import { NATIVE_AUDIO_DEFAULT } from '../../../shared/types'
import type { ModelCapabilities } from '../types'

/**
 * THE ONE LIST OF FAL.AI VIDEO MODELS.
 *
 * ── WHY A REGISTRY AND NOT A CONSTANT ────────────────────────────────
 *
 * The model was a single global string in settings, baked into the queue
 * path, the field map, the duration enum and the price. Comparing two
 * models on the same transition — the reason this exists — was not
 * possible without changing a setting that then applied to everything.
 *
 * Everything the UI and the runtime need for ONE model lives in one
 * entry: what to call it, where to send it, what it accepts, what it
 * costs, and how to shape its body. Nothing about a model is stated
 * twice.
 *
 * ── VERIFIED MEANS VERIFIED ──────────────────────────────────────────
 *
 * `confirmed` is not decoration. A model is confirmed only when its
 * endpoint path, request fields, duration vocabulary, response shape and
 * published rate have actually been read from fal.ai's documentation.
 * An unconfirmed entry cannot be submitted: guessing a schema spends the
 * operator's money to discover a 422, and inventing a price is worse
 * than admitting we do not know one.
 */

/** The request we build internally, before any model sees it. */
export interface CanonicalGenerationRequest {
  /** Uploaded URL of the START frame. */
  startImage: string
  /** Uploaded URL of the END frame. */
  endImage: string
  prompt: string
  durationSec: number
  resolution: string
  nativeAudio: boolean
}

export interface FalModel {
  /** The endpoint id. This string IS the queue path. */
  id: string
  /** What the operator sees. Short — the dropdown is not a spec sheet. */
  displayName: string
  /** Full queue submit path, derived from `id`. */
  endpoint: string
  startFrame: boolean
  supportsEndFrame: boolean
  /**
   * Whether this endpoint will generate from a START IMAGE ALONE.
   *
   * Single-image motion needs this, and it is NOT the same question as
   * supportsEndFrame. An endpoint that REQUIRES an end frame cannot be
   * used for it — and the wrong answer here would be papered over by
   * sending the start image twice, which is a fabricated end frame and
   * exactly what must not happen.
   *
   * Only true where the documented schema marks the end image optional.
   */
  supportsStartFrameOnly: boolean
  durationsSec: number[]
  resolutions: string[]
  defaultResolution: string
  /** True when the endpoint accepts an audio flag at all. */
  audioSupport: boolean
  /**
   * Published rate, per output second, keyed by whether audio is on.
   * EMPTY when no rate has been verified — the estimate then reads
   * "unavailable" rather than inventing a number.
   */
  rates: Array<{ nativeAudio: boolean; usdPerSecond: number }>
  /**
   * FALSE blocks submission. See the note above: an unconfirmed schema is
   * a paid experiment, not a feature.
   */
  confirmed: boolean
  verificationNote: string
  /**
   * The body this endpoint actually wants.
   *
   * Per model on purpose. A generic payload sent hopefully at every
   * endpoint is how an unsupported field reaches a provider and rejects
   * the whole request — so each model states its own field names, and a
   * field a model does not support is never emitted.
   */
  buildBody: (request: CanonicalGenerationRequest) => Record<string, unknown>
}

export const FAL_QUEUE_HOST = 'https://queue.fal.run'

const KLING_O3_STANDARD = 'fal-ai/kling-video/o3/standard/image-to-video'

/**
 * Kling O3 Standard — the one model whose contract has been read.
 *
 * Endpoint, queue paths, field names, duration enum, status vocabulary,
 * result field and pricing were all confirmed against fal.ai's official
 * model page and the official client source. Output quality is fixed by
 * the "standard" tier: there is no resolution request field, so the
 * resolution vocabulary is the tier itself rather than a made-up pixel
 * count.
 */
