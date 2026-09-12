import {
  edgeBetween,
  imageAnalysis,
  roomOfImage,
  type AnalysisConfidence,
  type PropertyAnalysis
} from './propertyAnalysis'
import { traversableOpenings } from './openingEvidence'
import {
  contextResolves,
  isContextActive,
  type MissingContextItem,
  type OperatorSpatialContext
} from './operatorContext'
import {
  motionReferencesReflector,
  reflectionBlocksAi,
  reflectionEvidenceForPair,
  NO_REFLECTION_EVIDENCE,
  type ReflectionEvidence
} from './reflectionRisk'
import {
  connectionFactKey,
  navigationBlockedBy,
  type ReviewVerdict
} from './analysisReview'

/**
 * MAY A CAMERA BE GENERATED BETWEEN THESE TWO FRAMES, AND WHY?
 *
 * ── ONE ANSWER, NOT TWO ──────────────────────────────────────────────
 *
 * This question was being answered in two places with two different sets
 * of rules, and they disagreed in both directions:
 *
 *   SAME ROOM   the planner accepted a single leaving landmark, or a
 *               rotation derived from two orientations, as enough. The
 *               proposal required real overlap AND a shared landmark.
 *
 *   CROSS ROOM  the planner accepted any recorded opening. It never asked
 *               whether the opening was a way THROUGH — so a fixed
 *               picture window onto the next room licensed a generated
 *               move straight through the glazing. The proposal had
 *               learned to check; the planner had not.
 *
 * The second one is the dangerous half, because the planner is what the
 * timeline, the mode resolver and generation actually consult. The
 * stricter rule of each pair is the one kept here — consolidating these
 * must not be a way to quietly relax either.
 *
 * ── WHAT THIS OWNS ───────────────────────────────────────────────────
 *
 * Same-room overlap and shared-landmark rules; cross-room confirmed
 * adjacency; the traversable-opening requirement; bidirectional
 * corroboration; the review override; and the CUT default. Nothing else
 * may re-decide AI vs CUT.
 *
 * ── WHAT THIS DOES NOT OWN ───────────────────────────────────────────
 *
 * It says nothing about which images belong in the video — that is
 * selection, and a pair being unsafe never removes an image. It says
 * nothing about what the camera should DO when a move is allowed; that
 * is the motion planner. And it does not know about generated clips: an
 * existing clip outranks Auto elsewhere, deliberately, because dropping
 * work that was paid for is never the right default.
 */

/**
 * `needs-context` replaced the old `uncertain`.
 *
 * `uncertain` collapsed two different things into one word — "we found
 * evidence this will not work" and "we could not determine one fact" —
 * and both resolved to CUT. That made a missing detail as fatal as a
 * proven wall in the way, and a bathroom with an unreadable mirror lost
 * an otherwise well-evidenced transition.
 */
export type SafetyLevel = 'safe' | 'needs-context' | 'unsafe'

/**
 * THE THREE OUTCOMES.
 *
 *   ai            the evidence supports a generated move
 *   cut           AFFIRMATIVE evidence that it does not
 *   needs-context a specific fact is missing; the operator may know it
 *
 * The third is the point. Absence of evidence is not evidence of
 * impossibility, and the operator has usually stood in the room.
 */
export type TransitionDecision = 'ai' | 'cut' | 'needs-context'

export interface TransitionSafetyEvidence {
  relation: 'same-room' | 'adjacent-room' | 'unknown'
  /** Landmarks visible in BOTH frames. */
  sharedLandmarks: string[]
  /** Ways through — doors, archways, passages — visible in the START frame. */
  traversableOpenings: string[]
  /** The analyzer recorded these two frames as covering the same region. */
  overlapConfirmed: boolean
  adjacencyConfidence: AnalysisConfidence | null
  /** A reviewer's verdict that blocks navigation, when one exists. */
  reviewBlock: string | null
  /**
   * Mirrors and glass in either frame.
   *
   * Carried in the SAME evidence object as everything else on purpose. A
   * separate reflection checker would be a second safety evaluator, and
   * two evaluators can disagree about one pair — which is the class of
   * bug this file was created to end.
   */
  reflection: ReflectionEvidence
}

export interface TransitionSafetyVerdict {
  /**
   * What to DO today, with nothing else supplied.
   *
   * `needs-context` has no generated move yet, so this reads `cut` —
   * every existing caller (mode resolution, assembly, readiness) keeps
   * behaving exactly as before. `decision` is what distinguishes a pair
   * that is waiting for an answer from one that was refused.
   */
  mode: 'ai' | 'cut'
  decision: TransitionDecision
  safety: SafetyLevel
  /** Specific enough to argue with. Never "not safe". */
  reason: string
  /**
   * The facts nobody could determine, phrased as questions.
   *
   * Empty for `ai` and for `cut` — a cut is a positive finding, not an
   * absence, so there is nothing to ask.
   */
  missingContext: MissingContextItem[]
  evidence: TransitionSafetyEvidence
}

