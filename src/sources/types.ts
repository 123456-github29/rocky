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
  poll(cursor: string | null): Promise<{
    reports: Report[]
    cursor: string
    /**
     * The whole polled window, not only what is new since `cursor`.
     *
     * Optional, and only meaningful for sources that expose standing state —
     * an error tracker returns every open issue with its count, an inbox does
     * not. It is what an investigation reads: you cannot tell a regression
     * from a long-standing annoyance, or spot five signatures sharing one
     * cause, by looking only at what arrived in the last fifteen minutes.
     *
     * Omit it and rocky investigates the new reports alone.
     */
    corpus?: Report[]
  }>
}
