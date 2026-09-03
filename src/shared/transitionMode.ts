import type { PropertyAnalysis } from './propertyAnalysis'
import type { TransitionPlan } from './transitionPlan'

/**
 * NOT EVERY PAIR OF PHOTOGRAPHS DESERVES A GENERATED TRANSITION.
 *
 * ── THE STAIRCASE PROBLEM ────────────────────────────────────────────
 *
 * A ground-floor living room followed by an upstairs bedroom, with no
 * photograph of the staircase anywhere in the set. There is no visual
 * evidence of a route between them, and asking a video model to move the
 * camera from one to the other can only produce invented stairs — a tour
 * of a house that does not exist, for a home someone is selling.
 *
 * The correct editorial answer is a CUT. Films cut between rooms
 * constantly; nobody finds it confusing. What is confusing is a corridor
 * that is not there.
 *
 * So the transition type is a first-class decision, `auto` resolves it
 * from the same evidence the planner uses, and a cut costs nothing
 * because nothing is generated.
 */

export type TransitionMode = 'auto' | 'ai' | 'cut' | 'crossfade'

/** What `auto` can actually resolve to. */
export type EffectiveTransitionMode = 'ai' | 'cut' | 'crossfade'

export interface ResolvedTransitionMode {
  requestedMode: TransitionMode
  effectiveMode: EffectiveTransitionMode
  /** Why, in words the operator can act on. */
  reason: string
  /**
   * True when the operator forced AI where the evidence does not support
   * navigation. Not blocked — an expert may know something the photographs
   * do not show — but the risk is stated and confirmed before paying.
   */
  forcedAgainstEvidence: boolean
}

/**
 * The default for every transition that has never been configured.
 *
 * `auto` rather than `ai`: the safe reading of "nobody has decided yet" is
 * "let the evidence decide", not "generate video".
 */
export const DEFAULT_TRANSITION_MODE: TransitionMode = 'auto'

/**
 * Whether the evidence supports a generated camera move between these two
 * frames.
 *
 * ── THE ANSWER IS NOT COMPUTED HERE ──────────────────────────────────
 *
 * It is read from `plan.safetyVerdict`, produced by
 * `shared/transitionSafety` — the one evaluator the feed proposal also
 * uses. The rules themselves, and why they are what they are, live there.
 *
 * Two cases pass, both conservative on purpose:
 *
 *   same space, where a landmark is visible in BOTH frames — the camera
 *     repositions around something it can hold on to;
 *   different spaces, where the adjacency is confirmed AND the start
 *     frame shows a genuine way THROUGH — a door or archway, not a window
 *     onto the next room — and no reviewer has vetoed it.
 *
 * Everything else is a cut, including a same-room pair with nothing in
 * common: generating a camera move from nothing is how twenty-nine
 * identical invented pans happened.
 */
export function evidenceSupportsAi(plan: TransitionPlan): boolean {
  // READ, DO NOT RE-DERIVE. This used to apply its own rules —
  // `hasEvidence` for same-room, `physicalNavigationAllowed` for
  // adjacent — and both were looser than the ones the feed proposal
  // applied to the identical pair. Same-room passed on a single leaving
  // landmark or a derived rotation; adjacent-room passed on ANY recorded
  // opening, including a fixed window, which licensed a generated move
  // through solid glazing. The verdict now comes from the one evaluator
  // both paths share.
  return plan.safetyVerdict.mode === 'ai'
}

/**
 * The reason a cut was chosen, specific enough to argue with.
 *
 * Taken from the evaluator that made the decision, so the explanation can
 * never describe different reasoning from the one actually applied. This
 * function used to reconstruct a reason from the plan's fields, which is
 * how a pair could be cut for one reason and told about another.
 */
function cutReason(plan: TransitionPlan): string {
  return plan.safetyVerdict.reason
}

/**
 * Resolve what will ACTUALLY happen for one transition.
 *
 * A manual choice is honoured exactly — including a manual AI on weak
 * evidence, which is flagged rather than refused. The operator may know
 * the property; they may not know what the photographs fail to show, so
 * the risk is stated and confirmed before anything is paid for.
 */
export function resolveTransitionMode(
  requestedMode: TransitionMode,
  plan: TransitionPlan | null,
  /**
   * Whether a generated clip already exists for this pair.
   *
   * ── SOMEONE ALREADY PAID FOR IT ──────────────────────────────────────
   *
   * An existing clip outranks the evidence for AUTO. Resolving to a cut
   * and then quietly dropping a clip out of the assembled video would
   * discard work that cost real money, and the operator would have no
   * indication of why their transition vanished. Cutting away from a clip
   * that exists has to be a deliberate manual choice.
   */
  hasClip = false
): ResolvedTransitionMode {
  const supported = plan ? evidenceSupportsAi(plan) : false

  if (requestedMode === 'cut') {
    return {
      requestedMode,
      effectiveMode: 'cut',
      reason: 'Set to Cut manually.',
      forcedAgainstEvidence: false
    }
  }
  if (requestedMode === 'crossfade') {
    return {
      requestedMode,
      effectiveMode: 'crossfade',
      reason: 'Set to Crossfade manually.',
      forcedAgainstEvidence: false
    }
  }
  if (requestedMode === 'ai') {
    return {
      requestedMode,
      effectiveMode: 'ai',
      reason: supported
        ? 'Set to AI manually, and the evidence supports it.'
        : 'Set to AI manually, against the available evidence.',
      // The warning the inspector shows, and the extra confirmation the
      // generation path requires.
      forcedAgainstEvidence: !supported
    }
  }

  // AUTO
  if (hasClip) {
    return {
      requestedMode,
      effectiveMode: 'ai',
      reason: 'A generated clip already exists for this transition, so it is used.',
      forcedAgainstEvidence: false
    }
  }
  if (!plan) {
    return {
      requestedMode,
      effectiveMode: 'cut',
      reason: 'No analysis covers these images, so no camera route is evidenced.',
      forcedAgainstEvidence: false
    }
  }
  return supported
    ? {
        requestedMode,
        effectiveMode: 'ai',
        reason:
          plan.relationType === 'SAME_ROOM'
            ? 'Same space, with pair-specific evidence for a camera move.'
            : `Confirmed connection with ${plan.visiblePassage ?? 'an opening'} visible in the start frame.`,
        forcedAgainstEvidence: false
      }
    : {
        requestedMode,
        effectiveMode: 'cut',
        reason: cutReason(plan),
        forcedAgainstEvidence: false
      }
}

