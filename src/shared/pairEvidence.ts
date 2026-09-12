import { isContextActive, type OperatorSpatialContext } from './operatorContext'
import {
  isPairAnalysisCurrent,
  type EvidenceSource,
  type PairAnalysisRecord
} from './pairAnalysis'
import type { PropertyAnalysis } from './propertyAnalysis'

/**
 * WHERE THIS PAIR'S EVIDENCE COMES FROM — one answer, for everyone.
 *
 * ── THE FAILURE THIS EXISTS FOR ──────────────────────────────────────
 *
 * Different components were each picking their own spatial source. The
 * feed analysis judged the bathroom pair against a map produced minutes
 * earlier and called it safe; generation preflight judged the same pair
 * against a five-week-old accepted map and refused it. Both were
 * "correct" about the object they happened to be holding.
 *
 * There are now four possible sources and one function that ranks them.
 * A component that picks for itself is the bug, not a shortcut.
 *
 * ── THE ORDER, AND WHY ───────────────────────────────────────────────
 *
 *   1. operator     someone stood in the room. For UNKNOWNS they are the
 *                   best evidence available — that is why we ask.
 *   2. individual   this exact pair, examined on its own, most recently.
 *   3. feed         the accepted feed analysis' verdict for this pair.
 *   4. global       the accepted whole-property map.
 *   5. unknown      nothing covers it. Not a licence to guess.
 *
 * Operator context ranks first for MISSING facts only. It never
 * outranks an affirmative contradiction — that is a finding, not a gap,
 * and overriding it requires the deliberate manual path.
 */

export interface ResolvedPairEvidence {
  source: EvidenceSource
  /** The pair analysis when it is the winning source; null otherwise. */
  individual: PairAnalysisRecord | null
  /** Operator text, only when it is active (not awaiting review). */
  operatorContext: OperatorSpatialContext | null
  /** The map every downstream evaluator should judge against. */
  analysis: PropertyAnalysis | null
  /** True when an individual analysis exists but no longer applies. */
  individualOutdated: boolean
  /** One line for the Prompt panel. Never a guess. */
  label: string
}

export function resolvePairSpatialEvidence(input: {
  pairKey: string
  /** The accepted whole-property map. */
  analysis: PropertyAnalysis | null
  /** This pair's own analysis, if one has ever been run. */
  pairAnalysis: PairAnalysisRecord | null
  /** What the operator wrote about this pair. */
  operatorContext: OperatorSpatialContext | null | undefined
  /** Whether the accepted feed analysis covers this pair. */
  coveredByFeedAnalysis: boolean
  fingerprints: { feedFingerprint: string; libraryFingerprint: string }
  now?: number
}): ResolvedPairEvidence {
  const { pairAnalysis, analysis, coveredByFeedAnalysis, fingerprints } = input
  const operatorContext = isContextActive(input.operatorContext) ? input.operatorContext : null
  const individualCurrent = isPairAnalysisCurrent(pairAnalysis, fingerprints)
  const individualOutdated = Boolean(pairAnalysis) && !individualCurrent

  const base = {
    individual: individualCurrent ? pairAnalysis : null,
    operatorContext,
    analysis,
    individualOutdated
  }

  // 1. The operator answered. Reported as theirs even when an analysis
  //    also exists, because that is what generation will actually be
  //    guided by and the Prompt panel must not claim otherwise.
  if (operatorContext) {
    return { ...base, source: 'operator', label: describeOperator(input.now, operatorContext) }
  }

  // 2. This exact pair, examined on its own.
  if (individualCurrent && pairAnalysis) {
    return {
      ...base,
      source: 'individual-analysis',
      label: `Individual analysis · ${relativeTime(pairAnalysis.analyzedAt, input.now)}`
    }
  }

  // 3. The accepted feed analysis.
  if (coveredByFeedAnalysis) {
    return { ...base, source: 'feed-analysis', label: 'Feed Analysis' }
  }

  // 4. The accepted property map, when there is one.
  if (analysis && analysis.rooms.length > 0) {
    return { ...base, source: 'global-analysis', label: 'Property Analysis' }
  }

  // 5. Nothing.
  return { ...base, source: 'unknown', label: 'No accepted evidence' }
}

function describeOperator(now: number | undefined, context: OperatorSpatialContext): string {
  return `Operator context · ${relativeTime(context.createdAt, now)}`
}

/** Short, and honest about not knowing. */
export function relativeTime(at: number, now: number = Date.now()): string {
  if (!at) return 'unknown time'
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 90) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}
