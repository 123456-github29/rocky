import { describe, expect, it } from 'vitest'
import { approve, deny, formatStatus, watch } from '../src/watch'
import type { WatchEvent } from '../src/watch'
import { emptyState, pruneTickets, TICKET_CAP } from '../src/state'
import type { RockyState, TicketProgress } from '../src/state'
import { defineConfig } from '../src/project'
import { assertGatedSink } from '../src/sinks/types'
import type { LabelChange, Sink, TicketResolution } from '../src/sinks/types'
import type { Notifier, NotifyMessage } from '../src/notify/types'
import type { Ticket } from '../src/types'

function ticket(id: string | number, overrides: Partial<Ticket> = {}): Ticket {
  return {
    id,
    title: `Bug ${String(id)}`,
    summary: 'something broke',
    fingerprint: null,
    state: 'open',
    link: `https://tracker/${String(id)}`,
    ...overrides,
  }
}

interface GateSink extends Sink {
  labelCalls: Array<{ ticketId: string | number; change: LabelChange }>
  comments: Array<{ ticketId: string | number; body: string }>
}

/**
 * A tracker in memory. `byLabel` is the whole approval mechanism: adding an id
 * to the approve label is exactly what a human does in the real tracker.
 */
function gateSink(options: {
  byLabel: Record<string, Ticket[]>
  resolutions?: Record<string, TicketResolution>
  failResolution?: boolean
}): GateSink {
  const labelCalls: GateSink['labelCalls'] = []
  const comments: GateSink['comments'] = []
  return {
    name: 'memory',
    labelCalls,
    comments,
    async listOpen() {
      return Object.values(options.byLabel).flat()
    },
    async create() {
      throw new Error('not used')
    },
    async annotate() {
      throw new Error('not used')
    },
    async listByLabel(label) {
      return [...(options.byLabel[label] ?? [])]
    },
    async setLabels(ticketId, change) {
      labelCalls.push({ ticketId, change })
    },
    async comment(ticketId, body) {
      comments.push({ ticketId, body })
    },
    async resolution(ticketId) {
      if (options.failResolution) throw new Error('tracker unreachable')
      return options.resolutions?.[String(ticketId)] ?? { closed: false, fix: null }
    },
  }
}

interface RecordingNotifier extends Notifier {
  sent: NotifyMessage[]
}

function recordingNotifier(options: { fail?: boolean; name?: string } = {}): RecordingNotifier {
  const sent: NotifyMessage[] = []
  return {
    name: options.name ?? 'recorder',
    sent,
    async send(message) {
      if (options.fail) throw new Error('telegram is down')
      sent.push(message)
    },
  }
}

function stateWith(tickets: Record<string, TicketProgress>): RockyState {
  return { ...emptyState(), tickets }
}

const AT = '2026-08-23T00:00:00.000Z'

