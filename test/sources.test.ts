import { describe, expect, it, vi } from 'vitest'
import { sentrySource } from '../src/sources/sentry'
import { gmailSource, oauthRefreshAuth } from '../src/sources/gmail'
import { reactionTrigger, slackSource } from '../src/sources/slack'
import { webhookSource } from '../src/sources/webhook'
import type { Report } from '../src/types'

interface Routed {
  status?: number
  body: unknown
}

function apiFetch(handler: (url: URL, init?: RequestInit) => Routed) {
  const calls: Array<{ url: URL; init?: RequestInit }> = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    calls.push(init === undefined ? { url } : { url, init })
    const { status = 200, body } = handler(url, init)
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
  return { impl, calls }
}

function authHeader(init?: RequestInit): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.['authorization']
}

describe('sentrySource', () => {
  const issues = [
    {
      id: '101',
      title: 'TypeError: x is undefined',
      culprit: 'app/dashboard.tsx in render',
      permalink: 'https://sentry.io/organizations/acme/issues/101/',
      lastSeen: '2026-08-20T10:00:00Z',
      metadata: { value: "Cannot read properties of undefined (reading 'map')" },
    },
    {
      id: '102',
      title: 'Timeout connecting to redis',
      culprit: 'worker/queue.ts in flush',
      permalink: 'https://sentry.io/organizations/acme/issues/102/',
      lastSeen: '2026-08-21T12:00:00Z',
    },
  ]

  it('maps issues to reports with the issue id as fingerprint, oldest first', async () => {
    const { impl, calls } = apiFetch(() => ({ body: issues }))
    const source = sentrySource({ token: 'tok', org: 'acme', project: 'web', fetch: impl })

    const { reports, cursor } = await source.poll(null)

    expect(calls[0]!.url.pathname).toBe('/api/0/projects/acme/web/issues/')
    expect(calls[0]!.url.searchParams.get('query')).toBe('is:unresolved')
    expect(calls[0]!.url.searchParams.get('sort')).toBe('date')
    expect(authHeader(calls[0]!.init)).toBe('Bearer tok')

    expect(reports).toHaveLength(2)
    expect(reports[0]).toMatchObject({
      id: 'sentry-101',
      source: 'sentry',
      fingerprint: 'sentry:101',
      title: 'TypeError: x is undefined',
      link: 'https://sentry.io/organizations/acme/issues/101/',
    })
    expect(reports[0]!.text).toContain('app/dashboard.tsx in render')
    expect(reports[0]!.text).toContain("reading 'map'")
    expect(reports[0]!.occurredAt.toISOString()).toBe('2026-08-20T10:00:00.000Z')
    expect(reports[1]!.id).toBe('sentry-102')
    expect(cursor).toBe('2026-08-21T12:00:00.000Z')
  })

  it('only returns issues newer than the cursor and preserves the cursor when nothing is new', async () => {
    const { impl } = apiFetch(() => ({ body: issues }))
    const source = sentrySource({ token: 'tok', org: 'acme', project: 'web', fetch: impl })

    const incremental = await source.poll('2026-08-20T10:00:00.000Z')
    expect(incremental.reports.map((r) => r.id)).toEqual(['sentry-102'])
    expect(incremental.cursor).toBe('2026-08-21T12:00:00.000Z')

    const quiet = await source.poll('2026-08-22T00:00:00.000Z')
    expect(quiet.reports).toEqual([])
    expect(quiet.cursor).toBe('2026-08-22T00:00:00.000Z')
  })

  it('polls a GlitchTip instance through baseUrl with a custom source name', async () => {
    const { impl, calls } = apiFetch(() => ({ body: [issues[0]] }))
    const source = sentrySource({
      token: 'tok',
      org: 'acme',
      project: 'web',
      baseUrl: 'https://glitchtip.example.com/',
      name: 'glitchtip',
      fetch: impl,
    })
    const { reports } = await source.poll(null)
    expect(calls[0]!.url.origin).toBe('https://glitchtip.example.com')
    expect(reports[0]).toMatchObject({ id: 'glitchtip-101', source: 'glitchtip', fingerprint: 'glitchtip:101' })
  })

  it('throws on HTTP errors', async () => {
    const { impl } = apiFetch(() => ({ status: 401, body: { detail: 'bad token' } }))
    const source = sentrySource({ token: 'nope', org: 'acme', project: 'web', fetch: impl })
    await expect(source.poll(null)).rejects.toThrow(/HTTP 401/)
  })
})

