import { geminiGenerateUrl } from './geminiConfig'
import { describeGeminiFailure, type GeminiErrorCategory } from './geminiErrors'
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
  | {
      ok: false
      stage: GeminiStage
      status: number | null
      /** One line for the main card. Never raw provider JSON. */
      message: string
      /** The provider's own text, for Details/Advanced. */
      detail: string | null
      category: GeminiErrorCategory
      /** Only when the provider NAMED one. Never inferred from a pattern. */
      recommendedModel: string | null
      retryable: boolean
    }

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
        const raw = await safeText(response)
        // The summary is short and actionable; the provider's own text is
        // kept SEPARATE for Details rather than pasted into the card. A
        // raw JSON blob tells someone with a broken analysis nothing about
        // what to do next.
        const failure = describeGeminiFailure(response.status, raw, this.model)
        return {
          ok: false,
          stage: 'generate',
          status: response.status,
          message: failure.summary,
          detail: failure.detail,
          category: failure.category,
          recommendedModel: failure.recommendedModel,
          retryable: failure.retryable
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
          detail: null,
          category: 'unknown',
          recommendedModel: null,
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
        message: aborted ? 'The Gemini request timed out. Nothing was stored.' : 'Could not reach Gemini',
        detail: err instanceof Error ? err.message.slice(0, 400) : String(err).slice(0, 400),
        category: 'network',
        recommendedModel: null,
        retryable: true
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    // Enough to carry Google's full error envelope, which is where the
    // recommended replacement model lives.
    return (await response.text()).slice(0, 1200)
  } catch {
    return ''
  }
}