describe('watch — asking for approval', () => {
  it('asks once per newly filed ticket and records it as awaiting', async () => {
    const notify = recordingNotifier()
    const sink = gateSink({ byLabel: { rocky: [ticket(1), ticket(2)], approved: [] } })
    const project = defineConfig({ sources: [{ name: 's', poll: async () => ({ reports: [], cursor: '' }) }], sink, notify })

    const first = await watch(project, emptyState(), { live: true })

    expect(first.summary).toMatchObject({ asked: 2, approved: 0, completed: 0, tracked: 2 })
    expect(notify.sent.map((m) => m.kind)).toEqual(['approval', 'approval'])
    expect(notify.sent[0]!.subject).toBe('Approve fix for #1: Bug 1')
    expect(notify.sent[0]!.body).toContain('approve #1')
    expect(first.state.tickets['1']).toMatchObject({ phase: 'awaiting', title: 'Bug 1' })

    // Second pass over the same tracker state must be silent.
    const second = await watch(project, first.state, { live: true })
    expect(second.summary.asked).toBe(0)
    expect(notify.sent).toHaveLength(2)
  })

  it('holds the phase when delivery fails, so the next pass asks again instead of losing the bug', async () => {
    const notify = recordingNotifier({ fail: true })
    const sink = gateSink({ byLabel: { rocky: [ticket(1)], approved: [] } })
    const events: WatchEvent[] = []
    const project = defineConfig({ sources: [{ name: 's', poll: async () => ({ reports: [], cursor: '' }) }], sink, notify })

    const { summary, state } = await watch(project, emptyState(), { live: true, log: (e) => events.push(e) })

    expect(summary.errors).toBe(1)
    expect(state.tickets['1']).toBeUndefined()
    expect(events.some((e) => e.type === 'notify-error' && e.message.includes('telegram is down'))).toBe(true)
  })

  it('dry-run computes phases but sends nothing', async () => {
    const notify = recordingNotifier()
    const sink = gateSink({ byLabel: { rocky: [ticket(1)], approved: [] } })
    const events: WatchEvent[] = []
    const project = defineConfig({ sources: [{ name: 's', poll: async () => ({ reports: [], cursor: '' }) }], sink, notify })

    const { summary } = await watch(project, emptyState(), { log: (e) => events.push(e) })

    expect(notify.sent).toHaveLength(0)
    expect(summary).toMatchObject({ asked: 1, live: false })
    expect(events.some((e) => e.type === 'phase' && e.to === 'awaiting' && e.live === false)).toBe(true)
  })

  it('emits the full message text in a dry run — the point of the dry run is reading it', async () => {
    const sink = gateSink({ byLabel: { rocky: [ticket(1)], approved: [] } })
    const events: WatchEvent[] = []
    const project = defineConfig({
      sources: [{ name: 's', poll: async () => ({ reports: [], cursor: '' }) }],
      sink,
      notify: recordingNotifier(),
    })

    await watch(project, emptyState(), { log: (e) => events.push(e) })

    const message = events.find((e) => e.type === 'message')
    expect(message).toMatchObject({ ticketId: '1', kind: 'approval', live: false })
    expect(message?.type === 'message' ? message.body : '').toContain('approve #1')
  })
})

describe('watch — the gate', () => {
  it('advances only tickets carrying the approve label', async () => {
    const notify = recordingNotifier()
    const sink = gateSink({ byLabel: { rocky: [ticket(1), ticket(2)], approved: [ticket(2)] } })
    const project = defineConfig({ sources: [{ name: 's', poll: async () => ({ reports: [], cursor: '' }) }], sink, notify })

    const { summary, state } = await watch(
      project,
      stateWith({
        '1': { phase: 'awaiting', title: 'Bug 1', link: '', changedAt: AT },
        '2': { phase: 'awaiting', title: 'Bug 2', link: '', changedAt: AT },
      }),
      { live: true },
    )

    expect(summary.approved).toBe(1)
    expect(state.tickets['1']!.phase).toBe('awaiting')
    expect(state.tickets['2']!.phase).toBe('approved')
    expect(notify.sent.map((m) => m.kind)).toEqual(['started'])
  })

  it('respects a custom approve label', async () => {
    const notify = recordingNotifier()
    const sink = gateSink({ byLabel: { rocky: [ticket(1)], 'ship-it': [ticket(1)] } })
    const project = defineConfig({
      sources: [{ name: 's', poll: async () => ({ reports: [], cursor: '' }) }],
      sink,
      notify,
      approveLabel: 'ship-it',
    })

    const { state } = await watch(project, emptyState(), { live: true })

    expect(state.tickets['1']!.phase).toBe('approved')
    expect(notify.sent[0]!.body).toContain('"ship-it" label')
  })

  it('fires onApprove once, and an exception there does not stall the ticket', async () => {
    const seen: Array<string | number> = []
    const sink = gateSink({ byLabel: { rocky: [ticket(1), ticket(2)], approved: [ticket(1), ticket(2)] } })
    const events: WatchEvent[] = []
    const project = defineConfig({
      sources: [{ name: 's', poll: async () => ({ reports: [], cursor: '' }) }],
      sink,
      notify: recordingNotifier(),
      onApprove: (t) => {
        seen.push(t.id)
        if (t.id === 2) throw new Error('workflow_dispatch rejected')
      },
    })

    const { summary, state } = await watch(project, emptyState(), { live: true })

    // The hook gets the live ticket, so its id keeps the tracker's own type —
    // a workflow_dispatch call needs the real issue number, not the ledger key.
    expect(seen).toEqual([1, 2])
    expect(state.tickets['2']!.phase).toBe('approved')
    expect(summary.errors).toBe(1)
    expect(events).toHaveLength(0)
  })

  it('does not call onApprove in a dry run', async () => {
    let called = 0
    const sink = gateSink({ byLabel: { rocky: [ticket(1)], approved: [ticket(1)] } })
    const project = defineConfig({
      sources: [{ name: 's', poll: async () => ({ reports: [], cursor: '' }) }],
      sink,
      onApprove: () => {
        called++
      },
    })

    await watch(project, emptyState(), {})

    expect(called).toBe(0)
  })
})

