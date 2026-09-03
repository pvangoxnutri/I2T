import type { PropertyAnalysis } from './propertyAnalysis'
import { roomOfImage } from './propertyAnalysis'
import { planSequence } from './transitionPlan'
import type { ReviewVerdict } from './analysisReview'

/**
 * MAY WE SPEND MONEY GENERATING THIS TRANSITION?
 *
 * ── THE FAILURE THIS EXISTS FOR ──────────────────────────────────────
 *
 * A stored `mode: 'ai'` is a DECISION, and the mode resolver honours a
 * decision without revisiting it. That is right for a mode. It is wrong
 * as the only thing standing between a project and a paid request,
 * because the evidence that justified the decision can be gone by the
 * time the request is sent — and in the failure this was written for, it
 * was gone at the moment the decision was saved.
 *
 * Eight transitions carried `mode: 'ai'` against an accepted analysis
 * containing zero rooms. Nothing checked. The planner had no geometry, so
 * it produced no motion instruction; the prompt builder fell back to the
 * bare safety prompt; and fal was handed two photographs and asked to
 * invent the room between them. It moved the sofa and produced a second
 * television, which is the correct behaviour for a model given no
 * constraints.
 *
 * ── WHAT THIS CHECKS ─────────────────────────────────────────────────
 *
 * That an ANCHORED prompt can actually be built right now, from the
 * ACCEPTED analysis, for the CURRENT feed. Not that the pair once looked
 * safe. A generation whose only instruction would be the generic preset
 * is refused rather than sent — prompting is not a substitute for
 * evidence, and a default-only AI request is evidence-free by
 * definition.
 *
 * ── WHAT THIS DOES NOT DO ────────────────────────────────────────────
 *
 * It touches nothing already generated. A clip that exists was paid for
 * and stays exactly where it is; this gate only stands in front of NEW
 * spend.
 */

export interface AiGenerationBasis {
  /** The mapped space the move happens in or out of. */
  roomLabel: string | null
  /** Landmarks visible in both frames — what the camera holds on to. */
  sharedLandmarks: string[]
  /** The opening being travelled through, when one is. */
  visiblePassage: string | null
  /** The analysis-derived motion sentence. Never the neutral fallback. */
  motionInstruction: string
}

export type AiGenerationReadiness =
  /** Backed by the accepted map, with an anchored instruction. */
  | { ok: true; kind: 'analysis-backed'; basis: AiGenerationBasis }
  /**
   * NOT backed by evidence, but the operator set this mode themselves and
   * may proceed after acknowledging the risk. The dialog must present it
   * as a risk, never as a supported transition.
   */
  | { ok: true; kind: 'manual-override'; warning: string; reason: string }
  | { ok: false; reason: string }

/** What an operator is agreeing to when they override. */
export const MANUAL_OVERRIDE_WARNING =
  'No accepted spatial analysis supports this transition. Generating anyway may cause ' +
  'invented geometry, moved furniture, duplicated objects or an incorrect camera path.'

const NEEDS_REANALYSIS =
  'This AI transition no longer has sufficient accepted spatial evidence. ' +
  'Re-analyse transitions before generating.'

export function assessAiGenerationReadiness(
  analysis: PropertyAnalysis | null,
  feedImageIds: string[],
  pairKey: string,
  /**
   * Who chose this transition's mode. `manual` — and ONLY an explicit
   * `manual` — opens the override path; absent provenance is treated as
   * analysis-driven, so rows written before this existed cannot be
   * retro-classified as human decisions.
   */
  modeProvenance?: 'analysis' | 'manual',
  reviews?: Map<string, ReviewVerdict>
): AiGenerationReadiness {
  const isManual = modeProvenance === 'manual'

  /**
   * The operator's own choice survives a missing or unsupportive map —
   * they may know the property better than the photographs show — but it
   * is never dressed up as a supported transition. Everything the
   * analyzer chose stays bound to the evidence that justified it.
   */
  const refuseOrOverride = (reason: string): AiGenerationReadiness =>
    isManual
      ? { ok: true, kind: 'manual-override', warning: MANUAL_OVERRIDE_WARNING, reason }
      : { ok: false, reason }

  // No accepted map at all. This is the exact state the bad run was in.
  if (!analysis || analysis.rooms.length === 0) {
    return refuseOrOverride(
      'No accepted property analysis covers this project, so a generated camera move ' +
        'would have nothing to follow. Analyse the imported media and accept the result first.'
    )
  }

  const plans = planSequence(analysis, feedImageIds, reviews)
  const plan = plans.find((p) => `${p.fromImageId}->${p.toImageId}` === pairKey)
  if (!plan) {
    return {
      ok: false,
      reason:
        'This transition is no longer part of the current Transition Feed. ' +
        'Select an active transition to generate.'
    }
  }

  // The evidence gate, re-asked NOW rather than trusted from when the
  // mode was stored.
  if (plan.safetyVerdict.mode !== 'ai') {
    return refuseOrOverride(`${NEEDS_REANALYSIS} (${plan.safetyVerdict.reason})`)
  }

  // A DEFAULT-ONLY REQUEST IS REFUSED. `motionInstruction` is null exactly
  // when the planner found nothing pair-specific to say, which is when the
  // prompt would collapse to the generic preset.
  if (!plan.motionInstruction) {
    return refuseOrOverride(
      'No analysis-derived camera instruction could be built for this pair, so the ' +
        'request would carry only the generic prompt. Re-analyse transitions before generating.'
    )
  }

  return {
    ok: true,
    kind: 'analysis-backed',
    basis: {
      roomLabel: roomOfImage(analysis, plan.fromImageId)?.label ?? null,
      sharedLandmarks: plan.sharedLandmarks,
      visiblePassage: plan.visiblePassage,
      motionInstruction: plan.motionInstruction
    }
  }
}
