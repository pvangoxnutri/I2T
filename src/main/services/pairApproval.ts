import { getDb, scheduleFlush } from '../db/index'
import { listProjects, saveProject } from '../db/projectsRepo'
import { readAnalysis } from '../db/analysisRepo'
import { listOverrides } from '../db/overrideRepo'
import { readPairAnalysis, setPairAnalysisState } from '../db/pairAnalysisRepo'
import { currentPairEvidence } from './currentEvidence'
import { applyImageOverrides } from '../../shared/imageFacts'
import { getFeedSequenceIds } from '../../shared/feedSequence'
import { makeOperatorContext } from '../../shared/operatorContext'
import { resolvePairSpatialEvidence } from '../../shared/pairEvidence'
import { evidenceFingerprintOf } from '../../shared/promptPlanner'
import { planSequence } from '../../shared/transitionPlan'
import { finalizeTransitionPrompt } from './promptFinalizer'
import { DEFAULT_TRANSITION_PROMPT } from '../../shared/prompts'
import type { TransitionSettings } from '../../shared/types'

/**
 * APPROVE ONE PAIR — context, decision and wording, in one operation.
 *
 * ── THE RUNTIME BUG THIS EXISTS FOR ──────────────────────────────────
 *
 * The operator did everything right: ran the analysis, supplied the
 * missing spatial fact, approved. The screen agreed. Generation then
 * refused with "the transition prompt is based on outdated spatial
 * evidence".
 *
 * Recovered from the real database:
 *
 *   resolved evidence   operator / operator:1788716607428
 *   prompt provenance   NULL — never stamped at all
 *
 * Three separate writes did it. The renderer persisted the context, told
 * main to accept the pair analysis, then set the mode. And main's accept
 * only rebuilt the prompt when the STORED RECORD said `ai` — but the
 * record said `needs-context`, because that was the analyzer's verdict
 * before the operator answered. The operator's answer was the thing that
 * resolved it, and the rebuild never heard about it.
 *
 * So the decision about whether to rebuild can never be made from a
 * record written before the approval. It is made here, after everything
 * is persisted, from the evidence that actually resolves.
 *
 * ── THE STAMP COMES FROM THE RESOLVER ────────────────────────────────
 *
 * Not from this function's opinion. `resolvePairSpatialEvidence` is
 * consulted AFTER the writes, so the provenance recorded is by
 * construction the provenance generation preflight will compute. A
 * caller guessing `'operator'` here and the gate resolving something
 * else is the same bug in a new place.
 */

export interface PairApprovalResult {
  ok: boolean
  reason?: string
  /** What the wording ended up recorded against. */
  evidenceSource?: string
  evidenceFingerprint?: string
  /** True when a hand-written prompt was deliberately left alone. */
  manualPromptPreserved?: boolean
}

