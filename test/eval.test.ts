import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { formatEvalReport, parsePairs, runEval } from '../src/eval'
import type { EvalPair } from '../src/eval'

const examplePairsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../eval/example-pairs.json')

describe('parsePairs', () => {
  it('accepts a well-formed pairs file', () => {
    const pairs = parsePairs([{ id: 1, a: 'x', b: 'y', same: true, note: 'n' }])
    expect(pairs).toEqual([{ id: 1, a: 'x', b: 'y', same: true, note: 'n' }])
  })

  it('rejects non-arrays and malformed entries with the offending position', () => {
    expect(() => parsePairs({})).toThrow(/array/)
    expect(() => parsePairs([{ id: 1, a: 'x', b: 'y' }])).toThrow(/"same"/)
    expect(() => parsePairs([{ id: 1, a: '', b: 'y', same: true }])).toThrow(/"a"/)
    expect(() => parsePairs([null])).toThrow(/index 0/)
  })
})

describe('runEval on synthetic pairs', () => {
  // Thresholds chosen so p1 resolves at tier 2 (identical), p2 at tier 2
  // (disjoint), and p3/p4 land in the ambiguous middle.
  const thresholds = { lowThreshold: 0.05, highThreshold: 0.95 }
  const pairs: EvalPair[] = [
    { id: 'p1', a: 'alpha beta gamma delta', b: 'alpha beta gamma delta', same: true },
    { id: 'p2', a: 'zzzz qqqq vvvv', b: 'aaaa bbbb cccc', same: false },
    { id: 'p3', a: 'alpha beta gamma delta epsilon', b: 'alpha beta zeta eta theta', same: true },
    { id: 'p4', a: 'lorem ipsum dolor sit amet', b: 'lorem ipsum consectetur adipiscing', same: false },
  ]

  // A deliberately merge-happy tier 3: matches whatever ticket it is shown.
  const mergeHappyLLM = async (prompt: string): Promise<string> => {
    const id = /"(ticket-p\d+)"/.exec(prompt)?.[1]
    return JSON.stringify({ matchId: id, confidence: 0.95, reasoning: 'stub says duplicate' })
  }

  it('reports baseline and full runs with separate missed/false-merge counts and per-tier breakdown', async () => {
    const report = await runEval(pairs, { ...thresholds, llm: mergeHappyLLM })

    expect(report.baseline).toMatchObject({
      total: 4,
      correct: 3,
      missedDuplicates: 1,
      falseMerges: 0,
      byTier: { tier1: 0, tier2: 4, tier3: 0 },
    })
    expect(report.full).toMatchObject({
      total: 4,
      correct: 3,
      missedDuplicates: 0,
      falseMerges: 1,
      byTier: { tier1: 0, tier2: 2, tier3: 2 },
    })
    expect(report.delta).toEqual({
      pairsSentToLLM: 2,
      fixedMissedDuplicates: 1,
      introducedFalseMerges: 1,
      netCorrectDelta: 0,
    })

    const text = formatEvalReport(report)
    expect(text).toContain('false merges       1')
    expect(text).toContain('FALSE MERGE')
    expect(text).toContain('fix this before going live')
  })

  it('runs tiers 1–2 only when no LLM is configured, with a null delta', async () => {
    const report = await runEval(pairs, { ...thresholds, llm: null })
    expect(report.delta).toBeNull()
    expect(report.full.correct).toBe(report.baseline.correct)
    expect(report.full.byTier.tier3).toBe(0)
    expect(formatEvalReport(report)).toContain('no LLM provider configured')
  })
})

describe('the shipped example pairs under default thresholds', () => {
  const pairs = parsePairs(JSON.parse(readFileSync(examplePairsPath, 'utf8')))
  const labels = new Map(pairs.map((p) => [String(p.id), p.same]))

  // An oracle tier 3: answers every pair correctly. With it, full-pipeline
  // accuracy is limited only by tiers 1–2 short-circuiting — which is exactly
  // what this test pins: no negative may resolve as a tier-2 match, and no
  // positive may be discarded below lowThreshold before the LLM can see it.
  const oracleLLM = async (prompt: string): Promise<string> => {
    const id = /"ticket-(\d+)"/.exec(prompt)?.[1]
    const same = id !== undefined && labels.get(id) === true
    return JSON.stringify({
      matchId: same ? `ticket-${id}` : null,
      confidence: 0.9,
      reasoning: 'oracle label',
    })
  }

  it('ships 10 pairs, half of them negatives', () => {
    expect(pairs).toHaveLength(10)
    expect(pairs.filter((p) => !p.same)).toHaveLength(5)
  })

  it('never false-merges in the tiers-1–2 baseline', async () => {
    const { baseline } = await runEval(pairs)
    expect(baseline.falseMerges).toBe(0)
  })

  it('resolves the near-verbatim duplicate (pair 7) at tier 2 without an LLM call', async () => {
    const { baseline } = await runEval(pairs)
    const pair7 = baseline.outcomes.find((o) => o.id === 7)
    expect(pair7).toMatchObject({ predicted: true, correct: true, tier: 2 })
  })

  it('keeps the false-merge trap (pair 6) and the cross-subsystem pair (4) out of tier-2 matches', async () => {
    const { baseline } = await runEval(pairs)
    expect(baseline.outcomes.find((o) => o.id === 6)).toMatchObject({ predicted: false, correct: true })
    expect(baseline.outcomes.find((o) => o.id === 4)).toMatchObject({ predicted: false, correct: true })
  })

  it('reaches 10/10 with a perfect tier 3 — thresholds neither merge negatives nor discard positives early', async () => {
    const { full, baseline, delta } = await runEval(pairs, { llm: oracleLLM })
    expect(full.correct).toBe(10)
    expect(full.falseMerges).toBe(0)
    expect(full.byTier.tier1).toBe(0)
    expect(delta?.introducedFalseMerges).toBe(0)
    expect(delta?.fixedMissedDuplicates).toBe(baseline.missedDuplicates)
  })
})
