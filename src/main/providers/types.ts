import type { ProviderId } from '../../shared/types'

/**
 * The generic video-provider contract. FrameToFrame talks ONLY to this
 * interface — nothing outside src/main/providers/kling knows Kling exists.
 * A future provider implements the same shape and slots into the registry.
 */

// ── Capabilities ─────────────────────────────────────────────────────────

/**
 * What a specific provider MODEL can actually do. FrameToFrame's whole
 * product needs `startFrame && endFrame`; models without both are refused
 * for transition generation rather than silently degraded.
 */
export interface ModelCapabilities {
  id: string
  label: string
  startFrame: boolean
  endFrame: boolean
  /** Allowed clip durations in seconds. */
  durationsSec: number[]
  /** Allowed output resolutions, provider vocabulary. */
  resolutions: string[]
  /** Fallback when a requested resolution is not offered. Without this an
   * unsupported request would degrade to the LAST entry — i.e. silently to
   * the most expensive mode. */
  defaultResolution?: string
  /** The model CAN do native audio. Whether a job uses it is per-request. */
  nativeAudio: boolean
  /**
   * FALSE means the identifiers below are taken from unofficial sources and
   * MUST be verified against the provider's official documentation before
   * Live mode is enabled. Nothing here is guessed silently.
   */
  confirmed: boolean
  /** Where the identifiers came from / what still needs checking. */
  verificationNote?: string
}

export interface ProviderMetadata {
  id: ProviderId
  label: string
  /** Models exposed for the start+end-frame workflow. */
  models: ModelCapabilities[]
  supportsRemoteCancel: boolean
  /** Docs URL for verification, if any. */
  docsUrl?: string
}

// ── Requests & results ───────────────────────────────────────────────────

/** FrameToFrame's provider-neutral description of one transition job. */
export interface GenerationRequest {
  projectId: string
  pairKey: string
  /** Absolute managed path of the START image. */
  startImagePath: string
  /** Absolute managed path of the END image. */
  endImagePath: string
  /** Display names, safe for logs/preview. */
  startImageName: string
  endImageName: string
  prompt: string
  durationSec: number
  /** FrameToFrame export resolution, mapped by the provider. */
  resolution: string
  /** Native audio for THIS job. FrameToFrame defaults it OFF and never turns
   * it on by itself — it costs 50 % more per second. */
  nativeAudio: boolean
  modelId: string
}

/** Provider-neutral lifecycle state of a remote task. */
export type GenerationState = 'pending' | 'processing' | 'succeeded' | 'failed'

/**
 * What one generation will consume. Providers bill in their own unit: Kling
 * sells credits, fal.ai bills money per output second. Both are optional and
 * only ever set from a VERIFIED published rate — `label` is what the UI
 * shows and is never invented.
 */
export interface UsageEstimate {
  seconds: number
  resolution: string
  nativeAudio: boolean
  /** Set when the provider bills in credits. */
  credits: number | null
  creditsPerSecond: number | null
  /** Set when the provider publishes a currency rate. */
  money: { amount: number; currency: string } | null
  /** The rate this was derived from, e.g. "8 credits/s" or "$0.084/s". */
  rateLabel: string
  /** e.g. "40 credits" or "$0.42". */
  label: string
}

/** A request rendered for display/debug — NEVER contains credentials. */
export interface SanitizedRequestPreview {
  provider: ProviderId
  model: string
  endpoint: string
  method: string
  /** Header names only, with credential values redacted. */
  headers: Record<string, string>
  body: Record<string, unknown>
  /** Human-readable frame identifiers for the developer view. Original file
   * names only — never absolute local paths. */
  display: { startImage: string; endImage: string; durationSec: number; resolution: string }
  dryRun: boolean
  warnings: string[]
}

export type SubmitResult =
  | { ok: true; providerTaskId: string; providerStatus: string; meta: Record<string, unknown> }
  | { ok: false; error: ProviderError }

export type StatusResult =
  | {
      ok: true
      providerStatus: string
      state: GenerationState
      /** Present when succeeded. */
      resultUrl?: string
      meta: Record<string, unknown>
    }
  | { ok: false; error: ProviderError }

