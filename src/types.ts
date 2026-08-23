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
  /**
   * How many times this has happened, when the source counts (Sentry and
   * GlitchTip do). Absent means "once, as far as anyone knows".
   *
   * This is what separates a crisis from noise during an investigation: an
   * error tracker's grouping tells you a signature exists, the count tells you
   * whether it is happening to everyone or to nobody.
   */
  occurrences?: number
  /**
   * When this first occurred, when the source tracks it. With `occurredAt` it
   * gives an investigation the shape over time — something new and
   * accelerating is a regression; something steady for months is a known
   * annoyance, and they deserve different answers.
   */
  firstSeen?: Date
  /** The source's original payload, untouched, for debugging and future re-mapping. */
  raw?: unknown
}

/**
 * A model's brief on one incoming bug: what broke, where, what fixing it
 * involves, and what makes it risky.
 *
 * Produced once per *new* ticket (never for a duplicate) and written into the
 * ticket body, so the approval message and the dashboard can show you a
 * decision you can actually make — rather than a raw stack trace and a yes/no.
 *
 * It is a hypothesis. The original report travels with it precisely so the
 * evidence is never replaced by the summary of it.
 */
export interface TaskAnalysis {
  /** One sentence: what is broken, in plain language. */
  summary: string
  /** The component, file, or function at fault — null when the report does not say. */
  location: string | null
  /** What the work involves: what to change and why it addresses the cause. */
  proposedFix: string
  /** What makes this risky or ambiguous to hand to an agent unsupervised. */
  risks: string[]
  /** How actionable this is as described. Below 0.5 means the report is probably too thin. */
  confidence: number
}

/** An existing ticket in whatever tracker the reports are deduplicated against. */
export interface Ticket {
  id: string | number
  title: string
  summary: string
  /** The first of {@link fingerprints}, kept for the common single-signature case. */
  fingerprint?: string | null
  /**
   * Every source signature this ticket covers.
   *
   * A ticket usually stands for one error group, but an investigation can
   * conclude that five signatures share one root cause and file them as one
   * piece of work. All five must then map back to this ticket, or the next
   * investigation files it again.
   */
  fingerprints?: string[]
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
