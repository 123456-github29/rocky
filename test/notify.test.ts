import { EventEmitter } from 'node:events'
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hermesNotifier } from '../src/notify/hermes'
import { consoleNotifier } from '../src/notify/console'
import { approvalMessage, completedMessage, ticketRef } from '../src/notify/format'
import type { Ticket } from '../src/types'

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 42,
    title: 'Voice pipeline crashes on empty transcript',
    summary: 'TypeError: cannot read length of undefined',
    fingerprint: null,
    state: 'open',
    link: 'https://github.com/o/r/issues/42',
    ...overrides,
  }
}

/** A fake `hermes send` process: records the argv and what got piped in. */
function fakeSpawn(result: { code?: number; stderr?: string; error?: Error } = {}) {
  const calls: Array<{ bin: string; args: string[]; stdin: string }> = []
  const spawn = ((bin: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: { end: (data: string) => void; on: (e: string, f: () => void) => void }
      stderr: EventEmitter
    }
    const stderr = new EventEmitter()
    child.stderr = stderr
    child.stdin = {
      on: () => undefined,
      end: (data: string) => {
        calls.push({ bin, args, stdin: data })
        setImmediate(() => {
          if (result.error) return child.emit('error', result.error)
          if (result.stderr) stderr.emit('data', result.stderr)
          child.emit('close', result.code ?? 0)
        })
      },
    }
    return child
  }) as unknown as typeof import('node:child_process').spawn
  return { spawn, calls }
}

describe('message wording', () => {
  it('the approval request carries the decision, both answers, and the gate label', () => {
    const message = approvalMessage(ticket(), { approveLabel: 'approved' })
    expect(message.subject).toBe('Approve fix for #42: Voice pipeline crashes on empty transcript')
    expect(message.body).toContain('approve #42')
    expect(message.body).toContain('deny #42')
    expect(message.body).toContain('"approved" label')
    expect(message.body).toContain('https://github.com/o/r/issues/42')
  })

  it('truncates a long body rather than pushing the instructions off the screen', () => {
    const message = approvalMessage(ticket({ summary: 'x'.repeat(5000) }), { approveLabel: 'approved' })
    expect(message.body.length).toBeLessThan(1200)
    expect(message.body).toContain('approve #42')
  })

  it('renders tracker-native references', () => {
    expect(ticketRef(ticket({ id: 42 }))).toBe('#42')
    expect(ticketRef(ticket({ id: '42' }))).toBe('#42')
    expect(ticketRef(ticket({ id: 'ENG-123' }))).toBe('ENG-123')
  })

  it('completion names the fix when there is one', () => {
    expect(completedMessage(ticket(), { fix: 'https://github.com/o/r/pull/7' }).body).toContain('/pull/7')
  })
})

describe('hermesNotifier — cli transport', () => {
  it('pipes the body to `hermes send` with the target and subject', async () => {
    const { spawn, calls } = fakeSpawn()
    const notifier = hermesNotifier({ to: 'telegram:-100123', spawn })

    await notifier.send(approvalMessage(ticket(), { approveLabel: 'approved' }))

    expect(calls).toHaveLength(1)
    expect(calls[0]!.bin).toBe('hermes')
    expect(calls[0]!.args).toEqual([
      'send',
      '--to',
      'telegram:-100123',
      '--subject',
      'Approve fix for #42: Voice pipeline crashes on empty transcript',
      '--quiet',
      '--file',
      '-',
    ])
    expect(calls[0]!.stdin).toContain('approve #42')
    expect(notifier.name).toBe('hermes:telegram:-100123')
  })

  it('reads exit code 2 as a config problem and points at `hermes send --list`', async () => {
    const { spawn } = fakeSpawn({ code: 2, stderr: 'unknown target' })
    const notifier = hermesNotifier({ to: 'telegram', spawn })
    await expect(notifier.send(completedMessage(ticket()))).rejects.toThrow(/hermes send --list.*unknown target/s)
  })

  it('reads exit code 1 as a delivery failure', async () => {
    const { spawn } = fakeSpawn({ code: 1 })
    const notifier = hermesNotifier({ to: 'slack:#eng', spawn })
    await expect(notifier.send(completedMessage(ticket()))).rejects.toThrow(/delivery to "slack:#eng" failed/)
  })

  it('explains a missing binary instead of leaking ENOENT', async () => {
    const { spawn } = fakeSpawn({ error: new Error('spawn hermes ENOENT') })
    const notifier = hermesNotifier({ to: 'telegram', spawn })
    await expect(notifier.send(completedMessage(ticket()))).rejects.toThrow(/is not on PATH/)
  })

  it('rejects an empty target at construction, not at send time', () => {
    expect(() => hermesNotifier({ to: '' })).toThrow(/"to" is required/)
  })
})

