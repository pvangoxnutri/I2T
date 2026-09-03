import { DEFAULT_TRANSITION_PROMPT } from './prompts'
import {
  evaluateTransitionSafety,
  type TransitionSafetyVerdict
} from './transitionSafety'
import {
  relateImages,
  type CameraOrientation,
  type PropertyAnalysis,
  type SpatialRelation
} from './propertyAnalysis'
import {
  deriveRotation,
  deriveTranslation,
  gatherPairEvidence,
  hasPairEvidence,
  type PairEvidence,
  type RotationDirection,
  type TranslationDirection
} from './transitionEvidence'
export type { RotationDirection, TranslationDirection }
import {
  connectionFactKey,
  navigationBlockedBy,
  type ReviewVerdict
} from './analysisReview'

/**
 * A STRUCTURED transition plan, decided before any wording exists.
 *
 * ── WHY A STRUCTURE AND NOT A STRING ─────────────────────────────────
 *
 * The planner used to go straight from "what do we know" to an English
 * sentence, which made the one rule that really matters — whether
 * physical navigation is permitted — a property of prose. Prose cannot be
 * asserted on, and a reworded sentence could quietly start describing a
 * doorway nobody had seen.
 *
 * `physicalNavigationAllowed` is now a boolean the tests can pin, and the
 * text is rendered from it. Wording can change freely; the safety rule
 * cannot drift with it.
 *
 * ── CONTINUITY ───────────────────────────────────────────────────────
 *
 * Clips are generated one pair at a time but watched in sequence. If 1→2
 * ends rotating clockwise and 2→3 opens with a hard counter-rotation, the
 * seam reads as a cut no matter how well the frames match. Each plan
 * therefore carries the motion it hands over, and the next plan sees it.
 *
 * Deliberately a HINT, not a constraint: the end frame is still the
 * highest priority, and over-specifying camera behaviour is how these
 * models start ignoring the frame they were given.
 */

export type RelationType = 'SAME_ROOM' | 'ADJACENT_ROOM' | 'UNKNOWN'
export type MotionSpeed = 'slow' | 'moderate'

/**
 * The neutral instruction used when the evidence does not support a
 * direction.
 *
 * ── WHY A CONSTANT ───────────────────────────────────────────────────
 *
 * This is what "we do not know" looks like on screen, and it must be
 * identical everywhere so it is recognisable as an absence of evidence
 * rather than as one more variation of a camera path. It names no
 * rotation, no bearing and no architecture.
 */
export const NEUTRAL_MOTION =
  'Use restrained cinematic camera movement that preserves visible geometry and converges exactly to the end frame. Do not imply movement through unseen architecture.'

export interface ContinuityHints {
  /** Rotation the previous clip finished on, if any. */
  incomingRotation: RotationDirection
  /** Rotation this clip hands to the next one. */
  outgoingRotation: RotationDirection
  speed: MotionSpeed
  /**
   * Every I2T clip must settle on its exact end frame, so this is always
   * true. It is carried explicitly so the renderer cannot forget it and
   * so a future plan type cannot quietly opt out.
   */
  staticEndpoint: true
}

export interface TransitionPlan {
  fromImageId: string
  toImageId: string
  relationType: RelationType
  /**
   * Set when a reviewer's verdict — not the evidence — is what stopped
   * navigation. Surfaced next to the plan so the operator can see that a
   * confirmed connection was overridden by their own judgement.
   */
  reviewBlock?: string
  confidence: 'confirmed' | 'probable' | 'unknown'

  // ── EVIDENCE, as facts ──────────────────────────────────────────────
  sharedLandmarks: string[]
  /** Visible in the start frame and not the end — the camera turned away. */
  leavingLandmarks: string[]
  /** Visible in the end frame and not the start — the camera turned toward. */
  enteringLandmarks: string[]
  /** Openings visible in the START frame. The only basis for moving through one. */
  visibleOpenings: string[]
  /** The landmark the camera should hold on, when there is one. */
  anchorLandmark: string | null
  startOrientation: CameraOrientation
  endOrientation: CameraOrientation
  /** Derived from two compass headings, or `unknown`. NEVER a default. */
  rotationDirection: RotationDirection
  translationDirection: TranslationDirection
  /** The opening actually being travelled through, when one is. */
  visiblePassage: string | null
  /** Which images this plan was actually derived from. */
  evidenceImageIds: string[]
  /** False when nothing pair-specific was found — see NEUTRAL_MOTION. */
  hasEvidence: boolean

