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
}

/** Most report ids remembered. Old entries fall off FIFO. */
export const SEEN_CAP = 1000

export function emptyState(): RockyState {
  return { cursors: {}, seen: [] }
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
      `rocky: state file ${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}). ` +
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
    throw new Error(`rocky: state file ${path} has an unexpected shape. Fix it or delete it to start over.`)
  }
  return { cursors: { ...(cursors as Record<string, string>) }, seen: [...(seen as string[])] }
}

/** Write the state file (creating its directory), via a temp file so a crash never leaves half-written JSON. */
export function saveState(path: string, state: RockyState): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const temp = join(dir, `.state-${process.pid}.tmp`)
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
}
