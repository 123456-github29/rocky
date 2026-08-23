import type { LLMProvider, Report, Ticket } from './types'

/**
 * A problem rocky concluded exists, from reading the logs — not a copy of one
 * error line.
 *
 * The distinction is the whole point. An error tracker tells you
 * "TypeError fired 4,200 times". A finding says "the voice pipeline does not
 * handle empty transcripts; it accounts for these three error signatures and
 * started after Tuesday's deploy; here is what to change." One is a symptom
 * report, the other is a work item.
 */
export interface Finding {
  /** Ticket title: the problem, not the error text. */
  title: string
  /** What is actually wrong with the system, in plain language. */
  whatIsWrong: string
  /** Where in the codebase to start — from stack traces. Null when the logs do not say. */
  whereToLook: string | null
  /** What the work involves: what to change, and why that addresses the cause. */
  proposedFix: string
  /** Ranked on user impact, not error volume — one broken checkout beats a thousand noisy warnings. */
  priority: 'critical' | 'high' | 'medium' | 'low'
  /** How well the logs support this conclusion. Below 0.5 means "investigate", not "fix". */
  confidence: number
  /** What this conclusion rests on. Load-bearing — see {@link Evidence}. */
  evidence: Evidence
}

/**
 * What a finding is built from.
 *
 * This is not decoration. It does two jobs that nothing else can:
 *
 * 1. **A human can check the work.** A model's diagnosis is a hypothesis, and a
 *    hypothesis you cannot trace back to the logs it came from is a rumour.
 * 2. **It gives the finding a stable identity.** The same investigation runs
 *    every cycle and will phrase the same problem differently each time. Rocky
 *    matches findings to existing tickets by the *fingerprints they cite*,
 *    never by the model's wording — so re-analysing the same logs updates one
 *    ticket instead of filing a fourth copy of it.
 */
export interface Evidence {
  /** Report ids the finding rests on. */
  reportIds: string[]
  /** Source fingerprints of those reports. The stable key across runs. */
  fingerprints: string[]
  /** Total occurrences across the cited reports, when the source counts them. */
  occurrences: number
  /** ISO timestamps bounding the evidence. */
  firstSeen: string | null
  lastSeen: string | null
}

export const DEFAULT_INVESTIGATION_TEMPLATE = `You are the on-call engineer reading this service's recent error logs. Your job is to work out what is actually wrong with the system and what should be done about each problem — not to summarise the log lines back.

An error tracker has already grouped raw events into signatures. That grouping is mechanical: it splits one underlying bug across several signatures, and it lumps unrelated failures together when they share an exception type. Do not treat one signature as one problem.

How to read the logs:

- **Group by root cause, not by error text.** Several signatures caused by one missing guard are ONE finding. Identical exception types thrown from unrelated components are SEPARATE findings.
- **Weigh user impact, not event count.** A checkout failure hitting twelve people outranks a logging warning that fired forty thousand times. Occurrence counts tell you about volume; the stack trace and the component tell you who is hurt.
- **Use time.** Something that first appeared two days ago and is accelerating is a regression and probably relates to a recent change. Something that has fired steadily for months at low volume is a known annoyance. Say which you think it is.
- **Ignore noise.** Bot traffic, expected 404s, third-party SDK chatter, and errors from client code you do not control are not findings. Leaving them out is as valuable as reporting the real ones.
- **Do not invent.** Every claim comes from the logs in front of you. If the evidence does not identify a location or a cause, say so and lower your confidence — "this needs investigation before anyone writes code" is a correct and useful answer.

These problems already have tickets. Do not report them again unless the logs show something genuinely new about them:
{{tickets}}

Recent logs:
{{reports}}

Respond with a single JSON object and nothing else — no prose, no markdown fences:
{"findings": [{"title": "<the problem, as a ticket title — not the error text>", "whatIsWrong": "<what is actually broken, in plain language a non-specialist understands>", "whereToLook": "<file, function, or component from the stack traces — or null if the logs do not say>", "proposedFix": "<what the work involves: what to change and why that addresses the cause, in two or three sentences>", "priority": "<critical|high|medium|low>", "confidence": <number from 0 to 1>, "reportIds": ["<ids of the log entries above that this rests on>"]}]}

"reportIds" is mandatory and must contain ids copied exactly from the logs above. A finding citing no reports will be discarded, because nobody can check it.

Return {"findings": []} if nothing in these logs warrants engineering work. That is a good answer when it is the true one.`

