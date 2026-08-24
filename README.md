# rocky

Reads your error logs, works out what is actually wrong with the service, writes each problem up as a work item with the evidence behind it, and asks you before a coding agent touches any of it.

```
glitchtip ─┐                          ┌─ 2 problems worth work → file each ─┐
gmail      ─┤→ read the whole window ─┤                                      ├→ "approve #42?" → you → Claude Code → "done, PR #117"
slack      ─┤   work out what's wrong  └─ 3 signatures already tracked → skip┘
webhook    ─┘
```

## How it works

One model reads your whole log window each cycle and returns **problems**, not error copies. On a real five-signature window:

```
[investigate] read 5 log signature(s) → 2 problem(s) worth work

[critical] Deadlock applying billing credits
           based on 11 occurrence(s) across 1 signature(s)

[high]     Voice pipeline crashes on empty transcripts
           where: src/voice/pipeline.ts:88
           based on 4,012 occurrence(s) across 3 signature(s)
```

Three things happened there that a router cannot do. A signature with **44,000 occurrences** produced no finding — it was a deprecation warning, and leaving noise out is as valuable as reporting the real thing. Three separate signatures became **one work item**, because they share a cause. And an **11-occurrence** problem outranked a **4,012-occurrence** one, because volume is not impact.

### The two properties it rests on

**Evidence.** Every finding cites the exact log entries it was built from, and a citation that is not in the window discards the whole finding. A diagnosis you cannot trace back to the logs is a rumour.

**Stability.** The same problem investigated twice is worded differently every time, so findings map to tickets by **the signatures they cite**, never by prose — and a ticket carries every signature it covers. Verified live: a second run reworded both findings past recognition *and* cited one of three signatures; both still matched. Without this a 15-minute schedule files 96 copies a day.

## If you run without an investigator: write 30 labeled pairs and tune first

Without an `investigator`, rocky falls back to per-report triage — a router that matches each incoming report against your open tickets. That mode has thresholds, and tools that hide their thresholds become **duplicate factories**, or worse: they silently merge two different bugs and one of them disappears into someone else's closed ticket. Rocky refuses to hide this. Measuring the matcher on *your* bugs comes before you rely on it.

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

Rocky does that join, then carries the result through a human gate to the runner and back:

| stage | command | what happens |
|---|---|---|
| **monitor** | `rocky run` | poll every source for new reports |
| **investigate** | | one model reads the whole log window and works out what is actually wrong: signatures grouped by root cause, impact weighed against noise, each conclusion carrying the evidence it rests on |
| **dedupe** | | findings map to existing tickets by the signatures they cite — never by wording, so re-investigating the same logs updates one ticket instead of filing a fourth copy |
| **ask** | `rocky watch` | one message per problem: what needs doing, and how to say yes or no |
| **gate** | `rocky approve 42` | your yes, recorded as a label on the ticket |
| **fix** | *(your runner)* | triggered by that label — Claude Code, cyrus, whatever you use |
| **report** | `rocky watch` | the ticket closes; you get one "done" with the PR link |

Rocky writes no code and sends no messages itself: the fix is your runner's job, and delivery is [Hermes](https://github.com/nousresearch/hermes-agent)'s. See [docs/pipeline.md](docs/pipeline.md) for the whole loop wired end to end, and [docs/handoff.md](docs/handoff.md) for the ticket contract runners consume.

### The gate is the point

Filing is automatic. Fixing is not. Approval is a **label on the ticket**, never a row in rocky's state file — so you can approve from a chat reply, from the GitHub UI on your phone, or a teammate can, and all three look identical to rocky. Two labels are the entire protocol:

- **`rocky`** — rocky filed this. Defines the funnel `rocky watch` follows.
- **`approved`** — a human said yes. Point your runner's trigger at *this* one.

Losing rocky's state file makes it re-ask about open tickets. It can never make rocky act on something you did not approve.

## The fallback: how per-report matching works

With no `investigator` configured, three tiers, cheapest first, short-circuiting on a conclusive answer:

