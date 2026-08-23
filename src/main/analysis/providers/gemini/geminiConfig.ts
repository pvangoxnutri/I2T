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
 * `gemini-3.6-flash` is the default: multimodal, many images in one
 * request, native structured JSON output, and the cost-efficient tier —
 * which matters because a property set is 10–30 images and this runs
 * repeatedly during evaluation.
 *
 * ── WHY 2.5 IS GONE ──────────────────────────────────────────────────
 *
 * `gemini-2.5-flash` returned HTTP 404 against a real key:
 *
 *   "This model is no longer available to new users.
 *    Please update your code to use models/gemini-3.6-flash"
 *
 * That is the provider naming its own replacement, which is far better
 * evidence than anything this file could assert on its own. So the id
 * changed, and the retired ones are listed in RETIRED_GEMINI_MODELS
 * rather than deleted — a project configured before this change still
 * holds `gemini-2.5-flash` in its settings, and it must be TOLD that,
 * not silently switched.
 *
 * ── NO PRO TIER IS LISTED ────────────────────────────────────────────
 *
 * `gemini-2.5-pro` is the same retired generation, and there is no
 * verified id for its replacement. Inventing `gemini-3.6-pro` because it
 * follows the pattern would be a guess dressed as configuration, and this
 * file's whole discipline is that unverified vendor values are marked
 * unverified rather than shipped as fact. A comparison tier returns when
 * an operator can point at a documented id.
 *
 * Gemini 2.0 Flash is deliberately absent — deprecated.
 */
export const GEMINI_MODELS = [
  {
    id: 'gemini-3.6-flash',
    label: 'Gemini 3.6 Flash',
    note: 'Cost-efficient, multimodal, structured output. Recommended.'
  }
] as const

export const GEMINI_DEFAULT_MODEL = 'gemini-3.6-flash'

/**
 * Model ids the provider has retired.
 *
 * Checked BEFORE a request rather than discovered as a 404 afterwards: a
 * stored setting pointing at one of these produces a clear "configured
 * model is unavailable" state instead of a failed paid attempt and a raw
 * JSON blob. The replacement is recorded where the provider named one.
 */
export const RETIRED_GEMINI_MODELS: Record<string, string | null> = {
  'gemini-2.5-flash': 'gemini-3.6-flash',
  // Same generation, same retirement. No replacement id is claimed here
  // because none has been verified — see the note above.
  'gemini-2.5-pro': null,
  'gemini-2.0-flash': 'gemini-3.6-flash'
}

export function isRetiredModel(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(RETIRED_GEMINI_MODELS, model)
}

/** The provider's named replacement, when there is a verified one. */
export function replacementForModel(model: string): string | null {
  return RETIRED_GEMINI_MODELS[model] ?? null
}

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
  // Carried over from the previous flash tier as a starting point ONLY.
  // The model changed and this rate has not been checked against the
  // vendor's pricing page for it, so `verified: false` is doing real work
  // here: every figure derived from it is shown as "unavailable — rate not
  // verified" rather than as a number anyone could reconcile.
  { model: 'gemini-3.6-flash', inputPerMillion: 0.3, outputPerMillion: 2.5, verified: false }
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
