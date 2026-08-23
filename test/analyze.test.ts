import { describe, expect, it } from 'vitest'
import { analyze, analysisSection, parseAnalysis } from '../src/analyze'
import { ticketBody } from '../src/sinks/format'
import { run } from '../src/run'
import type { RunEvent } from '../src/run'
import { emptyState } from '../src/state'
import { defineConfig } from '../src/project'
import type { Report, TaskAnalysis, Ticket } from '../src/types'
import type { Sink } from '../src/sinks/types'

const REPORT: Report = {
  id: 'gt-1',
  source: 'glitchtip',
  title: 'TypeError in transcribe',
  text: "TypeError: Cannot read properties of undefined (reading 'length')\n  at transcribe (src/voice/pipeline.ts:88)",
  occurredAt: new Date('2026-08-23T00:00:00Z'),
}

const GOOD: TaskAnalysis = {
  summary: 'The voice pipeline crashes when a transcript comes back empty.',
  location: 'src/voice/pipeline.ts:88, transcribe()',
  proposedFix: 'Guard the transcript before reading .length and return an empty result instead of throwing.',
  risks: ['No reproduction steps in the report'],
  confidence: 0.8,
}

const answer = (payload: unknown) => async () => JSON.stringify(payload)

function memorySink(): Sink & { created: Array<{ report: Report; analysis?: TaskAnalysis | null }> } {
  const created: Array<{ report: Report; analysis?: TaskAnalysis | null }> = []
  return {
    name: 'memory',
    created,
    listOpen: async () => [],
    create: async (report, opts) => {
      created.push({ report, analysis: opts.analysis })
      const ticket: Ticket = { id: 1, title: report.title ?? '', summary: '', fingerprint: null, state: 'open', link: '' }
      return ticket
    },
    annotate: async () => undefined,
  }
}

describe('analyze', () => {
  it('turns a stack trace into something a human can decide on', async () => {
    const result = await analyze(REPORT, { llm: answer(GOOD) })
    expect(result).toEqual(GOOD)
  })

  it('sends the report, not the raw text, so the model sees who and when', async () => {
    let prompt = ''
    await analyze({ ...REPORT, reporter: 'ana@acme.com' }, {
      llm: async (p) => {
        prompt = p
        return JSON.stringify(GOOD)
      },
    })
    expect(prompt).toContain('ana@acme.com')
    expect(prompt).toContain('glitchtip')
    expect(prompt).toContain('2026-08-23')
  })

  it('clamps confidence into range and tolerates a missing one', async () => {
    expect((await analyze(REPORT, { llm: answer({ ...GOOD, confidence: 7 }) }))?.confidence).toBe(1)
    expect((await analyze(REPORT, { llm: answer({ ...GOOD, confidence: -2 }) }))?.confidence).toBe(0)
    expect((await analyze(REPORT, { llm: answer({ ...GOOD, confidence: 'high' }) }))?.confidence).toBe(0.5)
  })

  it('drops malformed risks rather than rendering "undefined" to a human', async () => {
    const result = await analyze(REPORT, { llm: answer({ ...GOOD, risks: ['real', 42, null, '  '] }) })
    expect(result?.risks).toEqual(['real'])
  })

  it('reads a fenced or prose-wrapped answer', async () => {
    expect(await analyze(REPORT, { llm: async () => `Here you go:\n\`\`\`json\n${JSON.stringify(GOOD)}\n\`\`\`` })).toEqual(GOOD)
  })

  describe('returns null rather than a half-brief', () => {
    const cases: Array<[string, () => Promise<string>]> = [
      ['the provider throws', () => Promise.reject(new Error('402 quota exceeded'))],
      ['the output is not JSON', async () => 'I think it is the voice pipeline'],
      ['the output is an array', async () => '[1,2,3]'],
      ['there is no summary', answer({ proposedFix: 'do the thing' })],
      ['there is no proposed fix', answer({ summary: 'it broke' })],
      ['the summary is blank', answer({ ...GOOD, summary: '   ' })],
    ]
    for (const [label, llm] of cases) {
      it(label, async () => {
        expect(await analyze(REPORT, { llm })).toBeNull()
      })
    }
  })

  it('parses a null location without discarding the brief', () => {
    const result = parseAnalysis(JSON.stringify({ ...GOOD, location: null }))
    expect(result).toMatchObject({ location: null, summary: GOOD.summary })
  })
})

