import type { Report, TaskAnalysis, Ticket } from '../types'

/** What the tracker knows about a ticket being finished. */
export interface TicketResolution {
  /** True once the tracker considers the ticket done (issue closed, Linear state completed/canceled). */
  closed: boolean
  /** The change that closed it — a merged PR — when the tracker names one. Null when it does not. */
  fix?: string | null
}

/** Label changes to apply in one call. Both sides are optional; an empty change is a no-op. */
export interface LabelChange {
  add?: string[]
  remove?: string[]
}

/**
 * Where tickets live. Counterpart to `Source`: sources produce Reports, the
 * matcher decides, and a Sink records the decision. Sinks never import the
 * matcher.
 *
 * The first three methods are what `rocky run` needs. The rest drive the
 * approval loop (`rocky watch`, `rocky approve`, `rocky deny`) and are
 * optional so that a minimal hand-written sink keeps working — the commands
 * that need them say so by name instead of failing on an undefined call.
 */
export interface Sink {
  name: string
  /** The open-ish tickets new reports are deduplicated against. */
  listOpen(): Promise<Ticket[]>
  /**
   * File a new ticket for a report.
   *
   * `analysis`, when present, is the model's brief on what needs doing — put it
   * at the head of the ticket body (`ticketBody` does this for you) so the
   * human approving and the agent fixing both read it first. It is absent
   * whenever no analyst is configured or the call failed, and a sink must file
   * the ticket regardless: an un-analyzed bug is still a bug.
   */
  create(
    report: Report,
    opts: {
      labels: string[]
      analysis?: TaskAnalysis | null
      /** Overrides the title derived from the report — used when rocky composed the ticket from a finding. */
      title?: string
      /** Overrides the whole body. The report still supplies the source/reporter footer. */
      body?: string
      /** Every signature this ticket covers. Defaults to the report's own, when it has one. */
      fingerprints?: string[]
    },
  ): Promise<Ticket>
  /**
   * Record a duplicate occurrence on an existing ticket instead of creating a
   * new one: a comment that must say who reported it and link back to the
   * source, so the extra signal (frequency, affected users) is never lost.
   */
  annotate(ticketId: string | number, report: Report): Promise<void>

  /** Open tickets carrying a label. Used to find rocky's funnel and the approved subset. */
  listByLabel?(label: string): Promise<Ticket[]>
  /** Add and/or remove labels on one ticket. This is how approval is recorded. */
  setLabels?(ticketId: string | number, change: LabelChange): Promise<void>
  /** Post a plain comment — the audit trail for who approved or denied, and why. */
  comment?(ticketId: string | number, body: string): Promise<void>
  /** Whether a ticket is finished, and what closed it. */
  resolution?(ticketId: string | number): Promise<TicketResolution>
}

/** A Sink that implements the approval-loop methods. */
export type GatedSink = Sink &
  Required<Pick<Sink, 'listByLabel' | 'setLabels' | 'resolution'>>

/**
 * Narrow a Sink to one that can run the approval loop, naming the missing
 * methods rather than dying on `undefined is not a function` three frames in.
 */
export function assertGatedSink(sink: Sink, command: string): asserts sink is GatedSink {
  const missing = (['listByLabel', 'setLabels', 'resolution'] as const).filter((method) => typeof sink[method] !== 'function')
  if (missing.length > 0) {
    throw new TypeError(
      `rocky ${command}: sink "${sink.name}" does not implement ${missing.join(', ')}. ` +
        'The shipped githubSink and linearSink do; a custom sink needs them to run the approval loop.',
    )
  }
}
