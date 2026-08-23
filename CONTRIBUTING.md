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

1. **A false merge is much worse than a missed duplicate.** Every uncertainty
   resolves to "new ticket". Unparseable model output, a hallucinated ticket
   id, confidence below the threshold, a provider that throws, no provider at
   all — all of it fails safe to no-match. If you add a code path that can
   merge two reports, it needs a test proving it cannot fire on garbage input.

2. **The matcher is pure.** `src/match.ts` does no I/O except the one injected
   tier-3 call, and imports no SDK. Config is passed in, never read from the
   environment. This is what makes the eval harness meaningful.

3. **Nothing acts without a human.** Only a label a person added moves a ticket
   past the gate. No code path may add the approve label on rocky's own
   initiative, and that includes anything an LLM decides. The Hermes skill
   states this at the top for the same reason.

4. **Dry-run is the default on every command that writes or sends.** `--live`
   is opt-in, always.

5. **Failures hold, they do not skip.** A notifier that throws leaves the
   ticket's phase alone so the next pass retries; a resolution lookup that
   fails leaves the ticket approved rather than claiming it shipped. Losing a
   bug you never heard about is the failure mode to design against.

6. **A misleading measurement is worse than no measurement.** The eval harness
   reports missed duplicates and false merges separately and never as one F1
   score, because the costs are wildly asymmetric. When a run cannot support a
   conclusion — every LLM call failed, say — it must say so instead of printing
   a number that reads like a verdict.

7. **Zero runtime dependencies except `openai`**, and that only loads if you
   call `openaiProvider()`. A new dependency needs a strong argument.

## Adding a source

A `Source` is `{ name, poll(cursor) }`. Return reports oldest-first and the
next cursor. Points worth getting right:

- **Fingerprints.** If the upstream system already groups events (Sentry,
  GlitchTip), pass that group id as `fingerprint` — it makes every recurrence a
  free tier-1 match. If it does not, leave it null rather than inventing one.
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
