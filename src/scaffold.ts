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

  // Writes the brief on each NEW bug — what broke, where, what the fix involves,
  // what makes it risky. It heads the ticket body, so it is what you read to
  // approve and what the coding agent reads to start. Without it a ticket
  // carries the raw stack trace, which is not something you can decide on from
  // a phone.
  //
  // Deliberately a different provider from the matcher's below: dedup is a
  // cheap yes/no on every report, this runs once per distinct bug and is read
  // by a human about to change production code. Point it at your best model.
  analyst: openaiProvider({ model: 'gpt-5.4' }),

  match: {
    // Tier 3: one LLM call for reports that string similarity cannot settle.
    // Remove this line to run tiers 1–2 only — ambiguous reports then become
    // new tickets instead of consulting a model. Nothing is ever merged on a
    // guess either way.
    llm: openaiProvider(),

    // Tune these against YOUR labeled pairs with \`rocky eval\`. The defaults
    // were tuned on rocky's example pairs, not on your bug tracker, and a
    // deduplicator you have not measured is a duplicate factory.
    // highThreshold: 0.82,
    // lowThreshold: 0.25,
    // llmMinConfidence: 0.7,

    // A smaller model is usually right here — it is answering "same bug?",
    // not writing the brief. Measure the swap with \`rocky eval\`.
    // model: 'gpt-5.4-mini',
  },

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

  1. Fill in rocky.config.ts (sources, sink, tokens via environment variables).
  2. Write ~30 labeled pairs from your real bug history into eval/pairs.json.
     This is not optional homework — an untuned deduplicator is a duplicate
     factory, and the pairs are how you find out before your tracker does.
  3. Run \`rocky eval\` and tune thresholds until false merges are ZERO and
     missed duplicates are tolerable.
  4. Run \`rocky run\` (dry-run is the default) on a schedule and read its
     decisions for a week or two. It writes nothing.
  5. Only then: \`rocky run --live\`, and persist .rocky/state.json between
     runs (add .rocky/ to .gitignore; on CI, cache or commit it deliberately).

Then close the loop — approval out, approval back, "done" at the end:

  6. Run \`rocky watch\` (also dry-run by default) to see the approval messages
     rocky would send you. Read them: if you would open the tracker anyway to
     decide, the ticket bodies are too thin.
  7. Configure \`notify\` to deliver them for real, then \`rocky watch --live\`.
  8. Trigger your coding agent on the approve label, not on the rocky label.

See docs/pipeline.md for the whole loop wired end to end.
`
