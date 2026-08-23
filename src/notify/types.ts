import type { Ticket } from '../types'

/**
 * Why rocky is interrupting you.
 *
 * - `approval` — a new deduplicated bug is filed and needs a yes/no before
 *   anything touches the codebase. This is the only message that asks for
 *   something; the rest are progress.
 * - `started`  — you approved it, the runner has the gate open.
 * - `completed`— the fix landed and the ticket closed.
 * - `failed`   — rocky could not carry a ticket forward and stopped tracking it.
 */
export type NotifyKind = 'approval' | 'started' | 'completed' | 'failed'

export interface NotifyMessage {
  kind: NotifyKind
  /** One line. Becomes an email subject, a Telegram bold header, a Slack fallback. */
  subject: string
  /** The rest. Light markdown; notifiers that cannot render it send it as plain text. */
  body: string
  ticket: Ticket
}

/**
 * Where approval requests and completion notices go.
 *
 * Deliberately one method: rocky decides *what* to say, the notifier only
 * decides *how it travels*. That keeps message wording identical whether it
 * reaches you over Telegram, Slack, or a terminal, and means a new channel is
 * one small adapter rather than a fork of the message text.
 *
 * A notifier that throws does not fail the run — {@link watch} logs the error
 * and leaves the ticket in its current phase, so the next pass retries the
 * delivery rather than silently skipping a bug you never heard about.
 */
export interface Notifier {
  name: string
  send(message: NotifyMessage): Promise<void>
}
