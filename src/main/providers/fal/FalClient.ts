import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { providerError, type ProviderError } from '../types'
import { sanitizeApiKey } from '../keyHygiene'
import { falUploadInitiateUrl } from './falConfig'

/**
 * fal.ai HTTP transport. Every fal call in the app goes through this class,
 * so "did anything hit the network, and did anything get uploaded?" are two
 * single observable facts.
 *
 * fal.ai spans two hosts (queue.fal.run and rest.fal.ai), so this client
 * takes ABSOLUTE urls built by falConfig rather than owning a base url.
 *
 * DIAGNOSTICS: every failure names its request STAGE, HTTP status, endpoint
 * (host + path, never credentials), whether an Authorization header was
 * attached and what the provider's response said — because "the key was
 * rejected" is useless when the flow spans three authenticated endpoints.
 * The API key itself is assembled here and nowhere else. It never appears
 * in a body, a url, an error or a diagnostic line.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/** Which step of the fal workflow a request belongs to. */
export type FalStage = 'upload-init' | 'upload-put' | 'submit' | 'status' | 'result' | 'cancel' | 'download'

export interface FalClientOptions {
  apiKey: string
  fetchImpl?: FetchLike
  timeoutMs?: number
}

export class FalClient {
  private readonly apiKey: string
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number

  /** Transport calls made — asserted to be 0 in dry-run tests. */
  public callCount = 0
  /** Files uploaded — asserted to be 0 in dry-run tests. */
  public uploadCount = 0

  constructor(options: FalClientOptions) {
    // Repairs whitespace/quote baggage even on an already-stored key.
    this.apiKey = sanitizeApiKey(options.apiKey)
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
    this.timeoutMs = options.timeoutMs ?? 60_000
  }

  /** fal.ai auth: a single API key, sent as `Key <token>` (not Bearer). */
  authHeaders(): Record<string, string> {
    return {
      Authorization: `Key ${this.apiKey}`,
      'Content-Type': 'application/json'
    }
  }

