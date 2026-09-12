import type { GenerationRecord, TransitionClip, TransitionSettings } from './types'

/**
 * WHAT THE FEED SAYS ABOUT ONE TRANSITION.
 *
 * ── THE REGRESSION THIS EXISTS FOR ───────────────────────────────────
 *
 * The feed derived its word from `transition.status`, and the generation
 * path wrote `failed` for any live run that ended without an attached
 * clip. A generation that succeeded at the provider and downloaded a
 * playable file could therefore appear as FAILED, identical to a fal
 * submit rejection.
 *
 * ── THREE FACTS, NOT ONE ENUM ────────────────────────────────────────
 *
 * `transition.status` records what the GENERATION did. It cannot also
 * record whether a file reached the disk, so the view state is derived
 * from the stored row, the active clip and the newest generation, and a
 * failure word is reserved for things that really failed.
 */

export type FeedTransitionState =
  /** No generation has ever produced anything for this pair. */
  | 'missing'
  | 'queued'
  | 'generating'
  /** A clip is attached and in use. */
  | 'ready'
  /** The provider succeeded but no file reached the disk. */
  | 'download-pending'
  /** The provider itself failed, or the work was cancelled. */
  | 'failed'

export interface FeedTransitionView {
  state: FeedTransitionState
  /** The chip text. Never "Failed" for something that did not fail. */
  word: string
  /** Drives colour only; never the sole carrier of meaning. */
  tone: 'ready' | 'busy' | 'pending' | 'failed' | 'missing'
  detail: string
  /** A clip that can be played. */
  playableClip: TransitionClip | null
  /** A second, quieter line under the primary word. */
  secondaryWord: string | null
}

/**
 * @param transition   the stored row; absent means never configured
 * @param latest       the newest generation for this pair, if any
 * @param downloadPending  provider succeeded and no file arrived
 */
export function feedTransitionState(
  transition: TransitionSettings | undefined,
  latest: Pick<GenerationRecord, 'clip' | 'active'> | null,
  downloadPending = false
): FeedTransitionView {
  const status = transition?.status ?? 'not-generated'
  const activeClip = transition?.clip ?? null

  // ── IN FLIGHT ───────────────────────────────────────────────────────
  if (status === 'queued' || status === 'generating') {
    return {
      state: status === 'queued' ? 'queued' : 'generating',
      word: status === 'queued' ? 'Queued' : 'Generating',
      tone: 'busy',
      detail:
        status === 'queued'
          ? 'Waiting for a free generation slot.'
          : 'The provider is working on this transition.',
      playableClip: activeClip,
      secondaryWord: null
    }
  }

  // ── AN ACTIVE CLIP IS FINISHED WORK ────────────────────────────────
  if (activeClip) {
    return {
      state: 'ready',
      word: 'Ready',
      tone: 'ready',
      detail: 'A generated clip is attached.',
      playableClip: activeClip,
      secondaryWord: null
    }
  }

  // ── PROVIDER FINISHED, FILE DID NOT ARRIVE ──────────────────────────
  if (downloadPending) {
    return {
      state: 'download-pending',
      word: 'Download pending',
      tone: 'pending',
      detail: 'The provider finished and was paid. The file has not reached this machine.',
      playableClip: null,
      secondaryWord: null
    }
  }

  // ── A REAL FAILURE ──────────────────────────────────────────────────
  //
  // Reached only with no clip anywhere, which is what  was
  // always supposed to mean.
  if (status === 'failed') {
    return {
      state: 'failed',
      word: 'Failed',
      tone: 'failed',
      detail: 'The generation did not produce a clip.',
      playableClip: null,
      secondaryWord: null
    }
  }

  if (status === 'completed') {
    return {
      state: 'ready',
      word: 'Ready',
      tone: 'ready',
      detail: 'A generated clip is attached.',
      playableClip: activeClip,
      secondaryWord: null
    }
  }

  return {
    state: 'missing',
    word: 'Missing',
    tone: 'missing',
    detail: 'No clip has been generated for this transition.',
    playableClip: null,
    secondaryWord: null
  }
}

