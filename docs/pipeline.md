# The full loop: GlitchTip → rocky → Hermes → Claude Code

Four open-source pieces, each doing one job, wired into a loop that ends where
it started: a bug is reported, and later you are told it is fixed.

```
 ┌──────────────┐   errors + comms      ┌──────────────────┐
 │  glitchtip   │ ────────────────────→ │      rocky       │
 │  gmail       │                       │  dedupe, decide  │
 │  slack       │                       └────────┬─────────┘
 └──────────────┘                                │ one ticket per distinct bug
        ▲                                        ▼
        │                              ┌──────────────────┐
        │                              │ github / linear  │
        │                              │  label: rocky    │
        │                              └────────┬─────────┘
        │                                       │ "approve #42?"
        │                                       ▼
        │                              ┌──────────────────┐
        │                              │      hermes      │
        │                              │ telegram/slack/… │
        │                              └────────┬─────────┘
        │                                       │ you reply "approve 42"
        │                                       ▼
        │                              ┌──────────────────┐
        │                              │ label: approved  │
        │                              └────────┬─────────┘
        │                                       ▼
        │                              ┌──────────────────┐
        │        fix ships             │   claude code    │
        └───────────────────────────── │  opens the PR    │
                 "Done — #42"          └──────────────────┘
```

Nobody here is a framework for the others. Rocky does not know what Hermes is
made of, Hermes does not know how rocky decides duplicates, and neither one
writes code. The only shared vocabulary is a ticket and two labels.

## What each piece is responsible for

| Piece | Job | Why not one of the others |
|---|---|---|
| **GlitchTip** | Group raw errors into issues, keep the stack traces | Self-hosted, Sentry-API-compatible, and already the thing your app reports to |
| **rocky** | Decide what is a *new* bug and what is the same bug again; file one ticket per distinct bug; run the approval loop | Deduplication needs an eval harness and a fail-safe bias. It is the one job here you must be able to measure |
| **Hermes** | Reach you wherever you are, and turn your reply into a command | It already holds the tokens for Telegram, Slack, Discord, Signal, WhatsApp, and email. Rocky reimplementing that would be a worse Hermes |
| **Claude Code** | Read the ticket, write the fix, open the PR | The only piece that touches your codebase |

## The two labels

Everything hangs off two labels on the ticket:

- **`rocky`** — rocky filed this. It defines rocky's funnel: `rocky watch`
  follows exactly the open tickets carrying it.
- **`approved`** — a human said yes. This is the gate.

That is the whole protocol. It matters that approval is a *label on the ticket*
and not a row in rocky's state file:

- you can approve from a Telegram reply, from the GitHub UI on your phone, or
  by a teammate clicking a button, and all three look identical to rocky;
- `rocky approve` works from any machine, because the tracker is the shared
  truth;
- losing rocky's state file re-asks about open tickets, which is noisy. It can
  never cause rocky to act on something you did not approve.

Point your coding agent's trigger at `approved`, never at `rocky`. Filing is
automatic; fixing is not.

## Wiring it up

### 1. Reports in

```ts
// rocky.config.ts
import { defineConfig, sentrySource, slackSource, githubSink, hermesNotifier, openaiProvider } from 'rocky-triage'

export default defineConfig({
  sources: [
    // GlitchTip speaks the Sentry API — same adapter, your own baseUrl.
    sentrySource({
      name: 'glitchtip',
      baseUrl: 'https://glitchtip.internal',
      token: process.env.GLITCHTIP_TOKEN!,
      org: 'acme',
      project: 'api',
    }),
    slackSource({
      token: process.env.SLACK_TOKEN!,
      channel: 'C0BUGREPORTS',
    }),
  ],
  sink: githubSink({
    token: process.env.GITHUB_TOKEN!,
    owner: 'acme',
    repo: 'api',
  }),
  labels: ['rocky'],
  approveLabel: 'approved',
  notify: hermesNotifier({ to: 'telegram' }),
  match: { llm: openaiProvider() },
})
```

### 2. Messages out

`hermesNotifier({ to: 'telegram' })` shells out to `hermes send`, which reuses
the credentials the Hermes gateway already has. `hermes send --list` shows
every target available; `slack:#eng`, `discord:#ops`, `signal:+1555…` and
`email` all work the same way.

