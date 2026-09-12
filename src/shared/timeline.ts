import type { AssemblyPlan, AssemblySegment } from './assemblyPlan'

/**
 * THE FINAL EDIT.
 *
 * ── WHAT THE AUDIT FOUND, AND WHY THIS SHAPE FOLLOWS FROM IT ─────────
 *
 * The exporter already works in exactly two concepts, and this model is
 * built to match them rather than to fight them:
 *
 *   1. `assemble()` takes an ORDERED LIST OF SEGMENTS, each of which is
 *      either a video file or a held still, and it already applies a
 *      per-segment `trim=start=…:end=…` before joining. Source offsets
 *      are therefore not a new mechanism — they are the mechanism the
 *      seam logic already uses, given a second reason to exist.
 *
 *   2. A BOUNDARY carries a seam in seconds. Zero is a hard cut and
 *      concatenates; a positive value is an xfade, which OVERLAPS its
 *      two neighbours and so consumes real time.
 *
 * That second fact settles the question §12 asks. A CUT occupies no
 * time and is not a thing on the timeline: it is simply two clips
 * meeting, and giving it a block would invent a frame that does not
 * exist. A CROSSFADE does occupy time, but it belongs to the JOINT
 * rather than to either side — so it is stored on the left item as
 * `seamAfterSec`, and the timeline's total duration subtracts it.
 *
 * ── NON-DESTRUCTIVE, LITERALLY ───────────────────────────────────────
 *
 * A split creates two items pointing at the SAME file with different
 * offset ranges. No video is ever written, copied or cut on disk. Delete
 * removes an item from this list and nothing else: the generation, its
 * catalogue row, its file and the feed are all untouched.
 *
 * ── FEED IS UPSTREAM, TIMELINE IS FINAL ──────────────────────────────
 *
 * The feed is the production plan; this is what gets exported. Editing
 * here never writes back — not to `feedSequence`, not to the spatial
 * analysis, not to a transition's mode. And a feed change never silently
 * rewrites this: the fingerprint the timeline was built from is stored,
 * a mismatch is REPORTED, and rebuilding is an explicit act.
 */

export type TimelineSourceType = 'transition-clip' | 'motion-clip' | 'still'

export interface TimelineItem {
  id: string
  /** Position in the final video. Contiguous from 0 after any edit. */
  order: number
  sourceType: TimelineSourceType
  /**
   * What this came from: a pairKey, a motion segment id, or an image id.
   * Diagnostic and for grouping — never parsed to reconstruct a pair.
   */
  sourceId: string
  /**
   * THE EXACT GENERATION THIS ITEM PLAYS.
   *
   * Pinned deliberately (§20). When a regeneration upstream makes a new
   * generation active, an item that has been split or trimmed must keep
   * playing the file it was cut against — silently swapping it would
   * move the operator's in/out points onto different footage.
   */
  sourceGenerationId: string | null
  /** The managed file this item plays. Null for a still. */
  sourceClipName: string | null
  /** The managed image a still holds. Null for a clip. */
  sourceImageName: string | null
  /** IN point, seconds into the source. */
  startOffsetSec: number
  /** OUT point, seconds into the source. Exclusive. */
  endOffsetSec: number
  /**
   * The blend into the NEXT item, in seconds.
   *
   * 0 is a hard cut — two clips meeting, occupying no extra time. A
   * positive value is an xfade and OVERLAPS, so it shortens the total.
   * Null means "whatever the project's seam setting says at this
   * boundary", which is what an un-edited timeline carries.
   */
  seamAfterSec: number | null
}

export interface Timeline {
  projectId: string
  items: TimelineItem[]
  /**
   * The feed/assembly state this timeline was materialised from.
   *
   * Compared against the CURRENT plan to detect drift. Never used to
   * rebuild automatically — see `timelineDrift`.
   */
  feedFingerprint: string
  /** True once a human has split, deleted or reordered anything. */
  manuallyEdited: boolean
  updatedAt: number
}

/** How long one item occupies, before any seam overlap is subtracted. */
export function itemDurationSec(item: TimelineItem): number {
  return Math.max(0, round3(item.endOffsetSec - item.startOffsetSec))
}

/**
 * The finished video's length.
 *
 * Sum of the items, MINUS every seam: an xfade plays the end of one clip
 * on top of the start of the next, so a 0.2s blend makes the film 0.2s
 * shorter, not longer. Getting this wrong would make the playhead and
 * the exported file disagree about where the end is.
 */
export function timelineDurationSec(items: TimelineItem[], defaultSeamSec = 0): number {
  let total = 0
  items.forEach((item, i) => {
    total += itemDurationSec(item)
    if (i < items.length - 1) total -= seamAfter(item, defaultSeamSec)
  })
  return Math.max(0, round3(total))
}

