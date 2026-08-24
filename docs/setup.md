# Connecting rocky to your stack

What you actually have to do, in order, and what each credential is for.

Budget about **30 minutes of setup**, then a **week of dry-run**, then an
**afternoon writing eval pairs** before you let anything run live. The setup is
the easy part; the two waiting periods are what make it safe.

## 1. Install

```bash
npm install --save-dev github:123456-github29/rocky
npx rocky init
```

`init` writes `rocky.config.ts` and `eval/pairs.json`. If your `package.json`
has no `"type": "module"`, it will tell you to add one (or rename the config to
`rocky.config.mts`).

## 2. Get the credentials

Everything goes in environment variables. Rocky never stores a token — it reads
them from your config at startup and never writes them to the state file, ticket
bodies, or logs.

| Piece | What you need | Where it comes from | Scope |
|---|---|---|---|
| **GlitchTip** (or Sentry) | auth token, org slug, project slug, your instance URL | GlitchTip: Profile → Auth Tokens. Sentry: Settings → Auth Tokens | project read |
| **GitHub Issues** | token, owner, repo | Settings → Developer settings → Personal access tokens. In Actions, `${{ github.token }}` already works | `issues: write` (fine-grained: Issues read+write) |
| **Linear** *(instead of GitHub)* | API key, team key (`ENG`) or team UUID | Linear → Settings → API → Personal API keys | default is fine |
| **An LLM** *(strongly recommended)* | `OPENAI_API_KEY`, or any OpenAI-compatible endpoint, or your own function | platform.openai.com → API keys. Or run a local model — see below | — |
| **Gmail** *(optional source)* | OAuth client id, client secret, refresh token | Google Cloud Console → OAuth 2.0 Client IDs | `gmail.readonly` |
| **Slack** *(optional source)* | bot token (`xoxb-…`), **channel ID** (not the name) | api.slack.com → your app → OAuth & Permissions | `channels:history` |
| **Hermes** *(optional, for messages)* | a configured Hermes gateway | [hermes-agent](https://github.com/nousresearch/hermes-agent); `hermes send --list` shows your targets | — |

Only two are strictly required: **one source** and **one sink**. Rocky runs with
no LLM at all and prints its messages instead of sending them — but without a
model it is a router, not an engineer, so in practice you want the third.

### Two modes, and you want the first one

**Investigation mode** (`investigator` set). Each cycle, one model reads your
whole log window and returns ranked problems:

```ts
investigator: openaiProvider({ model: 'gpt-5.4' }),
```

It groups error signatures by root cause, weighs user impact against event
volume, reads the shape over time from occurrence counts and first-seen, and
leaves noise out. Each finding cites the log entries it rests on, and those
citations become the ticket's evidence section — and its identity, so
re-investigating the same logs updates one ticket rather than filing another.

This is the judgement call in the pipeline. One call per cycle, reading
everything. Point it at your best model.

**Triage mode** (no `investigator`). Rocky drops to a router: each incoming
report is matched against your open tickets one at a time and filed or
commented. Cheaper, never wrong, and blind to everything above — it can only
mirror your error tracker's own grouping. That mode uses two other providers:

| | `analyst` | `match.llm` (tier 3) |
|---|---|---|
| answers | "what needs to be done about this bug?" | "is this the same bug as that one?" |
| runs | once per **new** bug | only on reports similarity cannot settle |
| wants | your best model | usually a small one |

**These are mutually exclusive.** With an `investigator` set, `analyst` and
`match.llm` are never called — the finding *is* the brief, and dedup happens by
cited signature. Configuring all three means paying for models you never call,
so `rocky doctor` warns about exactly that.

Whichever mode, a **hypothesis is labelled as one** on every surface that shows
it, and the evidence always travels with the conclusion. When confidence is low
the ticket says so outright, because "this needs a human before anyone writes
code" is the most useful thing triage can say.

### It does not have to be OpenAI, and it does not have to leave your network

`LLMProvider` is one function, so any provider works. `openaiProvider({ baseUrl })`
points at any OpenAI-compatible endpoint, which matters more here than it did
for deduplication: an investigation sends **stack traces, customer emails, and
whatever your users typed into a bug form** to whichever model you choose. Plenty
of teams cannot send that to a third party. They do not have to.

```ts
// Ollama, LM Studio, vLLM, Together, Groq, OpenRouter, an internal gateway.
investigator: openaiProvider({
  baseUrl: 'http://localhost:11434/v1',
  apiKey: 'ollama',
  model: 'qwen2.5:32b',
}),

// Or anything at all.
investigator: async (prompt) => (await myProvider.complete(prompt)).text,
```

A local model is a real option for investigation, though it is the hardest job
in the pipeline — reading a hundred signatures and reasoning about root cause.
Start with a strong hosted model to see what good looks like, then try swapping
it and compare the findings side by side.

A minimal working config:

```ts
import { defineConfig, sentrySource, githubSink, openaiProvider } from 'rocky-triage'

export default defineConfig({
  sources: [
    sentrySource({
      name: 'glitchtip',
      baseUrl: 'https://glitchtip.yourcompany.com',   // omit for Sentry cloud
      token: process.env.GLITCHTIP_TOKEN!,
      org: 'your-org',
      project: 'your-project',
    }),
  ],
  sink: githubSink({
    token: process.env.GITHUB_TOKEN!,
    owner: 'your-org',
    repo: 'your-repo',
  }),
  labels: ['rocky'],
  approveLabel: 'approved',
  investigator: openaiProvider({ model: 'gpt-5.4' }),
})
```

## 3. Check it before you trust it

```bash
npx rocky doctor
```

This is the step people skip and regret. It calls every configured source,
sink, and provider **for real**, writes nothing, and tells you exactly what is
wrong — including the failures that are otherwise silent for a week:

- a source that authenticates fine but returns nothing (wrong query or channel);
- a source whose reports carry **no signatures**, which is what findings use to
  stay attached to their tickets across cycles;
- a provider you configured that will never be called in the mode you are in;
- tickets already carrying your approve label that aren't in rocky's funnel —
  a label mismatch rocky would ignore forever;
- a network policy blocking you, distinguished from a bad token.

Fix everything it marks `✗` before going further.

## 4. The step that is not optional

What you have to check before going live depends on your mode.

**In investigation mode**, read the findings. `rocky run` prints every one with
its evidence, its priority, and its reasoning. You are asking: does it find the
things you would have found, does it leave out the noise you would have left
out, and does it rank them the way you would rank them? There is no substitute
for reading a week of this, and there is currently **no automated eval for
investigation quality** — that gap is real and worth knowing about.

**In triage mode**, write ~30 labeled pairs from your own bug history into
`eval/pairs.json` and tune. This is the part that is not "plug in an API key",
and it is the part that decides whether the router helps you or quietly buries
bug reports.

```json
[{ "id": 1, "a": "<a real report>", "b": "<the ticket it duplicated>", "same": true }]
```

Make roughly half `same: false`, and make those **hard** — different bugs that
sound alike, the same error text in a different component. Then:

```bash
npx rocky eval
```

Tune `highThreshold` / `lowThreshold` until **false merges are zero** and missed
duplicates are tolerable. The shipped defaults were tuned on rocky's ten example
pairs, which are a smoke test, not your bug tracker.

Why this matters more than it sounds: a missed duplicate costs a human thirty
seconds closing a dupe. A false merge takes a real bug report and hides it in a
comment thread on an unrelated ticket, where nobody will ever look at it again.
The two errors are not symmetric, so rocky never averages them into one score.

## 5. Watch it decide, before it does anything

```bash
npx rocky run     # prints its dedup decisions. Writes nothing.
npx rocky watch   # prints the messages it would send. Sends nothing.
```

Both are dry-run by default. Run them on a schedule for a week or two and
actually read the output. `run` logs which tier fired, the confidence, and the
reasoning for every decision. `watch` prints the full text of each approval
request — read those and ask whether you could decide from your phone without
opening the tracker. If not, your ticket bodies are too thin.

Then go live, one at a time, `run` first:

```bash
npx rocky run --live      # now it files tickets
npx rocky watch --live    # now it messages you
```

## 6. Connect your coding agent

**Rocky does not fix bugs and does not install your agent.** It gets a
deduplicated, evidence-rich ticket to the point where a human said yes. Wiring
what happens next is yours, and it is one rule:

> Trigger your agent on the **approve** label. Never on rocky's filing label.

For GitHub Issues + `claude-code-action`, that is a workflow keyed on
`issues: [labeled]` with `if: github.event.label.name == 'approved'` — the full
example is in [pipeline.md](pipeline.md). For Linear + cyrus, point cyrus at a
state a human drags the issue into. Any runner works; the trigger just has to be
the thing a person does, not the thing rocky does.

If you trigger on rocky's own label instead, you have removed the gate and rocky
will file straight into your codebase. Don't.

## 7. Schedule it

Two loops, different cadences. Any scheduler works — cron, GitHub Actions
([example](../examples/github-action.yml)), or Hermes
([example](../integrations/hermes/config.example.yaml)):

```bash
*/15 * * * *  cd /path/to/project && npx rocky run --live
*/5  * * * *  cd /path/to/project && npx rocky watch --live
```

`.rocky/state.json` must survive between runs — it holds the source cursors and
which tickets rocky has already asked you about. On stateless CI, cache it (the
Actions example uses a rolling `actions/cache` key). Losing it is safe but
wasteful: sources get re-polled and you get asked again about tickets you
already answered. It can never cause rocky to act on something you did not
approve — the tracker's label is the authority, not this file.

## Answering from wherever you are

Three routes, all equivalent, because approval is just a label:

- **Chat** — copy `integrations/hermes/SKILL.md` into
  `~/.hermes/skills/devops/rocky-triage/`, set `ROCKY_PROJECT_DIR`, and reply
  "approve 42" wherever Hermes reaches you.
- **Dashboard** — `npx rocky serve`, then `http://127.0.0.1:4711`. Binds to
  loopback because its buttons authorize code changes; use `--token` and an SSH
  tunnel if you need it elsewhere.
- **The tracker** — add the `approved` label by hand.

## What can go wrong

| Symptom | Cause |
|---|---|
| A ticket per error signature, not per problem | No `investigator` configured — you are in triage mode. |
| The same problem filed again every cycle | Your source supplies no signatures, so findings have nothing stable to attach to. `rocky doctor` flags this. |
| Findings that read like guesses | Check the evidence section on the ticket. If the cited logs do not support the claim, lower the model or raise what you expect of it — and remember rocky discards any finding citing logs that do not exist. |
| Two different bugs merged into one ticket (triage mode) | Thresholds too loose. `rocky eval` with the offending pair added, raise `highThreshold`. This is the failure to care about. |
| Nothing ever gets approved | Your agent is watching the wrong label, or `rocky watch --live` isn't scheduled. |
| Approval messages arrive but "done" never does | The PR isn't closing the issue. Put `Closes #42` in the PR body. |
| `rocky eval` says LLM calls failed | Your provider is broken, and that run says nothing about whether tier 3 helps. Fix the key and re-run. |
| "the investigation did not complete" | Not the same as clean logs. Rocky read nothing that pass and filed nothing; check the investigator provider. |
