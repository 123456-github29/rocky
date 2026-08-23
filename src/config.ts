import type { RockyConfig } from './types'

/**
 * Default tier-3 prompt. The asymmetry paragraph is load-bearing: the single
 * worst failure mode of a deduplicator is merging two different bugs, so the
 * model is told to prefer null whenever it is not confident.
 */
export const DEFAULT_PROMPT_TEMPLATE = `You are a bug-report deduplication assistant. Decide whether the incoming report describes the SAME underlying bug as one of the existing tickets.

The costs are asymmetric, and this must drive your decision: a missed duplicate costs a human thirty seconds of closing a ticket; a false merge makes a real bug silently disappear into someone else's ticket. When you are not confident, answer null.

Two reports are the same bug only if they plausibly share the same root cause — not merely the same subsystem, the same error type, or similar wording. An identical error message in a different component is a DIFFERENT bug. A different symptom of the same underlying cause IS the same bug.

Incoming report:
{{report}}

Existing tickets:
{{tickets}}

Respond with a single JSON object and nothing else — no prose, no markdown fences:
{"matchId": <id of the matching ticket, or null>, "confidence": <number from 0 to 1>, "reasoning": "<one sentence>"}

"matchId" must be exactly one of the ticket ids listed above, or null if no ticket describes the same bug.`

/**
 * Documented defaults.
 *
 * - `highThreshold` 0.82 / `lowThreshold` 0.25: Sørensen–Dice on character
 *   bigrams of normalized text. Unrelated English sentences typically score
 *   0.15–0.35, paraphrases of the same bug 0.30–0.65, near-verbatim duplicates
 *   0.85+. The wide middle is deliberate — that is the zone where cheap string
 *   math cannot be trusted and the LLM (or, without one, a safe no-match)
 *   decides. On the example pairs the hardest true duplicate scores 0.293 and
 *   an identical-error-different-component trap scores 0.653: string similarity
 *   alone cannot separate those, which is why the low threshold prunes only
 *   the obviously unrelated.
 * - `llmMinConfidence` 0.7: a hesitant LLM match is treated as no-match.
 * - `model` "gpt-5.4": used by `openaiProvider()`; swap in "gpt-5.4-mini" to
 *   trade accuracy for cost, and re-run `rocky-eval` to see what it costs you.
 * - `llm` null: tier 3 is opt-in. Without a provider, ambiguous reports become
 *   new tickets rather than risky merges.
 *
 * These were tuned on the 10 pairs in eval/example-pairs.json. That is a smoke
 * test, not a benchmark — write ~30 labeled pairs from your own bug history and
 * tune against those.
 */
export const defaultConfig: Readonly<RockyConfig> = Object.freeze({
  highThreshold: 0.82,
  lowThreshold: 0.25,
  llmMinConfidence: 0.7,
  model: 'gpt-5.4',
  promptTemplate: DEFAULT_PROMPT_TEMPLATE,
  llm: null,
})

/** Merge partial overrides onto the defaults and validate the result. */
export function resolveConfig(overrides: Partial<RockyConfig> = {}): RockyConfig {
  const merged: RockyConfig = { ...defaultConfig }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      ;(merged as unknown as Record<string, unknown>)[key] = value
    }
  }
  assertUnitRange('highThreshold', merged.highThreshold)
  assertUnitRange('lowThreshold', merged.lowThreshold)
  assertUnitRange('llmMinConfidence', merged.llmMinConfidence)
  if (merged.lowThreshold >= merged.highThreshold) {
    throw new RangeError(
      `lowThreshold (${merged.lowThreshold}) must be below highThreshold (${merged.highThreshold})`,
    )
  }
  if (merged.promptTemplate.trim() === '') {
    throw new RangeError('promptTemplate must not be empty')
  }
  return merged
}

function assertUnitRange(name: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a number between 0 and 1, got ${String(value)}`)
  }
}