1. **Fingerprint equality** — e.g. a Sentry issue id. Free, exact, no API call. Tickets rocky creates carry the fingerprint (an invisible marker in the body), so recurrences of a known error match instantly forever after.
2. **String similarity** — Sørensen–Dice on normalized text. At or above `highThreshold`: duplicate. Below `lowThreshold`: new bug. No API call either way.
3. **One LLM call** for the ambiguous middle only, via an injected provider (`openaiProvider()` ships; any `(prompt: string) => Promise<string>` works).

Tier 3 is optional and **not OpenAI-specific**. `openaiProvider({ baseUrl })` points at any OpenAI-compatible endpoint — Ollama, vLLM, an internal gateway — so report text need never leave your network, and a custom provider is one function. With no provider at all, rocky runs tiers 1–2: more missed duplicates, never more false merges. `rocky eval` reports the baseline separately so "is the LLM worth paying for" is a measurement, not an opinion.

The load-bearing rule everywhere: **a false merge is much worse than a missed duplicate**, so every uncertainty resolves to "new ticket". Unparseable LLM output, hallucinated ticket ids, confidence below `llmMinConfidence`, a provider that throws, no provider configured — all of it fails safe to no-match. Nothing is ever merged on a guess.

## Install and wire up

Requires Node ≥ 18 (≥ 22.18 to load a TypeScript config directly; otherwise name it `rocky.config.mts`).

```bash
npm install --save-dev github:123456-github29/rocky
npx rocky init          # scaffolds rocky.config.ts + eval/pairs.json
npx rocky doctor        # checks your credentials and APIs. Writes nothing.
```

> Not on npm yet, so install from git for now — it builds itself on install.
> Once published, this becomes `npm install --save-dev rocky-triage`.

**[docs/setup.md](docs/setup.md) is the step-by-step**: which credential each
piece needs, where to get it, what scope, and what goes wrong if it's off.

**Run `rocky doctor` first.** Rocky's adapters are tested against a fake
`fetch`, which proves the parsing and nothing about *your* GlitchTip instance,
*your* OAuth token, or *your* Linear team key. `doctor` calls every configured
source, sink, and provider for real, writes nothing, and tells you what is
wrong in the specific — including the things that fail silently later, like a
source that returns no fingerprints (tier 1 can never fire) or approved tickets
that are not in rocky's funnel.

```ts
// rocky.config.ts
import { defineConfig, sentrySource, githubSink, hermesNotifier, openaiProvider } from 'rocky-triage'

export default defineConfig({
  sources: [
    // GlitchTip speaks the Sentry API — same adapter, your own baseUrl.
    sentrySource({ token: process.env.GLITCHTIP_TOKEN!, org: 'acme', project: 'web',
                   baseUrl: 'https://glitchtip.internal', name: 'glitchtip' }),
  ],
  sink: githubSink({ token: process.env.GITHUB_TOKEN!, owner: 'acme', repo: 'web' }),
  labels: ['rocky'],
  approveLabel: 'approved',
  notify: hermesNotifier({ to: 'telegram' }),           // omit and `rocky watch` prints instead
  investigator: openaiProvider({ model: 'gpt-5.4' }),  // reads the logs, works out what's wrong
})
```

`investigator` is the judgement call in the pipeline — one call per cycle, reading everything. Point it at your best model. Leave it out and rocky drops to per-report triage, which then wants `match.llm` and `analyst` instead; `rocky doctor` tells you when a provider you configured is never being called. See [docs/setup.md](docs/setup.md).

| command | what it does |
|---|---|
| `rocky init` | scaffold the config and the pairs file |
| `rocky doctor` | check every configured source, sink, and provider against the real APIs. Writes nothing. |
| `rocky eval` | run the harness: accuracy, missed dups vs. false merges, baseline, per-tier breakdown |
| `rocky run` | poll → match → **print** what would happen. Writes nothing. |
| `rocky run --live` | actually create/annotate tickets and persist cursors to `.rocky/state.json` |
| `rocky watch` | **print** the approval and completion messages that are due. Sends nothing. |
| `rocky watch --live` | actually deliver them, and advance the gate |
| `rocky approve <id>` | record your yes — adds the approve label |
| `rocky deny <id>` | drop a ticket from the funnel. Leaves it open; rocky never closes your tickets. |
| `rocky status` | what rocky is following, and how far each ticket got |
| `rocky serve` | local dashboard: read what's waiting, click approve or deny |
| `rocky-source <name>` | poll one source in isolation and print the reports (credential smoke test) |
| `rocky-eval <pairs.json>` | the eval harness standalone, no config needed |

