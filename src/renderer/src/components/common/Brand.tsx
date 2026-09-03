import logoLockup from '../../assets/i2t-logo.png'
import logoMark from '../../assets/i2t-mark.png'

/**
 * The I2T brand treatment.
 *
 * ── THE REAL ASSET, AS PROMISED ──────────────────────────────────────
 *
 * This used to draw the wordmark in CSS and SVG as a stand-in. The
 * supplied artwork replaced it, and the swap cost nothing at the call
 * sites: they still pass only a variant and a size.
 *
 * ── THE ARTWORK ALREADY CONTAINS THE NAME ────────────────────────────
 *
 * The lockup file is symbol + "I 2 T" + "Image2Transition.com". So the
 * text rows this component used to render beside the mark are gone for
 * `lockup` — keeping them would print the product name twice, side by
 * side, in two different typefaces. Only the tagline survives, because
 * it is the one line the image does not already say.
 *
 * ── TWO CROPS, NOT ONE SCALED FILE ───────────────────────────────────
 *
 * `variant="mark"` appears in the editor toolbar at around 20px tall.
 * The full lockup shrunk to that height is an illegible smear of text,
 * so the symbol is its own file, cropped from the same source at the
 * 130px-wide transparent gutter that separates it from the wordmark.
 *
 * Both are near-white (RGB 253) on transparency with a peak alpha of
 * 223, so they are built for a dark ground and will all but vanish on a
 * light one — which is what `tone` is for.
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
  const isMark = variant === 'mark'
  return (
    <span className={`brand brand-${size} brand-tone-${tone} brand-variant-${variant}`}>
      <img
        className={isMark ? 'brand-img brand-img-mark' : 'brand-img brand-img-lockup'}
        src={isMark ? logoMark : logoLockup}
        // The visible name lives in the artwork, so the accessible name
        // has to be supplied here — an empty alt would leave the app
        // shell with no readable identity at all.
        alt={isMark ? 'I2T' : 'I2T — Image2Transition.com'}
        draggable={false}
      />
      {variant === 'full' && <span className="brand-tagline">Images into motion</span>}
    </span>
  )
}

/** The product name in prose. One place, so it is never half-renamed. */
export const PRODUCT_NAME = 'I2T'
export const PRODUCT_FULL_NAME = 'Image 2 Transition'
export const PRODUCT_TAGLINE = 'Images into motion'
