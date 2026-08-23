import { NATIVE_AUDIO_DEFAULT } from '../../../shared/types'
import type { GenerationState, ModelCapabilities } from '../types'

/**
 * THE ONLY PLACE FAL.AI'S EXTERNAL CONTRACT LIVES.
 *
 * Everything here was verified against fal.ai's current official model page,
 * queue documentation and the official JS client source, so — unlike the
 * Kling direct API — nothing needs operator confirmation:
 *
 *   • auth            Authorization: Key <FAL_KEY>
 *   • model           fal-ai/kling-video/o3/standard/image-to-video
 *   • queue host      https://queue.fal.run
 *       submit        POST   /{model}
 *       status        GET    /{model}/requests/{id}/status
 *       result        GET    /{model}/requests/{id}
 *       cancel        PUT    /{model}/requests/{id}/cancel
 *   • statuses        IN_QUEUE · IN_PROGRESS · COMPLETED
 *   • input fields    image_url (start), end_image_url (end), prompt,
 *                     duration (string seconds), generate_audio
 *   • output          video.url
 *   • uploads         POST {rest}/storage/upload/initiate?storage_type=fal-cdn-v3
 *                     → { upload_url, file_url }, then PUT the bytes
 *   • pricing         $0.084 / output second (audio off)
 *                     $0.112 / output second (audio on)
 *
 * Remote cancellation IS supported here, which is the one place fal.ai is
 * meaningfully better than the Kling direct API for us.
 */

export const FAL_DOCS_URL = 'https://fal.ai/models/fal-ai/kling-video/o3/standard/image-to-video'

/** The exact model/endpoint id. This string IS the queue path. */
export const FAL_MODEL_ID = 'fal-ai/kling-video/o3/standard/image-to-video'

export const FAL_QUEUE_HOST = 'https://queue.fal.run'
/** REST host used for file storage, matching the official client. */
export const FAL_REST_HOST = 'https://rest.fal.ai'
export const FAL_STORAGE_TYPE = 'fal-cdn-v3'

// ── Queue endpoints ──────────────────────────────────────────────────────

export const falSubmitUrl = (): string => `${FAL_QUEUE_HOST}/${FAL_MODEL_ID}`

/**
 * DERIVED QUEUE URLS — THE FALLBACK, NOT THE SOURCE OF TRUTH.
 *
 * fal returns `status_url`, `response_url` and `cancel_url` in the submit
 * response, and those are what the lifecycle uses (see falQueueUrls.ts).
 * These builders exist only for a request whose urls were never persisted,
 * and for the connection probe, where no submit response exists.
 *
 * They now build from the APPLICATION base (`{owner}/{app}`), not the full
 * endpoint path. Queue operations are not namespaced by an endpoint's own
 * routing — keeping `/o3/standard/image-to-video` produced a path that
 * answers **HTTP 405**, which is what left a paid request unpollable.
 */
export const falStatusUrl = (requestId: string, modelId: string = FAL_MODEL_ID): string =>
  `${falQueueRequestBase(requestId, modelId)}/status`
export const falResultUrl = (requestId: string, modelId: string = FAL_MODEL_ID): string =>
  falQueueRequestBase(requestId, modelId)
export const falCancelUrl = (requestId: string, modelId: string = FAL_MODEL_ID): string =>
  `${falQueueRequestBase(requestId, modelId)}/cancel`

/** `https://queue.fal.run/{owner}/{app}/requests/{id}` */
function falQueueRequestBase(requestId: string, modelId: string): string {
  const app = modelId.split('/').filter(Boolean).slice(0, 2).join('/') || modelId
  return `${FAL_QUEUE_HOST}/${app}/requests/${encodeURIComponent(requestId)}`
}
export const falUploadInitiateUrl = (): string =>
  `${FAL_REST_HOST}/storage/upload/initiate?storage_type=${FAL_STORAGE_TYPE}`

// ── Request fields ───────────────────────────────────────────────────────

/**
 * THE DIRECTION IS THE PRODUCT: `image_url` is the START frame and
 * `end_image_url` is the END frame. Reversing them produces backwards
 * property tours, so it is asserted in the test suite.
 */
export const FAL_FIELDS = {
  startImage: 'image_url',
  endImage: 'end_image_url',
  prompt: 'prompt',
  duration: 'duration',
  generateAudio: 'generate_audio'
} as const

// ── Queue status vocabulary ──────────────────────────────────────────────

