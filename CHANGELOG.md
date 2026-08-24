# Changelog

## 0.1.0 — unreleased

First release. Everything below is new.

### Deduplication

- Three-tier matcher: fingerprint equality, Sørensen–Dice similarity on
  normalized text, then one LLM call for the ambiguous middle only. Every
  uncertainty resolves to "new ticket" — nothing is merged on a guess.
- Eval harness (`rocky eval`) reporting missed duplicates and false merges as
  separate counts, a tiers-1–2 baseline for comparison, and what the LLM tier
  actually buys over it. Failed LLM calls are counted apart from answered ones,
  and the delta is withheld entirely when every call failed.

### Sources and sinks

- Sources: `sentrySource` (Sentry cloud and GlitchTip), `gmailSource`,
  `slackSource` with `reactionTrigger`, `webhookSource`.
- Sinks: `githubSink` and `linearSink`, both round-tripping the fingerprint
  through the ticket body so recurrences keep matching.

### Investigation

- `investigator`: one model reads the whole polled log window each cycle and
  returns ranked work items — signatures grouped by root cause, user impact
  weighed against event volume, the shape over time read from occurrence counts
  and first-seen. Set it and this replaces per-report triage.
- Every finding cites the log entries it rests on. That is what lets a human
  check the work, and what gives the finding a stable identity: findings map to
  tickets by cited signature, never by wording, so re-investigating the same
  logs updates one ticket instead of filing another copy every cycle.
- A finding citing reports that do not exist is discarded — an uncheckable
  diagnosis is the one thing this must not emit.
- A failed investigation is reported as a failure, never as clean logs. Both
  file nothing; one means the service is healthy and the other means rocky read
  nothing at all.
- Tickets now carry every signature they cover, so one work item can stand for
  several error groups.

### Triage

- `analyst`: a model writes a brief on each **new** bug — what broke, where,
  what the fix involves, what makes it risky, and how confident it is. It heads
  the ticket body, so it is what a human reads to approve and what the coding
  agent reads to start. Separate from the matcher's provider, because the two
  jobs want different models.
- Never runs for a duplicate, so its cost tracks distinct bugs rather than error
  volume. A failure never blocks filing.
- The original report always travels with it in full, and every surface labels
  the brief a hypothesis.

### The approval loop

- `rocky watch` asks about each new ticket, notices the approve label, and
  reports completion when the ticket closes.
- `rocky approve` / `rocky deny` / `rocky status`. Approving fires `onApprove` immediately, so the work starts on the click rather than at the next poll.
- `rocky serve`: a local dashboard, no build step and no dependencies.
- `hermesNotifier` delivers over Telegram, Slack, Discord, Signal, WhatsApp, or
  email through a Hermes gateway — by CLI or by signed webhook.
- A Hermes skill in `integrations/hermes/` so a chat reply records the decision.

### Operations

- `rocky doctor` checks every configured source, sink, and provider against the
  real APIs and writes nothing, with a diagnosis per failure.
- Dry-run is the default on `run` and `watch`; `--live` is always opt-in.
- State persists cursors, a seen-list, and approval phases, written atomically.

### Security

- `rocky serve` rejects cross-site writes. A plain form POST is a "simple
  request", so without this any page a viewer visited while the dashboard ran
  could approve a ticket — and approving triggers a coding agent.
- Ticket ids are URL-encoded as single path segments in the GitHub sink. Raw,
  an id of `1/../../../../orgs/x/memberships` reached a different GitHub
  endpoint with the user's token.
- Both the investigation and analysis prompts state that log and report text is
  data, never instructions. Logs are attacker-influenced, and in investigation
  mode the model's output is read by a coding agent — so `SECURITY.md` now sets
  out that threat model honestly rather than claiming, as it did when the
  matcher was the only LLM step, that a manipulated response cannot reach your
  codebase. It can. The gate is what stops it.
