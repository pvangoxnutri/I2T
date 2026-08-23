import {
  providerError,
  type CancelResult,
  type DryRunResult,
  type GenerationRequest,
  type ProviderMetadata,
  type SanitizedRequestPreview,
  type StatusResult,
  type SubmitResult,
  type ValidationResult,
  type VideoProvider
} from '../types'
import { KlingClient, type FetchLike } from './KlingClient'
import {
  buildKlingBody,
  buildKlingLiveBody,
  imageToVideoEndpoint,
  mapDuration,
  mapResolution,
  prepareImagesForDryRun,
  taskStatusEndpoint
} from './KlingMapper'
import { prepareFramePair } from './KlingImages'
import {
  creditRateFor,
  KLING_CREDIT_TO_MONEY,
  KLING_DOCS_URL,
  KLING_MODELS,
  KLING_SUPPORTS_REMOTE_CANCEL,
  KLING_TASK_STATUS,
  resolveContract,
  type KlingContractOverrides
} from './klingConfig'
import type { GenerationState, UsageEstimate } from '../types'

/**
 * The Kling provider.
 *
 * MILESTONE 5A CONTRACT: in dry-run mode this class is guaranteed
 * network-free — `dryRun()` never constructs a client call, and the submit/
 * status/fetch methods refuse outright when the provider is not in live
 * mode. Live mode is not enabled anywhere in the app yet.
 */
export interface KlingProviderOptions {
  apiKey: string
  mode: 'dry-run' | 'live'
  fetchImpl?: FetchLike
  /** Operator-verified transport contract (endpoints, model id). */
  contract?: KlingContractOverrides
  /**
   * THE SAFETY LOCK. Even in live mode, no paid request may leave the app
   * unless this is explicitly true — it mirrors the Settings switch and is
   * re-checked here, in main, rather than trusting a disabled button.
   */
  liveAllowed?: boolean
}

export class KlingProvider implements VideoProvider {
  private readonly apiKey: string
  private readonly mode: 'dry-run' | 'live'
  private readonly client: KlingClient
  private readonly contract?: KlingContractOverrides
  private readonly liveAllowed: boolean

  constructor(options: KlingProviderOptions) {
    this.apiKey = options.apiKey ?? ''
    this.mode = options.mode
    this.contract = options.contract
    this.liveAllowed = options.liveAllowed === true
    this.client = new KlingClient({
      apiKey: this.apiKey,
      fetchImpl: options.fetchImpl,
      baseUrl: resolveContract(options.contract).baseUrl
    })
  }

  /** Single gate every network-touching method must pass. */
  private liveGate(): { ok: true } | { ok: false; error: ReturnType<typeof providerError> } {
    if (this.mode !== 'live') {
      return {
        ok: false,
        error: providerError(
          'not-configured',
          'Kling is in Dry Run mode — no request was sent.'
        )
      }
    }
    if (!this.liveAllowed) {
      return {
        ok: false,
        error: providerError(
          'not-configured',
          'The safety lock “Allow live Kling requests” is OFF — no paid request was sent.'
        )
      }
    }
    return { ok: true }
  }

  /** Test/diagnostic hook: how many transport calls this provider made. */
  get transportCallCount(): number {
    return this.client.callCount
  }

  metadata(): ProviderMetadata {
    return {
      id: 'kling',
      label: 'Kling',
      // Only start+end-frame capable models are offered for FrameToFrame.
      // The model id is CONFIRMED and locked — no operator override path.
      models: KLING_MODELS.filter((m) => m.startFrame && m.endFrame),
      supportsRemoteCancel: KLING_SUPPORTS_REMOTE_CANCEL,
      docsUrl: KLING_DOCS_URL
    }
  }

  private model(modelId: string | null) {
    return this.metadata().models.find((m) => m.id === modelId) ?? null
  }

