import { listProjects, saveProject } from '../db/projectsRepo'
import { readAnalysis } from '../db/analysisRepo'
import { listOverrides } from '../db/overrideRepo'
import { applyImageOverrides } from '../../shared/imageFacts'
import { getFeedSequenceIds } from '../../shared/feedSequence'
import { planSequence } from '../../shared/transitionPlan'
import { readPairAnalysis } from '../db/pairAnalysisRepo'
import { finalizeTransitionPrompt } from './promptFinalizer'
import {
  promptExceedsLimit,
  promptUsesRetiredContract,
  promptUsesRetiredLayout
} from '../../shared/prompts'
import type { OperatorSpatialContext } from '../../shared/operatorContext'

/**
 * REBUILD PROMPTS WRITTEN UNDER THE RETIRED CAMERA ONTOLOGY.
 *
 * ── THE PROBLEM THIS SOLVES ──────────────────────────────────────────
 *
 * A transition's prompt is STORED, and improving the preset does not
 * reach work already planned — correctly, because an operator may have
 * written that wording themselves. The consequence was invisible and
 * expensive: after the preset was rewritten to remove the physical-camera
 * ontology, the bathroom pair went on sending a 3789-character prompt
 * that opened with "cinematic camera transition" and described "a
 * high-end stabilized gimbal or indoor drone". Ten of eighty-four stored
 * prompts in the operator's project carried it.
 *
 * Nothing detected that. The prompt looked current — it had been planned
 * minutes earlier — because currency was tracked against the EVIDENCE it
 * was built from, never against the prompt contract it was built under.
 *
 * ── WHAT IT WILL AND WILL NOT TOUCH ──────────────────────────────────
 *
 * Only prompts that (a) contain retired wording and (b) are not
 * hand-written. A manual prompt is the operator's own sentence; it is
 * reported rather than rewritten, because silently editing someone's text
 * is worse than the wording being wrong. `promptOntologyOffenders` lists
 * those so the UI can ask.
 */

export interface OntologyRepairResult {
  projectsTouched: number
  promptsRebuilt: number
  /** Every stored prompt considered, so a repair can be read as a ratio. */
  promptsScanned: number
  /** Carrying retired wording BEFORE the repair — manual ones included. */
  offendersBefore: number
  /** Hand-written prompts that carry retired wording. Never rewritten. */
  manualOffenders: Array<{ projectId: string; pairKey: string }>
  /** Offenders whose pair is no longer in the feed, so nothing can rebuild them. */
  unplannable: Array<{ projectId: string; pairKey: string }>
}

/**
 * @param projectId Limit to one project. Omit to sweep all of them.
 * @param dryRun    Report what WOULD change and write nothing. The audit
 *                  runs this way first: this rewrites stored operator
 *                  work, so "what would happen" has to be answerable
 *                  without it having already happened.
 */
