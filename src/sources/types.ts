import type { Report } from '../types'

/**
 * A place bug reports come from.
 *
 * `poll` fetches what arrived since `cursor` (null on the very first poll) and
 * returns the reports — oldest first — plus the cursor to persist for the next
 * poll. The cursor is an opaque string: only the source that produced it ever
 * interprets it, callers just store it. Sources never import the matcher; they
 * only produce `Report`s.
 */
export interface Source {
  name: string
  poll(cursor: string | null): Promise<{ reports: Report[]; cursor: string }>
}
