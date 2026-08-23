import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import type { RockyProjectConfig } from '../project'
import { assertProjectConfig } from '../project'
import type { RunEvent } from '../run'
import { run } from '../run'
import type { WatchEvent } from '../watch'
import { approve, deny, formatStatus, watch } from '../watch'
import { consoleNotifier } from '../notify/console'
import type { RockyState } from '../state'
import { loadState, saveState } from '../state'
import { formatEvalReport, parsePairs, runEval } from '../eval'
import { openaiProvider } from '../providers'
import { defaultConfig } from '../config'
import { CONFIG_TEMPLATE, INIT_NEXT_STEPS, PAIRS_TEMPLATE } from '../scaffold'

const USAGE = `usage: rocky <command>

  rocky init              scaffold rocky.config.ts and eval/pairs.json
  rocky eval [pairs.json] run the eval harness (uses the config's matcher tuning when present)

  rocky run               poll sources, match, and PRINT what would happen — writes nothing
  rocky run --live        actually create and annotate tickets, and persist cursors

  rocky watch             PRINT the approval messages that are due — sends nothing
  rocky watch --live      send approval requests and completion notices
  rocky approve <id>      record your yes: adds the approve label, opening the gate
  rocky deny <id>         drop a ticket from rocky's funnel (leaves it open)
  rocky status            what rocky is following, and how far each ticket got

options:
  --config <path>   config file (default: rocky.config.ts, then .mts/.js/.mjs)
  --json            (run, watch) emit structured JSON lines instead of pretty output
  --by <name>       (approve, deny) who decided — recorded on the ticket
  --reason <text>   (deny) why

Dry-run being the default is the design: watch rocky's decisions until you
trust them, then add --live.`

const CONFIG_CANDIDATES = ['rocky.config.ts', 'rocky.config.mts', 'rocky.config.js', 'rocky.config.mjs']

