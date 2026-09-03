import type { TransitionSettings } from './types'

/**
 * HOW LONG A GENERATED TRANSITION IS.
 *
 * ── ONE RESOLVER, THREE CALLERS ──────────────────────────────────────
 *
 * The answer to "how many seconds will this transition be?" was being
 * derived independently in the inspector, the timeline and the generation
 * service, each with its own `?? 5` at the end. Three copies of a default
 * is three chances for the number shown to the operator to disagree with
 * the number actually sent to the provider — and the one that decides is
 * the one nobody is looking at.
 *
 * ── SETTING, NOT RESULT ──────────────────────────────────────────────
 *
 * A duration is configuration until Generate is pressed. Changing it
 * costs nothing, sends nothing and destroys nothing: an existing clip was
 * produced at whatever length it was produced at, and stays exactly as it
 * is. The new value describes the NEXT generation.
 *
 * ── THE PROVIDER IS THE AUTHORITY ON WHAT IS ALLOWED ─────────────────
 *
 * Allowed values come from `ModelCapabilities.durationsSec` for the model
 * actually selected — already carried to the renderer on the provider
 * metadata. Nothing here hardcodes a range: fal's Kling O3 offers every
 * integer from 3 to 15, Kling's own API offers 5/10/15, and a future model
 * will offer whatever it offers. Offering a value the model cannot honour
 * only means it is silently snapped at submit, which is how an operator
 * ends up with a clip of a length they did not choose.
 */

/**
 * Used only when nothing else has an opinion — no per-transition value and
 * no configured default. Matches the historical I2T default, so projects
 * written before durations were configurable keep the length they had.
 */
export const FALLBACK_DURATION_SEC = 5

/** A whole number of seconds is the only thing any provider accepts. */
export function isWholeSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * The duration this transition will be generated at.
 *
 * A per-transition value always wins over the project default — it is an
 * explicit decision about one transition, and a settings change must not
 * silently rewrite it.
 */
export function resolveTransitionDuration(
  transition: Pick<TransitionSettings, 'durationSec'> | null | undefined,
  defaultDurationSec: number | null | undefined
): number {
  if (isWholeSeconds(transition?.durationSec)) return transition!.durationSec
  if (isWholeSeconds(defaultDurationSec)) return defaultDurationSec!
  return FALLBACK_DURATION_SEC
}

/**
 * The values a control may offer, sorted. Empty capability means the model
 * published none, in which case the caller should not pretend to know.
 */
export function durationChoices(allowedSec: number[] | null | undefined): number[] {
  if (!allowedSec || allowedSec.length === 0) return []
  return [...new Set(allowedSec.filter(isWholeSeconds))].sort((a, b) => a - b)
}

/** Whether a value can be sent to a model with these capabilities. */
export function isDurationSupported(
  seconds: unknown,
  allowedSec: number[] | null | undefined
): boolean {
  if (!isWholeSeconds(seconds)) return false
  const choices = durationChoices(allowedSec)
  // No published capability means we cannot claim a value is unsupported.
  if (choices.length === 0) return true
  return choices.includes(seconds)
}

/**
 * Move a value one step through what the model actually offers.
 *
 * Stepping through the ALLOWED LIST rather than adding one second is what
 * keeps a stepper honest on a model with gaps: on Kling (5/10/15) pressing
 * "+" from 5 gives 10, not an unsupported 6.
 */
export function stepDuration(
  current: number,
  direction: 1 | -1,
  allowedSec: number[] | null | undefined
): number {
  const choices = durationChoices(allowedSec)
  if (choices.length === 0) return current

  const index = choices.indexOf(current)
  if (index === -1) {
    // Current value is not on the list at all (a stored value from another
    // model). Land on the nearest allowed value rather than guessing.
    return clampToSupported(current, allowedSec)
  }
  const next = index + direction
  if (next < 0 || next >= choices.length) return current
  return choices[next]
}

/**
 * The closest value this model can honour. Mirrors the provider mappers'
 * own behaviour so what the UI shows is what the provider will do.
 */
export function clampToSupported(
  seconds: number,
  allowedSec: number[] | null | undefined
): number {
  const choices = durationChoices(allowedSec)
  if (choices.length === 0) return seconds
  return choices.reduce((best, candidate) =>
    Math.abs(candidate - seconds) < Math.abs(best - seconds) ? candidate : best
  )
}
