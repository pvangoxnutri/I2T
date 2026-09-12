import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { listProjects, saveProject } from '../db/projectsRepo'
import { readAnalysis } from '../db/analysisRepo'
import { listOverrides } from '../db/overrideRepo'
import { savePairAnalysis, readPairAnalysis, setPairAnalysisState } from '../db/pairAnalysisRepo'
import { imagePath } from '../files'
import { applyImageOverrides } from '../../shared/imageFacts'
import { getFeedSequenceIds } from '../../shared/feedSequence'
import { evaluateTransitionSafety } from '../../shared/transitionSafety'
import { evidenceFingerprintOf } from '../../shared/promptPlanner'
import { resolvePairSpatialEvidence } from '../../shared/pairEvidence'
import { DEFAULT_TRANSITION_PROMPT } from '../../shared/prompts'
import { finalizeTransitionPrompt } from './promptFinalizer'
import type { PairAnalysisRecord, PairEvidenceRecord } from '../../shared/pairAnalysis'
import type { PropertyAnalysis } from '../../shared/propertyAnalysis'
import type { MissingContextItem } from '../../shared/operatorContext'
import {
  GeminiPairAnalyzer,
  type PairAnalysisResult,
  type PairImage
} from '../analysis/providers/gemini/GeminiPairAnalyzer'

/**
 * RE-ANALYSE ONE TRANSITION.
 *
 * ── WHAT IT MAY AND MAY NOT TOUCH ────────────────────────────────────
 *
 * It writes exactly one row, for one pairKey. It does not touch the feed
 * order, the other transitions, or the accepted PropertyAnalysis. A
 * two-image answer is not a property map, and letting one become one
 * would rewrite room membership for photographs it never examined.
 *
 * ── THE MODEL SUPPLIES EVIDENCE, NOT A VERDICT ───────────────────────
 *
 * The analyzer returns what it can see. AI / CUT / MISSING CONTEXT is
 * then decided by `evaluateTransitionSafety` — the same gate the feed
 * analysis, the planner and generation preflight use. A model's opinion
 * about safety would be a second evaluator, which is the exact class of
 * bug this codebase has spent three passes removing.
 */

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
}

function loadImage(projectId: string, image: { id: string; fileName: string; storedName: string }): PairImage | null {
  const path = imagePath(projectId, image.storedName)
  if (!path) return null
  try {
    return {
      imageId: image.id,
      label: image.fileName,
      base64: readFileSync(path).toString('base64'),
      mimeType: MIME[extname(image.storedName).toLowerCase()] ?? 'image/jpeg'
    }
  } catch {
    return null
  }
}

/** Cheap, stable identifiers for "has the world moved". */
export function fingerprints(projectId: string): {
  feedFingerprint: string
  libraryFingerprint: string
} {
  const project = listProjects().find((p) => p.id === projectId)
  if (!project) return { feedFingerprint: '', libraryFingerprint: '' }
  return {
    feedFingerprint: getFeedSequenceIds(project).join('|'),
    libraryFingerprint: project.images.map((i) => i.id).join('|')
  }
}

/**
 * Turn pair evidence into the smallest PropertyAnalysis that describes
 * it, so the CANONICAL evaluator can judge it unchanged.
 *
 * Deliberately minimal: two images, one or two rooms, and only what the
 * analyzer actually reported. Nothing is inferred to make the shape fit.
 */
export function evidenceAsAnalysis(
  projectId: string,
  fromImageId: string,
  toImageId: string,
  evidence: PairEvidenceRecord
): PropertyAnalysis {
  const sameRoom = evidence.relation === 'same-room'
  const roomA = { id: 'pair-room-a', label: evidence.roomLabel ?? 'Room', imageIds: [fromImageId] as string[], landmarks: evidence.sharedLandmarks, confidence: 'confirmed' as const }
  const roomB = sameRoom
    ? null
    : { id: 'pair-room-b', label: 'Adjacent space', imageIds: [toImageId], landmarks: [] as string[], confidence: 'confirmed' as const }
  if (sameRoom) roomA.imageIds = [fromImageId, toImageId]

  return {
    projectId,
    version: 1,
    source: 'provider',
    updatedAt: Date.now(),
    state: 'accepted',
    rooms: roomB ? [roomA, roomB] : [roomA],
    images: [
      {
        imageId: fromImageId,
        roomId: roomA.id,
        orientation: 'into-room',
        landmarks: evidence.sharedLandmarks,
        openings: evidence.openings,
        reflectiveSurfaces: evidence.reflectiveSurfaces,
        // The analyzer was asked what the two frames share; saying so is
        // what lets the same-room rule find an anchor.
        overlapWith: [toImageId]
      },
      {
        imageId: toImageId,
        roomId: roomB ? roomB.id : roomA.id,
        orientation: 'into-room',
        landmarks: evidence.sharedLandmarks,
        openings: [],
        overlapWith: [fromImageId]
      }
    ],
    edges: roomB
      ? [
          {
            id: 'pair-edge',
            fromRoomId: roomA.id,
            toRoomId: roomB.id,
            // Only ever `probable` here: a two-image look cannot confirm
            // an adjacency, and claiming it could is how a camera ends up
            // travelling through a wall.
            confidence: 'probable',
            supportingImageIds: [fromImageId, toImageId]
          }
        ]
      : [],
    transitionHints: []
  } as PropertyAnalysis
}

