import { describe, expect, it } from 'vitest'
import { githubSink } from '../src/sinks/github'
import { linearSink } from '../src/sinks/linear'
import { apiFetch, jsonBody } from './api-fetch'
import type { Routed } from './api-fetch'

const ISSUE = { number: 42, title: 'Voice crash', body: 'boom', state: 'open', html_url: 'https://github.com/o/r/issues/42' }

describe('githubSink — approval gate', () => {
  it('lists only open issues carrying a label, url-encoding it, and drops pull requests', async () => {
    const { impl, calls } = apiFetch((url): Routed => {
      if (url.pathname === '/repos/o/r/issues') {
        return { body: [ISSUE, { ...ISSUE, number: 99, pull_request: { url: 'x' } }] }
      }
      throw new Error(`unexpected ${url.pathname}`)
    })
    const sink = githubSink({ token: 't', owner: 'o', repo: 'r', fetch: impl })

    const tickets = await sink.listByLabel!('needs triage')

    expect(tickets.map((t) => t.id)).toEqual([42])
    expect(calls[0]!.url.searchParams.get('labels')).toBe('needs triage')
    expect(calls[0]!.url.searchParams.get('state')).toBe('open')
  })

  it('adds labels in one call and removes them one DELETE at a time', async () => {
    const { impl, calls } = apiFetch((): Routed => ({ body: {} }))
    const sink = githubSink({ token: 't', owner: 'o', repo: 'r', fetch: impl })

    await sink.setLabels!(42, { add: ['approved'], remove: ['rocky', 'needs triage'] })

    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.url.pathname).toBe('/repos/o/r/issues/42/labels')
    expect(jsonBody(calls[0]!.init)).toEqual({ labels: ['approved'] })
    expect(calls[1]).toMatchObject({ init: { method: 'DELETE' } })
    expect(calls[1]!.url.pathname).toBe('/repos/o/r/issues/42/labels/rocky')
    expect(calls[2]!.url.pathname).toBe('/repos/o/r/issues/42/labels/needs%20triage')
  })

  it('treats removing a label the issue never had as success, not failure', async () => {
    const { impl } = apiFetch((url): Routed => (url.pathname.includes('/labels/') ? { status: 404, body: { message: 'Label does not exist' } } : { body: {} }))
    const sink = githubSink({ token: 't', owner: 'o', repo: 'r', fetch: impl })

    await expect(sink.setLabels!(42, { remove: ['rocky'] })).resolves.toBeUndefined()
  })

  it('still reports a real failure while removing a label', async () => {
    const { impl } = apiFetch((url): Routed => (url.pathname.includes('/labels/') ? { status: 403, body: { message: 'no write access' } } : { body: {} }))
    const sink = githubSink({ token: 't', owner: 'o', repo: 'r', fetch: impl })

    await expect(sink.setLabels!(42, { remove: ['rocky'] })).rejects.toThrow(/HTTP 403/)
  })

  it('reports an open issue as unresolved without touching the timeline', async () => {
    const { impl, calls } = apiFetch((): Routed => ({ body: ISSUE }))
    const sink = githubSink({ token: 't', owner: 'o', repo: 'r', fetch: impl })

    expect(await sink.resolution!(42)).toEqual({ closed: false, fix: null })
    expect(calls).toHaveLength(1)
  })

  it('names the pull request that closed the issue', async () => {
    const { impl } = apiFetch((url): Routed => {
      if (url.pathname.endsWith('/timeline')) {
        return {
          body: [
            { event: 'labeled' },
            { event: 'cross-referenced', source: { issue: { pull_request: {}, html_url: 'https://github.com/o/r/pull/7' } } },
          ],
        }
      }
      return { body: { ...ISSUE, state: 'closed' } }
    })
    const sink = githubSink({ token: 't', owner: 'o', repo: 'r', fetch: impl })

    expect(await sink.resolution!(42)).toEqual({ closed: true, fix: 'https://github.com/o/r/pull/7' })
  })

  it('falls back to the closing commit, on the web host rather than the api host', async () => {
    const { impl } = apiFetch((url): Routed =>
      url.pathname.endsWith('/timeline')
        ? { body: [{ event: 'closed', commit_id: 'abc123' }] }
        : { body: { ...ISSUE, state: 'closed' } },
    )
    const sink = githubSink({ token: 't', owner: 'o', repo: 'r', fetch: impl })

    expect(await sink.resolution!(42)).toEqual({ closed: true, fix: 'https://github.com/o/r/commit/abc123' })
  })

  it('builds enterprise commit links off the enterprise host', async () => {
    const { impl } = apiFetch((url): Routed =>
      url.pathname.endsWith('/timeline')
        ? { body: [{ event: 'closed', commit_id: 'abc123' }] }
        : { body: { ...ISSUE, state: 'closed' } },
    )
    const sink = githubSink({ token: 't', owner: 'o', repo: 'r', baseUrl: 'https://ghe.example.com/api/v3', fetch: impl })

    expect((await sink.resolution!(42)).fix).toBe('https://ghe.example.com/o/r/commit/abc123')
  })

  it('still reports the ticket closed when the timeline is unavailable', async () => {
    const { impl } = apiFetch((url): Routed =>
      url.pathname.endsWith('/timeline') ? { status: 410, body: {} } : { body: { ...ISSUE, state: 'closed' } },
    )
    const sink = githubSink({ token: 't', owner: 'o', repo: 'r', fetch: impl })

    expect(await sink.resolution!(42)).toEqual({ closed: true, fix: null })
  })
})

