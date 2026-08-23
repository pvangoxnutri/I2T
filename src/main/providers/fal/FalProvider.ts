import {
  providerError,
  type CancelResult,
  type DryRunResult,
  type GenerationRequest,
  type GenerationState,
  type ProviderMetadata,
  type SanitizedRequestPreview,
  type StatusResult,
  type SubmitResult,
  type UsageEstimate,
  type ValidationResult,
  type VideoProvider
} from '../types'
import { FalClient, type FetchLike } from './FalClient'
import {
  buildFalBody,
  extractQueueStatus,
  extractRequestId,
  extractResultUrl,
  imagePlaceholder,
  mapDuration,
  mapResolution,
  sanitizeMeta
} from './FalMapper'
import { readFramePair } from './FalImages'
import { sanitizeApiKey } from '../keyHygiene'
import { randomUUID } from 'node:crypto'
import {
  falCostRate,
  falSubmitUrl,
  falUploadInitiateUrl,
  FAL_CURRENCY,
  FAL_DOCS_URL,
  FAL_MODEL_ID,
  FAL_MODELS,
  FAL_QUEUE_STATUS,
  FAL_SUPPORTS_REMOTE_CANCEL
} from './falConfig'
import { deriveQueueUrls, extractQueueUrls, queueUrlMeta, resolveQueueUrls } from './falQueueUrls'

/**
 * The fal.ai provider.
 *
 * Guarantees, in the same shape as the Kling provider:
 *   • DRY RUN is network-free AND upload-free. `dryRun()` never constructs a
 *     client call, so no request and no file can escape.
 *   • Every network-touching method passes `liveGate()` first, which checks
 *     live mode AND the fal safety lock — a disabled button is never the
 *     only barrier.
 *   • The API key lives only in FalClient and never enters a body, url,
 *     preview or error.
 */
export interface FalProviderOptions {
  apiKey: string
  mode: 'dry-run' | 'live'
  fetchImpl?: FetchLike
  /** THE SAFETY LOCK, mirroring the Settings switch and re-checked here. */
  liveAllowed?: boolean
}

export class FalProvider implements VideoProvider {
  private readonly apiKey: string
  private readonly mode: 'dry-run' | 'live'
  private readonly client: FalClient
  private readonly liveAllowed: boolean

  constructor(options: FalProviderOptions) {
    // Sanitised HERE too, so "is a key configured?" and "what is sent" can
    // never disagree about a key that is nothing but quotes/whitespace.
    this.apiKey = sanitizeApiKey(options.apiKey)
    this.mode = options.mode
    this.liveAllowed = options.liveAllowed === true
    this.client = new FalClient({ apiKey: this.apiKey, fetchImpl: options.fetchImpl })
  }

  private liveGate(): { ok: true } | { ok: false; error: ReturnType<typeof providerError> } {
    if (this.mode !== 'live') {
      return {
        ok: false,
        error: providerError('not-configured', 'fal.ai is in Dry Run mode — no request was sent.')
      }
    }
    if (!this.liveAllowed) {
      return {
        ok: false,
        error: providerError(
          'not-configured',
          'The safety lock “Allow live fal.ai requests” is OFF — no paid request was sent.'
        )
      }
    }
    return { ok: true }
  }

  /** Test/diagnostic hooks: what this provider actually did. */
  get transportCallCount(): number {
    return this.client.callCount
  }

  get uploadCount(): number {
    return this.client.uploadCount
  }

  metadata(): ProviderMetadata {
    return {
      id: 'fal',
      label: 'fal.ai',
      models: FAL_MODELS.filter((m) => m.startFrame && m.endFrame),
      supportsRemoteCancel: FAL_SUPPORTS_REMOTE_CANCEL,
      docsUrl: FAL_DOCS_URL
    }
  }

  private model(modelId: string | null) {
    return this.metadata().models.find((m) => m.id === modelId) ?? null
  }

