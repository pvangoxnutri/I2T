import type { PropertyAnalysis } from './propertyAnalysis'
import type { TransitionPlan } from './transitionPlan'

/**
 * IS THIS ANALYSIS GOOD ENOUGH TO PLAN CAMERA MOTION FROM?
 *
 * ── WHY MEASURE AT ALL ───────────────────────────────────────────────
 *
 * An accepted analysis that placed thirty photographs into one unsorted
 * room, with no landmarks, no orientations and no connections, is
 * structurally valid and completely useless. It produced twenty-nine
 * identical prompts, and nothing in the app said so — the panel reported
 * "Property analyzed" and moved on.
 *
 * These are diagnostics, not gates. They describe what the planner had to
 * work with so the operator can judge whether to trust the output, and
 * they never rewrite or randomise a plan to make the numbers look better.
 */

export interface PlanningQuality {
  imagesTotal: number
  imagesCovered: number
  spaces: number
  /** Rooms with a real name — "Unsorted" is a placement, not a room. */
  namedSpaces: number
  connections: number
  confirmedConnections: number
  imagesWithOrientation: number
  imagesWithLandmarks: number
  transitionsTotal: number
  /** Plans built from something specific to that pair. */
  transitionsWithEvidence: number
  /** Plans that fell back to the neutral instruction. */
  transitionsUsingFallback: number
  /** True when there is too little here to plan motion from. */
  insufficient: boolean
  reasons: string[]
}

const PLACEHOLDER_ROOM = /^(unsorted|unknown|room \d+|space \d+)$/i

export function planningQuality(
  analysis: PropertyAnalysis | null,
  imageIds: string[],
  plans: TransitionPlan[]
): PlanningQuality {
  const rooms = analysis?.rooms.filter((r) => r.imageIds.length > 0) ?? []
  const covered = imageIds.filter(
    (id) => analysis?.images.find((i) => i.imageId === id)?.roomId
  ).length
  const withOrientation =
    analysis?.images.filter((i) => imageIds.includes(i.imageId) && i.orientation !== 'unknown')
      .length ?? 0
  const withLandmarks =
    analysis?.images.filter((i) => imageIds.includes(i.imageId) && i.landmarks.length > 0).length ??
    0
  const withEvidence = plans.filter((p) => p.hasEvidence).length

  const reasons: string[] = []
  // Each of these on its own is survivable; together they mean the
  // planner has nothing pair-specific to work from.
  if (rooms.length > 0 && rooms.every((r) => PLACEHOLDER_ROOM.test(r.label))) {
    reasons.push('every space carries a placeholder name rather than a room')
  }
  if (rooms.length === 1 && imageIds.length > 4) {
    reasons.push(`all ${imageIds.length} images are in a single space`)
  }
  if ((analysis?.edges.length ?? 0) === 0 && rooms.length > 1) {
    reasons.push('no connections between spaces were identified')
  }
  if (withLandmarks === 0 && imageIds.length > 0) {
    reasons.push('no landmarks were recorded on any image')
  }
  if (withOrientation === 0 && imageIds.length > 0) {
    reasons.push('no camera orientation was recorded on any image')
  }
  if (plans.length > 0 && withEvidence === 0) {
    reasons.push('no transition has pair-specific evidence')
  }

  return {
    imagesTotal: imageIds.length,
    imagesCovered: covered,
    spaces: rooms.length,
    namedSpaces: rooms.filter((r) => !PLACEHOLDER_ROOM.test(r.label)).length,
    connections: analysis?.edges.length ?? 0,
    confirmedConnections: analysis?.edges.filter((e) => e.confidence === 'confirmed').length ?? 0,
    imagesWithOrientation: withOrientation,
    imagesWithLandmarks: withLandmarks,
    transitionsTotal: plans.length,
    transitionsWithEvidence: withEvidence,
    transitionsUsingFallback: plans.length - withEvidence,
    // Two or more independent signals, so one thin dimension does not
    // condemn an otherwise usable analysis.
    insufficient: reasons.length >= 2,
    reasons
  }
}

// ── Repetitive plans ───────────────────────────────────────────────────

export interface MotionDiversity {
  total: number
  distinct: number
  /** The most common instruction and how many plans share it. */
  mostCommon: { instruction: string; count: number } | null
  /** Share of plans carrying the single most common instruction, 0–1. */
  dominantShare: number
  lowDiversity: boolean
}

/** Above this share of identical instructions, the planner had nothing. */
export const LOW_DIVERSITY_THRESHOLD = 0.5

/**
 * How varied the planned motions actually are.
 *
 * ── A DIAGNOSTIC, NEVER A CORRECTION ─────────────────────────────────
 *
 * If most transitions are planned identically the cause is missing
 * evidence, and the honest response is to say so. Perturbing the wording
 * to spread the numbers would turn a visible symptom into an invisible
 * one, and would put fabricated directions back into the prompts this
 * milestone removed them from.
 */
export function motionDiversity(plans: TransitionPlan[]): MotionDiversity {
  const counts = new Map<string, number>()
  for (const plan of plans) {
    // The neutral fallback is one bucket, deliberately: twenty-nine plans
    // that all fell back IS the finding.
    const key = (plan.motionInstruction ?? '<neutral fallback>').trim().toLowerCase()
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  let mostCommon: { instruction: string; count: number } | null = null
  for (const [instruction, count] of counts) {
    if (!mostCommon || count > mostCommon.count) mostCommon = { instruction, count }
  }

  const dominantShare = plans.length > 0 ? (mostCommon?.count ?? 0) / plans.length : 0
  return {
    total: plans.length,
    distinct: counts.size,
    mostCommon,
    dominantShare,
    // One or two transitions sharing an instruction is normal; a majority
    // of them means the analysis, not the planner, is the problem.
    lowDiversity: plans.length >= 4 && dominantShare > LOW_DIVERSITY_THRESHOLD
  }
}