export function repairRetiredPromptOntology(
  projectId?: string,
  dryRun = false
): OntologyRepairResult {
  let projectsTouched = 0
  let promptsRebuilt = 0
  let promptsScanned = 0
  let offendersBefore = 0
  const manualOffenders: OntologyRepairResult['manualOffenders'] = []
  const unplannable: OntologyRepairResult['unplannable'] = []

  for (const project of listProjects()) {
    if (projectId && project.id !== projectId) continue

    const stored = Object.entries(project.transitions).filter(([, t]) => t?.prompt)
    promptsScanned += stored.length

    const affected = stored.filter(
      // ANY superseded contract, not just the camera ontology. The
      // constant-velocity rule retired the ease-in/ease-out wording the
      // same way, and a stored row can carry either or both.
      //
      // Length counts as its own reason. A stored prompt longer than the
      // provider accepts is not a wording preference — it cannot be sent
      // as written, and the fitter will drop sections out of it at
      // submit time. Wording detection would have missed exactly that
      // case: the 8 prompts carrying the over-long draft said all the
      // right things, at 4000 characters.
      //
      // And LAYOUT, which length alone misses: a short instruction can
      // sit last and still be under the limit. It is built the wrong way
      // round, one edit from overflowing, and the model reads the route
      // after everything else.
      ([, t]) =>
        t &&
        (promptUsesRetiredContract(t.prompt) ||
          promptExceedsLimit(t.prompt) ||
          promptUsesRetiredLayout(t.prompt))
    )
    offendersBefore += affected.length
    if (affected.length === 0) continue

    const analysis = applyImageOverrides(readAnalysis(project.id), listOverrides(project.id))
    const feedIds = getFeedSequenceIds(project)

    // The operator's own facts, so a rebuilt prompt keeps carrying them.
    const contexts = new Map<string, OperatorSpatialContext>()
    for (const [pairKey, t] of Object.entries(project.transitions)) {
      if (t?.operatorContext && t.operatorContext.text.trim().length > 0) {
        contexts.set(pairKey, t.operatorContext)
      }
    }
    const plans = planSequence(analysis, feedIds, undefined, contexts)

    let changed = false
    for (const [pairKey, transition] of affected) {
      if (!transition) continue
      if (transition.promptProvenance?.manuallyEdited) {
        manualOffenders.push({ projectId: project.id, pairKey })
        continue
      }

      // THE SAME FINALIZER RE-ANALYSE USES. This file used to be the only
      // caller of the canonical builder, which is how the divergence
      // stayed invisible: the path that produced good prompts and the
      // path that produced different ones were both "working".
      const finalized = finalizeTransitionPrompt({
        project,
        pairKey,
        individualMotionInstruction: readPairAnalysis(project.id, pairKey)?.motionInstruction ?? null,
        operatorContext: transition.operatorContext ?? null
      })
      const [fromImageId, toImageId] = pairKey.split('->') as [string, string]
      const plan = plans.find((p) => p.fromImageId === fromImageId && p.toImageId === toImageId)
      if (!finalized.ok || !plan) {
        // No plan means the pair is not in the current feed, so there is
        // nothing to rebuild the wording from. Counted and named rather
        // than skipped in silence: the audit otherwise reports offenders
        // it then does nothing about, which reads as the repair having
        // failed. These cannot be generated either — the preflight
        // refuses a pair outside the feed first.
        unplannable.push({ projectId: project.id, pairKey })
        continue
      }

      const prompt = finalized.prompt
      project.transitions[pairKey] = {
        ...transition,
        prompt,
        promptProvenance: transition.promptProvenance
          ? {
              ...transition.promptProvenance,
              motionInstruction: finalized.motionInstruction,
              effectivePrompt: prompt,
              plannedAt: Date.now()
            }
          : transition.promptProvenance
      }
      promptsRebuilt++
      changed = true
      console.log(`[prompt-ontology] ${dryRun ? 'would rebuild' : 'rebuilt'} ${project.id} ${pairKey}`)
    }

    if (changed) {
      if (!dryRun) {
        project.updatedAt = Date.now()
        saveProject(project)
      }
      projectsTouched++
    }
  }

  console.log(
    `[prompt-ontology] ${dryRun ? 'DRY RUN — nothing written. ' : ''}` +
      `scanned ${promptsScanned} stored prompt(s); ${offendersBefore} carried retired wording; ` +
      `${dryRun ? 'would rebuild' : 'rebuilt'} ${promptsRebuilt} across ${projectsTouched} project(s); ` +
      `${manualOffenders.length} hand-written prompt(s) left untouched for the operator; ` +
      `${unplannable.length} outside the current feed`
  )
  for (const m of manualOffenders) {
    console.log(`[prompt-ontology]   manual, left alone: ${m.projectId} ${m.pairKey}`)
  }
  for (const u of unplannable) {
    console.log(
      `[prompt-ontology]   not in the current feed, nothing to rebuild from: ${u.projectId} ${u.pairKey}`
    )
  }
  return {
    projectsTouched,
    promptsRebuilt,
    promptsScanned,
    offendersBefore,
    manualOffenders,
    unplannable
  }
}
