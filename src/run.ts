import type { MatchResult, Report, Ticket } from './types'
import type { RockyProjectConfig } from './project'
import type { RockyState } from './state'
import { SEEN_CAP } from './state'
import { match } from './match'
import { firstLine } from './sinks/format'

/**
 * Structured log events — one per observable step, so every decision is
 * inspectable: which tier fired, what confidence, what rocky did (or, in
 * dry-run, would have done).
 */
export type RunEvent =
  | { type: 'poll'; source: string; count: number; cursor: string }
  | { type: 'poll-error'; source: string; message: string }
  | {
      type: 'decision'
      report: { id: string; source: string }
      result: MatchResult
      action: 'create' | 'annotate'
      live: boolean
    }
  | { type: 'skip'; reportId: string; source: string; reason: 'seen' }
  | { type: 'created'; reportId: string; ticketId: string | number; link: string }
  | { type: 'annotated'; reportId: string; ticketId: string | number }
  | { type: 'action-error'; action: 'create' | 'annotate'; reportId: string; message: string }

export interface RunOptions {
  /** false (the default) is a dry run: decisions are made and logged, nothing is written anywhere. */
  live?: boolean
  log?: (event: RunEvent) => void
}

export interface RunSummary {
  /** Reports processed (after seen-skips). */
  reports: number
  /** Tickets created — or, in dry-run, that would have been. */
  created: number
  /** Duplicates annotated — or, in dry-run, that would have been. */
  annotated: number
  /** Reports skipped because a previous live run already processed them. */
  skipped: number
  errors: number
  /** Tier-3 decisions this run — each one was an LLM call (dry runs pay for these too). */
  llmCalls: number
  /**
   * How many of those calls threw. Each one silently degraded that report to a
   * fail-safe no-match, so a run with failures here deduplicates worse than
   * the numbers suggest — and says nothing about tier 3 being worth its cost.
   */
  llmFailures: number
  live: boolean
}

/**
 * One pass: poll every source, match every new report against the sink's open
 * tickets, then create or annotate. Pure with respect to state: takes the
 * previous {@link RockyState}, returns the next one, touches no files — the
 * CLI owns persistence (and only persists on live runs).
 *
 * Failure containment, in the safe direction throughout:
 * - a source whose poll throws is skipped this run, cursor untouched;
 * - a report whose create/annotate throws is not marked seen and its source's
 *   cursor is not advanced, so the next run retries it;
 * - `listOpen` failing aborts the run — without candidates every report would
 *   wrongly become a fresh ticket.
 */
export async function run(
  project: RockyProjectConfig,
  state: RockyState,
  options: RunOptions = {},
): Promise<{ summary: RunSummary; state: RockyState }> {
  const { live = false, log = () => undefined } = options
  const labels = project.labels ?? ['rocky']
  const summary: RunSummary = { reports: 0, created: 0, annotated: 0, skipped: 0, errors: 0, llmCalls: 0, llmFailures: 0, live }
  // Approval phases belong to `watch`; carry them through untouched so a run
  // and a watch can share one state file without clobbering each other.
  const next: RockyState = { cursors: { ...state.cursors }, seen: [...state.seen], tickets: { ...state.tickets } }
  const seen = new Set(state.seen)

  let tickets: Ticket[]
  try {
    tickets = await project.sink.listOpen()
  } catch (error) {
    // No "rocky:" prefix here — the CLI adds one, and two reads as a bug.
    throw new Error(`could not list open tickets from sink "${project.sink.name}": ${message(error)}`)
  }

  for (const source of project.sources) {
    let polled: { reports: Report[]; cursor: string }
    try {
      polled = await source.poll(state.cursors[source.name] ?? null)
    } catch (error) {
      summary.errors++
      log({ type: 'poll-error', source: source.name, message: message(error) })
      continue
    }
    log({ type: 'poll', source: source.name, count: polled.reports.length, cursor: polled.cursor })

    let failed = false
    for (const report of polled.reports) {
      if (seen.has(report.id)) {
        summary.skipped++
        log({ type: 'skip', reportId: report.id, source: source.name, reason: 'seen' })
        continue
      }
      summary.reports++

      const result = await match(report, tickets, project.match)
      if (result.tier === 3) summary.llmCalls++
      if (result.llmFailed) summary.llmFailures++
      const action = result.matchId === null ? 'create' : 'annotate'
      log({ type: 'decision', report: { id: report.id, source: report.source }, result, action, live })

      if (!live) {
        if (action === 'create') {
          summary.created++
          // Keep the dry-run batch faithful: later reports in this run can
          // match the ticket this one would have created.
          tickets.push(pendingTicket(report))
        } else {
          summary.annotated++
        }
        continue
      }

      try {
        if (result.matchId === null) {
          const ticket = await project.sink.create(report, { labels })
          tickets.push(ticket)
          summary.created++
          log({ type: 'created', reportId: report.id, ticketId: ticket.id, link: ticket.link })
        } else {
          await project.sink.annotate(result.matchId, report)
          summary.annotated++
          log({ type: 'annotated', reportId: report.id, ticketId: result.matchId })
        }
        seen.add(report.id)
        next.seen.push(report.id)
      } catch (error) {
        failed = true
        summary.errors++
        log({ type: 'action-error', action, reportId: report.id, message: message(error) })
      }
    }

    if (live && !failed) {
      next.cursors[source.name] = polled.cursor
    }
  }

  next.seen = next.seen.slice(-SEEN_CAP)
  return { summary, state: next }
}

/** Stand-in for the ticket a dry-run would have created. Its id makes the simulation visible in logs. */
function pendingTicket(report: Report): Ticket {
  return {
    id: `pending:${report.id}`,
    title: report.title ?? firstLine(report.text),
    summary: report.text,
    fingerprint: report.fingerprint ?? null,
    state: 'open',
    link: '',
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