export interface PairAnalysisOutcome {
  ok: boolean
  reason?: string
  record?: PairAnalysisRecord
}

/**
 * Run the analysis and persist it as a DRAFT.
 *
 * Never accepted automatically: the operator reviews one pair the same
 * way they review a whole feed, because the money is spent either way
 * and a silent apply is how wrong evidence becomes invisible.
 */
export async function analysePair(input: {
  projectId: string
  pairKey: string
  apiKey: string
  model: string
  /** Injected by tests so the real parser and persistence run unpaid. */
  fetchImpl?: Parameters<typeof GeminiPairAnalyzer.prototype.analyse> extends never
    ? never
    : ConstructorParameters<typeof GeminiPairAnalyzer>[0]['fetchImpl']
}): Promise<PairAnalysisOutcome> {
  const project = listProjects().find((p) => p.id === input.projectId)
  if (!project) return { ok: false, reason: 'Project not found' }

  const [fromImageId, toImageId] = input.pairKey.split('->') as [string, string]
  const from = project.images.find((i) => i.id === fromImageId)
  const to = project.images.find((i) => i.id === toImageId)
  if (!from || !to) return { ok: false, reason: 'This pair is no longer part of the project.' }

  const feedIds = getFeedSequenceIds(project)
  const adjacent = feedIds.some((id, i) => id === fromImageId && feedIds[i + 1] === toImageId)
  if (!adjacent) {
    return {
      ok: false,
      reason: 'These two images are no longer next to each other in the Transition Feed.'
    }
  }

  const startImage = loadImage(project.id, from)
  const endImage = loadImage(project.id, to)
  if (!startImage || !endImage) return { ok: false, reason: 'The pair images could not be read.' }

  // EVERY other photograph, as context only. The instruction says four
  // times that they are not part of the transition.
  const supporting = project.images
    .filter((i) => i.id !== fromImageId && i.id !== toImageId)
    .map((i) => loadImage(project.id, i))
    .filter((i): i is PairImage => i !== null)

  const analyzer = new GeminiPairAnalyzer({
    apiKey: input.apiKey,
    model: input.model,
    fetchImpl: input.fetchImpl
  })
  console.log(`[pair-analyse] request pair=${input.pairKey} supporting=${supporting.length}`)
  const call = await analyzer.analyse(startImage, endImage, supporting)
  if (!call.ok) {
    console.error('[pair-analyse] failed', call.reason)
    return { ok: false, reason: call.reason }
  }

  const record = decidePair(project.id, input.pairKey, call.result, input.model)
  savePairAnalysis(record)
  console.log(`[pair-analyse] stored pair=${input.pairKey} decision=${record.decision}`)
  return { ok: true, record }
}

/**
 * THE CANONICAL GATE, APPLIED TO PAIR EVIDENCE.
 *
 * Exported so tests can drive it with mocked analyzer output and no
 * transport at all.
 */
export function decidePair(
  projectId: string,
  pairKey: string,
  result: PairAnalysisResult,
  model: string | null
): PairAnalysisRecord {
  const [fromImageId, toImageId] = pairKey.split('->') as [string, string]
  const synthetic = evidenceAsAnalysis(projectId, fromImageId, toImageId, result.evidence)
  const verdict = evaluateTransitionSafety(synthetic, fromImageId, toImageId)

  // AN AFFIRMATIVE CONFLICT OUTRANKS EVERYTHING.
  //
  // The evaluator judges the route and the reflections; it cannot know
  // that the analyzer SAW two layouts that cannot both be true. That is a
  // finding, not a gap, so it forces a cut and carries no question — a
  // question would invite an operator to type it away.
  const conflicts = result.evidence.geometryConflicts
  if (conflicts.length > 0) {
    return base(projectId, pairKey, result, model, {
      decision: 'cut',
      missingContext: [],
      reason: `Incompatible geometry: ${conflicts.join('; ')}`
    })
  }

  const missing: MissingContextItem[] =
    result.missingContext.length > 0 ? result.missingContext : verdict.missingContext
  return base(projectId, pairKey, result, model, {
    decision: verdict.decision === 'ai' && missing.length > 0 ? 'needs-context' : verdict.decision,
    missingContext: verdict.decision === 'ai' && missing.length === 0 ? [] : missing,
    reason: verdict.reason
  })
}

