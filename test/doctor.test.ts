import { describe, expect, it } from 'vitest'
import { doctor, formatDoctorReport } from '../src/doctor'
import type { CheckResult } from '../src/doctor'
import { defineConfig } from '../src/project'
import type { RockyProjectConfig } from '../src/project'
import type { Sink } from '../src/sinks/types'
import type { Source } from '../src/sources/types'
import type { Notifier, NotifyMessage } from '../src/notify/types'
import type { Report, Ticket } from '../src/types'

function report(id: string, fingerprint: string | null = null): Report {
  return { id, source: 'test', title: `Bug ${id}`, text: 'boom', fingerprint, occurredAt: new Date(0) }
}

function source(name: string, reports: Report[] | Error): Source {
  return {
    name,
    poll: async () => {
      if (reports instanceof Error) throw reports
      return { reports, cursor: 'c' }
    },
  }
}

function ticket(id: string | number): Ticket {
  return { id, title: `Bug ${String(id)}`, summary: '', fingerprint: null, state: 'open', link: '' }
}

function fullSink(byLabel: Record<string, Ticket[]> = {}): Sink {
  return {
    name: 'tracker',
    listOpen: async () => Object.values(byLabel).flat(),
    create: async () => ticket(1),
    annotate: async () => undefined,
    listByLabel: async (label) => byLabel[label] ?? [],
    setLabels: async () => undefined,
    comment: async () => undefined,
    resolution: async () => ({ closed: false, fix: null }),
  }
}

function find(results: CheckResult[], name: string): CheckResult {
  const hit = results.find((r) => r.name === name)
  if (!hit) throw new Error(`no check named ${name} in ${results.map((r) => r.name).join(', ')}`)
  return hit
}

function project(overrides: Partial<RockyProjectConfig> = {}): RockyProjectConfig {
  return defineConfig({
    sources: [source('glitchtip', [report('a', 'glitchtip:1')])],
    sink: fullSink({ rocky: [ticket(1)], approved: [] }),
    match: { llm: async () => 'ok' },
    ...overrides,
  })
}

describe('doctor — the happy path', () => {
  it('passes every check and writes nothing', async () => {
    const results = await doctor(project())
    const { text, failed } = formatDoctorReport(results)

    expect(failed).toBe(false)
    expect(find(results, 'glitchtip')).toMatchObject({ status: 'ok', summary: '1 report(s) available · 1 with signatures' })
    expect(find(results, 'tracker').status).toBe('ok')
    expect(find(results, 'approval loop')).toMatchObject({ status: 'ok' })
    expect(find(results, 'llm').status).toBe('ok')
    expect(text).toContain('1 ticket(s) labeled "rocky"')
  })

  it('shows a sample report so you can see what the matcher will actually get', async () => {
    const results = await doctor(project())
    expect(find(results, 'glitchtip').detail?.[0]).toContain('sample: a  "Bug a"  fingerprint glitchtip:1')
  })

  it('does not message anyone unless asked', async () => {
    const sent: NotifyMessage[] = []
    const notifier: Notifier = {
      name: 'telegram',
      send: async (m) => {
        sent.push(m)
      },
    }

    const quiet = await doctor(project({ notify: notifier }))
    expect(sent).toHaveLength(0)
    expect(find(quiet, 'telegram').summary).toContain('pass --notify')

    await doctor(project({ notify: notifier }), { notify: true })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.subject).toContain('test message')
  })
})

describe('doctor — warnings that predict a silent failure later', () => {
  it('flags a source that returns nothing rather than calling it healthy', async () => {
    const results = await doctor(project({ sources: [source('gmail', [])] }))
    expect(find(results, 'gmail')).toMatchObject({ status: 'warn', summary: 'reachable, but returned nothing to work with' })
  })

  it('flags a source with no fingerprints, because tier 1 can never fire for it', async () => {
    const results = await doctor(project({ sources: [source('gmail', [report('a', null)])] }))
    const check = find(results, 'gmail')
    expect(check.status).toBe('warn')
    expect(check.detail?.join(' ')).toContain('tier 1')
  })

  it('flags approved tickets that are not in the funnel — a label mismatch rocky would ignore forever', async () => {
    const results = await doctor(project({ sink: fullSink({ rocky: [], approved: [ticket(7)] }) }))
    expect(find(results, 'approval loop').detail?.join(' ')).toContain('will not be picked up')
  })

  it('flags a missing LLM as a warning, not a failure — tiers 1–2 is a valid setup', async () => {
    const results = await doctor(project({ match: {} }))
    expect(find(results, 'llm').status).toBe('warn')
    expect(formatDoctorReport(results).failed).toBe(false)
  })

  it('names the exact methods a hand-written sink is missing', async () => {
    const bare: Sink = {
      name: 'homemade',
      listOpen: async () => [],
      create: async () => ticket(1),
      annotate: async () => undefined,
    }
    const results = await doctor(project({ sink: bare }))
    expect(find(results, 'approval loop')).toMatchObject({ status: 'fail' })
    expect(find(results, 'approval loop').summary).toContain('listByLabel, setLabels, comment, resolution')
  })
})

