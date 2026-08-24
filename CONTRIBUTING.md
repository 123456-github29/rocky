# Contributing

## Getting set up

```bash
git clone https://github.com/123456-github29/rocky
cd rocky
npm ci
npm test          # 161 tests, no network, no credentials needed
npm run typecheck
npm run build
```

Every test runs against an injected fake `fetch` or an in-memory sink. If a
change makes the suite need a network connection or a token, that is the thing
to reconsider — not the CI config.

## The rules this codebase actually holds itself to

These are not style preferences. Breaking one of them is a bug even if the
tests pass.

1. **Never emit a conclusion nobody can check.** Every finding cites the log
   entries it rests on, and a citation not present in the window discards the
   whole finding. A diagnosis you cannot trace back to the logs is a rumour,
   and a coding agent will act on it. If you add a path that produces a claim,
   it needs a path that produces the evidence too.

2. **A false merge is much worse than a missed duplicate.** Every uncertainty
   resolves to "new ticket". Unparseable model output, a hallucinated ticket
   id, confidence below the threshold, a provider that throws, no provider at
   all — all of it fails safe. If you add a code path that can merge two
   reports, it needs a test proving it cannot fire on garbage input.

3. **Identity comes from signatures, never from prose.** The same problem
   investigated twice is worded differently every time. Anything that matches
   findings to tickets by model output will file a fresh copy every cycle —
   match on cited signatures.

4. **The matcher is pure.** `src/match.ts` does no I/O except the one injected
   tier-3 call, and imports no SDK. Config is passed in, never read from the
   environment. This is what makes the eval harness meaningful.

5. **Nothing acts without a human.** Only a label a person added moves a ticket
   past the gate. No code path may add the approve label on rocky's own
   initiative, and that includes anything an LLM decides. The Hermes skill
   states this at the top for the same reason.

6. **Dry-run is the default on every command that writes or sends.** `--live`
   is opt-in, always.

7. **Failures hold, they do not skip.** A notifier that throws leaves the
   ticket's phase alone so the next pass retries; a resolution lookup that
   fails leaves the ticket approved rather than claiming it shipped. Losing a
   bug you never heard about is the failure mode to design against.

8. **A misleading measurement is worse than no measurement.** The eval harness
   reports missed duplicates and false merges separately and never as one F1
   score, because the costs are wildly asymmetric. When a run cannot support a
   conclusion — every LLM call failed, say — it must say so instead of printing
   a number that reads like a verdict.

9. **Zero runtime dependencies except `openai`**, and that only loads if you
   call `openaiProvider()`. A new dependency needs a strong argument.

## Adding an investigator prompt

`DEFAULT_INVESTIGATION_TEMPLATE` in `src/investigate.ts` is the highest-leverage
text in the project — it decides what counts as a problem. If you change it,
say what you changed and why in the PR, and be aware that two instructions in it
are load-bearing rather than stylistic: that `reportIds` is mandatory (it is
what makes findings checkable and stable), and that log text is data rather than
instructions (logs are attacker-influenced and the output reaches a coding
agent).

## Adding a source

A `Source` is `{ name, poll(cursor) }`. Return reports oldest-first and the
next cursor. Points worth getting right:

- **Signatures.** If the upstream system already groups events (Sentry,
  GlitchTip), pass that group id as `fingerprint`. It is what keeps a finding
  attached to its ticket across cycles, and what makes a recurrence a free
  tier-1 match in triage mode. If the source has none, leave it null rather
  than inventing one.
- **`corpus`, and counts.** If the source can return standing state rather than
  only what is new, return it as `corpus` — an investigation cannot spot a
  regression without it. Populate `occurrences` and `firstSeen` where the API
  provides them: they are how volume gets told apart from impact.
- **Cursor overlap is fine, gaps are not.** Prefer re-delivering a boundary
  report (the seen-list turns it into a skip) over risking a missed one.
- **Throw on a bad response.** `run` contains a failing source without
  advancing its cursor, so throwing is safe and silence is not.

Test it with `apiFetch` from `test/api-fetch.ts`.

## Adding a sink

Three methods (`listOpen`, `create`, `annotate`) make it work with `rocky run`.
Four more (`listByLabel`, `setLabels`, `comment`, `resolution`) make it work
with the approval loop. Implement all seven unless the tracker genuinely cannot
do one, and if you skip any, `assertGatedSink` will name it for the user.

`create` must round-trip the fingerprint through the tracker somehow — an HTML
comment on GitHub, a trailing line on Linear — or recurrences will never
tier-1 match the ticket you filed for them.

## Adding a notifier

A `Notifier` is `{ name, send(message) }`. It decides *how a message travels*
and never *what it says* — the wording lives in `src/notify/format.ts` so that
an approval request reads identically over Telegram and over a terminal.

## Before you open a pull request

```bash
npm run typecheck && npm test && npm run build
```

Tests are expected with any behavior change. If you found a bug, the most
useful first commit is the failing test.
