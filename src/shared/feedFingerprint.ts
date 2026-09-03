/**
 * Feed fingerprint — stable identifier for detecting when feed structure changes.
 *
 * Used to invalidate analysis results when feed is reordered/truncated.
 * Includes: image IDs in order + adjacent pair keys.
 *
 * Example: A→B→C feeds becomes A→C→B
 * Old fingerprint: "A|B|C" with pairs "A>B|B>C|C>D"
 * New fingerprint: "A|C|B" with pairs "A>C|C>B|B>D"
 * → Detected as different, transition analysis is STALE
 */

export interface FeedSnapshot {
  /** Fingerprint of ordered image IDs, e.g. "A|B|C|D" */
  imageIds: string
  /** Fingerprint of adjacent pairs, e.g. "A>B|B>C|C>D" */
  adjacentPairs: string
}

/**
 * Create a stable snapshot of current feed structure.
 * Includes image order + adjacent pair keys.
 */
export function getFeedSnapshot(feedImageIds: string[]): FeedSnapshot {
  const imageIds = feedImageIds.join('|')

  const adjacentPairs: string[] = []
  for (let i = 0; i < feedImageIds.length - 1; i++) {
    const fromId = feedImageIds[i]
    const toId = feedImageIds[i + 1]
    adjacentPairs.push(`${fromId}>${toId}`)
  }

  return {
    imageIds,
    adjacentPairs: adjacentPairs.join('|')
  }
}

/**
 * Check if feed structure has changed since a snapshot was taken.
 * Returns false if feed is identical; true if any structural change.
 */
export function isFeedSnapshotStale(
  currentFeedIds: string[],
  snapshot: FeedSnapshot | null | undefined
): boolean {
  if (!snapshot) return false // No baseline = not stale

  const current = getFeedSnapshot(currentFeedIds)
  return current.imageIds !== snapshot.imageIds || current.adjacentPairs !== snapshot.adjacentPairs
}

/**
 * Check if imported media library has changed since a snapshot.
 * Includes: added, removed, or reordered images.
 */
export function isMediaLibrarySnapshotStale(
  currentImageIds: string[],
  snapshot: { imageIds: string } | null | undefined
): boolean {
  if (!snapshot) return false

  const current = currentImageIds.join('|')
  return current !== snapshot.imageIds
}
