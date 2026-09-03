import type { PropertyAnalysis, RoomRecord } from './propertyAnalysis'
import type { ProjectImage } from './types'
import { evaluateTransitionSafety } from './transitionSafety'

/**
 * Which images belong in the marketing video, and in what order.
 *
 * ── THE PRODUCT INVARIANT THIS FUNCTION EXISTS UNDER ─────────────────
 *
 *   Transition safety determines HOW selected images are connected,
 *   never WHETHER a valuable image belongs in the video.
 *
 * Nothing in this function may look at transition feasibility. An image
 * that cannot be reached by a generated camera move is connected with a
 * CUT and stays in the film. Selection and connection are separate
 * decisions and are computed by separate functions on purpose.
 *
 * ── THE BUG THIS SHAPE PREVENTS ──────────────────────────────────────
 *
 * A real 37-image library proposed ZERO images. The cause was not
 * transition safety: selection was a chain of threshold gates over
 * `marketingImportance`, every one of them reading `?? 0`, and the field
 * was never populated because the Gemini response SCHEMA did not declare
 * it. Unscored therefore meant score 0, 0 failed every tier — hero ≥ 9,
 * primary ≥ 8, secondary ≥ 5, functional ≥ 4 — and the "safety fallback"
 * at the end required ≥ 5 as well. Nothing could get through.
 *
 * The schema gap is fixed, but the deeper fault was the algorithm having
 * no behaviour for "we were not told how good these are". It now has one:
 * missing scores fall back to STRUCTURAL selection — cover the property,
 * one strong frame per space — and the invariant at the bottom of this
 * function guarantees a non-empty result whenever usable images exist.
 *
 * ── STRATEGY ─────────────────────────────────────────────────────────
 *
 * Highlights first, redundancy trimmed. A hero standing alone between two
 * cuts is a good outcome, not a failure.
 */
export function proposeFeedOrder(
  images: ProjectImage[],
  analysis: PropertyAnalysis
): string[] {
  if (images.length === 0) return []
  if (images.length === 1) return [images[0].id]
  if (analysis.rooms.length === 0) return images.map((i) => i.id)

  // Did the analyzer actually score anything? If not, thresholds are
  // meaningless and structural selection is used instead. This is the
  // difference between "these are all worthless" and "we were not told".
  const anyScored =
    analysis.rooms.some((r) => typeof r.marketingImportance === 'number') ||
    analysis.images.some((i) => typeof i.marketingImportance === 'number')

  if (!anyScored) return structuralSelection(images, analysis)

  // Build room-to-images map and image metadata lookup
  const roomMap = new Map<string, ProjectImage[]>()
  const imageMetadata = new Map<string, { roomId: string | null; marketingScore: number; isHero: boolean }>()

  for (const imgAnalysis of analysis.images) {
    const img = images.find((i) => i.id === imgAnalysis.imageId)
    if (img) {
      imageMetadata.set(img.id, {
        roomId: imgAnalysis.roomId ?? null,
        marketingScore: imgAnalysis.marketingImportance ?? 0,
        isHero: imgAnalysis.isHero ?? false
      })
    }
  }

  for (const room of analysis.rooms) {
    const roomImages: ProjectImage[] = []
    for (const imageId of room.imageIds) {
      const img = images.find((i) => i.id === imageId)
      if (img) roomImages.push(img)
    }
    if (roomImages.length > 0) {
      roomMap.set(room.id, roomImages)
    }
  }

  // Categorize rooms by marketing importance
  const heroRooms = analysis.rooms.filter((r) => (r.marketingImportance ?? 0) >= 9)
  const primaryRooms = analysis.rooms.filter((r) => {
    const score = r.marketingImportance ?? 0
    return score >= 8 && score < 9
  })
  const secondaryRooms = analysis.rooms.filter((r) => {
    const score = r.marketingImportance ?? 0
    return score >= 5 && score < 8
  })
  const functionalRooms = analysis.rooms.filter((r) => (r.marketingImportance ?? 0) < 5)

  // Helper: filter out weak/redundant images from a room
  // Keep only the BEST image per room, plus one secondary if marketing score justifies it
  const filterStrongImages = (roomImages: ProjectImage[], room: RoomRecord): ProjectImage[] => {
    const sorted = roomImages.sort((a, b) => {
      const scoreA = imageMetadata.get(a.id)?.marketingScore ?? 0
      const scoreB = imageMetadata.get(b.id)?.marketingScore ?? 0
      const heroA = imageMetadata.get(a.id)?.isHero ?? false
      const heroB = imageMetadata.get(b.id)?.isHero ?? false
      // Hero first, then by marketing score
      if (heroA !== heroB) return heroA ? -1 : 1
      return scoreB - scoreA
    })

    // For hero rooms: take all strong images (score 8+)
    if ((room.marketingImportance ?? 0) >= 9) {
      return sorted.filter((img) => (imageMetadata.get(img.id)?.marketingScore ?? 0) >= 8)
    }

    // For primary rooms: take best image + one secondary if strong
    if ((room.marketingImportance ?? 0) >= 8) {
      const result: ProjectImage[] = []
      if (sorted.length > 0) result.push(sorted[0])
      if (sorted.length > 1 && (imageMetadata.get(sorted[1].id)?.marketingScore ?? 0) >= 7) {
        result.push(sorted[1])
      }
      return result
    }

    // For secondary/functional: only the best, high quality only
    return sorted.length > 0 ? [sorted[0]] : []
  }

  // Propose images in priority order
  const proposed: string[] = []
  const visitedImages = new Set<string>()

  // Helper: add filtered images from a room
  const addFromRoom = (room: RoomRecord): void => {
    const roomImages = roomMap.get(room.id) ?? []
    const strong = filterStrongImages(roomImages, room)
    for (const img of strong) {
      if (!visitedImages.has(img.id)) {
        proposed.push(img.id)
        visitedImages.add(img.id)
      }
    }
  }

  // 1. Hero images/rooms first (pool, spectacular view, etc.)
  for (const room of heroRooms) {
    addFromRoom(room)
  }

  // 2. Primary selling spaces (living, dining, kitchen, outdoor)
  for (const room of primaryRooms) {
    addFromRoom(room)
  }

  // 3. Secondary spaces (bedrooms, baths, bonus rooms) - but only strong ones
  for (const room of secondaryRooms) {
    addFromRoom(room)
  }

  // 4. Functional/utility spaces - very selective, only if truly valuable
  const valuableFunctional = functionalRooms.filter((r) => (r.marketingImportance ?? 0) >= 4)
  for (const room of valuableFunctional) {
    addFromRoom(room)
  }

  // 5. Add any previously unassigned HIGH-VALUE images (safety fallback)
  // But skip low-value unassigned images entirely
  for (const img of images) {
    if (!visitedImages.has(img.id)) {
      const meta = imageMetadata.get(img.id)
      if (meta && meta.marketingScore >= 5) {
        proposed.push(img.id)
        visitedImages.add(img.id)
      }
    }
  }

  // ADAPTIVE LENGTH: No hard cap, but trim if feed has too much low-value tail
  // Principle: keep all strong images, trim redundant/weak material
  // Soft guideline: if > 30 images, filter out scores below 4
  let result = proposed
  if (proposed.length > 30) {
    const withScores = proposed.map((id) => ({
      id,
      score: imageMetadata.get(id)?.marketingScore ?? 0
    }))
    withScores.sort((a, b) => b.score - a.score)
    // Keep all high/medium value (4+), trim low value (< 4)
    result = withScores.filter((x) => x.score >= 4).map((x) => x.id)
  }

  // ── THE INVARIANT ───────────────────────────────────────────────────
  //
  // Real images in, real feed out. Selection may trim hard, but it may
  // never conclude that a property with photographs has no video in it.
  // If every tier rejected everything — the exact 0-of-37 failure — fall
  // back to structural coverage rather than handing back nothing.
  if (result.length === 0) return structuralSelection(images, analysis)

  return result
}

