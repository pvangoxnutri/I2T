import { listProjects } from '../db/projectsRepo'
import { readPairAnalysis } from '../db/pairAnalysisRepo'
import { readAnalysis } from '../db/analysisRepo'
import { listOverrides } from '../db/overrideRepo'
import { applyImageOverrides } from '../../shared/imageFacts'
import { getFeedSequenceIds } from '../../shared/feedSequence'
import { planSequence, renderPrompt, type TransitionPlan } from '../../shared/transitionPlan'
import { sanitizeMotionInstruction } from '../../shared/motionInstructionHygiene'
import type { OperatorSpatialContext } from '../../shared/operatorContext'
import type { Project } from '../../shared/types'

/**
 * THE ONE PLACE AN AUTOMATIC TRANSITION PROMPT IS FINISHED.
 *
 * ── THE BUG THIS FIXES ────────────────────────────────────────────────
 *
 * There were two final-prompt assemblies, and they did not agree.
 *
 *   prompt repair / rebuild / feed analysis
 *     → planSequence → renderPrompt → canonical sections → assemblePrompt
 *
 *   individual Re-analyse acceptance
 *     → `${DEFAULT_TRANSITION_PROMPT}\n\n${motionBlock(gemini.motionInstruction)}`
 *
 * The second one is the pre-sections concatenation this codebase spent a
 * whole pass removing. It put the pair's movement LAST — the position
 * the length fitter cuts from — applied no budget at all, skipped the
 * reflection escalation and skipped the operator's own spatial context.
 * And its movement text was Gemini's free prose rather than the
 * canonical derivation, so the wording arrived with a tempo in it.
 *
 * The operator saw exactly that: a pair rebuilt by prompt repair played
 * as one continuous take, and the same pair after Re-analyse did not.
 *
 * ── WHAT GEMINI IS, AND IS NOT, AUTHORITATIVE FOR ────────────────────
 *
 * IS: the route. Which opening, which direction, which landmark to hold,
 * what leaves frame. That is the whole value of the pair analysis and
 * nothing here weakens it — an accepted individual analysis still
 * overrides the property-map derivation for its own pair.
 *
 * IS NOT: how fast, how it starts, how it ends, how it is stabilised.
 * Those are stated once, in MOTION_QUALITY, for every transition. The
 * route is passed through `sanitizeMotionInstruction` on the way in, so
 * a sentence like "rotate gently toward the window" — a real one, from
 * the operator's database — contributes its rotation and its window and
 * leaves its tempo behind.
 */

export type FinalPrompt =
  | {
      ok: true
      prompt: string
      plan: TransitionPlan
      /** The route actually used, after hygiene. Stored as provenance. */
      motionInstruction: string | null
      /** True when an individual analysis supplied the route. */
      usedIndividualRoute: boolean
    }
  | { ok: false; reason: string }

export interface FinalizeInput {
  project: Project
  pairKey: string
  /**
   * The route from an accepted individual analysis, when one is the
   * winning evidence for this pair. Raw — hygiene is applied here so
   * every caller gets the same treatment rather than remembering to.
   */
  individualMotionInstruction?: string | null
  /** The operator's own words about this pair, when active. */
  operatorContext?: OperatorSpatialContext | null
}

/**
 * Build the final prompt for ONE pair, the canonical way.
 *
 * Reads the same analysis, applies the same overrides, plans over the
 * same feed and renders through the same `renderPrompt` as every other
 * caller — so "which path produced this prompt" stops being a question
 * that can change the answer.
 */
/**
 * The finalizer, bound to one project.
 *
 * Callers that finish MANY pairs — the rebuild, the analyse-prompts
 * preview — plan the feed once and finish each pair against it, instead
 * of re-reading the analysis per pair. Same arithmetic either way; this
 * is only about not doing it forty times.
 */
