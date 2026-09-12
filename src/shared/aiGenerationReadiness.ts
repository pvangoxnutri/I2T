import type { PropertyAnalysis } from './propertyAnalysis'
import { imageAnalysis, roomOfImage } from './propertyAnalysis'
import { reflectionEvidenceForPair } from './reflectionRisk'
import {
  promptCoversReflection,
  PROMPT_MAX_CHARS,
  promptExceedsLimit,
  promptUsesRetiredLayout,
  promptUsesRetiredMotion,
  promptUsesRetiredOntology
} from './prompts'
import type { OperatorSpatialContext } from './operatorContext'
import type { TransitionSettings } from './types'
import type { EvidenceSource } from './pairAnalysis'
import { isPromptBasisCurrent } from './promptPlanner'
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
  /**
   * Backed by the accepted map, with an anchored instruction.
   *
   * `advisory` is a non-blocking note for the confirmation dialog — a
   * risk worth stating that is not a reason to refuse. It exists so a
   * hazard the operator owns can be mentioned without becoming a gate,
   * which is what happened when a hand-written prompt on a reflective
   * transition was refused for not containing our template's wording.
   */
  | { ok: true; kind: 'analysis-backed'; basis: AiGenerationBasis; advisory?: string }
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

/**
 * The EXTRA sentence when a reflector is in frame.
 *
 * ── WHY THE GENERIC WARNING IS NOT ENOUGH HERE ───────────────────────
 *
 * The standard warning talks about geometry: invented walls, moved
 * furniture. An operator reads that and weighs it against a property
 * they know well — and concludes, reasonably, that they can judge
 * whether the room is right.
 *
 * They cannot judge this one in advance. A mirror failure does not
 * distort the room; it adds a person who was never there. That is a
 * different kind of harm — a stranger in a listing for someone's home —
 * so it is named explicitly rather than left inside "incorrect camera
 * path".
 */
export const REFLECTION_OVERRIDE_WARNING =
  'This transition contains reflective surfaces. Manual generation may introduce people, ' +
  'cameras or incorrect reflections.'

/**
 * The warning an operator must see before overriding this pair.
 *
 * Appends the reflection sentence rather than replacing the generic one:
 * both risks are real at once, and a mirror does not make invented
 * geometry any less likely.
 */