describe('watch — completion', () => {
  it('reports a closed ticket with the change that closed it, then goes quiet', async () => {
    const notify = recordingNotifier()
    // Closed tickets leave the open funnel — the ledger is what keeps rocky looking.
    const sink = gateSink({
      byLabel: { rocky: [], approved: [] },
      resolutions: { '9': { closed: true, fix: 'https://github.com/o/r/pull/12' } },
    })
    const project = defineConfig({ sources: [{ name: 's', poll: async () => ({ reports: [], cursor: '' }) }], sink, notify })
    const before = stateWith({ '9': { phase: 'approved', title: 'Voice crash', link: 'https://tracker/9', changedAt: AT } })

    const { summary, state } = await watch(project, before, { live: true })

    expect(summary).toMatchObject({ completed: 1, tracked: 0 })
    expect(state.tickets['9']!.phase).toBe('done')
    expect(notify.sent[0]).toMatchObject({ kind: 'completed', subject: 'Done — #9: Voice crash' })
    expect(notify.sent[0]!.body).toContain('https://github.com/o/r/pull/12')

    const again = await watch(project, state, { live: true })
    expect(again.summary.completed).toBe(0)
    expect(notify.sent).toHaveLength(1)
  })

  it('says so when the tracker names no linked change rather than implying one', async () => {
    const notify = recordingNotifier()
    const sink = gateSink({ byLabel: { rocky: [], approved: [] }, resolutions: { '9': { closed: true, fix: null } } })
    const project = defineConfig({ sources: [{ name: 's', poll: async () => ({ reports: [], cursor: '' }) }], sink, notify })

    await watch(project, stateWith({ '9': { phase: 'approved', title: 'B', link: '', changedAt: AT } }), { live: true })

    expect(notify.sent[0]!.body).toContain('did not name a linked change')
  })

  it('keeps the ticket approved when the completion notice cannot be delivered', async () => {
    const sink = gateSink({ byLabel: { rocky: [], approved: [] }, resolutions: { '9': { closed: true, fix: null } } })
    const project = defineConfig({
      sources: [{ name: 's', poll: async () => ({ reports: [], cursor: '' }) }],
      sink,
      notify: recordingNotifier({ fail: true }),
    })

    const { state } = await watch(project, stateWith({ '9': { phase: 'approved', title: 'B', link: '', changedAt: AT } }), {
      live: true,
    })

    expect(state.tickets['9']!.phase).toBe('approved')
  })

  it('holds the phase and logs when the resolution lookup fails', async () => {
    const sink = gateSink({ byLabel: { rocky: [], approved: [] }, failResolution: true })
    const events: WatchEvent[] = []
    const project = defineConfig({ sources: [{ name: 's', poll: async () => ({ reports: [], cursor: '' }) }], sink })

    const { summary, state } = await watch(project, stateWith({ '9': { phase: 'approved', title: 'B', link: '', changedAt: AT } }), {
      live: true,
      log: (e) => events.push(e),
    })

    expect(summary.errors).toBe(1)
    expect(state.tickets['9']!.phase).toBe('approved')
    expect(events.some((e) => e.type === 'watch-error' && e.message.includes('tracker unreachable'))).toBe(true)
  })
})