  validateConfiguration(modelId: string | null): ValidationResult {
    if (!this.apiKey.trim()) {
      return {
        ok: false,
        error: providerError('not-configured', 'No fal.ai API key is configured in Settings.')
      }
    }
    if (!modelId) {
      return { ok: false, error: providerError('not-configured', 'No fal.ai model selected.') }
    }
    const model = this.model(modelId)
    if (!model) {
      return {
        ok: false,
        error: providerError(
          'unsupported-capability',
          `Model "${modelId}" is not available for start + end frame generation.`
        )
      }
    }
    return { ok: true }
  }

  validateRequest(request: GenerationRequest): ValidationResult {
    const model = this.model(request.modelId)
    if (!model) {
      return {
        ok: false,
        error: providerError(
          'unsupported-capability',
          `Model "${request.modelId}" is unknown to the fal.ai provider.`
        )
      }
    }
    // The product IS start-frame → end-frame; refuse anything less.
    if (!model.startFrame || !model.endFrame) {
      return {
        ok: false,
        error: providerError(
          'unsupported-capability',
          `Model "${model.label}" does not support start + end frame generation.`
        )
      }
    }
    if (!request.startImagePath || !request.endImagePath) {
      return {
        ok: false,
        error: providerError('invalid-image', 'Both a start and an end image are required.')
      }
    }
    if (request.startImagePath === request.endImagePath) {
      return {
        ok: false,
        error: providerError('invalid-request', 'Start and end frames must be different images.')
      }
    }
    if (!request.prompt.trim()) {
      return { ok: false, error: providerError('invalid-request', 'The prompt is empty.') }
    }
    return { ok: true }
  }

  buildRequest(request: GenerationRequest): SanitizedRequestPreview {
    const model = this.model(request.modelId)!
    const warnings: string[] = []
    const mappedDuration = mapDuration(request.durationSec, model)
    const mappedResolution = mapResolution(request.resolution, model)

    if (mappedDuration !== request.durationSec) {
      warnings.push(
        `Requested ${request.durationSec}s is not offered by this model; mapped to ${mappedDuration}s.`
      )
    }
    if (mappedResolution !== request.resolution) {
      warnings.push(
        `Output quality is fixed by the fal.ai “${mappedResolution}” tier — ${request.resolution} is not a request field for this endpoint.`
      )
    }
    if (this.estimateUsage(request) === null) {
      warnings.push('No verified fal.ai rate for this combination — the cost estimate is unavailable.')
    }

    return {
      provider: 'fal',
      model: model.id,
      endpoint: falSubmitUrl(),
      method: 'POST',
      // Header VALUES are redacted — the key never reaches the preview.
      headers: FalClient.redactHeaders(this.client.authHeaders()),
      // DRY RUN: sanitized placeholders, never an uploaded url and never a
      // local path.
      body: buildFalBody(
        request,
        model,
        imagePlaceholder(request.startImagePath),
        imagePlaceholder(request.endImagePath)
      ),
      display: {
        startImage: request.startImageName,
        endImage: request.endImageName,
        durationSec: mappedDuration,
        resolution: mappedResolution
      },
      dryRun: this.mode === 'dry-run',
      warnings
    }
  }

  dryRun(request: GenerationRequest): DryRunResult | { error: ReturnType<typeof providerError> } {
    const config = this.validateConfiguration(request.modelId)
    if (!config.ok) return { error: config.error }
    const valid = this.validateRequest(request)
    if (!valid.ok) return { error: valid.error }
    // Build only — no client method is touched, so nothing is sent and
    // nothing is uploaded.
    return {
      dryRun: true,
      preview: this.buildRequest(request),
      estimatedCost: this.estimateCost(request),
      estimatedUsage: this.estimateUsage(request)
    }
  }

