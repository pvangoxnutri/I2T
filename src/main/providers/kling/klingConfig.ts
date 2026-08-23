import { NATIVE_AUDIO_DEFAULT } from '../../../shared/types'
import type { GenerationState, ModelCapabilities } from '../types'

/**
 * THE ONLY PLACE KLING'S EXTERNAL CONTRACT LIVES.
 *
 * Values are split in two, deliberately:
 *
 *   LOCKED   — verified against current official Kling documentation. These
 *              come from application configuration and the operator can no
 *              longer edit (or mistype) them. A stale override can therefore
 *              never point paid traffic at the wrong host or model.
 *   UNLOCKED — genuinely not verified yet. Isolated, labelled, and
 *              operator-overridable in Settings so verifying one is a
 *              settings edit, not a code change.
 *
 * LOCKED (confirmed):
 *   • auth               Authorization: Bearer <API_KEY>
 *   • base URL           https://api-singapore.klingai.com
 *   • submit endpoint    POST /image-to-video/kling-3.0
 *   • model id           kling-v3-omni
 *   • frame fields       `image` = start frame, `image_tail` = end frame
 *   • capability         Start & End Frames-to-Video, up to 15 s
 *   • duration/resolution are configurable (4K available)
 *   • status vocabulary  submitted | processing | succeed | failed
 *   • API pricing        credits/second, NO VIDEO INPUT (see KLING_CREDIT_RATES)
 *
 * STILL UNCONFIRMED:
 *   • the exact task-status query path
 *   • the exact result response path / video URL field
 *   • whether remote task cancellation exists
 *   • the request field name for native audio (so we never send one)
 *   • an official credit → currency conversion (so we show credits only)
 */

export const KLING_DOCS_URL = 'https://app.klingai.com/global/dev/document-api'

/**
 * LOCKED transport contract. Not operator-editable: these are confirmed, and
 * an editable field is a field that can be wrong on a paid request.
 */
export const KLING_LOCKED_CONTRACT = {
  baseUrl: 'https://api-singapore.klingai.com',
  /** Submit endpoint (POST). Full URL: baseUrl + this path. */
  imageToVideoPath: '/image-to-video/kling-3.0',
  /** `model_name` value sent with the request. */
  modelId: 'kling-v3-omni'
} as const

/**
 * UNCONFIRMED default. Derived from the confirmed submit path, which is the
 * most plausible shape — but it is NOT verified, so it stays overridable and
 * is labelled as such in Settings. `{id}` is replaced with the task id.
 */
export const KLING_DEFAULT_TASK_STATUS_PATH = '/image-to-video/kling-3.0/{id}'

/** Everything the transport needs, locked values plus the one override. */
export interface KlingContract {
  baseUrl: string
  imageToVideoPath: string
  taskStatusPath: string
  modelId: string
}

/** The ONLY part of the contract an operator may still override. */
export type KlingContractOverrides = Partial<{ taskStatusPath: string }>

export function resolveContract(overrides?: KlingContractOverrides): KlingContract {
  return {
    baseUrl: KLING_LOCKED_CONTRACT.baseUrl,
    imageToVideoPath: KLING_LOCKED_CONTRACT.imageToVideoPath,
    taskStatusPath: overrides?.taskStatusPath?.trim() || KLING_DEFAULT_TASK_STATUS_PATH,
    modelId: KLING_LOCKED_CONTRACT.modelId
  }
}

/** Kept for the Settings "developer details" view. */
export const KLING_DEFAULT_CONTRACT: KlingContract = resolveContract()

// ── What is / is not verified ────────────────────────────────────────────

export interface KlingContractStatus {
  key: string
  label: string
  confirmed: boolean
  /** True when the value now comes from locked application configuration. */
  locked: boolean
  note: string
}

