import type { MatchResult, Report, TaskAnalysis, Ticket } from './types'
import type { RockyProjectConfig } from './project'
import type { RockyState } from './state'
import { SEEN_CAP } from './state'
import { match, signaturesOf } from './match'
import { analyze } from './analyze'
import { findingBody, investigate } from './investigate'
import type { Finding } from './investigate'
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
  | { type: 'analyzed'; reportId: string; analysis: TaskAnalysis }
  | { type: 'analysis-failed'; reportId: string }
  | { type: 'investigated'; corpus: number; findings: Finding[] }
  | { type: 'investigation-failed'; corpus: number }
  | { type: 'finding'; finding: Finding; action: 'create' | 'known'; ticketId: string | number | null; live: boolean }

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
  /**
   * New bugs given a written brief before filing. Never counted for duplicates:
   * a recurrence of a known error is analyzed once, on the ticket it matched.
   */
  analyzed: number
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
  return project.investigator ? investigateRun(project, state, options) : triageRun(project, state, options)
}

/**
 * The investigating pass: read the logs, work out what is wrong, file the work.
 *
 * The unit here is a *problem*, not a report. One finding can rest on five
 * error signatures and become one ticket; the loudest signature in the window
 * can produce no finding at all because it is noise. That is the difference
 * from {@link triageRun}, which can only ever mirror the error tracker's own
 * grouping.
 *
 * Findings map to existing tickets by the signatures they cite, never by the
 * model's wording — the same problem investigated twice is phrased differently
 * every time, so matching on prose would file a fresh ticket every cycle.
 */
async function investigateRun(
  project: RockyProjectConfig,
  state: RockyState,
  options: RunOptions,
): Promise<{ summary: RunSummary; state: RockyState }> {
  const { live = false, log = () => undefined } = options
  const labels = project.labels ?? ['rocky']
  const summary: RunSummary = { reports: 0, created: 0, annotated: 0, skipped: 0, errors: 0, llmCalls: 0, llmFailures: 0, analyzed: 0, live }
  const next: RockyState = { cursors: { ...state.cursors }, seen: [...state.seen], tickets: { ...state.tickets } }

  let tickets: Ticket[]
  try {
    tickets = await project.sink.listOpen()
  } catch (error) {
    throw new Error(`could not list open tickets from sink "${project.sink.name}": ${message(error)}`)
  }

  // Gather the standing state of every source, not only what is new. A
  // regression is only visible next to what was already there.
  const corpus: Report[] = []
  const byId = new Map<string, Report>()
  const polledCursors: Record<string, string> = {}
  for (const source of project.sources) {
    try {
      const polled = await source.poll(state.cursors[source.name] ?? null)
      const window = polled.corpus ?? polled.reports
      for (const report of window) {
        if (byId.has(report.id)) continue
        byId.set(report.id, report)
        corpus.push(report)
      }
      polledCursors[source.name] = polled.cursor
      log({ type: 'poll', source: source.name, count: window.length, cursor: polled.cursor })
    } catch (error) {
      summary.errors++
      log({ type: 'poll-error', source: source.name, message: message(error) })
    }
  }
  summary.reports = corpus.length
  if (corpus.length === 0) {
    return { summary, state: next }
  }

  summary.llmCalls++
  const { findings, failed } = await investigate(corpus, {
    llm: project.investigator!,
    tickets,
    ...(project.investigationTemplate ? { template: project.investigationTemplate } : {}),
    ...(project.investigationLimit ? { limit: project.investigationLimit } : {}),
  })
  if (failed) {
    // Rocky is blind this pass. Loud, and counted — a service whose logs go
    // unread looks exactly like a healthy one from the outside.
    summary.llmFailures++
    log({ type: 'investigation-failed', corpus: corpus.length })
    return { summary, state: next }
  }
  log({ type: 'investigated', corpus: corpus.length, findings })
  if (findings.length === 0) {
    // A real answer: nothing in these logs warrants engineering work.
    if (live) Object.assign(next.cursors, polledCursors)
    return { summary, state: next }
  }

  for (const finding of findings) {
    // A finding is already known if any signature it cites is on a ticket.
    // Deterministic, and independent of how the model phrased it this time.
    const known = tickets.find((ticket) => {
      const covered = signaturesOf(ticket)
      return finding.evidence.fingerprints.some((f) => covered.includes(f))
    })

    log({ type: 'finding', finding, action: known ? 'known' : 'create', ticketId: known?.id ?? null, live })
    if (!live) {
      if (known) summary.skipped++
      else {
        summary.created++
        summary.analyzed++
        tickets.push(pendingFinding(finding))
      }
      continue
    }
    if (known) {
      summary.skipped++
      continue
    }

    try {
      const primary = byId.get(finding.evidence.reportIds[0]!)!
      const ticket = await project.sink.create(primary, {
        labels,
        title: finding.title,
        body: findingBody(finding),
        fingerprints: finding.evidence.fingerprints,
      })
      tickets.push(ticket)
      summary.created++
      summary.analyzed++
      log({ type: 'created', reportId: primary.id, ticketId: ticket.id, link: ticket.link })
    } catch (error) {
      summary.errors++
      log({ type: 'action-error', action: 'create', reportId: finding.evidence.reportIds[0]!, message: message(error) })
      // A finding that could not be filed must be re-found next cycle, so no
      // cursor moves this run.
      return { summary, state: next }
    }
  }

  if (live) Object.assign(next.cursors, polledCursors)
  return { summary, state: next }
}

/** Stand-in for the ticket a dry-run investigation would have filed. */
function pendingFinding(finding: Finding): Ticket {
  return {
    id: `pending:${finding.evidence.fingerprints[0] ?? finding.title}`,
    title: finding.title,
    summary: finding.whatIsWrong,
    fingerprint: finding.evidence.fingerprints[0] ?? null,
    fingerprints: finding.evidence.fingerprints,
    state: 'open',
    link: '',
  }
}

/** The per-report pass: match each incoming report against open tickets, then file or comment. */
async function triageRun(
  project: RockyProjectConfig,
  state: RockyState,
  options: RunOptions,
): Promise<{ summary: RunSummary; state: RockyState }> {
  const { live = false, log = () => undefined } = options
  const labels = project.labels ?? ['rocky']
  const summary: RunSummary = { reports: 0, created: 0, annotated: 0, skipped: 0, errors: 0, llmCalls: 0, llmFailures: 0, analyzed: 0, live }
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
          // Only new bugs get analyzed. A recurrence of a known error already
          // has a brief on the ticket it matched, so paying for another would
          // buy nothing — which is what keeps this cost proportional to
          // distinct bugs rather than to error volume.
          const analysis = await analyzeReport(project, report, log)
          if (analysis) summary.analyzed++
          const ticket = await project.sink.create(report, { labels, analysis })
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

/**
 * Write the brief for a new bug, if an analyst is configured.
 *
 * Never throws and never blocks filing. An analysis that fails means the ticket
 * carries the raw report and nothing else, exactly as rocky behaved before this
 * existed — losing the brief is an inconvenience, losing the bug report is not
 * acceptable.
 */
async function analyzeReport(
  project: RockyProjectConfig,
  report: Report,
  log: (event: RunEvent) => void,
): Promise<TaskAnalysis | null> {
  if (!project.analyst) return null
  const analysis = await analyze(report, { llm: project.analyst, ...(project.analysisTemplate ? { template: project.analysisTemplate } : {}) })
  if (analysis) {
    log({ type: 'analyzed', reportId: report.id, analysis })
  } else {
    log({ type: 'analysis-failed', reportId: report.id })
  }
  return analysis
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
