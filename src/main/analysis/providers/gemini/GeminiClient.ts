import { geminiGenerateUrl } from './geminiConfig'
import { sanitizeApiKey } from '../../../providers/keyHygiene'

/**
 * The ONE place a Gemini HTTP request can be made.
 *
 * ── WHY A TRANSPORT SEAM ─────────────────────────────────────────────
 *
 * Every call goes through the injected `fetchImpl`, exactly like
 * FalClient. Tests supply a mock and then assert `callCount === 0` on the
 * dry-run path — which is the only way to prove "no network" rather than
 * merely believe it.
 *
 * ── THE KEY ──────────────────────────────────────────────────────────
 *
 * Sent in the `x-goog-api-key` header, never in the URL: a query-string
 * key ends up in proxy logs, browser history and crash reports. It is
 * sanitised on the way in — pasted quotes and newlines produce a 403 that
 * looks exactly like a bad key — and it is never returned, logged or
 * included in any error message.
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export type GeminiStage = 'generate'

export interface GeminiClientOptions {
  apiKey: string
  model: string
  fetchImpl?: FetchLike
  timeoutMs?: number
}

export interface GeminiUsage {
  promptTokenCount: number | null
  candidatesTokenCount: number | null
  totalTokenCount: number | null
}

export type GeminiCallResult =
  | { ok: true; text: string; usage: GeminiUsage }
  | { ok: false; stage: GeminiStage; status: number | null; message: string; retryable: boolean }

/** A part of the multimodal request. Images are inline base64. */
export type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } }

export interface GeminiRequestBody {
  contents: Array<{ role: 'user'; parts: GeminiPart[] }>
  generationConfig: {
    responseMimeType: 'application/json'
    responseSchema: unknown
    temperature: number
  }
}

export class GeminiClient {
  /** Transport calls made — asserted to be 0 in dry-run tests. */
  public callCount = 0

  private readonly apiKey: string
  private readonly model: string
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number

  constructor(options: GeminiClientOptions) {
    this.apiKey = sanitizeApiKey(options.apiKey)
    this.model = options.model
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
    this.timeoutMs = options.timeoutMs ?? 180_000
  }

  hasKey(): boolean {
    return this.apiKey.length > 0
  }

  async generate(body: GeminiRequestBody): Promise<GeminiCallResult> {
    this.callCount++
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(geminiGenerateUrl(this.model), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Header, never the query string — see the note above.
          'x-goog-api-key': this.apiKey
        },
        body: JSON.stringify(body),
        signal: controller.signal
      })

      if (!response.ok) {
        const detail = await safeText(response)
        return {
          ok: false,
          stage: 'generate',
          status: response.status,
          // The key is never echoed, and the provider's body is truncated
          // so a verbose error cannot become a wall of noise in the UI.
          message: describeStatus(response.status, detail),
          retryable: response.status === 429 || response.status >= 500
        }
      }

      const json = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
        usageMetadata?: {
          promptTokenCount?: number
          candidatesTokenCount?: number
          totalTokenCount?: number
        }
      }

      const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
      if (!text) {
        return {
          ok: false,
          stage: 'generate',
          status: response.status,
          message: 'Gemini returned no content. The analysis was not created.',
          retryable: true
        }
      }

      return {
        ok: true,
        text,
        usage: {
          promptTokenCount: json.usageMetadata?.promptTokenCount ?? null,
          candidatesTokenCount: json.usageMetadata?.candidatesTokenCount ?? null,
          totalTokenCount: json.usageMetadata?.totalTokenCount ?? null
        }
      }
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      return {
        ok: false,
        stage: 'generate',
        status: null,
        message: aborted
          ? 'The Gemini request timed out. Nothing was stored.'
          : `Could not reach Gemini: ${err instanceof Error ? err.message : String(err)}`,
        retryable: true
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 400)
  } catch {
    return ''
  }
}

/** Actionable wording per status — the operator should know what to fix. */
function describeStatus(status: number, detail: string): string {
  const tail = detail ? ` Provider said: ${detail}` : ''
  if (status === 400) return `Gemini rejected the request (400). This is a bug in the request we built, not your key.${tail}`
  if (status === 401 || status === 403) {
    return `Gemini refused the API key (${status}). Check the key in Settings and that the Generative Language API is enabled for it.${tail}`
  }
  if (status === 404) return `Model not found (404). The configured model id may be wrong or unavailable to this key.${tail}`
  if (status === 413) return `The request was too large (413). Fewer images, or smaller ones, are needed.${tail}`
  if (status === 429) return `Rate limited by Gemini (429). Nothing was analysed; try again shortly.${tail}`
  if (status >= 500) return `Gemini had a server error (${status}). Nothing was analysed.${tail}`
  return `Gemini request failed (${status}).${tail}`
}
