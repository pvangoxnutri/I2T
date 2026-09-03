import { getFeedSequenceIds } from '../../shared/feedSequence'
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
import { resolveTransitionMode } from '../../shared/transitionMode'
import { logicalTransitionCount, logicalTransitions } from '../../shared/logicalTransitions'
import { getSettingsJson } from '../db/projectsRepo'
import type { AppSettings } from '../../shared/types'
import { broadcastProjectUpdated } from '../events'

/**
 * The default clip length, for transitions that have no stored row yet.
 *
 * Read from settings rather than hard-coded so a pair created by a
 * rebuild gets the same duration as one created any other way.
 */
function defaultDurationSec(): number {
  try {
    const json = getSettingsJson()
    if (!json) return 5
    return (JSON.parse(json) as AppSettings).exportDefaults?.defaultTransitionDurationSec ?? 5
  } catch {
    return 5
  }
}

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
  const empty: RebuildPlanSummary = {
    rebuildable: [],
    preserved: [],
    unchanged: [],
    skipped: [],
    logicalTransitionCount: 0,
    hasAnalysis: false,
    analysisIsMock: false
  }
  if (!project) return empty

  const analysis = plannerAnalysis(projectId)
  const hasAnalysis = analysis.rooms.length > 0
  // The WHOLE sequence at once, so each plan can see the one before it.
  // Planning pair-by-pair could not do continuity at all.
  // PLANNED OVER THE FEED, because that is what `logicalTransitions`
  // iterates and what `t.position` indexes into. Planning over
  // `project.images` meant feed position N looked up the plan for library
  // position N — a different pair entirely whenever the feed had been
  // reordered, which is exactly what accepting a proposal does.
  const plans = planSequence(analysis, getFeedSequenceIds(project))

  const rebuildable: RebuildPlanSummary['rebuildable'] = []
  const preserved: RebuildPlanSummary['preserved'] = []
  const unchanged: RebuildPlanSummary['unchanged'] = []
  const skipped: RebuildPlanSummary['skipped'] = []

  // ── EVERY LOGICAL TRANSITION ─────────────────────────────────────────
  //
  // This loop used to skip any pair with no stored row (`if (!transition)
  // continue`), so a thirty-image project offered 2 rebuildable
  // transitions out of 29 and the other 27 did not appear anywhere at
  // all — not as unchanged, not as preserved, just gone. Absence of a row
  // means unconfigured, never non-existent.
  for (const t of logicalTransitions(project, defaultDurationSec())) {
    // ── A CUT HAS NO PROMPT ───────────────────────────────────────────
    //
    // No video is generated for it, so planning motion wording would
    // create a row purely to hold text nothing will ever read — and would
    // report work the operator is not doing.
    const effective = resolveTransitionMode(
      t.persisted?.mode ?? 'auto',
      plans[t.position] ?? null,
      Boolean(t.persisted?.clip)
    ).effectiveMode
    if (effective !== 'ai') {
      skipped.push({ pairKey: t.pairKey, label: t.label, mode: effective })
      continue
    }

    if (!canRebuildPrompt(t.persisted?.promptProvenance)) {
      preserved.push({ pairKey: t.pairKey, label: t.label })
      continue
    }

    const plan = plans[t.position]
    const labels = labelsFor(analysis, t.startImageId, t.endImageId)
    const nextPrompt = renderPrompt(plan, labels)

    // A pair whose prompt is ALREADY what the analysis would produce is
    // reported as unchanged rather than as work — the counts are what the
    // operator uses to decide whether to press the button.
    if (t.persisted && t.persisted.prompt === nextPrompt) {
      unchanged.push({ pairKey: t.pairKey, label: t.label })
      continue
    }

    rebuildable.push({
      pairKey: t.pairKey,
      label: t.label,
      basis: plan.relationType.toLowerCase().replace('_', '-'),
      preview: renderMotionInstruction(plan, labels) ?? 'Base safety prompt only'
    })
  }

  return {
    rebuildable,
    preserved,
    unchanged,
    skipped,
    logicalTransitionCount: logicalTransitionCount(project),
    hasAnalysis,
    // A placeholder structure is not a spatial map. Rebuilding every
    // prompt from one would replace real wording with wording derived
    // from nothing.
    analysisIsMock: analysis.provenance?.mode === 'mock' || analysis.source === 'mock'
  }
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
  // PLANNED OVER THE FEED, because that is what `logicalTransitions`
  // iterates and what `t.position` indexes into. Planning over
  // `project.images` meant feed position N looked up the plan for library
  // position N — a different pair entirely whenever the feed had been
  // reordered, which is exactly what accepting a proposal does.
  const plans = planSequence(analysis, getFeedSequenceIds(project))

  // EVERY logical transition, not only the ones with a stored row. The
  // `if (!transition) continue` that used to be here is what made a
  // thirty-image project rebuild two prompts and silently leave 27
  // untouched — see the note in shared/logicalTransitions.ts.
  for (const t of logicalTransitions(project, defaultDurationSec())) {
    // A cut or a crossfade generates no video, so it needs no prompt and
    // gets no row created for one.
    if (
      resolveTransitionMode(t.persisted?.mode ?? 'auto', plans[t.position] ?? null, Boolean(t.persisted?.clip))
        .effectiveMode !== 'ai'
    ) {
      continue
    }

    if (!canRebuildPrompt(t.persisted?.promptProvenance)) {
      preservedCount++
      continue
    }

    const plan = plans[t.position]
    const labels = labelsFor(analysis, t.startImageId, t.endImageId)
    const motion = renderMotionInstruction(plan, labels)
    const prompt = renderPrompt(plan, labels)

    // ── DO NOT WRITE WHAT WOULD NOT CHANGE ─────────────────────────────
    //
    // The dialog counts this pair as "unchanged", so writing it anyway
    // would make the preview a lie about its own work. It would also bump
    // `updatedAt`, which marks the assembled editor preview stale — a
    // rebuild that changed nothing should not invalidate a built video.
    if (t.persisted && t.persisted.prompt === prompt) {
      continue
    }

    // ── THE ROW IS CREATED HERE, AND ONLY HERE ─────────────────────────
    //
    // Persistence stays lazy for DISPLAY — listing 29 transitions creates
    // nothing. A row appears when there is genuinely something to store,
    // which is exactly this: an analysis-managed prompt with provenance.
    // `t.settings` supplies defaults for a pair that had no row, so
    // duration and clip are carried correctly either way.
    project.transitions[t.pairKey] = {
      ...t.settings,
      prompt,
      promptProvenance: {
        basePrompt: DEFAULT_TRANSITION_PROMPT,
        motionInstruction: motion,
        effectivePrompt: prompt,
        basis:
          plan.relationType === 'SAME_ROOM'
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

  // A rebuild that wrote nothing must not touch the project at all.
  // Bumping `updatedAt` marks the assembled editor preview stale, and a
  // no-op should never cost someone a re-render of a finished video.
  if (rebuiltCount === 0) return { rebuiltCount, preservedCount }

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

  const analysis = plannerAnalysis(projectId)
  const now = Date.now()

  // ── PLANNED AS PART OF THE SEQUENCE ──────────────────────────────────
  //
  // Deliberately `planSequence`, not the pair-wise planner. A prompt built
  // in isolation has no incoming continuity, so adopting the analysis
  // prompt for one transition used to write DIFFERENT wording than a bulk
  // rebuild would write for the very same pair — and the next rebuild
  // would immediately list it as needing an update. Two paths that claim
  // to produce "the analysis prompt" must produce the same one.
  // PLANNED OVER THE FEED, because that is what `logicalTransitions`
  // iterates and what `t.position` indexes into. Planning over
  // `project.images` meant feed position N looked up the plan for library
  // position N — a different pair entirely whenever the feed had been
  // reordered, which is exactly what accepting a proposal does.
  const plans = planSequence(analysis, getFeedSequenceIds(project))

  for (const t of logicalTransitions(project, defaultDurationSec())) {
    if (t.pairKey !== pairKey) continue

    const replacedManualPrompt = t.persisted?.promptProvenance?.manuallyEdited === true
    const plan = plans[t.position]
    const labels = labelsFor(analysis, t.startImageId, t.endImageId)
    const motion = renderMotionInstruction(plan, labels)
    const prompt = renderPrompt(plan, labels)

    // Works for an unconfigured pair too: `t.settings` supplies defaults,
    // and the row is created here because there is now something to store.
    project.transitions[pairKey] = {
      ...t.settings,
      prompt,
      // Adopting the analysis prompt makes this transition
      // analysis-managed again, so future rebuilds may update it.
      promptProvenance: {
        basePrompt: DEFAULT_TRANSITION_PROMPT,
        motionInstruction: motion,
        effectivePrompt: prompt,
        basis:
          plan.relationType === 'SAME_ROOM'
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
    project.updatedAt = now
    saveProject(project)
    broadcastProjectUpdated(projectId)
    return { ok: true, replacedManualPrompt }
  }
  return { ok: false, replacedManualPrompt: false }
}


