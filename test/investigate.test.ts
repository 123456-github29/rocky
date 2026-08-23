import { describe, expect, it } from 'vitest'
import { findingBody, investigate, parseFindings } from '../src/investigate'
import type { Finding } from '../src/investigate'
import { run } from '../src/run'
import type { RunEvent } from '../src/run'
import { emptyState } from '../src/state'
import { defineConfig } from '../src/project'
import type { Report, Ticket } from '../src/types'
import type { Sink } from '../src/sinks/types'
import type { Source } from '../src/sources/types'

function log(id: string, overrides: Partial<Report> = {}): Report {
  return {
    id,
    source: 'glitchtip',
    title: `error ${id}`,
    text: `stack trace for ${id}`,
    fingerprint: `glitchtip:${id}`,
    occurredAt: new Date('2026-08-23T12:00:00Z'),
    ...overrides,
  }
}

/** The three signatures an investigation should conclude are one problem. */
const CORPUS = [
  log('4471', { occurrences: 3100, firstSeen: new Date('2026-08-21T00:00:00Z') }),
  log('4472', { occurrences: 900, firstSeen: new Date('2026-08-21T02:00:00Z') }),
  log('4473', { occurrences: 12, firstSeen: new Date('2026-08-21T04:00:00Z') }),
  log('0001', { occurrences: 44000, firstSeen: new Date('2025-01-01T00:00:00Z') }),
]

const ONE_PROBLEM = {
  findings: [
    {
      title: 'Voice pipeline does not handle empty transcripts',
      whatIsWrong: 'Three signatures all come from one missing guard in transcribe().',
      whereToLook: 'src/voice/pipeline.ts:88',
      proposedFix: 'Guard the transcript before reading .length and return an empty result.',
      priority: 'high',
      confidence: 0.85,
      reportIds: ['4471', '4472', '4473'],
    },
  ],
}

const answer = (payload: unknown) => async () => JSON.stringify(payload)

function memorySink(open: Ticket[] = []): Sink & { created: Array<{ title?: string; body?: string; fingerprints?: string[] }> } {
  const created: Array<{ title?: string; body?: string; fingerprints?: string[] }> = []
  let next = 100
  return {
    name: 'memory',
    created,
    listOpen: async () => [...open],
    create: async (_report, opts) => {
      created.push({ title: opts.title, body: opts.body, fingerprints: opts.fingerprints })
      const ticket: Ticket = {
        id: next++,
        title: opts.title ?? '',
        summary: opts.body ?? '',
        fingerprint: opts.fingerprints?.[0] ?? null,
        fingerprints: opts.fingerprints ?? [],
        state: 'open',
        link: '',
      }
      open.push(ticket)
      return ticket
    },
    annotate: async () => undefined,
  }
}

function source(reports: Report[], corpus?: Report[]): Source {
  return { name: 'glitchtip', poll: async () => ({ reports, cursor: 'c1', ...(corpus ? { corpus } : {}) }) }
}

describe('investigate — reading the corpus', () => {
  it('groups several signatures into one problem and records what it rests on', async () => {
    const { findings } = await investigate(CORPUS, { llm: answer(ONE_PROBLEM) })

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ title: ONE_PROBLEM.findings[0]!.title, priority: 'high' })
    expect(findings[0]!.evidence).toMatchObject({
      reportIds: ['4471', '4472', '4473'],
      fingerprints: ['glitchtip:4471', 'glitchtip:4472', 'glitchtip:4473'],
      // Summed across the cited signatures, not the loudest one.
      occurrences: 3100 + 900 + 12,
    })
  })

  it('bounds the evidence window by first-seen, so a regression is datable', async () => {
    const { findings } = await investigate(CORPUS, { llm: answer(ONE_PROBLEM) })
    expect(findings[0]!.evidence.firstSeen).toBe('2026-08-21T00:00:00.000Z')
    expect(findings[0]!.evidence.lastSeen).toBe('2026-08-23T12:00:00.000Z')
  })

  it('shows the model occurrence counts and age — the difference between a crisis and noise', async () => {
    let prompt = ''
    await investigate(CORPUS, {
      llm: async (p) => {
        prompt = p
        return JSON.stringify(ONE_PROBLEM)
      },
    })
    expect(prompt).toContain('"occurrences": 44000')
    expect(prompt).toContain('"firstSeen": "2025-01-01T00:00:00.000Z"')
    expect(prompt).toContain('"signature": "glitchtip:4471"')
  })

  it('tells the model which problems already have tickets', async () => {
    let prompt = ''
    await investigate(CORPUS, {
      tickets: [{ id: 7, title: 'Known thing', summary: '', fingerprint: null, state: 'open', link: '' }],
      llm: async (p) => {
        prompt = p
        return JSON.stringify({ findings: [] })
      },
    })
    expect(prompt).toContain('Known thing')
  })

  it('hands over the busiest signatures first when the window has to be trimmed', async () => {
    let prompt = ''
    await investigate(CORPUS, {
      limit: 1,
      llm: async (p) => {
        prompt = p
        return JSON.stringify({ findings: [] })
      },
    })
    // 44,000 occurrences beats 3,100 — losing the quiet tail is survivable,
    // losing the thing paging someone is not.
    expect(prompt).toContain('"id": "0001"')
    expect(prompt).not.toContain('"id": "4473"')
  })

  it('accepts an empty investigation as a real answer', async () => {
    expect(await investigate(CORPUS, { llm: answer({ findings: [] }) })).toEqual({ findings: [], failed: false })
  })

  it('does not call the model when there are no logs', async () => {
    let calls = 0
    await investigate([], {
      llm: async () => {
        calls++
        return '{}'
      },
    })
    expect(calls).toBe(0)
  })

  it('ranks critical before high before medium before low', async () => {
    const { findings } = await investigate(CORPUS, {
      llm: answer({
        findings: ['low', 'critical', 'medium', 'high'].map((priority, i) => ({
          title: priority,
          whatIsWrong: 'x',
          proposedFix: 'y',
          priority,
          reportIds: [CORPUS[i]!.id],
        })),
      }),
    })
    expect(findings.map((f) => f.priority)).toEqual(['critical', 'high', 'medium', 'low'])
  })
})