/** Rendered in Settings so the operator sees exactly what is/isn't known. */
export const KLING_CONTRACT_STATUS: KlingContractStatus[] = [
  {
    key: 'auth',
    label: 'Authentication',
    confirmed: true,
    locked: true,
    note: 'Authorization: Bearer <API_KEY> — the modern Kling scheme.'
  },
  {
    key: 'baseUrl',
    label: 'Base URL',
    confirmed: true,
    locked: true,
    note: `${KLING_LOCKED_CONTRACT.baseUrl} — confirmed and locked in application configuration.`
  },
  {
    key: 'submitEndpoint',
    label: 'Image-to-video submit endpoint',
    confirmed: true,
    locked: true,
    note: `POST ${KLING_LOCKED_CONTRACT.imageToVideoPath} — confirmed and locked.`
  },
  {
    key: 'modelId',
    label: 'Model identifier',
    confirmed: true,
    locked: true,
    note: `${KLING_LOCKED_CONTRACT.modelId} — confirmed. Kling 3.0 Turbo stays excluded: it does not cover start + end frame.`
  },
  {
    key: 'frameFields',
    label: 'Start/end frame request fields',
    confirmed: true,
    locked: true,
    note: '`image` = start frame, `image_tail` = end frame. Asserted at runtime before every submit.'
  },
  {
    key: 'frameCapability',
    label: 'Start & End Frames-to-Video',
    confirmed: true,
    locked: true,
    note: 'Kling VIDEO 3.0 Omni officially supports Start & End Frames-to-Video and up to 15-second generation.'
  },
  {
    key: 'duration',
    label: 'Duration configuration',
    confirmed: true,
    locked: true,
    note: 'Configurable up to 15 s. The mapper snaps a request to the nearest offered value.'
  },
  {
    key: 'resolution',
    label: 'Output resolution',
    confirmed: true,
    locked: true,
    note: 'Configurable; 720p, 1080p and 4K are available. FrameToFrame defaults to 1080p.'
  },
  {
    key: 'statusVocabulary',
    label: 'Task status vocabulary',
    confirmed: true,
    locked: true,
    note: 'submitted · processing · succeed · failed — mapped explicitly. Unknown future values still fall back to pattern matching.'
  },
  {
    key: 'pricing',
    label: 'API pricing (credits)',
    confirmed: true,
    locked: true,
    note: 'Official 3.0 Omni NO VIDEO INPUT rates: 720p 6/9 and 1080p 8/12 credits per second (audio off/on). FrameToFrame runs audio OFF.'
  },
  {
    key: 'taskStatusPath',
    label: 'Task status query path',
    confirmed: false,
    locked: false,
    note: `Not verified. Default ${KLING_DEFAULT_TASK_STATUS_PATH} is derived from the confirmed submit path — correct it below if the documentation differs.`
  },
  {
    key: 'resultFields',
    label: 'Result response fields',
    confirmed: false,
    locked: false,
    note: 'The result video URL is read defensively from several shapes; a missing URL fails the job instead of guessing.'
  },
  {
    key: 'remoteCancel',
    label: 'Remote task cancellation',
    confirmed: false,
    locked: false,
    note: 'Not confirmed to exist. Cancelling only stops local polling — we never claim the remote task stopped.'
  },
  {
    key: 'nativeAudioField',
    label: 'Native audio request field',
    confirmed: false,
    locked: false,
    note: 'The field name is not verified, so FrameToFrame sends none. Audio is never enabled automatically; cost is estimated at the audio-OFF rate.'
  },
  {
    key: 'creditToMoney',
    label: 'Credit → currency conversion',
    confirmed: false,
    locked: false,
    note: 'No official money-per-credit conversion is published in the API pricing configuration, so estimates are shown in credits only.'
  }
]

// ── Request fields ───────────────────────────────────────────────────────

/**
 * Request field names. CONFIRMED: `image` is the start frame and
 * `image_tail` is the end frame — this direction is the whole product and is
 * asserted in the test suite.
 */
export const KLING_FIELDS = {
  startImage: 'image',
  endImage: 'image_tail',
  model: 'model_name',
  prompt: 'prompt',
  duration: 'duration',
  aspectRatio: 'aspect_ratio',
  mode: 'mode'
} as const