const klingO3Standard: FalModel = {
  id: KLING_O3_STANDARD,
  displayName: 'Kling O3 Standard',
  endpoint: `${FAL_QUEUE_HOST}/${KLING_O3_STANDARD}`,
  startFrame: true,
  supportsEndFrame: true,
  // NOT verified as start-only. The documented input lists image_url and
  // end_image_url without marking the end frame optional, and sending the
  // start image twice to satisfy it would be a fabricated end frame.
  supportsStartFrameOnly: false,
  durationsSec: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  resolutions: ['standard'],
  defaultResolution: 'standard',
  audioSupport: true,
  rates: [
    { nativeAudio: false, usdPerSecond: 0.084 },
    { nativeAudio: true, usdPerSecond: 0.112 }
  ],
  confirmed: true,
  verificationNote:
    'Endpoint, queue paths, field names, duration enum, status vocabulary, result field and pricing confirmed against fal.ai’s official documentation.',
  // The direction IS the product: `image_url` is the START frame and
  // `end_image_url` is the END frame. Reversing them produces backwards
  // property tours, which the suite asserts against.
  buildBody: (r) => ({
    image_url: r.startImage,
    end_image_url: r.endImage,
    prompt: r.prompt,
    duration: String(r.durationSec),
    generate_audio: r.nativeAudio
  })
}

const KLING_26_PRO = 'fal-ai/kling-video/v2.6/pro/image-to-video'

/**
 * Kling 2.6 Pro — verified by the operator against fal.ai's current docs.
 *
 * ── ITS BODY IS NOT O3'S BODY ────────────────────────────────────────
 *
 * The start frame field is `start_image_url`, where O3 calls the same
 * thing `image_url`. Copying O3's mapper would have sent `image_url` to
 * an endpoint that does not know it and omitted the field it requires —
 * a 422 on a paid request, for a reason that would have looked like a
 * model problem rather than ours. This is precisely why each entry
 * builds its own body.
 *
 * ── WHAT IS DELIBERATELY ABSENT ──────────────────────────────────────
 *
 * No resolution field: the documented schema does not have one, so the
 * vocabulary is the tier itself rather than an invented pixel count.
 * `voice_ids` is documented as optional and I2T never sends voices, so
 * it is never emitted — and the voice-control rate is therefore never
 * the one that applies.
 */
const kling26Pro: FalModel = {
  id: KLING_26_PRO,
  displayName: 'Kling 2.6 Pro',
  endpoint: `${FAL_QUEUE_HOST}/${KLING_26_PRO}`,
  startFrame: true,
  supportsEndFrame: true,
  // ── VERIFIED START-FRAME-ONLY ──────────────────────────────────────
  //
  // This was previously false, on the reading that the contract marked
  // only `voice_ids` optional. That reading was wrong: the operator has
  // since checked fal.ai's published schema for this endpoint, where
  // `start_image_url` is REQUIRED and `end_image_url` is OPTIONAL. One
  // endpoint, two valid request shapes — with an end frame it travels
  // between two photographs, without one it moves within a single one.
  supportsStartFrameOnly: true,
  // Only these two. The schema is an enum, not a range.
  durationsSec: [5, 10],
  resolutions: ['standard'],
  defaultResolution: 'standard',
  audioSupport: true,
  rates: [
    { nativeAudio: false, usdPerSecond: 0.07 },
    { nativeAudio: true, usdPerSecond: 0.14 }
  ],
  confirmed: true,
  verificationNote:
    'Endpoint, input contract (prompt, required start_image_url, OPTIONAL end_image_url, duration ' +
    'enum 5|10, generate_audio, optional voice_ids), output shape and per-second pricing verified ' +
    'against fal.ai’s current API documentation. Because end_image_url is optional, this model ' +
    'serves both two-image transitions and single-image motion. Voice control ($0.168/s) is not ' +
    'used: I2T never sends voice_ids.',
  buildBody: (r) => {
    const body: Record<string, unknown> = {
      prompt: r.prompt,
      // THE DIFFERENCE FROM O3: named fields rather than image_url.
      start_image_url: r.startImage,
      duration: String(r.durationSec),
      generate_audio: r.nativeAudio
    }
    // The end frame is OMITTED, not sent empty. An empty string is a
    // value fal.ai would have to interpret; an absent optional field is
    // the documented single-image shape.
    if (r.endImage) body.end_image_url = r.endImage
    return body
  }
}

