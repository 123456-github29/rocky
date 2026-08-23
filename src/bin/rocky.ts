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
import { serve } from '../serve'
import { doctor, formatDoctorReport } from '../doctor'
import type { RockyState } from '../state'
import { loadState, saveState } from '../state'
import { formatEvalReport, parsePairs, runEval } from '../eval'
import { openaiProvider } from '../providers'
import { defaultConfig } from '../config'
import { CONFIG_TEMPLATE, INIT_NEXT_STEPS, PAIRS_TEMPLATE } from '../scaffold'

const USAGE = `usage: rocky <command>

  rocky init              scaffold rocky.config.ts and eval/pairs.json
  rocky doctor            check every configured source, sink, and provider. Writes nothing.
  rocky eval [pairs.json] run the eval harness (uses the config's matcher tuning when present)

  rocky run               poll sources, match, and PRINT what would happen — writes nothing
  rocky run --live        actually create and annotate tickets, and persist cursors

  rocky watch             PRINT the approval messages that are due — sends nothing
  rocky watch --live      send approval requests and completion notices
  rocky approve <id>      record your yes: adds the approve label, opening the gate
  rocky deny <id>         drop a ticket from rocky's funnel (leaves it open)
  rocky status            what rocky is following, and how far each ticket got
  rocky serve             local dashboard: read what's waiting, click approve or deny

options:
  --config <path>   config file (default: rocky.config.ts, then .mts/.js/.mjs)
  --json            (run, watch) emit structured JSON lines instead of pretty output
  --by <name>       (approve, deny) who decided — recorded on the ticket
  --reason <text>   (deny) why
  --port <n>        (serve) default 4711
  --host <addr>     (serve) default 127.0.0.1 — this page approves code changes
  --token <secret>  (serve) require ?token= or a Bearer header
  --notify          (doctor) also send one test message through each notifier

Dry-run being the default is the design: watch rocky's decisions until you
trust them, then add --live.`

const CONFIG_CANDIDATES = ['rocky.config.ts', 'rocky.config.mts', 'rocky.config.js', 'rocky.config.mjs']

interface Flags {
  live: boolean
  json: boolean
  notify: boolean
  config?: string
  by?: string
  reason?: string
  port?: string
  host?: string
  token?: string
  positional: string[]
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = { live: false, json: false, notify: false, positional: [] }
  const valued = {
    '--config': 'config',
    '--by': 'by',
    '--reason': 'reason',
    '--port': 'port',
    '--host': 'host',
    '--token': 'token',
  } as const
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--live') flags.live = true
    else if (arg === '--json') flags.json = true
    else if (arg === '--notify') flags.notify = true
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

  // The scaffolded config is ESM. In a package without "type": "module", Node
  // still loads it but prints a reparsing warning on every single command,
  // which reads like something is broken when nothing is.
  const pkgPath = resolve('package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { type?: unknown }
      if (pkg.type !== 'module') {
        console.log(
          '\nnote: add "type": "module" to package.json. rocky.config.ts is ESM, and without\n' +
            '      it Node prints a "Reparsing as ES module" warning on every rocky command.\n' +
            '      If the rest of your package is CommonJS, rename the config to rocky.config.mts instead.',
        )
      }
    } catch {
      // A package.json we cannot parse is not rocky's problem to report.
    }
  }

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
    case 'analyzed': {
      const { summary, location, proposedFix, risks, confidence } = event.analysis
      return (
        `[analysis]  ${event.reportId}: ${summary} (confidence ${confidence.toFixed(2)})\n` +
        `            where: ${location ?? 'not identified'}\n` +
        `            fix:   ${proposedFix}` +
        (risks.length > 0 ? `\n            risks: ${risks.join('; ')}` : '')
      )
    }
    case 'analysis-failed':
      return `[analysis]  ${event.reportId}: no brief written — the ticket will carry the raw report`
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
      `${summary.skipped} skipped as seen, ${summary.errors} error(s), ${summary.llmCalls} LLM call(s)` +
      (summary.analyzed > 0 ? `, ${summary.analyzed} analyzed` : ''),
  )
  if (summary.llmFailures > 0) {
    console.log(
      `WARNING: ${summary.llmFailures} of ${summary.llmCalls} LLM call(s) failed. Those reports fell back to\n` +
        '         "new ticket" without the model ever seeing them — this run deduplicated worse\n' +
        '         than tiers 1–2 would suggest. Check the provider before trusting the numbers.',
    )
  }
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
    case 'message': {
      // In a live run the delivery lines below carry the news, and repeating
      // every body would bury them. In a dry run the body IS the output.
      if (event.live) return `[message]   ${event.ticketId}: ${event.subject}`
      const body = event.body
        .split('\n')
        .map((line) => `            ${line}`)
        .join('\n')
      return `[message]   ${event.ticketId}: would send —\n\n            ${event.subject}\n${body}\n`
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
    const { triggered } = await approve(config, id, { by: flags.by ?? 'unknown', trigger: true })
    console.log(
      `approved ${ticketId} — label "${config.approveLabel ?? 'approved'}" added.` +
        (triggered ? '\nonApprove fired: the runner has started.' : '') +
        '\nThe coding agent takes it from here; `rocky watch --live` will report when it closes.',
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

async function doctorCommand(flags: Flags): Promise<void> {
  const { config, path } = await loadForLoop(flags)
  console.log(`config  ${path}`)
  console.log(flags.notify ? 'mode    checking, and sending one test message per notifier' : 'mode    read-only — nothing is written or sent')
  console.log('')

  const results = await doctor(config, { notify: flags.notify })
  if (flags.json) {
    console.log(JSON.stringify({ type: 'doctor', results }))
  } else {
    const { text } = formatDoctorReport(results)
    console.log(text)
  }
  if (results.some((r) => r.status === 'fail')) process.exitCode = 1
}

async function serveCommand(flags: Flags): Promise<void> {
  const { config, path, statePath } = await loadForLoop(flags)
  const port = flags.port === undefined ? 4711 : Number(flags.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port must be a port number, got "${flags.port}"`)
  const host = flags.host ?? '127.0.0.1'

  const server = serve(config, {
    port,
    host,
    statePath,
    ...(flags.token ? { token: flags.token } : {}),
  })

  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(`port ${port} is already in use — pass --port to pick another`)
          : error,
      )
    })
  })

  const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host
  const query = flags.token ? `?token=${encodeURIComponent(flags.token)}` : ''
  console.log(`config  ${path}`)
  console.log(`state   ${statePath}`)
  console.log(`gate    label "${(config.labels ?? ['rocky'])[0]!}" → "${config.approveLabel ?? 'approved'}"`)
  console.log('')
  console.log(`  http://${shown}:${port}/${query}`)
  console.log('')
  if (host !== '127.0.0.1' && host !== 'localhost' && !flags.token) {
    console.log(`WARNING: bound to ${host} with no --token. Anyone who can reach this port can approve`)
    console.log('         code changes. Use --token, or bind to 127.0.0.1 and tunnel over SSH.')
    console.log('')
  }
  console.log('Approving here does exactly what `rocky approve` does — it adds the label in your')
  console.log('tracker. `rocky watch --live` still has to be running to send the messages.')
  console.log('Ctrl-C to stop.')

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      server.close(() => resolve())
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
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
    case 'serve':
      await serveCommand(flags)
      return
    case 'doctor':
      await doctorCommand(flags)
      return
    default:
      throw new Error(`unknown command "${command}"\n\n${USAGE}`)
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `rocky: ${error.message}` : error)
  process.exitCode = 1
})