export function approvePair(input: {
  projectId: string
  pairKey: string
  mode: 'ai' | 'cut'
  /** Empty string clears; undefined leaves any stored context untouched. */
  contextText?: string
}): PairApprovalResult {
  const project = listProjects().find((p) => p.id === input.projectId)
  if (!project) return { ok: false, reason: 'Project not found' }

  const [fromImageId, toImageId] = input.pairKey.split('->') as [string, string]
  const feedIds = getFeedSequenceIds(project)
  if (!feedIds.some((id, i) => id === fromImageId && feedIds[i + 1] === toImageId)) {
    return {
      ok: false,
      reason: 'These two images are no longer next to each other in the Transition Feed.'
    }
  }

  const db = getDb()
  db.run('SAVEPOINT approve_pair')
  try {
    const analysis = applyImageOverrides(readAnalysis(input.projectId), listOverrides(input.projectId))
    const existing = project.transitions[input.pairKey]

    // ── 1-5. CONTEXT, DECISION, PROVENANCE ────────────────────────────
    const trimmed = (input.contextText ?? '').trim()
    const operatorContext =
      input.contextText === undefined
        ? existing?.operatorContext
        : trimmed.length > 0
          ? // Stamped against the map in force NOW, so a later analysis
            // can tell this was written after it and not before.
            makeOperatorContext(trimmed, Date.now(), analysis.updatedAt)
          : undefined

    const withDecision: TransitionSettings = {
      ...(existing ?? { prompt: '', durationSec: 5, status: 'not-generated', clip: null }),
      mode: input.mode,
      // The analyzer did not reach this conclusion on its own. Whether
      // they supplied a fact or simply decided, it is their call and the
      // history must keep saying so.
      modeProvenance: 'manual',
      operatorContext
    }
    project.transitions[input.pairKey] = withDecision

    // A pair analysis the operator has now acted on is accepted, whatever
    // the analyzer originally concluded.
    if (readPairAnalysis(input.projectId, input.pairKey)) {
      setPairAnalysisState(input.projectId, input.pairKey, 'accepted')
    }

    // ── 6. RESOLVE AGAIN, AFTER THE WRITES ────────────────────────────
    //
    // The same helper generation preflight calls, against the project row
    // this operation has just built — so what is stamped below is by
    // construction what the gate will recompute.
    const current = currentPairEvidence(input.projectId, input.pairKey, project)
    const fingerprint = current?.fingerprint ?? 'unknown'

    // ── 7-8. WORDING, STAMPED FROM THAT RESULT ────────────────────────
    let manualPromptPreserved = false
    if (input.mode === 'ai') {
      if (existing?.promptProvenance?.manuallyEdited) {
        // Their sentence stands. New evidence does not make it wrong,
        // and the generation gate exempts a manual prompt for exactly
        // that reason.
        manualPromptPreserved = true
      } else {
        // Planned WITH the context, so the wording carries it — and with
        // the same resolver-derived stamp the gate will recompute.
        const plans = planSequence(
          analysis,
          feedIds,
          undefined,
          operatorContext ? new Map([[input.pairKey, operatorContext]]) : undefined
        )
        const plan = plans.find(
          (p) => p.fromImageId === fromImageId && p.toImageId === toImageId
        )
        // THE CANONICAL FINALIZER, like every other path. Building here
        // from the plan alone discarded this pair's own accepted
        // analysis, so approving with context could replace a route the
        // operator had just re-analysed with the property-map guess.
        const finalized = finalizeTransitionPrompt({
          project,
          pairKey: input.pairKey,
          operatorContext: operatorContext ?? null
        })
        if (plan && finalized.ok) {
          const prompt = finalized.prompt
          project.transitions[input.pairKey] = {
            ...withDecision,
            prompt,
            promptProvenance: {
              basePrompt: DEFAULT_TRANSITION_PROMPT,
              motionInstruction: finalized.motionInstruction,
              effectivePrompt: prompt,
              basis:
                plan.relationType === 'SAME_ROOM'
                  ? 'same-room'
                  : plan.relationType === 'ADJACENT_ROOM'
                    ? 'adjacent-room'
                    : 'unknown',
              rationale: plan.rationale,
              manuallyEdited: false,
              plannedAt: Date.now(),
              analysisUpdatedAt: analysis.updatedAt ?? null,
              evidenceSource: current?.source ?? 'unknown',
              evidenceFingerprint: fingerprint,
              operatorContextFingerprint: current?.operatorContextFingerprint,
              pairKey: input.pairKey
            }
          }
        }
      }
    }

    // ── 9. PERSIST ────────────────────────────────────────────────────
    project.updatedAt = Date.now()
    saveProject(project)

    db.run('RELEASE approve_pair')
    scheduleFlush()
    console.log(
      `[pair-approve] pair=${input.pairKey} mode=${input.mode} evidence=${current?.source}/${fingerprint}` +
        (manualPromptPreserved ? ' (manual prompt preserved)' : '')
    )
    return {
      ok: true,
      evidenceSource: current?.source ?? 'unknown',
      evidenceFingerprint: fingerprint,
      manualPromptPreserved
    }
  } catch (err) {
    try {
      db.run('ROLLBACK TO approve_pair')
      db.run('RELEASE approve_pair')
    } catch (rollbackErr) {
      console.error('[pair-approve] rollback could not run', rollbackErr)
    }
    console.error('[pair-approve] failed', err)
    return { ok: false, reason: err instanceof Error ? err.message : 'The approval failed.' }
  }
}