  /** Header set safe for display: credential values redacted. */
  static redactHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) {
      out[key] = /^authorization$/i.test(key) ? 'Key ***redacted***' : value
    }
    return out
  }

  /** Redacts the key from any text that might echo it back. */
  private scrub(text: string): string {
    return this.apiKey ? text.split(this.apiKey).join('[redacted]') : text
  }

  async post(
    url: string,
    body: unknown,
    stage: FalStage
  ): Promise<{ ok: true; data: unknown } | { ok: false; error: ProviderError }> {
    return this.request('POST', url, body, stage)
  }

  async get(
    url: string,
    stage: FalStage
  ): Promise<{ ok: true; data: unknown } | { ok: false; error: ProviderError }> {
    return this.request('GET', url, undefined, stage)
  }

  async put(
    url: string,
    stage: FalStage
  ): Promise<{ ok: true; data: unknown } | { ok: false; error: ProviderError }> {
    return this.request('PUT', url, undefined, stage)
  }

  /**
   * Uploads one file to fal.ai's own storage and returns the resulting URL.
   *
   * This is fal.ai's official two-step mechanism: initiate to obtain a
   * short-lived signed upload url, then PUT the raw bytes to it. Nothing is
   * served by us, no third-party host is involved, and the local path never
   * leaves this process — only the bytes and a file NAME do.
   */
  async uploadFile(
    bytes: Buffer,
    fileName: string,
    contentType: string
  ): Promise<{ ok: true; url: string } | { ok: false; error: ProviderError }> {
    const initiated = await this.request(
      'POST',
      falUploadInitiateUrl(),
      { content_type: contentType, file_name: fileName },
      'upload-init'
    )
    if (!initiated.ok) return { ok: false, error: initiated.error }

    const data = (initiated.data ?? {}) as Record<string, unknown>
    const uploadUrl = typeof data.upload_url === 'string' ? data.upload_url : null
    const fileUrl = typeof data.file_url === 'string' ? data.file_url : null
    if (!uploadUrl || !fileUrl) {
      return {
        ok: false,
        error: providerError('unknown', 'fal.ai did not return an upload target for the frame image.')
      }
    }

    this.callCount++
    this.uploadCount++
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      // The signed url carries its own authorisation — the API key must NOT
      // be attached to it.
      const res = await this.fetchImpl(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: new Uint8Array(bytes),
        signal: controller.signal
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return {
          ok: false,
          error: this.diagnosticError(res.status, safeParse(text), {
            stage: 'upload-put',
            url: uploadUrl,
            hadAuth: false
          })
        }
      }
      return { ok: true, url: fileUrl }
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      return {
        ok: false,
        error: providerError(
          aborted ? 'timeout' : 'network',
          `${aborted ? 'Uploading a frame image timed out.' : 'Uploading a frame image failed.'} (Stage: upload-put · ${describeEndpoint(uploadUrl)})`,
          { retryable: true }
        )
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Downloads a finished result to a managed path. The result url is
   * fal-supplied and signed, so no credentials are attached. */
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
          error: this.diagnosticError(res.status, null, {
            stage: 'download',
            url,
            hadAuth: false,
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
          `${aborted ? 'The result download timed out.' : 'Downloading the generated video failed.'} (Stage: download · ${describeEndpoint(url)})`,
          { retryable: true }
        )
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private async request(
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    body: unknown,
    stage: FalStage
  ): Promise<{ ok: true; data: unknown; status: number } | { ok: false; error: ProviderError }> {
    this.callCount++
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: this.authHeaders(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      })
      const text = await res.text()
      const data = safeParse(text)
      if (!res.ok) {
        return {
          ok: false,
          error: this.diagnosticError(res.status, data, { stage, url, hadAuth: true })
        }
      }
      return { ok: true, data, status: res.status }
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      return {
        ok: false,
        error: providerError(
          aborted ? 'timeout' : 'network',
          `${aborted ? 'fal.ai did not respond in time.' : 'Could not reach fal.ai.'} (Stage: ${stage} · ${describeEndpoint(url)})`,
          { retryable: true }
        )
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Builds the sanitized, stage-aware error. The key never appears. */
  private diagnosticError(
    status: number,
    data: unknown,
    ctx: { stage: FalStage; url: string; hadAuth: boolean; retryable?: boolean }
  ): ProviderError {
    const base = mapFalHttpError(status, data, ctx)
    return { ...base, message: this.scrub(base.message), retryable: base.retryable || ctx.retryable === true }
  }
}

/** host + path for display — protocol stripped, credentials never present. */
export function describeEndpoint(url: string): string {
  return url.replace(/^https?:\/\//, '')
}

function safeParse(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text.slice(0, 500) }
  }
}

export interface FalErrorContext {
  stage: FalStage
  url: string
  hadAuth: boolean
}

/** The sanitized diagnostic block shown for every fal HTTP failure. */
function diagnosticBlock(status: number, data: unknown, ctx: FalErrorContext): string {
  const response = extractMessage(data) || truncate(JSON.stringify(data ?? '')) || '(empty)'
  return [
    `Stage: ${ctx.stage}`,
    `HTTP: ${status}`,
    `Endpoint: ${describeEndpoint(ctx.url)}`,
    `Authorization: ${ctx.hadAuth ? 'Key [redacted]' : 'none (signed URL)'}`,
    `Response: ${truncate(response)}`
  ].join('\n')
}

function truncate(text: string): string {
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

/**
 * Maps fal.ai transport failures into the app's error taxonomy. Raw request
 * details — and therefore credentials — never enter the message, but the
 * STAGE, status, endpoint and provider response always do: a 401 on
 * upload-init and a 401 on submit are different problems, and collapsing
 * them into "the key was rejected" hides which host rejected it.
 */
export function mapFalHttpError(status: number, data: unknown, ctx?: FalErrorContext): ProviderError {
  const providerCode = extractCode(data)
  const message = extractMessage(data)
  const detail = ctx ? `\n${diagnosticBlock(status, data, ctx)}` : ''

  if (status === 401) {
    return providerError('authentication', `fal.ai authentication failed${detail}`, {
      providerCode,
      httpStatus: status
    })
  }
  if (status === 403) {
    return providerError(
      'authentication',
      `fal.ai permission/scope issue — the key was recognised but is not allowed to do this${detail}`,
      { providerCode, httpStatus: status }
    )
  }
  if (status === 402) {
    return providerError('billing', `fal.ai reports a billing problem or exhausted balance.${detail}`, {
      providerCode,
      httpStatus: status
    })
  }
  if (status === 404) {
    return providerError(
      'endpoint-unverified',
      `fal.ai returned 404 — the endpoint or request id was not found.${detail}`,
      { providerCode, httpStatus: status }
    )
  }
  if (status === 405) {
    // 405 means the PATH exists but not for this method — i.e. we asked the
    // wrong url, not that the generation failed. A rebuilt queue url does
    // exactly this. Classified as endpoint-unverified so the caller keeps
    // the paid task and offers recovery instead of marking it failed.
    return providerError(
      'endpoint-unverified',
      `fal.ai returned 405 — that queue url does not accept this method. The remote task still exists; it needs its authoritative status_url.${detail}`,
      { providerCode, httpStatus: status }
    )
  }
  if (status === 429) {
    return providerError('rate-limit', `fal.ai rate limit reached — try again shortly.${detail}`, {
      providerCode,
      httpStatus: status,
      retryable: true
    })
  }
  if (status === 400 || status === 422) {
    if (/moderat|policy|nsfw|safety|sensitiv/i.test(message)) {
      return providerError('moderation', `fal.ai rejected the request during content moderation.${detail}`, {
        providerCode,
        httpStatus: status
      })
    }
    if (/image|url/i.test(message)) {
      return providerError('invalid-image', `fal.ai rejected one of the frame images.${detail}`, {
        providerCode,
        httpStatus: status
      })
    }
    return providerError('invalid-request', `fal.ai rejected the request as invalid.${detail}`, {
      providerCode,
      httpStatus: status
    })
  }
  if (status >= 500) {
    return providerError('network', `fal.ai had a server-side error.${detail}`, {
      providerCode,
      httpStatus: status,
      retryable: true
    })
  }
  return providerError('unknown', `Unexpected fal.ai response (HTTP ${status}).${detail}`, {
    providerCode,
    httpStatus: status
  })
}

function extractCode(data: unknown): string | undefined {
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>
    const code = record.code ?? record.error_code ?? record.status
    if (typeof code === 'string' || typeof code === 'number') return String(code)
  }
  return undefined
}

function extractMessage(data: unknown): string {
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>
    const msg = record.detail ?? record.message ?? record.error ?? record.raw
    if (typeof msg === 'string') return msg
    // fal validation errors arrive as a list of {loc, msg, type}.
    if (Array.isArray(msg)) {
      return msg
        .map((entry) =>
          entry && typeof entry === 'object' ? String((entry as Record<string, unknown>).msg ?? '') : ''
        )
        .join(' ')
    }
  }
  return ''
}
