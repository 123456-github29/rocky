import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readBoard, serve } from '../src/serve'
import { DASHBOARD_HTML } from '../src/dashboard'
import { emptyState, saveState } from '../src/state'
import type { RockyState } from '../src/state'
import { defineConfig } from '../src/project'
import type { LabelChange, Sink } from '../src/sinks/types'
import type { Ticket } from '../src/types'

function ticket(id: string | number, overrides: Partial<Ticket> = {}): Ticket {
  return {
    id,
    title: `Bug ${String(id)}`,
    summary: 'boom',
    fingerprint: null,
    state: 'open',
    link: `https://tracker/${String(id)}`,
    ...overrides,
  }
}

function boardSink(byLabel: Record<string, Ticket[]>, options: { fail?: boolean } = {}) {
  const labelCalls: Array<{ ticketId: string | number; change: LabelChange }> = []
  const comments: Array<{ ticketId: string | number; body: string }> = []
  const sink: Sink = {
    name: 'memory',
    listOpen: async () => Object.values(byLabel).flat(),
    create: async () => {
      throw new Error('unused')
    },
    annotate: async () => undefined,
    listByLabel: async (label) => {
      if (options.fail) throw new Error('tracker unreachable')
      return [...(byLabel[label] ?? [])]
    },
    setLabels: async (ticketId, change) => {
      labelCalls.push({ ticketId, change })
    },
    comment: async (ticketId, body) => {
      comments.push({ ticketId, body })
    },
    resolution: async () => ({ closed: false, fix: null }),
  }
  return { sink, labelCalls, comments }
}

function project(sink: Sink) {
  return defineConfig({ sources: [{ name: 's', poll: async () => ({ reports: [], cursor: '' }) }], sink })
}

const AT = '2026-08-23T00:00:00.000Z'
const servers: Server[] = []

