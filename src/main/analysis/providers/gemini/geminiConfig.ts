/**
 * Gemini analyzer configuration — every vendor constant in one file.
 *
 * The point of isolating these is that swapping to a stronger model, or
 * correcting a rate, must never require touching the domain model, the
 * planner or the editor.
 */

/**
 * THE MODEL.
 *
 * `gemini-2.5-flash` is the default: current, multimodal, supports many
 * images in one request and native structured JSON output, and is the
 * cost-efficient tier — which matters because a property set is 10–30
 * images and this will run repeatedly during evaluation.
 *
 * `gemini-2.5-pro` is offered as the stronger comparison tier. Spatial
 * reasoning across a photo set is exactly the kind of task where the pro
 * model may earn its cost, and the whole reason the model id lives here
 * is so that comparison is a settings change rather than a code change.
 *
 * Gemini 2.0 Flash is deliberately absent — deprecated.
 */
export const GEMINI_MODELS = [
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    note: 'Cost-efficient. Recommended for evaluation runs.'
  },
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    note: 'Stronger reasoning, higher cost. For comparison against Flash.'
  }
] as const

export const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash'

/** Base URL, locked. Never rebuilt from a model id at call time. */
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

export function geminiGenerateUrl(model: string): string {
  return `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`
}

/**
 * ── PRICING IS NOT VERIFIED IN CODE ──────────────────────────────────
 *
 * This project has been burned once already by treating an unconfirmed
 * provider value as fact, so the rule here is the same as for Kling's
 * contract: a rate we have not checked against the vendor's live pricing
 * page is marked UNVERIFIED, and every number derived from it is labelled
 * an estimate.
 *
 * These figures are a starting point for the operator to confirm and
 * correct in Settings — not a promise. `verified: false` is what makes
 * the UI say "estimate, rate not verified" instead of showing a number
 * that looks reconcilable against an invoice and is not.
 *
 * Units are USD per 1M tokens, which is how Google publishes them.
 */
export interface GeminiRate {
  model: string
  inputPerMillion: number
  outputPerMillion: number
  /** Flipped to true only by an operator who has checked the pricing page. */
  verified: boolean
}

export const GEMINI_DEFAULT_RATES: GeminiRate[] = [
  { model: 'gemini-2.5-flash', inputPerMillion: 0.3, outputPerMillion: 2.5, verified: false },
  { model: 'gemini-2.5-pro', inputPerMillion: 1.25, outputPerMillion: 10, verified: false }
]

export function rateFor(model: string): GeminiRate | null {
  return GEMINI_DEFAULT_RATES.find((r) => r.model === model) ?? null
}

/**
 * Token cost of one image, for estimating before submit.
 *
 * Google bills images as tokens, and the exact count depends on
 * dimensions and the tiling the model applies — which we cannot know
 * before sending. This is a documented approximation for a downscaled
 * photo, and it is why the estimate is always presented as a RANGE
 * rather than a figure.
 */
export const GEMINI_APPROX_TOKENS_PER_IMAGE = 1300

/** Spread applied around the estimate, since image tokenisation varies. */
export const GEMINI_ESTIMATE_SPREAD = 0.4

/**
 * ── IMAGE POLICY ─────────────────────────────────────────────────────
 *
 * Deterministic, so two runs of the same project produce the same
 * request and diagnostics are comparable.
 *
 * Longest edge 1568px: enough to keep window frames, cabinetry lines and
 * doorway edges legible — which is the whole point, since fixed
 * architecture carries the spatial weight — while avoiding uploading
 * 24-megapixel originals whose extra detail the model tiles away anyway.
 * Aspect ratio is never altered: a distorted room is a misread room.
 */
export const GEMINI_MAX_EDGE_PX = 1568
export const GEMINI_IMAGE_MIME = 'image/jpeg'
export const GEMINI_IMAGE_QUALITY = 82

/**
 * Hard ceiling on images per request.
 *
 * A property set beyond this is REFUSED with a clear error rather than
 * truncated: silently analysing the first N photos would produce an
 * analysis that looks complete and is not, and every relationship drawn
 * from the missing images would be wrong in a way nobody could see.
 * Chunking with reliable merging is a separate piece of work.
 */
export const GEMINI_MAX_IMAGES = 60
