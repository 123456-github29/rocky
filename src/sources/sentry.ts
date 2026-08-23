import type { Report } from '../types'
import type { Source } from './types'

export interface SentrySourceOptions {
  /** API token with project read access (Sentry auth token / GlitchTip auth token). */
  token: string
  /** Organization slug. */
  org: string
  /** Project slug. */
  project: string
  /**
   * API root. Defaults to Sentry cloud. Point it at a GlitchTip instance
   * (e.g. "https://app.glitchtip.com") — GlitchTip is API-compatible.
   */
  baseUrl?: string
  /** Issue search query. Defaults to "is:unresolved". */
  query?: string
  /** Max issues fetched per poll. Sentry caps a page at 100. */
  limit?: number
  /** Source name stamped on reports, e.g. "glitchtip". Defaults to "sentry". */
  name?: string
  fetch?: typeof globalThis.fetch
}

interface SentryIssue {
  id: string | number
  title: string
  culprit?: string
  permalink?: string
  lastSeen: string
  metadata?: { value?: string; type?: string }
  count?: string | number
}

/**
 * Polls the Sentry (or GlitchTip) issues API for a project. Sentry has already
 * grouped raw events into issues, so the issue id is the natural fingerprint:
 * it lands in `Report.fingerprint` as "<name>:<issue id>", which makes every
 * re-occurrence of a known error a free tier-1 match once a ticket carries it.
 *
 * Cursor: the ISO `lastSeen` timestamp of the newest issue observed. Issues
 * are fetched sorted by last-seen and filtered client-side, which avoids
 * depending on server-side search syntax that differs between Sentry and
 * GlitchTip.
 */
export function sentrySource(options: SentrySourceOptions): Source {
  const {
    token,
    org,
    project,
    baseUrl = 'https://sentry.io',
    query = 'is:unresolved',
    limit = 100,
    name = 'sentry',
    fetch = globalThis.fetch,
  } = options

  return {
    name,
    async poll(cursor) {
      const url = new URL(`${baseUrl.replace(/\/$/, '')}/api/0/projects/${org}/${project}/issues/`)
      url.searchParams.set('query', query)
      url.searchParams.set('sort', 'date')
      url.searchParams.set('limit', String(limit))

      const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
      if (!response.ok) {
        throw new Error(`${name}: HTTP ${response.status} from ${url.pathname} — ${(await response.text()).slice(0, 200)}`)
      }
      const payload: unknown = await response.json()
      if (!Array.isArray(payload)) {
        throw new Error(`${name}: expected a JSON array of issues, got ${typeof payload}`)
      }

      const issues = payload.filter(isSentryIssue)
      const since = cursor ? Date.parse(cursor) : Number.NaN
      const fresh = issues.filter((issue) => {
        const seen = Date.parse(issue.lastSeen)
        return Number.isNaN(since) ? true : Number.isFinite(seen) && seen > since
      })

      const reports: Report[] = fresh
        .map((issue) => toReport(issue, name))
        .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())

      const newest = issues.reduce((max, issue) => Math.max(max, Date.parse(issue.lastSeen) || 0), 0)
      const nextCursor =
        newest > 0 && (Number.isNaN(since) || newest > since) ? new Date(newest).toISOString() : (cursor ?? new Date(0).toISOString())

      return { reports, cursor: nextCursor }
    },
  }
}

function isSentryIssue(value: unknown): value is SentryIssue {
  if (typeof value !== 'object' || value === null) return false
  const issue = value as Record<string, unknown>
  return (
    (typeof issue['id'] === 'string' || typeof issue['id'] === 'number') &&
    typeof issue['title'] === 'string' &&
    typeof issue['lastSeen'] === 'string'
  )
}

function toReport(issue: SentryIssue, name: string): Report {
  const text = [issue.title, issue.culprit, issue.metadata?.value]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join('\n')
  const report: Report = {
    id: `${name}-${issue.id}`,
    source: name,
    title: issue.title,
    text: text || issue.title,
    fingerprint: `${name}:${issue.id}`,
    occurredAt: new Date(issue.lastSeen),
    raw: issue,
  }
  if (issue.permalink) report.link = issue.permalink
  return report
}
