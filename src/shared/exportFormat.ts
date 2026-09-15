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
