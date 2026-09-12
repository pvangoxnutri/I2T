import type { AppSettings, BrandSignature, PreviewWatermark, Project } from './types'

/**
 * THE ONE ANSWER TO "WHAT BRANDING DOES THIS PROJECT USE".
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────
 *
 * There are two levels, and they are both legitimate: the app settings
 * hold the business's branding, and a project may override it for one
 * customer. What was missing was the rule joining them, so every
 * consumer picked one level and stuck to it — which is why configuring
 * a watermark in Settings had no effect on a project that already
 * existed. The project's own value was null, and null was read as "no
 * watermark" rather than "nothing overridden".
 *
 * ── ABSENT IS NOT OFF ────────────────────────────────────────────────
 *
 * That distinction is the whole of this file. A project with no image
 * of its own INHERITS the default; a project that has chosen one keeps
 * it. `enabled` is likewise the project's own decision once it has been
 * saved, because turning a watermark off for one customer must not be
 * undone by a settings change made for another.
 *
 * Every consumer — the timeline preview overlay, the export rasteriser,
 * the settings preview — resolves through here, so what is on screen
 * and what is encoded cannot describe different images.
 */

export interface ResolvedBranding {
  watermark: PreviewWatermark
  signature: BrandSignature
}

/**
 * Fill a project's branding from the app defaults where it has made no
 * choice of its own.
 *
 * Only the IMAGE is inherited. Position, size and opacity stay with
 * whoever set them: a project that has been positioned for a particular
 * property should not jump because the default moved.
 */
export function resolveBranding(
  project: Pick<Project, 'watermark' | 'signature'>,
  settings: Pick<AppSettings, 'defaultSignature' | 'defaultWatermark'> | null
): ResolvedBranding {
  const dw = settings?.defaultWatermark
  const ds = settings?.defaultSignature

  // ── WHAT COUNTS AS "THE PROJECT HAS OVERRIDDEN THIS" ────────────────
  //
  // Having chosen its own IMAGE. That is the only field with a genuine
  // unset state — size, position and opacity are numbers that every
  // project carries from creation, so they cannot distinguish "chosen"
  // from "never touched".
  //
  // THE BUG THIS FIXES. Only the image used to be inherited, so a
  // project that had never configured a watermark still used its own
  // creation-time size of 45. Dragging Size in Settings changed
  // nothing for it: the slider moved, the render did not, and 100%
  // looked "far too small" because the project was pinned at 45% and
  // the settings value was inert.
  //
  // A project that has not chosen an image has not configured a
  // watermark at all, so it follows the business default WHOLESALE.
  // One that has chosen its own keeps everything — its size was set
  // for that image on that property, and a settings change made for a
  // different customer must not move it.
  const watermarkOverridden = !!project.watermark.imageSrc
  const signatureOverridden = !!project.signature.logoSrc

  return {
    watermark:
      watermarkOverridden || !dw?.imageSrc
        ? { ...project.watermark }
        : {
            ...dw,
            // `enabled` stays the project's: turning the watermark off
            // for one customer is a decision about that film.
            enabled: project.watermark.enabled
          },
    signature:
      signatureOverridden || !ds?.logoSrc
        ? { ...project.signature }
        : { ...ds, enabled: project.signature.enabled }
  }
}

/**
 * Is there anything to draw for this layer?
 *
 * Enabled AND carrying an image. Used by the preview so an enabled
 * watermark with no image renders nothing rather than an empty box, and
 * by the export so it does not rasterise a blank overlay.
 */
export function watermarkVisible(w: PreviewWatermark): boolean {
  return w.enabled && !!w.imageSrc
}

export function signatureVisible(s: BrandSignature): boolean {
  return s.enabled && !!s.logoSrc
}

/**
 * WHERE A CONTAINED IMAGE ACTUALLY SITS INSIDE ITS BOX.
 *
 * `object-fit: contain` scales media to fit and centres it, leaving bars
 * on two sides. Branding overlays must be positioned against THAT
 * rectangle rather than against the box, because the export composites
 * onto the picture — a mark placed against the box lands in the letter-
 * box, off the film, and a percentage size comes out proportionally
 * wrong as well.
 *
 * Here rather than inside the component so the arithmetic can be pinned:
 * a wrong rectangle is invisible in a screenshot and obvious in numbers.
 */
export function containFit(
  boxWidth: number,
  boxHeight: number,
  mediaWidth: number,
  mediaHeight: number
): { left: number; top: number; width: number; height: number } {
  if (boxWidth <= 0 || boxHeight <= 0 || mediaWidth <= 0 || mediaHeight <= 0) {
    return { left: 0, top: 0, width: 0, height: 0 }
  }
  const scale = Math.min(boxWidth / mediaWidth, boxHeight / mediaHeight)
  const width = mediaWidth * scale
  const height = mediaHeight * scale
  return { left: (boxWidth - width) / 2, top: (boxHeight - height) / 2, width, height }
}

/**
 * THE CANONICAL BRANDING RECTANGLE.
 *
 * ── THE BUG THIS FIXES ────────────────────────────────────────────────
 *
 * Preview and export were placing the same mark by two different rules.
 *
 * The export rasteriser anchors with ONE margin on both axes, derived
 * from the short side: `round(min(W, H) * fraction)`. The preview used
 * CSS percentages — `bottom: 3%; right: 3%` — and a CSS percentage
 * resolves `right` against the container's WIDTH and `bottom` against
 * its HEIGHT. On a 16:9 picture those are different distances, and
 * neither is the one the export uses.
 *
 * Measured on a 1920×1080 frame: the export insets by 32px on both
 * edges; the preview inset by 57.6px on the right and 32.4px on the
 * bottom. The stamp sat 25px too far from the right edge, which is
 * exactly the "not actually bottom-right" that was reported.
 *
 * ── AND THE SIZE IS AN ASPECT-CORRECT RECTANGLE ──────────────────────
 *
 * The width comes from `sizePct` — a percentage of the picture's WIDTH,
 * the same semantic the export uses. The height then follows the asset's
 * own aspect ratio. A stamp is not assumed square: a 1920×1080 asset at
 * 30% is 576×324, and it is that 576×324 rectangle that gets anchored,
 * not a guessed box.
 */
