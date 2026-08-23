import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { RockyProjectConfig } from './project'
import type { RockyState, TicketPhase } from './state'
import { loadState } from './state'
import { approve, deny } from './watch'
import { assertGatedSink } from './sinks/types'
import { DASHBOARD_HTML } from './dashboard'

/** One row in the dashboard: what the tracker says now, joined with how far rocky has got. */
export interface BoardTicket {
  id: string
  title: string
  summary: string
  link: string
  phase: TicketPhase
  changedAt: string | null
}

export interface BoardData {
  tickets: BoardTicket[]
  labels: { funnel: string; approve: string }
  /** Set when the tracker could not be reached — the page says so instead of showing an empty board. */
  error?: string
}

export interface ServeOptions {
  port?: number
  /** Bind address. Defaults to 127.0.0.1 — this dashboard approves code changes; it is not a public page. */
  host?: string
  /** Optional shared secret, required as `?token=` or a Bearer header when set. */
  token?: string
  statePath: string
}

/**
 * Read the current board: everything open in rocky's funnel, plus anything the
 * ledger is still following. The tracker wins on title and link (a ticket can
 * be renamed), the ledger supplies the phase.
 */
export async function readBoard(project: RockyProjectConfig, state: RockyState): Promise<BoardData> {
  const sink = project.sink
  assertGatedSink(sink, 'serve')
  const funnel = (project.labels ?? ['rocky'])[0]!
  const approveLabel = project.approveLabel ?? 'approved'
  const labels = { funnel, approve: approveLabel }

  let open: Awaited<ReturnType<typeof sink.listByLabel>>
  let approved: Set<string>
  try {
    open = await sink.listByLabel(funnel)
    approved = new Set((await sink.listByLabel(approveLabel)).map((t) => String(t.id)))
  } catch (error) {
    return { tickets: [], labels, error: error instanceof Error ? error.message : String(error) }
  }

  const tickets: BoardTicket[] = open.map((ticket) => {
    const id = String(ticket.id)
    const tracked = state.tickets[id]
    // The label is the authority: a ticket carrying the approve label is
    // approved even if rocky's ledger has not caught up with it yet.
    const phase: TicketPhase = approved.has(id) ? 'approved' : (tracked?.phase ?? 'awaiting')
    return {
      id,
      title: ticket.title,
      summary: ticket.summary,
      link: ticket.link,
      phase,
      changedAt: tracked?.changedAt ?? null,
    }
  })

  // Tickets the ledger still remembers that have left the open list — closed,
  // denied, or fixed. They are the history half of the board.
  for (const [id, progress] of Object.entries(state.tickets)) {
    if (tickets.some((t) => t.id === id)) continue
    tickets.push({
      id,
      title: progress.title,
      summary: '',
      link: progress.link,
      phase: progress.phase,
      changedAt: progress.changedAt,
    })
  }

  return { tickets, labels }
}

/**
 * A local dashboard for the approval gate: see what is waiting, read it, click
 * approve or deny.
 *
 * Deliberately one file with no build step and no runtime dependency — the
 * page is served as a string and talks to a small JSON API. If you want a real
 * React app instead, point it at `GET /api/board` and the two POST routes;
 * they are the whole contract.
 *
 * Approving here does exactly what `rocky approve` does — it adds the label in
 * the tracker. It does not touch the state file, so this dashboard, the CLI,
 * a chat reply, and the tracker's own UI can all be used interchangeably.
 */
export function serve(project: RockyProjectConfig, options: ServeOptions): Server {
  const { port = 4711, host = '127.0.0.1', token, statePath } = options
  assertGatedSink(project.sink, 'serve')

  const authorized = (request: IncomingMessage, url: URL): boolean => {
    if (!token) return true
    const header = request.headers.authorization ?? ''
    const presented = header.startsWith('Bearer ') ? header.slice(7) : (url.searchParams.get('token') ?? '')
    const a = Buffer.from(presented)
    const b = Buffer.from(token)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  const json = (response: ServerResponse, status: number, body: unknown): void => {
    const payload = JSON.stringify(body)
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    response.end(payload)
  }

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? host}`)

      if (!authorized(request, url)) return json(response, 401, { error: 'unauthorized' })

      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(DASHBOARD_HTML)
        return
      }

      if (request.method === 'GET' && url.pathname === '/api/board') {
        // Re-read state each request: `rocky watch` writes it from another
        // process, and a dashboard showing a snapshot from startup is a lie.
        return json(response, 200, await readBoard(project, loadState(statePath)))
      }

      const decision = /^\/api\/tickets\/(.+)\/(approve|deny)$/.exec(url.pathname)
      if (request.method === 'POST' && decision) {
        const [, rawId, action] = decision
        const id = decodeURIComponent(rawId!)
        const body = await readJsonBody(request)
        const by = typeof body['by'] === 'string' && body['by'].trim() !== '' ? body['by'] : 'dashboard'
        try {
          if (action === 'approve') await approve(project, id, { by })
          else await deny(project, id, { by, ...(typeof body['reason'] === 'string' ? { reason: body['reason'] } : {}) })
          return json(response, 200, { ok: true, id, action })
        } catch (error) {
          return json(response, 502, { error: error instanceof Error ? error.message : String(error) })
        }
      }

      json(response, 404, { error: 'not found' })
    })().catch((error: unknown) => {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  })

  server.listen(port, host)
  return server
}

const MAX_BODY = 64 * 1024

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