function base(
  projectId: string,
  pairKey: string,
  result: PairAnalysisResult,
  model: string | null,
  decided: {
    decision: PairAnalysisRecord['decision']
    missingContext: MissingContextItem[]
    reason: string
  }
): PairAnalysisRecord {
  const fp = fingerprints(projectId)
  const overrides = listOverrides(projectId)
  const accepted = applyImageOverrides(readAnalysis(projectId), overrides)
  return {
    projectId,
    pairKey,
    analyzedAt: Date.now(),
    analyzer: 'gemini',
    model,
    parentAnalysisUpdatedAt: accepted.updatedAt ?? null,
    feedFingerprint: fp.feedFingerprint,
    libraryFingerprint: fp.libraryFingerprint,
    evidence: result.evidence,
    decision: decided.decision,
    missingContext: decided.missingContext,
    motionInstruction: result.motionInstruction,
    // Wording is only ever a CANDIDATE here. Accepting is what may write
    // it, and never over a hand-edited prompt.
    promptCandidate: null,
    reason: decided.reason,
    state: 'draft'
  }
}

/**
 * Promote a reviewed pair analysis. Touches only this pair.
 *
 * ── THE WORDING RULE ─────────────────────────────────────────────────
 *
 * A prompt nobody has hand-edited is REBUILT from the newly accepted
 * evidence, and its provenance records that it came from this pair
 * analysis — so a later evidence change can be seen to have made it
 * stale.
 *
 * A prompt a human wrote is NOT touched. Their sentence is a judgement
 * about this transition and new evidence does not make it wrong. The
 * suggestion is stored beside it instead, and only an explicit "Replace
 * manual prompt" may swap them.
 */
export function acceptPairAnalysis(projectId: string, pairKey: string): PairAnalysisOutcome {
  const record = readPairAnalysis(projectId, pairKey)
  if (!record) return { ok: false, reason: 'No analysis exists for this transition.' }
  setPairAnalysisState(projectId, pairKey, 'accepted')

  const project = listProjects().find((x) => x.id === projectId)
  if (project) {
    const existing = project.transitions[pairKey]
    // Ask the resolver what actually governs this pair now — do not
    // assume it is this analysis. Operator context outranks it, and a
    // prompt stamped `individual-analysis` while the resolver reports
    // `operator` reads as outdated forever after.
    const parentAnalysis = applyImageOverrides(readAnalysis(projectId), listOverrides(projectId))
    const feedIds = getFeedSequenceIds(project)
    const resolved = resolvePairSpatialEvidence({
      pairKey,
      analysis: parentAnalysis,
      pairAnalysis: { ...record, state: 'accepted' },
      operatorContext: existing?.operatorContext,
      coveredByFeedAnalysis: false,
      fingerprints: {
        feedFingerprint: feedIds.join('|'),
        libraryFingerprint: project.images.map((i) => i.id).join('|')
      }
    })
    const fingerprint = evidenceFingerprintOf({
      source: resolved.source,
      analysisUpdatedAt: parentAnalysis.updatedAt ?? null,
      pairAnalyzedAt: resolved.individual?.analyzedAt ?? record.analyzedAt,
      operatorContextAt: resolved.operatorContext?.createdAt ?? null
    })
    // ── THE CANONICAL FINALIZER, NOT A SECOND ASSEMBLY ────────────────
    //
    // THE BUG THIS FIXES. This used to build the final prompt itself:
    //
    //   `${DEFAULT_TRANSITION_PROMPT}\n\n${motionBlock(record.motionInstruction)}`
    //
    // — the pre-sections concatenation, with the pair's movement LAST
    // (where the length fitter cuts), no budget applied, no reflection
    // escalation, no operator context, and Gemini's free prose used
    // verbatim as the movement text. Meanwhile prompt repair went
    // through `renderPrompt`. Same pair, two different prompts,
    // depending only on which button produced it — and the operator
    // could see it: one played as a continuous take, the other did not.
    //
    // Both paths call `finalizeTransitionPrompt` now. The individual
    // route still wins for this pair, because that is what Re-analyse is
    // for; it is passed as EVIDENCE and the canonical builder decides
    // how the prompt is assembled around it.
    const finalized = finalizeTransitionPrompt({
      project,
      pairKey,
      individualMotionInstruction: record.motionInstruction,
      operatorContext: resolved.operatorContext
    })
    if (!finalized.ok) {
      console.log(`[pair-analyse] prompt NOT rebuilt pair=${pairKey}: ${finalized.reason}`)
      return { ok: false, reason: finalized.reason }
    }
    const suggestion = finalized.prompt

    if (existing?.promptProvenance?.manuallyEdited) {
      // HELD, NEVER APPLIED. See the note above.
      project.transitions[pairKey] = {
        ...existing,
        promptSuggestion: {
          text: suggestion,
          createdAt: Date.now(),
          evidenceSource: 'individual-analysis',
          evidenceFingerprint: fingerprint
        }
      }
      console.log(`[pair-analyse] suggestion stored (manual prompt protected) pair=${pairKey}`)
    } else if (record.decision === 'ai') {
      project.transitions[pairKey] = {
        ...(existing ?? { prompt: '', durationSec: 5, status: 'not-generated', clip: null }),
        prompt: suggestion,
        promptProvenance: {
          basePrompt: DEFAULT_TRANSITION_PROMPT,
          // The route AFTER hygiene — what was actually sent, not what
          // the analyzer happened to word it as. Provenance that records
          // a different sentence from the one in the prompt is how a
          // divergence stays invisible.
          motionInstruction: finalized.motionInstruction,
          effectivePrompt: suggestion,
          basis: record.evidence.relation === 'same-room' ? 'same-room' : 'adjacent-room',
          rationale: record.reason ?? '',
          manuallyEdited: false,
          plannedAt: Date.now(),
          analysisUpdatedAt: record.parentAnalysisUpdatedAt,
          evidenceSource: resolved.source,
          evidenceFingerprint: fingerprint,
          pairKey
        },
        promptSuggestion: undefined
      }
      console.log(`[pair-analyse] prompt rebuilt pair=${pairKey}`)
    }
    project.updatedAt = Date.now()
    saveProject(project)
  }

  console.log(`[pair-analyse] accepted pair=${pairKey}`)
  return { ok: true, record: { ...record, state: 'accepted' } }
}