  async submitGeneration(request: GenerationRequest): Promise<SubmitResult> {
    const gate = this.liveGate()
    if (!gate.ok) return { ok: false, error: gate.error }

    const config = this.validateConfiguration(request.modelId)
    if (!config.ok) return { ok: false, error: config.error }
    const valid = this.validateRequest(request)
    if (!valid.ok) return { ok: false, error: valid.error }

    const model = this.model(request.modelId)!

    // Read both frames first: a failure here must happen BEFORE anything is
    // uploaded, let alone submitted.
    const frames = readFramePair(request.startImagePath, request.endImagePath)
    if (!frames.ok) return { ok: false, error: frames.error }

    // Official fal.ai storage upload — start frame, then end frame.
    const startUpload = await this.client.uploadFile(
      frames.start.bytes,
      frames.start.fileName,
      frames.start.contentType
    )
    if (!startUpload.ok) return { ok: false, error: startUpload.error }
    const endUpload = await this.client.uploadFile(
      frames.end.bytes,
      frames.end.fileName,
      frames.end.contentType
    )
    if (!endUpload.ok) return { ok: false, error: endUpload.error }

    // RUNTIME ASSERTIONS — a paid request must never go out with a missing
    // or collapsed frame pair.
    if (!startUpload.url || !endUpload.url) {
      return {
        ok: false,
        error: providerError('invalid-image', 'Both frames must be uploaded before submitting.')
      }
    }
    if (startUpload.url === endUpload.url) {
      return {
        ok: false,
        error: providerError(
          'invalid-request',
          'The uploaded start and end frames resolved to the same file — refusing to submit.'
        )
      }
    }

    const body = buildFalBody(request, model, startUpload.url, endUpload.url)
    const res = await this.client.post(falSubmitUrl(), body, 'submit')
    if (!res.ok) return { ok: false, error: res.error }

    const data = (res.data ?? {}) as Record<string, unknown>
    const requestId = extractRequestId(data)
    if (!requestId) {
      return {
        ok: false,
        error: providerError('unknown', 'fal.ai accepted the request but returned no request id.')
      }
    }
    // fal returns status_url / response_url / cancel_url alongside the id.
    // sanitizeMeta now keeps them, and they are merged explicitly here so a
    // future shape change in that helper cannot silently drop the only way
    // to reach a PAID request again. Derivation is the fallback, never the
    // first choice.
    const urls = extractQueueUrls(data)
    return {
      ok: true,
      providerTaskId: requestId,
      providerStatus: extractQueueStatus(data) ?? 'IN_QUEUE',
      meta: { ...sanitizeMeta(data), ...queueUrlMeta(urls) }
    }
  }

  /**
   * fal.ai splits status and result across two endpoints: the status call
   * says COMPLETED but carries no video, so the result endpoint is fetched
   * only once the queue reports completion.
   */
  async getGenerationStatus(
    providerTaskId: string,
    providerMeta?: Record<string, unknown> | null
  ): Promise<StatusResult> {
    const gate = this.liveGate()
    if (!gate.ok) return { ok: false, error: gate.error }

    // The url fal itself handed us at submit time wins over anything we
    // could rebuild. Rebuilding is what produced the 405 that stranded a
    // paid request; see falQueueUrls.
    const urls = resolveQueueUrls(providerMeta, providerTaskId, this.modelIdOf(providerMeta))
    const res = await this.client.get(urls.statusUrl, 'status')
    if (!res.ok) return { ok: false, error: res.error }
    const data = (res.data ?? {}) as Record<string, unknown>
    const raw = extractQueueStatus(data)
    if (raw === undefined) {
      return {
        ok: false,
        error: providerError(
          'endpoint-unverified',
          'The fal.ai status endpoint returned no recognisable status.'
        )
      }
    }

    const state = normalizeFalState(raw)
    if (state !== 'succeeded') {
      return { ok: true, providerStatus: raw, state, meta: sanitizeMeta(data) }
    }

    // COMPLETED → fetch the actual result payload for the video url, from
    // the response_url fal returned at submit time.
    const result = await this.client.get(urls.responseUrl, 'result')
    if (!result.ok) return { ok: false, error: result.error }
    const resultData = (result.data ?? {}) as Record<string, unknown>
    return {
      ok: true,
      providerStatus: raw,
      state: 'succeeded',
      resultUrl: extractResultUrl(resultData),
      meta: { ...sanitizeMeta(data), ...sanitizeMeta(resultData) }
    }
  }

