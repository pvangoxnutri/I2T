import type { MissingContextItem } from './operatorContext'
import type { ReflectiveSurface } from './propertyAnalysis'

/**
 * ONE TRANSITION, ANALYSED ON ITS OWN.
 *
 * ── WHY THIS EXISTS SEPARATELY ───────────────────────────────────────
 *
 * Re-running the whole feed analysis to settle one joint is expensive
 * and disproportionate: it re-decides thirteen transitions to answer a
 * question about one. But writing a two-image answer back into the
 * accepted PropertyAnalysis would be worse — a single pair's re-analysis
 * would rewrite room membership and adjacency for photographs it never
 * examined.
 *
 * So a pair analysis is its own record, preferred only for the exact
 * pair it describes. `resolvePairSpatialEvidence` is the one place that
 * decides when it wins.
 */

export type PairAnalysisState = 'draft' | 'accepted' | 'outdated'

/** What the analyzer observed about this specific pair. */
export interface PairEvidenceRecord {
  /** "same-room", "adjacent-room", "unknown" — the analyzer's reading. */
  relation: string
  roomLabel?: string
  sharedLandmarks: string[]
  /** Openings visible in the START frame; the only basis for moving through. */
  openings: string[]
  reflectiveSurfaces: ReflectiveSurface[]
  /** Correspondence the analyzer could point at, in its own words. */
  overlapNotes?: string
  /**
   * AFFIRMATIVE incompatibilities. Distinct from missing context: these
   * are findings, and no amount of operator prose resolves them.
   */
  geometryConflicts: string[]
}

export interface PairAnalysisRecord {
  projectId: string
  pairKey: string
  analyzedAt: number
  analyzer: string | null
  model: string | null
  /**
   * The accepted PropertyAnalysis this pair was judged against, and the
   * feed/library it belonged to. All three are what make a stale record
   * detectable rather than silently authoritative.
   */
  parentAnalysisUpdatedAt: number | null
  feedFingerprint: string | null
  libraryFingerprint: string | null
  evidence: PairEvidenceRecord
  decision: 'ai' | 'cut' | 'needs-context'
  missingContext: MissingContextItem[]
  motionInstruction: string | null
  /** Suggested wording. NEVER written over a hand-edited prompt. */
  promptCandidate: string | null
  reason: string | null
  state: PairAnalysisState
}

/**
 * WHERE A PAIR'S SPATIAL EVIDENCE COMES FROM.
 *
 * Ordered, and the order is the product decision:
 *
 *   1. operator      a human who stood in the room, and said so
 *   2. individual    this exact pair, analysed on its own
 *   3. feed          the accepted feed analysis' verdict for this pair
 *   4. global        the accepted whole-property map
 *   5. unknown       nothing covers it
 *
 * The operator outranks every analyzer for UNKNOWNS — that is the whole
 * point of asking them. It does not outrank an affirmative contradiction;
 * that still needs the deliberate manual override.
 */
export type EvidenceSource = 'operator' | 'individual-analysis' | 'feed-analysis' | 'global-analysis' | 'unknown'

export const EVIDENCE_SOURCE_LABEL: Record<EvidenceSource, string> = {
  operator: 'Operator context',
  'individual-analysis': 'Individual analysis',
  'feed-analysis': 'Feed Analysis',
  'global-analysis': 'Property Analysis',
  unknown: 'No accepted evidence'
}

/**
 * Is this pair analysis still describing the world it was run against?
 *
 * Deliberately conservative: anything that moved makes it outdated
 * rather than quietly applying it to a pair it may no longer fit.
 */
export function isPairAnalysisCurrent(
  record: PairAnalysisRecord | null | undefined,
  current: { feedFingerprint: string; libraryFingerprint: string }
): boolean {
  if (!record) return false
  if (record.state !== 'accepted') return false
  if (record.feedFingerprint && record.feedFingerprint !== current.feedFingerprint) return false
  if (record.libraryFingerprint && record.libraryFingerprint !== current.libraryFingerprint) {
    return false
  }
  return true
}