/**
 * CANDIDATES, DELIBERATELY NOT ENABLED.
 *
 * These are the models asked for, registered so the mechanism around
 * them is real and testable — and left unconfirmed because their
 * contract has NOT been read. The endpoint ids follow the naming pattern
 * of the confirmed entry, which is a reasonable guess and nothing more.
 *
 * What is unknown for each: whether the path is right, whether the end
 * frame field is called `end_image_url`, which durations the enum
 * accepts, whether a resolution field exists, whether audio is supported,
 * and the published rate.
 *
 * Submitting any of that would be spending the operator's money to find
 * out. Confirming one is a small job — read the model page, fill in the
 * fields, flip `confirmed` — and the rest of the product already works
 * the moment that happens.
 */
const UNVERIFIED_NOTE =
  'NOT VERIFIED. The endpoint path follows fal.ai’s documented naming pattern but has not been ' +
  'confirmed, and neither have its request fields, duration vocabulary, resolution options, audio ' +
  'support or price. Confirm these against the model’s fal.ai page before enabling it.'

function unverifiedKling(id: string, displayName: string): FalModel {
  return {
    id,
    displayName,
    endpoint: `${FAL_QUEUE_HOST}/${id}`,
    startFrame: true,
    supportsEndFrame: true,
    supportsStartFrameOnly: false,
    // Deliberately the confirmed model's vocabulary: a placeholder that
    // cannot be mistaken for a researched answer, and unreachable anyway
    // while `confirmed` is false.
    durationsSec: [5, 10],
    resolutions: ['standard'],
    defaultResolution: 'standard',
    audioSupport: false,
    rates: [],
    confirmed: false,
    verificationNote: UNVERIFIED_NOTE,
    buildBody: (r) => ({
      image_url: r.startImage,
      end_image_url: r.endImage,
      prompt: r.prompt,
      duration: String(r.durationSec)
    })
  }
}

export const FAL_MODEL_REGISTRY: FalModel[] = [
  klingO3Standard,
  kling26Pro,
  unverifiedKling('fal-ai/kling-video/v2.1/pro/image-to-video', 'Kling 2.1 Pro')
]

/** The model used when nothing has been chosen. Always a confirmed one. */
export const FAL_DEFAULT_MODEL_ID = KLING_O3_STANDARD

export function falModel(id: string | null | undefined): FalModel | undefined {
  return FAL_MODEL_REGISTRY.find((m) => m.id === id)
}

/**
 * The model a run should use, resolved from a requested id.
 *
 * Falls back to the default rather than throwing, because a stored id
 * from an older build must not make a project unopenable. The caller
 * still checks `confirmed` before spending anything.
 */
export function resolveFalModel(id: string | null | undefined): FalModel {
  return falModel(id) ?? falModel(FAL_DEFAULT_MODEL_ID) ?? FAL_MODEL_REGISTRY[0]
}

/** Models an operator may actually pick for a paid run. */
export function selectableFalModels(): FalModel[] {
  return FAL_MODEL_REGISTRY.filter((m) => m.confirmed)
}

/**
 * Cost for one run, or null when the model publishes no verified rate.
 *
 * Null is a real answer and is rendered as "unavailable — rate not
 * verified". A guessed price is worse than no price: it gets reconciled
 * against an invoice.
 */
export function falRunCost(
  model: FalModel,
  durationSec: number,
  nativeAudio: boolean
): { usd: number; usdPerSecond: number } | null {
  const rate = model.rates.find((r) => r.nativeAudio === nativeAudio)
  if (!rate) return null
  // Rounded to cents at the source. $0.07 × 5 is 0.35000000000000003 in
  // binary floating point, and money that carries that drift into a
  // ledger sum stops reconciling against an invoice.
  return {
    usd: Math.round(rate.usdPerSecond * durationSec * 100) / 100,
    usdPerSecond: rate.usdPerSecond
  }
}

/** The duration this model will accept, nearest to what was asked. */
export function clampDurationForModel(model: FalModel, requestedSec: number): number {
  if (model.durationsSec.length === 0) return requestedSec
  if (model.durationsSec.includes(requestedSec)) return requestedSec
  return model.durationsSec.reduce((best, d) =>
    Math.abs(d - requestedSec) < Math.abs(best - requestedSec) ? d : best
  )
}

