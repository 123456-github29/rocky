import type { Ticket } from './types'
import type { RockyProjectConfig } from './project'
import type { RockyState, TicketPhase, TicketProgress } from './state'
import { pruneTickets } from './state'
import type { Notifier, NotifyMessage } from './notify/types'
import { approvalMessage, completedMessage, startedMessage } from './notify/format'
import { assertGatedSink } from './sinks/types'

/** One observable step of the approval loop. Mirrors `RunEvent` so `--json` output is uniform. */
export type WatchEvent =
  | { type: 'watch-poll'; open: number; approved: number; tracked: number }
  | { type: 'phase'; ticketId: string; from: TicketPhase | 'new'; to: TicketPhase; title: string; link: string; live: boolean }
  /**
   * The exact text rocky decided to send, emitted whether or not it is
   * delivered. This is what makes a dry run worth reading: you see the message
   * you would have to answer from a phone, not just that one would exist.
   */
  | { type: 'message'; ticketId: string; kind: NotifyMessage['kind']; subject: string; body: string; live: boolean }
  | { type: 'notified'; ticketId: string; kind: NotifyMessage['kind']; via: string }
  | { type: 'notify-error'; ticketId: string; kind: NotifyMessage['kind']; via: string; message: string }
  | { type: 'watch-error'; ticketId: string; message: string }
  | { type: 'approve-hook-error'; ticketId: string; message: string }

export interface WatchOptions {
  /** false (the default) is a dry run: phases are computed and logged, nothing is sent and no state is written. */
  live?: boolean
  log?: (event: WatchEvent) => void
}

export interface WatchSummary {
  /** Tickets rocky is following after this pass (awaiting + approved). */
  tracked: number
  /** New tickets asked about this pass. */
  asked: number
  /** Tickets that crossed the gate this pass. */
  approved: number
  /** Tickets that closed and were reported done this pass. */
  completed: number
  /** Tickets that left the funnel without approval. */
  dismissed: number
  errors: number
  live: boolean
}

/**
 * One pass of the approval loop: ask about newly filed tickets, notice the ones
 * you approved, and report the ones that got fixed. Pure with respect to state,
 * like {@link run} — takes the previous {@link RockyState}, returns the next one,
 * writes no files.
 *
 * The tracker is the authority, not the state file. Approval is "the approve
 * label is on the ticket", which means you can approve from a chat reply, from
 * the GitHub UI, or from a teammate's phone, and every one of those looks the
 * same to rocky. The state file only records which messages already went out.
 *
 * Failure containment runs the same direction as everywhere else in rocky: a
 * notifier that throws leaves the phase untouched so the next pass retries,
 * and a ticket whose resolution lookup fails is logged and skipped rather than
 * reported done. Nothing here can move a ticket forward that you did not
 * approve — the worst failure is a message sent twice.
 */
