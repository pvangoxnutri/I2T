import { transitionKey } from '../../shared/types'
import {
  canRebuildPrompt,
  planTransitionPrompt,
  provenanceFromPlan,
  type RebuildPlanSummary
} from '../../shared/promptPlanner'
import { planSequence, renderMotionInstruction, renderPrompt } from '../../shared/transitionPlan'
import { roomOfImage } from '../../shared/propertyAnalysis'
import { DEFAULT_TRANSITION_PROMPT } from '../../shared/prompts'
import { listProjects, saveProject } from '../db/projectsRepo'
import { readAnalysis } from '../db/analysisRepo'
import { listOverrides } from '../db/overrideRepo'
import { applyImageOverrides } from '../../shared/imageFacts'
import { broadcastProjectUpdated } from '../events'

/**
 * The analysis the PLANNER reads: accepted, with manual corrections
 * folded in.
 *
 * An operator who fixed a wrong room assignment expects the prompts to
 * follow the fix. Folding the corrections in here rather than teaching
 * every planning rule about a side table keeps ONE code path, so every
 * safety guard already written keeps applying to the corrected picture.
 */
function plannerAnalysis(projectId: string): ReturnType<typeof readAnalysis> {
  return applyImageOverrides(readAnalysis(projectId), listOverrides(projectId))
}

/**
 * Rebuilding transition prompts from Property Analysis.
 *
 * ── THE RULE THAT MATTERS ────────────────────────────────────────────
 *
 * A hand-written prompt is an operator's judgement about ONE specific
 * transition — usually because the generic plan got something wrong. Any
 * rebuild that silently replaced it would destroy the fix and, worse,
 * would do it invisibly right before someone pays to generate. So
 * `manuallyEdited` is absolute: those transitions are skipped, counted,
 * and reported.
 *
 * The counts are computed BEFORE anything is written, so the confirmation
 * can state exactly what will happen rather than describing it afterwards.
 */

function labelFor(imageCount: number, index: number): string {
  void imageCount
  return `Image ${index + 1} → Image ${index + 2}`
}

/**
 * Room labels for one transition, so the rendered wording can name rooms
 * instead of saying "the next room".
 */
function labelsFor(
  analysis: ReturnType<typeof readAnalysis>,
  fromImageId: string,
  toImageId: string
): { fromRoom?: string; toRoom?: string } {
  const from = roomOfImage(analysis, fromImageId)?.label
  const to = roomOfImage(analysis, toImageId)?.label
  return { fromRoom: from, toRoom: to }
}

/** What a rebuild WOULD do. Writes nothing. */
export function planPromptRebuild(projectId: string): RebuildPlanSummary {
  const project = listProjects().find((p) => p.id === projectId)
  const empty: RebuildPlanSummary = { rebuildable: [], preserved: [], hasAnalysis: false }
  if (!project) return empty

  const analysis = plannerAnalysis(projectId)
  const hasAnalysis = analysis.rooms.length > 0
  // The WHOLE sequence at once, so each plan can see the one before it.
  // Planning pair-by-pair could not do continuity at all.
  const plans = planSequence(analysis, project.images.map((i) => i.id))

  const rebuildable: RebuildPlanSummary['rebuildable'] = []
  const preserved: RebuildPlanSummary['preserved'] = []

  for (let i = 0; i < project.images.length - 1; i++) {
    const start = project.images[i]
    const end = project.images[i + 1]
    const key = transitionKey(start.id, end.id)
    const transition = project.transitions[key]
    if (!transition) continue
    const label = labelFor(project.images.length, i)

    if (!canRebuildPrompt(transition.promptProvenance)) {
      preserved.push({ pairKey: key, label })
      continue
    }
    const plan = plans[i]
    rebuildable.push({
      pairKey: key,
      label,
      basis: plan.relationType.toLowerCase().replace('_', '-'),
      preview:
        renderMotionInstruction(plan, labelsFor(analysis, start.id, end.id)) ??
        'Base safety prompt only'
    })
  }

  return { rebuildable, preserved, hasAnalysis }
}

