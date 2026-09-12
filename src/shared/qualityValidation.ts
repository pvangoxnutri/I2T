/**
 * POST-GENERATION QUALITY VALIDATION.
 *
 * ── THE FAILURE THIS EXISTS FOR ──────────────────────────────────────
 *
 * A generated bathroom transition contained a person walking past with a
 * camera, and the app presented it as finished. Everything upstream had
 * done its job: the provider returned a valid MP4, the download
 * succeeded, the file passed integrity checks. Nothing had looked at what
 * was IN it.
 *
 * `shared/reflectionRisk` reduces how often a model is put in a position
 * to invent a person. It cannot make it impossible — no prompt can. So
 * this is the last line: look at the clip that came back, and refuse to
 * call it usable when a human or a camera is in it.
 *
 * ── PROVIDER SUCCESS AND QUALITY ARE DIFFERENT FACTS ─────────────────
 *
 * A provider can succeed technically while the content fails. Collapsing
 * those into one status would make the catalogue lie about what happened,
 * break the resume/retry state machine — which reads provider status to
 * decide whether a paid task can be recovered — and hide from cost
 * history that a real generation was paid for. So they are stored
 * separately and neither is derived from the other.
 *
 * ── FAIL CLOSED, BUT NEVER DESTROY ───────────────────────────────────
 *
 * A clip that fails is kept: the file stays on disk, the catalogue row
 * stays, and the operator can preview it, regenerate, or override. What
 * it may NOT do is become the active clip on its own. The money was
 * spent; the decision about what to do with the result is the operator's.
 */

/** Detection targets, in the validator's own words. */
export const QUALITY_DETECTION_TARGETS = [
  'person',
  'face',
  'hand or body part',
  'human silhouette',
  'photographer',
  'camera operator',
  'camera',
  'phone',
  'tripod',
  'gimbal',
  'drone',
  'filming equipment',
  'human reflection'
] as const

export type QualityConfidence = 'low' | 'medium' | 'high'

export interface SuspiciousFrame {
  frameIndex: number
  reason: string
  confidence: QualityConfidence
}

/** Exactly what the validator is asked to return. */
export interface ClipValidationResult {
  humanDetected: boolean
  humanReflectionDetected: boolean
  cameraEquipmentDetected: boolean
  suspiciousFrames: SuspiciousFrame[]
  pass: boolean
}

/**
 * The quality state of ONE generation.
 *
 * `not-run` is a real state, not a synonym for passed: every clip
 * generated before this existed has it, and those must keep working. It
 * means "nobody looked", which is what was true then.
 */
export type QualityStatus = 'passed' | 'failed' | 'needs-review' | 'not-run'

/** Who decided a clip was acceptable. */
export type QualityOverride = 'manual' | null

export interface QualityOutcome {
  status: QualityStatus
  /** One line, specific enough to argue with. Null only for `not-run`. */
  reason: string | null
  suspiciousFrames: SuspiciousFrame[]
  /** Which validator produced this, for debugging a bad verdict later. */
  validator: string | null
  checkedAt: number | null
}

export const NOT_RUN: QualityOutcome = {
  status: 'not-run',
  reason: null,
  suspiciousFrames: [],
  validator: null,
  checkedAt: null
}

/**
 * When is the check run?
 *
 * ── WHY THE DEFAULT IS `all` ─────────────────────────────────────────
 *
 * It was `reflection-risk-only`, on the reasoning that mirrors are where
 * the known failure came from. That reasoning is too narrow. A model can
 * hallucinate a person into any room — a figure in a doorway, a hand at
 * the edge of frame, a photographer's shadow across a floor — and none of
 * those need a reflective surface. Restricting the check to mirrors made
 * the product's guarantee depend on the analyzer having spotted one,
 * which is exactly the dependency that failed the first time.
 *
 * The cost is real and is stated in Settings rather than hidden. Being
 * charged for a check nobody asked for is a smaller harm than shipping a
 * stranger inside a listing for someone's home.
 *
 * `reflection-risk-only` stays available for anyone who wants to bound
 * the spend, and reflection risk still escalates the INSTRUCTION in
 * every mode — see `reflectionEmphasis`.
 */
export type QualityValidationMode = 'off' | 'reflection-risk-only' | 'all'

export const DEFAULT_QUALITY_VALIDATION_MODE: QualityValidationMode = 'all'

export const QUALITY_MODE_LABEL: Record<QualityValidationMode, string> = {
  all: 'All generated clips',
  'reflection-risk-only': 'Reflective scenes only',
  off: 'Off'
}

/** What the check does, in the operator's terms. */
export const QUALITY_MODE_EXPLANATION =
  'Checks sampled frames after generation for unexpected people, cameras and filming ' +
  'equipment before the clip becomes active.'

