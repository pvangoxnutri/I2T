import { listProjects } from '../db/projectsRepo'
import { readAnalysis } from '../db/analysisRepo'
import { listOverrides } from '../db/overrideRepo'
import { readPairAnalysis } from '../db/pairAnalysisRepo'
import { readTransitionDraft } from '../db/transitionAnalysisRepo'
import { applyImageOverrides } from '../../shared/imageFacts'
import { getFeedSequenceIds } from '../../shared/feedSequence'
import { resolvePairSpatialEvidence, type ResolvedPairEvidence } from '../../shared/pairEvidence'
import { evidenceFingerprintOf } from '../../shared/promptPlanner'
import type { EvidenceSource } from '../../shared/pairAnalysis'
import type { Project } from '../../shared/types'

/**
 * WHAT THIS PAIR'S PROMPT IS CURRENTLY BASED ON — one computation.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────
 *
 * Four places derived this independently: the prompt rebuild, the
 * single-transition adopt, the pair approval, and generation preflight.
 * They agreed only by coincidence, and stopped agreeing the moment any
 * one of them read state at a slightly different moment.
 *
 * Recovered from the operator's own database — 8 AI pairs blocked, two
 * different ways of being wrong at once:
 *
 *   7 pairs   prompt = global-analysis / global:1788716462539
 *             current = feed-analysis  / feed:1788761469749
 *
 *   1 pair    prompt = NULL, never stamped at all
 *
 * The seven were stamped by Accept, which rebuilt the wording BEFORE
 * marking the feed analysis accepted — so the resolver it consulted could
 * not yet see a feed analysis and answered `global-analysis`, while the
 * resolver preflight consults, moments later, answers `feed-analysis`.
 * Both readings were correct about the state in front of them.
 *
 * There is now one function. It reads PERSISTED state, so a caller cannot
 * hand it a draft, a pre-commit object, or a stale renderer copy. Call it
 * after the writes, never before.
 */

export interface CurrentPairEvidence {
  source: EvidenceSource
  fingerprint: string
  operatorContextFingerprint?: string
  pairKey: string
  evidence: ResolvedPairEvidence
}

/**
 * Reads from disk unless a caller passes the project it has just written.
 *
 * `project` is an optimisation for callers inside a transaction that hold
 * the row they are about to save; everything else — the analysis, the
 * accepted feed draft, the pair analysis — is always re-read, because
 * those are exactly the values that go stale between a write and a stamp.
 */
export function currentPairEvidence(
  projectId: string,
  pairKey: string,
  project?: Project
): CurrentPairEvidence | null {
  const p = project ?? listProjects().find((x) => x.id === projectId)
  if (!p) return null

  const analysis = applyImageOverrides(readAnalysis(projectId), listOverrides(projectId))
  const feedIds = getFeedSequenceIds(p)

  /**
   * Pairs the ACCEPTED feed analysis covers — not pairs the feed
   * contains. Those are different claims, and conflating them reports
   * `feed-analysis` for a project that has never run one.
   */
  const accepted = readTransitionDraft(projectId)
  /**
   * AND accepted against the map that is still in force.
   *
   * A feed analysis is a set of per-pair verdicts about ONE version of
   * the property map — it is pinned to that version at accept time. If
   * the accepted map has changed since, those verdicts describe a
   * property the app no longer believes in, so the pair falls back to the
   * map itself and every prompt built from the old feed analysis reads as
   * stale. That is the correct answer: the evidence really did move.
   *
   * A feed analysis accepted before the identity was pinned has no value
   * to compare, and keeps covering as it always did.
   */
  const pinned = accepted?.acceptedAnalysisUpdatedAt
  const feedStillMatchesMap =
    pinned === undefined || pinned === null || pinned === analysis.updatedAt
  const coveredByFeedAnalysis =
    accepted?.status === 'accepted' &&
    feedStillMatchesMap &&
    (accepted.pairs ?? []).some((pair) => `${pair.fromId}->${pair.toId}` === pairKey)

  const resolved = resolvePairSpatialEvidence({
    pairKey,
    analysis,
    pairAnalysis: readPairAnalysis(projectId, pairKey),
    operatorContext: p.transitions[pairKey]?.operatorContext,
    coveredByFeedAnalysis: Boolean(coveredByFeedAnalysis),
    fingerprints: {
      feedFingerprint: feedIds.join('|'),
      libraryFingerprint: p.images.map((i) => i.id).join('|')
    }
  })

  return {
    source: resolved.source,
    fingerprint: evidenceFingerprintOf({
      source: resolved.source,
      analysisUpdatedAt: analysis.updatedAt ?? null,
      pairAnalyzedAt: resolved.individual?.analyzedAt ?? null,
      operatorContextAt: resolved.operatorContext?.createdAt ?? null,
      // THE IDENTITY OF THE FEED ANALYSIS ITSELF, pinned when it was
      // accepted. Deriving this from the live PropertyAnalysis timestamp
      // instead meant any later save of the map — an image override, a
      // re-accept — silently invalidated every prompt built from a feed
      // analysis that had not changed at all.
      feedAnalysisAcceptedAt: accepted?.acceptedAnalysisUpdatedAt ?? null
    }),
    operatorContextFingerprint: resolved.operatorContext
      ? String(resolved.operatorContext.createdAt)
      : undefined,
    pairKey,
    evidence: resolved
  }
}