/**
 * Swap a held suggestion in for the operator's own wording.
 *
 * Only ever reached from an explicit action. The manual flag is cleared
 * because the wording is no longer theirs — keeping it set would protect
 * generated text from future rebuilds under a false claim.
 */
export function replaceManualPrompt(projectId: string, pairKey: string): PairAnalysisOutcome {
  const project = listProjects().find((x) => x.id === projectId)
  const existing = project?.transitions[pairKey]
  if (!project || !existing?.promptSuggestion) {
    return { ok: false, reason: 'There is no suggestion to apply.' }
  }
  const s = existing.promptSuggestion

  // ── REBUILT NOW, NOT REPLAYED FROM WHEN IT WAS HELD ────────────────
  //
  // A suggestion can sit in the row for as long as the operator leaves
  // their own wording in place, and the prompt contract can change while
  // it waits. Applying the stored string would install a prompt built
  // under whatever contract was current when the analysis ran — which is
  // precisely the class of staleness the repair exists to undo.
  //
  // So the held text is used only as the fallback. The normal path
  // finishes through the same canonical builder as everything else.
  const rebuilt = finalizeTransitionPrompt({
    project,
    pairKey,
    individualMotionInstruction: readPairAnalysis(projectId, pairKey)?.motionInstruction ?? null,
    operatorContext: existing.operatorContext ?? null
  })
  const prompt = rebuilt.ok ? rebuilt.prompt : s.text

  project.transitions[pairKey] = {
    ...existing,
    prompt,
    promptProvenance: {
      basePrompt: DEFAULT_TRANSITION_PROMPT,
      motionInstruction: rebuilt.ok ? rebuilt.motionInstruction : null,
      effectivePrompt: prompt,
      basis:
        rebuilt.ok && rebuilt.plan.relationType === 'ADJACENT_ROOM' ? 'adjacent-room' : 'same-room',
      rationale: 'Replaced the manual prompt with the analysis suggestion.',
      manuallyEdited: false,
      plannedAt: Date.now(),
      analysisUpdatedAt: null,
      evidenceSource: s.evidenceSource,
      evidenceFingerprint: s.evidenceFingerprint,
      pairKey
    },
    promptSuggestion: undefined
  }
  project.updatedAt = Date.now()
  saveProject(project)
  console.log(`[pair-analyse] manual prompt replaced pair=${pairKey}`)
  return { ok: true }
}

/** A unique id for a run, used only in logs. */
export const newRunId = (): string => randomUUID().slice(0, 8)