export function modelSupportsDuration(model: FalModel, sec: number): boolean {
  return model.durationsSec.includes(sec)
}

export function modelSupportsResolution(model: FalModel, resolution: string): boolean {
  return model.resolutions.includes(resolution)
}

export { NATIVE_AUDIO_DEFAULT }

/**
 * The registry as the renderer sees it.
 *
 * Exported as a function so the IPC handler and the test call the SAME
 * projection — a handler that builds its own shape inline can only be
 * verified by running the whole app, which is how a missing channel went
 * unnoticed behind a mocked one.
 *
 * Every model is sent, including unconfirmed ones: the dialog shows them
 * disabled and says why, which is more useful than a name that silently
 * does not exist.
 */
export interface FalModelPayload {
  id: string
  displayName: string
  durationsSec: number[]
  resolutions: string[]
  defaultResolution: string
  audioSupport: boolean
  confirmed: boolean
  verificationNote: string
  rates: Array<{ nativeAudio: boolean; usdPerSecond: number }>
}

export function modelListPayload(): FalModelPayload[] {
  return FAL_MODEL_REGISTRY.map((m) => ({
    id: m.id,
    displayName: m.displayName,
    durationsSec: m.durationsSec,
    resolutions: m.resolutions,
    defaultResolution: m.defaultResolution,
    audioSupport: m.audioSupport,
    confirmed: m.confirmed,
    verificationNote: m.verificationNote,
    rates: m.rates
  }))
}

/**
 * THE REGISTRY, AS PROVIDER CAPABILITIES.
 *
 * ── THE BUG THIS EXISTS FOR ──────────────────────────────────────────
 *
 * There were TWO lists of fal models: this registry, which decides the
 * endpoint, the body and the price, and `FAL_MODELS` in falConfig, which
 * the provider's `metadata()` published and `validateRequest` checked
 * against. That second list contained only O3.
 *
 * So selecting any other model produced a request the provider refused
 * as "unknown to the fal.ai provider" — including every two-image
 * transition on Kling 2.6 Pro, not only single-image motion. The
 * selector offered models the validator had never heard of.
 *
 * One list. Capabilities are DERIVED from the registry here, so a model
 * that can be chosen is by construction a model that can be validated.
 */
export function falModelCapabilities(): ModelCapabilities[] {
  return FAL_MODEL_REGISTRY.map((m) => ({
    id: m.id,
    label: m.displayName,
    startFrame: m.startFrame,
    endFrame: m.supportsEndFrame,
    durationsSec: m.durationsSec,
    resolutions: m.resolutions,
    defaultResolution: m.defaultResolution,
    nativeAudio: m.audioSupport,
    confirmed: m.confirmed,
    verificationNote: m.verificationNote
  }))
}

/**
 * Models that can generate from a START IMAGE ALONE.
 *
 * The list single-image motion may offer. Kling 2.6 Pro qualifies: its
 * published schema marks `end_image_url` optional, so the same endpoint
 * serves both shapes. A model whose contract requires an end frame is
 * excluded here rather than being sent a fabricated one.
 */
export function startFrameOnlyModels(): FalModel[] {
  return FAL_MODEL_REGISTRY.filter((m) => m.confirmed && m.supportsStartFrameOnly)
}

/** The body for a single-image run — no end frame, ever. */
export function buildSingleImageBody(
  model: FalModel,
  request: Omit<CanonicalGenerationRequest, 'endImage'>
): Record<string, unknown> {
  if (!model.supportsStartFrameOnly) {
    throw new Error(
      `${model.displayName} requires an end frame and cannot generate from a single image.`
    )
  }
  // The model's own mapper, so a single-image body is built by exactly
  // the code that builds a two-image one — one mapper per model, never a
  // parallel single-image mapper to drift out of step.
  //
  // The deletes below are a BACKSTOP, not the mechanism: a start-only
  // model's mapper is expected to omit the field itself when no end
  // image is given (2.6 Pro's does). They exist so that a future mapper
  // written without that care still cannot emit an empty end frame.
  const body = model.buildBody({ ...request, endImage: '' })
  delete body.end_image_url
  delete body.image_url_end
  return body
}
