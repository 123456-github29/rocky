import { spawn as nodeSpawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import type { Notifier, NotifyMessage } from './types'

/**
 * Deliver through the `hermes send` CLI.
 *
 * Hermes already holds the bot tokens for every platform it is configured for,
 * so rocky never learns a Telegram token or a Slack signing secret — it shells
 * out and lets Hermes route. This is the transport to use when rocky and the
 * Hermes gateway share a machine.
 */
export interface HermesCliNotifierOptions {
  transport?: 'cli'
  /**
   * A `hermes send --to` target: `telegram`, `telegram:-1001234567890`,
   * `slack:#eng`, `discord:#ops`, `signal:+15551234567`, `email`. Bare platform
   * names go to that platform's configured home channel.
   */
  to: string
  /** The hermes executable. Defaults to `hermes` on PATH. */
  bin?: string
  /** Kill the send after this long. Defaults to 30s. */
  timeoutMs?: number
  name?: string
  /** Injectable for tests. Defaults to `child_process.spawn`. */
  spawn?: typeof nodeSpawn
}

/**
 * Deliver by POSTing to a Hermes webhook route.
 *
 * Use this when the gateway is on another host. Pair it with a route that sets
 * `deliver_only: true` — the rendered prompt becomes the message verbatim, so
 * an approval request costs no tokens and arrives immediately instead of being
 * paraphrased by an agent turn.
 */
export interface HermesWebhookNotifierOptions {
  transport: 'webhook'
  /** Full route URL, e.g. `http://localhost:8644/webhooks/rocky`. */
  url: string
  /** The route's HMAC secret, from `platforms.webhook.extra.routes.<route>.secret`. */
  secret: string
  name?: string
  fetch?: typeof globalThis.fetch
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number
}

export type HermesNotifierOptions = HermesCliNotifierOptions | HermesWebhookNotifierOptions

/**
 * Hermes as rocky's outbound channel.
 *
 * Rocky knows what needs saying; Hermes knows how to reach you on Telegram,
 * Slack, Discord, Signal, WhatsApp, or email. Neither has to learn the other's
 * job, and adding a platform is a Hermes config change with no rocky release.
 */
export function hermesNotifier(options: HermesNotifierOptions): Notifier {
  return options.transport === 'webhook' ? webhookNotifier(options) : cliNotifier(options)
}

function cliNotifier(options: HermesCliNotifierOptions): Notifier {
  const { to, bin = 'hermes', timeoutMs = 30_000, name = `hermes:${options.to}`, spawn = nodeSpawn } = options
  if (!to) throw new TypeError('hermesNotifier: "to" is required (e.g. "telegram" or "slack:#eng")')

  return {
    name,
    send(message: NotifyMessage) {
      return new Promise<void>((resolve, reject) => {
        const child = spawn(bin, ['send', '--to', to, '--subject', message.subject, '--quiet', '--file', '-'], {
          stdio: ['pipe', 'ignore', 'pipe'],
          timeout: timeoutMs,
        })

        let stderr = ''
        child.stderr?.on('data', (chunk: Buffer | string) => {
          stderr += String(chunk)
        })
        // A gateway that is down surfaces as EPIPE on the write, not as an
        // exit code — swallow it here and let 'close' report the real reason.
        child.stdin?.on('error', () => undefined)
        child.on('error', (error: Error) => {
          reject(
            new Error(
              error.message.includes('ENOENT')
                ? `${name}: "${bin}" is not on PATH — install hermes-agent or set { bin } to its full path`
                : `${name}: could not run ${bin}: ${error.message}`,
            ),
          )
        })
        child.on('close', (code: number | null) => {
          if (code === 0) return resolve()
          // hermes send: 1 = delivery failed at the platform, 2 = usage/config.
          const why =
            code === 2
              ? `hermes rejected the target "${to}" or its config — check \`hermes send --list\``
              : `delivery to "${to}" failed`
          reject(new Error(`${name}: ${why}${stderr.trim() === '' ? '' : ` — ${stderr.trim().slice(0, 300)}`}`))
        })

        child.stdin?.end(message.body)
      })
    },
  }
}

function webhookNotifier(options: HermesWebhookNotifierOptions): Notifier {
  const { url, secret, name = 'hermes:webhook', fetch = globalThis.fetch, now = Date.now } = options
  if (!url) throw new TypeError('hermesNotifier: "url" is required for the webhook transport')
  if (!secret) throw new TypeError('hermesNotifier: "secret" is required for the webhook transport')

  return {
    name,
    async send(message: NotifyMessage) {
      // Flat and dot-addressable so a route's `prompt:` template can pull
      // fields straight out — e.g. "{subject}\n\n{body}".
      const body = JSON.stringify({
        event_type: `rocky.${message.kind}`,
        kind: message.kind,
        subject: message.subject,
        body: message.body,
        ticket: {
          id: message.ticket.id,
          title: message.ticket.title,
          link: message.ticket.link,
          state: message.ticket.state,
        },
      })

      // Hermes generic HMAC V2: hex HMAC-SHA256 over "<unix seconds>.<body>",
      // with the timestamp echoed in its own header. V1 signs the body alone
      // and replays forever, so rocky only ever speaks V2.
      const timestamp = String(Math.floor(now() / 1000))
      const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-webhook-timestamp': timestamp,
          'x-webhook-signature-v2': signature,
        },
        body,
      })
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 200)
        throw new Error(`${name}: HTTP ${response.status} from ${url}${detail === '' ? '' : ` — ${detail}`}`)
      }
    },
  }
}