export type CancelResult =
  | { ok: true }
  | { ok: false; unsupported: true; reason: string }
  | { ok: false; unsupported?: false; error: ProviderError }

export type ValidationResult = { ok: true } | { ok: false; error: ProviderError }

/** Dry-run outcome: everything validated and built, nothing sent. */
export interface DryRunResult {
  dryRun: true
  preview: SanitizedRequestPreview
  /** Money — null unless the provider publishes a verified conversion. */
  estimatedCost: number | null
  /** The provider's own billing unit. This is the honest number. */
  estimatedUsage: UsageEstimate | null
}

// ── Errors ───────────────────────────────────────────────────────────────

/**
 * Provider failures are mapped into these categories so the UI can say
 * something useful and the queue can decide whether a retry is sane.
 * Raw credentials never travel inside them.
 */
export type ProviderErrorCode =
  | 'not-configured'
  | 'authentication'
  | 'billing'
  | 'rate-limit'
  | 'invalid-image'
  | 'invalid-request'
  | 'unsupported-capability'
  | 'moderation'
  | 'task-failed'
  /**
   * The remote task exists, but OUR status endpoint is wrong: a 404/405, or
   * a response whose shape carries no status at all. This is deliberately
   * its own code — it must never be treated as a failed generation, because
   * a PAID task is still running on the provider's side.
   */
  | 'endpoint-unverified'
  | 'network'
  | 'timeout'
  | 'unknown'

export interface ProviderError {
  code: ProviderErrorCode
  /** Customer/operator-facing message — safe to display. */
  message: string
  /** Provider's own code, kept for diagnosis. */
  providerCode?: string
  /** The raw HTTP status, kept so callers can distinguish 401 from 403
   * without parsing message text. */
  httpStatus?: number
  /** True when retrying could plausibly succeed. */
  retryable: boolean
}

export const providerError = (
  code: ProviderErrorCode,
  message: string,
  opts: { providerCode?: string; retryable?: boolean; httpStatus?: number } = {}
): ProviderError => ({
  code,
  message,
  providerCode: opts.providerCode,
  httpStatus: opts.httpStatus,
  retryable: opts.retryable ?? false
})

// ── The provider interface ───────────────────────────────────────────────

export interface VideoProvider {
  metadata(): ProviderMetadata
  /** Is the provider usable at all (key present, model chosen, capable)? */
  validateConfiguration(modelId: string | null): ValidationResult
  /** Refuses models that cannot do start+end frame. */
  validateRequest(request: GenerationRequest): ValidationResult
  /** Pure mapping — no I/O, safe to call in tests and for the preview UI. */
  buildRequest(request: GenerationRequest): SanitizedRequestPreview
  /** Dry run: validate + build + estimate, guaranteed network-free. */
  dryRun(request: GenerationRequest): DryRunResult | { error: ProviderError }
  submitGeneration(request: GenerationRequest): Promise<SubmitResult>
  /**
   * `providerMeta` is the job's persisted provider metadata. Providers whose
   * queue hands back its own urls at submit time (fal.ai returns status_url /
   * response_url / cancel_url) MUST use those rather than rebuilding a path —
   * a rebuilt fal queue url answers 405 and strands a paid request. Optional,
   * so providers without that concept are unaffected.
   */
  getGenerationStatus(
    providerTaskId: string,
    providerMeta?: Record<string, unknown> | null
  ): Promise<StatusResult>
  cancelGeneration(
    providerTaskId: string,
    providerMeta?: Record<string, unknown> | null
  ): Promise<CancelResult>
  /** Downloads the finished media to a managed path. */
  fetchResult(resultUrl: string, targetPath: string): Promise<{ ok: true } | { ok: false; error: ProviderError }>
  /** Monetary estimate. Null when no verified conversion exists — never a
   * guess. Prefer `estimateUsage`. */
  estimateCost(request: GenerationRequest): number | null
  /** Estimate in the provider's billing unit (credits). */
  estimateUsage(request: GenerationRequest): UsageEstimate | null
}
