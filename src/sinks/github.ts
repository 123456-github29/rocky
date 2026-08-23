import type { Report, Ticket } from '../types'
import type { LabelChange, Sink, TicketResolution } from './types'
import { annotationBody, firstLine, ticketBody } from './format'

export interface GithubSinkOptions {
  /** Token with issues read/write on the repository. */
  token: string
  owner: string
  repo: string
  /** API root. Defaults to github.com; for GitHub Enterprise use e.g. "https://ghe.example.com/api/v3". */
  baseUrl?: string
  /** listOpen fetches pages of 100 open issues, at most this many pages. */
  maxPages?: number
  /** Sink name used in errors. Defaults to "github". */
  name?: string
  fetch?: typeof globalThis.fetch
}

interface GithubIssue {
  number: number
  title: string
  body?: string | null
  state?: string
  html_url?: string
  pull_request?: unknown
}

/**
 * Fingerprints survive the round trip through GitHub as an HTML comment in the
 * issue body (URI-encoded so no value can break out of the comment). Invisible
 * in the rendered issue, parsed back out by listOpen — this is what lets a
 * recurring error tier-1-match the ticket rocky filed for it.
 */
const FINGERPRINT_MARKER = /<!--\s*rocky:fingerprint:([^\s>]+)\s*-->/

/**
 * GitHub Issues as the ticket store. State mapping is the honest one: GitHub
 * only has open/closed, so "approved" and "in_progress" never occur here —
 * open issues are `open`, everything else `closed`.
 */
