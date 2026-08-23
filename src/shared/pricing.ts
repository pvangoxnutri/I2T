import type { Currency, PriceSnapshot, PricingSettings } from './types'

/**
 * Pure customer-pricing logic, shared by main (job snapshots) and renderer
 * (editor summary, settings, queue display). No I/O, fully testable.
 */

export const DEFAULT_PRICING: PricingSettings = {
  pricePerImage: 149,
  currency: 'SEK'
}

/** Clamps user input to a valid price: finite, ≥ 0 (0 is allowed), rounded
 * to two decimals. Anything unparsable becomes 0 — never NaN. */
export function sanitizePricePerImage(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.round(n * 100) / 100
}

/** customer price = number of project images × price per image. */
export function priceSnapshot(imageCount: number, pricing: PricingSettings): PriceSnapshot {
  const pricePerImage = sanitizePricePerImage(pricing.pricePerImage)
  const count = Number.isFinite(imageCount) && imageCount > 0 ? Math.floor(imageCount) : 0
  return {
    pricePerImage,
    imageCount: count,
    currency: pricing.currency,
    totalPrice: Math.round(pricePerImage * count * 100) / 100
  }
}

/** Locale per currency so each renders in its native convention:
 * SEK → "1 788 kr", EUR → "€178.00", USD → "$178.00". */
const CURRENCY_LOCALE: Record<Currency, string> = {
  SEK: 'sv-SE',
  EUR: 'en-IE',
  USD: 'en-US'
}

export function formatPrice(amount: number, currency: Currency): string {
  const safe = Number.isFinite(amount) ? amount : 0
  const wholeNumber = Number.isInteger(safe)
  return new Intl.NumberFormat(CURRENCY_LOCALE[currency], {
    style: 'currency',
    currency,
    minimumFractionDigits: wholeNumber && currency === 'SEK' ? 0 : 2,
    maximumFractionDigits: 2
  }).format(safe)
}
