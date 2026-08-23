import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * What `rocky run --live` persists between runs: one cursor per source (keyed
 * by source name) and the ids of recently processed reports. The seen list
 * exists because some cursors deliberately overlap (gmail's second-granular
 * `after:` repeats the boundary message rather than risk a gap) — report ids
 * are stable, so remembering them turns repeats into skips.
 */
export interface RockyState {
  cursors: Record<string, string>
  seen: string[]
  /**
   * How far each ticket has got through the approval loop, keyed by ticket id.
   * Only a record of which messages rocky has already sent — the *authority*
   * on approval is the label in the tracker, never this file. Losing it makes
   * rocky ask about open tickets again; it can never make rocky act on
   * something you did not approve.
   */
  tickets: Record<string, TicketProgress>
}

/**
 * - `awaiting`  — filed and asked about; waiting for the approve label.
 * - `approved`  — the gate is open, the runner owns it; waiting for it to close.
 * - `done`      — closed, and you were told.
 * - `dismissed` — it left the funnel without being approved (denied, or a
 *                 human closed it). Terminal, and deliberately silent.
 */
export type TicketPhase = 'awaiting' | 'approved' | 'done' | 'dismissed'

export interface TicketProgress {
  phase: TicketPhase
  /** Kept so `rocky status` can name a ticket without re-fetching the tracker. */
  title: string
  link: string
  /** ISO timestamp of the last phase change. */
  changedAt: string
}

/** Most report ids remembered. Old entries fall off FIFO. */
export const SEEN_CAP = 1000

/** Most finished tickets remembered, oldest dropped first. Live ones are never pruned. */
export const TICKET_CAP = 500

export function emptyState(): RockyState {
  return { cursors: {}, seen: [], tickets: {} }
}

const PHASES = new Set<string>(['awaiting', 'approved', 'done', 'dismissed'])

/**
 * Drop the oldest finished tickets once the ledger grows past {@link TICKET_CAP}.
 * `awaiting` and `approved` entries are never dropped at any size — forgetting
 * one would re-ask about a ticket you already answered.
 */
export function pruneTickets(tickets: Record<string, TicketProgress>): Record<string, TicketProgress> {
  const entries = Object.entries(tickets)
  if (entries.length <= TICKET_CAP) return { ...tickets }
  const live = entries.filter(([, t]) => t.phase === 'awaiting' || t.phase === 'approved')
  const finished = entries
    .filter(([, t]) => t.phase === 'done' || t.phase === 'dismissed')
    .sort(([, a], [, b]) => a.changedAt.localeCompare(b.changedAt))
  return Object.fromEntries([...live, ...finished.slice(-Math.max(0, TICKET_CAP - live.length))])
}

/**
 * Load the state file. A missing file is a fresh start; a corrupted one throws
 * rather than silently resetting cursors (which would re-process everything) —
 * delete the file yourself if a reset is what you want.
 */
export function loadState(path: string): RockyState {
  if (!existsSync(path)) return emptyState()
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(
      `state file ${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}). ` +
        'Fix it or delete it to start over — deleting re-processes whatever the sources still return.',
    )
  }
  const state = parsed as Record<string, unknown>
  const cursors = state['cursors']
  const seen = state['seen']
  if (
    typeof cursors !== 'object' ||
    cursors === null ||
    Object.values(cursors).some((v) => typeof v !== 'string') ||
    !Array.isArray(seen) ||
    seen.some((v) => typeof v !== 'string')
  ) {
    throw new Error(`state file ${path} has an unexpected shape. Fix it or delete it to start over.`)
  }

  // `tickets` arrived after `cursors`/`seen`; a state file written by an
  // earlier rocky is valid and simply has no approval ledger yet.
  const tickets = state['tickets']
  if (tickets !== undefined && (typeof tickets !== 'object' || tickets === null || Array.isArray(tickets))) {
    throw new Error(`state file ${path} has an unexpected "tickets" shape. Fix it or delete it to start over.`)
  }
  for (const [id, value] of Object.entries((tickets ?? {}) as Record<string, unknown>)) {
    const progress = value as Record<string, unknown> | null
    if (typeof progress !== 'object' || progress === null || !PHASES.has(String(progress['phase']))) {
      throw new Error(`state file ${path} has an unexpected entry for ticket ${id}. Fix it or delete it to start over.`)
    }
  }

  return {
    cursors: { ...(cursors as Record<string, string>) },
    seen: [...(seen as string[])],
    tickets: { ...((tickets ?? {}) as Record<string, TicketProgress>) },
  }
}

/** Write the state file (creating its directory), via a temp file so a crash never leaves half-written JSON. */
export function saveState(path: string, state: RockyState): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const temp = join(dir, `.state-${process.pid}.tmp`)
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
}