// ── Status vocabulary ────────────────────────────────────────────────────

/**
 * The confirmed task statuses, mapped explicitly. Anything outside this set
 * is a future/unknown value and falls back to defensive pattern matching
 * rather than being treated as a failure.
 */
export const KLING_TASK_STATUS: Record<string, GenerationState> = {
  submitted: 'pending',
  processing: 'processing',
  succeed: 'succeeded',
  failed: 'failed'
}

// ── Models ───────────────────────────────────────────────────────────────

/**
 * Models offered for the FrameToFrame workflow. ONLY start+end-frame capable
 * models belong here — a model that cannot honour the end frame would
 * silently produce the wrong video. Kling 3.0 Turbo is deliberately absent
 * for exactly that reason.
 */
export const KLING_MODELS: ModelCapabilities[] = [
  {
    id: KLING_LOCKED_CONTRACT.modelId,
    label: 'Kling 3.0 Omni (start + end frame)',
    startFrame: true,
    endFrame: true,
    // Confirmed: configurable up to 15 s. These are the values we offer; the
    // mapper snaps a request to the nearest one.
    durationsSec: [5, 10, 15],
    resolutions: ['720p', '1080p', '4K'],
    // Capability exists. FrameToFrame keeps it OFF — see
    // KLING_NATIVE_AUDIO_DEFAULT and the `nativeAudioField` contract item.
    nativeAudio: true,
    defaultResolution: '1080p',
    confirmed: true,
    verificationNote:
      'Base URL, submit endpoint, model id, image/image_tail fields, start+end frame capability, status vocabulary and credit pricing are confirmed and locked. The task-status path, result field and remote cancellation are not.'
  }
]

// ── Pricing ──────────────────────────────────────────────────────────────

export interface KlingCreditRate {
  modelId: string
  resolution: string
  nativeAudio: boolean
  creditsPerSecond: number
}

/**
 * Official Kling 3.0 Omni API rates for the NO VIDEO INPUT workflow — which
 * is exactly FrameToFrame: we supply images only, never a source video.
 *
 * Isolated here on purpose: updating Kling's price list is a one-table edit.
 * 4K is intentionally absent — no verified rate, so a 4K estimate reports
 * "unavailable" instead of inventing a number.
 */
export const KLING_CREDIT_RATES: KlingCreditRate[] = [
  { modelId: KLING_LOCKED_CONTRACT.modelId, resolution: '720p', nativeAudio: false, creditsPerSecond: 6 },
  { modelId: KLING_LOCKED_CONTRACT.modelId, resolution: '1080p', nativeAudio: false, creditsPerSecond: 8 },
  { modelId: KLING_LOCKED_CONTRACT.modelId, resolution: '720p', nativeAudio: true, creditsPerSecond: 9 },
  { modelId: KLING_LOCKED_CONTRACT.modelId, resolution: '1080p', nativeAudio: true, creditsPerSecond: 12 }
]

export function creditRateFor(
  modelId: string,
  resolution: string,
  nativeAudio: boolean
): KlingCreditRate | null {
  return (
    KLING_CREDIT_RATES.find(
      (r) => r.modelId === modelId && r.resolution === resolution && r.nativeAudio === nativeAudio
    ) ?? null
  )
}

/**
 * No official money-per-credit conversion is published in the API pricing
 * configuration, so cost is reported in CREDITS. Setting this to a verified
 * value is the only change needed to also show a monetary estimate.
 */
export const KLING_CREDIT_TO_MONEY: { currency: string; perCredit: number } | null = null

/** FrameToFrame never turns audio on by itself — one source of truth. */
export const KLING_NATIVE_AUDIO_DEFAULT = NATIVE_AUDIO_DEFAULT

/** Unconfirmed → we never claim a remote task was cancelled. */
export const KLING_SUPPORTS_REMOTE_CANCEL = false

/** Image input: base64-encoded managed bytes — needs no third-party host and
 * never exposes a local path. */
export const KLING_IMAGE_INPUT_MODE = 'base64' as const