  /** The model a job was submitted with, for url derivation. Falls back to
   *  the configured model — derivation is only ever a fallback anyway. */
  private modelIdOf(meta?: Record<string, unknown> | null): string {
    const stored = meta && typeof meta['model'] === 'string' ? (meta['model'] as string) : null
    return stored ?? FAL_MODEL_ID
  }

  /**
   * fal.ai DOES support remote cancellation, so unlike Kling we can answer
   * honestly in the affirmative — but only when the endpoint says so.
   */
  async cancelGeneration(
    providerTaskId: string,
    providerMeta?: Record<string, unknown> | null
  ): Promise<CancelResult> {
    const gate = this.liveGate()
    if (!gate.ok) return { ok: false, unsupported: false, error: gate.error }

    // Same rule as polling: fal's own cancel_url, never a rebuilt one.
    const urls = resolveQueueUrls(providerMeta, providerTaskId, this.modelIdOf(providerMeta))
    const res = await this.client.put(urls.cancelUrl, 'cancel')
    if (res.ok) return { ok: true }
    // 400 means the request already finished — it cannot be cancelled, and
    // it has already been billed.
    if (res.error.code === 'invalid-request') {
      return {
        ok: false,
        unsupported: false,
        error: providerError(
          'invalid-request',
          'The fal.ai request had already completed — it could not be cancelled and has been billed.'
        )
      }
    }
    return { ok: false, unsupported: false, error: res.error }
  }

  async fetchResult(
    resultUrl: string,
    targetPath: string
  ): Promise<{ ok: true } | { ok: false; error: ReturnType<typeof providerError> }> {
    const gate = this.liveGate()
    if (!gate.ok) return { ok: false, error: gate.error }
    const res = await this.client.downloadTo(resultUrl, targetPath)
    if (!res.ok) return { ok: false, error: res.error }
    if (res.bytes <= 0) {
      return {
        ok: false,
        error: providerError('task-failed', 'The downloaded result was empty.', { retryable: true })
      }
    }
    return { ok: true }
  }