/**
 * Selection with no usable scores: cover the property, avoid repeats.
 *
 * Deliberately simple, because it runs precisely when the analyzer's
 * judgement is unavailable and inventing a ranking would be pretending to
 * know something. One frame per recorded space, in the order the analyzer
 * listed them, then anything it never placed. The operator gets a
 * complete, obviously-editable starting point instead of an empty modal.
 */
function structuralSelection(images: ProjectImage[], analysis: PropertyAnalysis): string[] {
  const known = new Set(images.map((i) => i.id))
  const chosen: string[] = []
  const taken = new Set<string>()

  const heroes = analysis.images.filter((i) => i.isHero === true).map((i) => i.imageId)
  for (const id of heroes) {
    if (known.has(id) && !taken.has(id)) {
      chosen.push(id)
      taken.add(id)
    }
  }

  for (const room of analysis.rooms) {
    // The best available frame for this space is simply the first one the
    // analyzer associated with it — no ranking is being claimed.
    const first = room.imageIds.find((id) => known.has(id) && !taken.has(id))
    if (first) {
      chosen.push(first)
      taken.add(first)
    }
  }

  // Images the analyzer never assigned to a room are still photographs of
  // the property, and dropping them silently would repeat the original bug.
  for (const img of images) {
    if (!taken.has(img.id)) {
      chosen.push(img.id)
      taken.add(img.id)
    }
  }

  return chosen
}

/**
 * For each transition in the proposed order, recommend a mode based on analysis.
 *
 * STRICT SAFETY RULES:
 * - AI is ONLY recommended when visual evidence is strong (safe level)
 * - Uncertain or unsafe pairs → always CUT
 * - Same room requires clear overlap/shared landmarks
 * - Different rooms require visible opening AND recognizable destination
 *
 * Returns a map of pairKey -> recommended mode ('ai' or 'cut').
 */
export function proposeTransitionModes(
  analysis: PropertyAnalysis,
  imageIds: string[]
): Record<string, 'ai' | 'cut'> {
  const modes: Record<string, 'ai' | 'cut'> = {}

  for (let i = 0; i < imageIds.length - 1; i++) {
    const fromId = imageIds[i]
    const toId = imageIds[i + 1]
    const pairKey = `${fromId}->${toId}`

    // ── ONE GATE ─────────────────────────────────────────────────────
    //
    // The same-room and cross-room rules that used to live here are now
    // in `evaluateTransitionSafety`, because the canonical planner was
    // answering the identical question with different rules and the two
    // disagreed. A proposal that recommends AI for a pair the timeline
    // would then cut is worse than either answer on its own.
    const verdict = evaluateTransitionSafety(analysis, fromId, toId)

    // Gemini's hint is ADVISORY and may only ever RESTRICT. It can veto a
    // move the evidence supports; it can never authorise one the evidence
    // does not.
    const hint = analysis.transitionHints?.find(
      (h) => h.fromImageId === fromId && h.toImageId === toId
    )
    const hintVetoes = hint?.safetyLevel === 'unsafe' || hint?.safetyLevel === 'uncertain'

    modes[pairKey] = hintVetoes ? 'cut' : verdict.mode
    continue
  }

  return modes
}
