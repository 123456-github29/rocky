# Handing off to your task runner

Rocky is **upstream** of agent task runners, not competing with them. The
division of labor:

```
  reports            rocky                      your tracker            your runner
┌──────────┐   ┌────────────────┐   create   ┌──────────────┐  label/  ┌─────────────────┐
│ sentry   │   │ dedupe against │ ─────────→ │ labeled      │  state   │ cyrus / sortie / │
│ gmail    │ → │ open tickets,  │            │ ticket       │ ───────→ │ symphony /       │
│ slack    │   │ 3 tiers        │  annotate  │              │  gate    │ claude-code-     │
│ webhook  │   │                │ ─────────→ │ + comment on │          │ action           │
└──────────┘   └────────────────┘            │ existing     │          │ …opens the PR    │
                                             └──────────────┘          └─────────────────┘
```

Rocky creates the labeled ticket; the runner executes it. Runners all start
from "an issue exists" — rocky is the thing that makes the issue exist exactly
once, with the evidence attached.

## The contract rocky upholds

Every ticket rocky creates has:

- a **title** (the report's title, or its first line);
- the **original report text**, then a footer with `source`, `reported by`,
  `occurred at`, and a **link back to the source** (the Sentry issue, the
  email, the Slack message);
- your configured **labels** (`labels: ['rocky']` in `rocky.config.ts`);
- a machine-readable **fingerprint marker** (an HTML comment on GitHub, a
  trailing `rocky:fingerprint:` line on Linear) so recurrences keep matching
  this ticket.

Every **duplicate** becomes a comment on the existing ticket — reporter, source
link, quoted text — never a new work item. Your runner sees one ticket
accumulating evidence ("fired 60 times, three customers wrote in"), which is
exactly the prioritization signal a human needs before pointing an agent at it.

## The two-label human gate (recommended)

Let rocky file with one label (`rocky`) and let your runner trigger on a
*different* one (`approved`). A human reads the ticket, decides it is real and
well-scoped, and adds the runner's label. Rocky fills the funnel; a person
opens the gate; the runner executes. Fully automatic filing plus fully
automatic fixing with no human in between is how you wake up to seventeen PRs
that fix the same non-bug.

## GitHub Issues → claude-code-action

Rocky's `githubSink` files issues; a workflow triggers the runner when a human
adds the gate label:

```yaml
name: execute-approved-tickets
on:
  issues:
    types: [labeled]

jobs:
  execute:
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
            Fix the bug in issue #${{ github.event.issue.number }}. The issue
            body is a rocky-filed report: it includes the original text, the
            source, and a link back to where it came from — follow the link if
            you need more context. Read the issue's comments too: duplicate
            reports rocky attached there often contain extra reproduction
            detail. Open a pull request with the fix.
```

(Auth and trigger options vary — see the
[claude-code-action docs](https://github.com/anthropics/claude-code-action).)

## Linear → cyrus

[Cyrus](https://github.com/ceedaragents/cyrus) watches Linear and runs Claude
Code sessions against issues that enter the states/assignments it is
configured for. Point rocky's `linearSink` at the same team:

```ts
sink: linearSink({ apiKey: process.env.LINEAR_API_KEY!, team: 'ENG' }),
labels: ['rocky'],
```

New rocky tickets land in the team's default entry state (usually **Triage**),
which rocky maps to its `open` state. Keep cyrus watching a *later* state (or
its assignment) — a human drags the issue forward when it's real, and that
drag is the gate. Rocky's state mapping is designed around this funnel:
triage/backlog → `open`, unstarted → `approved`, started → `in_progress`.

## sortie, symphony, and anything else

Same contract, same pattern: find the trigger your runner keys on — a label, a
state transition, an assignee — and make that trigger the thing a human adds,
not the thing rocky adds. Rocky's job ends at "a deduplicated, evidence-rich,
labeled ticket exists"; from there, any runner that can read a ticket can
execute it. If your runner can be triggered by webhook instead of by polling
the tracker, trigger it from the tracker's own automation on the gate label.
