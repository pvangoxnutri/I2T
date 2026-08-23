import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { providerError, type ProviderError } from '../types'
import { sanitizeApiKey } from '../keyHygiene'
import { KLING_DEFAULT_CONTRACT } from './klingConfig'

/**
 * Kling HTTP transport, kept separate so it is trivially testable and so
 * "did anything hit the network?" is a single observable fact.
 *
 * The fetch implementation is INJECTABLE: tests pass a spy that asserts the
 * call count is zero for dry runs. The default implementation is only ever
 * reached in Live mode, which milestone 5A does not enable.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface KlingClientOptions {
  apiKey: string
  fetchImpl?: FetchLike
  baseUrl?: string
  timeoutMs?: number
}

export class KlingClient {
  private readonly apiKey: string
  private readonly fetchImpl: FetchLike
  private readonly baseUrl: string
  private readonly timeoutMs: number

  /** Number of transport calls made — asserted to be 0 in dry-run tests. */
  public callCount = 0

  constructor(options: KlingClientOptions) {
    // Same key hygiene as fal: whitespace/quote baggage never reaches auth.
    this.apiKey = sanitizeApiKey(options.apiKey)
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
    this.baseUrl = options.baseUrl ?? KLING_DEFAULT_CONTRACT.baseUrl
    this.timeoutMs = options.timeoutMs ?? 60_000
  }

  /**
   * Modern Kling auth: a single API key as a Bearer token. The key is
   * assembled here and nowhere else, is never logged, and never appears in
   * any value that leaves this class.
   */
  authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json'
    }
  }

  /** Header set safe for display: credential values redacted. */
  static redactHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) {
      out[key] = /^authorization$/i.test(key) ? 'Bearer ***redacted***' : value
    }
    return out
  }

  async post(path: string, body: unknown): Promise<{ ok: true; data: unknown } | { ok: false; error: ProviderError }> {
    return this.request('POST', path, body)
  }

  async get(path: string): Promise<{ ok: true; data: unknown } | { ok: false; error: ProviderError }> {
    return this.request('GET', path, undefined)
  }

  /**
   * Downloads a provider result to a local path. Routed through this class
   * so EVERY Kling HTTP call lives in one place — no scattered fetches.
   * The result URL is provider-supplied, so no credentials are attached.
   */
  async downloadTo(
    url: string,
    targetPath: string
  ): Promise<{ ok: true; bytes: number } | { ok: false; error: ProviderError }> {
    this.callCount++
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(url, { signal: controller.signal })
      if (!res.ok || !res.body) {
        return {
          ok: false,
          error: providerError('network', `Could not download the result (HTTP ${res.status}).`, {
            retryable: true
          })
        }
      }
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(targetPath))
      const { statSync } = await import('node:fs')
      return { ok: true, bytes: statSync(targetPath).size }
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      return {
        ok: false,
        error: providerError(
          aborted ? 'timeout' : 'network',
          aborted ? 'The result download timed out.' : 'Downloading the generated video failed.',
          { retryable: true }
        )
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown
  ): Promise<{ ok: true; data: unknown } | { ok: false; error: ProviderError }> {
    this.callCount++
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.authHeaders(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      })
      const text = await res.text()
      let data: unknown = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = { raw: text.slice(0, 500) }
      }
      if (!res.ok) return { ok: false, error: mapHttpError(res.status, data) }
      return { ok: true, data }
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      return {
        ok: false,
        error: providerError(
          aborted ? 'timeout' : 'network',
          aborted ? 'The provider did not respond in time.' : 'Could not reach the provider.',
          { retryable: true }
        )
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Maps transport/provider failures into the app's error taxonomy. Raw
 * request details (and therefore credentials) never enter the message. */
export function mapHttpError(status: number, data: unknown): ProviderError {
  const providerCode = extractCode(data)
  if (status === 401 || status === 403) {
    return providerError('authentication', 'Kling rejected the API key. Check it in Settings.', {
      providerCode
    })
  }
  if (status === 402) {
    return providerError('billing', 'Kling reports insufficient credits or a billing problem.', {
      providerCode
    })
  }
  // The path itself is wrong — NOT a failed generation. The status-query
  // path is the one part of the contract we could not verify, so this is the
  // expected way for it to be wrong, and it must stay recoverable.
  if (status === 404 || status === 405 || status === 501) {
    return providerError(
      'endpoint-unverified',
      `The status endpoint answered HTTP ${status} — the task-status path in Settings needs verification.`,
      { providerCode }
    )
  }
  if (status === 429) {
    return providerError('rate-limit', 'Kling rate or concurrency limit reached — try again shortly.', {
      providerCode,
      retryable: true
    })
  }
  if (status === 400 || status === 422) {
    const message = extractMessage(data)
    if (/moderat|policy|nsfw|sensitiv/i.test(message)) {
      return providerError('moderation', 'Kling rejected the request during content moderation.', {
        providerCode
      })
    }
    if (/image/i.test(message)) {
      return providerError('invalid-image', 'Kling rejected one of the frame images.', { providerCode })
    }
    return providerError('invalid-request', 'Kling rejected the request as invalid.', { providerCode })
  }
  if (status >= 500) {
    return providerError('network', 'Kling had a server-side error.', { providerCode, retryable: true })
  }
  return providerError('unknown', `Unexpected provider response (HTTP ${status}).`, { providerCode })
}

function extractCode(data: unknown): string | undefined {
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>
    const code = record.code ?? record.error_code ?? record.errorCode
    if (typeof code === 'string' || typeof code === 'number') return String(code)
  }
  return undefined
}

function extractMessage(data: unknown): string {
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>
    const msg = record.message ?? record.msg ?? record.error
    if (typeof msg === 'string') return msg
  }
  return ''
}