describe('doctor — diagnosis', () => {
  const cases: Array<[string, string, string]> = [
    ['a 401', 'github: HTTP 401 — Bad credentials', 'credential was rejected'],
    ['a 404', 'linear: HTTP 404 — not found', 'Check org/project/owner/repo/team spelling'],
    ['a 429', 'sentry: HTTP 429 — slow down', 'Rate limited'],
    ['a dead host', 'fetch failed: ENOTFOUND glitchtip.internal', 'Could not connect at all'],
  ]

  for (const [label, error, expected] of cases) {
    it(`explains ${label}`, async () => {
      const results = await doctor(project({ sources: [source('s', new Error(error))] }))
      expect(find(results, 's').detail?.join(' ')).toContain(expected)
    })
  }

  it('reads an egress block as a network policy, not a missing scope', async () => {
    // A proxy or allowlist answers 403 too. Telling someone to widen their
    // token scope when the request never left the building is worse than
    // saying nothing.
    const results = await doctor(project({ sources: [source('s', new Error('HTTP 403 — Host not in allowlist: sentry.io'))] }))
    const detail = find(results, 's').detail?.join(' ') ?? ''
    expect(detail).toContain('network policy')
    expect(detail).not.toContain('write scope')
  })

  it('flattens a multi-line API body so the report stays aligned', async () => {
    const results = await doctor(project({ sources: [source('s', new Error('HTTP 401 from GET /x — {\n  "message": "Bad credentials"\n}'))] }))
    expect(find(results, 's').summary).not.toContain('\n')
  })
})

describe('doctor — reporting', () => {
  it('exits non-zero on a failure and says what to do', async () => {
    const results = await doctor(project({ sources: [source('s', new Error('HTTP 401'))] }))
    const { text, failed } = formatDoctorReport(results)
    expect(failed).toBe(true)
    expect(text).toContain('check(s) failed')
    expect(text).toContain('before `--live`')
  })

  it('a warning alone does not fail the run', async () => {
    const results = await doctor(project({ sources: [source('gmail', [])] }))
    const { text, failed } = formatDoctorReport(results)
    expect(failed).toBe(false)
    expect(text).toContain('warning(s) worth reading')
  })

  it('keeps checking after one source throws', async () => {
    const results = await doctor(
      project({ sources: [source('broken', new Error('HTTP 500')), source('healthy', [report('a', 'fp')])] }),
    )
    expect(find(results, 'broken').status).toBe('fail')
    expect(find(results, 'healthy').status).toBe('ok')
    expect(find(results, 'llm').status).toBe('ok')
  })
})

describe('doctor — reads what the run will actually read', () => {
  // The bug this guards: doctor called poll() and looked only at `reports`,
  // so a source holding a full standing window of signatures — exactly what an
  // investigation consumes — was reported as returning nothing. A check that
  // tells you your source is empty when it is not is worse than no check.
  const corpusOnly: Source = {
    name: 'glitchtip',
    poll: async () => ({ reports: [], cursor: 'c', corpus: [report('a', 'glitchtip:1'), report('b', 'glitchtip:2')] }),
  }
  const investigating = (overrides: Partial<RockyProjectConfig> = {}) =>
    project({ investigator: async () => '{"findings":[]}', match: {}, ...overrides })

  it('counts the standing window in investigation mode', async () => {
    const results = await doctor(investigating({ sources: [corpusOnly] }))
    expect(find(results, 'glitchtip')).toMatchObject({
      status: 'ok',
      summary: '2 log signature(s) in the window · 2 with signatures',
    })
  })

  it('counts only new reports in triage mode, where that is what runs', async () => {
    const results = await doctor(project({ sources: [corpusOnly] }))
    expect(find(results, 'glitchtip').summary).toContain('nothing to work with')
  })

  it('says so when an investigating source exposes no standing window at all', async () => {
    const results = await doctor(investigating({ sources: [source('gmail', [])] }))
    expect(find(results, 'gmail').detail?.join(' ')).toContain('no standing window')
  })

  it('explains missing signatures in the terms of the mode you are in', async () => {
    const inv = await doctor(investigating({ sources: [source('gmail', [report('a', null)])] }))
    expect(find(inv, 'gmail').detail?.join(' ')).toContain('re-file the same problem every cycle')

    const tri = await doctor(project({ sources: [source('gmail', [report('a', null)])] }))
    expect(find(tri, 'gmail').detail?.join(' ')).toContain('tier 1')
  })

  it('flags providers that will never be called in the mode you are in', async () => {
    const results = await doctor(investigating({ match: { llm: async () => 'x' }, analyst: async () => 'x' }))
    expect(find(results, 'analyst').status).toBe('warn')
    expect(find(results, 'match.llm').status).toBe('warn')
    expect(find(results, 'investigator').status).toBe('ok')
  })
})
