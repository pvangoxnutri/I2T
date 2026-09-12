import type { SeamBlend } from './seamBlend'
import { SEAM_SECONDS } from './seamBlend'
import {
  CROSSFADE_SECONDS,
  STILL_HOLD_SECONDS,
  type EffectiveTransitionMode
} from './transitionMode'

/**
 * WHAT ACTUALLY GOES INTO THE VIDEO, once not every pair has a clip.
 *
 * ── THE MODEL ────────────────────────────────────────────────────────
 *
 * The assembled video has always been a chain of transition CLIPS: clip
 * i covers image i → image i+1, so the still photographs appear only as
 * the first and last frames of the clips around them.
 *
 * That is why a CUT usually needs nothing at all. With
 *
 *   clip(1→2) · CUT · clip(3→4)
 *
 * the first clip ends on image 2, the second begins on image 3, and
 * joining them with a zero-length seam IS the cut. No filler, no black
 * frame, no fabricated clip to satisfy an assumption.
 *
 * ── EXCEPT AT THE EDGES ──────────────────────────────────────────────
 *
 * An image that no clip covers would never reach the screen: a cut as the
 * first transition loses image 1, two consecutive cuts lose the image
 * between them. Those — and only those — get a still HOLD segment.
 *
 * ── AND CROSSFADE IS JUST A SEAM ─────────────────────────────────────
 *
 * A dissolve between two segments is what the seam machinery already
 * does. A crossfade is therefore a boundary with a deliberate blend
 * duration rather than a new kind of segment, which keeps one timeline
 * implementation instead of two.
 */

/**
 * ── AND A SINGLE PHOTOGRAPH CAN MOVE ─────────────────────────────────
 *
 * A motion segment is one image with gentle camera movement. In the
 * timeline it occupies exactly the place its photograph would otherwise
 * have occupied, which makes the no-duplicated-time rule simple:
 *
 *   a motion clip REPLACES that image's still hold.
 *
 * It never adds one on top. And it does not duplicate frames against the
 * transitions around it either: the clip before it ENDS on that image,
 * the motion clip BEGINS on it, and the clip after it begins on it too —
 * the same frame continuing, which is what a seam of zero means
 * everywhere else in this file. What would duplicate time is holding the
 * still as well, and that is precisely what coverage now prevents.
 */

export type SegmentKind = 'clip' | 'still' | 'motion'

export interface AssemblySegment {
  kind: SegmentKind
  /** For a clip: the pair it was generated for. */
  pairKey?: string
  /** For a motion segment: its own id, and what it does. */
  motionSegmentId?: string
  motionLabel?: string
  /** For a clip: the managed file. */
  clipPath?: string
  /** For a still: the image to hold, and for how long. */
  imageId?: string
  imagePath?: string
  holdSeconds?: number
  /** Images this segment puts on screen — used to work out coverage. */
  covers: string[]
}

export interface AssemblyPlanInput {
  imageIds: string[]
  /** Effective mode per pair, in sequence order (length imageIds − 1). */
  modes: EffectiveTransitionMode[]
  /** Managed clip path per pair, or null. Only consulted for `ai` pairs. */
  clipPaths: (string | null)[]
  /** Managed still path per image, for hold segments. */
  imagePaths: string[]
  /** The project's seam setting, used between two AI clips. */
  seamBlend: SeamBlend
  /**
   * Single-image motion segments, if the project has any. Optional so
   * every existing caller keeps its exact current behaviour.
   */
  motions?: PlannedMotion[]
}

export interface PlannedMotion {
  segmentId: string
  imageId: string
  /** Human wording for the plan readout, e.g. `SINGLE IMAGE · PAN LEFT`. */
  label: string
  /** The generated file, or null when it has not been generated yet. */
  clipPath: string | null
}

export interface AssemblyPlan {
  segments: AssemblySegment[]
  /**
   * Seam seconds at each boundary BETWEEN segments (length segments − 1).
   * 0 is a hard cut; a positive value dissolves.
   */
  seamSeconds: number[]
  /** AI pairs whose clip is missing — the only thing that blocks a build. */
  missingClipPairs: string[]
  /** Motion segments the operator added but never generated. */
  missingMotionSegments: string[]
  /** Pairs that need no clip at all. */
  cutPairs: string[]
  crossfadePairs: string[]
  /** True when there is something to assemble. */
  ok: boolean
  reason?: string
}

/**
 * Build the segment timeline.
 *
 * Pure and total: it never touches the filesystem, so the whole mixed-mode
 * arrangement can be asserted without FFmpeg.
 */
