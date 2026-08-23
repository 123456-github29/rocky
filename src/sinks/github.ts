import type { Report, Ticket } from '../types'
import type { Sink } from './types'
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

  const api = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> => {
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
    return response.json()
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
      await api('POST', `/repos/${owner}/${repo}/issues/${ticketId}/comments`, {
        body: annotationBody(report),
      })
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