function graphql(handler: (operation: string, variables: Record<string, unknown>) => unknown) {
  return apiFetch((_url, init): Routed => {
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> }
    const operation = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? ''
    return { body: { data: handler(operation, variables) } }
  })
}

const TEAM = '11111111-2222-3333-4444-555555555555'

describe('linearSink — approval gate', () => {
  it('filters open issues by label within the team', async () => {
    const seen: Record<string, unknown>[] = []
    const { impl } = graphql((operation, variables) => {
      seen.push({ operation, ...variables })
      if (operation === 'LabeledIssues') {
        return {
          issues: {
            nodes: [{ id: 'u1', identifier: 'ENG-1', title: 'Crash', description: 'boom', url: 'https://linear.app/1', state: { type: 'triage' } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }
      }
      throw new Error(`unexpected ${operation}`)
    })
    const sink = linearSink({ apiKey: 'k', team: TEAM, fetch: impl })

    const tickets = await sink.listByLabel!('rocky')

    expect(tickets).toHaveLength(1)
    expect(tickets[0]).toMatchObject({ id: 'ENG-1', state: 'open' })
    expect(seen[0]).toMatchObject({ label: 'rocky', teamId: TEAM })
  })

  it('resolves the human identifier to a uuid, then adds and removes by label id', async () => {
    const operations: string[] = []
    const { impl } = graphql((operation, variables) => {
      operations.push(operation)
      if (operation === 'IssueById') return { issue: { id: 'uuid-1' } }
      if (operation === 'LabelsByName') {
        const names = variables['names'] as string[]
        return { issueLabels: { nodes: names.map((name, i) => ({ id: `label-${i}`, name })) } }
      }
      if (operation === 'AddLabel') return { issueAddLabel: { success: true } }
      if (operation === 'RemoveLabel') return { issueRemoveLabel: { success: true } }
      throw new Error(`unexpected ${operation}`)
    })
    const sink = linearSink({ apiKey: 'k', team: TEAM, fetch: impl })

    await sink.setLabels!('ENG-1', { add: ['approved'], remove: ['rocky'] })

    expect(operations).toContain('AddLabel')
    expect(operations).toContain('RemoveLabel')
    // A removal must never create the label it is trying to remove.
    expect(operations).not.toContain('CreateLabel')
  })

  it('does nothing at all for an empty label change', async () => {
    const { impl, calls } = graphql(() => ({}))
    const sink = linearSink({ apiKey: 'k', team: TEAM, fetch: impl })

    await sink.setLabels!('ENG-1', {})

    expect(calls).toHaveLength(0)
  })

  it('maps a completed state to closed and finds the linked pull request', async () => {
    const { impl } = graphql((operation) => {
      if (operation === 'IssueResolution') {
        return {
          issue: {
            state: { type: 'completed' },
            attachments: {
              nodes: [
                { url: 'https://linear.app/attachment', sourceType: 'link' },
                { url: 'https://github.com/o/r/pull/12', sourceType: 'github' },
              ],
            },
          },
        }
      }
      throw new Error(`unexpected ${operation}`)
    })
    const sink = linearSink({ apiKey: 'k', team: TEAM, fetch: impl })

    expect(await sink.resolution!('ENG-1')).toEqual({ closed: true, fix: 'https://github.com/o/r/pull/12' })
  })

  it('treats a started issue as still open', async () => {
    const { impl } = graphql(() => ({ issue: { state: { type: 'started' }, attachments: { nodes: [] } } }))
    const sink = linearSink({ apiKey: 'k', team: TEAM, fetch: impl })

    expect(await sink.resolution!('ENG-1')).toEqual({ closed: false, fix: null })
  })
})