  /**
   * THE SAFETY BIT. False unless a confirmed adjacency has an opening
   * visible in the start frame.
   */
  physicalNavigationAllowed: boolean
  /** True when nothing is known and only the base prompt applies. */
  useBaseSafetyMotion: boolean
  /**
   * The rendered motion sentence, or null when the neutral instruction
   * applies. Rendered FROM the evidence above — never written first.
   */
  motionInstruction: string | null
  continuity: ContinuityHints
  /** Plain-language reason, for the plan review list. */
  rationale: string
  /**
   * WHETHER A GENERATED MOVE IS ALLOWED, and why — from the single
   * evaluator shared with the feed proposal.
   *
   * Kept as its own field rather than folded into the evidence above
   * because the rest of this plan answers "how should the camera move",
   * while this answers "may it move at all". Those were once decided by
   * two different rule sets that disagreed; see `shared/transitionSafety`.
   */
  safetyVerdict: TransitionSafetyVerdict
}

/**
 * Render the motion sentence FROM the evidence.
 *
 * ── ORDER MATTERS ────────────────────────────────────────────────────
 *
 * Each clause is emitted only if the fact behind it exists. A pair with a
 * shared anchor and a departing landmark gets a sentence about those; a
 * pair with nothing gets no sentence at all and falls back to the neutral
 * instruction. Nothing here has a default — that is the whole point.
 */
function renderMotion(
  evidence: PairEvidence,
  rotation: RotationDirection,
  translation: TranslationDirection,
  passage: string | null
): string | null {
  const parts: string[] = []

  if (passage) {
    parts.push(`advance through the ${passage} visible in the start frame`)
  } else if (translation === 'lateral') {
    parts.push('reposition smoothly between the two viewpoints')
  }

  // A turn is described ONLY when its direction was derived from two
  // compass headings. `unknown` and `none` say nothing.
  if (rotation === 'clockwise' || rotation === 'counter-clockwise') {
    parts.push(`rotating ${rotation}`)
  }

  if (evidence.sharedLandmarks.length > 0) {
    parts.push(`keeping the ${evidence.sharedLandmarks[0]} continuously in view`)
  }

  // What leaves and enters frame is real, observed, and different for
  // every pair — which is exactly what a generic template could not be.
  if (evidence.leavingLandmarks.length > 0 && evidence.enteringLandmarks.length > 0) {
    parts.push(
      `turning away from the ${evidence.leavingLandmarks[0]} toward the ${evidence.enteringLandmarks[0]}`
    )
  } else if (evidence.enteringLandmarks.length > 0) {
    parts.push(`bringing the ${evidence.enteringLandmarks[0]} into frame`)
  } else if (evidence.leavingLandmarks.length > 0) {
    parts.push(`letting the ${evidence.leavingLandmarks[0]} leave frame`)
  }

  if (parts.length === 0) return null
  return `${parts.join(', ')}.`
}

