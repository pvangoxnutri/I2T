import {
  edgeBetween,
  imageAnalysis,
  roomOfImage,
  type AnalysisConfidence,
  type PropertyAnalysis
} from './propertyAnalysis'
import { traversableOpenings } from './openingEvidence'
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

export type SafetyLevel = 'safe' | 'uncertain' | 'unsafe'

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
}

export interface TransitionSafetyVerdict {
  mode: 'ai' | 'cut'
  safety: SafetyLevel
  /** Specific enough to argue with. Never "not safe". */
  reason: string
  evidence: TransitionSafetyEvidence
}

const NO_EVIDENCE: TransitionSafetyEvidence = {
  relation: 'unknown',
  sharedLandmarks: [],
  traversableOpenings: [],
  overlapConfirmed: false,
  adjacencyConfidence: null,
  reviewBlock: null
}

/**
 * The single evidence gate.
 *
 * `reviews` are ground-truth verdicts keyed by connection fact key. They
 * can only ever make this MORE conservative: a reviewer can veto a
 * connection the evidence supports, never unlock one it does not.
 */
export function evaluateTransitionSafety(
  analysis: PropertyAnalysis | null,
  fromImageId: string,
  toImageId: string,
  reviews?: Map<string, ReviewVerdict>
): TransitionSafetyVerdict {
  if (!analysis) {
    return {
      mode: 'cut',
      safety: 'unsafe',
      reason: 'No property analysis covers these images.',
      evidence: NO_EVIDENCE
    }
  }

  const fromImage = imageAnalysis(analysis, fromImageId)
  const toImage = imageAnalysis(analysis, toImageId)
  if (!fromImage || !toImage) {
    return {
      mode: 'cut',
      safety: 'unsafe',
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
        safety: 'safe',
        reason: overlap
          ? `Both frames are in ${fromRoom.label} and overlap, sharing ${shared.join(', ')}.`
          : `Both frames are in ${fromRoom.label} and share ${shared.join(', ')}.`,
        evidence
      }
    }
    return {
      mode: 'cut',
      safety: 'uncertain',
      reason: overlap
        ? `Both frames are in ${fromRoom.label} and overlap, but no landmark appears in both — there is nothing to anchor a move to.`
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
      reviewBlock
    }

    if (!edge || edge.confidence === 'unknown') {
      return {
        mode: 'cut',
        safety: 'unsafe',
        reason: `No confirmed connection between ${fromRoom.label} and ${toRoom.label} — a generated move would have to invent the route.`,
        evidence
      }
    }
    if (reviewBlock) {
      return { mode: 'cut', safety: 'unsafe', reason: reviewBlock, evidence }
    }
    if (edge.confidence !== 'confirmed') {
      return {
        mode: 'cut',
        safety: 'uncertain',
        reason: `The connection ${fromRoom.label} → ${toRoom.label} is only ${edge.confidence}, which is not enough to stage a move through it.`,
        evidence
      }
    }
    if (ways.length === 0) {
      const seenButSealed = (fromImage.openings ?? []).length > 0
      return {
        mode: 'cut',
        safety: 'unsafe',
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
      safety: 'safe',
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
    safety: 'unsafe',
    reason: 'At least one of these images was never assigned to a space.',
    evidence: { ...NO_EVIDENCE, sharedLandmarks: shared, traversableOpenings: ways }
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
