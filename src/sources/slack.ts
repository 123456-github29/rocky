import type { Report } from '../types'
import type { Source } from './types'

export interface SlackSourceOptions {
  /** Bot token (xoxb-…) with history scope for the channel. */
  token: string
  /** Channel id (starts with C/G), not the channel name. */
  channel: string
  /** Max messages fetched per poll. */
  limit?: number
  /**
   * Workspace domain (the "acme" of acme.slack.com), used to build permalink
   * `Report.link`s. Without it reports carry no link.
   */
  teamDomain?: string
  /** Source name stamped on reports. Defaults to "slack". */
  name?: string
  fetch?: typeof globalThis.fetch
}

interface SlackMessage {
  type?: string
  subtype?: string
  ts: string
  text?: string
  user?: string
  username?: string
}

/**
 * System noise that is never a bug report. Deliberately NOT including
 * "bot_message": alert bots posting into a triage channel are a prime source.
 */
const SKIP_SUBTYPES = new Set([
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'message_deleted',
  'message_changed',
  'thread_broadcast',
])

/**
 * Polls one Slack channel since a timestamp.
 *
 * Cursor: the newest message `ts` seen, passed back as `oldest` (exclusive) on
 * the next poll.
 */
export function slackSource(options: SlackSourceOptions): Source {
  const { token, channel, limit = 100, teamDomain, name = 'slack', fetch = globalThis.fetch } = options

  return {
    name,
    async poll(cursor) {
      const url = new URL('https://slack.com/api/conversations.history')
      url.searchParams.set('channel', channel)
      url.searchParams.set('limit', String(limit))
      if (cursor) {
        url.searchParams.set('oldest', cursor)
        url.searchParams.set('inclusive', 'false')
      }

      const messages = await slackCall(fetch, url, token, name)
      const usable = messages.filter(
        (m) =>
          (m.type === undefined || m.type === 'message') &&
          typeof m.text === 'string' &&
          m.text.trim() !== '' &&
          (m.subtype === undefined || !SKIP_SUBTYPES.has(m.subtype)),
      )

      const reports = usable
        .map((m) => toReport(m, { channel, teamDomain, name }))
        .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())

      const newest = messages.reduce((max, m) => (parseFloat(m.ts) > parseFloat(max) ? m.ts : max), cursor ?? '0')
      return { reports, cursor: newest }
    },
  }
}

export interface ReactionTriggerOptions {
  /** Bot token with history scope for the channel the reaction happened in. */
  token: string
  /** Emoji that marks a message as a bug report, with or without colons (e.g. "ticket" or ":ticket:"). */
  emoji: string
  /** Workspace domain for permalinks, as in `SlackSourceOptions`. */
  teamDomain?: string
  /** Source name stamped on reports. Defaults to "slack". */
  name?: string
  fetch?: typeof globalThis.fetch
}

/**
 * Turns a Slack `reaction_added` event into a Report — but only when the
 * reaction matches the configured emoji, so a human's judgment is the filter.
 * Feed it events from your Slack Events API subscription; it returns null for
 * anything that should be ignored.
 *
 * The report id matches what `slackSource` would produce for the same message,
 * so a message that is both polled and reacted to deduplicates by id.
 */
export async function reactionTrigger(event: unknown, options: ReactionTriggerOptions): Promise<Report | null> {
  const { token, emoji, teamDomain, name = 'slack', fetch = globalThis.fetch } = options

  if (typeof event !== 'object' || event === null) return null
  const e = event as Record<string, unknown>
  if (e['type'] !== 'reaction_added') return null
  if (typeof e['reaction'] !== 'string' || normalizeEmoji(e['reaction']) !== normalizeEmoji(emoji)) return null
  const item = e['item'] as Record<string, unknown> | undefined
  if (typeof item !== 'object' || item === null || item['type'] !== 'message') return null
  const channel = item['channel']
  const ts = item['ts']
  if (typeof channel !== 'string' || typeof ts !== 'string') return null

  const url = new URL('https://slack.com/api/conversations.history')
  url.searchParams.set('channel', channel)
  url.searchParams.set('latest', ts)
  url.searchParams.set('inclusive', 'true')
  url.searchParams.set('limit', '1')

  const messages = await slackCall(fetch, url, token, name)
  const message = messages.find((m) => m.ts === ts) ?? messages[0]
  if (!message || typeof message.text !== 'string' || message.text.trim() === '') return null

  const report = toReport(message, { channel, teamDomain, name })
  report.raw = { event, message }
  return report
}

async function slackCall(
  fetch: typeof globalThis.fetch,
  url: URL,
  token: string,
  name: string,
): Promise<SlackMessage[]> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  if (!response.ok) {
    throw new Error(`${name}: HTTP ${response.status} from ${url.pathname}`)
  }
  const payload = (await response.json()) as { ok?: boolean; error?: string; messages?: unknown }
  if (!payload.ok) {
    throw new Error(`${name}: Slack API error "${payload.error ?? 'unknown'}" from ${url.pathname}`)
  }
  if (!Array.isArray(payload.messages)) return []
  return payload.messages.filter(
    (m): m is SlackMessage =>
      typeof m === 'object' && m !== null && typeof (m as Record<string, unknown>)['ts'] === 'string',
  )
}

function toReport(
  message: SlackMessage,
  context: { channel: string; teamDomain?: string; name: string },
): Report {
  const { channel, teamDomain, name } = context
  const report: Report = {
    id: `${name}-${channel}-${message.ts}`,
    source: name,
    text: message.text ?? '',
    occurredAt: new Date(Math.round(parseFloat(message.ts) * 1000)),
    raw: message,
  }
  const reporter = message.user ?? message.username
  if (reporter) report.reporter = reporter
  if (teamDomain) {
    report.link = `https://${teamDomain}.slack.com/archives/${channel}/p${message.ts.replace('.', '')}`
  }
  return report
}

function normalizeEmoji(emoji: string): string {
  return emoji.replace(/:/g, '').trim().toLowerCase()
}