export async function watch(
  project: RockyProjectConfig,
  state: RockyState,
  options: WatchOptions = {},
): Promise<{ summary: WatchSummary; state: RockyState }> {
  const { live = false, log = () => undefined } = options
  const sink = project.sink
  assertGatedSink(sink, 'watch')

  const rockyLabel = (project.labels ?? ['rocky'])[0]!
  const approveLabel = project.approveLabel ?? 'approved'
  const notifiers = toNotifiers(project.notify)
  const summary: WatchSummary = { tracked: 0, asked: 0, approved: 0, completed: 0, dismissed: 0, errors: 0, live }
  const tickets: Record<string, TicketProgress> = { ...state.tickets }
  const now = new Date().toISOString()

  const open = new Map((await sink.listByLabel(rockyLabel)).map((ticket) => [String(ticket.id), ticket]))
  const approvedIds = new Set((await sink.listByLabel(approveLabel)).map((ticket) => String(ticket.id)))
  log({ type: 'watch-poll', open: open.size, approved: approvedIds.size, tracked: Object.keys(tickets).length })

  /** Send to every notifier. Returns false if any failed, so the caller can hold the phase. */
  const notify = async (id: string, message: NotifyMessage): Promise<boolean> => {
    log({ type: 'message', ticketId: id, kind: message.kind, subject: message.subject, body: message.body, live })
    if (!live) return true
    let ok = true
    for (const notifier of notifiers) {
      try {
        await notifier.send(message)
        log({ type: 'notified', ticketId: id, kind: message.kind, via: notifier.name })
      } catch (error) {
        ok = false
        summary.errors++
        log({ type: 'notify-error', ticketId: id, kind: message.kind, via: notifier.name, message: reason(error) })
      }
    }
    return ok
  }

  const setPhase = (id: string, ticket: Ticket, from: TicketPhase | 'new', to: TicketPhase): void => {
    tickets[id] = { phase: to, title: ticket.title, link: ticket.link, changedAt: now }
    log({ type: 'phase', ticketId: id, from, to, title: ticket.title, link: ticket.link, live })
  }

  // 1. Tickets rocky filed but has never asked about. The approval request is
  //    what earns the right to record the phase: if it could not be delivered,
  //    the ticket stays unknown and the next pass asks again.
  for (const [id, ticket] of open) {
    if (tickets[id]) continue
    summary.asked++
    if (await notify(id, approvalMessage(ticket, { approveLabel }))) {
      setPhase(id, ticket, 'new', 'awaiting')
    }
  }

  // 2. Advance everything still in flight. Iterating the ledger rather than
  //    the open list is deliberate: a ticket closed by a merged fix is no
  //    longer open, and that is exactly the ticket whose completion is due.
  for (const [id, progress] of Object.entries(tickets)) {
    if (progress.phase === 'done' || progress.phase === 'dismissed') continue
    const ticket = open.get(id) ?? asTicket(id, progress)

    try {
      if (progress.phase === 'awaiting') {
        if (approvedIds.has(id)) {
          summary.approved++
          setPhase(id, ticket, 'awaiting', 'approved')
          await notify(id, startedMessage(ticket))
          if (project.onApprove && live) {
            try {
              await project.onApprove(ticket)
            } catch (error) {
              summary.errors++
              log({ type: 'approve-hook-error', ticketId: id, message: reason(error) })
            }
          }
        } else if (!open.has(id)) {
          // Off the funnel without the approve label: denied, or a human
          // closed it. Either way a person already decided — stay quiet.
          summary.dismissed++
          setPhase(id, ticket, 'awaiting', 'dismissed')
          continue
        }
      }

      if (tickets[id]?.phase === 'approved') {
        const resolved = await sink.resolution(id)
        if (resolved.closed) {
          summary.completed++
          if (await notify(id, completedMessage(ticket, { fix: resolved.fix ?? null }))) {
            setPhase(id, ticket, 'approved', 'done')
          }
        }
      }
    } catch (error) {
      summary.errors++
      log({ type: 'watch-error', ticketId: id, message: reason(error) })
    }
  }

  summary.tracked = Object.values(tickets).filter((t) => t.phase === 'awaiting' || t.phase === 'approved').length
  return { summary, state: { ...state, tickets: pruneTickets(tickets) } }
}

/**
 * Record an approval in the tracker. Deliberately does not touch the state
 * file: the label is the shared truth, so this works from any machine — the
 * one running `rocky watch` on a schedule will see it on its next pass.
 */
export async function approve(
  project: RockyProjectConfig,
  ticketId: string | number,
  options: { by?: string } = {},
): Promise<void> {
  const sink = project.sink
  assertGatedSink(sink, 'approve')
  await sink.setLabels(ticketId, { add: [project.approveLabel ?? 'approved'] })
  await sink.comment?.(ticketId, `Approved${options.by ? ` by ${options.by}` : ''} — handed to the coding agent by rocky.`)
}

/**
 * Take a ticket out of rocky's funnel by removing the label rocky tracks. The
 * ticket itself is left open and untouched: a "no" to *the agent fixing this
 * now* is not a claim that the bug is not real, and rocky does not get to
 * close other people's tickets.
 */
export async function deny(
  project: RockyProjectConfig,
  ticketId: string | number,
  options: { by?: string; reason?: string } = {},
): Promise<void> {
  const sink = project.sink
  assertGatedSink(sink, 'deny')
  await sink.comment?.(
    ticketId,
    `Not handed to the coding agent${options.by ? ` (denied by ${options.by})` : ''}.` +
      `${options.reason ? ` Reason: ${options.reason}` : ''}\n\nThe ticket stays open; rocky has stopped tracking it.`,
  )
  await sink.setLabels(ticketId, { remove: [(project.labels ?? ['rocky'])[0]!] })
}

/** One line per tracked ticket, newest phase change first. */
export function formatStatus(state: RockyState): string {
  const entries = Object.entries(state.tickets).sort(([, a], [, b]) => b.changedAt.localeCompare(a.changedAt))
  if (entries.length === 0) return 'No tickets tracked yet. Run `rocky run --live`, then `rocky watch --live`.'
  const width = Math.max(...entries.map(([id]) => id.length))
  return entries
    .map(([id, t]) => `${t.phase.padEnd(9)} ${id.padEnd(width)}  ${t.title}${t.link ? `  ${t.link}` : ''}`)
    .join('\n')
}

function toNotifiers(notify: RockyProjectConfig['notify']): Notifier[] {
  if (!notify) return []
  return Array.isArray(notify) ? notify : [notify]
}

/**
 * Stand-in for a ticket that has left the open list. The ledger keeps the
 * title and link precisely so a completion notice can still name the bug
 * after the tracker stopped returning it.
 */
function asTicket(id: string, progress: TicketProgress): Ticket {
  return { id, title: progress.title, summary: '', fingerprint: null, state: 'closed', link: progress.link }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