interface Flags {
  live: boolean
  json: boolean
  config?: string
  by?: string
  reason?: string
  positional: string[]
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = { live: false, json: false, positional: [] }
  const valued = { '--config': 'config', '--by': 'by', '--reason': 'reason' } as const
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--live') flags.live = true
    else if (arg === '--json') flags.json = true
    else if (arg in valued) {
      const value = args[++i]
      if (!value) throw new Error(`${arg} requires a value`)
      flags[valued[arg as keyof typeof valued]] = value
    } else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`)
    else flags.positional.push(arg)
  }
  return flags
}

async function loadProjectConfig(explicit: string | undefined): Promise<{ config: RockyProjectConfig; path: string } | null> {
  const candidates = explicit ? [explicit] : CONFIG_CANDIDATES
  for (const candidate of candidates) {
    const path = resolve(candidate)
    if (!existsSync(path)) {
      if (explicit) throw new Error(`config file not found: ${candidate}`)
      continue
    }
    let module: Record<string, unknown>
    try {
      module = (await import(pathToFileURL(path).href)) as Record<string, unknown>
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ERR_UNKNOWN_FILE_EXTENSION') {
        throw new Error(
          `this Node cannot import ${candidate} directly — TypeScript configs need Node >= 22.18 ` +
            '(type stripping), or rename the config to rocky.config.mjs',
        )
      }
      throw error
    }
    const config = module['default'] ?? module['config']
    assertProjectConfig(config)
    return { config, path }
  }
  return null
}

function init(): void {
  const write = (path: string, content: string): void => {
    if (existsSync(path)) {
      console.log(`kept    ${path} (already exists)`)
      return
    }
    mkdirSync(dirname(resolve(path)), { recursive: true })
    writeFileSync(path, content, 'utf8')
    console.log(`created ${path}`)
  }
  write('rocky.config.ts', CONFIG_TEMPLATE)
  write('eval/pairs.json', PAIRS_TEMPLATE)
  console.log(`\n${INIT_NEXT_STEPS}`)
}

async function evalCommand(flags: Flags): Promise<void> {
  const loaded = await loadProjectConfig(flags.config)
  const explicitPairs = flags.positional[0]
  const pairsPath =
    explicitPairs ??
    loaded?.config.pairsPath ??
    ['eval/pairs.json', 'eval/example-pairs.json'].find((p) => existsSync(p))
  if (!pairsPath || !existsSync(pairsPath)) {
    throw new Error(
      explicitPairs ? `no such pairs file: ${explicitPairs}` : 'no pairs file found — run `rocky init` and write your labeled pairs first',
    )
  }
  const pairs = parsePairs(JSON.parse(readFileSync(pairsPath, 'utf8')))

  const matchConfig = { ...loaded?.config.match }
  if (!matchConfig.llm && process.env['OPENAI_API_KEY']) {
    matchConfig.llm = openaiProvider()
  }

  console.log(`config  ${loaded ? loaded.path : '(none found — library defaults)'}`)
  console.log(`pairs   ${pairsPath} (${pairs.length})`)
  console.log(
    matchConfig.llm
      ? `tier 3  ${loaded?.config.match?.llm ? 'provider from config' : `openai · ${defaultConfig.model} (OPENAI_API_KEY)`}`
      : 'tier 3  disabled — no provider in config and OPENAI_API_KEY is not set',
  )
  console.log('')
  console.log(formatEvalReport(await runEval(pairs, matchConfig)))
}

function prettyEvent(event: RunEvent): string {
  switch (event.type) {
    case 'poll':
      return `[poll]      ${event.source}: ${event.count} report(s), cursor → ${event.cursor}`
    case 'poll-error':
      return `[error]     polling ${event.source} failed: ${event.message}`
    case 'decision': {
      const outcome =
        event.result.matchId === null ? 'new ticket' : `duplicate of ticket ${String(event.result.matchId)}`
      const prefix = event.live ? '[decision] ' : '[dry-run]  '
      return (
        `${prefix} ${event.report.id}: ${outcome} (tier ${event.result.tier}, confidence ${event.result.confidence.toFixed(2)})\n` +
        `            ${event.result.reasoning}`
      )
    }
    case 'skip':
      return `[skip]      ${event.reportId}: already processed by an earlier run`
    case 'created':
      return `[created]   ticket ${String(event.ticketId)} ← ${event.reportId}${event.link ? ` (${event.link})` : ''}`
    case 'annotated':
      return `[annotated] ticket ${String(event.ticketId)} ← ${event.reportId}`
    case 'action-error':
      return `[error]     ${event.action} for ${event.reportId} failed: ${event.message} (will retry next run)`
  }
}

async function runCommand(flags: Flags): Promise<void> {
  const loaded = await loadProjectConfig(flags.config)
  if (!loaded) {
    throw new Error('no rocky.config.{ts,mts,js,mjs} found — run `rocky init` first')
  }
  const { config } = loaded
  const statePath = config.statePath ?? '.rocky/state.json'
  const state = loadState(statePath)

  const log = (event: RunEvent): void => {
    console.log(flags.json ? JSON.stringify(event) : prettyEvent(event))
  }

  if (!flags.json) {
    console.log(`config  ${loaded.path}`)
    console.log(`state   ${statePath}${existsSync(statePath) ? '' : ' (fresh start — no cursors yet)'}`)
    console.log(flags.live ? 'mode    LIVE — tickets will be created and annotated' : 'mode    dry-run (default) — nothing will be written')
    console.log('')
  }

  const { summary, state: nextState } = await run(config, state, { live: flags.live, log })

  if (flags.live) {
    saveState(statePath, nextState)
  }

  if (flags.json) {
    console.log(JSON.stringify({ type: 'summary', ...summary }))
    return
  }
  console.log('')
  const verb = flags.live ? '' : 'would be '
  console.log(
    `summary: ${summary.reports} report(s) — ${summary.created} ${verb}created, ${summary.annotated} ${verb}annotated, ` +
      `${summary.skipped} skipped as seen, ${summary.errors} error(s), ${summary.llmCalls} LLM call(s)`,
  )
  console.log(
    flags.live
      ? `state saved to ${statePath}`
      : 'dry-run: nothing was written and no cursors moved. Rerun with --live when you trust the decisions above.',
  )
}

function prettyWatchEvent(event: WatchEvent): string {
  switch (event.type) {
    case 'watch-poll':
      return `[poll]      ${event.open} open in the funnel, ${event.approved} approved, ${event.tracked} tracked`
    case 'phase': {
      const prefix = event.live ? '[phase]    ' : '[dry-run]  '
      const arrow = `${event.from} → ${event.to}`
      return `${prefix} ${event.ticketId}: ${arrow} — ${event.title}${event.link ? `\n            ${event.link}` : ''}`
    }
    case 'notified':
      return `[sent]      ${event.ticketId}: ${event.kind} via ${event.via}`
    case 'notify-error':
      return `[error]     ${event.ticketId}: ${event.kind} via ${event.via} failed: ${event.message} (will retry next pass)`
    case 'watch-error':
      return `[error]     ${event.ticketId}: ${event.message}`
    case 'approve-hook-error':
      return `[error]     ${event.ticketId}: onApprove hook failed: ${event.message}`
  }
}

/** Load the config and its state, or fail with the same message every approval-loop command wants. */
async function loadForLoop(flags: Flags): Promise<{
  config: RockyProjectConfig
  path: string
  statePath: string
  state: RockyState
}> {
  const loaded = await loadProjectConfig(flags.config)
  if (!loaded) throw new Error('no rocky.config.{ts,mts,js,mjs} found — run `rocky init` first')
  const statePath = loaded.config.statePath ?? '.rocky/state.json'
  return { config: loaded.config, path: loaded.path, statePath, state: loadState(statePath) }
}

async function watchCommand(flags: Flags): Promise<void> {
  const { config, path, statePath, state } = await loadForLoop(flags)
  const log = (event: WatchEvent): void => {
    console.log(flags.json ? JSON.stringify(event) : prettyWatchEvent(event))
  }

  const notifiers = config.notify ? (Array.isArray(config.notify) ? config.notify : [config.notify]) : []
  if (!flags.json) {
    console.log(`config  ${path}`)
    console.log(`state   ${statePath}`)
    console.log(`gate    label "${(config.labels ?? ['rocky'])[0]!}" → "${config.approveLabel ?? 'approved'}"`)
    console.log(`notify  ${notifiers.length === 0 ? 'nothing configured — messages print here' : notifiers.map((n) => n.name).join(', ')}`)
    console.log(flags.live ? 'mode    LIVE — messages will be sent' : 'mode    dry-run (default) — nothing will be sent')
    console.log('')
  }

  // With no notifier configured, print the messages rather than sending into a
  // void — that is what makes `rocky watch` useful before any platform is set up.
  const project: RockyProjectConfig = notifiers.length > 0 ? config : { ...config, notify: consoleNotifier() }
  const { summary, state: nextState } = await watch(project, state, { live: flags.live, log })

  if (flags.live) saveState(statePath, nextState)

  if (flags.json) {
    console.log(JSON.stringify({ type: 'summary', ...summary }))
    return
  }
  console.log('')
  const verb = flags.live ? '' : 'would be '
  console.log(
    `summary: ${summary.asked} ${verb}asked about, ${summary.approved} approved, ${summary.completed} completed, ` +
      `${summary.dismissed} dismissed, ${summary.errors} error(s) — ${summary.tracked} still tracked`,
  )
  console.log(
    flags.live
      ? `state saved to ${statePath}`
      : 'dry-run: nothing was sent and no phases were saved. Rerun with --live when the messages above look right.',
  )
}

async function decisionCommand(command: 'approve' | 'deny', flags: Flags): Promise<void> {
  const ticketId = flags.positional[0]
  if (!ticketId) throw new Error(`${command} requires a ticket id, e.g. \`rocky ${command} 42\``)
  const { config } = await loadForLoop(flags)
  const id = ticketId.replace(/^#/, '')

  if (command === 'approve') {
    await approve(config, id, { by: flags.by ?? 'unknown' })
    console.log(
      `approved ${ticketId} — label "${config.approveLabel ?? 'approved'}" added.\n` +
        'The coding agent takes it from here; `rocky watch --live` will report when it closes.',
    )
    return
  }
  await deny(config, id, { by: flags.by ?? 'unknown', ...(flags.reason ? { reason: flags.reason } : {}) })
  console.log(`denied ${ticketId} — dropped from rocky's funnel. The ticket is still open.`)
}

async function statusCommand(flags: Flags): Promise<void> {
  const { state, statePath } = await loadForLoop(flags)
  if (flags.json) {
    console.log(JSON.stringify({ type: 'status', tickets: state.tickets }))
    return
  }
  console.log(`state   ${statePath}\n`)
  console.log(formatStatus(state))
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE)
    if (!command) process.exitCode = 1
    return
  }
  const flags = parseFlags(rest)
  switch (command) {
    case 'init':
      init()
      return
    case 'eval':
      await evalCommand(flags)
      return
    case 'run':
      await runCommand(flags)
      return
    case 'watch':
      await watchCommand(flags)
      return
    case 'approve':
    case 'deny':
      await decisionCommand(command, flags)
      return
    case 'status':
      await statusCommand(flags)
      return
    default:
      throw new Error(`unknown command "${command}"\n\n${USAGE}`)
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `rocky: ${error.message}` : error)
  process.exitCode = 1
})
