import type { RockyConfig } from './types'
import type { Source } from './sources/types'
import type { Sink } from './sinks/types'

/**
 * What a consumer's rocky.config.ts declares: where reports come from, where
 * tickets live, how the matcher is tuned, and which labels rocky's tickets get.
 */
export interface RockyProjectConfig {
  /** Report sources. Each keeps its own cursor in the state file, keyed by `source.name`. */
  sources: Source[]
  /** The ticket store new reports are deduplicated against and written to. */
  sink: Sink
  /** Labels applied to every ticket rocky creates. Default: ["rocky"]. */
  labels?: string[]
  /** Matcher tuning and the tier-3 LLM provider — see `RockyConfig`. */
  match?: Partial<RockyConfig>
  /** Where cursors and processed-report ids are persisted. Default: ".rocky/state.json". */
  statePath?: string
  /** Labeled pairs for `rocky eval`. Default: "eval/pairs.json". */
  pairsPath?: string
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
  }
  for (const key of ['statePath', 'pairsPath'] as const) {
    if (config[key] !== undefined && typeof config[key] !== 'string') fail(`"${key}" must be a string`)
  }
}
