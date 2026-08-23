import type { Ticket } from '../types'
import type { NotifyMessage } from './types'

const MAX_SUMMARY = 600

/** Trim a ticket body down to something readable on a phone. */
function excerpt(summary: string): string {
  const text = summary.trim()
  if (text === '') return '(no description)'
  return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY).trimEnd()}…` : text
}

/**
 * `#42` on GitHub, `ENG-123` on Linear — whatever the tracker calls it.
 *
 * Keyed on the shape of the id, not its JavaScript type: ids arrive as numbers
 * from the sink but as strings once they have been through the state ledger,
 * and the same ticket must read the same way in the approval message and in
 * the completion message that follows it.
 */
export function ticketRef(ticket: Ticket): string {
  const id = String(ticket.id)
  return /^\d+$/.test(id) ? `#${id}` : id
}

/**
 * The one message that asks for something. It has to carry enough for a
 * yes/no decision without opening the tracker — what broke, how to say yes,
 * how to say no — because the whole point of the gate is that it gets answered
 * from wherever you are.
 */
export function approvalMessage(ticket: Ticket, options: { approveLabel: string }): NotifyMessage {
  const ref = ticketRef(ticket)
  return {
    kind: 'approval',
    subject: `Approve fix for ${ref}: ${ticket.title}`,
    body: [
      `**${ticket.title}**`,
      '',
      excerpt(ticket.summary),
      '',
      ticket.link ? `Ticket: ${ticket.link}` : `Ticket: ${ref}`,
      '',
      `Reply **approve ${ref}** to let the coding agent start, or **deny ${ref}** to drop it.`,
      `(Approving adds the "${options.approveLabel}" label — you can also just add it in the tracker.)`,
    ].join('\n'),
    ticket,
  }
}

/** Sent once, when the gate opens. Confirms the approval was actually recorded. */
export function startedMessage(ticket: Ticket): NotifyMessage {
  const ref = ticketRef(ticket)
  return {
    kind: 'started',
    subject: `Working on ${ref}: ${ticket.title}`,
    body: [
      `Approved. The coding agent has the gate open on ${ref}.`,
      '',
      ticket.link ? `Ticket: ${ticket.link}` : '',
      "You'll get one more message when it closes.",
    ]
      .filter((line) => line !== '')
      .join('\n'),
    ticket,
  }
}

/** The last message for a ticket. `fix` is the change that closed it, when the tracker names one. */
export function completedMessage(ticket: Ticket, options: { fix?: string | null } = {}): NotifyMessage {
  const ref = ticketRef(ticket)
  return {
    kind: 'completed',
    subject: `Done — ${ref}: ${ticket.title}`,
    body: [
      `${ref} is closed.`,
      options.fix ? `Fix: ${options.fix}` : 'The tracker did not name a linked change — worth a look before you trust it.',
      '',
      ticket.link ? `Ticket: ${ticket.link}` : '',
    ]
      .filter((line) => line !== '')
      .join('\n'),
    ticket,
  }
}

/** Rocky gave up carrying this ticket forward. Says why, so the ticket is not just abandoned quietly. */
export function failedMessage(ticket: Ticket, reason: string): NotifyMessage {
  const ref = ticketRef(ticket)
  return {
    kind: 'failed',
    subject: `Stopped tracking ${ref}: ${ticket.title}`,
    body: [`Rocky stopped following ${ref}.`, '', reason, '', ticket.link ? `Ticket: ${ticket.link}` : '']
      .filter((line) => line !== '')
      .join('\n'),
    ticket,
  }
}
