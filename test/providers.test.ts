import { describe, expect, it } from 'vitest'
import { openaiProvider } from '../src/providers'

interface CapturedCall {
  url: string
  headers: Headers
  body: Record<string, unknown>
}

function fakeFetch(status: number, payload: unknown) {
  const calls: CapturedCall[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    calls.push({
      url: request.url,
      headers: request.headers,
      body: JSON.parse(String(init?.body ?? (await request.text()))) as Record<string, unknown>,
    })
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
  return { impl, calls }
}

function completion(content: string | null, refusal?: string) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'test-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content, ...(refusal ? { refusal } : {}) },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

describe('openaiProvider', () => {
  it('sends the prompt to chat/completions with the configured model and JSON mode, and returns the text', async () => {
    const { impl, calls } = fakeFetch(200, completion('{"matchId": null, "confidence": 0.9, "reasoning": "new"}'))
    const llm = openaiProvider({ apiKey: 'test-key', model: 'test-model', maxTokens: 512, fetch: impl })

    const text = await llm('Is this the same bug? Respond in JSON.')
    expect(text).toBe('{"matchId": null, "confidence": 0.9, "reasoning": "new"}')

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toContain('/chat/completions')
    expect(call.headers.get('authorization')).toBe('Bearer test-key')
    expect(call.body['model']).toBe('test-model')
    expect(call.body['max_completion_tokens']).toBe(512)
    expect(call.body['response_format']).toEqual({ type: 'json_object' })
    expect(call.body['messages']).toEqual([{ role: 'user', content: 'Is this the same bug? Respond in JSON.' }])
  })

  it('omits response_format when jsonMode is disabled', async () => {
    const { impl, calls } = fakeFetch(200, completion('ok'))
    const llm = openaiProvider({ apiKey: 'test-key', jsonMode: false, fetch: impl })
    await llm('prompt')
    expect(calls[0]!.body['response_format']).toBeUndefined()
  })

  it('targets an OpenAI-compatible gateway when baseUrl is set', async () => {
    const { impl, calls } = fakeFetch(200, completion('ok'))
    const llm = openaiProvider({ apiKey: 'test-key', baseUrl: 'https://gateway.example.com/v1', fetch: impl })
    await llm('prompt')
    expect(calls[0]!.url).toBe('https://gateway.example.com/v1/chat/completions')
  })

  it('throws on a refusal instead of returning empty text', async () => {
    const { impl } = fakeFetch(200, completion(null, 'I cannot help with that'))
    const llm = openaiProvider({ apiKey: 'test-key', fetch: impl })
    await expect(llm('prompt')).rejects.toThrow(/refused/)
  })

  it('throws when the response carries no text content', async () => {
    const { impl } = fakeFetch(200, completion(null))
    const llm = openaiProvider({ apiKey: 'test-key', fetch: impl })
    await expect(llm('prompt')).rejects.toThrow(/no text content/)
  })

  it('propagates API errors to the caller (the matcher turns them into safe no-matches)', async () => {
    const { impl } = fakeFetch(401, {
      error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' },
    })
    const llm = openaiProvider({ apiKey: 'bad-key', fetch: impl })
    await expect(llm('prompt')).rejects.toThrow(/Incorrect API key|401/)
  })
})