**Dry-run is the default on both loops, and that's the design, not a convenience.** `rocky run` logs every decision with the tier, confidence, and reasoning; `rocky watch` prints the full text of each message it would send. Read a week of both before adding `--live` — to `run` first, then `watch`. You are checking two different things: whether the dedup decisions are right, and whether the approval message is enough to decide on without opening the tracker. A cron example with state persistence is in [examples/github-action.yml](examples/github-action.yml); the Hermes schedule is in [integrations/hermes/config.example.yaml](integrations/hermes/config.example.yaml).

### Three ways to answer

Approval is a label, so every route to it is equivalent — use whichever is in front of you:

- **From chat.** Copy [`integrations/hermes/SKILL.md`](integrations/hermes/SKILL.md) into `~/.hermes/skills/devops/rocky-triage/` and set `ROCKY_PROJECT_DIR`. Replying "approve 42" in any chat Hermes is in then runs `rocky approve 42`. The skill's first rule is that it may only approve tickets you named in that conversation — an agent that approves on its own initiative has deleted the only safeguard in the pipeline.
- **From the dashboard.** `rocky serve` opens a local page listing what's waiting, what the agent is working on, and what shipped. It binds to `127.0.0.1` by default because the buttons on it authorize code changes; `--token` and `--host` are there for tunnelling, in that order of preference. One HTML file, no build step, no dependency — if you'd rather run a real React app, point it at `GET /api/board` and the two POST routes, which are the whole contract.
- **From the tracker.** Add the `approved` label by hand. Rocky picks it up on its next pass like any other.

## Sources and sinks

| | ships | escape hatch |
|---|---|---|
| **sources** | `sentrySource` (Sentry cloud + GlitchTip), `gmailSource`, `slackSource` (+ `reactionTrigger`: a human's emoji is the filter), `webhookSource` | `webhookSource({ map })` accepts any POST; or implement `Source` — it's one method |
| **sinks** | `githubSink` (Issues + labels), `linearSink` | implement `Sink` — three methods, plus four optional ones for the approval loop |
| **notifiers** | `hermesNotifier` (Telegram, Slack, Discord, Signal, WhatsApp, email — anything Hermes is configured for), `consoleNotifier` | implement `Notifier` — one method |

Duplicates are never dropped: `annotate` comments on the existing ticket with who reported it and a link back to the source, so frequency and affected-user signal accumulates where the fix will happen. The same error firing another 400 times produces zero further messages — that silence is the product.

## Design rules

- The matcher is pure: no I/O except the one injected tier-3 call, config passed in, never imported.
- Zero runtime dependencies except the `openai` SDK (and that only loads if you use `openaiProvider`).
- No plugin system, no config DSL, no web UI — a `Source` is `{ name, poll }`, a `Sink` is three functions (four more for the gate), a `Notifier` is one, and that's the whole extension story on purpose.
- Rocky decides *what* to say; the notifier decides only *how it travels*. So the wording is identical whether it reaches you over Telegram or a terminal, and a new platform is an adapter rather than a fork.
- Every failure direction is the safe one. A notifier that throws holds the ticket's phase so the next pass retries rather than losing a bug you never heard about; a resolution lookup that fails leaves the ticket approved rather than claiming it shipped.
- Everything tunable lives in one config object with documented defaults, and the eval harness exists so you never have to trust those defaults.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) has the setup and, more usefully, the seven
rules this codebase holds itself to — a change that breaks one is a bug even if
the tests pass. If you hit a matching mistake, the most valuable thing you can
send is the two texts: they become a labeled eval pair.

Security notes, including what rocky can reach and why the gate is a boundary
rather than a convention, are in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