  validateConfiguration(modelId: string | null): ValidationResult {
    if (!this.apiKey.trim()) {
      return {
        ok: false,
        error: providerError('not-configured', 'No Kling API key is configured in Settings.')
      }
    }
    if (!modelId) {
      return { ok: false, error: providerError('not-configured', 'No Kling model selected.') }
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
          `Model "${request.modelId}" is unknown to the Kling provider.`
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
    const images = prepareImagesForDryRun(request)
    const warnings: string[] = []
    if (!model.confirmed) {
      warnings.push(
        'Model/endpoint identifiers are UNVERIFIED — confirm against the official Kling documentation before enabling Live mode.'
      )
    }
    if (this.estimateUsage(request) === null) {
      warnings.push(
        `No verified credit rate for ${mapResolution(request.resolution, model)} with audio ${request.nativeAudio ? 'on' : 'off'} — the cost estimate is unavailable.`
      )
    }
    if (mapDuration(request.durationSec, model) !== request.durationSec) {
      warnings.push(
        `Requested ${request.durationSec}s is not offered by this model; mapped to ${mapDuration(request.durationSec, model)}s.`
      )
    }
    if (mapResolution(request.resolution, model) !== request.resolution) {
      warnings.push(
        `Requested ${request.resolution} is not offered by this model; mapped to ${mapResolution(request.resolution, model)}.`
      )
    }

    return {
      provider: 'kling',
      model: model.id,
      endpoint: imageToVideoEndpoint(this.contract),
      method: 'POST',
      // Header VALUES are redacted — the key never reaches the preview.
      headers: KlingClient.redactHeaders(this.client.authHeaders()),
      body: buildKlingBody(request, model, images),
      display: {
        startImage: request.startImageName,
        endImage: request.endImageName,
        durationSec: mapDuration(request.durationSec, model),
        resolution: mapResolution(request.resolution, model)
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
    // Build only — no client method is touched, so no request can escape.
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

    // Real image preparation: managed bytes → base64, no host, no paths.
    const frames = prepareFramePair(request.startImagePath, request.endImagePath)
    if (!frames.ok) return { ok: false, error: frames.error }

    // RUNTIME ASSERTION — a paid request must never go out with a missing
    // or collapsed frame pair.
    if (!frames.start.base64 || !frames.end.base64) {
      return {
        ok: false,
        error: providerError('invalid-image', 'Both frames must be present before submitting.')
      }
    }
    if (frames.start.base64 === frames.end.base64) {
      return {
        ok: false,
        error: providerError('invalid-request', 'Start and end frames are identical — refusing to submit.')
      }
    }

    const body = buildKlingLiveBody(request, model, frames.start.base64, frames.end.base64)
    const res = await this.client.post(imageToVideoEndpoint(this.contract), body)
    if (!res.ok) return { ok: false, error: res.error }

    const data = res.data as Record<string, unknown>
    const taskId = extractTaskId(data)
    if (!taskId) {
      return {
        ok: false,
        error: providerError('unknown', 'Kling accepted the request but returned no task id.')
      }
    }
    return { ok: true, providerTaskId: taskId, providerStatus: 'submitted', meta: sanitizeMeta(data) }
  }

  async getGenerationStatus(providerTaskId: string): Promise<StatusResult> {
    const gate = this.liveGate()
    if (!gate.ok) return { ok: false, error: gate.error }
    const res = await this.client.get(taskStatusEndpoint(providerTaskId, this.contract))
    if (!res.ok) return { ok: false, error: res.error }
    const data = res.data as Record<string, unknown>
    const raw = extractStatus(data)
    // A 200 that carries no status at all is the SAME problem as a 404: we
    // are talking to the wrong place. Reporting "pending" here would poll a
    // wrong URL forever; reporting "failed" would libel a paid task that is
    // probably running fine.
    if (raw === undefined) {
      return {
        ok: false,
        error: providerError(
          'endpoint-unverified',
          'The status endpoint returned no recognisable task status — the task-status path in Settings needs verification.'
        )
      }
    }
    return {
      ok: true,
      providerStatus: raw,
      state: normalizeState(raw),
      resultUrl: extractResultUrl(data),
      meta: sanitizeMeta(data)
    }
  }

  async cancelGeneration(providerTaskId: string): Promise<CancelResult> {
    // Honest answer: we do not claim a remote task stopped when we have not
    // verified that Kling exposes cancellation at all. Local queue cancel
    // stops OUR polling; the remote task may keep running and may still be
    // billed.
    void providerTaskId
    return {
      ok: false,
      unsupported: true,
      reason:
        'Remote cancellation is not confirmed for the Kling API. Cancelling here only stops local polling — the remote task may continue and may still incur cost.'
    }
  }

  async fetchResult(
    resultUrl: string,
    targetPath: string
  ): Promise<{ ok: true } | { ok: false; error: ReturnType<typeof providerError> }> {
    const gate = this.liveGate()
    if (!gate.ok) return { ok: false, error: gate.error }
    // Routed through the single client so every HTTP call is in one place.
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
   * The honest cost number: Kling bills in CREDITS per second, and the rate
   * depends on resolution and whether native audio is on. Rates are the
   * official NO VIDEO INPUT rates, which is exactly this workflow — we send
   * images only.
   */
  estimateUsage(request: GenerationRequest): UsageEstimate | null {
    const model = this.model(request.modelId)
    if (!model) return null
    const seconds = mapDuration(request.durationSec, model)
    const resolution = mapResolution(request.resolution, model)
    const nativeAudio = request.nativeAudio === true
    const rate = creditRateFor(model.id, resolution, nativeAudio)
    // No verified rate for this combination (e.g. 4K) → no number invented.
    if (!rate) return null

    const credits = seconds * rate.creditsPerSecond
    const money = KLING_CREDIT_TO_MONEY
      ? {
          amount: Math.round(credits * KLING_CREDIT_TO_MONEY.perCredit * 100) / 100,
          currency: KLING_CREDIT_TO_MONEY.currency
        }
      : null

    return {
      seconds,
      resolution,
      nativeAudio,
      credits,
      creditsPerSecond: rate.creditsPerSecond,
      money,
      rateLabel: `${rate.creditsPerSecond} credits/s`,
      label: money
        ? `${credits} credits (~${money.amount} ${money.currency})`
        : `${credits} credits`
    }
  }

  /**
   * Monetary estimate. Kling publishes credit rates but no official
   * credit→currency conversion, so this stays null rather than inventing a
   * currency value. `estimateUsage` is the number to show.
   */
  estimateCost(request: GenerationRequest): number | null {
    return this.estimateUsage(request)?.money?.amount ?? null
  }
}

// ── Response helpers (defensive: the exact shape is unverified) ───────────

function unwrap(data: Record<string, unknown>): Record<string, unknown> {
  const nested = data.data
  return nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : data
}

function extractTaskId(data: Record<string, unknown>): string | null {
  const d = unwrap(data)
  const id = d.task_id ?? d.taskId ?? d.id
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null
}

function extractStatus(data: Record<string, unknown>): string | undefined {
  const d = unwrap(data)
  const status = d.task_status ?? d.status
  return typeof status === 'string' ? status : undefined
}

function extractResultUrl(data: Record<string, unknown>): string | undefined {
  const d = unwrap(data)
  const result = (d.task_result ?? d.result) as Record<string, unknown> | undefined
  const videos = result?.videos
  if (Array.isArray(videos) && videos.length > 0) {
    const first = videos[0] as Record<string, unknown>
    if (typeof first.url === 'string') return first.url
  }
  return typeof d.video_url === 'string' ? d.video_url : undefined
}

/**
 * CONFIRMED vocabulary first — submitted / processing / succeed / failed are
 * mapped explicitly. Anything else is a future or undocumented value, so we
 * keep the defensive pattern match rather than treating it as a failure.
 */
export function normalizeState(raw: string): GenerationState {
  const s = raw.trim().toLowerCase()
  const known = KLING_TASK_STATUS[s]
  if (known) return known
  if (/succe|complete|finish/.test(s)) return 'succeeded'
  if (/fail|error|reject/.test(s)) return 'failed'
  if (/process|running|generat/.test(s)) return 'processing'
  return 'pending'
}

/** Keeps only small, non-sensitive scalars from a provider response. */
function sanitizeMeta(data: Record<string, unknown>): Record<string, unknown> {
  const d = unwrap(data)
  const out: Record<string, unknown> = {}
  for (const key of ['task_status', 'status', 'created_at', 'updated_at', 'model_name', 'code', 'message']) {
    const value = d[key]
    if (typeof value === 'string' || typeof value === 'number') out[key] = value
  }
  return out
}
