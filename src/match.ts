import type { LLMProvider, MatchResult, Report, RockyConfig, Ticket } from './types'
import { resolveConfig } from './config'

/** Bound tier-2 work on pathological inputs (a 100KB stack dump adds no signal past this). */
const TIER2_MAX_CHARS = 5000

/**
 * Match one report against the candidate tickets. Three tiers, cheapest first,
 * short-circuiting on a conclusive answer:
 *
 * 1. Fingerprint equality — both non-empty and equal.
 * 2. Sørensen–Dice similarity on normalized text — at/above `highThreshold` is
 *    a duplicate, everything below `lowThreshold` is new.
 * 3. One LLM call for the ambiguous middle, via the injected `config.llm`.
 *
 * Pure apart from that one injected call: no file I/O, no global state, no
 * imported config. Callers decide the candidate set (typically open tickets).
 */
export async function match(
  report: Report,
  tickets: Ticket[],
  config: Partial<RockyConfig> = {},
): Promise<MatchResult> {
  const cfg = resolveConfig(config)

  if (tickets.length === 0) {
    return { matchId: null, confidence: 1, tier: 2, reasoning: 'no candidate tickets to compare against' }
  }

  const byFingerprint = matchByFingerprint(report, tickets)
  if (byFingerprint) return byFingerprint

  const reportText = normalize([report.title, report.text].filter(Boolean).join(' ')).slice(0, TIER2_MAX_CHARS)
  let bestTicket: Ticket = tickets[0]!
  let bestScore = -1
  for (const ticket of tickets) {
    const ticketText = normalize(`${ticket.title} ${ticket.summary}`).slice(0, TIER2_MAX_CHARS)
    const score = diceSimilarity(reportText, ticketText)
    if (score > bestScore) {
      bestScore = score
      bestTicket = ticket
    }
  }

  if (bestScore >= cfg.highThreshold) {
    return {
      matchId: bestTicket.id,
      confidence: bestScore,
      tier: 2,
      reasoning: `text similarity ${bestScore.toFixed(3)} to ticket ${bestTicket.id} is at or above highThreshold ${cfg.highThreshold}`,
    }
  }
  if (bestScore < cfg.lowThreshold) {
    return {
      matchId: null,
      confidence: 1 - bestScore,
      tier: 2,
      reasoning: `best text similarity ${bestScore.toFixed(3)} (ticket ${bestTicket.id}) is below lowThreshold ${cfg.lowThreshold}`,
    }
  }
  if (!cfg.llm) {
    return {
      matchId: null,
      confidence: 1 - bestScore,
      tier: 2,
      reasoning: `text similarity ${bestScore.toFixed(3)} to ticket ${bestTicket.id} is ambiguous (between lowThreshold ${cfg.lowThreshold} and highThreshold ${cfg.highThreshold}) and no LLM provider is configured; failing safe to no-match`,
    }
  }

  return matchByLLM(report, tickets, cfg.llm, cfg)
}

function matchByFingerprint(report: Report, tickets: Ticket[]): MatchResult | null {
  const fp = report.fingerprint
  // Empty-string fingerprints would all "equal" each other — a false-merge factory — so only non-empty strings count.
  if (typeof fp !== 'string' || fp === '') return null
  const ticket = tickets.find((t) => typeof t.fingerprint === 'string' && t.fingerprint !== '' && t.fingerprint === fp)
  if (!ticket) return null
  return {
    matchId: ticket.id,
    confidence: 1,
    tier: 1,
    reasoning: `fingerprint ${JSON.stringify(truncate(fp, 80))} exactly matches ticket ${ticket.id}`,
  }
}

async function matchByLLM(
  report: Report,
  tickets: Ticket[],
  llm: LLMProvider,
  cfg: RockyConfig,
): Promise<MatchResult> {
  const prompt = renderPrompt(cfg.promptTemplate, report, tickets)
  let raw: string
  try {
    raw = await llm(prompt)
  } catch (error) {
    // Provider failures resolve to no-match by design: an extra ticket is recoverable, a wrong merge is not.
    return {
      matchId: null,
      confidence: 0,
      tier: 3,
      reasoning: `LLM call failed (${error instanceof Error ? error.message : String(error)}); failing safe to no-match`,
    }
  }
  return interpretLLMResponse(raw, tickets, cfg)
}