If rocky runs somewhere the Hermes CLI does not, use the webhook transport
instead — see `integrations/hermes/config.example.yaml`.

### 3. Replies in

Three routes, all equivalent because approval is just a label.

**The dashboard.** `npx rocky serve` opens a page at `http://127.0.0.1:4711`
listing what is waiting, what the agent is working on, and what shipped:

```bash
npx rocky serve                                  # localhost only
npx rocky serve --host 0.0.0.0 --token "$SECRET" # if you must expose it
```

It binds to loopback by default because its buttons authorize changes to your
codebase. Prefer an SSH tunnel over `--host 0.0.0.0`; if you do expose it, the
token is not optional.

The page is one self-contained HTML file with no build step and no
dependencies. To run your own UI instead, it is three routes:
`GET /api/board`, `POST /api/tickets/:id/approve`, `POST /api/tickets/:id/deny`.

**A chat reply.** Install the skill so "approve 42" becomes an approval:

```bash
mkdir -p ~/.hermes/skills/devops/rocky-triage
cp integrations/hermes/SKILL.md ~/.hermes/skills/devops/rocky-triage/
echo 'ROCKY_PROJECT_DIR=/path/to/your/repo' >> ~/.hermes/.env
```

The skill's first rule is that it may only approve tickets you named in that
conversation. An agent that approves on its own initiative has deleted the only
safeguard in the pipeline, so this is stated as loudly as it can be stated.

**The tracker itself.** Add the `approved` label by hand in GitHub or Linear.
Rocky picks it up on its next pass, exactly as if you had used either of the
other two.

### 4. The fix

A workflow triggers on the gate label:

```yaml
name: fix-approved-tickets
on:
  issues:
    types: [labeled]

jobs:
  fix:
    if: github.event.label.name == 'approved'
    runs-on: ubuntu-latest
    permissions:
      contents: write
      issues: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: anthropics/claude-code-action@v1
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          prompt: |
            Fix the bug in issue #${{ github.event.issue.number }}. The body is
            a rocky-filed report: original text, source, and a link back to
            where it came from. Read the comments too — duplicate reports rocky
            attached there often carry the reproduction detail the first one
            lacked. Open a pull request that closes this issue.
```

Write "Closes #42" in the PR body. That is how the issue closes on merge, and
the issue closing is how rocky knows to tell you it is done.

### 5. The schedule

```bash
hermes cron create "every 15m" \
  "Run: cd $ROCKY_PROJECT_DIR && npx rocky run --live" \
  --name "rocky: poll for new bugs" --no-agent

hermes cron create "every 5m" \
  "Run: cd $ROCKY_PROJECT_DIR && npx rocky watch --live" \
  --name "rocky: approval loop" --no-agent
```

`--no-agent` runs the command and delivers stdout verbatim — no LLM call, and
no possibility of an agent deciding to be helpful by approving something.

## What you actually see

Four messages per bug, at most:

```
Approve fix for #42: Voice pipeline crashes on empty transcript
  TypeError: Cannot read properties of undefined (reading 'length')
  at transcribe (src/voice/pipeline.ts:88)
  Ticket: https://github.com/acme/api/issues/42
  Reply approve #42 to let the coding agent start, or deny #42 to drop it.

  → you: approve 42

Working on #42: Voice pipeline crashes on empty transcript
  Approved. The coding agent has the gate open on #42.

Done — #42: Voice pipeline crashes on empty transcript
  #42 is closed.
  Fix: https://github.com/acme/api/pull/117
```

The same error firing another 400 times produces zero further messages — it
lands as comments on #42. That silence is the product.

## Before you turn it on

Run the whole thing in dry-run first. Both loops default to it:

```bash
npx rocky run      # prints the dedup decisions, writes nothing
npx rocky watch    # prints the messages it would send, sends nothing
```

Read a week of that. You are checking two things, and only one of them is about
message volume:

1. **Are the dedup decisions right?** Every false merge is a real bug report
   buried in a comment thread on an unrelated ticket. Tune with
   `rocky eval` against your own labeled pairs — see the README.
2. **Is the approval message enough to decide on?** If you find yourself
   opening the tracker every time, the ticket bodies are too thin; fix that
   before you are answering these on a phone.

Add `--live` to each loop separately, `run` first. There is no step where
turning both on at once is the right call.