describe('investigate — refusing what cannot be checked', () => {
  const byId = new Map(CORPUS.map((r) => [r.id, r]))

  it('discards a finding citing a report that does not exist', () => {
    const findings = parseFindings(
      JSON.stringify({
        findings: [{ title: 'Invented', whatIsWrong: 'x', proposedFix: 'y', reportIds: ['9999'] }],
      }),
      byId,
    )
    expect(findings).toEqual([])
  })

  it('keeps only the citations that are real', () => {
    const findings = parseFindings(
      JSON.stringify({
        findings: [{ title: 'Half real', whatIsWrong: 'x', proposedFix: 'y', reportIds: ['4471', '9999'] }],
      }),
      byId,
    )
    expect(findings[0]!.evidence.reportIds).toEqual(['4471'])
  })

  it('discards a finding citing nothing at all', () => {
    expect(parseFindings(JSON.stringify({ findings: [{ title: 'a', whatIsWrong: 'b', proposedFix: 'c', reportIds: [] }] }), byId)).toEqual([])
  })

  it('discards a finding with no proposed fix — a diagnosis with no work item is not a task', () => {
    expect(parseFindings(JSON.stringify({ findings: [{ title: 'a', whatIsWrong: 'b', reportIds: ['4471'] }] }), byId)).toEqual([])
  })

  it('reports a failure as a failure, never as clean logs', async () => {
    // "Nothing to file" and "rocky read nothing" both write no tickets, and a
    // service whose logs go unread looks exactly like a healthy one. These must
    // never be reported the same way.
    for (const llm of [
      () => Promise.reject(new Error('502')),
      async () => 'I had a look and things seem fine',
      async () => '{"findings": "lots"}',
    ]) {
      expect(await investigate(CORPUS, { llm })).toEqual({ findings: [], failed: true })
    }
    expect(await investigate(CORPUS, { llm: answer({ findings: [] }) })).toEqual({ findings: [], failed: false })
    expect(await investigate([], { llm: answer({ findings: [] }) })).toEqual({ findings: [], failed: false })
  })

  it('defaults an unknown priority to medium rather than dropping the finding', () => {
    const findings = parseFindings(
      JSON.stringify({ findings: [{ title: 'a', whatIsWrong: 'b', proposedFix: 'c', priority: 'URGENT!!', reportIds: ['4471'] }] }),
      byId,
    )
    expect(findings[0]!.priority).toBe('medium')
  })
})

describe('the ticket a finding becomes', () => {
  const finding: Finding = {
    title: 'Voice pipeline does not handle empty transcripts',
    whatIsWrong: 'Three signatures share one missing guard.',
    whereToLook: 'src/voice/pipeline.ts:88',
    proposedFix: 'Guard the transcript before reading .length.',
    priority: 'high',
    confidence: 0.85,
    evidence: {
      reportIds: ['4471', '4472'],
      fingerprints: ['glitchtip:4471', 'glitchtip:4472'],
      occurrences: 4012,
      firstSeen: '2026-08-21T00:00:00.000Z',
      lastSeen: '2026-08-23T12:00:00.000Z',
    },
  }

  it('leads with the work and shows the evidence underneath it', () => {
    const body = findingBody(finding)
    expect(body.indexOf('## What needs to be done')).toBe(0)
    expect(body).toContain(finding.proposedFix)
    expect(body).toContain('**Priority:** high')
    expect(body).toContain('4,012 occurrence(s) across 2 log signature(s)')
    expect(body).toContain('glitchtip:4471')
    expect(body).toContain('hypothesis, not a diagnosis')
  })

  it('says outright when the logs do not support the diagnosis', () => {
    expect(findingBody({ ...finding, confidence: 0.2 })).toContain('needs a human to investigate before anyone writes code')
  })
})

