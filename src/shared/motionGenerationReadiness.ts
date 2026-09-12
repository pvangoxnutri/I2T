import type { MotionSegment } from './motionSegment'
import { motionSegmentLabel } from './motionSegment'
import type { MotionRunState } from './motionRunState'

/**
 * CAN THIS MOTION SEGMENT BE GENERATED, AND WITH WHICH MODEL?
 *
 * ── ONE EVALUATOR, LIKE EVERY OTHER GATE IN THE PRODUCT ──────────────
 *
 * The recurring bug in this codebase has been two places forming their
 * own opinion about the same question and drifting apart. So the answer
 * to "may this run, and what may it run on" is computed here, once, and
 * both the button's enabled state and the main process's preflight read
 * it. A disabled button whose reason disagrees with the refusal behind
 * it is the failure mode this shape exists to make impossible.
 *
 * ── WHY THIS CAN REFUSE FOR REASONS THAT ARE NOBODY'S FAULT ──────────
 *
 * A single-image run sends a START frame and no end frame. A model whose
 * verified contract requires `end_image_url` therefore cannot do it. The
 * honest response is to refuse: the alternative is passing the start
 * frame as the end frame too, which asks the model to travel from a
 * photograph to itself, and nothing about that is what the operator
 * bought. Faking an end frame is never on the table.
 *
 * When no registered model is capable, this refuses with that reason —
 * and, importantly, refuses BEFORE any confirmation is shown, so nobody
 * is offered a paid run the provider cannot perform.
 */

/** The minimum a model must expose for this evaluator to consider it. */
export interface MotionCapableModel {
  id: string
  displayName: string
  supportsStartFrameOnly: boolean
  confirmed: boolean
  durationsSec: number[]
}

export type MotionGenerationReadiness =
  | {
      ok: true
      /** Models the operator may choose between. Never empty when ok. */
      models: MotionCapableModel[]
      /** Durations the chosen models can all honour, for the selector. */
      durationsSec: number[]
      advisory?: string
    }
  | { ok: false; reason: string }

export function motionGenerationReadiness(
  segment: MotionSegment | null,
  registry: MotionCapableModel[],
  /**
   * WHAT IS ACTUALLY IN FLIGHT.
   *
   * ── WHY THIS IS A PARAMETER AND NOT A STATUS READ ──────────────────
   *
   * This used to refuse whenever `segment.status` was `queued` or
   * `generating`. That made the stored status a LOCK, and the lock
   * deadlocked the feature: `queueMotionGeneration` set the status to
   * `queued` before enqueuing, so the runner's own request build was
   * refused by the marker the queue had just written for it. The job
   * failed with "already running", the failure never cleared the
   * status, and the segment was stuck permanently.
   *
   * Running is now something a caller must PROVE with a live job — see
   * `motionRunState`. Omitted, this refuses nothing on those grounds,
   * because a status word is not evidence.
   */
  runState?: MotionRunState
): MotionGenerationReadiness {
  if (!segment) return { ok: false, reason: 'No motion clip selected.' }

  if (runState?.kind === 'running') {
    return {
      ok: false,
      reason: `${motionSegmentLabel(segment)} is already running. Wait for it to finish.`
    }
  }

  if (runState?.kind === 'recoverable') {
    return {
      ok: false,
      reason:
        `A paid fal.ai task already exists for ${motionSegmentLabel(segment)} ` +
        `(${runState.providerTaskId}). Resume it from the Queue rather than paying again.`
    }
  }

  if (!segment.prompt || segment.prompt.trim().length === 0) {
    return { ok: false, reason: 'This motion clip has no prompt.' }
  }

  // Only CONFIRMED models — the same bar the transition path uses. An
  // unconfirmed entry is a guess at a contract, and a guess is not
  // something to spend the operator's money discovering is wrong.
  const capable = registry.filter((m) => m.confirmed && m.supportsStartFrameOnly)

  if (capable.length === 0) {
    return {
      ok: false,
      reason:
        'No verified fal.ai model can generate from a single image yet — every registered model requires both a start and an end frame. Single-image motion becomes available as soon as a start-frame-only model is verified into the registry.'
    }
  }

  // ── EVERY LENGTH SOME CAPABLE MODEL OFFERS ──────────────────────────
  //
  // The UNION, not the intersection.
  //
  // This was the intersection, on the reasoning that the selector should
  // never show a length that becomes invalid when the model is switched.
  // That is a clamp which HIDES real capability: with O3's 3–15s enum
  // beside 2.6 Pro's 5|10, the intersection would have offered 5 and 10
  // and silently concealed eleven lengths O3 genuinely supports.
  //
  // The right answer is that the DURATION LIST FOLLOWS THE SELECTED
  // MODEL — which the confirmation does, from that model's own registry
  // entry. This union is the honest summary of what single-image motion
  // can do across the models available, and it is what the advisory is
  // measured against.
  const durationsSec = [...new Set(capable.flatMap((m) => m.durationsSec))].sort((a, b) => a - b)

  if (durationsSec.length === 0) {
    return {
      ok: false,
      reason: 'No available model publishes a clip length.'
    }
  }

  return {
    ok: true,
    // ── PROJECTED, NOT PASSED THROUGH ─────────────────────────────────
    //
    // Callers hand in whole registry entries, which carry a `buildBody`
    // FUNCTION. Returning those directly made this result impossible to
    // send over IPC — structured clone refuses functions — and the whole
    // readiness call failed at runtime with "An object could not be
    // cloned" while typechecking perfectly, because the entries do
    // satisfy the declared interface structurally.
    //
    // Rebuilding the plain shape here means nothing but data can ever
    // leave, whatever a caller passes in.
    models: capable.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      supportsStartFrameOnly: m.supportsStartFrameOnly,
      confirmed: m.confirmed,
      durationsSec: [...m.durationsSec]
    })),
    durationsSec,
    advisory: durationsSec.includes(segment.durationSec)
      ? undefined
      : `This clip is set to ${segment.durationSec}s, which no available model offers. Pick one of: ${durationsSec.join('s, ')}s.`
  }
}
