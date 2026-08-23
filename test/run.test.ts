import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { run } from '../src/run'
import type { RunEvent } from '../src/run'
import { SEEN_CAP, emptyState, loadState, saveState } from '../src/state'
import { assertProjectConfig, defineConfig } from '../src/project'
import { CONFIG_TEMPLATE, PAIRS_TEMPLATE } from '../src/scaffold'
import { parsePairs } from '../src/eval'
import type { Report, Ticket } from '../src/types'
import type { Source } from '../src/sources/types'
import type { Sink } from '../src/sinks/types'

function report(id: string, overrides: Partial<Report> = {}): Report {
  return {
    id,
    source: 'test',
    text: `report text for ${id} zzzz`,
    occurredAt: new Date(0),
    ...overrides,
  }
}

function scriptedSource(name: string, batch: { reports: Report[]; cursor: string }): Source & { polledWith: Array<string | null> } {
  const polledWith: Array<string | null> = []
  return {
    name,
    polledWith,
    async poll(cursor) {
      polledWith.push(cursor)
      return batch
    },
  }
}

interface MemorySink extends Sink {
  createCalls: Array<{ report: Report; labels: string[] }>
  annotateCalls: Array<{ ticketId: string | number; report: Report }>
}

function memorySink(initial: Ticket[], options: { failCreate?: boolean } = {}): MemorySink {
  const createCalls: MemorySink['createCalls'] = []
  const annotateCalls: MemorySink['annotateCalls'] = []
  let nextId = 100
  return {
    name: 'memory',
    createCalls,
    annotateCalls,
    async listOpen() {
      return [...initial]
    },
    async create(r, opts) {
      if (options.failCreate) throw new Error('tracker is down')
      createCalls.push({ report: r, labels: opts.labels })
      return {
        id: nextId++,
        title: r.title ?? r.text,
        summary: r.text,
        fingerprint: r.fingerprint ?? null,
        state: 'open',
        link: '',
      }
    },
    async annotate(ticketId, r) {
      annotateCalls.push({ ticketId, report: r })
    },
  }
}

const existingTicket: Ticket = {
  id: 7,
  title: 'Known crash',
  summary: 'aaaa bbbb cccc dddd',
  fingerprint: 'sentry:7',
  state: 'open',
  link: 'https://tracker/7',
}

describe('run — dry-run (the default)', () => {
  it('decides and logs but writes nothing: no sink calls, state returned unchanged', async () => {
    const sink = memorySink([existingTicket])
    const source = scriptedSource('s1', {
      reports: [report('r-new'), report('r-dup', { fingerprint: 'sentry:7' })],
      cursor: 'c1',
    })
    const events: RunEvent[] = []
    const before = emptyState()

    const { summary, state } = await run(defineConfig({ sources: [source], sink }), before, {
      log: (e) => events.push(e),
    })

    expect(sink.createCalls).toHaveLength(0)
    expect(sink.annotateCalls).toHaveLength(0)
    expect(summary).toMatchObject({ reports: 2, created: 1, annotated: 1, skipped: 0, errors: 0, live: false })
    expect(state).toEqual(emptyState())

    const decisions = events.filter((e) => e.type === 'decision')
    expect(decisions).toHaveLength(2)
    expect(decisions[1]).toMatchObject({ action: 'annotate', result: { matchId: 7, tier: 1 }, live: false })
  })

  it('simulates in-batch creation so the second identical report shows as a duplicate of the first', async () => {
    const sink = memorySink([])
    const source = scriptedSource('s1', {
      reports: [report('r1', { fingerprint: 'fp-x' }), report('r2', { fingerprint: 'fp-x' })],
      cursor: 'c1',
    })
    const events: RunEvent[] = []

    const { summary } = await run(defineConfig({ sources: [source], sink }), emptyState(), {
      log: (e) => events.push(e),
    })

    expect(summary).toMatchObject({ created: 1, annotated: 1 })
    const second = events.filter((e) => e.type === 'decision')[1]!
    expect(second).toMatchObject({ action: 'annotate', result: { matchId: 'pending:r1', tier: 1 } })
  })
})