describe('run — the investigating pass', () => {
  it('files one ticket for a problem spanning three signatures, carrying all three', async () => {
    const sink = memorySink()
    const events: RunEvent[] = []
    const project = defineConfig({
      sources: [source([CORPUS[0]!], CORPUS)],
      sink,
      investigator: answer(ONE_PROBLEM),
    })

    const { summary } = await run(project, emptyState(), { live: true, log: (e) => events.push(e) })

    expect(summary).toMatchObject({ created: 1, reports: 4 })
    expect(sink.created).toHaveLength(1)
    expect(sink.created[0]!.title).toBe(ONE_PROBLEM.findings[0]!.title)
    expect(sink.created[0]!.fingerprints).toEqual(['glitchtip:4471', 'glitchtip:4472', 'glitchtip:4473'])
    expect(events.some((e) => e.type === 'investigated')).toBe(true)
  })

  it('does not re-file the same problem next cycle, even worded completely differently', async () => {
    const sink = memorySink()
    const project = defineConfig({ sources: [source([], CORPUS)], sink, investigator: answer(ONE_PROBLEM) })

    await run(project, emptyState(), { live: true })

    // Same logs, same problem, a model that phrases it nothing like last time.
    // Matching on prose would file a second ticket every fifteen minutes.
    const reworded = defineConfig({
      sources: [source([], CORPUS)],
      sink,
      investigator: answer({
        findings: [
          {
            title: 'Empty STT results crash the audio worker',
            whatIsWrong: 'Completely different wording for the same fault.',
            proposedFix: 'Also worded differently.',
            priority: 'critical',
            reportIds: ['4472'],
          },
        ],
      }),
    })
    const { summary } = await run(reworded, emptyState(), { live: true })

    expect(summary).toMatchObject({ created: 0, skipped: 1 })
    expect(sink.created).toHaveLength(1)
  })

  it('reads the whole corpus, not only what arrived since the cursor', async () => {
    let seen = 0
    const project = defineConfig({
      // One new report, but four signatures standing. A regression is only
      // visible next to what was already there.
      sources: [source([CORPUS[0]!], CORPUS)],
      sink: memorySink(),
      investigator: async (prompt) => {
        seen = (prompt.match(/"id":/g) ?? []).length
        return JSON.stringify({ findings: [] })
      },
    })

    await run(project, emptyState(), { live: true })

    expect(seen).toBe(4)
  })

  it('clean logs file nothing, advance the cursor, and count no failure', async () => {
    const sink = memorySink()
    const events: RunEvent[] = []
    const project = defineConfig({ sources: [source([], CORPUS)], sink, investigator: answer({ findings: [] }) })

    const { summary, state } = await run(project, emptyState(), { live: true, log: (e) => events.push(e) })

    expect(sink.created).toEqual([])
    expect(summary).toMatchObject({ created: 0, llmFailures: 0 })
    // The window was read and had nothing in it, so there is no reason to read
    // it again from the same point.
    expect(state.cursors).toEqual({ glitchtip: 'c1' })
    expect(events.some((e) => e.type === 'investigated')).toBe(true)
  })

  it('a failed investigation holds the cursor and is never reported as clean logs', async () => {
    const sink = memorySink()
    const events: RunEvent[] = []
    const project = defineConfig({
      sources: [source([], CORPUS)],
      sink,
      investigator: () => Promise.reject(new Error('provider down')),
    })

    const { summary, state } = await run(project, emptyState(), { live: true, log: (e) => events.push(e) })

    expect(sink.created).toEqual([])
    expect(summary.llmFailures).toBe(1)
    // Held, so the next pass re-reads this window rather than skipping past it.
    expect(state.cursors).toEqual({})
    expect(events.some((e) => e.type === 'investigation-failed')).toBe(true)
    expect(events.some((e) => e.type === 'investigated')).toBe(false)
  })

  it('dry-run reports every finding and writes nothing', async () => {
    const sink = memorySink()
    const events: RunEvent[] = []
    const project = defineConfig({ sources: [source([], CORPUS)], sink, investigator: answer(ONE_PROBLEM) })

    const { summary, state } = await run(project, emptyState(), { log: (e) => events.push(e) })

    expect(sink.created).toEqual([])
    expect(state).toEqual(emptyState())
    expect(summary).toMatchObject({ created: 1, live: false })
    const finding = events.find((e) => e.type === 'finding')
    expect(finding).toMatchObject({ action: 'create', live: false })
  })

  it('falls back to per-report triage when no investigator is configured', async () => {
    const sink = memorySink()
    const project = defineConfig({ sources: [source([CORPUS[0]!], CORPUS)], sink })

    const { summary } = await run(project, emptyState(), { live: true })

    // Triage sees only the one new report, not the corpus.
    expect(summary.reports).toBe(1)
    expect(sink.created).toHaveLength(1)
  })
})
