import { defaultTransitionSettings, transitionKey, type Project } from './types'

/**
 * WHAT ACCEPTING A FEED PROPOSAL PRODUCES.
 *
 * ── WHY THIS IS ONE FUNCTION, NOT A LOOP OF STORE CALLS ──────────────
 *
 * Accepting used to be a sequence of per-image store calls in the
 * renderer: `removeFromFeed` for every current image, then `addToFeed`
 * for every proposed one. That arrived at the right sequence in the
 * ordinary case, but it is the wrong shape for the decision:
 *
 *  - it is 2N+M separately debounced writes for ONE choice, so there is
 *    no moment at which the change either happened or did not;
 *  - it cannot be awaited, so the dialog closed and told the operator it
 *    had worked before anything reached disk, and a failed write had
 *    nowhere to be reported;
 *  - both calls carry a guard that ABORTS when the feed length does not
 *    move by exactly one — correct for a single drag, but it makes a
 *    duplicate id in either list silently drop out of the result.
 *
 * The result of accepting is a pure function of (project, proposal), so
 * it is written as one here: one value, assertable without a renderer,
 * and impossible to half-apply.
 *
 * ── WHAT IS PRESERVED ────────────────────────────────────────────────
 *
 * Transition rows are MERGED, never replaced. A generated clip, its
 * status and its prompt survive both a mode change and a pair being
 * stranded by the new order. Accepting an ORDERING must never discard
 * generation work that was already paid for.
 */
export function applyProposalToProject(
  project: Project,
  sequence: string[],
  modes: Record<string, 'ai' | 'cut'>,
  defaultDurationSec: number
): Project {
  // A proposal naming an image that is no longer in the library is
  // rejected WHOLE. Half-applying it would leave a feed nobody chose.
  const known = new Set(project.images.map((i) => i.id))
  const unknown = sequence.filter((id) => !known.has(id))
  if (unknown.length > 0) {
    throw new Error(
      `Proposal references ${unknown.length} image(s) that are no longer in the library`
    )
  }

  const transitions = { ...project.transitions }

  // Modes for the pairs the new sequence actually creates.
  const nextPairKeys = new Set<string>()
  for (let i = 0; i < sequence.length - 1; i++) {
    const key = transitionKey(sequence[i], sequence[i + 1])
    nextPairKeys.add(key)
    const mode = modes[key]
    if (!mode) continue
    const existing = transitions[key] ?? defaultTransitionSettings(defaultDurationSec)
    // The ANALYZER chose this, not the operator. It therefore needs the
    // accepted spatial map behind it before it can be generated.
    transitions[key] = { ...existing, mode, modeProvenance: 'analysis' }
  }

  // A pair that is no longer adjacent loses its stored MODE, because that
  // decision described an adjacency that no longer exists. Everything else
  // on the row — clip, status, prompt — is left exactly as it was.
  for (const [key, settings] of Object.entries(transitions)) {
    if (nextPairKeys.has(key)) continue
    if (settings.mode && settings.mode !== 'auto') {
      transitions[key] = { ...settings, mode: 'auto' }
    }
  }

  return {
    ...project,
    feedSequence: [...sequence],
    transitions,
    updatedAt: Date.now()
  }
}
