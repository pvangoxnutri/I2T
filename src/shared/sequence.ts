import { transitionKey } from './types'
import { pairKeysFor } from './editorSelection'

/**
 * THE SEQUENCE IS THE VIDEO.
 *
 * ── THE ANALYZER DOES NOT GET A VOTE ─────────────────────────────────
 *
 * Property Analysis works out how the rooms relate. It does NOT decide
 * what order the video plays in — that is the operator's editorial
 * judgement about how to walk a buyer through a home, and no amount of
 * spatial understanding replaces it. Analysis supplies context for the
 * transitions BETWEEN consecutive images; the images' order is an input to
 * it, never an output of it.
 *
 * So there is deliberately no `suggestOrder`, no `sortByRoom`, and nothing
 * anywhere that writes `project.images` from an analysis result.
 *
 * This module is the arithmetic behind reordering, extracted from the
 * timeline component so the awkward part — what a drop position means —
 * can be asserted rather than eyeballed.
 */

/**
 * Where an item actually lands, given the slot it was dropped ON.
 *
 * ── THE OFF-BY-ONE THAT MATTERS ──────────────────────────────────────
 *
 * Drop slots are the GAPS between items: slot 0 is before the first image,
 * slot n is after the last. Removing the dragged item first shifts every
 * slot after it down by one, so a rightward move must be decremented or it
 * overshoots by one position every time.
 *
 * Written out here because it is exactly the kind of expression that looks
 * obviously right in either form.
 */
export function dropTargetIndex(fromIndex: number, dropSlot: number): number {
  return dropSlot > fromIndex ? dropSlot - 1 : dropSlot
}

/** Move one item. Pure — the caller persists. */
export function moveInSequence<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex) return items
  if (fromIndex < 0 || fromIndex >= items.length) return items
  if (toIndex < 0 || toIndex >= items.length) return items
  const next = [...items]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  return next
}

/** True when a reorder produced a genuine permutation and lost nothing. */
export function isValidReorder<T>(before: T[], after: T[]): boolean {
  if (before.length !== after.length) return false
  const seen = new Set(after)
  // A duplicated entry shows up as a Set smaller than the array, which is
  // the failure mode a naive splice-twice bug produces.
  if (seen.size !== after.length) return false
  return before.every((item) => seen.has(item))
}

export interface PairDelta {
  /** Pairs that exist both before and after — their prompts must survive. */
  kept: string[]
  /** Pairs the reorder created. These have no settings yet. */
  created: string[]
  /** Pairs the reorder destroyed. */
  removed: string[]
}

/**
 * What a reorder does to the transition pairs.
 *
 * Prompts, clips and provenance are keyed by image PAIR, not by position.
 * That is what makes reordering safe: moving image 4 to the front does not
 * touch the 2→3 transition at all, because 2→3 is still 2→3. Only the
 * pairs that genuinely changed neighbours are affected, and this reports
 * exactly which those are.
 */
export function pairDelta(beforeIds: string[], afterIds: string[]): PairDelta {
  const before = pairKeysFor(beforeIds)
  const after = pairKeysFor(afterIds)
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  return {
    kept: after.filter((k) => beforeSet.has(k)),
    created: after.filter((k) => !beforeSet.has(k)),
    removed: before.filter((k) => !afterSet.has(k))
  }
}

/**
 * The pair key at one position in the sequence, or null past the end.
 * Small, but it is written out in four different components otherwise.
 */
export function pairKeyAt(imageIds: string[], index: number): string | null {
  if (index < 0 || index >= imageIds.length - 1) return null
  return transitionKey(imageIds[index], imageIds[index + 1])
}

/**
 * Which slot of a scrolling track needs to come into view.
 *
 * Returned as a decision rather than performed, because `scrollIntoView`
 * cannot be asserted and the interesting part — "is it already visible?" —
 * is arithmetic. Keyboard navigation must not yank the track around when
 * the target is already on screen.
 */
export function scrollIntoViewOffset(
  item: { left: number; width: number },
  view: { scrollLeft: number; width: number },
  margin = 24
): number | null {
  const leftEdge = item.left - margin
  const rightEdge = item.left + item.width + margin
  if (leftEdge < view.scrollLeft) return Math.max(0, leftEdge)
  if (rightEdge > view.scrollLeft + view.width) return Math.max(0, rightEdge - view.width)
  return null
}
