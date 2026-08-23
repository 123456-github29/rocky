import type { Report } from '../types'
import type { Source } from './types'

/**
 * Maps one POSTed payload to zero or more Reports. Return null (or []) to
 * ignore a payload. Throwing is fine too — the caller's HTTP layer should turn
 * that into a 4xx so the sender knows its payload was rejected.
 */
export type WebhookMapper = (payload: unknown) => Report | Report[] | null

export interface WebhookSourceOptions {
  /** Turns whatever your systems POST into Reports. This is the whole contract. */
  map: WebhookMapper
  /** Source name stamped nowhere by default — your mapper sets `Report.source` — but used in errors. Defaults to "webhook". */
  name?: string
}

export interface WebhookSource extends Source {
  /**
   * Feed one POST body. Returns the reports it mapped, which are also queued
   * until the next `poll()` drains them. Throws (loudly) when the mapper
   * returns something that is not a valid Report.
   */
  ingest(payload: unknown): Report[]
  /** Reports waiting to be drained by poll(). */
  pending(): number
}

/**
 * The escape hatch: accept a POST from anything, map it with a user-supplied
 * function. Push-based under the hood — `ingest()` buffers, `poll()` drains —
 * so it still satisfies the pull-based `Source` interface the orchestrator
 * speaks.
 *
 * Cursor: a count of reports drained so far, meaningful only within this
 * process. Durability comes from the sender's retry semantics, not the cursor.
 */
export function webhookSource(options: WebhookSourceOptions): WebhookSource {
  const { map, name = 'webhook' } = options
  const buffer: Report[] = []
  let drained = 0

  return {
    name,
    ingest(payload) {
      const mapped = map(payload)
      const reports = mapped === null ? [] : Array.isArray(mapped) ? mapped : [mapped]
      for (const report of reports) assertReport(report, name)
      buffer.push(...reports)
      return reports
    },
    pending() {
      return buffer.length
    },
    async poll(cursor) {
      const reports = buffer.splice(0)
      drained += reports.length
      const previous = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0
      return { reports, cursor: String(Math.max(previous, drained)) }
    },
  }
}

function assertReport(value: unknown, name: string): asserts value is Report {
  const fail = (why: string): never => {
    throw new TypeError(`${name}: mapper returned an invalid Report — ${why}`)
  }
  if (typeof value !== 'object' || value === null) fail('not an object')
  const report = value as Record<string, unknown>
  if (typeof report['id'] !== 'string' || report['id'] === '') fail('"id" must be a non-empty string')
  if (typeof report['source'] !== 'string' || report['source'] === '') fail('"source" must be a non-empty string')
  if (typeof report['text'] !== 'string' || report['text'].trim() === '') fail('"text" must be a non-empty string')
  if (!(report['occurredAt'] instanceof Date) || Number.isNaN(report['occurredAt'].getTime())) {
    fail('"occurredAt" must be a valid Date')
  }
}