function start(config: ReturnType<typeof project>, state: RockyState, options: { token?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rocky-serve-'))
  const statePath = join(dir, 'state.json')
  saveState(statePath, state)
  const server = serve(config, { port: 0, host: '127.0.0.1', statePath, ...options })
  servers.push(server)
  return new Promise<{ base: string; statePath: string }>((resolve) => {
    server.once('listening', () => {
      const { port } = server.address() as AddressInfo
      resolve({ base: `http://127.0.0.1:${port}`, statePath })
    })
  })
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

describe('readBoard', () => {
  it('joins the tracker with the ledger, and lets the label win over a stale phase', async () => {
    const { sink } = boardSink({ rocky: [ticket(1), ticket(2)], approved: [ticket(2)] })
    const state: RockyState = {
      ...emptyState(),
      // The ledger still says awaiting; the tracker says approved. The tracker is right.
      tickets: { '2': { phase: 'awaiting', title: 'stale', link: '', changedAt: AT } },
    }

    const board = await readBoard(project(sink), state)

    expect(board.labels).toEqual({ funnel: 'rocky', approve: 'approved' })
    expect(board.tickets.find((t) => t.id === '1')).toMatchObject({ phase: 'awaiting', title: 'Bug 1' })
    expect(board.tickets.find((t) => t.id === '2')).toMatchObject({ phase: 'approved', title: 'Bug 2' })
  })

  it('keeps finished tickets that have left the open list', async () => {
    const { sink } = boardSink({ rocky: [], approved: [] })
    const state: RockyState = {
      ...emptyState(),
      tickets: { '9': { phase: 'done', title: 'Fixed thing', link: 'https://tracker/9', changedAt: AT } },
    }

    const board = await readBoard(project(sink), state)

    expect(board.tickets).toHaveLength(1)
    expect(board.tickets[0]).toMatchObject({ id: '9', phase: 'done', title: 'Fixed thing' })
  })

  it('reports a tracker outage instead of rendering an empty board', async () => {
    const { sink } = boardSink({}, { fail: true })

    const board = await readBoard(project(sink), emptyState())

    expect(board.error).toContain('tracker unreachable')
    expect(board.tickets).toEqual([])
  })
})

describe('serve', () => {
  it('serves the dashboard and the board', async () => {
    const { sink } = boardSink({ rocky: [ticket(1)], approved: [] })
    const { base } = await start(project(sink), emptyState())

    const page = await fetch(`${base}/`)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(await page.text()).toBe(DASHBOARD_HTML)

    const board = (await (await fetch(`${base}/api/board`)).json()) as { tickets: Array<{ id: string }> }
    expect(board.tickets.map((t) => t.id)).toEqual(['1'])
  })

  it('approve and deny go to the tracker, exactly as the CLI would', async () => {
    const { sink, labelCalls, comments } = boardSink({ rocky: [ticket(1), ticket(2)], approved: [] })
    const { base } = await start(project(sink), emptyState())

    const approved = await fetch(`${base}/api/tickets/1/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ by: 'rushil' }),
    })
    expect(approved.status).toBe(200)

    await fetch(`${base}/api/tickets/2/deny`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ by: 'rushil', reason: 'not a bug' }),
    })

    expect(labelCalls).toEqual([
      { ticketId: '1', change: { add: ['approved'] } },
      { ticketId: '2', change: { remove: ['rocky'] } },
    ])
    expect(comments[0]!.body).toContain('Approved by rushil')
    expect(comments[1]!.body).toContain('not a bug')
  })

  it('re-reads the state file per request, so another process writing it shows up', async () => {
    const { sink } = boardSink({ rocky: [], approved: [] })
    const { base, statePath } = await start(project(sink), emptyState())

    const before = (await (await fetch(`${base}/api/board`)).json()) as { tickets: unknown[] }
    expect(before.tickets).toHaveLength(0)

    // `rocky watch --live` in another process.
    saveState(statePath, {
      ...emptyState(),
      tickets: { '9': { phase: 'done', title: 'Landed', link: '', changedAt: AT } },
    })

    const after = (await (await fetch(`${base}/api/board`)).json()) as { tickets: Array<{ id: string }> }
    expect(after.tickets.map((t) => t.id)).toEqual(['9'])
  })

  it('reports a tracker failure on a decision as 502, not a silent success', async () => {
    const { sink } = boardSink({ rocky: [ticket(1)], approved: [] })
    sink.setLabels = async () => {
      throw new Error('403 from github')
    }
    const { base } = await start(project(sink), emptyState())

    const response = await fetch(`${base}/api/tickets/1/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })

    expect(response.status).toBe(502)
    expect(((await response.json()) as { error: string }).error).toContain('403 from github')
  })

  it('404s an unknown route', async () => {
    const { sink } = boardSink({ rocky: [], approved: [] })
    const { base } = await start(project(sink), emptyState())
    expect((await fetch(`${base}/api/nope`)).status).toBe(404)
  })

  describe('with a token', () => {
    it('rejects every route without it, and accepts either presentation', async () => {
      const { sink, labelCalls } = boardSink({ rocky: [ticket(1)], approved: [] })
      const { base } = await start(project(sink), emptyState(), { token: 's3cret' })

      expect((await fetch(`${base}/api/board`)).status).toBe(401)
      expect((await fetch(`${base}/`)).status).toBe(401)
      expect((await fetch(`${base}/api/board?token=wrong`)).status).toBe(401)
      // A prefix must not pass: the comparison is length-checked before it is timing-safe.
      expect((await fetch(`${base}/api/board?token=s3cre`)).status).toBe(401)

      expect((await fetch(`${base}/api/board?token=s3cret`)).status).toBe(200)
      expect((await fetch(`${base}/api/board`, { headers: { authorization: 'Bearer s3cret' } })).status).toBe(200)

      expect((await fetch(`${base}/api/tickets/1/approve`, { method: 'POST' })).status).toBe(401)
      expect(labelCalls).toHaveLength(0)
    })
  })
})

describe('dashboard page', () => {
  it('is self-contained: no external scripts, styles, or fonts', () => {
    expect(DASHBOARD_HTML).not.toMatch(/<script[^>]+src=/i)
    expect(DASHBOARD_HTML).not.toMatch(/<link[^>]+href=/i)
    expect(DASHBOARD_HTML).not.toMatch(/https?:\/\/(?!tracker)/i)
  })

  it('never writes ticket text as markup', () => {
    // Ticket titles and bodies are quoted from error trackers and other
    // people's emails. innerHTML anywhere in this page is a vulnerability.
    expect(DASHBOARD_HTML).not.toContain('innerHTML')
    expect(DASHBOARD_HTML).not.toContain('outerHTML')
    expect(DASHBOARD_HTML).not.toContain('insertAdjacentHTML')
    expect(DASHBOARD_HTML).not.toContain('document.write')
  })
})

describe('serve — cross-site writes', () => {
  // The buttons on this page authorize an agent to change a codebase. A plain
  // HTML form POST is a "simple request": browsers send it cross-origin with
  // no preflight, so without a guard any site a viewer visits can approve.
  it('refuses the exact shape a form on another site submits', async () => {
    const { sink, labelCalls } = boardSink({ rocky: [ticket(1)], approved: [] })
    const { base } = await start(project(sink), emptyState())

    const response = await fetch(`${base}/api/tickets/1/approve`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8', origin: 'https://evil.example' },
      body: 'x',
    })

    expect(response.status).toBe(403)
    expect(labelCalls).toHaveLength(0)
  })

  it('refuses a mismatched Origin even with a JSON content-type', async () => {
    const { sink, labelCalls } = boardSink({ rocky: [ticket(1)], approved: [] })
    const { base } = await start(project(sink), emptyState())

    const response = await fetch(`${base}/api/tickets/1/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: '{}',
    })

    expect(response.status).toBe(403)
    expect(((await response.json()) as { error: string }).error).toContain('cross-origin')
    expect(labelCalls).toHaveLength(0)
  })

  it('refuses a form content-type from no origin at all', async () => {
    const { sink, labelCalls } = boardSink({ rocky: [ticket(1)], approved: [] })
    const { base } = await start(project(sink), emptyState())

    const response = await fetch(`${base}/api/tickets/1/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=b',
    })

    expect(response.status).toBe(403)
    expect(labelCalls).toHaveLength(0)
  })

  it('still allows the dashboard itself, whose Origin matches', async () => {
    const { sink, labelCalls } = boardSink({ rocky: [ticket(1)], approved: [] })
    const { base } = await start(project(sink), emptyState())

    const response = await fetch(`${base}/api/tickets/1/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ by: 'dashboard' }),
    })

    expect(response.status).toBe(200)
    expect(labelCalls).toHaveLength(1)
  })

  it('does not let a ticket id contain a path separator', async () => {
    const { sink, labelCalls } = boardSink({ rocky: [], approved: [] })
    const { base } = await start(project(sink), emptyState())

    const response = await fetch(`${base}/api/tickets/1/../../evil/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })

    expect(response.status).toBe(404)
    expect(labelCalls).toHaveLength(0)
  })
})
