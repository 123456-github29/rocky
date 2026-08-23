import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import type { RockyProjectConfig } from '../project'
import { assertProjectConfig } from '../project'
import type { RunEvent } from '../run'
import { run } from '../run'
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

options:
  --config <path>   config file (default: rocky.config.ts, then .mts/.js/.mjs)
  --json            (run) emit structured JSON lines instead of pretty output

Dry-run being the default is the design: watch rocky's decisions until you
trust them, then add --live.`

const CONFIG_CANDIDATES = ['rocky.config.ts', 'rocky.config.mts', 'rocky.config.js', 'rocky.config.mjs']

interface Flags {
  live: boolean
  json: boolean
  config?: string
  positional: string[]
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = { live: false, json: false, positional: [] }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--live') flags.live = true
    else if (arg === '--json') flags.json = true
    else if (arg === '--config') {
      const value = args[++i]
      if (!value) throw new Error('--config requires a path')
      flags.config = value
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
    default:
      throw new Error(`unknown command "${command}"\n\n${USAGE}`)
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `rocky: ${error.message}` : error)
  process.exitCode = 1
})
