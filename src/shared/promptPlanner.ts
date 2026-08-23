import { DEFAULT_TRANSITION_PROMPT } from './prompts'
import { relateImages, type PropertyAnalysis, type SpatialRelation } from './propertyAnalysis'

/**
 * TRANSITION PROMPT PLANNING from whole-property analysis.
 *
 * ── WHAT THIS ADDS, AND WHAT IT MUST NEVER REMOVE ────────────────────
 *
 * The default prompt is a SAFETY contract: reproduce the end frame
 * exactly, preserve architecture, invent nothing, no morphing, physically
 * plausible motion, photorealistic. Every one of those constraints exists
 * because a generation broke it once.
 *
 * Property analysis only ever adds a MOTION INSTRUCTION — how the camera
 * should travel between two frames it already has. It is composed with
 * the safety prompt, never in place of it. There is no branch here that
 * produces a prompt without the base contract.
 *
 * ── THE UNKNOWN CASE IS THE IMPORTANT ONE ────────────────────────────
 *
 * When the relationship between two images is unknown, the planner says
 * nothing about navigation. It does NOT guess a doorway, a corridor or a
 * direction. Inventing physical navigation is precisely the failure mode
 * that makes AI video unusable for property marketing — a tour that walks
 * through a wall misrepresents the home being sold.
 *
 * A confirmed adjacency is still not enough on its own: the move-through
 * instruction also requires an opening visible in the START image, since
 * that is the only frame the camera is actually leaving from.
 */

export type PromptPlanBasis = 'same-room' | 'adjacent-room' | 'unknown'

export interface TransitionPromptPlan {
  /** The unchanged FrameToFrame safety prompt. */
  basePrompt: string
  /** The analysis-derived motion sentence, or null when we know nothing. */
  motionInstruction: string | null
  /** What the plan was built from. */
  basis: PromptPlanBasis
  /** Plain-language reason, for the provenance panel. */
  rationale: string
  /** base + motion — what would be sent if the prompt is not hand-edited. */
  effectivePrompt: string
}

/** Turn a landmark list into readable English without a trailing comma. */
function list(items: string[]): string {
  const clean = items.map((i) => i.trim()).filter(Boolean)
  if (clean.length === 0) return ''
  if (clean.length === 1) return clean[0]
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`
  return `${clean.slice(0, -1).join(', ')} and ${clean[clean.length - 1]}`
}

function planFromRelation(relation: SpatialRelation): {
  motion: string | null
  basis: PromptPlanBasis
  rationale: string
} {
  if (relation.kind === 'same-room') {
    const anchors = list(relation.shared)
    // Within one room the camera repositions rather than travels. Naming a
    // shared landmark gives the model something real to hold on to instead
    // of drifting the geometry between the two viewpoints.
    const motion =
      `Both frames show the same room (${relation.room.label}). Move within this room only: ` +
      `a slow forward dolly with a slight rotation toward the END FRAME's viewpoint` +
      (anchors ? `, keeping ${anchors} continuously visible as the spatial anchor` : '') +
      `. Do not leave the room and do not pass through any doorway.`
    return {
      motion,
      basis: 'same-room',
      rationale: anchors
        ? `Both images are assigned to ${relation.room.label}, sharing ${anchors}.`
        : `Both images are assigned to ${relation.room.label}.`
    }
  }

  if (relation.kind === 'adjacent-room') {
    // A room connection we believe in, but the camera can only move through
    // an opening it can actually see from the start frame.
    if (relation.confidence === 'confirmed' && relation.openings.length > 0) {
      const through = list(relation.openings)
      return {
        motion:
          `The END FRAME is in the ${relation.to.label}, reached from the ${relation.from.label} ` +
          `through the ${through} visible in the START FRAME. Move the camera forward through ` +
          `that visible opening and settle into the ${relation.to.label}. Do not invent any ` +
          `corridor, door or opening that is not visible in the START FRAME.`,
        basis: 'adjacent-room',
        rationale:
          `Confirmed connection ${relation.from.label} ↔ ${relation.to.label}, ` +
          `with ${through} visible in the start image.`
      }
    }
    // Probable, or confirmed but with nothing visible to move through. We
    // may say the destination changes room WITHOUT staging a walk-through.
    return {
      motion:
        `The START FRAME is in the ${relation.from.label} and the END FRAME is in the ` +
        `${relation.to.label}. Move the camera smoothly toward the END FRAME's viewpoint ` +
        `without depicting travel through any doorway or opening, since none is confirmed ` +
        `visible in the START FRAME.`,
      basis: 'adjacent-room',
      rationale:
        relation.openings.length === 0
          ? `${relation.from.label} ↔ ${relation.to.label} is ${relation.confidence}, but no opening is visible in the start image.`
          : `${relation.from.label} ↔ ${relation.to.label} is only ${relation.confidence}.`
    }
  }

  // UNKNOWN — say nothing about navigation at all.
  return {
    motion: null,
    basis: 'unknown',
    rationale:
      'No confident spatial relationship between these images. No navigation instruction was added.'
  }
}

