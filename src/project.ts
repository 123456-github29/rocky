import type { RockyConfig, Ticket } from './types'
import type { Source } from './sources/types'
import type { Sink } from './sinks/types'
import type { Notifier } from './notify/types'

/**
 * What a consumer's rocky.config.ts declares: where reports come from, where
 * tickets live, how the matcher is tuned, which labels rocky's tickets get,
 * and how the approval loop reaches you.
 */
export interface RockyProjectConfig {
  /** Report sources. Each keeps its own cursor in the state file, keyed by `source.name`. */
  sources: Source[]
  /** The ticket store new reports are deduplicated against and written to. */
  sink: Sink
  /**
   * Labels applied to every ticket rocky creates. Default: ["rocky"].
   * The **first** label is the one `rocky watch` follows — it defines rocky's funnel.
   */
  labels?: string[]
  /** Matcher tuning and the tier-3 LLM provider — see `RockyConfig`. */
  match?: Partial<RockyConfig>
  /** Where cursors, processed-report ids, and approval phases are persisted. Default: ".rocky/state.json". */
  statePath?: string
  /** Labeled pairs for `rocky eval`. Default: "eval/pairs.json". */
  pairsPath?: string

  /**
   * Where approval requests and completion notices are delivered. One notifier
   * or several (every one gets every message). Default: none — `rocky watch`
   * prints instead, which is the right setting until you trust its decisions.
   */
  notify?: Notifier | Notifier[]
  /**
   * The label that means "a human said yes". Adding it is the only thing that
   * moves a ticket past the gate, whether it is added by `rocky approve`, by
   * your agent, or by hand in the tracker. Default: "approved".
   *
   * Point your coding agent's trigger at this same label.
   */
  approveLabel?: string
  /**
   * Called once per ticket, the pass it crosses the gate. Only needed if
   * nothing else is watching the label — with GitHub Actions or Linear
   * automation the tracker already fires the runner and this stays unset.
   */
  onApprove?: (ticket: Ticket) => Promise<void> | void
}

/** Identity helper that gives rocky.config.ts type checking and completion. */
export function defineConfig(config: RockyProjectConfig): RockyProjectConfig {
  return config
}

/** Validate a loaded config file's default export. Throws with a pointed message on anything off. */
export function assertProjectConfig(value: unknown): asserts value is RockyProjectConfig {
  const fail = (why: string): never => {
    throw new TypeError(`rocky.config: ${why}`)
  }
  if (typeof value !== 'object' || value === null) fail('the default export must be an object (use defineConfig({...}))')
  const config = value as Record<string, unknown>

  const sources = config['sources']
  if (!Array.isArray(sources) || sources.length === 0) fail('"sources" must be a non-empty array')
  for (const [index, source] of (sources as unknown[]).entries()) {
    const s = source as Record<string, unknown> | null
    if (typeof s !== 'object' || s === null || typeof s['name'] !== 'string' || typeof s['poll'] !== 'function') {
      fail(`sources[${index}] must be a Source ({ name, poll })`)
    }
  }

  const sink = config['sink'] as Record<string, unknown> | null
  if (
    typeof sink !== 'object' ||
    sink === null ||
    typeof sink['name'] !== 'string' ||
    typeof sink['listOpen'] !== 'function' ||
    typeof sink['create'] !== 'function' ||
    typeof sink['annotate'] !== 'function'
  ) {
    fail('"sink" must be a Sink ({ name, listOpen, create, annotate })')
  }

  if (config['labels'] !== undefined) {
    const labels = config['labels']
    if (!Array.isArray(labels) || labels.some((l) => typeof l !== 'string')) fail('"labels" must be an array of strings')
    if ((labels as string[]).length === 0) fail('"labels" must not be empty — the first label is the funnel `rocky watch` follows')
  }
  for (const key of ['statePath', 'pairsPath', 'approveLabel'] as const) {
    if (config[key] !== undefined && typeof config[key] !== 'string') fail(`"${key}" must be a string`)
  }

  if (config['notify'] !== undefined) {
    const notifiers = Array.isArray(config['notify']) ? config['notify'] : [config['notify']]
    for (const [index, value] of (notifiers as unknown[]).entries()) {
      const n = value as Record<string, unknown> | null
      if (typeof n !== 'object' || n === null || typeof n['name'] !== 'string' || typeof n['send'] !== 'function') {
        fail(`notify[${index}] must be a Notifier ({ name, send })`)
      }
    }
  }
  if (config['onApprove'] !== undefined && typeof config['onApprove'] !== 'function') {
    fail('"onApprove" must be a function (ticket) => void')
  }

  // Same label on both sides means every ticket rocky files is born approved.
  const funnel = Array.isArray(config['labels']) ? (config['labels'] as string[])[0] : 'rocky'
  if (funnel === (config['approveLabel'] ?? 'approved')) {
    fail('"approveLabel" must differ from the first entry of "labels" — otherwise every filed ticket is instantly approved')
  }
}
