export interface Routed {
  status?: number
  body: unknown
}

/** A routed fake fetch: the handler decides the response per URL, every call is captured. */
export function apiFetch(handler: (url: URL, init?: RequestInit) => Routed) {
  const calls: Array<{ url: URL; init?: RequestInit }> = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    calls.push(init === undefined ? { url } : { url, init })
    const { status = 200, body } = handler(url, init)
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
  return { impl, calls }
}

export function authHeader(init?: RequestInit): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.['authorization']
}

export function jsonBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}