function planFromRelation(
  relation: SpatialRelation,
  evidence: PairEvidence,
  previous: TransitionPlan | null,
  reviewBlock: string | null
  // The AI/CUT verdict is deliberately NOT this function's business — it
  // describes motion, not permission — so it is not part of what it returns.
): Omit<TransitionPlan, 'fromImageId' | 'toImageId' | 'safetyVerdict'> {
  const incomingRotation: RotationDirection = previous?.continuity.outgoingRotation ?? 'none'
  // Derived from the two recorded headings, or `unknown`. There is no
  // longer any path that manufactures one.
  const rotation = deriveRotation(evidence.startOrientation, evidence.endOrientation)

  const base = {
    sharedLandmarks: evidence.sharedLandmarks,
    leavingLandmarks: evidence.leavingLandmarks,
    enteringLandmarks: evidence.enteringLandmarks,
    startOrientation: evidence.startOrientation,
    endOrientation: evidence.endOrientation,
    rotationDirection: rotation,
    evidenceImageIds: evidence.evidenceImageIds,
    continuity: {
      incomingRotation,
      // Only a DERIVED rotation is handed on. Passing `unknown` forward as
      // if it were a direction is how one invented turn used to propagate
      // down an entire thirty-image sequence.
      outgoingRotation: rotation,
      speed: 'slow' as MotionSpeed,
      staticEndpoint: true as const
    }
  }

  if (relation.kind === 'same-room') {
    const anchor = evidence.sharedLandmarks[0] ?? null
    const translation = deriveTranslation(evidence, false)
    const motion = renderMotion(evidence, rotation, translation, null)
    return {
      ...base,
      relationType: 'SAME_ROOM',
      confidence: 'confirmed',
      visibleOpenings: [],
      anchorLandmark: anchor,
      translationDirection: translation,
      visiblePassage: null,
      hasEvidence: hasPairEvidence(evidence, rotation, translation),
      // Repositioning inside one room is not navigation between spaces.
      physicalNavigationAllowed: false,
      useBaseSafetyMotion: false,
      motionInstruction: motion,
      rationale: motion
        ? `Both images are assigned to ${relation.room.label}. ${describeEvidence(evidence, rotation)}`
        : `Both images are assigned to ${relation.room.label}, but nothing pair-specific was recorded — no shared landmark, no orientation, no overlap. Safe cinematic motion is used.`
    }
  }

  if (relation.kind === 'adjacent-room') {
    // A confirmed edge is NOT enough on its own. The camera can only move
    // through an opening it can actually see from where it is standing —
    // and a reviewer who marked the connection Incorrect or Unsure
    // overrides the evidence entirely. That override only ever makes this
    // MORE conservative; a review can never unlock navigation.
    const evidenceAllows = relation.confidence === 'confirmed' && relation.openings.length > 0
    const canNavigate = evidenceAllows && reviewBlock === null
    const passage = canNavigate ? (relation.openings[0] ?? null) : null
    const translation = deriveTranslation(evidence, canNavigate)
    const motion = renderMotion(evidence, rotation, translation, passage)
    return {
      ...base,
      relationType: 'ADJACENT_ROOM',
      confidence: relation.confidence === 'confirmed' ? 'confirmed' : 'probable',
      visibleOpenings: relation.openings,
      anchorLandmark: evidence.sharedLandmarks[0] ?? relation.openings[0] ?? null,
      translationDirection: translation,
      visiblePassage: passage,
      hasEvidence: hasPairEvidence(evidence, rotation, translation),
      physicalNavigationAllowed: canNavigate,
      useBaseSafetyMotion: false,
      motionInstruction: motion,
      continuity: {
        ...base.continuity,
        speed: canNavigate ? 'moderate' : 'slow'
      },
      reviewBlock: reviewBlock ?? undefined,
      rationale: reviewBlock
        ? reviewBlock
        : canNavigate
          ? `Confirmed connection ${relation.from.label} → ${relation.to.label}, with ${relation.openings.join(', ')} visible in the start image.`
          : relation.openings.length === 0
            ? `${relation.from.label} → ${relation.to.label} is ${relation.confidence}, but no opening is visible in the start image.`
            : `${relation.from.label} → ${relation.to.label} is only ${relation.confidence}.`
    }
  }

  // UNKNOWN — the safe default, and a correct answer.
  return {
    ...base,
    relationType: 'UNKNOWN',
    confidence: 'unknown',
    visibleOpenings: [],
    anchorLandmark: null,
    translationDirection: 'unknown',
    visiblePassage: null,
    hasEvidence: false,
    physicalNavigationAllowed: false,
    useBaseSafetyMotion: true,
    motionInstruction: null,
    continuity: {
      ...base.continuity,
      // Claims nothing about where the camera ends up, so it hands the
      // next clip no rotation to continue.
      outgoingRotation: 'none'
    },
    rationale: 'No confident spatial relationship between these images.'
  }
}

/** One line naming what the plan was actually built from. */
function describeEvidence(evidence: PairEvidence, rotation: RotationDirection): string {
  const bits: string[] = []
  if (evidence.sharedLandmarks.length > 0) {
    bits.push(`shares ${evidence.sharedLandmarks.join(', ')}`)
  }
  if (evidence.enteringLandmarks.length > 0) {
    bits.push(`${evidence.enteringLandmarks.join(', ')} enters frame`)
  }
  if (evidence.leavingLandmarks.length > 0) {
    bits.push(`${evidence.leavingLandmarks.join(', ')} leaves frame`)
  }
  if (rotation === 'clockwise' || rotation === 'counter-clockwise') {
    bits.push(`heading turns ${rotation}`)
  }
  return bits.length > 0 ? `Evidence: ${bits.join('; ')}.` : ''
}

/**
 * Plan every transition in sequence, so each one can see the one before
 * it. Order matters — that is the whole point of continuity.
 */