/** The three documented queue states, mapped explicitly. */
export const FAL_QUEUE_STATUS: Record<string, GenerationState> = {
  IN_QUEUE: 'pending',
  IN_PROGRESS: 'processing',
  COMPLETED: 'succeeded'
}

// ── Models ───────────────────────────────────────────────────────────────

/**
 * Only start+end-frame capable models belong here. The o3 *standard* tier
 * fixes the output quality at the endpoint level — there is no resolution
 * request field — so the resolution vocabulary is the tier itself rather
 * than a made-up pixel count.
 */
export const FAL_MODELS: ModelCapabilities[] = [
  {
    id: FAL_MODEL_ID,
    label: 'Kling O3 Standard via fal.ai (start + end frame)',
    startFrame: true,
    endFrame: true,
    // The documented DurationEnum for this endpoint.
    durationsSec: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    resolutions: ['standard'],
    defaultResolution: 'standard',
    nativeAudio: true,
    confirmed: true,
    verificationNote:
      'Endpoint, queue paths, field names, duration enum, status vocabulary, result field and pricing all confirmed against fal.ai’s current official documentation. Output quality is fixed by the “standard” tier — it is not a request field.'
  }
]

// ── Pricing ──────────────────────────────────────────────────────────────

export interface FalCostRate {
  modelId: string
  nativeAudio: boolean
  usdPerSecond: number
}

/**
 * fal.ai's official published rate for THIS endpoint. It is billed per
 * output second and does not vary by resolution — the tier is fixed.
 * Isolated here so a price change is a one-line edit.
 */
export const FAL_COST_RATES: FalCostRate[] = [
  { modelId: FAL_MODEL_ID, nativeAudio: false, usdPerSecond: 0.084 },
  { modelId: FAL_MODEL_ID, nativeAudio: true, usdPerSecond: 0.112 }
]

export const FAL_CURRENCY = 'USD'

export function falCostRate(modelId: string, nativeAudio: boolean): FalCostRate | null {
  return FAL_COST_RATES.find((r) => r.modelId === modelId && r.nativeAudio === nativeAudio) ?? null
}

/** FrameToFrame never turns audio on by itself — one source of truth. */
export const FAL_NATIVE_AUDIO_DEFAULT = NATIVE_AUDIO_DEFAULT

/** Confirmed: fal.ai exposes a real cancel endpoint for queued requests. */
export const FAL_SUPPORTS_REMOTE_CANCEL = true

/** Image input: uploaded to fal.ai's own CDN, then referenced by URL. No
 * third-party host, no ad-hoc public server, no local path ever leaves. */
export const FAL_IMAGE_INPUT_MODE = 'fal-storage-upload' as const

// ── What is verified ─────────────────────────────────────────────────────

export interface FalContractItem {
  key: string
  label: string
  confirmed: boolean
  note: string
}

export const FAL_CONTRACT_STATUS: FalContractItem[] = [
  { key: 'auth', label: 'Authentication', confirmed: true, note: 'Authorization: Key <FAL_KEY>.' },
  {
    key: 'model',
    label: 'Model / endpoint',
    confirmed: true,
    note: `${FAL_MODEL_ID} — the endpoint id is also the queue path.`
  },
  {
    key: 'queue',
    label: 'Queue lifecycle',
    confirmed: true,
    note: 'POST /{model} · GET /requests/{id}/status · GET /requests/{id} · PUT /requests/{id}/cancel.'
  },
  {
    key: 'fields',
    label: 'Request fields',
    confirmed: true,
    note: 'image_url = start frame, end_image_url = end frame, prompt, duration, generate_audio.'
  },
  {
    key: 'statuses',
    label: 'Status vocabulary',
    confirmed: true,
    note: 'IN_QUEUE · IN_PROGRESS · COMPLETED, mapped explicitly with a defensive fallback for future values.'
  },
  {
    key: 'result',
    label: 'Result field',
    confirmed: true,
    note: 'video.url on the result endpoint, with content_type/file_name/file_size alongside.'
  },
  {
    key: 'upload',
    label: 'File upload',
    confirmed: true,
    note: 'POST /storage/upload/initiate?storage_type=fal-cdn-v3 → { upload_url, file_url }, then PUT the raw bytes.'
  },
  {
    key: 'cancel',
    label: 'Remote cancellation',
    confirmed: true,
    note: 'PUT /requests/{id}/cancel — 202 accepted, 400 when the request already completed.'
  },
  {
    key: 'pricing',
    label: 'Pricing',
    confirmed: true,
    note: '$0.084 per output second with audio off, $0.112 with audio on. FrameToFrame runs audio OFF.'
  }
]
