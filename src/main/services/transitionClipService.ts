import { listProjects, saveProject } from '../db/projectsRepo'
import {
  getAllProjectGenerations,
  archivePreviousGenerations,
  setActiveGeneration
} from '../db/generationCatalogueRepo'
import { broadcastProjectUpdated } from '../events'
import { transitionKey } from '../../shared/types'

/**
 * WHICH CLIP IS CURRENTLY IN THE VIDEO.
 *
 * ── ONE ACTIVE, MANY GENERATED ───────────────────────────────────────
 *
 * A transition pair can have been generated any number of times. Exactly
 * one of those generations is ACTIVE — the clip the timeline plays and
 * the export writes — and the rest are history. History is append-only:
 * it records money that was really spent and output that really exists,
 * so nothing here ever deletes a generation row or a clip file.
 *
 * The two facts live in different places and both must move together:
 *
 *   project.transitions[pair].clip   what the video uses
 *   transition_generations.active    which generation that is
 *
 * Letting those drift is how a timeline ends up playing a clip the
 * catalogue says is archived. Every function here writes both.
 */

/**
 * Detach the active clip from a transition WITHOUT destroying anything.
 *
 * The pair stays in the feed, its mode and prompt are untouched, the
 * generation row remains in the catalogue and the file stays on disk —
 * which is what makes this reversible by re-attaching. The transition
 * simply stops having a clip.
 */
export function clearActiveClip(
  projectId: string,
  pairKey: string
): { ok: true } | { ok: false; reason: string } {
  const project = listProjects().find((p) => p.id === projectId)
  if (!project) return { ok: false, reason: 'Project no longer exists.' }

  const transition = project.transitions[pairKey]
  if (!transition?.clip) return { ok: false, reason: 'This transition has no active clip.' }

  const [fromImageId, toImageId] = pairKey.split('->')
  // History keeps the row; only its ACTIVE flag is cleared, so the
  // catalogue still lists the generation and can re-attach it.
  archivePreviousGenerations(projectId, fromImageId, toImageId)

  saveProject({
    ...project,
    transitions: {
      ...project.transitions,
      [pairKey]: { ...transition, clip: null, status: 'not-generated' }
    },
    updatedAt: Date.now()
  })
  broadcastProjectUpdated(projectId)
  return { ok: true }
}

/**
 * Make an already-generated clip the active one for its pair.
 *
 * ── NO FILE COPY, NO PROVIDER REQUEST, NO NEW SPEND ──────────────────
 *
 * This is pure bookkeeping over work that was already paid for. It is
 * the same action whether it is reached from a catalogue button or a
 * drag, which is why it lives here rather than in either UI.
 *
 * COMPATIBILITY IS CHECKED AGAINST THE GENERATION'S OWN PAIR, not
 * against whatever the operator currently has selected. Attaching a clip
 * of the kitchen to a bedroom transition would put footage of the wrong
 * room in the video, and the ids are right there to prevent it.
 */
export function attachGenerationToTransition(
  projectId: string,
  generationId: string
): { ok: true; pairKey: string } | { ok: false; reason: string } {
  const project = listProjects().find((p) => p.id === projectId)
  if (!project) return { ok: false, reason: 'Project no longer exists.' }

  const generation = getAllProjectGenerations(projectId).find((g) => g.id === generationId)
  if (!generation) {
    return { ok: false, reason: 'That generation is not part of this project.' }
  }
  if (!generation.clip) {
    return { ok: false, reason: 'That generation produced no clip to attach.' }
  }

  const pairKey = transitionKey(generation.fromImageId, generation.toImageId)
  const transition = project.transitions[pairKey]
  if (!transition) {
    return {
      ok: false,
      reason: 'The images this clip was generated for are no longer a transition in this project.'
    }
  }

  // Exactly one active generation per pair.
  archivePreviousGenerations(projectId, generation.fromImageId, generation.toImageId)
  setActiveGeneration(projectId, generationId)

  saveProject({
    ...project,
    transitions: {
      ...project.transitions,
      [pairKey]: { ...transition, clip: generation.clip, status: 'completed' }
    },
    updatedAt: Date.now()
  })
  broadcastProjectUpdated(projectId)
  return { ok: true, pairKey }
}