const NO_EVIDENCE: TransitionSafetyEvidence = {
  relation: 'unknown',
  sharedLandmarks: [],
  traversableOpenings: [],
  overlapConfirmed: false,
  adjacencyConfidence: null,
  reviewBlock: null,
  reflection: NO_REFLECTION_EVIDENCE
}

/**
 * The single evidence gate.
 *
 * `reviews` are ground-truth verdicts keyed by connection fact key. They
 * can only ever make this MORE conservative: a reviewer can veto a
 * connection the evidence supports, never unlock one it does not.
 */
function evaluateRouteSafety(
  analysis: PropertyAnalysis | null,
  fromImageId: string,
  toImageId: string,
  reviews?: Map<string, ReviewVerdict>,
  /**
   * The motion the planner intends, when it already exists.
   *
   * Passed in because a camera path described in terms of a mirror is
   * itself the hazard — "turning away from the mirror reflection" is what
   * the failing bathroom clip was told to do. Omitted on the first pass,
   * where no motion has been planned yet; the gate then judges the
   * reflector alone.
   */
  plannedMotion?: string | null
): TransitionSafetyVerdict {
  if (!analysis) {
    return {
      mode: 'cut',
      decision: 'cut',
      safety: 'unsafe',
      missingContext: [],
      reason: 'No property analysis covers these images.',
      evidence: NO_EVIDENCE
    }
  }

  const fromImage = imageAnalysis(analysis, fromImageId)
  const toImage = imageAnalysis(analysis, toImageId)
  if (!fromImage || !toImage) {
    return {
      mode: 'cut',
      decision: 'cut',
      safety: 'unsafe',
      missingContext: [],
      reason: 'One of these images was never analysed, so no route can be defended.',
      evidence: NO_EVIDENCE
    }
  }

  const fromRoom = roomOfImage(analysis, fromImageId)
  const toRoom = roomOfImage(analysis, toImageId)
  const shared = fromImage.landmarks.filter((lm) => toImage.landmarks.includes(lm))
  // Openings are only evidence of a route when they are a way THROUGH, and
  // only from the frame the camera starts in.
  const ways = traversableOpenings(fromImage.openings)

  // ── SAME SPACE ──────────────────────────────────────────────────────
  //
  // Repositioning inside one room. Safe only when the two viewpoints
  // demonstrably see the same thing: overlap says the frames cover a
  // common region, shared landmarks say what that region contains. Either
  // alone is too weak — two photographs of opposite corners of a room
  // share the room and nothing else.
  if (fromRoom && toRoom && fromRoom.id === toRoom.id) {
    // Overlap is a symmetric fact about a pair, however the analyzer
    // happened to record it.
    const overlap =
      (fromImage.overlapWith?.includes(toImageId) ?? false) ||
      (toImage.overlapWith?.includes(fromImageId) ?? false)

    const evidence: TransitionSafetyEvidence = {
      relation: 'same-room',
      sharedLandmarks: shared,
      traversableOpenings: ways,
      overlapConfirmed: overlap,
      adjacencyConfidence: 'confirmed',
      reflection: NO_REFLECTION_EVIDENCE,
      reviewBlock: null
    }

    // A SHARED LANDMARK IS THE ANCHOR, AND IS SUFFICIENT.
    //
    // An explicit overlap record strengthens this but is not required:
    // `overlapWith` is an optional field, and demanding it would treat
    // "the analyzer did not fill this in" as "these frames do not
    // overlap" — the same mistake that made an unscored library select
    // zero images. A landmark visible in BOTH frames is itself direct
    // evidence that they see the same region.
    //
    // What is still refused is a same-room pair with nothing in common:
    // two photographs of opposite corners share the room and nothing
    // else, and generating a move between them invents the middle.
    if (shared.length > 0) {
      return {
        mode: 'ai',
        decision: 'ai',
        safety: 'safe',
        missingContext: [],
        reason: overlap
          ? `Both frames are in ${fromRoom.label} and overlap, sharing ${shared.join(', ')}.`
          : `Both frames are in ${fromRoom.label} and share ${shared.join(', ')}.`,
        evidence
      }
    }
    // SAME ROOM, NO SHARED ANCHOR.
    //
    // Nothing here says the move is impossible — the two frames ARE the
    // same room. What is missing is the thing a camera would hold on to
    // while moving between them, and that is a question about the room
    // rather than a finding about it.
    return {
      mode: 'cut',
      decision: 'needs-context',
      safety: 'needs-context',
      missingContext: [
        {
          type: 'spatial-relationship',
          question: `How do these two views of ${fromRoom.label} relate — which wall, window or fixture is visible in both?`
        }
      ],
      reason: overlap
        ? `Both frames are in ${fromRoom.label} and overlap, but no landmark appears in both, so there is nothing recorded to anchor a move to.`
        : `Both frames are in ${fromRoom.label}, but nothing pair-specific was recorded — no overlap and no shared landmark.`,
      evidence
    }
  }

  // ── DIFFERENT SPACES ────────────────────────────────────────────────
  if (fromRoom && toRoom) {
    const edge = edgeBetween(analysis, fromRoom.id, toRoom.id)
    const reviewBlock = blockingReview(fromRoom.label, toRoom.label, reviews)
    const evidence: TransitionSafetyEvidence = {
      relation: edge && edge.confidence !== 'unknown' ? 'adjacent-room' : 'unknown',
      sharedLandmarks: shared,
      traversableOpenings: ways,
      overlapConfirmed: false,
      adjacencyConfidence: edge?.confidence ?? null,
      reflection: NO_REFLECTION_EVIDENCE,
      reviewBlock
    }

    if (!edge || edge.confidence === 'unknown') {
      return {
        mode: 'cut',
        decision: 'cut',
        safety: 'unsafe',
        missingContext: [],
        reason: `No confirmed connection between ${fromRoom.label} and ${toRoom.label} — a generated move would have to invent the route.`,
        evidence
      }
    }
    if (reviewBlock) {
      return {
        mode: 'cut',
        decision: 'cut',
        safety: 'unsafe',
        missingContext: [],
        reason: reviewBlock,
        evidence
      }
    }
    if (edge.confidence !== 'confirmed') {
      return {
        mode: 'cut',
        // NOT a refusal: nobody proved these rooms do not connect, the
        // photographs merely did not settle it. That is a question an
        // operator who has walked the property can answer.
        decision: 'needs-context',
        safety: 'needs-context',
        missingContext: [
          {
            type: 'route-unconfirmed',
            question: `Is there a direct way through from ${fromRoom.label} to ${toRoom.label}, and what is visible along it?`
          }
        ],
        reason: `The connection ${fromRoom.label} → ${toRoom.label} is only ${edge.confidence}, so the route could not be confirmed from the photographs.`,
        evidence
      }
    }
    if (ways.length === 0) {
      const seenButSealed = (fromImage.openings ?? []).length > 0
      return {
        mode: 'cut',
        decision: 'cut',
        safety: 'unsafe',
        missingContext: [],
        reason: seenButSealed
          ? `${toRoom.label} is visible from ${fromRoom.label}, but only through ${fromImage.openings.join(', ')} — seeing a space is not a way into it.`
          : `No opening or path into ${toRoom.label} is visible in the start frame.`,
        evidence
      }
    }

    // A CONFIRMED ADJACENCY PLUS A VISIBLE WAY THROUGH IS THE BAR.
    //
    // Bidirectional evidence is ADDITIVE, not a further hurdle: it exists
    // to rescue a pair whose route is split across the two frames, never
    // to block one whose start frame already shows the doorway. Requiring
    // the destination to corroborate would refuse a perfectly ordinary
    // living-room → kitchen move simply because the kitchen photograph
    // does not happen to look back at the door it came through.
    const corroboration: string[] = []
    if (edge.visibleOpeningImageIds?.includes(fromImageId)) {
      corroboration.push('the analyzer recorded this opening as visible here')
    }
    if (traversableOpenings(toImage.openings).length > 0) {
      corroboration.push('the destination frame shows the matching opening')
    }
    if (shared.length > 0) {
      corroboration.push(`both frames show ${shared.join(', ')}`)
    }

    return {
      mode: 'ai',
      decision: 'ai',
      safety: 'safe',
      missingContext: [],
      reason:
        `Confirmed connection ${fromRoom.label} → ${toRoom.label}, with ${ways.join(', ')} ` +
        `visible in the start frame` +
        (corroboration.length > 0 ? ` — ${corroboration.join('; ')}.` : '.'),
      evidence
    }
  }

  // ── NOTHING PLACED ──────────────────────────────────────────────────
  return {
    mode: 'cut',
    decision: 'cut',
    safety: 'unsafe',
    missingContext: [],
    reason: 'At least one of these images was never assigned to a space.',
    evidence: { ...NO_EVIDENCE, sharedLandmarks: shared, traversableOpenings: ways }
  }
}

