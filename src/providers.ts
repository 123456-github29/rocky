import type { LLMProvider } from './types'
import { defaultConfig } from './config'

export interface OpenAIProviderOptions {
  /** Defaults to the OPENAI_API_KEY environment variable (resolved by the SDK). */
  apiKey?: string
  /** Model id. Defaults to `defaultConfig.model`. */
  model?: string
  /** Cap on response tokens (`max_completion_tokens`). The expected response is one small JSON object. */
  maxTokens?: number
  /** Request timeout in milliseconds. One tier-3 call should never hang a polling loop for long. */
  timeoutMs?: number
  /** Point at an OpenAI-compatible gateway instead of api.openai.com. */
  baseUrl?: string
  /**
   * Ask the API to enforce JSON output (`response_format: json_object`).
   * OpenAI requires the word "JSON" somewhere in the prompt for this — the
   * default template satisfies that. Set false if a custom template does not.
   */
  jsonMode?: boolean
  /** Custom fetch implementation (testing, instrumented proxies). */
  fetch?: typeof globalThis.fetch
}

/**
 * The shipped tier-3 provider: one OpenAI chat-completions call per ambiguous
 * report. Lazily imports the `openai` SDK on first use so that importing this
 * library stays cheap for consumers who inject their own `LLMProvider`.
 */
export function openaiProvider(options: OpenAIProviderOptions = {}): LLMProvider {
  const {
    apiKey,
    model = defaultConfig.model,
    maxTokens = 1024,
    timeoutMs = 60_000,
    baseUrl,
    jsonMode = true,
    fetch,
  } = options

  let clientPromise: Promise<InstanceType<typeof import('openai').default>> | null = null
  const createClient = async () => {
    let OpenAI: typeof import('openai').default
    try {
      OpenAI = (await import('openai')).default
    } catch {
      throw new Error(
        "openaiProvider requires the 'openai' package (npm install openai) — or inject your own LLMProvider instead.",
      )
    }
    return new OpenAI({ apiKey, baseURL: baseUrl, timeout: timeoutMs, fetch })
  }

  return async (prompt) => {
    clientPromise ??= createClient()
    const client = await clientPromise
    const response = await client.chat.completions.create({
      model,
      max_completion_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
      ...(jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
    })
    const choice = response.choices[0]
    const text = choice?.message?.content
    if (typeof text !== 'string' || text === '') {
      const refusal = choice?.message?.refusal
      throw new Error(refusal ? `OpenAI refused the request: ${refusal}` : 'OpenAI returned no text content')
    }
    return text
  }
}
