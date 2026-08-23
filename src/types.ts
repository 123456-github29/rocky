/** A single incoming bug report from any source (error tracker, email, chat, webhook). */
export interface Report {
  id: string
  /** Where this came from, e.g. "sentry", "gmail", "slack", "webhook". */
  source: string
  title?: string
  text: string
  /**
   * Stable grouping key assigned by the source (e.g. a Sentry fingerprint).
   * null/undefined when the source has none. Empty strings never match anything.
   */
  fingerprint?: string | null
  reporter?: string
  link?: string
  occurredAt: Date
  /** The source's original payload, untouched, for debugging and future re-mapping. */
  raw?: unknown
}

/** An existing ticket in whatever tracker the reports are deduplicated against. */
export interface Ticket {
  id: string | number
  title: string
  summary: string
  fingerprint?: string | null
  state: 'open' | 'approved' | 'in_progress' | 'closed'
  link: string
}

/**
 * The matcher's decision for one report.
 *
 * `confidence` is confidence in THIS decision: for a match, how sure the matcher
 * is that the report duplicates `matchId`; for a no-match (`matchId: null`), how
 * sure it is that the report is a new bug.
 *
 * `tier` records which tier resolved the report: 1 = fingerprint equality,
 * 2 = string similarity, 3 = LLM.
 */
export interface MatchResult {
  matchId: string | number | null
  confidence: number
  tier: 1 | 2 | 3
  reasoning: string
  /**
   * Set when tier 3 was reached but the provider threw — a bad key, no
   * network, a rate limit — and the decision is the fail-safe no-match rather
   * than the model's answer.
   *
   * Without this, an outage is indistinguishable from a confident "these are
   * different bugs": both are `{ matchId: null, tier: 3 }`. A whole run can
   * silently degrade to tiers 1–2 and still report tier-3 activity, so the
   * eval harness and `rocky run` both count these separately.
   */
  llmFailed?: true
}

/**
 * Tier 3, injected. Takes a fully rendered prompt and returns the model's raw
 * text response. The matcher never imports an LLM SDK — pass `openaiProvider()`
 * from this package, or any function with this shape.
 */
export type LLMProvider = (prompt: string) => Promise<string>

/**
 * Everything tunable lives here. Defaults are in `defaultConfig` — they were
 * tuned on `eval/example-pairs.json` and you are expected to re-tune them on
 * your own labeled pairs with `rocky-eval`.
 */
export interface RockyConfig {
  /**
   * Tier 2: normalized-text similarity at or above this is declared a duplicate
   * without consulting the LLM. Raise it if the eval shows false merges.
   */
  highThreshold: number
  /**
   * Tier 2: when no ticket scores at or above this, the report is declared new
   * without consulting the LLM. Lower it to send more borderline reports to
   * tier 3 — better duplicate recall, more LLM spend.
   */
  lowThreshold: number
  /**
   * Tier 3: minimum confidence the LLM must state before its proposed match is
   * accepted. Anything lower falls back to no-match.
   */
  llmMinConfidence: number
  /**
   * Model id used by the shipped provider factory. The matcher itself never
   * reads this — it only calls `llm` — so custom providers are free to ignore it.
   */
  model: string
  /**
   * Tier-3 prompt. `{{report}}` and `{{tickets}}` are replaced with JSON
   * renderings of the report and the candidate tickets (id, title, summary).
   */
  promptTemplate: string
  /**
   * Injected tier-3 provider. When null, ambiguous reports resolve to no-match:
   * a possible duplicate gets a fresh ticket, and nothing is ever silently merged.
   */
  llm: LLMProvider | null
}