describe('gmailSource', () => {
  const bodyText = 'The app crashes when I tap share.\nSent from my iPhone'
  const message = {
    id: 'm1',
    internalDate: '1755950400000',
    snippet: 'The app crashes…',
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'Subject', value: 'App crash on share' },
        { name: 'From', value: 'Ada <ada@example.com>' },
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from(bodyText, 'utf8').toString('base64url') } },
        { mimeType: 'text/html', body: { data: Buffer.from('<p>html</p>', 'utf8').toString('base64url') } },
      ],
    },
  }

  function gmailFetch() {
    return apiFetch((url) => {
      if (url.pathname.endsWith('/messages')) return { body: { messages: [{ id: 'm1' }] } }
      if (url.pathname.endsWith('/messages/m1')) return { body: message }
      throw new Error(`unexpected gmail url ${url.toString()}`)
    })
  }

  it('requires a label or an address', () => {
    expect(() => gmailSource({ auth: async () => 't' })).toThrow(/label.*address/)
  })

  it('lists unread mail for the label, fetches each message, and decodes the plain-text body', async () => {
    const { impl, calls } = gmailFetch()
    const auth = vi.fn(async () => 'access-token')
    const source = gmailSource({ auth, label: 'bugs', fetch: impl })

    const { reports, cursor } = await source.poll(null)

    const listCall = calls[0]!
    expect(listCall.url.searchParams.get('q')).toBe('is:unread label:bugs')
    expect(authHeader(listCall.init)).toBe('Bearer access-token')
    expect(calls[1]!.url.pathname).toContain('/messages/m1')
    expect(calls[1]!.url.searchParams.get('format')).toBe('full')

    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      id: 'gmail-m1',
      source: 'gmail',
      title: 'App crash on share',
      reporter: 'Ada <ada@example.com>',
    })
    expect(reports[0]!.text).toContain('App crash on share')
    expect(reports[0]!.text).toContain('crashes when I tap share')
    expect(reports[0]!.occurredAt.getTime()).toBe(1755950400000)
    expect(cursor).toBe(String(Math.floor(1755950400000 / 1000)))
  })

  it('applies the cursor as an after: term and scopes by address', async () => {
    const { impl, calls } = gmailFetch()
    const source = gmailSource({ auth: async () => 't', address: 'support@example.com', fetch: impl })
    await source.poll('1755950000')
    expect(calls[0]!.url.searchParams.get('q')).toBe('is:unread from:support@example.com after:1755950000')
  })

  it('returns no reports and keeps the cursor when the mailbox is quiet', async () => {
    const { impl } = apiFetch(() => ({ body: {} }))
    const source = gmailSource({ auth: async () => 't', label: 'bugs', fetch: impl })
    expect(await source.poll('1755950000')).toEqual({ reports: [], cursor: '1755950000' })
    expect(await source.poll(null)).toEqual({ reports: [], cursor: '0' })
  })
})

describe('oauthRefreshAuth', () => {
  it('exchanges the refresh token once and caches the access token', async () => {
    const { impl, calls } = apiFetch(() => ({ body: { access_token: 'at-1', expires_in: 3600 } }))
    const auth = oauthRefreshAuth({ clientId: 'ci', clientSecret: 'cs', refreshToken: 'rt', fetch: impl })

    expect(await auth()).toBe('at-1')
    expect(await auth()).toBe('at-1')
    expect(calls).toHaveLength(1)

    const body = new URLSearchParams(String(calls[0]!.init?.body))
    expect(calls[0]!.url.origin).toBe('https://oauth2.googleapis.com')
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('client_id')).toBe('ci')
    expect(body.get('refresh_token')).toBe('rt')
  })

  it('throws a descriptive error when the refresh is rejected', async () => {
    const { impl } = apiFetch(() => ({ status: 400, body: { error: 'invalid_grant' } }))
    const auth = oauthRefreshAuth({ clientId: 'ci', clientSecret: 'cs', refreshToken: 'rt', fetch: impl })
    await expect(auth()).rejects.toThrow(/invalid_grant/)
  })
})