function renderPrompt(template: string, report: Report, tickets: Ticket[]): string {
  const reportBlock = JSON.stringify(
    { source: report.source, title: report.title ?? null, text: report.text },
    null,
    2,
  )
  const ticketsBlock = JSON.stringify(
    tickets.map((t) => ({ id: t.id, title: t.title, summary: t.summary })),
    null,
    2,
  )
  return template.replaceAll('{{report}}', () => reportBlock).replaceAll('{{tickets}}', () => ticketsBlock)
}

function interpretLLMResponse(raw: string, tickets: Ticket[], cfg: RockyConfig): MatchResult {
  const noMatch = (confidence: number, reasoning: string): MatchResult => ({
    matchId: null,
    confidence,
    tier: 3,
    reasoning,
  })

  const parsed = parseJsonObject(raw)
  if (!parsed) {
    return noMatch(0, `LLM response was not parseable JSON (${preview(raw)}); failing safe to no-match`)
  }

  const confidence = clamp01(parsed['confidence'])
  const stated =
    typeof parsed['reasoning'] === 'string' && parsed['reasoning'].trim() !== ''
      ? parsed['reasoning'].trim()
      : 'LLM gave no reasoning'
  const rawId = parsed['matchId']

  if (rawId === null || rawId === undefined) {
    return noMatch(confidence, stated)
  }
  if (typeof rawId !== 'string' && typeof rawId !== 'number') {
    return noMatch(0, `LLM returned a non-id matchId (${preview(JSON.stringify(rawId) ?? 'undefined')}); failing safe to no-match`)
  }
  const ticket = tickets.find((t) => String(t.id) === String(rawId))
  if (!ticket) {
    return noMatch(0, `LLM returned ticket id ${JSON.stringify(rawId)} which is not among the candidates; failing safe to no-match`)
  }
  if (confidence < cfg.llmMinConfidence) {
    return noMatch(
      confidence,
      `LLM proposed ticket ${ticket.id} at confidence ${confidence} below llmMinConfidence ${cfg.llmMinConfidence}; failing safe to no-match — ${stated}`,
    )
  }
  return { matchId: ticket.id, confidence, tier: 3, reasoning: stated }
}

/** Parse a JSON object out of model output: fenced, prose-wrapped, or clean. Never throws. */
function parseJsonObject(raw: string): Record<string, unknown> | null {
  const unfenced = raw
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```$/, '')
  for (const candidate of [unfenced, firstJsonObject(unfenced)]) {
    if (!candidate) continue
    try {
      const value: unknown = JSON.parse(candidate)
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>
      }
    } catch {
      // fall through to the next candidate
    }
  }
  return null
}

/** First balanced `{...}` in the text, string-aware. */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      if (inString) escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/**
 * Lowercase, fold to letters and digits, collapse everything else to single
 * spaces. Digits are kept: "error 500" and "error 404" must not normalize equal.
 */
export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/**
 * Sørensen–Dice similarity over character-bigram multisets. Order-tolerant and
 * cheap; on normalized English text, unrelated sentences land around 0.15–0.35
 * and near-verbatim duplicates above 0.85.
 */
export function diceSimilarity(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) {
    return a.length > 0 && a === b ? 1 : 0
  }
  const bigramsA = countBigrams(a)
  const bigramsB = countBigrams(b)
  let overlap = 0
  for (const [bigram, count] of bigramsA) {
    overlap += Math.min(count, bigramsB.get(bigram) ?? 0)
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1))
}

function countBigrams(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (let i = 0; i < text.length - 1; i++) {
    const bigram = text.slice(i, i + 2)
    counts.set(bigram, (counts.get(bigram) ?? 0) + 1)
  }
  return counts
}

function clamp01(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function preview(text: string): string {
  return JSON.stringify(truncate(text.trim(), 120))
}