/**
 * The cost note.
 *
 * Deliberately says "a small API cost" and no number: Gemini bills per
 * token and this project has not verified a rate for the validator model.
 * A made-up figure would be worse than none — it would be quoted back.
 */
export const QUALITY_MODE_COST_NOTE =
  'This uses an additional Gemini vision request and may incur a small API cost.'

export function shouldValidateClip(
  mode: QualityValidationMode,
  reflectionRisk: boolean
): boolean {
  if (mode === 'off') return false
  if (mode === 'all') return true
  return reflectionRisk
}

/**
 * TURN A VALIDATOR RESPONSE INTO A VERDICT.
 *
 * ── WHY `pass` FROM THE MODEL IS NOT TRUSTED ALONE ───────────────────
 *
 * The validator returns its own `pass` boolean, and it is used — but a
 * model that reports `humanDetected: true` and `pass: true` in the same
 * object has contradicted itself, and the safe reading of a
 * contradiction is the one that does not ship a person to a customer.
 * The flags therefore win over the summary.
 *
 * ── LOW CONFIDENCE IS NOT A PASS ─────────────────────────────────────
 *
 * "Possibly a person, low confidence" is exactly the case where an
 * automatic answer is worth least and a human glance is worth most. It
 * becomes `needs-review`: not shipped, not discarded, waiting for
 * someone to look.
 */
export function decideQuality(
  result: ClipValidationResult,
  validator: string,
  now: number = Date.now()
): QualityOutcome {
  const strong = result.suspiciousFrames.filter(
    (f) => f.confidence === 'medium' || f.confidence === 'high'
  )
  const weak = result.suspiciousFrames.filter((f) => f.confidence === 'low')
  const flagged =
    result.humanDetected || result.humanReflectionDetected || result.cameraEquipmentDetected

  const base = { suspiciousFrames: result.suspiciousFrames, validator, checkedAt: now }

  // A detection with real confidence behind it fails, whatever `pass` said.
  if (flagged && strong.length > 0) {
    return { ...base, status: 'failed', reason: describe(result, strong) }
  }

  // Flagged, but nothing above low confidence — including the case where
  // the model set a flag and listed no frames at all, which is a
  // malformed-but-alarming answer and must not become a pass.
  if (flagged) {
    return {
      ...base,
      status: 'needs-review',
      reason: `${describe(result, weak)} Confidence was low, so this needs a human look.`
    }
  }

  // Nothing flagged, but frames were called suspicious anyway.
  if (strong.length > 0) {
    return {
      ...base,
      status: 'needs-review',
      reason: `The validator flagged ${strong.length} frame(s) without naming what it saw.`
    }
  }

  if (!result.pass) {
    return {
      ...base,
      status: 'needs-review',
      reason: 'The validator did not pass this clip but gave no specific detection.'
    }
  }

  return { ...base, status: 'passed', reason: null }
}

function describe(result: ClipValidationResult, frames: SuspiciousFrame[]): string {
  const what: string[] = []
  if (result.humanDetected) what.push('a person')
  if (result.humanReflectionDetected) what.push('a human reflection')
  if (result.cameraEquipmentDetected) what.push('camera or filming equipment')
  const subject = what.length > 0 ? what.join(' and ') : 'something unexpected'
  const first = frames[0]
  const where = first ? ` in sampled frame ${first.frameIndex}` : ''
  const why = first?.reason ? ` — ${first.reason}` : ''
  return `Detected ${subject}${where}.${why}`
}

/**
 * The verdict when the check itself could not run.
 *
 * A network failure says nothing about the clip, so it must not read as
 * approval. It is the one path where "we do not know" has to be visible
 * rather than resolved by a default.
 */
export function validationUnavailable(reason: string, now: number = Date.now()): QualityOutcome {
  return {
    status: 'needs-review',
    reason: `Automatic quality check could not be completed. ${reason}`,
    suspiciousFrames: [],
    validator: null,
    checkedAt: now
  }
}

/**
 * MAY THIS GENERATION BECOME — OR STAY — THE ACTIVE CLIP?
 *
 * The single rule, used both when a new clip arrives and when export
 * readiness re-checks an attached one, so the two can never disagree.
 *
 * `not-run` passes deliberately: it is every clip made before this
 * feature, and retroactively blocking work the customer already paid for
 * would be a far worse failure than the one being fixed.
 */
export function qualityAllowsActive(
  status: QualityStatus,
  override: QualityOverride
): boolean {
  if (override === 'manual') return true
  return status === 'passed' || status === 'not-run'
}

/** What the operator is agreeing to when they override a failed clip. */
export const QUALITY_OVERRIDE_CONFIRMATION = 'This clip failed the automatic quality check.'
