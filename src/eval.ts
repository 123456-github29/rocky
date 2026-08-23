import type { MatchResult, RockyConfig, Report, Ticket } from './types'
import { match } from './match'
import { resolveConfig } from './config'

/** One labeled pair from the eval file: does report text `a` describe the same bug as ticket text `b`? */
export interface EvalPair {
  id: string | number
  a: string
  b: string
  same: boolean
  note?: string
}

export interface PairOutcome {
  id: string | number
  note?: string
  expected: boolean
  predicted: boolean
  correct: boolean
  tier: 1 | 2 | 3
  confidence: number
  reasoning: string
  /** The tier-3 provider threw; this decision is the fail-safe, not the model's answer. */
  llmFailed?: true
}

export interface TierCounts {
  tier1: number
  tier2: number
  tier3: number
}

export interface EvalRunStats {
  label: string
  total: number
  correct: number
  accuracy: number
  /** Pairs labeled same=true where the matcher said "new bug". Cost: a human closes a duplicate, ~30 seconds. */
  missedDuplicates: number
  /** Pairs labeled same=false where the matcher merged. Cost: a real bug silently disappears. Keep this at zero. */
  falseMerges: number
  byTier: TierCounts
  /**
   * Tier-3 decisions where the provider threw — a bad key, no network, a rate
   * limit — and the matcher failed safe to no-match. Counted separately
   * because these look exactly like "the LLM considered it and said no": the
   * tier still reads 3. Without this number, a run against a broken key reads
   * as evidence that tier 3 is not worth paying for.
   */
  llmFailures: number
  outcomes: PairOutcome[]
}

/** What tier 3 changed relative to the tiers-1–2 baseline — i.e. whether the LLM is earning its cost. */
export interface LLMDelta {
  pairsSentToLLM: number
  fixedMissedDuplicates: number
  introducedFalseMerges: number
  netCorrectDelta: number
}

export interface EvalReport {
  full: EvalRunStats
  baseline: EvalRunStats
  /** null when no LLM provider is configured (full === baseline). */
  delta: LLMDelta | null
}

/** Validate a parsed pairs file. Throws with the offending index on malformed input. */
export function parsePairs(data: unknown): EvalPair[] {
  if (!Array.isArray(data)) {
    throw new TypeError('pairs file must be a JSON array of { id, a, b, same, note? } objects')
  }
  return data.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new TypeError(`pair at index ${index} is not an object`)
    }
    const { id, a, b, same, note } = item as Record<string, unknown>
    if (typeof id !== 'string' && typeof id !== 'number') {
      throw new TypeError(`pair at index ${index}: "id" must be a string or number`)
    }
    if (typeof a !== 'string' || a.trim() === '') {
      throw new TypeError(`pair ${String(id)} (index ${index}): "a" must be a non-empty string`)
    }
    if (typeof b !== 'string' || b.trim() === '') {
      throw new TypeError(`pair ${String(id)} (index ${index}): "b" must be a non-empty string`)
    }
    if (typeof same !== 'boolean') {
      throw new TypeError(`pair ${String(id)} (index ${index}): "same" must be a boolean`)
    }
    if (note !== undefined && typeof note !== 'string') {
      throw new TypeError(`pair ${String(id)} (index ${index}): "note" must be a string when present`)
    }
    return note === undefined ? { id, a, b, same } : { id, a, b, same, note }
  })
}

/**
 * Run every pair through the matcher twice — once with the configured tier-3
 * provider and once with tiers 1–2 only — and report both, plus what the LLM
 * changed. Missed duplicates and false merges are counted separately and never
 * folded into a single score, because their costs are wildly asymmetric.
 */
export async function runEval(pairs: EvalPair[], config: Partial<RockyConfig> = {}): Promise<EvalReport> {
  const cfg = resolveConfig(config)
  const baselineOutcomes: PairOutcome[] = []
  const fullOutcomes: PairOutcome[] = []

  for (const pair of pairs) {
    const report = reportFromPair(pair)
    const ticket = ticketFromPair(pair)
    baselineOutcomes.push(toOutcome(pair, await match(report, [ticket], { ...cfg, llm: null })))
    if (cfg.llm) {
      fullOutcomes.push(toOutcome(pair, await match(report, [ticket], cfg)))
    }
  }

  const baseline = toStats('baseline — tiers 1–2 only', baselineOutcomes)
  if (!cfg.llm) {
    return {
      full: toStats('full pipeline — tiers 1–3 (no LLM configured, identical to baseline)', baselineOutcomes),
      baseline,
      delta: null,
    }
  }
  const full = toStats('full pipeline — tiers 1–3', fullOutcomes)
  return { full, baseline, delta: computeDelta(full, baseline) }
}

