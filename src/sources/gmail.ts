import type { Report } from '../types'
import type { Source } from './types'

export interface GmailSourceOptions {
  /**
   * Returns a valid OAuth2 access token with at least gmail.readonly scope.
   * Use `oauthRefreshAuth()` for the common refresh-token setup, or supply
   * your own (e.g. from a secrets manager).
   */
  auth: () => Promise<string>
  /** Only unread mail carrying this Gmail label. One of `label`/`address` is required. */
  label?: string
  /** Only unread mail from this address. One of `label`/`address` is required. */
  address?: string
  /** Max messages fetched per poll. */
  limit?: number
  /** Source name stamped on reports. Defaults to "gmail". */
  name?: string
  fetch?: typeof globalThis.fetch
}

interface GmailMessageStub {
  id: string
}

interface GmailPayload {
  mimeType?: string
  body?: { data?: string }
  parts?: GmailPayload[]
  headers?: Array<{ name?: string; value?: string }>
}

interface GmailMessage {
  id: string
  internalDate?: string
  snippet?: string
  payload?: GmailPayload
}

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'

/**
 * Polls one Gmail label or address for unread mail.
 *
 * Cursor: epoch seconds of the newest message seen, applied as an `after:`
 * search term on the next poll. `after:` is second-granular, so the newest
 * message can reappear once on the following poll — report ids are stable
 * (`gmail-<message id>`), so callers can drop the repeat. Gaps are worse than
 * repeats.
 */
export function gmailSource(options: GmailSourceOptions): Source {
  const { auth, label, address, limit = 25, name = 'gmail', fetch = globalThis.fetch } = options
  if (!label && !address) {
    throw new TypeError('gmailSource requires at least one of "label" or "address"')
  }

  const get = async (url: string): Promise<unknown> => {
    const token = await auth()
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
    if (!response.ok) {
      throw new Error(`${name}: HTTP ${response.status} from Gmail — ${(await response.text()).slice(0, 200)}`)
    }
    return response.json()
  }

  return {
    name,
    async poll(cursor) {
      const terms = ['is:unread']
      if (label) terms.push(`label:${label}`)
      if (address) terms.push(`from:${address}`)
      if (cursor && /^\d+$/.test(cursor)) terms.push(`after:${cursor}`)

      const listUrl = new URL(`${GMAIL_API}/messages`)
      listUrl.searchParams.set('q', terms.join(' '))
      listUrl.searchParams.set('maxResults', String(limit))

      const listing = (await get(listUrl.toString())) as { messages?: unknown }
      const stubs = Array.isArray(listing.messages)
        ? listing.messages.filter(
            (m): m is GmailMessageStub =>
              typeof m === 'object' && m !== null && typeof (m as Record<string, unknown>)['id'] === 'string',
          )
        : []

      const reports: Report[] = []
      let newestMs = 0
      for (const stub of stubs) {
        const message = (await get(`${GMAIL_API}/messages/${stub.id}?format=full`)) as GmailMessage
        const occurredMs = Number(message.internalDate ?? 0)
        newestMs = Math.max(newestMs, occurredMs)
        reports.push(toReport(message, name, occurredMs))
      }
      reports.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())

      const nextCursor = newestMs > 0 ? String(Math.floor(newestMs / 1000)) : (cursor ?? '0')
      return { reports, cursor: nextCursor }
    },
  }
}

function toReport(message: GmailMessage, name: string, occurredMs: number): Report {
  const header = (headerName: string): string | undefined =>
    message.payload?.headers?.find((h) => h.name?.toLowerCase() === headerName)?.value
  const subject = header('subject')
  const from = header('from')
  const body = extractPlainText(message.payload) ?? message.snippet ?? ''

  const report: Report = {
    id: `${name}-${message.id}`,
    source: name,
    text: [subject, body].filter((part): part is string => Boolean(part && part.trim())).join('\n\n') || '(empty message)',
    link: `https://mail.google.com/mail/u/0/#all/${message.id}`,
    occurredAt: new Date(occurredMs || 0),
    raw: message,
  }
  if (subject) report.title = subject
  if (from) report.reporter = from
  return report
}

function extractPlainText(payload: GmailPayload | undefined): string | null {
  if (!payload) return null
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data)
  }
  for (const part of payload.parts ?? []) {
    const text = extractPlainText(part)
    if (text) return text
  }
  return null
}

function decodeBase64Url(data: string): string | null {
  try {
    return Buffer.from(data, 'base64url').toString('utf8')
  } catch {
    return null
  }
}

export interface OAuthRefreshAuthOptions {
  clientId: string
  clientSecret: string
  refreshToken: string
  fetch?: typeof globalThis.fetch
}

/**
 * The common Gmail auth setup: exchange a long-lived OAuth2 refresh token for
 * short-lived access tokens, cached until a minute before expiry.
 */
export function oauthRefreshAuth(options: OAuthRefreshAuthOptions): () => Promise<string> {
  const { clientId, clientSecret, refreshToken, fetch = globalThis.fetch } = options
  let cached: { token: string; expiresAt: number } | null = null

  return async () => {
    if (cached && cached.expiresAt > Date.now()) return cached.token
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    })
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (!response.ok || typeof payload['access_token'] !== 'string') {
      const detail = typeof payload['error'] === 'string' ? payload['error'] : `HTTP ${response.status}`
      throw new Error(`gmail: OAuth token refresh failed (${detail})`)
    }
    const expiresIn = typeof payload['expires_in'] === 'number' ? payload['expires_in'] : 300
    cached = { token: payload['access_token'], expiresAt: Date.now() + (expiresIn - 60) * 1000 }
    return cached.token
  }
}