export function createPromptFinalizer(project: Project): {
  finalize: (pairKey: string, opts?: Omit<FinalizeInput, 'project' | 'pairKey'>) => FinalPrompt
} {
  const analysis = applyImageOverrides(readAnalysis(project.id), listOverrides(project.id))
  const feedIds = getFeedSequenceIds(project)

  // The operator's facts for EVERY pair, so a rebuilt prompt keeps
  // carrying them — the planner needs the whole map, not just this pair.
  const contexts = new Map<string, OperatorSpatialContext>()
  for (const [key, t] of Object.entries(project.transitions)) {
    if (t?.operatorContext && t.operatorContext.text.trim().length > 0) {
      contexts.set(key, t.operatorContext)
    }
  }

  const plans = planSequence(analysis, feedIds, undefined, contexts)

  return {
    finalize: (pairKey, opts = {}) =>
      finishOne({ project, pairKey, plans, contexts, ...opts })
  }
}

export function finalizeTransitionPrompt(input: FinalizeInput): FinalPrompt {
  return createPromptFinalizer(input.project).finalize(input.pairKey, input)
}

function finishOne(
  input: FinalizeInput & { plans: TransitionPlan[]; contexts: Map<string, OperatorSpatialContext> }
): FinalPrompt {
  const { project, pairKey, plans } = input
  const [fromImageId, toImageId] = pairKey.split('->') as [string, string]
  const plan = plans.find((p) => p.fromImageId === fromImageId && p.toImageId === toImageId)
  if (!plan) {
    return {
      ok: false,
      reason:
        'This transition is not part of the current Transition Feed, so there is nothing to ' +
        'build a route from.'
    }
  }

  // ── THE PAIR'S OWN FINDING WINS, WITH ITS TEMPO REMOVED ────────────
  //
  // An accepted individual analysis looked at this exact pair; the
  // property map is a generalisation. So its route replaces the derived
  // one — which is what makes Re-analyse worth running — but only the
  // route. `sanitizeMotionInstruction` is what stops the replacement
  // smuggling a speed in with it.
  //
  // `hasEvidence` and `useBaseSafetyMotion` move with it, because
  // `renderMotionInstruction` reads them to decide whether there is a
  // route to state at all — an accepted individual analysis of this
  // exact pair IS evidence for it, even when the property map has
  // nothing. Without this the route was set and then discarded, and the
  // prompt fell back to the neutral "move with restraint" sentence.
  //
  // NOTHING ABOUT SAFETY MOVES. `safetyVerdict` and
  // `physicalNavigationAllowed` are left exactly as the planner decided
  // them: this makes the route sayable, never permitted. A pair that may
  // not travel through a doorway still may not.
  // ── THE LOOKUP LIVES HERE, NOT IN EVERY CALLER ────────────────────
  //
  // A caller that forgets to pass the pair's own analysis silently gets
  // the property-map derivation instead — a different prompt for the
  // same pair, which is the whole fault being fixed. So the default is
  // to look it up. `undefined` means "find it"; an explicit value wins,
  // which is what the acceptance path needs because its record is not
  // stored as accepted yet.
  const stored = readPairAnalysis(project.id, pairKey)
  const rawRoute =
    input.individualMotionInstruction !== undefined
      ? input.individualMotionInstruction
      : stored?.state === 'accepted'
        ? stored.motionInstruction
        : null

  const individual = sanitizeMotionInstruction(rawRoute)
  const effectivePlan: TransitionPlan = individual
    ? { ...plan, motionInstruction: individual, hasEvidence: true, useBaseSafetyMotion: false }
    : plan

  const prompt = renderPrompt(effectivePlan, {}, undefined, input.operatorContext ?? null)
  return {
    ok: true,
    prompt,
    plan: effectivePlan,
    motionInstruction: effectivePlan.motionInstruction,
    usedIndividualRoute: Boolean(individual)
  }
}

/** Convenience for callers that only have ids. */
export function finalizeTransitionPromptById(
  projectId: string,
  pairKey: string,
  opts: Omit<FinalizeInput, 'project' | 'pairKey'> = {}
): FinalPrompt {
  const project = listProjects().find((p) => p.id === projectId)
  if (!project) return { ok: false, reason: 'Project no longer exists.' }
  return finalizeTransitionPrompt({ project, pairKey, ...opts })
}
