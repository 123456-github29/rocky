import type { LLMProvider, Report, TaskAnalysis } from './types'

/**
 * What the analyst is asked for. Written to be answerable from a stack trace and
 * a description, and to refuse rather than guess: an invented file path or a
 * confident fix for a misread error is worse than "I could not tell", because a
 * human is about to approve work on the strength of it.
 */
export const DEFAULT_ANALYSIS_TEMPLATE = `You are triaging a single incoming bug report so a human can decide, in about fifteen seconds, whether to hand it to a coding agent.

Read the report and answer four things. Be concrete and specific; a vague answer is useless here.

Ground every claim in the report itself. If the report does not say where the fault is, say so — do not invent a file path, a function name, or a cause. If the report is too thin to act on (no stack trace, no reproduction, no clear symptom), that is the single most useful thing you can report, because it means the right decision is to ask the reporter rather than to start coding.

Bug report:
{{report}}

Respond with a single JSON object and nothing else — no prose, no markdown fences:
{"summary": "<one sentence: what is broken, in plain language a non-specialist understands>", "location": "<the component, file, or function at fault, quoted or inferred from the report — or null if the report does not say>", "proposedFix": "<what the work actually involves, in two or three sentences: what to change and why that addresses the cause>", "risks": ["<anything that makes this risky or ambiguous to hand to an agent unsupervised>"], "confidence": <number from 0 to 1: how sure you are that this is actionable as described>}

Set "confidence" below 0.5 when the report is too thin to act on, and put the reason in "risks". Leave "risks" as an empty array only when you genuinely see none.`

export interface AnalyzeOptions {
  /**
   * The provider used for analysis. Deliberately separate from the matcher's
   * tier-3 provider: deduplication is a cheap yes/no that a small model handles
   * well, while this one is read once by a human deciding whether to change
   * production code. Point it at your best model.
   */
  llm: LLMProvider
  /** Prompt override. `{{report}}` is replaced with the rendered report. */
  template?: string
}

/**
 * Turn one bug report into a short brief: what broke, where, what the fix
 * involves, and what makes it risky.
 *
 * This is the difference between an approval prompt that shows you
 * `TypeError: cannot read 'length' of undefined` and one that tells you what
 * that means and what fixing it entails. The first is a decision you cannot
 * actually make from a phone; the second is.
 *
 * Returns null whenever it cannot produce a trustworthy answer — a provider
 * that throws, unparseable output, a missing summary. A ticket with no analysis
 * files perfectly well and simply shows the raw report, which is exactly what
 * rocky did before this existed. Nothing here can block a bug from being filed.
 *
 * The result is a **hypothesis**, and every surface that renders it says so. It
 * is there to make the approve decision informed, not to be believed.
 */
export async function analyze(report: Report, options: AnalyzeOptions): Promise<TaskAnalysis | null> {
  const { llm, template = DEFAULT_ANALYSIS_TEMPLATE } = options
  const rendered = JSON.stringify(
    {
      source: report.source,
      title: report.title ?? null,
      reportedBy: report.reporter ?? null,
      occurredAt: report.occurredAt.toISOString(),
      text: report.text,
    },
    null,
    2,
  )

  let raw: string
  try {
    raw = await llm(template.replaceAll('{{report}}', () => rendered))
  } catch {
    return null
  }
  return parseAnalysis(raw)
}

/** Parse the analyst's response. Never throws; returns null on anything it cannot trust. */
export function parseAnalysis(raw: string): TaskAnalysis | null {
  const parsed = parseJsonObject(raw)
  if (!parsed) return null

  const summary = text(parsed['summary'])
  const proposedFix = text(parsed['proposedFix'])
  // A brief with no summary is not a brief. Better to show the raw report than
  // a half-filled template that looks authoritative.
  if (summary === null || proposedFix === null) return null

  const rawRisks = parsed['risks']
  const risks = Array.isArray(rawRisks)
    ? rawRisks.map((r) => text(r)).filter((r): r is string => r !== null)
    : []

  const rawConfidence = parsed['confidence']
  const confidence =
    typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)
      ? Math.min(1, Math.max(0, rawConfidence))
      : 0.5

  return { summary, location: text(parsed['location']), proposedFix, risks, confidence }
}

/** Render an analysis as the markdown that heads a ticket body. */
export function analysisSection(analysis: TaskAnalysis): string {
  const lines = [
    '## What needs to be done',
    '',
    analysis.proposedFix,
    '',
    `**What is broken:** ${analysis.summary}`,
    `**Where:** ${analysis.location ?? 'not identified in the report'}`,
  ]
  if (analysis.risks.length > 0) {
    lines.push('', '**Risks and unknowns:**', ...analysis.risks.map((risk) => `- ${risk}`))
  }
  if (analysis.confidence < 0.5) {
    lines.push(
      '',
      `> Low confidence (${analysis.confidence.toFixed(2)}) — the report may be too thin to act on. ` +
        'Consider asking the reporter before approving.',
    )
  }
  lines.push('', '_Written by a model from the report below. A hypothesis, not a diagnosis — the original report is the evidence._')
  return lines.join('\n')
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** Parse a JSON object out of model output: fenced, prose-wrapped, or clean. Never throws. */
function parseJsonObject(raw: string): Record<string, unknown> | null {
  const unfenced = raw
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```$/, '')
  for (const candidate of [unfenced, sliceOutermostObject(unfenced)]) {
    if (candidate === null) continue
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

function sliceOutermostObject(value: string): string | null {
  const start = value.indexOf('{')
  const end = value.lastIndexOf('}')
  return start === -1 || end <= start ? null : value.slice(start, end + 1)
}
