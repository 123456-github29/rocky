import type { Report, Ticket } from '../types'

/**
 * Where tickets live. Counterpart to `Source`: sources produce Reports, the
 * matcher decides, and a Sink records the decision. Sinks never import the
 * matcher.
 */
export interface Sink {
  name: string
  /** The open-ish tickets new reports are deduplicated against. */
  listOpen(): Promise<Ticket[]>
  /** File a new ticket for a report. */
  create(report: Report, opts: { labels: string[] }): Promise<Ticket>
  /**
   * Record a duplicate occurrence on an existing ticket instead of creating a
   * new one: a comment that must say who reported it and link back to the
   * source, so the extra signal (frequency, affected users) is never lost.
   */
  annotate(ticketId: string | number, report: Report): Promise<void>
}