export function planAssembly(input: AssemblyPlanInput): AssemblyPlan {
  const { imageIds, modes, clipPaths, imagePaths, seamBlend } = input

  const missingClipPairs: string[] = []
  const cutPairs: string[] = []
  const crossfadePairs: string[] = []

  // ── 1. Which pairs contribute a clip ─────────────────────────────────
  const usable = modes.map((mode, i) => {
    const label = `${i + 1} → ${i + 2}`
    if (mode === 'cut') {
      cutPairs.push(label)
      return false
    }
    if (mode === 'crossfade') {
      crossfadePairs.push(label)
      return false
    }
    if (!clipPaths[i]) {
      missingClipPairs.push(label)
      return false
    }
    return true
  })

  // ── 2. Which images no clip puts on screen ───────────────────────────
  const covered = new Set<string>()
  usable.forEach((yes, i) => {
    if (!yes) return
    covered.add(imageIds[i])
    covered.add(imageIds[i + 1])
  })

  // A generated motion clip puts its photograph on screen, and for longer
  // and more deliberately than a hold would. So it counts as coverage —
  // that single line is what stops the still being emitted as well.
  const motions = (input.motions ?? []).filter((m) => imageIds.includes(m.imageId))
  const missingMotionSegments = motions.filter((m) => !m.clipPath).map((m) => m.label)
  const usableMotions = motions.filter((m) => m.clipPath)
  usableMotions.forEach((m) => covered.add(m.imageId))

  // ── 3. Walk the sequence, emitting segments in order ─────────────────
  //
  // An uncovered image becomes a hold; a usable pair becomes its clip. The
  // walk is over IMAGES so a hold lands in the right place relative to the
  // clips around it.
  const segments: AssemblySegment[] = []

  for (let i = 0; i < imageIds.length; i++) {
    // An image no clip shows gets held, in its own position in the
    // sequence. A covered image needs nothing: the clip around it already
    // puts it on screen as its first or last frame.
    if (!covered.has(imageIds[i])) {
      segments.push({
        kind: 'still',
        imageId: imageIds[i],
        imagePath: imagePaths[i],
        holdSeconds: STILL_HOLD_SECONDS,
        covers: [imageIds[i]]
      })
    }
    // Then whatever motion the operator gave this photograph, in the
    // position the photograph itself holds. It sits AFTER any still
    // branch — which cannot have run for this image — and BEFORE the
    // transition that leaves it, so the movement reads as the approach
    // to the doorway rather than an interruption after it.
    for (const m of usableMotions.filter((x) => x.imageId === imageIds[i])) {
      segments.push({
        kind: 'motion',
        motionSegmentId: m.segmentId,
        motionLabel: m.label,
        clipPath: m.clipPath ?? undefined,
        imageId: m.imageId,
        covers: [m.imageId]
      })
    }
    if (i < modes.length && usable[i]) {
      segments.push({
        kind: 'clip',
        pairKey: `${imageIds[i]}->${imageIds[i + 1]}`,
        clipPath: clipPaths[i] ?? undefined,
        covers: [imageIds[i], imageIds[i + 1]]
      })
    }
  }

  if (segments.length === 0) {
    return {
      segments: [],
      seamSeconds: [],
      missingClipPairs,
      missingMotionSegments,
      cutPairs,
      crossfadePairs,
      ok: false,
      reason:
        missingClipPairs.length > 0
          ? `Missing transition clips: ${missingClipPairs.join(', ')}`
          : 'Nothing to assemble.'
    }
  }

  // ── 4. Seam at each boundary ─────────────────────────────────────────
  //
  // The pair spanned by a boundary decides it: a crossfade dissolves, a
  // cut is hard, and two AI clips get the project's seam setting — which
  // exists to hide an encoder cut between continuous motion, and has
  // nothing to do with a deliberate dissolve.
  const seamSeconds: number[] = []
  for (let s = 0; s < segments.length - 1; s++) {
    const left = segments[s]
    const right = segments[s + 1]
    const leftEndImage = left.covers[left.covers.length - 1]
    const rightStartImage = right.covers[0]
    const pairIndex = imageIds.indexOf(leftEndImage)
    const spansOnePair = imageIds[pairIndex + 1] === rightStartImage

    if (spansOnePair && modes[pairIndex] === 'crossfade') {
      seamSeconds.push(CROSSFADE_SECONDS)
    } else if (spansOnePair && modes[pairIndex] === 'cut') {
      // A HARD cut. Never a fade, never a black frame.
      seamSeconds.push(0)
    } else if (left.kind === 'clip' && right.kind === 'clip') {
      seamSeconds.push(SEAM_SECONDS[seamBlend] ?? 0)
    } else {
      seamSeconds.push(0)
    }
  }

  return {
    segments,
    seamSeconds,
    missingClipPairs,
    missingMotionSegments,
    cutPairs,
    crossfadePairs,
    // A motion segment the operator added but never generated blocks the
    // build for the same reason a missing transition clip does: it is a
    // deliberate part of the sequence, and dropping it silently would
    // ship a video that is not the one shown on the timeline.
    ok: missingClipPairs.length === 0 && missingMotionSegments.length === 0,
    reason:
      missingClipPairs.length > 0
        ? `Missing transition clips: ${missingClipPairs.join(', ')}`
        : missingMotionSegments.length > 0
          ? `Motion clips not generated: ${missingMotionSegments.join(', ')}`
          : undefined
  }
}
