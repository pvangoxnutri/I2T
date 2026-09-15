import type { AspectRatio, ExportDefaults } from './types'

/**
 * WHAT SHAPE THE FINISHED FILM IS.
 *
 * ── WHY THIS IS DATA, NOT A BOOLEAN ──────────────────────────────────
 *
 * "Computer or Instagram" is the question today, and it will be "or
 * TikTok, or a 4:5 feed post" soon enough. A flag would have to be
 * rewritten each time; a list gets one more entry.
 *
 * ── CONTAIN vs COVER — THE PART THAT MATTERS ─────────────────────────
 *
 * A landscape photograph cannot become a 9:16 frame without losing
 * something. There are exactly three options and only two are
 * acceptable:
 *
 *   STRETCH  distorts the property. Never, under any circumstances.
 *   CONTAIN  fits the whole frame and pads the rest — black bars top and
 *            bottom, which on a phone is most of the screen.
 *   COVER    scales until the frame is filled and crops the overflow
 *            evenly from both sides. Nothing is distorted; the edges are
 *            outside the frame.
 *
 * Standard/Computer uses 16:9 COVER; Instagram uses 9:16 COVER.
 * Both fill the output frame without padding or stretching the source.
 *
 * This choice belongs to the EXPORT. Source files, the project's own
 * aspect ratio and everything the editor previews are untouched.
 */

export type ExportFormatId = 'computer' | 'instagram'

/** How the source is made to fill the output frame. Never 'stretch'. */
export type FrameFit = 'contain' | 'cover'

export interface ExportFormat {
  id: ExportFormatId
  label: string
  /** Shown under the label in the export panel. */
  description: string
  /**
   * Null allows a future format to inherit the project shape. Both
   * customer-facing formats explicitly choose their output aspect ratio.
   */
  aspectRatio: AspectRatio | null
  fit: FrameFit
  /**
   * Background for contain fits only. Cover never reaches padding.
   */
  padColor: 'black' | 'white'
}

export const EXPORT_FORMATS: ExportFormat[] = [
  {
    id: 'computer',
    label: 'Computer',
    description: 'Landscape · 16:9 · cropped to fill',
    aspectRatio: '16:9',
    // ── FULL BLEED, LIKE THE REEL ─────────────────────────────────
    //
    // This was `contain`, and the operator's sources are about 3:2 in a
    // 16:9 frame, so every desktop export came out with black bars down
    // both sides. Cropping a little off the top and bottom is the better
    // trade, and it is the same rule the vertical format uses — neither
    // stretches, and neither pads.
    fit: 'cover',
    padColor: 'black'
  },
  {
    id: 'instagram',
    label: 'Instagram',
    description: 'Vertical · 9:16 · 1080×1920',
    aspectRatio: '9:16',
    // Fills the phone screen. The alternative is a tall black rectangle
    // with a small landscape video floating in the middle of it.
    fit: 'cover',
    // Unreachable: `cover` scales up until the frame is filled, so there
    // is nothing to pad. Both customer-facing formats are now cover, so
    // neither of these colours is reached — `padColor` survives for the
    // internal helpers that still assemble with `contain` (the editor
    // preview, the assembly comparison), which keep the black they have
    // always had.
    padColor: 'white'
  }
]

export const DEFAULT_EXPORT_FORMAT: ExportFormatId = 'computer'

/**
 * THE RATE EVERY CUSTOMER DELIVERABLE IS ENCODED AT.
 *
 * ── WHY A DELIVERED FILE RUNS FASTER THAN ITS SOURCES ────────────────
 *
 * The provider returns 24 fps. A slow continuous camera move through a
 * property at 24 fps judders on a phone screen, which is where most of
 * these are watched, and judder reads as "cheap video" however clean the
 * picture is. Interpolating to 120 removes it: the operator compared 60,
 * 90 and 120 on real material and 120 was decisively the best, most
 * visibly on mobile.
 *
 * THIS IS NOT FRAME DUPLICATION. Duplicating frames to 120 would change
 * the file's header and nothing a viewer can see. The assembly runs
 * motion-compensated interpolation per segment — see ffmpegService — so
 * the added frames carry real intermediate motion.
 *
 * It costs encode time, and deliberately so: an export is rendered once
 * and watched many times. Internal renders (the editor preview, the
 * assembly comparison) do NOT use this; they stay at their sources' rate
 * and stay fast, because nobody receives them.
 */