export interface InvestigateOptions {
  /** The provider that reads the logs. Point it at your strongest model — this is the judgement call. */
  llm: LLMProvider
  /** Tickets that already exist, so the investigation does not re-report known problems. */
  tickets?: Ticket[]
  /** Prompt override. `{{reports}}` and `{{tickets}}` are replaced. */
  template?: string
  /** Cap on log entries handed to the model in one pass. */
  limit?: number
}

const DEFAULT_LIMIT = 120
const MAX_TEXT = 1200

/** What an investigation concluded, and whether it actually got to conclude anything. */
export interface Investigation {
  findings: Finding[]
  /**
   * The investigation did not complete — the provider threw, or its answer was
   * unusable.
   *
   * Separate from an empty `findings` on purpose. "Your logs are clean" and
   * "your model is down" both file nothing, and they are opposite messages: one
   * means the service is healthy, the other means rocky is blind and you would
   * never know. Nothing may report them the same way.
   */
  failed: boolean
}

/**
 * Read a window of logs and work out what is wrong with the system.
 *
 * This is the difference between routing error reports and doing triage. It
 * looks at the corpus rather than one entry at a time, which is the only way to
 * see the things that actually matter: that five signatures share one cause,
 * that this started on Tuesday, that the loudest error is noise and the
 * dangerous one fired eleven times.
 *
 * Never throws. A provider that dies, unparseable output, or findings citing
 * reports that do not exist all come back as `{ findings: [], failed: true }`,
 * and rocky files nothing that pass.
 */
export async function investigate(reports: Report[], options: InvestigateOptions): Promise<Investigation> {
  const { llm, tickets = [], template = DEFAULT_INVESTIGATION_TEMPLATE, limit = DEFAULT_LIMIT } = options
  // No logs is not a failure — it is a quiet service.
  if (reports.length === 0) return { findings: [], failed: false }

  // Busiest and most recent first: if the window has to be truncated, the model
  // should lose the quiet tail rather than the thing paging someone.
  const window = [...reports]
    .sort((a, b) => (b.occurrences ?? 1) - (a.occurrences ?? 1) || b.occurredAt.getTime() - a.occurredAt.getTime())
    .slice(0, limit)

  const byId = new Map(window.map((report) => [report.id, report]))

  const prompt = template
    .replaceAll('{{reports}}', () => JSON.stringify(window.map(renderReport), null, 2))
    .replaceAll(
      '{{tickets}}',
      () =>
        tickets.length === 0
          ? '(none — this is the first investigation)'
          : JSON.stringify(
              tickets.map((t) => ({ id: t.id, title: t.title })),
              null,
              2,
            ),
    )

  let raw: string
  try {
    raw = await llm(prompt)
  } catch {
    return { findings: [], failed: true }
  }
  // An unusable answer is a failure, not a clean bill of health. Only a
  // well-formed `{"findings": []}` counts as "nothing to do".
  const parsed = parseJsonObject(raw)
  if (!parsed || !Array.isArray(parsed['findings'])) return { findings: [], failed: true }
  return { findings: parseFindings(raw, byId), failed: false }
}