export function seamAfter(item: TimelineItem, defaultSeamSec: number): number {
  return item.seamAfterSec ?? defaultSeamSec
}

/** The absolute start of each item, accounting for seam overlaps. */
export function itemStartTimes(items: TimelineItem[], defaultSeamSec = 0): number[] {
  const starts: number[] = []
  let t = 0
  items.forEach((item, i) => {
    starts.push(round3(t))
    t += itemDurationSec(item)
    if (i < items.length - 1) t -= seamAfter(item, defaultSeamSec)
  })
  return starts
}

export interface TimelineLocation {
  index: number
  item: TimelineItem
  /** Seconds into the ITEM. */
  localSec: number
  /** Seconds into the SOURCE FILE — what a <video> should seek to. */
  sourceSec: number
}

/**
 * Absolute timeline time → which item, and where in its source.
 *
 * The mapping §9 asks for, and the one thing preview and split both
 * depend on. Kept here, once, so the playhead the operator sees and the
 * frame a split lands on cannot disagree.
 */
export function locateAtTime(
  items: TimelineItem[],
  timeSec: number,
  defaultSeamSec = 0
): TimelineLocation | null {
  if (items.length === 0) return null
  const starts = itemStartTimes(items, defaultSeamSec)
  const clamped = Math.max(0, timeSec)

  for (let i = items.length - 1; i >= 0; i--) {
    if (clamped >= starts[i] || i === 0) {
      const localSec = Math.max(0, round3(clamped - starts[i]))
      const duration = itemDurationSec(items[i])
      // Past the end of the last item, clamp to its final frame rather
      // than reporting a position no footage exists for.
      const bounded = Math.min(localSec, duration)
      return {
        index: i,
        item: items[i],
        localSec: bounded,
        sourceSec: round3(items[i].startOffsetSec + bounded)
      }
    }
  }
  return null
}

/**
 * The shortest piece a split may leave behind.
 *
 * Two frames at 25fps. Below this a segment is not a shot, and FFmpeg's
 * trim filter starts producing empty or single-frame output that xfade
 * then refuses to join.
 */
export const MIN_SEGMENT_SEC = 0.08

export type SplitResult =
  | { ok: true; items: TimelineItem[]; newItemId: string }
  | { ok: false; reason: string }

/**
 * Split ONE item at a local offset, in place.
 *
 * ── NO FILE IS TOUCHED ───────────────────────────────────────────────
 *
 * The two halves are two ranges over the same `sourceClipName`. This is
 * the whole of "split": there is no encode, no copy and no new mp4, so a
 * split is instant and perfectly reversible by deleting one half.
 *
 * The seam travels with the RIGHT half, because the seam describes the
 * joint to whatever follows — and after a split, what follows the left
 * half is the right half, meeting it exactly where the frame was cut.
 * That joint is a hard cut by definition: blending a clip into itself
 * across a split would dissolve one frame into the next.
 */
export function splitItemAt(
  items: TimelineItem[],
  itemId: string,
  localSec: number,
  makeId: () => string
): SplitResult {
  const index = items.findIndex((i) => i.id === itemId)
  if (index === -1) return { ok: false, reason: 'That clip is no longer on the timeline.' }

  const item = items[index]
  const cut = round3(item.startOffsetSec + localSec)
  const left = round3(cut - item.startOffsetSec)
  const right = round3(item.endOffsetSec - cut)

  if (left < MIN_SEGMENT_SEC || right < MIN_SEGMENT_SEC) {
    return {
      ok: false,
      reason:
        `The playhead is too close to the edge of this clip. ` +
        `A split must leave at least ${MIN_SEGMENT_SEC}s on both sides.`
    }
  }

  const newItemId = makeId()
  const first: TimelineItem = {
    ...item,
    endOffsetSec: cut,
    // The joint created BY the split is a cut. See above.
    seamAfterSec: 0
  }
  const second: TimelineItem = {
    ...item,
    id: newItemId,
    startOffsetSec: cut,
    // The original's outgoing seam belonged to the joint with the NEXT
    // item, which is now this half's problem.
    seamAfterSec: item.seamAfterSec
  }

  return {
    ok: true,
    items: renumber([...items.slice(0, index), first, second, ...items.slice(index + 1)]),
    newItemId
  }
}

/** Remove one item. Nothing outside this list is affected. */
export function removeItem(items: TimelineItem[], itemId: string): TimelineItem[] {
  return renumber(items.filter((i) => i.id !== itemId))
}

