/** Templates written by `rocky init`. Kept as data so tests can validate them. */

export const CONFIG_TEMPLATE = `import { defineConfig, sentrySource, githubSink, hermesNotifier, openaiProvider } from 'rocky-triage'

export default defineConfig({
  // Where bug reports come from. Add as many as you need — each keeps its own
  // cursor in the state file, keyed by its name. Also available: gmailSource,
  // slackSource (+ reactionTrigger), and webhookSource for anything else.
  sources: [
    sentrySource({
      token: process.env.SENTRY_TOKEN!,
      org: 'your-org',
      project: 'your-project',
      // baseUrl: 'https://app.glitchtip.com', // GlitchTip is API-compatible
    }),
  ],

  // Where tickets live. Also available: linearSink({ apiKey, team }).
  sink: githubSink({
    token: process.env.GITHUB_TOKEN!,
    owner: 'your-org',
    repo: 'your-repo',
  }),

  // Labels applied to every ticket rocky creates. The FIRST one defines
  // rocky's funnel: \`rocky watch\` follows exactly the open tickets carrying it.
  labels: ['rocky'],

  // The label that means "a human said yes". Adding it is the only thing that
  // moves a ticket past the gate — by \`rocky approve\`, by your agent, or by
  // hand in the tracker. Point your coding agent's trigger at THIS label, never
  // at the one above: filing is automatic, fixing is not.
  approveLabel: 'approved',

  // Where approval requests and completion notices go. Leave it out and
  // \`rocky watch\` prints them instead, which is the right setting until you
  // trust its decisions. Requires a configured Hermes gateway
  // (\`hermes send --list\` shows your targets); see docs/pipeline.md.
  // notify: hermesNotifier({ to: 'telegram' }),

  // Reads the logs and works out what is actually wrong with the service.
  // This is the piece that makes rocky more than a router: it looks at the
  // whole polled window, groups error signatures by root cause, weighs user
  // impact against noise, and returns ranked work items with the evidence each
  // one rests on. Those become your tickets.
  //
  // Leave it out and rocky falls back to per-report triage — cheaper, never
  // wrong, but it can only mirror your error tracker's own grouping. It cannot
  // notice that five signatures share one cause, or that the loudest error is
  // noise and the dangerous one fired eleven times.
  //
  // This is the judgement call in the pipeline. Point it at your best model.
  investigator: openaiProvider({ model: 'gpt-5.4' }),

  // ── Everything below belongs to TRIAGE MODE, and is never called while an
  // investigator is set above. Uncomment it only if you remove the
  // investigator; \`rocky doctor\` warns if you configure both.
  //
  // Triage mode is the fallback: each incoming report is matched against your
  // open tickets one at a time and filed or commented. Cheaper, never wrong,
  // and blind to everything an investigation sees — it can only mirror your
  // error tracker's own grouping.
  //
  // // Writes the brief on each NEW report: what broke, where, what the fix
  // // involves, what makes it risky.
  // analyst: openaiProvider({ model: 'gpt-5.4' }),
  //
  // match: {
  //   // Tier 3: one LLM call for reports string similarity cannot settle.
  //   // Omit to run tiers 1–2 only — ambiguous reports then become new
  //   // tickets instead of consulting a model. Nothing is ever merged on a
  //   // guess either way. A small model is usually right here: it answers
  //   // "same bug?", not "what should we do?".
  //   llm: openaiProvider({ model: 'gpt-5.4-mini' }),
  //
  //   // Tune against YOUR labeled pairs with \`rocky eval\`. The defaults were
  //   // tuned on rocky's example pairs, not on your bug tracker, and a
  //   // deduplicator you have not measured is a duplicate factory.
  //   // highThreshold: 0.82,
  //   // lowThreshold: 0.25,
  //   // llmMinConfidence: 0.7,
  // },

  // statePath: '.rocky/state.json',
  // pairsPath: 'eval/pairs.json',
})
`

export const PAIRS_TEMPLATE = `[
  {
    "id": "example-1",
    "a": "REPLACE ME: paste a real bug report from your history (an email, a Sentry title, a Slack message)",
    "b": "REPLACE ME: paste the text of the ticket it duplicated",
    "same": true,
    "note": "Aim for ~30 pairs drawn from your real bug history. Keep roughly half of them same:false."
  },
  {
    "id": "example-2",
    "a": "REPLACE ME: a report that is NOT a duplicate of b",
    "b": "REPLACE ME: a different bug that merely sounds alike (same subsystem, same error type)",
    "same": false,
    "note": "These hard negatives matter most: identical error text in a different component must stay separate. Then run \`rocky eval\` and tune thresholds until false merges are zero. Delete both example pairs."
  }
]
`

export const INIT_NEXT_STEPS = `rocky is scaffolded. The order of operations matters:

  1. Fill in rocky.config.ts — sources, sink, and tokens via environment
     variables. Point \`investigator\` at your best model; it is the piece that
     reads your logs and works out what is actually wrong.
  2. Run \`rocky doctor\`. It calls every configured source, sink, and provider
     for real, writes nothing, and names what is broken. Fix every ✗.
  3. Run \`rocky run\` (dry-run is the default) on a schedule and READ THE
     FINDINGS for a week or two. It writes nothing. You are asking: does it
     surface what you would have surfaced, leave out the noise you would have
     left out, and rank them the way you would? Check the evidence on each —
     a finding whose cited logs do not support it is the failure to catch.
     There is no automated eval for this yet; your reading is the eval.
  4. Only then: \`rocky run --live\`, and persist .rocky/state.json between runs
     (add .rocky/ to .gitignore; on CI, cache or commit it deliberately).

Then close the loop — approval out, approval back, "done" at the end:

  5. Run \`rocky watch\` (also dry-run by default) to see the approval messages
     rocky would send you. Read them: if you would open the tracker anyway to
     decide, the findings are too thin.
  6. Configure \`notify\` to deliver them for real, then \`rocky watch --live\`.
  7. Trigger your coding agent on the approve label, never on the rocky label.
     Filing is automatic; fixing is not.

eval/pairs.json is only used in triage mode (no investigator). If you go that
route, fill it in and tune with \`rocky eval\` before going live.

See docs/setup.md to get connected, and docs/pipeline.md for the whole loop.
`
