/**
 * SEAMLESS ASSEMBLY — hiding the joint between two generated clips.
 *
 * ── THE PROBLEM ──────────────────────────────────────────────────────
 *
 * FrameToFrame generates one clip per adjacent image pair:
 *
 *   clip A: Image 1 → Image 2
 *   clip B: Image 2 → Image 3
 *
 * A ends on Image 2 and B starts on Image 2, so conceptually the seam is
 * the SAME frame twice. In practice it never is: the model re-renders
 * that frame for each clip, the encoder cuts hard between two GOPs, and
 * exposure and framing drift by a hair. Concatenated, the viewer sees a
 * tick at every joint — which reads as "stitched slideshow" rather than
 * one continuous camera move.
 *
 * ── WHY IT IS DELIBERATELY TINY ──────────────────────────────────────
 *
 * The fix is NOT a crossfade. A dissolve long enough to notice is the
 * slideshow look we are trying to escape, and it throws away real
 * generated motion. The blend only has to cover the discontinuity —
 * roughly a tenth of a second, three frames at 30fps. Long enough to
 * hide a micro-jump and an exposure shift, short enough that nobody can
 * point at where one clip ended.
 *
 * Everything here is pure arithmetic so the timeline can be tested
 * without invoking FFmpeg.
 */

/** What the operator picks. Concrete durations live in SEAM_SECONDS. */
export type SeamBlend = 'off' | 'subtle' | 'smooth'

/**
 * Seam durations in seconds.
 *
 * `subtle` is the default: ~3 frames at 30fps, ~2.5 at 24fps. Enough to
 * swallow the encoder cut and a small exposure step. `smooth` doubles it
 * for clips whose framing drifts more, and is still under a quarter
 * second. Anything longer starts to read as a dissolve.
 */
export const SEAM_SECONDS: Record<SeamBlend, number> = {
  off: 0,
  subtle: 0.12,
  smooth: 0.2
}

/**
 * Frames trimmed from each side of a seam before blending.
 *
 * Some generated clips ease to a stop on their final frame and ease out
 * of their first. Blended as-is, two of those stack and the seam gains a
 * visible hold — the opposite of continuous motion. Trimming ONE frame
 * from the outgoing tail and one from the incoming head removes the
 * duplicated key frame itself without touching real motion.
 *
 * Deliberately one frame, not a duration: it scales with fps and cannot
 * grow into "cropping the generation".
 */
export const SEAM_TRIM_FRAMES = 1

/**
 * Result of the Compare Assembly development tool.
 *
 * In `shared` because it crosses the preload boundary. `wouldOverwrite`
 * is what lets the caller refuse to clobber existing files silently.
 */
export interface CompareAssemblyResult {
  ok: boolean
  hardCutsPath?: string
  seamlessPath?: string
  wouldOverwrite?: string[]
  reason?: string
}

export interface SeamPlanInput {
  /** Clip durations in seconds, in sequence order. */
  durationsSec: number[]
  blend: SeamBlend
  fps: number
}

export interface SeamPlan {
  /** Seam duration actually used between clip i and i+1 (length n-1). */
  seamSec: number[]
  /** Seconds trimmed from the END of clip i (length n). */
  trimEndSec: number[]
  /** Seconds trimmed from the START of clip i (length n). */
  trimStartSec: number[]
  /** Effective duration of each clip after trimming (length n). */
  effectiveSec: number[]
  /** xfade offset for seam i, on the accumulated timeline (length n-1). */
  offsetSec: number[]
  /** Total output duration in seconds. */
  totalSec: number
  /** True when at least one seam actually blends. */
  blended: boolean
}

/** Round to milliseconds — FFmpeg reads these as decimal seconds. */
const ms = (n: number): number => Math.max(0, Math.round(n * 1000) / 1000)

/**
 * Builds the seam timeline.
 *
 * SAFETY: a seam can never consume a clip. Very short clips (a 1-second
 * generation, or anything a provider truncated) clamp the seam to a
 * fraction of the shorter neighbour, and trimming is skipped entirely
 * when a clip is too short to give a frame away. The result is that
 * seamless mode degrades to a hard cut rather than producing a corrupt
 * or negative-length timeline.
 */
export function planSeams(input: SeamPlanInput): SeamPlan {
  const { durationsSec, fps } = input
  const n = durationsSec.length
  const requested = SEAM_SECONDS[input.blend] ?? 0
  const frame = fps > 0 ? 1 / fps : 0

  const trimStartSec = new Array<number>(n).fill(0)
  const trimEndSec = new Array<number>(n).fill(0)

  if (requested > 0 && n > 1) {
    const trim = SEAM_TRIM_FRAMES * frame
    for (let i = 0; i < n; i++) {
      const dur = durationsSec[i]
      // Only trim at a real seam, and only when the clip can spare it.
      // Two trims plus a seam must still leave most of the clip intact.
      const canSpare = dur > (requested + trim * 2) * 2
      if (!canSpare) continue
      if (i > 0) trimStartSec[i] = ms(trim)
      if (i < n - 1) trimEndSec[i] = ms(trim)
    }
  }

  const effectiveSec = durationsSec.map((d, i) => ms(d - trimStartSec[i] - trimEndSec[i]))

  const seamSec: number[] = []
  for (let i = 0; i < n - 1; i++) {
    if (requested <= 0) {
      seamSec.push(0)
      continue
    }
    // A seam may never be longer than a large fraction of either clip it
    // joins — otherwise xfade would eat the whole shorter clip.
    const shorter = Math.min(effectiveSec[i], effectiveSec[i + 1])
    seamSec.push(ms(Math.min(requested, shorter * 0.4)))
  }

  // Running xfade output length: A⊕B lasts durA + durB − seam.
  const offsetSec: number[] = []
  let accumulated = effectiveSec[0] ?? 0
  for (let i = 0; i < n - 1; i++) {
    offsetSec.push(ms(accumulated - seamSec[i]))
    accumulated = ms(accumulated + effectiveSec[i + 1] - seamSec[i])
  }

  return {
    seamSec,
    trimStartSec,
    trimEndSec,
    effectiveSec,
    offsetSec,
    totalSec: ms(accumulated),
    blended: seamSec.some((s) => s > 0)
  }
}