describe('watch — leaving the funnel', () => {
  it('marks a ticket dismissed, silently, when it loses the label without being approved', async () => {
    const notify = recordingNotifier()
    const sink = gateSink({ byLabel: { rocky: [], approved: [] } })
    const project = defineConfig({ sources: [{ name: 's', poll: async () => ({ reports: [], cursor: '' }) }], sink, notify })

    const { summary, state } = await watch(project, stateWith({ '5': { phase: 'awaiting', title: 'B', link: '', changedAt: AT } }), {
      live: true,
    })

    expect(summary).toMatchObject({ dismissed: 1, tracked: 0 })
    expect(state.tickets['5']!.phase).toBe('dismissed')
    expect(notify.sent).toHaveLength(0)
  })

  it('sends every message to every configured notifier', async () => {
    const a = recordingNotifier({ name: 'telegram' })
    const b = recordingNotifier({ name: 'slack' })
    const sink = gateSink({ byLabel: { rocky: [ticket(1)], approved: [] } })
    const project = defineConfig({
      sources: [{ name: 's', poll: async () => ({ reports: [], cursor: '' }) }],
      sink,
      notify: [a, b],
    })

    await watch(project, emptyState(), { live: true })

    expect(a.sent).toHaveLength(1)
    expect(b.sent).toHaveLength(1)
  })
})

describe('approve / deny', () => {
  it('approve adds the approve label and leaves an audit comment', async () => {
    const sink = gateSink({ byLabel: {} })
    const project = defineConfig({ sources: [{ name: 's', poll: async () => ({ reports: [], cursor: '' }) }], sink })

    await approve(project, 42, { by: 'rushil' })

    expect(sink.labelCalls).toEqual([{ ticketId: 42, change: { add: ['approved'] } }])
    expect(sink.comments[0]!.body).toContain('Approved by rushil')
  })

  it('deny removes the funnel label and never closes the ticket', async () => {
    const sink = gateSink({ byLabel: {} })
    const project = defineConfig({
      sources: [{ name: 's', poll: async () => ({ reports: [], cursor: '' }) }],
      sink,
      labels: ['triage-me', 'bug'],
    })

    await deny(project, 42, { by: 'rushil', reason: 'works as designed' })

    expect(sink.labelCalls).toEqual([{ ticketId: 42, change: { remove: ['triage-me'] } }])
    expect(sink.comments[0]!.body).toContain('works as designed')
    expect(sink.comments[0]!.body).toContain('ticket stays open')
  })

  it('names the missing methods when a sink cannot run the loop', () => {
    const bare: Sink = {
      name: 'bare',
      listOpen: async () => [],
      create: async () => ticket(1),
      annotate: async () => undefined,
    }
    expect(() => assertGatedSink(bare, 'watch')).toThrow(/listByLabel, setLabels, resolution/)
  })
})

describe('state — the ticket ledger', () => {
  it('never prunes tickets still in flight', () => {
    const tickets: Record<string, TicketProgress> = {}
    for (let i = 0; i < TICKET_CAP + 50; i++) {
      tickets[`done-${i}`] = { phase: 'done', title: 't', link: '', changedAt: `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z` }
    }
    tickets['live-1'] = { phase: 'awaiting', title: 't', link: '', changedAt: '2020-01-01T00:00:00.000Z' }
    tickets['live-2'] = { phase: 'approved', title: 't', link: '', changedAt: '2020-01-01T00:00:00.000Z' }

    const pruned = pruneTickets(tickets)

    expect(Object.keys(pruned)).toHaveLength(TICKET_CAP)
    expect(pruned['live-1']).toBeDefined()
    expect(pruned['live-2']).toBeDefined()
    // Oldest finished entries are the ones that go.
    expect(pruned['done-0']).toBeUndefined()
  })

  it('formats status newest first', () => {
    const text = formatStatus(
      stateWith({
        '1': { phase: 'awaiting', title: 'Older', link: '', changedAt: '2026-01-01T00:00:00.000Z' },
        '2': { phase: 'done', title: 'Newer', link: '', changedAt: '2026-02-01T00:00:00.000Z' },
      }),
    )
    expect(text.split('\n')[0]).toContain('Newer')
  })
})
