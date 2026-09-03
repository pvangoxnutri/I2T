import { transitionKey, type Project, type TransitionSettings } from './types'
import { pairKeysFor } from './editorSelection'
import { getEffectiveFeedSequence } from './feedSequence'

/**
 * GUARD: Detect if a feed mutation will break generated transitions.
 *
 * Before applying any feed change (reorder, delete, etc.), analyze whether
 * existing generated clips will become unused because their adjacent pair
 * no longer exists in the new feed order.
 *
 * Returns report of what will break. Caller decides whether to show a
 * confirmation dialog or proceed directly.
 */

export interface FeedMutationReport {
  /** Pairs that exist now but won't after the mutation. */
  brokenPairs: string[]
  /** Of those broken pairs, which have a generated clip that will go unused. */
  generatedClipsLosingUse: string[]
  /** True if caller should show a confirmation dialog. */
  requiresConfirmation: boolean
}

/**
 * Analyze a proposed feed mutation.
 *
 * @param project - current state
 * @param newFeedIds - proposed new feedSequence (image IDs in new order)
 * @returns report of what will break
 */
export function analyzeFeedMutation(
  project: Project,
  newFeedIds: string[]
): FeedMutationReport {
  // Current adjacent pairs.
  //
  // Read through the CANONICAL helper. This line used to re-implement the
  // legacy fallback as `feedSequence ?? images`, which is a second copy of
  // a rule that has exactly one correct form — and re-implementing it is
  // how an explicit empty feed once got mistaken for "no feed set" and the
  // whole sequence was silently rebuilt from the library.
  const currentPairs = pairKeysFor(getEffectiveFeedSequence(project))

  // Proposed adjacent pairs
  const proposedPairs = pairKeysFor(newFeedIds)

  // Which pairs disappear?
  const brokenPairs = currentPairs.filter((pk) => !proposedPairs.includes(pk))

  // Of those, which have a generated clip?
  const generatedClipsLosingUse = brokenPairs.filter((pk) => {
    const settings = project.transitions[pk]
    // Only flag if it has a clip AND that clip is generated (not 'manual').
    return settings?.clip && settings.clip.source !== 'manual'
  })

  return {
    brokenPairs,
    generatedClipsLosingUse,
    requiresConfirmation: generatedClipsLosingUse.length > 0
  }
}

/**
 * Human-readable description of broken pairs for the dialog.
 */
export function describeAffectedTransitions(
  report: FeedMutationReport,
  project: Project
): string[] {
  return report.generatedClipsLosingUse.map((pairKey) => {
    // Parse pair key to get image IDs
    const [fromId, toId] = pairKey.split('->') as [string, string]
    const fromImg = project.images.find((i) => i.id === fromId)
    const toImg = project.images.find((i) => i.id === toId)

    if (!fromImg || !toImg) return pairKey

    // Find positions in original library for user context
    const fromIdx = project.images.indexOf(fromImg)
    const toIdx = project.images.indexOf(toImg)

    return `IMAGE_${String(fromIdx + 1).padStart(3, '0')} → IMAGE_${String(toIdx + 1).padStart(3, '0')}`
  })
}
