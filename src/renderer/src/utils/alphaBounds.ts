import type { ContentBox } from '../../../shared/branding'

/**
 * THE BOUNDING BOX OF EVERYTHING THAT IS NOT TRANSPARENT.
 *
 * ── WHY THIS IS NEEDED AT ALL ────────────────────────────────────────
 *
 * A branding asset's file is not the same shape as the mark inside it.
 * The operator's corner stamp is a 1920x1080 canvas carrying a 643x253
 * artwork at (637, 416) — 1.47% opaque, with 640 px of nothing between
 * the mark and the canvas's right edge. Anchoring the FILE into a corner
 * therefore puts the visible mark nowhere near it.
 *
 * So the mark is measured, and the anchor is applied to what was
 * measured. Nothing is cropped: the whole image is still drawn, just
 * positioned by the part of it that can be seen.
 *
 * ── COST, AND WHY IT IS PAID ONCE ────────────────────────────────────
 *
 * This reads every pixel — two million for a 1080p asset. It is
 * memoised per image source, because the asset changes when the operator
 * picks a new one and not once per frame, per toggle or per render.
 */
const cache = new Map<string, ContentBox | null>()

/** Alpha at or below this counts as nothing. Kills anti-aliased dust. */
const ALPHA_FLOOR = 8

export function measureAlphaBounds(img: HTMLImageElement): ContentBox | null {
  const key = img.currentSrc || img.src
  if (!key) return null
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  const w = img.naturalWidth
  const h = img.naturalHeight
  if (w <= 0 || h <= 0) return null

  let box: ContentBox | null = null
  try {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(img, 0, 0)
    const { data } = ctx.getImageData(0, 0, w, h)

    let minX = w
    let minY = h
    let maxX = -1
    let maxY = -1
    for (let y = 0; y < h; y++) {
      const row = y * w * 4
      for (let x = 0; x < w; x++) {
        if (data[row + x * 4 + 3] > ALPHA_FLOOR) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    // A fully transparent asset has no mark to anchor; treating that as
    // "the whole canvas" is the honest fallback rather than a 0x0 rect.
    box = maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
  } catch {
    // A tainted canvas would throw. Managed assets are same-origin, but
    // failing to measure must degrade to "anchor the whole file" rather
    // than to no branding at all.
    box = null
  }

  cache.set(key, box)
  return box
}

/** True when the mark occupies only a small part of its own canvas. */
export function isFullFrameAsset(box: ContentBox | null, natural: { w: number; h: number }): boolean {
  if (!box || natural.w <= 0 || natural.h <= 0) return false
  return box.w / natural.w < 0.9 || box.h / natural.h < 0.9
}