  /**
   * FREE authentication/configuration test — never touches the video model
   * and never consumes generation credits, by construction:
   *
   *   Probe 1 — rest.fal.ai: `storage/upload/initiate`, the first
   *   non-billable step of our own confirmed workflow. It only issues a
   *   short-lived signed upload slot; NOTHING is uploaded to it and it
   *   expires unused.
   *
   *   Probe 2 — queue.fal.run: the status of a request id that cannot
   *   exist. A 404/422 answer proves the key was ACCEPTED on the queue
   *   host (auth is checked before the id lookup); 401/403 proves it was
   *   not. No generation is created either way.
   *
   * This method deliberately bypasses liveGate: it is reachable ONLY from
   * the explicit "Test connection" button, works in Dry Run (that is the
   * point — verify auth before going live), and cannot spend anything.
   */
  async testConnection(): Promise<{
    status: 'connected' | 'auth-failed' | 'permission' | 'network'
    detail: string[]
  }> {
    if (!this.apiKey.trim()) {
      return { status: 'auth-failed', detail: ['No fal.ai API key is stored — save one first.'] }
    }

    const detail: string[] = []
    let worst: 'connected' | 'auth-failed' | 'permission' | 'network' = 'connected'
    const downgrade = (to: typeof worst): void => {
      const rank = { connected: 0, permission: 1, 'auth-failed': 2, network: 3 }
      // network outranks auth verdicts: with no answer we know nothing.
      if (rank[to] > rank[worst]) worst = to
    }

    // ── Probe 1: storage auth on rest.fal.ai ─────────────────────────────
    const init = await this.client.post(
      falUploadInitiateUrl(),
      { content_type: 'application/octet-stream', file_name: 'f2f-connection-test.bin' },
      'upload-init'
    )
    if (init.ok) {
      detail.push('rest.fal.ai (storage): key accepted. The issued upload slot was NOT used.')
    } else if (init.error.httpStatus === 401) {
      downgrade('auth-failed')
      detail.push(`rest.fal.ai (storage): authentication failed.\n${init.error.message}`)
    } else if (init.error.httpStatus === 403) {
      downgrade('permission')
      detail.push(`rest.fal.ai (storage): permission/scope issue.\n${init.error.message}`)
    } else {
      downgrade('network')
      detail.push(`rest.fal.ai (storage): no verdict.\n${init.error.message}`)
    }

    // ── Probe 2: queue auth on queue.fal.run ─────────────────────────────
    // A deliberately unknown id: this proves the KEY is accepted by the
    // queue host, nothing more. Derived on purpose — there is no submit
    // response to take a url from for an id that was never submitted.
    const probe = await this.client.get(
      deriveQueueUrls(`f2f-connection-test-${randomUUID()}`).statusUrl,
      'status'
    )
    if (probe.ok) {
      // Should not happen for a random id, but a 200 still proves auth.
      detail.push('queue.fal.run (queue): key accepted.')
    } else if (probe.error.httpStatus === 401) {
      downgrade('auth-failed')
      detail.push(`queue.fal.run (queue): authentication failed.\n${probe.error.message}`)
    } else if (probe.error.httpStatus === 403) {
      downgrade('permission')
      detail.push(`queue.fal.run (queue): permission/scope issue.\n${probe.error.message}`)
    } else if (
      probe.error.httpStatus === 404 ||
      probe.error.httpStatus === 400 ||
      probe.error.httpStatus === 422
    ) {
      // The id is unknown — which means auth was accepted first.
      detail.push('queue.fal.run (queue): key accepted (probe request id unknown, as expected).')
    } else {
      downgrade('network')
      detail.push(`queue.fal.run (queue): no verdict.\n${probe.error.message}`)
    }

    return { status: worst, detail }
  }

  /**
   * fal.ai bills in MONEY per output second — no credits involved. The rate
   * is the officially published one for this exact endpoint.
   */
  estimateUsage(request: GenerationRequest): UsageEstimate | null {
    const model = this.model(request.modelId)
    if (!model) return null
    const seconds = mapDuration(request.durationSec, model)
    const resolution = mapResolution(request.resolution, model)
    const nativeAudio = request.nativeAudio === true
    const rate = falCostRate(model.id, nativeAudio)
    if (!rate) return null

    // Round to cents: fal bills in dollars, and a long float in a paid
    // confirmation dialog reads like a bug.
    const amount = Math.round(seconds * rate.usdPerSecond * 100) / 100
    return {
      seconds,
      resolution,
      nativeAudio,
      credits: null,
      creditsPerSecond: null,
      money: { amount, currency: FAL_CURRENCY },
      rateLabel: `$${rate.usdPerSecond}/s`,
      label: `$${amount.toFixed(2)}`
    }
  }

  estimateCost(request: GenerationRequest): number | null {
    return this.estimateUsage(request)?.money?.amount ?? null
  }
}

/**
 * CONFIRMED vocabulary first — IN_QUEUE / IN_PROGRESS / COMPLETED are mapped
 * explicitly. Anything else is a future or undocumented value, so the
 * defensive pattern match keeps it from being read as a failure.
 */
export function normalizeFalState(raw: string): GenerationState {
  const known = FAL_QUEUE_STATUS[raw.trim().toUpperCase()]
  if (known) return known
  const s = raw.trim().toLowerCase()
  if (/complet|succe|finish|ok/.test(s)) return 'succeeded'
  if (/fail|error|reject|cancel/.test(s)) return 'failed'
  if (/progress|running|process|generat/.test(s)) return 'processing'
  return 'pending'
}
