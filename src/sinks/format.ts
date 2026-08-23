import type { Report, TaskAnalysis } from '../types'
import { analysisSection } from '../analyze'

const MAX_TICKET_TEXT = 10_000
const MAX_QUOTE = 1_500
const MAX_TITLE = 120

/** First line of a text, shaped for use as a ticket title. */
export function firstLine(text: string): string {
  const line = text.split('\n', 1)[0]?.trim() ?? ''
  if (line === '') return 'Untitled report'
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line
}

/**
 * The who/where/when block. Reporter and source link always render (with
 * explicit fallbacks) — that is the annotate contract: the person and the
 * origin of a duplicate report must never be silently dropped.
 */
export function reportFacts(report: Report): string {
  return [
    `- source: ${report.source}`,
    `- reported by: ${report.reporter ?? 'unknown'}`,
    `- occurred at: ${report.occurredAt.toISOString()}`,
    `- source link: ${report.link ?? '(none provided)'}`,
  ].join('\n')
}

/**
 * Markdown body for a newly created ticket.
 *
 * When an analysis is present it goes first — that is what a human reads to
 * decide, and what a coding agent reads to start. The original report always
 * follows it in full: the brief is a hypothesis, the report is the evidence,
 * and the evidence must never be replaced by the summary of it.
 */
export function ticketBody(report: Report, analysis?: TaskAnalysis | null): string {
  const text =
    report.text.length > MAX_TICKET_TEXT
      ? `${report.text.slice(0, MAX_TICKET_TEXT)}\n\n[truncated by rocky]`
      : report.text
  const original = analysis ? `## Original report\n\n${text}` : text
  const head = analysis ? `${analysisSection(analysis)}\n\n---\n\n` : ''
  return `${head}${original}\n\n---\nFiled by rocky.\n${reportFacts(report)}`
}

/** Markdown comment recording a duplicate occurrence on an existing ticket. */
export function annotationBody(report: Report): string {
  const quoted = (report.text.length > MAX_QUOTE ? `${report.text.slice(0, MAX_QUOTE)}…` : report.text)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
  return `Duplicate report matched to this ticket by rocky.\n\n${reportFacts(report)}\n\n${quoted}`
}