export function overrideWarningFor(reflectionRisk: boolean): string {
  return reflectionRisk
    ? `${MANUAL_OVERRIDE_WARNING} ${REFLECTION_OVERRIDE_WARNING}`
    : MANUAL_OVERRIDE_WARNING
}

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
  reviews?: Map<string, ReviewVerdict>,
  /**
   * WHAT THE OPERATOR ANSWERED, as part of the input.
   *
   * A needs-context verdict means one determinable fact was missing. If
   * the operator supplied it, re-running the evaluator without that
   * answer and concluding "still needs context" would discard the very
   * thing that resolved it — and that is precisely what blocked a
   * bathroom pair the operator had already approved.
   *
   * The evaluator stays canonical. It is simply asked with everything
   * that is known.
   */
  operatorContext?: OperatorSpatialContext,
  /**
   * The stored transition, so the gate can see what its wording was
   * built from. Passed in rather than looked up because this module
   * reads an ANALYSIS — the transition rows belong to the project, and
   * a second source of truth about pairs is what this codebase keeps
   * having to remove.
   */
  transitionFor?: (pairKey: string) => TransitionSettings | undefined,
  /**
   * The evidence that resolves for this pair TODAY, from
   * `resolvePairSpatialEvidence`. Supplied by the caller for the same
   * reason: one resolver, one answer, no local re-derivation.
   */
  currentEvidence?: (pairKey: string) => {
    source: EvidenceSource
    fingerprint: string
    operatorContextFingerprint?: string
  } | null
): AiGenerationReadiness {
  const isManual = modeProvenance === 'manual'

  /**
   * The operator's own choice survives a missing or unsupportive map —
   * they may know the property better than the photographs show — but it
   * is never dressed up as a supported transition. Everything the
   * analyzer chose stays bound to the evidence that justified it.
   */
  // Reflection risk is read from the SAME evidence the safety gate uses,
  // so the warning cannot disagree with the verdict that produced it.
  const [fromId, toId] = pairKey.split('->')
  const reflectionRisk = analysis
    ? reflectionEvidenceForPair(imageAnalysis(analysis, fromId), imageAnalysis(analysis, toId)).risk
    : false

  const refuseOrOverride = (reason: string): AiGenerationReadiness =>
    isManual
      ? {
          ok: true,
          kind: 'manual-override',
          warning: overrideWarningFor(reflectionRisk),
          reason
        }
      : { ok: false, reason }

  // No accepted map at all. This is the exact state the bad run was in.
  if (!analysis || analysis.rooms.length === 0) {
    return refuseOrOverride(
      'No accepted property analysis covers this project, so a generated camera move ' +
        'would have nothing to follow. Analyse the imported media and accept the result first.'
    )
  }

  const plans = planSequence(
    analysis,
    feedImageIds,
    reviews,
    operatorContext ? new Map([[pairKey, operatorContext]]) : undefined
  )
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

  // ── IS THE STORED WORDING STILL BUILT ON WHAT WE NOW BELIEVE? ───────
  //
  // The last gap. `isPromptBasisCurrent` existed and the inspector said
  // "Prompt basis outdated" — but nothing stopped the generation, so an
  // analysis-derived prompt written against old evidence could still be
  // sent. That is the same class of failure as the two-analysis split:
  // a screen saying one thing while the paid path does another.
  //
  // A HAND-EDITED PROMPT IS EXEMPT. The operator authored it
  // deliberately; new evidence does not make their sentence wrong, and
  // blocking it would make the app refuse work it had no business
  // second-guessing. A pending suggestion stays optional — it is never
  // substituted for their text.
  const transition = transitionFor?.(pairKey)
  const provenance = transition?.promptProvenance
  const storedPrompt = transition?.prompt
  const manualPrompt = provenance?.manuallyEdited === true

  // ── EVERY PROMPT-CONTRACT CHECK IS FOR PROMPTS WE WROTE ─────────────
  //
  // All three below judge WORDING against the current template, so all
  // three belong inside this exemption. Two of them were written outside
  // it, and the consequence was immediate: an operator replaced the
  // prompt on a reflective transition with their own instructions and
  // was refused, because their sentences did not contain the internal
  // phrase `REFLECTION CONTENT`. The app was demanding its own template
  // back from someone who had deliberately chosen not to use it.
  //
  // A hand-written prompt is the operator's judgement about one specific
  // transition. Checking it against a template we generated is not a
  // safety check, it is a spell-check — and refusing to spend money on
  // that basis is refusing to do work the app had no business
  // second-guessing.
  if (!manualPrompt) {
    const current = currentEvidence?.(pairKey)
    if (current && !isPromptBasisCurrent(provenance, current)) {
      return refuseOrOverride(
        'The transition prompt is based on outdated spatial evidence. ' +
          'Re-analyse this transition or rebuild its prompt before generating.'
      )
    }

    // ── THE PROMPT ITSELF, NOT ONLY WHAT IT WAS BASED ON ──────────────
    //
    // Currency was tracked against the EVIDENCE a prompt was planned from
    // and never against the prompt contract it was written under. So a
    // prompt planned minutes ago, from perfectly current evidence, could
    // still be a 3789-character instruction opening with "cinematic
    // camera transition" and describing "a high-end stabilized gimbal or
    // indoor drone" — wording removed from the source, but not from the
    // row that gets sent.
    //
    // Checked on the STORED TEXT, because that text is what reaches fal.
    if (promptUsesRetiredOntology(storedPrompt)) {
      return {
        ok: false,
        reason:
          'This transition’s prompt describes a physical camera moving through the room — ' +
          'wording that makes the model draw filming equipment, especially in mirrors. ' +
          'Rebuild the prompt for this transition before generating.'
      }
    }

    // ── NOR ONE THAT STILL ASKS FOR A CHANGE OF TEMPO ────────────────
    //
    // The same failure mode, one contract later. A stored prompt planned
    // before the constant-velocity rule still says "ease in from an
    // almost imperceptible start … then ease out to a still landing",
    // and that sentence is why generated clips ran slow → faster → slow.
    // Improving the preset does nothing for a row already written, so
    // the row is refused rather than silently sent.
    if (promptUsesRetiredMotion(storedPrompt)) {
      return {
        ok: false,
        reason:
          'This transition’s prompt asks the viewpoint to ease in and ease out, which makes ' +
          'the clip change speed across its length. Rebuild the prompt for this transition ' +
          'before generating — the current contract is one constant speed throughout.'
      }
    }

    // ── NOR ONE THAT CANNOT BE SENT AS WRITTEN ───────────────────────
    //
    // A stored prompt over the provider's limit is trimmed on the way
    // into the request, and what it loses is the end — which under the
    // retired layout was the pair's own movement instruction. Six of
    // eight stored transitions in the operator's real database were
    // submitting that way: 2996–3458 characters, cut at ~2498, the route
    // the analysis produced never reaching the model. The same row built
    // the wrong way round but still under the limit is refused too; it
    // is one edit from the same outcome.
    //
    // Refusing costs a rebuild. Sending costs a paid generation of a
    // clip the instruction never reached.
    if (promptExceedsLimit(storedPrompt) || promptUsesRetiredLayout(storedPrompt)) {
      return {
        ok: false,
        reason:
          `This transition’s prompt is ${(storedPrompt ?? '').length} characters and was ` +
          `assembled before the pair’s movement instruction was given priority, so the ` +
          `instruction is what gets cut to fit the provider’s ${PROMPT_MAX_CHARS}-character ` +
          `limit. Rebuild the prompt for this transition before generating.`
      }
    }

    // ── A MIRROR PAIR MAY NOT USE A GENERATED PROMPT THAT IGNORES ─────
    //    MIRRORS
    //
    // A pair the analyzer flagged for reflections gets the reflection
    // constraints appended when its prompt is planned. If a prompt WE
    // built lacks them, something skipped a step and rebuilding costs
    // nothing.
    if (reflectionRisk && storedPrompt && !promptCoversReflection(storedPrompt)) {
      return {
        ok: false,
        reason:
          'This transition contains a mirror or reflective surface, and its prompt does not ' +
          'carry the reflection constraints. Rebuild the prompt so it states what the ' +
          'reflection may contain before generating.'
      }
    }
  }

  return {
    ok: true,
    kind: 'analysis-backed',
    basis: {
      roomLabel: roomOfImage(analysis, plan.fromImageId)?.label ?? null,
      sharedLandmarks: plan.sharedLandmarks,
      visiblePassage: plan.visiblePassage,
      motionInstruction: plan.motionInstruction
    },
    // ── SAID, NOT ENFORCED ────────────────────────────────────────────
    //
    // A mirror is still a real hazard and the operator's own prompt may
    // simply not have thought about it. Worth one sentence in the
    // confirmation they already have to read; not worth refusing their
    // work over. The paid confirmation is unchanged — this rides along
    // with it.
    advisory:
      manualPrompt && reflectionRisk
        ? 'Manual prompt on a reflective transition — you are responsible for the reflection instructions.'
        : undefined
  }
}
