# rocky

Deduplicates incoming bug reports against the tickets you already have, then files or annotates — with an eval harness so you can measure it before you trust it.

## Step zero: write 30 labeled pairs and tune. This comes before installing.

Every deduplication tool has thresholds. Tools that hide them become **duplicate factories** — or worse, they silently merge two different bugs and one of them disappears into someone else's closed ticket. Rocky refuses to hide this: measuring the matcher on *your* bugs is the first thing you do, not an afterthought.

The homework, concretely:

1. Pull ~30 real cases from your history into `eval/pairs.json`: a report text, a ticket text, and whether they were the same bug.

   ```json
   [{ "id": 1, "a": "<report text>", "b": "<ticket text>", "same": true, "note": "why" }]
   ```

2. Make roughly half of them `same: false`, and make those **hard**: different bugs that sound alike. Identical error text in a different component. Two timeouts in different subsystems. These traps are what the thresholds are tuned against.
3. Run `rocky eval`. It reports missed duplicates and false merges as **separate counts** — never a single F1 score, because the costs are wildly asymmetric: a missed duplicate costs a human thirty seconds; a false merge makes a real bug vanish.
4. Tune `highThreshold` / `lowThreshold` until false merges are **zero** and missed duplicates are tolerable. The harness also runs a tiers-1–2-only baseline so you can see exactly what the LLM call buys you per run.

On rocky's own 10 shipped example pairs (deliberately hard ones), the no-LLM baseline scores 6/10 with **0 false merges** — the four misses are hard positives like user-speak vs. stack-trace-speak, which is precisely the work the LLM tier exists for. Those pairs are a smoke test, not a benchmark; your numbers on your bugs are the only ones that matter.

## What rocky is

The missing upstream half of agent task runners. Autonomous runners (cyrus, sortie, symphony, `claude-code-action`) all start from *an issue exists*. AI SRE tools detect from logs, but are closed-source and log-only. Nobody joins **"a customer emailed"** + **"this error fired 60 times"** + **"there's already a ticket for it."**

Rocky does that join:

```
sentry ─┐
gmail  ─┤                       ┌─ new bug        → create labeled ticket
slack  ─┼→ match against open ──┤
webhook─┘   tickets (3 tiers)   └─ duplicate      → annotate existing ticket
```

…and hands the resulting labeled ticket to whatever runner you already use. See [docs/handoff.md](docs/handoff.md).

## How matching works

Three tiers, cheapest first, short-circuiting on a conclusive answer:

1. **Fingerprint equality** — e.g. a Sentry issue id. Free, exact, no API call. Tickets rocky creates carry the fingerprint (an invisible marker in the body), so recurrences of a known error match instantly forever after.
2. **String similarity** — Sørensen–Dice on normalized text. At or above `highThreshold`: duplicate. Below `lowThreshold`: new bug. No API call either way.
3. **One LLM call** for the ambiguous middle only, via an injected provider (`openaiProvider()` ships; any `(prompt: string) => Promise<string>` works).

The load-bearing rule everywhere: **a false merge is much worse than a missed duplicate**, so every uncertainty resolves to "new ticket". Unparseable LLM output, hallucinated ticket ids, confidence below `llmMinConfidence`, a provider that throws, no provider configured — all of it fails safe to no-match. Nothing is ever merged on a guess.

## Install and wire up

Requires Node ≥ 18 (≥ 22.18 to load a TypeScript config directly; otherwise name it `rocky.config.mjs`).

```bash
npm install --save-dev rocky-triage
npx rocky init          # scaffolds rocky.config.ts + eval/pairs.json
```

```ts
// rocky.config.ts
import { defineConfig, sentrySource, githubSink, openaiProvider } from 'rocky-triage'

export default defineConfig({
  sources: [sentrySource({ token: process.env.SENTRY_TOKEN!, org: 'acme', project: 'web' })],
  sink: githubSink({ token: process.env.GITHUB_TOKEN!, owner: 'acme', repo: 'web' }),
  labels: ['rocky'],
  match: { llm: openaiProvider() },   // remove to run tiers 1–2 only
})
```

| command | what it does |
|---|---|
| `rocky init` | scaffold the config and the pairs file |
| `rocky eval` | run the harness: accuracy, missed dups vs. false merges, baseline, per-tier breakdown |
| `rocky run` | poll → match → **print** what would happen. Writes nothing. |
| `rocky run --live` | actually create/annotate tickets and persist cursors to `.rocky/state.json` |
| `rocky-source <name>` | poll one source in isolation and print the reports (credential smoke test) |
| `rocky-eval <pairs.json>` | the eval harness standalone, no config needed |

**Dry-run is the default, and that's the design, not a convenience.** Run `rocky run` on a schedule and read its decisions — every one logs which tier fired, the confidence, and the reasoning — for a week or two before adding `--live`. A cron example with state persistence is in [examples/github-action.yml](examples/github-action.yml).

## Sources and sinks

| | ships | escape hatch |
|---|---|---|
| **sources** | `sentrySource` (Sentry cloud + GlitchTip), `gmailSource`, `slackSource` (+ `reactionTrigger`: a human's emoji is the filter), `webhookSource` | `webhookSource({ map })` accepts any POST; or implement `Source` — it's one method |
| **sinks** | `githubSink` (Issues + labels), `linearSink` | implement `Sink` — three methods |

Duplicates are never dropped: `annotate` comments on the existing ticket with who reported it and a link back to the source, so frequency and affected-user signal accumulates where the fix will happen.

## Design rules

- The matcher is pure: no I/O except the one injected tier-3 call, config passed in, never imported.
- Zero runtime dependencies except the `openai` SDK (and that only loads if you use `openaiProvider`).
- No plugin system, no config DSL, no web UI — a `Source` is `{ name, poll }`, a `Sink` is three functions, and that's the whole extension story on purpose.
- Everything tunable lives in one config object with documented defaults, and the eval harness exists so you never have to trust those defaults.

## License

[MIT](LICENSE)
