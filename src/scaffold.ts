/** Templates written by `rocky init`. Kept as data so tests can validate them. */

export const CONFIG_TEMPLATE = `import { defineConfig, sentrySource, githubSink, openaiProvider } from 'rocky-triage'

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

  // Labels applied to every ticket rocky creates.
  labels: ['rocky'],

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
`
