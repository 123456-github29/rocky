import { describe, expect, it } from 'vitest'
import { githubSink } from '../src/sinks/github'
import { linearSink } from '../src/sinks/linear'
import type { Report } from '../src/types'
import { apiFetch, authHeader, jsonBody } from './api-fetch'

const report: Report = {
  id: 'sentry-101',
  source: 'sentry',
  title: 'TypeError: x is undefined',
  text: 'TypeError: x is undefined\napp/dashboard.tsx in render',
  fingerprint: 'sentry:101',
  reporter: 'Ada <ada@example.com>',
  link: 'https://sentry.io/organizations/acme/issues/101/',
  occurredAt: new Date('2026-08-20T10:00:00Z'),
}

describe('githubSink', () => {
  const openIssue = {
    number: 12,
    title: 'Crash on dashboard',
    body: 'Dashboard blows up after login.\n\n<!-- rocky:fingerprint:sentry%3A101 -->',
    state: 'open',
    html_url: 'https://github.com/acme/web/issues/12',
  }
  const pullRequest = { number: 13, title: 'Fix dashboard', state: 'open', pull_request: { url: 'x' } }

  it('lists open issues, skipping pull requests and extracting the fingerprint marker', async () => {
    const { impl, calls } = apiFetch(() => ({ body: [openIssue, pullRequest] }))
    const sink = githubSink({ token: 'gh-tok', owner: 'acme', repo: 'web', fetch: impl })

    const tickets = await sink.listOpen()

    expect(calls[0]!.url.pathname).toBe('/repos/acme/web/issues')
    expect(calls[0]!.url.searchParams.get('state')).toBe('open')
    expect(authHeader(calls[0]!.init)).toBe('Bearer gh-tok')

    expect(tickets).toHaveLength(1)
    expect(tickets[0]).toEqual({
      id: 12,
      title: 'Crash on dashboard',
      summary: 'Dashboard blows up after login.',
      fingerprint: 'sentry:101',
      state: 'open',
      link: 'https://github.com/acme/web/issues/12',
    })
  })

  it('pages through more than 100 open issues', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: `issue ${i + 1}`, state: 'open' }))
    const { impl, calls } = apiFetch((url) =>
      url.searchParams.get('page') === '1' ? { body: fullPage } : { body: [openIssue] },
    )
    const sink = githubSink({ token: 't', owner: 'acme', repo: 'web', fetch: impl })
    const tickets = await sink.listOpen()
    expect(calls).toHaveLength(2)
    expect(tickets).toHaveLength(101)
  })

  it('creates an issue carrying the report facts, labels, and an encoded fingerprint marker', async () => {
    const { impl, calls } = apiFetch(() => ({
      body: { number: 40, title: 'TypeError: x is undefined', body: 'x', state: 'open', html_url: 'https://github.com/acme/web/issues/40' },
    }))
    const sink = githubSink({ token: 't', owner: 'acme', repo: 'web', fetch: impl })

    const ticket = await sink.create(report, { labels: ['rocky', 'bug'] })

    const body = jsonBody(calls[0]!.init)
    expect(calls[0]!.url.pathname).toBe('/repos/acme/web/issues')
    expect(body['title']).toBe('TypeError: x is undefined')
    expect(body['labels']).toEqual(['rocky', 'bug'])
    const issueBody = String(body['body'])
    expect(issueBody).toContain('app/dashboard.tsx in render')
    expect(issueBody).toContain('reported by: Ada <ada@example.com>')
    expect(issueBody).toContain('source link: https://sentry.io/organizations/acme/issues/101/')
    expect(issueBody).toContain('<!-- rocky:fingerprint:sentry%3A101 -->')
    expect(ticket).toMatchObject({ id: 40, state: 'open' })
  })

  it('falls back to the first line of text as the title', async () => {
    const { impl, calls } = apiFetch(() => ({ body: { number: 41, title: 'App freezes on the map screen', state: 'open' } }))
    const sink = githubSink({ token: 't', owner: 'acme', repo: 'web', fetch: impl })
    const { title: _ignored, ...untitled } = report
    await sink.create({ ...untitled, text: 'App freezes on the map screen\nMore detail here.' }, { labels: [] })
    expect(jsonBody(calls[0]!.init)['title']).toBe('App freezes on the map screen')
  })

  it('annotates a ticket with who reported it and a link back to the source', async () => {
    const { impl, calls } = apiFetch(() => ({ body: { id: 1 } }))
    const sink = githubSink({ token: 't', owner: 'acme', repo: 'web', fetch: impl })

    await sink.annotate(12, report)

    expect(calls[0]!.url.pathname).toBe('/repos/acme/web/issues/12/comments')
    const comment = String(jsonBody(calls[0]!.init)['body'])
    expect(comment).toContain('Duplicate report')
    expect(comment).toContain('reported by: Ada <ada@example.com>')
    expect(comment).toContain('source link: https://sentry.io/organizations/acme/issues/101/')
    expect(comment).toContain('> TypeError: x is undefined')
  })

  it('renders explicit fallbacks when reporter and link are missing', async () => {
    const { impl, calls } = apiFetch(() => ({ body: { id: 1 } }))
    const sink = githubSink({ token: 't', owner: 'acme', repo: 'web', fetch: impl })
    const { reporter: _r, link: _l, ...anonymous } = report
    await sink.annotate(12, anonymous)
    const comment = String(jsonBody(calls[0]!.init)['body'])
    expect(comment).toContain('reported by: unknown')
    expect(comment).toContain('source link: (none provided)')
  })

  it('throws on HTTP errors', async () => {
    const { impl } = apiFetch(() => ({ status: 422, body: { message: 'Validation Failed' } }))
    const sink = githubSink({ token: 't', owner: 'acme', repo: 'web', fetch: impl })
    await expect(sink.create(report, { labels: [] })).rejects.toThrow(/HTTP 422/)
  })
})

