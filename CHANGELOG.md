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

### The approval loop

- `rocky watch` asks about each new ticket, notices the approve label, and
  reports completion when the ticket closes.
- `rocky approve` / `rocky deny` / `rocky status`.
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
