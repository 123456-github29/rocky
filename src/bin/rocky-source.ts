import { createServer } from 'node:http'
import process from 'node:process'
import type { Report } from '../types'
import type { Source } from '../sources/types'
import { sentrySource } from '../sources/sentry'
import { gmailSource, oauthRefreshAuth } from '../sources/gmail'
import { slackSource } from '../sources/slack'
import { webhookSource } from '../sources/webhook'

const USAGE = `usage: rocky-source <sentry|gmail|slack> [cursor]
       rocky-source webhook [--port N]

Polls one source once and prints { reports, cursor } as JSON — for testing a
source in isolation before wiring it into anything. Pass the printed cursor
back as the second argument to test incremental polling.

Configuration comes from environment variables:

  sentry    SENTRY_TOKEN, SENTRY_ORG, SENTRY_PROJECT
            SENTRY_URL (optional, e.g. a GlitchTip instance), SENTRY_QUERY (optional)
  gmail     GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN,
            and GMAIL_LABEL and/or GMAIL_ADDRESS
  slack     SLACK_TOKEN, SLACK_CHANNEL, SLACK_TEAM_DOMAIN (optional)

"webhook" instead starts a local HTTP listener (default port 8377) and prints
the Report(s) each POSTed JSON body maps to, using a naive built-in mapper —
for eyeballing payloads only; real deployments supply their own map() in code.`

function need(names: string[]): Record<string, string> {
  const missing = names.filter((n) => !process.env[n])
  if (missing.length > 0) {
    console.error(`rocky-source: missing environment variable(s): ${missing.join(', ')}\n\n${USAGE}`)
    process.exit(1)
  }
  return Object.fromEntries(names.map((n) => [n, process.env[n] as string]))
}

function buildSource(kind: string): Source {
  switch (kind) {
    case 'sentry': {
      const env = need(['SENTRY_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT'])
      return sentrySource({
        token: env['SENTRY_TOKEN']!,
        org: env['SENTRY_ORG']!,
        project: env['SENTRY_PROJECT']!,
        ...(process.env['SENTRY_URL'] ? { baseUrl: process.env['SENTRY_URL'] } : {}),
        ...(process.env['SENTRY_QUERY'] ? { query: process.env['SENTRY_QUERY'] } : {}),
      })
    }
    case 'gmail': {
      const env = need(['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'])
      if (!process.env['GMAIL_LABEL'] && !process.env['GMAIL_ADDRESS']) {
        console.error(`rocky-source: set GMAIL_LABEL and/or GMAIL_ADDRESS\n\n${USAGE}`)
        process.exit(1)
      }
      return gmailSource({
        auth: oauthRefreshAuth({
          clientId: env['GMAIL_CLIENT_ID']!,
          clientSecret: env['GMAIL_CLIENT_SECRET']!,
          refreshToken: env['GMAIL_REFRESH_TOKEN']!,
        }),
        ...(process.env['GMAIL_LABEL'] ? { label: process.env['GMAIL_LABEL'] } : {}),
        ...(process.env['GMAIL_ADDRESS'] ? { address: process.env['GMAIL_ADDRESS'] } : {}),
      })
    }
    case 'slack': {
      const env = need(['SLACK_TOKEN', 'SLACK_CHANNEL'])
      return slackSource({
        token: env['SLACK_TOKEN']!,
        channel: env['SLACK_CHANNEL']!,
        ...(process.env['SLACK_TEAM_DOMAIN'] ? { teamDomain: process.env['SLACK_TEAM_DOMAIN'] } : {}),
      })
    }
    default: {
      console.error(`rocky-source: unknown source "${kind}"\n\n${USAGE}`)
      process.exit(1)
    }
  }
}

function runWebhookListener(args: string[]): void {
  const portFlag = args.indexOf('--port')
  const port = portFlag !== -1 ? Number(args[portFlag + 1]) : 8377
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error('rocky-source: --port must be a valid port number')
    process.exit(1)
  }

  let counter = 0
  const source = webhookSource({
    map: (payload): Report => {
      const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
      const pick = (...keys: string[]): string | undefined => {
        for (const key of keys) {
          const value = record[key]
          if (typeof value === 'string' && value.trim() !== '') return value
        }
        return undefined
      }
      const title = pick('title', 'subject', 'name')
      const report: Report = {
        id: pick('id') ?? `webhook-${process.pid}-${++counter}`,
        source: 'webhook',
        text: pick('text', 'message', 'description', 'body', 'error') ?? JSON.stringify(payload),
        occurredAt: new Date(),
        raw: payload,
      }
      if (title) report.title = title
      return report
    },
  })

  const server = createServer((request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' }).end('POST a JSON payload\n')
      return
    }
    let body = ''
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
    })
    request.on('end', () => {
      try {
        const payload: unknown = body === '' ? {} : JSON.parse(body)
        const reports = source.ingest(payload)
        console.log(JSON.stringify(reports, null, 2))
        response
          .writeHead(202, { 'content-type': 'application/json' })
          .end(JSON.stringify({ queued: reports.length }))
      } catch (error) {
        response
          .writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      }
    })
  })

  server.listen(port, () => {
    console.error(`rocky-source: webhook test listener on http://localhost:${port}/`)
    console.error('rocky-source: POST any JSON body to see the Report it maps to (built-in mapper, testing only)')
  })
}

async function main(): Promise<void> {
  const kind = process.argv[2]
  if (!kind || kind === '--help' || kind === '-h') {
    console.log(USAGE)
    if (!kind) process.exitCode = 1
    return
  }
  if (kind === 'webhook') {
    runWebhookListener(process.argv.slice(3))
    return
  }
  const source = buildSource(kind)
  const cursor = process.argv[3] ?? null
  const result = await source.poll(cursor)
  console.log(JSON.stringify(result, null, 2))
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `rocky-source: ${error.message}` : error)
  process.exitCode = 1
})