export interface RebuildResult {
  rebuiltCount: number
  preservedCount: number
}

/**
 * Apply the rebuild. Only transitions the plan listed as rebuildable are
 * touched — the same predicate is re-evaluated here rather than trusting a
 * list from the renderer, so a prompt edited between preview and confirm
 * is still protected.
 */
export function rebuildPromptsFromAnalysis(projectId: string): RebuildResult {
  const project = listProjects().find((p) => p.id === projectId)
  if (!project) return { rebuiltCount: 0, preservedCount: 0 }

  const analysis = plannerAnalysis(projectId)
  const now = Date.now()
  let rebuiltCount = 0
  let preservedCount = 0

  // Planned as a SEQUENCE. A manually edited transition is skipped for
  // writing but still occupies its slot in the plan list, so the clips
  // around it inherit the right continuity rather than being renumbered.
  const plans = planSequence(analysis, project.images.map((i) => i.id))

  for (let i = 0; i < project.images.length - 1; i++) {
    const start = project.images[i]
    const end = project.images[i + 1]
    const key = transitionKey(start.id, end.id)
    const transition = project.transitions[key]
    if (!transition) continue

    if (!canRebuildPrompt(transition.promptProvenance)) {
      preservedCount++
      continue
    }

    const plan = plans[i]
    const labels = labelsFor(analysis, start.id, end.id)
    const motion = renderMotionInstruction(plan, labels)
    project.transitions[key] = {
      ...transition,
      prompt: renderPrompt(plan, labels),
      promptProvenance: {
        basePrompt: DEFAULT_TRANSITION_PROMPT,
        motionInstruction: motion,
        effectivePrompt: renderPrompt(plan, labels),
        basis: plan.relationType === 'SAME_ROOM'
          ? 'same-room'
          : plan.relationType === 'ADJACENT_ROOM'
            ? 'adjacent-room'
            : 'unknown',
        rationale: plan.rationale,
        manuallyEdited: false,
        plannedAt: now,
        analysisUpdatedAt: analysis.updatedAt || null
      }
    }
    rebuiltCount++
  }

  project.updatedAt = now
  saveProject(project)
  broadcastProjectUpdated(projectId)
  return { rebuiltCount, preservedCount }
}

/**
 * Adopt the analysis prompt for ONE transition, including a manually
 * edited one.
 *
 * Separate from the bulk rebuild on purpose: this is a deliberate,
 * per-transition decision to discard custom wording, and the UI warns
 * before calling it. The bulk path can never reach here.
 */
export function applyAnalysisPromptToTransition(
  projectId: string,
  pairKey: string
): { ok: boolean; replacedManualPrompt: boolean } {
  const project = listProjects().find((p) => p.id === projectId)
  if (!project) return { ok: false, replacedManualPrompt: false }

  for (let i = 0; i < project.images.length - 1; i++) {
    const start = project.images[i]
    const end = project.images[i + 1]
    if (transitionKey(start.id, end.id) !== pairKey) continue
    const transition = project.transitions[pairKey]
    if (!transition) return { ok: false, replacedManualPrompt: false }

    const replacedManualPrompt = transition.promptProvenance?.manuallyEdited === true
    const analysis = plannerAnalysis(projectId)
    const plan = planTransitionPrompt(analysis, start.id, end.id)
    const now = Date.now()
    project.transitions[pairKey] = {
      ...transition,
      prompt: plan.effectivePrompt,
      // Adopting the analysis prompt makes this transition
      // analysis-managed again, so future rebuilds may update it.
      promptProvenance: provenanceFromPlan(plan, analysis.updatedAt || null, now)
    }
    project.updatedAt = now
    saveProject(project)
    broadcastProjectUpdated(projectId)
    return { ok: true, replacedManualPrompt }
  }
  return { ok: false, replacedManualPrompt: false }
}