export function planTransitionPrompt(
  analysis: PropertyAnalysis | null,
  startImageId: string,
  endImageId: string,
  basePrompt: string = DEFAULT_TRANSITION_PROMPT
): TransitionPromptPlan {
  const relation: SpatialRelation = analysis
    ? relateImages(analysis, startImageId, endImageId)
    : { kind: 'unknown' }
  const { motion, basis, rationale } = planFromRelation(relation)

  return {
    basePrompt,
    motionInstruction: motion,
    basis,
    rationale,
    // The safety contract ALWAYS leads. The motion instruction is appended
    // under its own heading so it can never be read as replacing a rule
    // above it.
    effectivePrompt: motion ? `${basePrompt}\n\nCAMERA MOVEMENT FOR THIS TRANSITION:\n${motion}` : basePrompt
  }
}

/**
 * Prompt provenance (C8).
 *
 * A hand-edited prompt is the operator's judgement about one specific
 * transition, and re-running the analysis must never quietly overwrite it.
 * `manuallyEdited` is what protects that, and it is only ever set by a
 * real edit in the UI — never inferred from the text differing.
 */
export interface PromptProvenance {
  basePrompt: string
  motionInstruction: string | null
  effectivePrompt: string
  basis: PromptPlanBasis
  rationale: string
  manuallyEdited: boolean
  plannedAt: number
  /**
   * `PropertyAnalysis.updatedAt` this wording was planned from, so a stale
   * prompt can be spotted without re-running the planner. Null when it was
   * planned with no analysis, or for rows written before provenance
   * existed.
   */
  analysisUpdatedAt: number | null
}

/**
 * Provenance for a freshly planned prompt. `manuallyEdited` is FALSE here
 * by construction: this records what the planner produced, and only a real
 * edit in the UI may ever set that flag.
 */
export function provenanceFromPlan(
  plan: TransitionPromptPlan,
  analysisUpdatedAt: number | null,
  now: number
): PromptProvenance {
  return {
    basePrompt: plan.basePrompt,
    motionInstruction: plan.motionInstruction,
    effectivePrompt: plan.effectivePrompt,
    basis: plan.basis,
    rationale: plan.rationale,
    manuallyEdited: false,
    plannedAt: now,
    analysisUpdatedAt
  }
}

/**
 * Mark a transition as hand-written. Once set, `canRebuildPrompt` returns
 * false forever after and Property Analysis can no longer touch it.
 */
export function markManuallyEdited(
  existing: PromptProvenance | null | undefined,
  prompt: string,
  now: number
): PromptProvenance {
  return {
    basePrompt: existing?.basePrompt ?? '',
    motionInstruction: existing?.motionInstruction ?? null,
    effectivePrompt: prompt,
    basis: existing?.basis ?? 'unknown',
    rationale: 'Written by hand — Property Analysis will not overwrite it.',
    manuallyEdited: true,
    plannedAt: existing?.plannedAt ?? now,
    analysisUpdatedAt: existing?.analysisUpdatedAt ?? null
  }
}

/**
 * Whether "Rebuild prompts from Property Analysis" may touch this
 * transition. Hand-written wording is never replaced.
 */
export function canRebuildPrompt(provenance: PromptProvenance | null | undefined): boolean {
  return !provenance?.manuallyEdited
}

/**
 * What a "Rebuild prompts from Property Analysis" would do.
 *
 * Lives in `shared` because it crosses the preload boundary: the renderer
 * needs the counts to write an honest confirmation ("8 will be rebuilt, 3
 * manually edited will be preserved") BEFORE anything is written.
 */
export interface RebuildPlanSummary {
  /** Transitions whose prompt would be rebuilt. */
  rebuildable: Array<{ pairKey: string; label: string; basis: string; preview: string }>
  /** Manually edited transitions that will be left alone. */
  preserved: Array<{ pairKey: string; label: string }>
  /** Whether an analysis exists at all. */
  hasAnalysis: boolean
}