/** Render an EvalReport as the human-readable text the `rocky-eval` bin prints. */
export function formatEvalReport(report: EvalReport): string {
  const lines: string[] = []
  lines.push(...formatRun(report.full))
  lines.push('')
  lines.push(...formatRun(report.baseline))
  lines.push('')
  if (report.delta && report.full.llmFailures === report.full.byTier.tier3 && report.full.llmFailures > 0) {
    lines.push('llm delta — NOT MEASURED: every LLM call failed, so the full pipeline above is')
    lines.push('  really the tiers-1–2 baseline. This is not evidence about tier 3 either way.')
    lines.push(`  First failure: ${report.full.outcomes.find((o) => o.llmFailed)?.reasoning ?? ''}`)
  } else if (report.delta) {
    const d = report.delta
    lines.push('llm delta — what tier 3 buys over the baseline')
    lines.push(`  pairs sent to the llm      ${d.pairsSentToLLM}`)
    lines.push(`  fixed missed duplicates    ${signed(d.fixedMissedDuplicates)}`)
    lines.push(`  introduced false merges    ${signed(d.introducedFalseMerges)}${d.introducedFalseMerges > 0 ? '  ← fix this before going live' : ''}`)
    lines.push(`  net correct decisions      ${signed(d.netCorrectDelta)}`)
  } else {
    lines.push('llm delta — skipped: no LLM provider configured, so tier 3 never ran.')
    lines.push('  Set OPENAI_API_KEY (or pass config.llm) to measure what the LLM call buys you.')
  }

  const failures = report.full.outcomes.filter((o) => !o.correct)
  if (failures.length > 0) {
    lines.push('')
    lines.push('failures — full pipeline')
    for (const f of failures) {
      const kind = f.expected ? 'missed duplicate' : 'FALSE MERGE'
      lines.push(`  ✗ #${f.id}  ${kind} (tier ${f.tier}, confidence ${f.confidence.toFixed(2)})`)
      if (f.note) lines.push(`      note: ${f.note}`)
      lines.push(`      reasoning: ${f.reasoning}`)
    }
  }

  lines.push('')
  lines.push('These pairs are a smoke test, not a benchmark. Write ~30 labeled pairs from')
  lines.push('your own bug history, put them in eval/pairs.json, and tune the thresholds')
  lines.push('until false merges are zero and missed duplicates are tolerable.')
  return lines.join('\n')
}

function formatRun(run: EvalRunStats): string[] {
  const pct = run.total > 0 ? ((100 * run.correct) / run.total).toFixed(1) : '0.0'
  const answered = run.byTier.tier3 - run.llmFailures
  const lines = [
    run.label,
    `  accuracy           ${run.correct}/${run.total} (${pct}%)`,
    `  missed duplicates  ${run.missedDuplicates}   (duplicate got a fresh ticket — costs a human ~30s each)`,
    `  false merges       ${run.falseMerges}   (real bug silently merged away — keep this at ZERO)`,
    `  resolved by tier   fingerprint ${run.byTier.tier1} · string ${run.byTier.tier2} · llm ${answered}`,
  ]
  if (run.llmFailures > 0) {
    // Loud, because the failure mode this prevents is reading a broken run as
    // a verdict on tier 3 and turning it off.
    lines.push(
      `  LLM CALLS FAILED   ${run.llmFailures} of ${run.byTier.tier3} — those decisions are the fail-safe, not the model's`,
      '                     answer. Fix the provider before you read any number above.',
    )
  }
  return lines
}

function reportFromPair(pair: EvalPair): Report {
  return {
    id: `report-${pair.id}`,
    source: 'eval',
    text: pair.a,
    occurredAt: new Date(0),
  }
}

function ticketFromPair(pair: EvalPair): Ticket {
  // Title is the first line, summary the remainder — never both the full text,
  // which would double-weight it in tier-2 similarity.
  const firstLine = pair.b.split('\n', 1)[0] ?? ''
  const title = firstLine.slice(0, 140) || 'untitled'
  const summary = pair.b.slice(title.length).trim()
  return {
    id: `ticket-${pair.id}`,
    title,
    summary,
    state: 'open',
    link: '',
  }
}

function toOutcome(pair: EvalPair, result: MatchResult): PairOutcome {
  const predicted = result.matchId !== null
  const outcome: PairOutcome = {
    id: pair.id,
    expected: pair.same,
    predicted,
    correct: predicted === pair.same,
    tier: result.tier,
    confidence: result.confidence,
    reasoning: result.reasoning,
  }
  if (pair.note !== undefined) outcome.note = pair.note
  if (result.llmFailed) outcome.llmFailed = true
  return outcome
}

function toStats(label: string, outcomes: PairOutcome[]): EvalRunStats {
  const total = outcomes.length
  const correct = outcomes.filter((o) => o.correct).length
  return {
    label,
    total,
    correct,
    accuracy: total > 0 ? correct / total : 0,
    missedDuplicates: outcomes.filter((o) => o.expected && !o.predicted).length,
    falseMerges: outcomes.filter((o) => !o.expected && o.predicted).length,
    byTier: {
      tier1: outcomes.filter((o) => o.tier === 1).length,
      tier2: outcomes.filter((o) => o.tier === 2).length,
      tier3: outcomes.filter((o) => o.tier === 3).length,
    },
    llmFailures: outcomes.filter((o) => o.llmFailed === true).length,
    outcomes,
  }
}

function computeDelta(full: EvalRunStats, baseline: EvalRunStats): LLMDelta {
  let fixedMissedDuplicates = 0
  let introducedFalseMerges = 0
  full.outcomes.forEach((f, i) => {
    const b = baseline.outcomes[i]
    if (!b || f.predicted === b.predicted) return
    if (f.expected && f.predicted) fixedMissedDuplicates++
    if (!f.expected && f.predicted) introducedFalseMerges++
  })
  return {
    pairsSentToLLM: full.byTier.tier3,
    fixedMissedDuplicates,
    introducedFalseMerges,
    netCorrectDelta: full.correct - baseline.correct,
  }
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : String(n)
}