export function planSequence(
  analysis: PropertyAnalysis | null,
  imageIds: string[],
  /**
   * Ground-truth verdicts, keyed by connection fact key. Optional — with
   * no reviews the evidence rules apply exactly as before.
   */
  reviews?: Map<string, ReviewVerdict>
): TransitionPlan[] {
  const plans: TransitionPlan[] = []
  for (let i = 0; i < imageIds.length - 1; i++) {
    const from = imageIds[i]
    const to = imageIds[i + 1]
    const relation: SpatialRelation = analysis
      ? relateImages(analysis, from, to)
      : { kind: 'unknown' }

    // A reviewer's verdict on THIS connection, if there is one.
    let reviewBlock: string | null = null
    if (analysis && reviews && relation.kind === 'adjacent-room') {
      const key = connectionFactKey(relation.from.label, relation.to.label)
      reviewBlock = navigationBlockedBy(reviews.get(key) ?? 'unreviewed')
    }

    plans.push({
      fromImageId: from,
      toImageId: to,
      ...planFromRelation(
        relation,
        gatherPairEvidence(analysis, from, to),
        plans[i - 1] ?? null,
        reviewBlock
      ),
      // THE AI/CUT DECISION IS NOT MADE HERE. It comes from the one
      // evaluator the feed proposal also uses, so the two cannot reach
      // different conclusions about the same pair. Everything above
      // describes how the camera should MOVE when a move is allowed,
      // which is a separate question.
      safetyVerdict: evaluateTransitionSafety(analysis, from, to, reviews)
    })
  }
  return plans
}

/**
 * Turn a plan into the motion instruction appended to the safety prompt.
 *
 * The base prompt ALWAYS leads and is never modified. This only ever adds
 * a paragraph under its own heading, so it cannot be read as overriding a
 * rule above it — and an UNKNOWN plan adds nothing at all.
 */
export function renderMotionInstruction(
  plan: TransitionPlan,
  labels: { fromRoom?: string; toRoom?: string } = {}
): string | null {
  if (plan.useBaseSafetyMotion) return null

  const parts: string[] = []

  // ── NO EVIDENCE, NO DIRECTIONS ──────────────────────────────────────
  //
  // The old version reached a template here regardless and filled it with
  // a manufactured rotation. When the analysis records nothing specific to
  // this pair, the neutral instruction is the honest output — and being a
  // single constant makes it recognisable as an absence of evidence rather
  // than as one more camera path.
  if (!plan.hasEvidence || plan.motionInstruction === null) {
    parts.push(NEUTRAL_MOTION)
    if (plan.relationType === 'SAME_ROOM') {
      parts.push(
        `Both frames show the same room${labels.fromRoom ? ` (${labels.fromRoom})` : ''}. Do not leave it and do not pass through any doorway.`
      )
    } else if (plan.relationType === 'ADJACENT_ROOM') {
      parts.push(
        'Do NOT depict travel through any doorway or opening, since none is confirmed visible in the start frame.'
      )
    }
    parts.push('Settle into a still final frame that matches the end frame exactly.')
    return parts.join(' ')
  }

  if (plan.relationType === 'SAME_ROOM') {
    parts.push(
      `Both frames show the same room${labels.fromRoom ? ` (${labels.fromRoom})` : ''}. Move within this room only: ${plan.motionInstruction}`
    )
    parts.push('Do not leave the room and do not pass through any doorway.')
  } else if (plan.physicalNavigationAllowed) {
    parts.push(
      `The end frame is in the ${labels.toRoom ?? 'next room'}, reached from the ${labels.fromRoom ?? 'current room'} through the ${plan.visibleOpenings.join(' and ')} visible in the start frame.`
    )
    parts.push(`Camera: ${plan.motionInstruction}`)
    parts.push(
      'Do not invent any corridor, door or opening that is not visible in the start frame.'
    )
  } else {
    parts.push(
      `The start frame is in the ${labels.fromRoom ?? 'current room'} and the end frame is in the ${labels.toRoom ?? 'another room'}.`
    )
    parts.push(`Camera: ${plan.motionInstruction}`)
    parts.push(
      'Move toward the end frame viewpoint WITHOUT depicting travel through any doorway or opening, since none is confirmed visible in the start frame.'
    )
  }

  // Continuity is offered as a preference, never as a hard constraint —
  // the end frame outranks it, and an over-constrained camera is how
  // these models start ignoring the frame they were given. Only a DERIVED
  // rotation is ever mentioned.
  if (
    plan.continuity.incomingRotation === 'clockwise' ||
    plan.continuity.incomingRotation === 'counter-clockwise'
  ) {
    parts.push(
      `Continuity: the previous shot ended rotating ${plan.continuity.incomingRotation}; prefer to continue in that direction rather than reversing abruptly, unless reaching the end frame requires otherwise.`
    )
  }
  parts.push('Settle into a still final frame that matches the end frame exactly.')

  return parts.join(' ')
}

/** base + motion. The safety contract always leads. */
export function renderPrompt(
  plan: TransitionPlan,
  labels: { fromRoom?: string; toRoom?: string } = {},
  basePrompt: string = DEFAULT_TRANSITION_PROMPT
): string {
  const motion = renderMotionInstruction(plan, labels)
  return motion ? `${basePrompt}\n\nCAMERA MOVEMENT FOR THIS TRANSITION:\n${motion}` : basePrompt
}
