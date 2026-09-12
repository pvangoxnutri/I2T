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
 * Desktop keeps CONTAIN because the material was shot for it and the
 * bars are usually nothing. Vertical uses COVER, because a 9:16 export
 * that is two thirds black is not a vertical video.
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
   * Null means "whatever the project is set to" — the desktop export is
   * deliberately not pinned to one shape.
   */
  aspectRatio: AspectRatio | null
  fit: FrameFit
  /**
   * What fills the frame where the picture cannot.
   *
   * A PROPERTY OF THE FORMAT, not a global setting. The desktop export
   * has always padded black and looks wrong any other way — it is a
   * letterbox, and letterboxes are black. A vertical Reel is supposed to
   * be full-bleed and never pads at all; white is declared only so that
   * if a source ever could not fill it, the result reads as deliberate
   * margin rather than as missing picture.
   *
   * This was briefly set globally to white, which changed every desktop
   * export the operator makes — their sources are 3:2 in a 16:9 frame,
   * so every one of them gained white pillarboxing.
   */
  padColor: 'black' | 'white'
}

export const EXPORT_FORMATS: ExportFormat[] = [
  {
    id: 'computer',
    label: 'Computer',
    description: 'Original / landscape format',
    aspectRatio: null,
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
