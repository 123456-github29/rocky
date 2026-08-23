import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { defaultConfig } from '../config'
import { formatEvalReport, parsePairs, runEval } from '../eval'
import { openaiProvider } from '../providers'

const USAGE = `usage: rocky-eval [pairs-file.json]

Runs the matcher over a file of labeled pairs and reports accuracy, missed
duplicates and false merges (separately — the costs are not symmetric), a
tiers-1–2-only baseline, and a per-tier breakdown.

The pairs file is a JSON array of:
  { "id": 1, "a": "<report text>", "b": "<ticket text>", "same": true, "note": "why" }

With no argument it reads eval/pairs.json, falling back to eval/example-pairs.json.
Set OPENAI_API_KEY to exercise tier 3; without it only tiers 1–2 run.`

async function main(): Promise<void> {
  const arg = process.argv[2]
  if (arg === '--help' || arg === '-h') {
    console.log(USAGE)
    return
  }

  const path = arg ?? ['eval/pairs.json', 'eval/example-pairs.json'].find((p) => existsSync(p))
  if (!path || !existsSync(path)) {
    console.error(
      arg
        ? `rocky-eval: no such file: ${arg}`
        : 'rocky-eval: no pairs file found (looked for eval/pairs.json and eval/example-pairs.json)',
    )
    console.error(`\n${USAGE}`)
    process.exitCode = 1
    return
  }

  let pairs
  try {
    pairs = parsePairs(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    console.error(`rocky-eval: could not read ${path}: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
    return
  }

  const hasKey = Boolean(process.env['OPENAI_API_KEY'])
  console.log(`pairs   ${path} (${pairs.length})`)
  console.log(
    hasKey
      ? `tier 3  openai · ${defaultConfig.model}`
      : 'tier 3  disabled — OPENAI_API_KEY is not set, running tiers 1–2 only',
  )
  console.log('')

  const report = await runEval(pairs, { llm: hasKey ? openaiProvider() : null })
  console.log(formatEvalReport(report))
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