/**
 * What the ANALYSIS recommends, independent of what is configured.
 *
 * ── THE ANALYZER DOES NOT PICK STYLES ────────────────────────────────
 *
 * A vision model's job here is to say whether spatial navigation is
 * supported by the photographs. It is not asked to choose between a cut
 * and a crossfade — that is an editorial decision, and a model with no
 * stake in the property has no basis for it. So the recommendation is
 * binary and the safety decision stays in domain logic.
 */
export function recommendedMode(plan: TransitionPlan | null): {
  mode: 'ai' | 'cut'
  reason: string
} {
  if (!plan) return { mode: 'cut', reason: 'No analysis covers these images.' }
  return evidenceSupportsAi(plan)
    ? { mode: 'ai', reason: plan.safetyVerdict.reason }
    : { mode: 'cut', reason: cutReason(plan) }
}

/** True when the recommendation has moved away from what Auto resolved to. */
export function recommendationChanged(
  requested: TransitionMode,
  previousEffective: EffectiveTransitionMode | null,
  plan: TransitionPlan | null
): boolean {
  // Only AUTO transitions can change on their own. A manual Cut, Crossfade
  // or AI is a decision, and re-analysis does not get to revisit it.
  if (requested !== 'auto') return false
  if (previousEffective === null) return false
  return resolveTransitionMode('auto', plan).effectiveMode !== previousEffective
}

/**
 * One transition, as the whole UI sees it.
 *
 * Resolved once in main and handed across, so the timeline, the inspector,
 * readiness and the cost estimate cannot each reach a different conclusion
 * about the same transition.
 */
export interface ResolvedModeRow {
  pairKey: string
  position: number
  label: string
  requestedMode: TransitionMode
  effectiveMode: EffectiveTransitionMode
  reason: string
  forcedAgainstEvidence: boolean
  recommendedMode: 'ai' | 'cut'
  recommendationReason: string
  /** A manual choice the current evidence would not have made. */
  recommendationDiffers: boolean
  hasClip: boolean
}

/** Counts for readiness and cost. Cuts and crossfades need no clip. */
export interface ModeTally {
  total: number
  ai: number
  cut: number
  crossfade: number
  /** AI transitions whose clip exists. */
  aiReady: number
  /** AI transitions still needing a paid generation — the only blocker. */
  aiMissing: number
}

export function tallyModes(rows: ResolvedModeRow[]): ModeTally {
  const ai = rows.filter((r) => r.effectiveMode === 'ai')
  return {
    total: rows.length,
    ai: ai.length,
    cut: rows.filter((r) => r.effectiveMode === 'cut').length,
    crossfade: rows.filter((r) => r.effectiveMode === 'crossfade').length,
    aiReady: ai.filter((r) => r.hasClip).length,
    aiMissing: ai.filter((r) => !r.hasClip).length
  }
}

export function requiresGeneratedClip(effective: EffectiveTransitionMode): boolean {
  return effective === 'ai'
}

/** Whether this transition can cost money. Cuts and crossfades cannot. */
export function incursGenerationCost(effective: EffectiveTransitionMode): boolean {
  return effective === 'ai'
}

export const MODE_LABEL: Record<EffectiveTransitionMode, string> = {
  ai: 'AI',
  cut: 'CUT',
  crossfade: 'CROSSFADE'
}

/**
 * Crossfade length in seconds.
 *
 * Deliberately short and NOT the seam blend: a seam hides an encoder cut
 * between two clips of continuous motion, while this is a deliberate
 * dissolve the viewer is meant to notice slightly. Long enough to read as
 * intentional, short enough not to become a slideshow effect.
 */
export const CROSSFADE_SECONDS = 0.5

/** How long an image is held when nothing else puts it on screen. */
export const STILL_HOLD_SECONDS = 1.5

/** Does the accepted analysis even exist? Used for honest empty states. */
export function analysisCoversPair(
  analysis: PropertyAnalysis | null,
  fromImageId: string,
  toImageId: string
): boolean {
  if (!analysis) return false
  const a = analysis.images.find((i) => i.imageId === fromImageId)?.roomId
  const b = analysis.images.find((i) => i.imageId === toImageId)?.roomId
  return Boolean(a && b)
}