/** Parse an investigation response. Never throws; drops anything it cannot verify against the logs. */
export function parseFindings(raw: string, byId: Map<string, Report>): Finding[] {
  const parsed = parseJsonObject(raw)
  const list = parsed?.['findings']
  if (!Array.isArray(list)) return []

  const findings: Finding[] = []
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    const value = entry as Record<string, unknown>

    const title = text(value['title'])
    const whatIsWrong = text(value['whatIsWrong'])
    const proposedFix = text(value['proposedFix'])
    if (!title || !whatIsWrong || !proposedFix) continue

    // Only ids that exist in the window count. A finding resting on a report
    // the model invented is not checkable, and an uncheckable diagnosis is the
    // one thing this must never emit.
    const cited = Array.isArray(value['reportIds'])
      ? (value['reportIds'] as unknown[]).map((id) => text(id)).filter((id): id is string => id !== null && byId.has(id))
      : []
    if (cited.length === 0) continue

    const reports = cited.map((id) => byId.get(id)!)
    const fingerprints = [...new Set(reports.map((r) => r.fingerprint).filter((f): f is string => typeof f === 'string' && f !== ''))]
    const times = reports.flatMap((r) => [r.occurredAt.getTime(), r.firstSeen?.getTime()].filter((t): t is number => typeof t === 'number'))

    findings.push({
      title,
      whatIsWrong,
      whereToLook: text(value['whereToLook']),
      proposedFix,
      priority: priority(value['priority']),
      confidence: unit(value['confidence']),
      evidence: {
        reportIds: cited,
        fingerprints,
        occurrences: reports.reduce((sum, r) => sum + (r.occurrences ?? 1), 0),
        firstSeen: times.length > 0 ? new Date(Math.min(...times)).toISOString() : null,
        lastSeen: times.length > 0 ? new Date(Math.max(...times)).toISOString() : null,
      },
    })
  }

  const rank = { critical: 0, high: 1, medium: 2, low: 3 }
  return findings.sort((a, b) => rank[a.priority] - rank[b.priority] || b.evidence.occurrences - a.evidence.occurrences)
}

/** Markdown body for a ticket filed from a finding. */
export function findingBody(finding: Finding): string {
  const { evidence } = finding
  const lines = [
    '## What needs to be done',
    '',
    finding.proposedFix,
    '',
    `**What is wrong:** ${finding.whatIsWrong}`,
    `**Where:** ${finding.whereToLook ?? 'not identified in the logs'}`,
    `**Priority:** ${finding.priority}`,
    '',
    '## Evidence',
    '',
    `- ${evidence.occurrences.toLocaleString('en-US')} occurrence(s) across ${evidence.reportIds.length} log signature(s)`,
  ]
  if (evidence.firstSeen) lines.push(`- first seen ${evidence.firstSeen}`)
  if (evidence.lastSeen) lines.push(`- last seen ${evidence.lastSeen}`)
  if (evidence.fingerprints.length > 0) {
    lines.push('', 'Signatures:', ...evidence.fingerprints.map((f) => `- \`${f}\``))
  }
  if (finding.confidence < 0.5) {
    lines.push(
      '',
      `> Low confidence (${finding.confidence.toFixed(2)}). The logs may not support this diagnosis — ` +
        'this probably needs a human to investigate before anyone writes code.',
    )
  }
  lines.push(
    '',
    '---',
    '_Concluded by a model from the logs cited above. A hypothesis, not a diagnosis — check the evidence before approving._',
  )
  return lines.join('\n')
}

/** What the model sees for one log entry. Aggregates first: they are what distinguishes a crisis from noise. */
function renderReport(report: Report): Record<string, unknown> {
  return {
    id: report.id,
    source: report.source,
    signature: report.fingerprint ?? null,
    title: report.title ?? null,
    occurrences: report.occurrences ?? 1,
    firstSeen: report.firstSeen?.toISOString() ?? null,
    lastSeen: report.occurredAt.toISOString(),
    reportedBy: report.reporter ?? null,
    text: report.text.length > MAX_TEXT ? `${report.text.slice(0, MAX_TEXT)}…` : report.text,
  }
}

function priority(value: unknown): Finding['priority'] {
  const asText = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return asText === 'critical' || asText === 'high' || asText === 'low' ? asText : 'medium'
}

function unit(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const unfenced = raw
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```$/, '')
  for (const candidate of [unfenced, slice(unfenced)]) {
    if (candidate === null) continue
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

function slice(value: string): string | null {
  const start = value.indexOf('{')
  const end = value.lastIndexOf('}')
  return start === -1 || end <= start ? null : value.slice(start, end + 1)
}