describe('linearSink', () => {
  const issueNodes = [
    {
      id: 'uuid-1',
      identifier: 'ENG-1',
      title: 'Crash on dashboard',
      description: 'Dashboard blows up.\n\nrocky:fingerprint:sentry%3A101',
      url: 'https://linear.app/acme/issue/ENG-1',
      state: { type: 'triage' },
    },
    { id: 'uuid-2', identifier: 'ENG-2', title: 'Todo item', description: null, url: 'u2', state: { type: 'unstarted' } },
    { id: 'uuid-3', identifier: 'ENG-3', title: 'Being fixed', description: '', url: 'u3', state: { type: 'started' } },
  ]

  function linearFetch(overrides: Record<string, (variables: Record<string, unknown>) => unknown> = {}) {
    return apiFetch((_url, init) => {
      const { query, variables } = jsonBody(init) as { query: string; variables: Record<string, unknown> }
      for (const [marker, respond] of Object.entries(overrides)) {
        if (query.includes(marker)) return { body: { data: respond(variables) } }
      }
      if (query.includes('TeamByKey')) return { body: { data: { teams: { nodes: [{ id: 'team-uuid' }] } } } }
      if (query.includes('OpenIssues')) {
        return { body: { data: { issues: { nodes: issueNodes, pageInfo: { hasNextPage: false, endCursor: null } } } } }
      }
      if (query.includes('LabelsByName')) {
        return { body: { data: { issueLabels: { nodes: [{ id: 'label-rocky', name: 'rocky' }] } } } }
      }
      if (query.includes('CreateLabel')) return { body: { data: { issueLabelCreate: { issueLabel: { id: 'label-new' } } } } }
      if (query.includes('CreateIssue')) {
        return {
          body: {
            data: {
              issueCreate: {
                success: true,
                issue: { id: 'uuid-9', identifier: 'ENG-9', title: 'x', description: 'x', url: 'u9', state: { type: 'triage' } },
              },
            },
          },
        }
      }
      if (query.includes('IssueById')) return { body: { data: { issue: { id: 'uuid-1' } } } }
      if (query.includes('CreateComment')) return { body: { data: { commentCreate: { success: true } } } }
      throw new Error(`unrouted linear query: ${query.slice(0, 60)}`)
    })
  }

  it('resolves a team key once, lists open issues, and maps workflow-state types onto the enum', async () => {
    const { impl, calls } = linearFetch()
    const sink = linearSink({ apiKey: 'lin_api_x', team: 'ENG', fetch: impl })

    const tickets = await sink.listOpen()

    expect(authHeader(calls[0]!.init)).toBe('lin_api_x')
    expect((jsonBody(calls[0]!.init) as { variables: { key: string } }).variables.key).toBe('ENG')

    expect(tickets.map((t) => [t.id, t.state])).toEqual([
      ['ENG-1', 'open'],
      ['ENG-2', 'approved'],
      ['ENG-3', 'in_progress'],
    ])
    expect(tickets[0]).toMatchObject({ fingerprint: 'sentry:101', summary: 'Dashboard blows up.' })

    await sink.listOpen()
    const teamLookups = calls.filter((c) => String(jsonBody(c.init)['query']).includes('TeamByKey'))
    expect(teamLookups).toHaveLength(1)
  })

  it('skips team resolution when given a UUID', async () => {
    const { impl, calls } = linearFetch()
    const sink = linearSink({ apiKey: 'k', team: '0f5f4a92-9d2e-4b6a-8a2f-9c1e2d3f4a5b', fetch: impl })
    await sink.listOpen()
    expect(calls.some((c) => String(jsonBody(c.init)['query']).includes('TeamByKey'))).toBe(false)
  })

  it('creates an issue with resolved labels (creating the missing ones) and the fingerprint line', async () => {
    const { impl, calls } = linearFetch()
    const sink = linearSink({ apiKey: 'k', team: 'ENG', fetch: impl })

    const ticket = await sink.create(report, { labels: ['rocky', 'needs-triage'] })

    const createCall = calls.find((c) => String(jsonBody(c.init)['query']).includes('CreateIssue'))!
    const input = (jsonBody(createCall.init) as { variables: { input: Record<string, unknown> } }).variables.input
    expect(input['teamId']).toBe('team-uuid')
    expect(input['labelIds']).toEqual(['label-rocky', 'label-new'])
    expect(String(input['description'])).toContain('rocky:fingerprint:sentry%3A101')
    expect(String(input['description'])).toContain('reported by: Ada <ada@example.com>')
    expect(ticket).toMatchObject({ id: 'ENG-9', state: 'open' })
  })

  it('annotates by identifier: resolves the UUID then posts the comment with reporter and source link', async () => {
    const { impl, calls } = linearFetch()
    const sink = linearSink({ apiKey: 'k', team: 'ENG', fetch: impl })

    await sink.annotate('ENG-1', report)

    const commentCall = calls.find((c) => String(jsonBody(c.init)['query']).includes('CreateComment'))!
    const input = (jsonBody(commentCall.init) as { variables: { input: Record<string, unknown> } }).variables.input
    expect(input['issueId']).toBe('uuid-1')
    expect(String(input['body'])).toContain('reported by: Ada <ada@example.com>')
    expect(String(input['body'])).toContain('source link: https://sentry.io')
  })

  it('surfaces GraphQL errors and failed mutations', async () => {
    const errored = apiFetch(() => ({ body: { errors: [{ message: 'not authorized' }] } }))
    const sink = linearSink({ apiKey: 'bad', team: 'ENG', fetch: errored.impl })
    await expect(sink.listOpen()).rejects.toThrow(/not authorized/)

    const failing = linearFetch({ CreateComment: () => ({ commentCreate: { success: false } }) })
    const sink2 = linearSink({ apiKey: 'k', team: 'ENG', fetch: failing.impl })
    await expect(sink2.annotate('ENG-1', report)).rejects.toThrow(/did not succeed/)
  })
})