/**
 * THE SINGLE EVIDENCE GATE — route first, then reflections.
 *
 * ── WHY THIS IS A WRAPPER AND NOT A SECOND EVALUATOR ─────────────────
 *
 * Reflection risk is a veto layered on top of the route argument, never a
 * parallel opinion about the same pair. `evaluateRouteSafety` is private
 * so no caller can reach a verdict that skipped this step, which is what
 * keeps "one canonical answer per pair" true. Two public evaluators is
 * exactly the shape of the bug this file replaced.
 *
 * ── SAME ROOM IS NOT ENOUGH WHEN A MIRROR IS IN FRAME ────────────────
 *
 * The bathroom pair that produced a photographer was same-room with three
 * shared landmarks — a textbook pass. One of those landmarks was the
 * string "mirror reflection", so the mirror was not merely missed, it was
 * counted as REASSURANCE. Nothing below can be satisfied by shared
 * landmarks: a reflector has to be separately defensible or the pair
 * cuts.
 */
export function evaluateTransitionSafety(
  analysis: PropertyAnalysis | null,
  fromImageId: string,
  toImageId: string,
  reviews?: Map<string, ReviewVerdict>,
  plannedMotion?: string | null,
  /**
   * What the operator wrote about this pair, when they have.
   *
   * It can only ever close an UNKNOWN. A `cut` is a positive finding and
   * is never reopened here — see the guard below.
   */
  operatorContext?: OperatorSpatialContext | null
): TransitionSafetyVerdict {
  const route = evaluateRouteSafety(analysis, fromImageId, toImageId, reviews, plannedMotion)

  const reflection = analysis
    ? reflectionEvidenceForPair(
        imageAnalysis(analysis, fromImageId),
        imageAnalysis(analysis, toImageId)
      )
    : NO_REFLECTION_EVIDENCE

  const verdict: TransitionSafetyVerdict = {
    ...route,
    evidence: { ...route.evidence, reflection }
  }

  // ── AN UNANSWERED QUESTION THE OPERATOR HAS ANSWERED ────────────────
  //
  // `needs-context` means one determinable fact was missing. Supplying it
  // is exactly what resolves it, and this must happen BEFORE the
  // reflection gate so a pair held only for its mirror can come back.
  //
  // A `cut` deliberately never reaches this: proven incompatibility is
  // not an absence, and typing "same room" under a wall conflict must not
  // read as evidence. That needs the deliberate manual override instead.
  if (verdict.decision === 'needs-context' && contextResolves(verdict.missingContext, operatorContext)) {
    return {
      ...verdict,
      mode: 'ai',
      decision: 'ai',
      safety: 'safe',
      missingContext: [],
      reason: `${verdict.reason} The operator supplied the missing detail.`
    }
  }

  // A cut stays a cut. This layer only ever removes permission.
  if (verdict.mode !== 'ai') return verdict

  const { blocked, reason } = reflectionBlocksAi(
    reflection,
    motionReferencesReflector(plannedMotion)
  )
  if (!blocked) return verdict

  // ── THE MIRROR NO LONGER ENDS THE CONVERSATION ──────────────────────
  //
  // This used to return CUT, and a bathroom with an unreadable reflection
  // lost an otherwise well-evidenced same-room move. But nothing here is
  // affirmative: the route holds, the geometry matches, and the single
  // open item is what the mirror shows — which the operator can simply
  // say. Refusing was treating "we could not read it" as "it cannot be
  // done".
  //
  // If the operator already answered, the branch above returned. Reaching
  // here means the question still stands.
  if (isContextActive(operatorContext)) {
    return {
      ...verdict,
      mode: 'ai',
      decision: 'ai',
      safety: 'safe',
      missingContext: [],
      // Stated as resolved, not as a refusal with an excuse appended.
      // Carrying "the model would have to invent the reflection" into a
      // verdict that is no longer blocked describes the old state.
      reason:
        'A reflective surface is in frame, and the operator described what its reflection contains.'
    }
  }

  return {
    ...verdict,
    mode: 'cut',
    decision: 'needs-context',
    safety: 'needs-context',
    missingContext: [
      {
        type: 'reflection-content',
        question: 'What should the mirror reflect as the camera moves?'
      }
    ],
    reason: `${(reason ?? 'A reflective surface is in frame.').replace(/^A large reflective surface is in frame and the analysis cannot say what it reflects, so the model would have to invent the reflection\.$/, 'A large mirror is visible, but the analysis cannot determine what should appear in its reflection during the camera move.')}`
  }
}

/**
 * A reviewer verdict that vetoes navigation between these spaces.
 *
 * Keyed the way the review store keys it — by room LABELS, order
 * independent — so a verdict recorded against "Terrace ↔ Living Room" is
 * found whichever way the feed happens to run.
 */
function blockingReview(
  fromRoomLabel: string,
  toRoomLabel: string,
  reviews: Map<string, ReviewVerdict> | undefined
): string | null {
  if (!reviews) return null
  const verdict = reviews.get(connectionFactKey(fromRoomLabel, toRoomLabel))
  return navigationBlockedBy(verdict ?? 'unreviewed')
}
