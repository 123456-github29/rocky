import { describe, expect, it, vi } from 'vitest'
import { diceSimilarity, match, normalize } from '../src/match'
import { defaultConfig, resolveConfig } from '../src/config'
import type { Report, Ticket } from '../src/types'

function report(overrides: Partial<Report> = {}): Report {
  return {
    id: 'r1',
    source: 'test',
    text: 'the app crashes when I tap the share button on my phone',
    occurredAt: new Date(0),
    ...overrides,
  }
}

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 'T-1',
    title: 'Crash on share',
    summary: 'app crashes when tapping the share button on ios',
    state: 'open',
    link: 'https://tracker.example/T-1',
    ...overrides,
  }
}

/** A tier-3 stub that fails the test if the matcher ever calls it. */
function forbiddenLLM() {
  return vi.fn(async (): Promise<string> => {
    throw new Error('tier 3 must not be reached in this test')
  })
}

// Thresholds that force any moderately-similar text into the ambiguous middle.
const FORCE_AMBIGUOUS = { lowThreshold: 0.01, highThreshold: 0.99 }

describe('tier 1 — fingerprint', () => {
  it('matches on equal non-empty fingerprints without calling the LLM, even for dissimilar text', async () => {
    const llm = forbiddenLLM()
    const result = await match(
      report({ fingerprint: 'abc123', text: 'completely unrelated words here' }),
      [ticket({ fingerprint: 'other' }), ticket({ id: 'T-2', fingerprint: 'abc123', title: 'x', summary: 'y' })],
      { ...FORCE_AMBIGUOUS, llm },
    )
    expect(result).toMatchObject({ matchId: 'T-2', confidence: 1, tier: 1 })
    expect(llm).not.toHaveBeenCalled()
  })

  it('never treats two empty-string fingerprints as equal', async () => {
    const result = await match(
      report({ fingerprint: '', text: 'zzzz qqqq vvvv' }),
      [ticket({ fingerprint: '', title: 'aaaa', summary: 'bbbb cccc' })],
      { lowThreshold: 0.5, highThreshold: 0.9 },
    )
    expect(result.tier).toBe(2)
    expect(result.matchId).toBeNull()
  })

  it('falls through when either fingerprint is null or missing', async () => {
    const result = await match(
      report({ fingerprint: null, text: 'zzzz qqqq vvvv' }),
      [ticket({ fingerprint: 'abc123', title: 'aaaa', summary: 'bbbb cccc' })],
      { lowThreshold: 0.5, highThreshold: 0.9 },
    )
    expect(result.tier).toBe(2)
    expect(result.matchId).toBeNull()
  })
})

describe('tier 2 — string similarity', () => {
  it('matches near-identical text above highThreshold without calling the LLM', async () => {
    const llm = forbiddenLLM()
    const result = await match(
      report({ text: 'password reset email never arrives for gmail addresses' }),
      [ticket({ title: 'Password reset email never arives for gmail adresses', summary: '' })],
      { lowThreshold: 0.1, highThreshold: 0.5, llm },
    )
    expect(result).toMatchObject({ matchId: 'T-1', tier: 2 })
    expect(result.confidence).toBeGreaterThanOrEqual(0.5)
    expect(llm).not.toHaveBeenCalled()
  })

  it('declares unrelated text a new bug below lowThreshold without calling the LLM', async () => {
    const llm = forbiddenLLM()
    const result = await match(
      report({ text: 'zzzz qqqq vvvv wwww' }),
      [ticket({ title: 'aaaa bbbb', summary: 'cccc dddd eeee' })],
      { lowThreshold: 0.5, highThreshold: 0.9, llm },
    )
    expect(result).toMatchObject({ matchId: null, tier: 2 })
    expect(result.confidence).toBeGreaterThan(0.5)
    expect(llm).not.toHaveBeenCalled()
  })

  it('fails safe to no-match when the middle is ambiguous and no LLM is configured', async () => {
    const result = await match(report(), [ticket()], { ...FORCE_AMBIGUOUS, llm: null })
    expect(result).toMatchObject({ matchId: null, tier: 2 })
    expect(result.reasoning).toContain('no LLM provider')
  })

  it('picks the most similar ticket among several', async () => {
    const result = await match(
      report({ text: 'login page returns a 500 error after password reset' }),
      [
        ticket({ id: 'far', title: 'Unrelated', summary: 'zzzz qqqq vvvv wwww yyyy' }),
        ticket({ id: 'near', title: 'Login returns 500 error after password reset', summary: '' }),
      ],
      { lowThreshold: 0.1, highThreshold: 0.6 },
    )
    expect(result.matchId).toBe('near')
  })

  it('returns no-match with full confidence when there are no tickets', async () => {
    const result = await match(report(), [])
    expect(result).toMatchObject({ matchId: null, confidence: 1 })
  })
})

