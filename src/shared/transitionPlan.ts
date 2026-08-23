import { DEFAULT_TRANSITION_PROMPT } from './prompts'
import {
  relateImages,
  type PropertyAnalysis,
  type SpatialRelation
} from './propertyAnalysis'
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
export type RotationDirection = 'clockwise' | 'counter-clockwise' | 'none'
export type MotionSpeed = 'slow' | 'moderate'

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
  sharedLandmarks: string[]
  /** Openings visible in the START frame. The only basis for moving through one. */
  visibleOpenings: string[]
  /** The landmark the camera should hold on, when there is one. */
  anchorLandmark: string | null
  cameraAction: string[]
  /**
   * THE SAFETY BIT. False unless a confirmed adjacency has an opening
   * visible in the start frame.
   */
  physicalNavigationAllowed: boolean
  /** True when nothing is known and only the base prompt applies. */
  useBaseSafetyMotion: boolean
  continuity: ContinuityHints
  /** Plain-language reason, for the plan review list. */
  rationale: string
}

/** Rotation alternates gently so consecutive clips do not fight. */
function nextRotation(previous: RotationDirection): RotationDirection {
  if (previous === 'clockwise') return 'clockwise'
  if (previous === 'counter-clockwise') return 'counter-clockwise'
  return 'clockwise'
}

function planFromRelation(
  relation: SpatialRelation,
  previous: TransitionPlan | null,
  reviewBlock: string | null
): Omit<TransitionPlan, 'fromImageId' | 'toImageId'> {
  const incomingRotation: RotationDirection = previous?.continuity.outgoingRotation ?? 'none'

  if (relation.kind === 'same-room') {
    const anchor = relation.shared[0] ?? null
    const rotation = nextRotation(incomingRotation)
    return {
      relationType: 'SAME_ROOM',
      confidence: 'confirmed',
      sharedLandmarks: relation.shared,
      visibleOpenings: [],
      anchorLandmark: anchor,
      cameraAction: ['slow forward dolly', `slight ${rotation} rotation`],
      // Repositioning inside one room is not navigation between spaces.
      physicalNavigationAllowed: false,
      useBaseSafetyMotion: false,
      continuity: {
        incomingRotation,
        outgoingRotation: rotation,
        speed: 'slow',
        staticEndpoint: true
      },
      rationale: anchor
        ? `Both images are assigned to ${relation.room.label}, sharing ${relation.shared.join(', ')}.`
        : `Both images are assigned to ${relation.room.label}.`
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
    const rotation = nextRotation(incomingRotation)
    return {
      relationType: 'ADJACENT_ROOM',
      confidence: relation.confidence === 'confirmed' ? 'confirmed' : 'probable',
      sharedLandmarks: [],
      visibleOpenings: relation.openings,
      anchorLandmark: relation.openings[0] ?? null,
      cameraAction: canNavigate
        ? [`advance through the ${relation.openings[0]}`, `slight ${rotation} rotation`]
        : ['move toward the end viewpoint without depicting travel through any opening'],
      physicalNavigationAllowed: canNavigate,
      useBaseSafetyMotion: false,
      continuity: {
        incomingRotation,
        outgoingRotation: canNavigate ? rotation : 'none',
        speed: canNavigate ? 'moderate' : 'slow',
        staticEndpoint: true
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
    relationType: 'UNKNOWN',
    confidence: 'unknown',
    sharedLandmarks: [],
    visibleOpenings: [],
    anchorLandmark: null,
    cameraAction: [],
    physicalNavigationAllowed: false,
    useBaseSafetyMotion: true,
    continuity: {
      incomingRotation,
      // Claims nothing about where the camera ends up, so it hands the
      // next clip no rotation to continue.
      outgoingRotation: 'none',
      speed: 'slow',
      staticEndpoint: true
    },
    rationale: 'No confident spatial relationship between these images.'
  }
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
      ...planFromRelation(relation, plans[i - 1] ?? null, reviewBlock)
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

  if (plan.relationType === 'SAME_ROOM') {
    parts.push(
      `Both frames show the same room${labels.fromRoom ? ` (${labels.fromRoom})` : ''}. Move within this room only: ${plan.cameraAction.join(', ')}.`
    )
    if (plan.anchorLandmark) {
      parts.push(`Keep the ${plan.anchorLandmark} continuously visible as the spatial anchor.`)
    }
    parts.push('Do not leave the room and do not pass through any doorway.')
  } else if (plan.physicalNavigationAllowed) {
    parts.push(
      `The end frame is in the ${labels.toRoom ?? 'next room'}, reached from the ${labels.fromRoom ?? 'current room'} through the ${plan.visibleOpenings.join(' and ')} visible in the start frame.`
    )
    parts.push(`Camera: ${plan.cameraAction.join(', ')}.`)
    parts.push(
      'Do not invent any corridor, door or opening that is not visible in the start frame.'
    )
  } else {
    parts.push(
      `The start frame is in the ${labels.fromRoom ?? 'current room'} and the end frame is in the ${labels.toRoom ?? 'another room'}.`
    )
    parts.push(
      'Move smoothly toward the end frame viewpoint WITHOUT depicting travel through any doorway or opening, since none is confirmed visible in the start frame.'
    )
  }

  // Continuity is offered as a preference, never as a hard constraint —
  // the end frame outranks it, and an over-constrained camera is how
  // these models start ignoring the frame they were given.
  if (plan.continuity.incomingRotation !== 'none') {
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