export const CUSTOMER_EXPORT_FPS = 120

/**
 * HOW SMOOTH THE DELIVERED MOTION IS.
 *
 * ── SMOOTHNESS, NOT QUALITY ──────────────────────────────────────────
 *
 * Both levels are the SAME picture: same resolution, same CRF, same
 * preset, same scaler, same branding, same full-bleed crop. The only
 * difference is how many frames the movement is drawn with, and both
 * reach their rate by real motion-compensated interpolation rather than
 * by repeating frames.
 *
 * ── AND NEITHER CHANGES HOW FAST ANYTHING MOVES ──────────────────────
 *
 * This is the distinction to keep hold of. The export rate decides
 * smoothness. A timeline item's `playbackRate` decides speed. A 1.5x
 * item moves 50% faster in both levels; a 60 fps export of it is the
 * same movement drawn with half as many frames as the 120. They are
 * independent, and conflating them is what produces slow motion.
 */
export type MotionQuality = 'standard60' | 'premium120'

export const MOTION_QUALITIES: Record<
  MotionQuality,
  { fps: number; label: string; note: string; caveat: string | null }
> = {
  standard60: {
    fps: 60,
    label: 'Standard',
    note: '60 fps · Smooth · Recommended',
    caveat: null
  },
  premium120: {
    fps: 120,
    label: 'Premium Smooth',
    note: '120 fps · Ultra-smooth',
    // Stated in the panel because it is the operator's own time. A 38s
    // film takes roughly twice as long to interpolate at 120 as at 60.
    caveat: 'Longer processing'
  }
}

/**
 * WHAT THE EXPORT PANEL PRE-SELECTS.
 *
 * Standard, deliberately. 120 fps is correct in the file — a 38.47s
 * timeline exports as a 38.47s file, proven by decoded frame count — but
 * a 120 fps upload has been seen to come back from Instagram running
 * long and slow. Until that is understood, the rate that every player
 * and platform handles without argument is the one an operator gets
 * without choosing, and 120 is something they opt into.
 */
export const DEFAULT_MOTION_QUALITY: MotionQuality = 'standard60'

/**
 * WHAT AN UNMARKED JOB WAS QUEUED AS. Not the same question.
 *
 * Every export queued before this choice existed rendered at 120, so an
 * unmarked job must still deliver 120. Reading the panel's new default
 * here instead would silently re-render someone's queued or recovered
 * export at a rate they never chose — which is exactly the class of bug
 * that made the format travel on the job in the first place.
 */
const LEGACY_JOB_QUALITY: MotionQuality = 'premium120'

/**
 * The rate a job should encode at, from what the job itself carries.
 */
export function motionQualityFps(quality: MotionQuality | null | undefined): number {
  return MOTION_QUALITIES[quality ?? LEGACY_JOB_QUALITY]?.fps ?? CUSTOMER_EXPORT_FPS
}

export function exportFormat(id: ExportFormatId | null | undefined): ExportFormat {
  return EXPORT_FORMATS.find((f) => f.id === id) ?? EXPORT_FORMATS[0]
}

/**
 * The export defaults to render with, once a format has had its say.
 *
 * Returns a COPY. The project's stored defaults are configuration and are
 * not rewritten by choosing where a film is going.
 */
export function applyExportFormat(
  defaults: ExportDefaults,
  id: ExportFormatId | null | undefined
): { defaults: ExportDefaults; fit: FrameFit; padColor: 'black' | 'white' } {
  const format = exportFormat(id)
  return {
    defaults: format.aspectRatio ? { ...defaults, aspectRatio: format.aspectRatio } : { ...defaults },
    fit: format.fit,
    padColor: format.padColor
  }
}
