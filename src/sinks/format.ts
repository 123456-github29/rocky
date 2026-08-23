import type { Report } from '../types'

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

/** Markdown body for a newly created ticket. */
export function ticketBody(report: Report): string {
  const text =
    report.text.length > MAX_TICKET_TEXT
      ? `${report.text.slice(0, MAX_TICKET_TEXT)}\n\n[truncated by rocky]`
      : report.text
  return `${text}\n\n---\nFiled by rocky.\n${reportFacts(report)}`
}

/** Markdown comment recording a duplicate occurrence on an existing ticket. */
export function annotationBody(report: Report): string {
  const quoted = (report.text.length > MAX_QUOTE ? `${report.text.slice(0, MAX_QUOTE)}…` : report.text)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
  return `Duplicate report matched to this ticket by rocky.\n\n${reportFacts(report)}\n\n${quoted}`
}