/** Move an item to a new position. Order is the only thing that changes. */
export function reorderItems(
  items: TimelineItem[],
  itemId: string,
  toIndex: number
): TimelineItem[] {
  const from = items.findIndex((i) => i.id === itemId)
  if (from === -1) return items
  const next = [...items]
  const [moved] = next.splice(from, 1)
  const bounded = Math.max(0, Math.min(toIndex, next.length))
  next.splice(bounded, 0, moved)
  return renumber(next)
}

/** Positions are contiguous and start at zero after every edit. */
export function renumber(items: TimelineItem[]): TimelineItem[] {
  return items.map((item, i) => ({ ...item, order: i }))
}

/**
 * WHAT THE TIMELINE WAS BUILT FROM.
 *
 * Identity plus order, so a reorder, an added photograph, a changed
 * transition mode or a newly generated clip all move it. Deliberately
 * NOT a hash of the whole project: a prompt edit or an analysis run
 * changes nothing about what the finished video contains, and warning
 * about those would train the operator to ignore the warning.
 */
export function feedFingerprintOf(plan: AssemblyPlan): string {
  return plan.segments
    .map((s) => `${s.kind}:${s.pairKey ?? s.motionSegmentId ?? s.imageId ?? ''}`)
    .join('|')
}

export type TimelineDrift =
  | { kind: 'none' }
  /** The feed moved on, but nobody has edited this timeline by hand. */
  | { kind: 'stale'; reason: string }
  /** The feed moved on AND there are manual edits to lose. */
  | { kind: 'conflict'; reason: string }

/**
 * Has the feed changed under this timeline, and does it matter?
 *
 * Reported, never acted on. §19's rule in one function: a rebuild is
 * always the operator's explicit choice, and when there are manual edits
 * it is a choice they have to confirm.
 */
export function timelineDrift(timeline: Timeline | null, currentFingerprint: string): TimelineDrift {
  if (!timeline) return { kind: 'none' }
  if (timeline.feedFingerprint === currentFingerprint) return { kind: 'none' }
  const reason = 'The Feed has changed since this timeline was created.'
  return timeline.manuallyEdited ? { kind: 'conflict', reason } : { kind: 'stale', reason }
}

/**
 * Materialise a timeline from the canonical assembly plan.
 *
 * The plan is what export would have produced on its own, so a freshly
 * materialised timeline exports byte-for-byte identically to the old
 * behaviour — which is the property test P pins.
 */
export function timelineFromPlan(
  projectId: string,
  plan: AssemblyPlan,
  sources: {
    /** Real duration of a clip file, seconds. */
    clipDurationSec: (storedName: string) => number
    /** The generation a clip came from, when one is known. */
    generationIdFor: (segment: AssemblySegment) => string | null
    clipNameFor: (segment: AssemblySegment) => string | null
    imageNameFor: (segment: AssemblySegment) => string | null
  },
  makeId: () => string,
  now: number
): Timeline {
  const items: TimelineItem[] = plan.segments.map((segment, i) => {
    const clipName = segment.kind === 'still' ? null : sources.clipNameFor(segment)
    const duration =
      segment.kind === 'still'
        ? (segment.holdSeconds ?? 0)
        : clipName
          ? sources.clipDurationSec(clipName)
          : 0

    return {
      id: makeId(),
      order: i,
      sourceType:
        segment.kind === 'still'
          ? 'still'
          : segment.kind === 'motion'
            ? 'motion-clip'
            : 'transition-clip',
      sourceId: segment.pairKey ?? segment.motionSegmentId ?? segment.imageId ?? '',
      sourceGenerationId: sources.generationIdFor(segment),
      sourceClipName: clipName,
      sourceImageName: segment.kind === 'still' ? sources.imageNameFor(segment) : null,
      startOffsetSec: 0,
      endOffsetSec: round3(duration),
      // The plan's own seam for this boundary, so a materialised timeline
      // reproduces the exporter's current output exactly.
      seamAfterSec: i < plan.seamSeconds.length ? plan.seamSeconds[i] : null
    }
  })

  return {
    projectId,
    items,
    feedFingerprint: feedFingerprintOf(plan),
    manuallyEdited: false,
    updatedAt: now
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

export { round3 as roundSeconds }

/**
 * WHAT THE RENDERER RECEIVES.
 *
 * Declared here rather than beside the service so the preload bridge can
 * import it without pulling the whole main tree into the renderer's
 * TypeScript project — the same reason `MotionConfirmation` lives in
 * shared.
 */
export interface TimelineViewPayload {
  timeline: Timeline | null
  drift: TimelineDrift
  durationSec: number
  defaultSeamSec: number
  /** Ids of items whose source file is not on disk. Blocks export. */
  missing: string[]
}

export type TimelineEditResult =
  | { ok: true; view: TimelineViewPayload }
  | { ok: false; reason: string }