describe('tier 3 — LLM', () => {
  const ambiguous = (llm: (prompt: string) => Promise<string>) =>
    match(report(), [ticket()], { ...FORCE_AMBIGUOUS, llm })

  it('sends the report and every ticket id/title/summary, and accepts a confident match', async () => {
    const llm = vi.fn(async (_prompt: string) =>
      JSON.stringify({ matchId: 'T-1', confidence: 0.9, reasoning: 'same root cause' }),
    )
    const result = await match(report(), [ticket()], { ...FORCE_AMBIGUOUS, llm })
    expect(result).toMatchObject({ matchId: 'T-1', confidence: 0.9, tier: 3, reasoning: 'same root cause' })
    expect(llm).toHaveBeenCalledTimes(1)
    const prompt = llm.mock.calls[0]![0]
    expect(prompt).toContain('"T-1"')
    expect(prompt).toContain('Crash on share')
    expect(prompt).toContain('app crashes when tapping the share button on ios')
    expect(prompt).toContain('the app crashes when I tap the share button on my phone')
  })

  it('maps a stringified id back to the ticket, preserving the original id type', async () => {
    const result = await match(
      report(),
      [ticket({ id: 42 })],
      { ...FORCE_AMBIGUOUS, llm: async () => '{"matchId": "42", "confidence": 0.95, "reasoning": "same"}' },
    )
    expect(result.matchId).toBe(42)
  })

  it('parses fenced output even though the prompt forbids fences', async () => {
    const result = await ambiguous(async () => '```json\n{"matchId": "T-1", "confidence": 0.85, "reasoning": "dup"}\n```')
    expect(result.matchId).toBe('T-1')
  })

  it('parses a JSON object embedded in prose', async () => {
    const result = await ambiguous(
      async () => 'Sure! Here is my answer: {"matchId": null, "confidence": 0.8, "reasoning": "different bugs"} — hope that helps }',
    )
    expect(result).toMatchObject({ matchId: null, confidence: 0.8, tier: 3 })
  })

  it('treats unparseable output as no-match, never as a match', async () => {
    const result = await ambiguous(async () => 'I think these are probably the same bug')
    expect(result).toMatchObject({ matchId: null, confidence: 0, tier: 3 })
    expect(result.reasoning).toContain('not parseable')
  })

  it('treats a JSON array as unparseable', async () => {
    const result = await ambiguous(async () => '[1, 2, 3]')
    expect(result.matchId).toBeNull()
  })

  it('rejects a hallucinated ticket id', async () => {
    const result = await ambiguous(async () => '{"matchId": "T-999", "confidence": 0.99, "reasoning": "sure"}')
    expect(result.matchId).toBeNull()
    expect(result.reasoning).toContain('not among the candidates')
  })

  it('rejects a match below llmMinConfidence', async () => {
    const result = await ambiguous(async () => '{"matchId": "T-1", "confidence": 0.5, "reasoning": "maybe"}')
    expect(result.matchId).toBeNull()
    expect(result.reasoning).toContain('llmMinConfidence')
  })

  it('treats a non-numeric confidence as zero and fails safe', async () => {
    const result = await ambiguous(async () => '{"matchId": "T-1", "confidence": "high", "reasoning": "sure"}')
    expect(result).toMatchObject({ matchId: null, confidence: 0 })
  })

  it('accepts a confident no-match verdict', async () => {
    const result = await ambiguous(async () => '{"matchId": null, "confidence": 0.9, "reasoning": "different component"}')
    expect(result).toMatchObject({ matchId: null, confidence: 0.9, tier: 3, reasoning: 'different component' })
  })

  it('turns a provider failure into no-match instead of throwing', async () => {
    const result = await ambiguous(async () => {
      throw new Error('socket hang up')
    })
    expect(result).toMatchObject({ matchId: null, confidence: 0, tier: 3 })
    expect(result.reasoning).toContain('LLM call failed')
    expect(result.reasoning).toContain('socket hang up')
  })
})

describe('config', () => {
  it('applies documented defaults', () => {
    const cfg = resolveConfig()
    expect(cfg).toMatchObject({
      highThreshold: defaultConfig.highThreshold,
      lowThreshold: defaultConfig.lowThreshold,
      llm: null,
    })
  })

  it('ignores explicit undefined overrides', () => {
    const cfg = resolveConfig({ highThreshold: undefined })
    expect(cfg.highThreshold).toBe(defaultConfig.highThreshold)
  })

  it('rejects lowThreshold at or above highThreshold', () => {
    expect(() => resolveConfig({ lowThreshold: 0.9, highThreshold: 0.5 })).toThrow(RangeError)
    expect(() => resolveConfig({ lowThreshold: 0.5, highThreshold: 0.5 })).toThrow(RangeError)
  })

  it('rejects out-of-range thresholds', () => {
    expect(() => resolveConfig({ highThreshold: 1.5 })).toThrow(RangeError)
    expect(() => resolveConfig({ llmMinConfidence: -0.1 })).toThrow(RangeError)
  })
})

describe('normalize and diceSimilarity', () => {
  it('normalizes case, punctuation and whitespace but keeps digits', () => {
    expect(normalize('  Error   500: Café-Bug!! ')).toBe('error 500 café bug')
  })

  it('scores identical text 1 and disjoint text 0', () => {
    expect(diceSimilarity('abcdef', 'abcdef')).toBe(1)
    expect(diceSimilarity('aaaa', 'zzzz')).toBe(0)
  })

  it('is symmetric', () => {
    const a = normalize('login fails after password reset')
    const b = normalize('password reset breaks the login page')
    expect(diceSimilarity(a, b)).toBeCloseTo(diceSimilarity(b, a), 10)
  })

  it('handles degenerate inputs without dividing by zero', () => {
    expect(diceSimilarity('', '')).toBe(0)
    expect(diceSimilarity('a', 'a')).toBe(1)
    expect(diceSimilarity('a', 'b')).toBe(0)
    expect(diceSimilarity('ab', '')).toBe(0)
  })
})
