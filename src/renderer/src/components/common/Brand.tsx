/**
 * The I2T brand treatment.
 *
 * ── ORIGINAL, NOT TRACED ─────────────────────────────────────────────
 *
 * Built from the stated direction — near-pure monochrome, very high
 * contrast, editorial, geometric, generous letter spacing, and a subtle
 * horizontal streak where the 2 and T meet. Nothing here is copied from
 * an image; it is CSS and SVG that can be swapped for a real asset later
 * without touching a single call site.
 *
 * ── THE 2/T INTERACTION ──────────────────────────────────────────────
 *
 * The mark's one piece of movement: the 2 and T sit tight enough to read
 * as joined, and a short horizontal fade trails off the T. That streak is
 * the whole "images into motion" idea in one gesture, so it stays quiet —
 * a gradient that ends in nothing, no glow and deliberately no outer drop
 * shadow, which would read as a 2010s SaaS logo rather than a studio mark.
 *
 * ── WHEN THE REAL LOGO ARRIVES ───────────────────────────────────────
 *
 * Drop the file in `src/renderer/src/assets`, import it, and render it in
 * place of `<Wordmark/>`. Callers only ever pass a variant and a size.
 */

export type BrandVariant =
  /** Just the mark — toolbars, tight spaces. */
  | 'mark'
  /** Mark + IMAGE 2 TRANSITION — app shell, headers. */
  | 'lockup'
  /** Mark + name + IMAGES INTO MOTION — splash, empty states. */
  | 'full'

export function BrandMark({
  variant = 'mark',
  size = 'md',
  tone = 'dark'
}: {
  variant?: BrandVariant
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /** `dark` = light mark on dark ground (the app). `light` = inverted. */
  tone?: 'dark' | 'light'
}): React.JSX.Element {
  return (
    <span className={`brand brand-${size} brand-tone-${tone} brand-variant-${variant}`}>
      <Wordmark />
      {variant !== 'mark' && (
        <span className="brand-lines">
          <span className="brand-name">Image 2 Transition</span>
          {variant === 'full' && <span className="brand-tagline">Images into motion</span>}
        </span>
      )}
      <span className="sr-only">I2T — Image 2 Transition</span>
    </span>
  )
}

/**
 * The wordmark itself.
 *
 * Text rather than paths so it stays crisp at every size and inherits the
 * UI font; the streak is the only drawn element, and it is an SVG so the
 * fade is a real gradient rather than a stack of divs.
 */
function Wordmark(): React.JSX.Element {
  return (
    <span className="brand-word" aria-hidden>
      <span className="brand-i">I</span>
      <span className="brand-2">2</span>
      <span className="brand-t">T</span>
      <svg className="brand-streak" viewBox="0 0 48 12" preserveAspectRatio="none" focusable="false">
        <defs>
          <linearGradient id="i2t-streak" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.55" />
            <stop offset="55%" stopColor="currentColor" stopOpacity="0.14" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Three unequal rules: a frame, its echo, and the trailing edge. */}
        <rect x="0" y="2.6" width="48" height="1.1" fill="url(#i2t-streak)" />
        <rect x="0" y="5.6" width="34" height="1.1" fill="url(#i2t-streak)" />
        <rect x="0" y="8.6" width="20" height="1.1" fill="url(#i2t-streak)" />
      </svg>
    </span>
  )
}

/** The product name in prose. One place, so it is never half-renamed. */
export const PRODUCT_NAME = 'I2T'
export const PRODUCT_FULL_NAME = 'Image 2 Transition'
export const PRODUCT_TAGLINE = 'Images into motion'