describe('how the brief reaches the ticket', () => {
  it('leads with the work, keeps the original report in full, and says it is a hypothesis', () => {
    const body = ticketBody(REPORT, GOOD)
    expect(body.indexOf('## What needs to be done')).toBe(0)
    expect(body.indexOf('## Original report')).toBeGreaterThan(0)
    expect(body).toContain(GOOD.proposedFix)
    expect(body).toContain('src/voice/pipeline.ts:88')
    // The evidence must survive intact — the brief is a summary of it, not a
    // replacement for it.
    expect(body).toContain(REPORT.text)
    expect(body).toContain('hypothesis, not a diagnosis')
  })

  it('is byte-identical to the old body when there is no analysis', () => {
    expect(ticketBody(REPORT)).toBe(ticketBody(REPORT, null))
    expect(ticketBody(REPORT)).not.toContain('## Original report')
  })

  it('warns in the ticket itself when the report is too thin to act on', () => {
    const section = analysisSection({ ...GOOD, confidence: 0.2, risks: ['No stack trace'] })
    expect(section).toContain('Low confidence')
    expect(section).toContain('asking the reporter')
  })

  it('says so plainly when the report never identified a location', () => {
    expect(analysisSection({ ...GOOD, location: null })).toContain('not identified in the report')
  })
})

describe('run — analysis in the loop', () => {
  const source = { name: 's', poll: async () => ({ reports: [REPORT], cursor: 'c' }) }

  it('analyzes a new bug and hands the brief to the sink', async () => {
    const sink = memorySink()
    const events: RunEvent[] = []
    const project = defineConfig({ sources: [source], sink, analyst: answer(GOOD) })

    const { summary } = await run(project, emptyState(), { live: true, log: (e) => events.push(e) })

    expect(summary).toMatchObject({ created: 1, analyzed: 1 })
    expect(sink.created[0]!.analysis).toEqual(GOOD)
    expect(events.some((e) => e.type === 'analyzed')).toBe(true)
  })

  it('never analyzes a duplicate — the brief already exists on the ticket it matched', async () => {
    let calls = 0
    const existing: Ticket = {
      id: 7,
      title: 'known',
      summary: 'x',
      fingerprint: 'glitchtip:1',
      state: 'open',
      link: '',
    }
    const sink: Sink = { ...memorySink(), listOpen: async () => [existing] }
    const project = defineConfig({
      sources: [{ name: 's', poll: async () => ({ reports: [{ ...REPORT, fingerprint: 'glitchtip:1' }], cursor: 'c' }) }],
      sink,
      analyst: async () => {
        calls++
        return JSON.stringify(GOOD)
      },
    })

    const { summary } = await run(project, emptyState(), { live: true })

    expect(summary).toMatchObject({ annotated: 1, created: 0, analyzed: 0 })
    expect(calls).toBe(0)
  })

  it('still files the ticket when the analyst fails — losing a brief is not losing a bug', async () => {
    const sink = memorySink()
    const events: RunEvent[] = []
    const project = defineConfig({
      sources: [source],
      sink,
      analyst: () => Promise.reject(new Error('rate limited')),
    })

    const { summary } = await run(project, emptyState(), { live: true, log: (e) => events.push(e) })

    expect(summary).toMatchObject({ created: 1, analyzed: 0, errors: 0 })
    expect(sink.created[0]!.analysis).toBeNull()
    expect(events.some((e) => e.type === 'analysis-failed')).toBe(true)
  })

  it('does not call the analyst in a dry run', async () => {
    let calls = 0
    const project = defineConfig({
      sources: [source],
      sink: memorySink(),
      analyst: async () => {
        calls++
        return JSON.stringify(GOOD)
      },
    })

    await run(project, emptyState(), {})

    expect(calls).toBe(0)
  })

  it('runs without an analyst configured at all', async () => {
    const sink = memorySink()
    const { summary } = await run(defineConfig({ sources: [source], sink }), emptyState(), { live: true })
    expect(summary).toMatchObject({ created: 1, analyzed: 0 })
    expect(sink.created[0]!.analysis).toBeNull()
  })
})