describe('run — live', () => {
  it('creates, annotates (including against tickets created earlier in the batch), advances cursors, records seen', async () => {
    const sink = memorySink([existingTicket])
    const source = scriptedSource('s1', {
      reports: [
        report('r-dup', { fingerprint: 'sentry:7' }),
        report('r-new', { fingerprint: 'fp-new' }),
        report('r-new-again', { fingerprint: 'fp-new' }),
      ],
      cursor: 'c-advanced',
    })
    const events: RunEvent[] = []

    const { summary, state } = await run(defineConfig({ sources: [source], sink, labels: ['rocky', 'bug'] }), emptyState(), {
      live: true,
      log: (e) => events.push(e),
    })

    expect(source.polledWith).toEqual([null])
    expect(sink.annotateCalls.map((c) => c.ticketId)).toEqual([7, 100])
    expect(sink.createCalls).toHaveLength(1)
    expect(sink.createCalls[0]).toMatchObject({ report: { id: 'r-new' }, labels: ['rocky', 'bug'] })
    expect(summary).toMatchObject({ reports: 3, created: 1, annotated: 2, errors: 0, live: true })
    expect(state.cursors).toEqual({ s1: 'c-advanced' })
    expect(state.seen).toEqual(['r-dup', 'r-new', 'r-new-again'])
    expect(events.some((e) => e.type === 'created' && e.ticketId === 100)).toBe(true)
  })

  it('skips reports already seen by an earlier run', async () => {
    const sink = memorySink([])
    const source = scriptedSource('s1', { reports: [report('r-old'), report('r-new')], cursor: 'c2' })

    const { summary } = await run(defineConfig({ sources: [source], sink }), { cursors: { s1: 'c1' }, seen: ['r-old'] }, { live: true })

    expect(summary).toMatchObject({ reports: 1, skipped: 1, created: 1 })
    expect(source.polledWith).toEqual(['c1'])
    expect(sink.createCalls.map((c) => c.report.id)).toEqual(['r-new'])
  })

  it('contains a failing source: logs the error, keeps its cursor, still processes the others', async () => {
    const sink = memorySink([])
    const broken: Source = {
      name: 'broken',
      poll: async () => {
        throw new Error('token expired')
      },
    }
    const healthy = scriptedSource('healthy', { reports: [report('r1')], cursor: 'c1' })
    const events: RunEvent[] = []

    const { summary, state } = await run(
      defineConfig({ sources: [broken, healthy], sink }),
      { cursors: { broken: 'keep-me' }, seen: [] },
      { live: true, log: (e) => events.push(e) },
    )

    expect(events.some((e) => e.type === 'poll-error' && e.source === 'broken' && e.message.includes('token expired'))).toBe(true)
    expect(summary).toMatchObject({ errors: 1, created: 1 })
    expect(state.cursors).toEqual({ broken: 'keep-me', healthy: 'c1' })
  })

  it('does not advance the cursor or mark seen when an action fails, so the next run retries', async () => {
    const sink = memorySink([], { failCreate: true })
    const source = scriptedSource('s1', { reports: [report('r1')], cursor: 'c-new' })
    const events: RunEvent[] = []

    const { summary, state } = await run(defineConfig({ sources: [source], sink }), { cursors: { s1: 'c-old' }, seen: [] }, { live: true, log: (e) => events.push(e) })

    expect(summary).toMatchObject({ errors: 1, created: 0 })
    expect(state.cursors).toEqual({ s1: 'c-old' })
    expect(state.seen).toEqual([])
    expect(events.some((e) => e.type === 'action-error' && e.message.includes('tracker is down'))).toBe(true)
  })

  it('caps the seen list', async () => {
    const sink = memorySink([])
    const source = scriptedSource('s1', { reports: [report('r-latest')], cursor: 'c' })
    const seeded = { cursors: {}, seen: Array.from({ length: SEEN_CAP }, (_, i) => `old-${i}`) }

    const { state } = await run(defineConfig({ sources: [source], sink }), seeded, { live: true })

    expect(state.seen).toHaveLength(SEEN_CAP)
    expect(state.seen.at(-1)).toBe('r-latest')
    expect(state.seen).not.toContain('old-0')
  })

  it('aborts when the sink cannot list open tickets', async () => {
    const sink = memorySink([])
    sink.listOpen = async () => {
      throw new Error('403')
    }
    const source = scriptedSource('s1', { reports: [report('r1')], cursor: 'c' })
    await expect(run(defineConfig({ sources: [source], sink }), emptyState(), { live: true })).rejects.toThrow(
      /could not list open tickets/,
    )
  })
})

describe('state persistence', () => {
  it('round-trips through the file, returns empty for a missing file, throws on corruption', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rocky-state-'))
    const path = join(dir, 'nested', 'state.json')

    expect(loadState(path)).toEqual(emptyState())

    const state = { cursors: { sentry: '2026-08-23T00:00:00.000Z' }, seen: ['a', 'b'] }
    saveState(path, state)
    expect(loadState(path)).toEqual(state)
    expect(readFileSync(path, 'utf8')).toContain('"sentry"')

    writeFileSync(path, '{not json', 'utf8')
    expect(() => loadState(path)).toThrow(/not valid JSON/)
    writeFileSync(path, '{"cursors": {"a": 1}, "seen": []}', 'utf8')
    expect(() => loadState(path)).toThrow(/unexpected shape/)
  })
})

describe('project config validation and scaffolds', () => {
  it('accepts a well-formed config and rejects structural mistakes by name', () => {
    const sink = memorySink([])
    const source = scriptedSource('s', { reports: [], cursor: 'c' })
    expect(() => assertProjectConfig(defineConfig({ sources: [source], sink }))).not.toThrow()
    expect(() => assertProjectConfig({ sink })).toThrow(/"sources"/)
    expect(() => assertProjectConfig({ sources: [source] })).toThrow(/"sink"/)
    expect(() => assertProjectConfig({ sources: [{ name: 'x' }], sink })).toThrow(/sources\[0\]/)
    expect(() => assertProjectConfig({ sources: [source], sink, labels: 'rocky' })).toThrow(/"labels"/)
  })

  it('ships scaffold templates that are valid: pairs parse, config mentions the moving parts', () => {
    const pairs = parsePairs(JSON.parse(PAIRS_TEMPLATE))
    expect(pairs).toHaveLength(2)
    expect(pairs.map((p) => p.same)).toEqual([true, false])
    for (const needle of ['defineConfig', 'sources', 'sink', 'openaiProvider', 'rocky eval', 'labels']) {
      expect(CONFIG_TEMPLATE).toContain(needle)
    }
  })
})
