import type { Notifier, NotifyMessage } from './types'

export interface ConsoleNotifierOptions {
  /** Where to write. Defaults to `console.log`. */
  write?: (line: string) => void
  name?: string
}

/**
 * Prints the message instead of delivering it. The default notifier, so
 * `rocky watch` works before any messaging platform is configured — you can
 * see the exact approval requests rocky would send you, in the same wording,
 * with nothing to set up.
 */
export function consoleNotifier(options: ConsoleNotifierOptions = {}): Notifier {
  const { write = (line: string) => console.log(line), name = 'console' } = options
  return {
    name,
    async send(message: NotifyMessage) {
      write(`\n── ${message.kind.toUpperCase()} ─ ${message.subject}\n${message.body}\n`)
    },
  }
}
