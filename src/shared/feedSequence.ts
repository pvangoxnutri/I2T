import type { Project, ProjectImage } from './types'

/**
 * LEGACY SEMANTICS:
 * - undefined = old project, no feed_sequence_json in DB → treat as "all images"
 * - [] = explicit empty feed → stay empty
 * - [ids...] = use exact order
 *
 * This is the SINGLE SOURCE OF TRUTH for legacy fallback behavior.
 * Used by mutations and readers to ensure consistency.
 */
export function getEffectiveFeedSequence(project: Project): string[] {
  if (project.feedSequence === undefined) {
    // Backward compatibility: legacy project with no stored feed
    // Treat as if feed = all images in their stored order
    return project.images.map((img) => img.id)
  }
  // Explicit feed (empty or with IDs): use exactly what was stored
  return project.feedSequence
}

/**
 * Get the ordered images that form the video sequence (Transition Feed).
 *
 * For backward compatibility, if feedSequence is undefined, returns all images
 * in their stored order. Otherwise returns only the images in feed order.
 */
export function getFeedImages(project: Project): ProjectImage[] {
  const feedIds = getEffectiveFeedSequence(project)
  return feedIds
    .map((id) => project.images.find((img) => img.id === id))
    .filter((img): img is ProjectImage => img !== undefined)
}

/**
 * Get image IDs in the active feed sequence.
 */
export function getFeedSequenceIds(project: Project): string[] {
  return getEffectiveFeedSequence(project)
}