describe('hermesNotifier — webhook transport', () => {
  it('signs with generic HMAC V2 over "<timestamp>.<body>"', async () => {
    let seen: { url: string; init: RequestInit } | null = null
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(input), init: init! }
      return new Response('{}', { status: 200 })
    }) as typeof globalThis.fetch

    const notifier = hermesNotifier({
      transport: 'webhook',
      url: 'http://localhost:8644/webhooks/rocky',
      secret: 'topsecret',
      fetch: fetchImpl,
      now: () => 1_800_000_000_000,
    })
    await notifier.send(approvalMessage(ticket(), { approveLabel: 'approved' }))

    const call = seen as unknown as { url: string; init: RequestInit }
    expect(call.url).toBe('http://localhost:8644/webhooks/rocky')
    const headers = call.init.headers as Record<string, string>
    expect(headers['x-webhook-timestamp']).toBe('1800000000')
    expect(headers['x-webhook-signature-v2']).toBe(
      createHmac('sha256', 'topsecret').update(`1800000000.${String(call.init.body)}`).digest('hex'),
    )
    // No V1 header: it signs the body alone and replays forever.
    expect(headers['x-webhook-signature']).toBeUndefined()
  })

  it('sends a flat payload a route template can address by dot notation', async () => {
    let body = ''
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      body = String(init?.body)
      return new Response('{}', { status: 200 })
    }) as typeof globalThis.fetch

    const notifier = hermesNotifier({
      transport: 'webhook',
      url: 'http://h/webhooks/rocky',
      secret: 's',
      fetch: fetchImpl,
    })
    await notifier.send(approvalMessage(ticket(), { approveLabel: 'approved' }))

    const payload = JSON.parse(body) as Record<string, unknown>
    expect(payload['event_type']).toBe('rocky.approval')
    expect(payload['subject']).toContain('Approve fix for #42')
    expect(payload['ticket']).toMatchObject({ id: 42, link: 'https://github.com/o/r/issues/42' })
  })

  it('surfaces a non-2xx with the gateway response', async () => {
    const fetchImpl = (async () => new Response('no route named rocky', { status: 404 })) as typeof globalThis.fetch
    const notifier = hermesNotifier({ transport: 'webhook', url: 'http://h/webhooks/rocky', secret: 's', fetch: fetchImpl })
    await expect(notifier.send(completedMessage(ticket()))).rejects.toThrow(/HTTP 404.*no route named rocky/s)
  })

  it('requires url and secret up front', () => {
    expect(() => hermesNotifier({ transport: 'webhook', url: '', secret: 's' })).toThrow(/"url" is required/)
    expect(() => hermesNotifier({ transport: 'webhook', url: 'http://h', secret: '' })).toThrow(/"secret" is required/)
  })
})

describe('consoleNotifier', () => {
  it('prints the message it would have delivered', async () => {
    const lines: string[] = []
    await consoleNotifier({ write: (l) => lines.push(l) }).send(approvalMessage(ticket(), { approveLabel: 'approved' }))
    expect(lines.join('\n')).toContain('APPROVAL')
    expect(lines.join('\n')).toContain('approve #42')
  })
})
