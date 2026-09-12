import { listProjects, saveProject } from '../db/projectsRepo'
import { getGenerationsForPair } from '../db/generationCatalogueRepo'
import { qualityAllowsActive } from '../../shared/qualityValidation'
import { resolveClipPath } from '../files'

/**
 * NORMALISE `status: 'failed'` ROWS THAT DID NOT FAIL.
 *
 * ── WHAT WENT WRONG ──────────────────────────────────────────────────
 *
 * Before quality validation existed, a live generation ending with no
 * attached clip could only mean the delivery broke, so the generation
 * path wrote `failed`. Quality validation then introduced a second,
 * entirely healthy reason for a transition to have no clip: the file
 * arrived and the inspection held it back for a decision.
 *
 * Those rows are still on disk saying `failed` about generations that
 * succeeded at the provider, downloaded, and are sitting playable in the
 * project directory.
 *
 * ── WHAT THIS DOES, AND DOES NOT, CHANGE ─────────────────────────────
 *
 * It rewrites ONLY the transition's `status` word, and only when the
 * catalogue proves the generation was delivered: a row for this pair
 * with a clip name whose file is actually on disk, held back solely
 * because the quality gate refused to activate it.
 *
 * It does NOT attach the clip, does not touch `active`, does not alter
 * any quality verdict, and never turns a rejected clip into a used one.
 * The gate is untouched — this corrects a label that is factually wrong.
 *
 * The renderer derives its state from the catalogue regardless, so this
 * is housekeeping rather than the fix. A legacy row displays correctly
 * whether or not this has run.
 */
export function repairQualityHeldStatuses(projectId?: string): {
  projectsTouched: number
  transitionsRepaired: number
} {
  let projectsTouched = 0
  let transitionsRepaired = 0

  for (const project of listProjects()) {
    if (projectId && project.id !== projectId) continue
    let changed = false

    for (const [pairKey, transition] of Object.entries(project.transitions)) {
      if (!transition || transition.status !== 'failed') continue
      // A transition that HAS a clip was never in this state.
      if (transition.clip) continue

      const [fromId, toId] = pairKey.split('->') as [string, string]
      if (!fromId || !toId) continue

      const latest = getGenerationsForPair(project.id, fromId, toId)[0]
      if (!latest?.clip) continue

      // THE FILE MUST REALLY BE THERE. A catalogue row naming a clip that
      // has since been deleted is a genuine "nothing to play", and
      // relabelling that would hide a real problem.
      if (!resolveClipPath(project.id, latest.clip.storedName)) continue

      // And it must be held by the QUALITY gate specifically — not
      // inactive for some other reason.
      if (qualityAllowsActive(latest.qualityStatus, latest.qualityOverride)) continue

      project.transitions[pairKey] = { ...transition, status: 'completed' }
      transitionsRepaired++
      changed = true
      console.log(
        `[status-repair] ${project.id} ${pairKey} failed → completed ` +
          `(delivered, quality=${latest.qualityStatus})`
      )
    }

    if (changed) {
      project.updatedAt = Date.now()
      saveProject(project)
      projectsTouched++
    }
  }

  return { projectsTouched, transitionsRepaired }
}
