import type { PropertyAnalysis } from './propertyAnalysis'

/**
 * HOW WELL WAS THIS PROPERTY ACTUALLY MAPPED?
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────
 *
 * An analysis that assigned almost nothing to a room still produced a
 * confident-looking feed proposal, and the editor then showed "No room"
 * on every thumbnail as though that were normal. Nothing anywhere said
 * "this mapping is too thin to trust" — so a weak analysis and a strong
 * one were presented identically, and the operator had no way to tell
 * which one they were about to spend money on.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────
 *
 * Not a score of how GOOD the property is, and not a claim about 3D
 * reconstruction. It counts what the analyzer actually returned and how
 * much of the library it managed to place. Coverage is a necessary
 * condition for trustworthy transitions, never a sufficient one — the
 * per-pair evidence gate still decides every AI/CUT on its own.
 */

export type AnalysisQualityLevel = 'good' | 'weak' | 'unusable'

export interface AnalysisQuality {
  imageCount: number
  /** Images the analyzer placed in a room. */
  assignedCount: number
  unassignedCount: number
  /** 0–1. The single most load-bearing number here. */
  assignedRatio: number
  withLandmarks: number
  withOpenings: number
  withOverlap: number
  roomCount: number
  /** Rooms seen from more than one viewpoint — the basis for same-room moves. */
  roomsWithMultipleViews: number
  edgeCount: number
  confirmedEdgeCount: number
  hintCount: number
  scoredCount: number
  level: AnalysisQualityLevel
  /** Plain sentences an operator can act on. Empty when the mapping is good. */
  problems: string[]
}

/**
 * @param imageIds every image that was submitted — the denominator. Taken
 *   from the project rather than from the analysis, because an analyzer
 *   that silently ignored half the library would otherwise score itself
 *   against only the half it answered about.
 */
export function assessAnalysisQuality(
  analysis: PropertyAnalysis | null,
  imageIds: string[]
): AnalysisQuality {
  const imageCount = imageIds.length
  const entries = (analysis?.images ?? []).filter((i) => imageIds.includes(i.imageId))
  const roomIds = new Set((analysis?.rooms ?? []).map((r) => r.id))

  // Assigned means placed in a room that actually exists. A roomId
  // pointing at nothing is not an assignment.
  const assigned = entries.filter((i) => i.roomId !== null && roomIds.has(i.roomId))
  const assignedCount = assigned.length
  const unassignedCount = Math.max(imageCount - assignedCount, 0)
  const assignedRatio = imageCount === 0 ? 0 : assignedCount / imageCount

  const viewsPerRoom = new Map<string, number>()
  for (const i of assigned) {
    viewsPerRoom.set(i.roomId!, (viewsPerRoom.get(i.roomId!) ?? 0) + 1)
  }

  const quality: Omit<AnalysisQuality, 'level' | 'problems'> = {
    imageCount,
    assignedCount,
    unassignedCount,
    assignedRatio,
    withLandmarks: entries.filter((i) => i.landmarks.length > 0).length,
    withOpenings: entries.filter((i) => i.openings.length > 0).length,
    withOverlap: entries.filter((i) => (i.overlapWith ?? []).length > 0).length,
    roomCount: analysis?.rooms.length ?? 0,
    roomsWithMultipleViews: [...viewsPerRoom.values()].filter((n) => n > 1).length,
    edgeCount: analysis?.edges.length ?? 0,
    confirmedEdgeCount: (analysis?.edges ?? []).filter((e) => e.confidence === 'confirmed').length,
    hintCount: analysis?.transitionHints?.length ?? 0,
    scoredCount: entries.filter((i) => typeof i.marketingImportance === 'number').length
  }

  const problems: string[] = []
  if (imageCount === 0) {
    return { ...quality, level: 'unusable', problems: ['No images were submitted for analysis.'] }
  }
  if (!analysis || quality.roomCount === 0) {
    return {
      ...quality,
      level: 'unusable',
      problems: ['The analyzer identified no rooms at all, so nothing can be placed in the property.']
    }
  }

  if (assignedRatio < 0.5) {
    problems.push(
      `${unassignedCount} of ${imageCount} images could not be assigned confidently to a room.`
    )
  }
  if (quality.withLandmarks < imageCount / 2) {
    problems.push(
      `Only ${quality.withLandmarks} of ${imageCount} images have recorded landmarks, so few pairs can be anchored to anything visible.`
    )
  }
  if (quality.roomsWithMultipleViews === 0) {
    problems.push(
      'No room was seen from more than one viewpoint, so no same-room camera move can be supported.'
    )
  }
  if (quality.withOverlap === 0 && quality.withLandmarks === 0) {
    problems.push('Insufficient overlap exists between the supplied views.')
  }

  // UNUSABLE is reserved for a mapping that cannot support any judgement:
  // almost nothing placed, or nothing to anchor on anywhere.
  const level: AnalysisQualityLevel =
    assignedRatio < 0.25 || quality.withLandmarks === 0
      ? 'unusable'
      : problems.length > 0
        ? 'weak'
        : 'good'

  return { ...quality, level, problems }
}

/** One sentence for a dialog header. Empty when the mapping is good. */
export function qualityHeadline(q: AnalysisQuality): string {
  if (q.level === 'good') return ''
  if (q.level === 'unusable') return 'The property could not be mapped reliably enough.'
  return 'The property was only partly mapped.'
}
