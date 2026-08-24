import type { RockyProjectConfig } from './project'
import type { Report } from './types'
import type { Notifier } from './notify/types'
import { resolveConfig } from './config'

/**
 * One line of the report. `warn` is the interesting state: the call worked but
 * something about the answer will bite later — a source with no fingerprints,
 * an empty funnel, a sink that cannot run the approval loop.
 */
export interface CheckResult {
  group: 'sources' | 'sink' | 'tier 3' | 'notify'
  name: string
  status: 'ok' | 'warn' | 'fail'
  summary: string
  /** Extra lines: a sample report, a diagnosis, what to do about it. */
  detail?: string[]
}

export interface DoctorOptions {
  /** Also send one test message through every configured notifier. Off by default: it messages real people. */
  notify?: boolean
}

/**
 * Check every configured piece against the real APIs, and write nothing.
 *
 * This exists because rocky's adapters are tested against a fake `fetch` — that
 * proves the parsing, not that your GlitchTip instance, your OAuth token, or
 * your Linear team key work. Nobody can test those for you in advance, so the
 * next best thing is a command that tells you in ten seconds instead of after
 * a silent week of empty polls.
 *
 * Every check is a read except `--notify`, which is opt-in precisely because it
 * is the one that reaches a human.
 */
export async function doctor(project: RockyProjectConfig, options: DoctorOptions = {}): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const funnel = (project.labels ?? ['rocky'])[0]!
  const approveLabel = project.approveLabel ?? 'approved'

  for (const source of project.sources) {
    try {
      const { reports } = await source.poll(null)
      const sample = reports[0]
      const withFingerprints = reports.filter((r) => typeof r.fingerprint === 'string' && r.fingerprint !== '').length

      const detail: string[] = []
      if (sample) detail.push(`sample: ${describeReport(sample)}`)

      if (reports.length === 0) {
        results.push({
          group: 'sources',
          name: source.name,
          status: 'warn',
          summary: 'reachable, but returned 0 reports',
          detail: [
            'Credentials work. Either there is genuinely nothing to fetch, or the',
            'query/label/channel is filtering everything out. Check with `rocky-source`.',
          ],
        })
        continue
      }

      if (withFingerprints === 0) {
        detail.push(
          'No report carries a fingerprint, so tier 1 (free, exact matching) can never fire',
          'for this source — every decision falls to string similarity or the LLM. Expected',
          'for email and chat; a problem for an error tracker.',
        )
      }

      results.push({
        group: 'sources',
        name: source.name,
        status: withFingerprints === 0 ? 'warn' : 'ok',
        summary: `${reports.length} report(s) available · ${withFingerprints} with fingerprints`,
        detail,
      })
    } catch (error) {
      results.push({
        group: 'sources',
        name: source.name,
        status: 'fail',
        summary: message(error),
        detail: diagnose(error),
      })
    }
  }

  const sink = project.sink
  try {
    const open = await sink.listOpen()
    results.push({ group: 'sink', name: sink.name, status: 'ok', summary: `${open.length} open ticket(s)` })
  } catch (error) {
    results.push({ group: 'sink', name: sink.name, status: 'fail', summary: message(error), detail: diagnose(error) })
  }

  const missing = (['listByLabel', 'setLabels', 'comment', 'resolution'] as const).filter(
    (method) => typeof sink[method] !== 'function',
  )
  if (missing.length > 0) {
    results.push({
      group: 'sink',
      name: 'approval loop',
      status: 'fail',
      summary: `sink does not implement ${missing.join(', ')}`,
      detail: ['`rocky watch`, `approve`, `deny`, and `serve` all need these. The shipped', 'githubSink and linearSink implement them.'],
    })
  } else if (sink.listByLabel) {
    try {
      const [inFunnel, approved] = await Promise.all([sink.listByLabel(funnel), sink.listByLabel(approveLabel)])
      results.push({
        group: 'sink',
        name: 'approval loop',
        status: 'ok',
        summary: `${inFunnel.length} ticket(s) labeled "${funnel}" · ${approved.length} labeled "${approveLabel}"`,
        detail:
          approved.length > 0 && inFunnel.length === 0
            ? [
                `Tickets carry "${approveLabel}" but none carry "${funnel}". Rocky only follows its own`,
                'funnel, so those will not be picked up — check the labels match your config.',
              ]
            : undefined,
      })
    } catch (error) {
      results.push({ group: 'sink', name: 'approval loop', status: 'fail', summary: message(error), detail: diagnose(error) })
    }
  }

  if (project.investigator) {
    results.push({
      group: 'tier 3',
      name: 'investigator',
      status: 'ok',
      summary: 'configured — rocky reads the whole log window and files problems, not reports',
    })
    if (project.analyst) {
      results.push({
        group: 'tier 3',
        name: 'analyst',
        status: 'warn',
        summary: 'set but never called while an investigator is configured',
        detail: [
          'The analyst writes a brief per report during per-report triage. With an',
          'investigator, the finding IS the brief, so this provider is dead config and',
          'you are paying for a model you never call. Remove it, or remove the',
          'investigator to go back to triage mode.',
        ],
      })
    }
  }

  const llm = resolveConfig(project.match).llm
  if (project.investigator) {
    if (llm) {
      results.push({
        group: 'tier 3',
        name: 'match.llm',
        status: 'warn',
        summary: 'set but never called while an investigator is configured',
        detail: ['Tier 3 belongs to per-report triage. An investigation dedupes by cited signature instead.'],
      })
    }
  } else if (!llm) {
    results.push({
      group: 'tier 3',
      name: 'llm',
      status: 'warn',
      summary: 'no provider configured — tiers 1–2 only',
      detail: ['Ambiguous reports will become new tickets rather than consulting a model.', 'Nothing is merged on a guess either way; you just miss more duplicates.'],
    })
  } else {
    const started = Date.now()
    try {
      const answer = await llm('Reply with the single word: ok')
      results.push({
        group: 'tier 3',
        name: 'llm',
        status: answer.trim() === '' ? 'warn' : 'ok',
        summary: answer.trim() === '' ? `responded in ${Date.now() - started}ms but returned nothing` : `responded in ${Date.now() - started}ms`,
      })
    } catch (error) {
      results.push({
        group: 'tier 3',
        name: 'llm',
        status: 'fail',
        summary: message(error),
        detail: [
          'Every tier-3 decision will fail safe to "new ticket" without the model seeing it.',
          'Rocky keeps working; it just deduplicates worse, and `rocky eval` will say so.',
          ...diagnose(error),
        ],
      })
    }
  }

  for (const notifier of toNotifiers(project.notify)) {
    if (!options.notify) {
      results.push({ group: 'notify', name: notifier.name, status: 'ok', summary: 'configured (pass --notify to send a test message)' })
      continue
    }
    try {
      await notifier.send({
        kind: 'started',
        subject: 'rocky doctor: test message',
        body: 'If you are reading this, rocky can reach you. Nothing needs doing.',
        ticket: { id: 'doctor', title: 'rocky doctor', summary: '', fingerprint: null, state: 'open', link: '' },
      })
      results.push({ group: 'notify', name: notifier.name, status: 'ok', summary: 'test message delivered' })
    } catch (error) {
      results.push({ group: 'notify', name: notifier.name, status: 'fail', summary: message(error), detail: diagnose(error) })
    }
  }

  if (toNotifiers(project.notify).length === 0) {
    results.push({
      group: 'notify',
      name: '(none)',
      status: 'warn',
      summary: 'no notifier configured — `rocky watch` will print instead of sending',
      detail: ['Fine while you are reading its decisions. Set `notify` before you rely on being told.'],
    })
  }

  return results
}