export const BRAND_MARGIN_FRACTION = {
  /** The large mark. */
  watermark: 0.04,
  /** The corner stamp. A small safety inset, not a layout gutter. */
  stamp: 0.02
} as const

/**
 * Where an asset's VISIBLE pixels sit inside its own canvas.
 *
 * In natural image pixels: the bounding box of everything not
 * transparent. `null` means "the whole canvas" — an opaque image, or one
 * nobody has measured.
 */
export interface ContentBox {
  x: number
  y: number
  w: number
  h: number
}

/**
 * ── ANCHOR WHAT CAN BE SEEN, NOT THE FILE IT ARRIVED IN ──────────────
 *
 * THE BUG THIS FIXES. The rectangle was anchored correctly and the mark
 * still sat far inside the corner, because the anchor was applied to the
 * image's CANVAS while the artwork was somewhere else inside it.
 *
 * Measured on the operator's own asset, `i2t-video-overlay-1920x1080.png`:
 *
 *   canvas            1920 x 1080
 *   visible artwork    643 x 253, at (637, 416)
 *   transparent pad    left 637   top 416   right 640   bottom 411
 *   opaque             1.47% of the canvas
 *
 * So 640 px of nothing sat between the artwork and the canvas's right
 * edge. At 30% on a 572 px picture that is another 57 px in from the
 * right and 37 px up from the bottom — on top of the margin, and
 * unequal, which is exactly "too far in and too high".
 *
 * `content` is that bounding box, in natural pixels. When it is given,
 * the anchor is applied to the CONTENT and the returned rectangle is the
 * whole canvas shifted so the content lands where it was asked to. The
 * image is still drawn complete — nothing is cropped, nothing is scaled
 * differently, and `sizePct` still means the same thing it always did.
 */
export function brandRect(
  frame: { width: number; height: number },
  natural: { w: number; h: number },
  sizePct: number,
  position: string,
  marginFraction: number,
  content?: ContentBox | null
): { left: number; top: number; width: number; height: number } {
  if (frame.width <= 0 || frame.height <= 0 || natural.w <= 0 || natural.h <= 0) {
    return { left: 0, top: 0, width: 0, height: 0 }
  }
  const width = frame.width * (sizePct / 100)
  const height = width * (natural.h / natural.w)
  // ONE margin for both axes, off the SHORT side — the export's rule.
  const margin = Math.round(Math.min(frame.width, frame.height) * marginFraction)

  // The part of the drawn image the operator can actually see, in
  // rendered pixels. Absent a measurement that is the whole canvas.
  const scale = width / natural.w
  const box: ContentBox =
    content && content.w > 0 && content.h > 0 ? content : { x: 0, y: 0, w: natural.w, h: natural.h }
  const inset = {
    left: box.x * scale,
    top: box.y * scale,
    right: (natural.w - (box.x + box.w)) * scale,
    bottom: (natural.h - (box.y + box.h)) * scale
  }

  const [v, h = 'center'] = position.split('-')
  // Place the CONTENT, then step back out to where the canvas has to be.
  const left =
    h === 'left'
      ? margin - inset.left
      : h === 'right'
        ? frame.width - width - margin + inset.right
        : (frame.width - width) / 2 + (inset.right - inset.left) / 2
  const top =
    v === 'top'
      ? margin - inset.top
      : v === 'bottom'
        ? frame.height - height - margin + inset.bottom
        : (frame.height - height) / 2 + (inset.bottom - inset.top) / 2
  return { left, top, width, height }
}

/**
 * Where the visible mark ends up, given the rectangle the canvas is
 * drawn into. Used by the tests and the runtime proof: the canvas rect
 * is what gets drawn, but the CONTENT rect is what a person sees, and
 * they are the numbers a margin should be measured against.
 */
export function visibleMarkRect(
  canvasRect: { left: number; top: number; width: number; height: number },
  natural: { w: number; h: number },
  content?: ContentBox | null
): { left: number; top: number; width: number; height: number } {
  if (!content || content.w <= 0 || content.h <= 0 || natural.w <= 0) return canvasRect
  const scale = canvasRect.width / natural.w
  return {
    left: canvasRect.left + content.x * scale,
    top: canvasRect.top + content.y * scale,
    width: content.w * scale,
    height: content.h * scale
  }
}

/**
 * Whether an asset is a FULL-FRAME overlay rather than a corner badge.
 *
 * A mark whose aspect ratio matches the video's is almost always an
 * artwork designed to be composited edge to edge, with its own margins
 * already built into a transparent canvas. Anchoring one into a corner
 * puts the CANVAS in the corner and leaves the visible artwork floating
 * somewhere in the middle — no positioning rule can rescue that, because
 * the position is inside the file.
 *
 * Worth detecting rather than silently rendering: the operator's own
 * stamp is `i2t-video-overlay-1920x1080.png`, exactly 16:9, and that is
 * why it never landed in the corner however the margin was computed.
 */
export function looksLikeFullFrameAsset(
  natural: { w: number; h: number },
  frame: { width: number; height: number }
): boolean {
  if (natural.w <= 0 || natural.h <= 0 || frame.width <= 0 || frame.height <= 0) return false
  return Math.abs(natural.w / natural.h - frame.width / frame.height) < 0.02
}