describe('slackSource', () => {
  const history = {
    ok: true,
    messages: [
      { type: 'message', ts: '1755952000.000200', text: 'beacon toggle crashes the app', user: 'U2' },
      { type: 'message', subtype: 'bot_message', ts: '1755951000.000100', text: 'ALERT: 500s on /login', username: 'alertbot' },
      { type: 'message', subtype: 'channel_join', ts: '1755950000.000050', text: '<@U9> has joined' },
    ],
  }

  it('maps channel messages oldest-first, keeps bot alerts, skips join noise', async () => {
    const { impl, calls } = apiFetch(() => ({ body: history }))
    const source = slackSource({ token: 'xoxb-1', channel: 'C123', teamDomain: 'acme', fetch: impl })

    const { reports, cursor } = await source.poll(null)

    expect(calls[0]!.url.pathname).toBe('/api/conversations.history')
    expect(calls[0]!.url.searchParams.get('channel')).toBe('C123')
    expect(calls[0]!.url.searchParams.has('oldest')).toBe(false)
    expect(authHeader(calls[0]!.init)).toBe('Bearer xoxb-1')

    expect(reports.map((r) => r.text)).toEqual(['ALERT: 500s on /login', 'beacon toggle crashes the app'])
    expect(reports[1]).toMatchObject({
      id: 'slack-C123-1755952000.000200',
      source: 'slack',
      reporter: 'U2',
      link: 'https://acme.slack.com/archives/C123/p1755952000000200',
    })
    expect(cursor).toBe('1755952000.000200')
  })

  it('passes the cursor as an exclusive oldest bound', async () => {
    const { impl, calls } = apiFetch(() => ({ body: { ok: true, messages: [] } }))
    const source = slackSource({ token: 'xoxb-1', channel: 'C123', fetch: impl })
    const { cursor } = await source.poll('1755952000.000200')
    expect(calls[0]!.url.searchParams.get('oldest')).toBe('1755952000.000200')
    expect(calls[0]!.url.searchParams.get('inclusive')).toBe('false')
    expect(cursor).toBe('1755952000.000200')
  })

  it('surfaces Slack API errors', async () => {
    const { impl } = apiFetch(() => ({ body: { ok: false, error: 'channel_not_found' } }))
    const source = slackSource({ token: 'xoxb-1', channel: 'CBAD', fetch: impl })
    await expect(source.poll(null)).rejects.toThrow(/channel_not_found/)
  })
})

describe('reactionTrigger', () => {
  const event = {
    type: 'reaction_added',
    reaction: 'ticket',
    user: 'U5',
    item: { type: 'message', channel: 'C123', ts: '1755952000.000200' },
  }
  const historyForTs = {
    ok: true,
    messages: [{ type: 'message', ts: '1755952000.000200', text: 'checkout is broken for me', user: 'U7' }],
  }

  it('fetches the reacted-to message when the emoji matches (colons optional)', async () => {
    const { impl, calls } = apiFetch(() => ({ body: historyForTs }))
    const report = await reactionTrigger(event, { token: 'xoxb-1', emoji: ':ticket:', fetch: impl })

    expect(calls[0]!.url.searchParams.get('latest')).toBe('1755952000.000200')
    expect(calls[0]!.url.searchParams.get('inclusive')).toBe('true')
    expect(calls[0]!.url.searchParams.get('limit')).toBe('1')
    expect(report).toMatchObject({
      id: 'slack-C123-1755952000.000200',
      text: 'checkout is broken for me',
      reporter: 'U7',
    })
  })

  it('ignores non-matching emoji and malformed events without calling Slack', async () => {
    const { impl, calls } = apiFetch(() => ({ body: historyForTs }))
    expect(await reactionTrigger(event, { token: 'x', emoji: 'bug', fetch: impl })).toBeNull()
    expect(await reactionTrigger({ type: 'reaction_added' }, { token: 'x', emoji: 'ticket', fetch: impl })).toBeNull()
    expect(await reactionTrigger('nonsense', { token: 'x', emoji: 'ticket', fetch: impl })).toBeNull()
    expect(calls).toHaveLength(0)
  })
})

describe('webhookSource', () => {
  const validReport = (id: string): Report => ({
    id,
    source: 'pager',
    text: 'disk full on db-1',
    occurredAt: new Date(1755950400000),
  })

  it('buffers ingested reports until poll drains them, counting the cursor up', async () => {
    const source = webhookSource({ map: (payload) => validReport(String((payload as { id: string }).id)) })

    expect(source.ingest({ id: 'a' })).toHaveLength(1)
    source.ingest({ id: 'b' })
    expect(source.pending()).toBe(2)

    const first = await source.poll(null)
    expect(first.reports.map((r) => r.id)).toEqual(['a', 'b'])
    expect(first.cursor).toBe('2')
    expect(source.pending()).toBe(0)

    const second = await source.poll(first.cursor)
    expect(second.reports).toEqual([])
    expect(second.cursor).toBe('2')
  })

  it('accepts array and null mapper results', async () => {
    const source = webhookSource({
      map: (payload) => (payload === 'skip' ? null : [validReport('x'), validReport('y')]),
    })
    expect(source.ingest('skip')).toEqual([])
    expect(source.ingest('take')).toHaveLength(2)
    expect((await source.poll(null)).reports).toHaveLength(2)
  })

  it('rejects invalid mapper output loudly', () => {
    const source = webhookSource({ map: () => ({ id: 'x', source: 'pager', text: '  ' }) as unknown as Report })
    expect(() => source.ingest({})).toThrow(/"text"/)
    expect(source.pending()).toBe(0)
  })
})