/** Render the report. Returns the text and whether anything failed, so the CLI can set an exit code. */
export function formatDoctorReport(results: CheckResult[]): { text: string; failed: boolean } {
  const mark = { ok: '✓', warn: '!', fail: '✗' } as const
  const lines: string[] = []
  const width = Math.max(8, ...results.map((r) => r.name.length))

  for (const group of ['sources', 'sink', 'tier 3', 'notify'] as const) {
    const inGroup = results.filter((r) => r.group === group)
    if (inGroup.length === 0) continue
    lines.push(group)
    for (const result of inGroup) {
      lines.push(`  ${mark[result.status]} ${result.name.padEnd(width)}  ${result.summary}`)
      for (const line of result.detail ?? []) lines.push(`      ${line}`)
    }
    lines.push('')
  }

  const failed = results.filter((r) => r.status === 'fail')
  const warned = results.filter((r) => r.status === 'warn')
  lines.push(
    failed.length > 0
      ? `${failed.length} check(s) failed, ${warned.length} warning(s). Fix the failures before \`--live\`.`
      : warned.length > 0
        ? `All checks passed, with ${warned.length} warning(s) worth reading.`
        : 'All checks passed. Nothing was written.',
  )
  return { text: lines.join('\n'), failed: failed.length > 0 }
}

function describeReport(report: Report): string {
  const title = (report.title ?? report.text).split('\n')[0]!.slice(0, 60)
  return `${report.id}  "${title}"  fingerprint ${report.fingerprint ?? '(none)'}`
}

/**
 * Turn a raw transport error into the next thing to try.
 *
 * Ordered most-specific first, and the network cases come before the status
 * codes on purpose: a corporate proxy or an egress allowlist answers 403, and
 * "your token needs more scope" is a confidently wrong thing to tell someone
 * whose request never left the building.
 */
function diagnose(error: unknown): string[] {
  const text = message(error)
  if (/not in allowlist|egress|blocked by|proxy|ERR_TLS|self.signed certificate|unable to verify/i.test(text)) {
    return ['This looks like a network policy, not a credential — the request was refused before', 'the service saw it. Check egress rules, proxy settings, and any TLS interception.']
  }
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed|ETIMEDOUT/i.test(text)) {
    return ['Could not connect at all. Check baseUrl and that the host is reachable from here.']
  }
  if (/HTTP 401|invalid_grant|Bad credentials|Incorrect API key|Missing credentials/i.test(text)) {
    return ['The credential was rejected or missing. Check the token is set, unexpired, and for the right account.']
  }
  if (/HTTP 403/i.test(text)) {
    return ['Authenticated but not permitted. The token needs write scope on issues (and read on the project).']
  }
  if (/HTTP 404/i.test(text)) {
    return ['Reached the API but not the thing. Check org/project/owner/repo/team spelling — a private resource a token cannot see also 404s.']
  }
  if (/HTTP 429/i.test(text)) {
    return ['Rate limited. Poll less often, or narrow the query.']
  }
  return []
}

function toNotifiers(notify: RockyProjectConfig['notify']): Notifier[] {
  if (!notify) return []
  return Array.isArray(notify) ? notify : [notify]
}

/**
 * One line, always. API error bodies are pretty-printed JSON, and a newline in
 * the middle of a status line destroys the column alignment that makes the
 * whole report scannable.
 */
function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat
}