export function githubSink(options: GithubSinkOptions): Sink {
  const {
    token,
    owner,
    repo,
    baseUrl = 'https://api.github.com',
    maxPages = 10,
    name = 'github',
    fetch = globalThis.fetch,
  } = options
  const root = baseUrl.replace(/\/$/, '')
  // Where humans read this repo. github.com splits API and web onto different
  // hosts; GitHub Enterprise puts the API under a /api/v3 path on the same one.
  const webRoot =
    root === 'https://api.github.com' ? 'https://github.com' : root.replace(/\/api\/v3$/, '')

  /**
   * Encode a value used as a single URL path segment.
   *
   * Ticket ids reach this sink from the dashboard, the CLI, and the state
   * ledger. Interpolated raw, an id of "1/../../../../orgs/x/memberships"
   * normalizes to a completely different GitHub endpoint — called with the
   * user's token. Everything that lands between slashes goes through here.
   */
  const segment = (value: string | number): string => encodeURIComponent(String(value))

  const api = async (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`${root}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) {
      throw new Error(`${name}: HTTP ${response.status} from ${method} ${path} — ${(await response.text()).slice(0, 200)}`)
    }
    // 204 No Content is the success shape for label removal.
    if (response.status === 204) return null
    return response.json()
  }

  /**
   * What closed the issue. GitHub does not put this on the issue itself, so it
   * comes from the timeline: the newest cross-referencing pull request, else
   * the closing commit. Best-effort by design — a completion notice that says
   * "closed, no linked change found" is far better than one that never fires
   * because the timeline endpoint was unavailable.
   */
  const closingChange = async (ticketId: string | number): Promise<string | null> => {
    let events: unknown
    try {
      events = await api('GET', `/repos/${owner}/${repo}/issues/${segment(ticketId)}/timeline?per_page=100`)
    } catch {
      return null
    }
    if (!Array.isArray(events)) return null

    for (const event of [...events].reverse()) {
      if (typeof event !== 'object' || event === null) continue
      const entry = event as Record<string, unknown>
      const source = entry['source'] as Record<string, unknown> | undefined
      const sourceIssue = source?.['issue'] as Record<string, unknown> | undefined
      if (entry['event'] === 'cross-referenced' && sourceIssue?.['pull_request'] !== undefined) {
        const url = sourceIssue['html_url']
        if (typeof url === 'string') return url
      }
      if (entry['event'] === 'closed' && typeof entry['commit_id'] === 'string') {
        return `${webRoot}/${owner}/${repo}/commit/${entry['commit_id']}`
      }
    }
    return null
  }

  return {
    name,
    async listOpen() {
      const tickets: Ticket[] = []
      for (let page = 1; page <= maxPages; page++) {
        const payload = await api('GET', `/repos/${owner}/${repo}/issues?state=open&per_page=100&page=${page}`)
        if (!Array.isArray(payload)) {
          throw new Error(`${name}: expected a JSON array of issues, got ${typeof payload}`)
        }
        // The issues endpoint also returns pull requests; those are not tickets.
        const issues = payload.filter(isIssue).filter((issue) => issue.pull_request === undefined)
        tickets.push(...issues.map((issue) => toTicket(issue)))
        if (payload.length < 100) break
      }
      return tickets
    },

    async create(report, opts) {
      const marker = report.fingerprint
        ? `\n\n<!-- rocky:fingerprint:${encodeURIComponent(report.fingerprint)} -->`
        : ''
      const issue = await api('POST', `/repos/${owner}/${repo}/issues`, {
        title: report.title ?? firstLine(report.text),
        body: ticketBody(report) + marker,
        labels: opts.labels,
      })
      if (!isIssue(issue)) {
        throw new Error(`${name}: unexpected response shape from issue creation`)
      }
      return toTicket(issue)
    },

    async annotate(ticketId, report) {
      await api('POST', `/repos/${owner}/${repo}/issues/${segment(ticketId)}/comments`, {
        body: annotationBody(report),
      })
    },

    async listByLabel(label: string) {
      const tickets: Ticket[] = []
      for (let page = 1; page <= maxPages; page++) {
        const query = `state=open&labels=${encodeURIComponent(label)}&per_page=100&page=${page}`
        const payload = await api('GET', `/repos/${owner}/${repo}/issues?${query}`)
        if (!Array.isArray(payload)) {
          throw new Error(`${name}: expected a JSON array of issues, got ${typeof payload}`)
        }
        const issues = payload.filter(isIssue).filter((issue) => issue.pull_request === undefined)
        tickets.push(...issues.map((issue) => toTicket(issue)))
        if (payload.length < 100) break
      }
      return tickets
    },

    async setLabels(ticketId: string | number, change: LabelChange) {
      const add = change.add ?? []
      if (add.length > 0) {
        await api('POST', `/repos/${owner}/${repo}/issues/${segment(ticketId)}/labels`, { labels: add })
      }
      for (const label of change.remove ?? []) {
        try {
          await api('DELETE', `/repos/${owner}/${repo}/issues/${segment(ticketId)}/labels/${encodeURIComponent(label)}`)
        } catch (error) {
          // Removing a label the issue never had is the desired end state, not
          // a failure — GitHub says 404 for it either way.
          if (!(error instanceof Error && error.message.includes('HTTP 404'))) throw error
        }
      }
    },

    async comment(ticketId: string | number, body: string) {
      await api('POST', `/repos/${owner}/${repo}/issues/${segment(ticketId)}/comments`, { body })
    },

    async resolution(ticketId: string | number): Promise<TicketResolution> {
      const issue = await api('GET', `/repos/${owner}/${repo}/issues/${segment(ticketId)}`)
      if (!isIssue(issue)) {
        throw new Error(`${name}: unexpected response shape reading issue ${String(ticketId)}`)
      }
      if (issue.state !== 'closed') return { closed: false, fix: null }
      return { closed: true, fix: await closingChange(ticketId) }
    },
  }
}

function isIssue(value: unknown): value is GithubIssue {
  if (typeof value !== 'object' || value === null) return false
  const issue = value as Record<string, unknown>
  return typeof issue['number'] === 'number' && typeof issue['title'] === 'string'
}

function toTicket(issue: GithubIssue): Ticket {
  const body = issue.body ?? ''
  const match = FINGERPRINT_MARKER.exec(body)
  const fingerprint = match?.[1] ? safeDecode(match[1]) : null
  const summary = body.replace(FINGERPRINT_MARKER, '').trim()
  return {
    id: issue.number,
    title: issue.title,
    summary: summary.length > 2000 ? `${summary.slice(0, 2000)}…` : summary,
    fingerprint,
    state: issue.state === 'closed' ? 'closed' : 'open',
    link: issue.html_url ?? '',
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
