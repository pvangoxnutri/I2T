import { getDb, scheduleFlush } from '../db/index'
import { listProjects, saveProject } from '../db/projectsRepo'
import { readAnalysisDraft, saveAnalysis, readAnalysis } from '../db/analysisRepo'
import { saveTransitionDraft } from '../db/transitionAnalysisRepo'
import { rebuildPromptsFromAnalysis } from './promptService'
import { getFeedSequenceIds } from '../../shared/feedSequence'
import { transitionKey, type TransitionSettings } from '../../shared/types'
import type { TransitionDraft } from '../../shared/transitionAnalysisExtractor'

/**
 * ACCEPT FEED ANALYSIS — one operation, one transaction.
 *
 * ── THE BUG THIS EXISTS FOR ──────────────────────────────────────────
 *
 * Accepting used to be a loop in the renderer that wrote per-pair modes
 * and marked the feed draft accepted. It never promoted the PROPERTY
 * ANALYSIS the run had produced. Recovered from the operator's own
 * database:
 *
 *   accepted PropertyAnalysis   2026-08-31   11 rooms, no reflectiveSurfaces
 *   draft PropertyAnalysis      2026-09-06    8 rooms, mirror described
 *   accepted feed analysis      2026-09-06   built from the DRAFT
 *
 * So the feed analysis said the bathroom pair was `ai / safe` — it had
 * read the new analysis, which knew the mirror reflects "white doorway,
 * beige wall tile". Generation preflight then read the ACCEPTED
 * analysis, five weeks old, where the mirror is only the landmark string
 * "mirror reflection" with nothing behind it, and refused:
 *
 *   "This AI transition no longer has sufficient accepted spatial
 *    evidence... (A large mirror is visible, but the analysis cannot
 *    determine what should appear in its reflection...)"
 *
 * Two analyses, two answers, one pair. Accept is therefore a single
 * operation that promotes the map and applies the decisions together, or
 * does neither.
 *
 * ── AND IT NO LONGER ERASES THE OPERATOR ─────────────────────────────
 *
 * The old loop set `modeProvenance: 'analysis'` on EVERY pair. An
 * operator who resolved a needs-context pair seconds earlier — mode
 * `ai`, provenance `manual` — had that overwritten by the analyzer's own
 * recommendation the moment they pressed Accept. Their decision vanished
 * with no message. `manual` is now preserved.
 */

export interface AcceptResult {
  ok: boolean
  reason?: string
  /** AI pairs whose wording was rebuilt from the newly accepted map. */
  promptsUpdated: number
  /** Hand-written prompts left alone. */
  manualPromptsPreserved: number
  /** Pairs still waiting on the operator; deliberately given no prompt. */
  stillNeedContext: number
  /** Decisions the operator made that Accept honoured rather than reset. */
  operatorDecisionsPreserved: number
}

/**
 * Everything Accept writes, in one SQLite transaction.
 *
 * The four stores it touches — accepted PropertyAnalysis, feed-analysis
 * state, transition rows, prompt basis — live in the same database, so
 * there is no reason for a half-applied accept to be possible. A failure
 * rolls back to exactly the state before the click.
 *
 * SAVEPOINT rather than BEGIN because the writes below call repository
 * functions that manage their own units of work, and SQLite refuses a
 * nested BEGIN. A savepoint nests and still gives all-or-nothing.
 */
export function acceptFeedAnalysis(projectId: string, draft: TransitionDraft): AcceptResult {
  const project = listProjects().find((p) => p.id === projectId)
  if (!project) return empty('Project not found')

  // ── A. VALIDATE AGAINST THE CURRENT FEED ──────────────────────────
  const feedIds = getFeedSequenceIds(project)
  const sameFeed =
    feedIds.length === draft.feedImageIds.length &&
    feedIds.every((id, i) => id === draft.feedImageIds[i])
  if (!sameFeed) {
    return empty('The Transition Feed changed since this analysis. Re-analyse the feed.')
  }
  const feedPairs = new Set(
    feedIds.slice(0, -1).map((id, i) => transitionKey(id, feedIds[i + 1]))
  )
  for (const pair of draft.pairs) {
    if (!feedPairs.has(transitionKey(pair.fromId, pair.toId))) {
      return empty('This analysis describes pairs the current feed does not contain.')
    }
  }

  const db = getDb()
  db.run('SAVEPOINT accept_feed')
  try {
    // ── B. PROMOTE THE MAP THE ANALYSIS WAS BUILT FROM ──────────────
    //
    // THE LINE THAT WAS MISSING. Without it every downstream reader
    // keeps consulting the previous accepted analysis, and the feed
    // analysis the operator just approved describes a property the rest
    // of the app cannot see.
    const pending = readAnalysisDraft(projectId)
    const acceptedAnalysis = pending
      ? saveAnalysis({
          ...pending,
          state: 'accepted',
          provenance: pending.provenance
            ? { ...pending.provenance, acceptedAt: Date.now() }
            : pending.provenance
        })
      : readAnalysis(projectId)

    // ── C + D + E. PAIR DECISIONS, WITHOUT ERASING THE OPERATOR ─────
    const live = listProjects().find((p) => p.id === projectId)!
    let operatorDecisionsPreserved = 0
    let stillNeedContext = 0

    for (const pair of draft.pairs) {
      const key = transitionKey(pair.fromId, pair.toId)
      const existing = live.transitions[key]
      const decision = pair.decision ?? pair.recommendation

      // A DECISION THE OPERATOR MADE OUTRANKS THE ANALYZER'S.
      // They made it against this same analysis, seconds ago.
      if (existing?.modeProvenance === 'manual') {
        operatorDecisionsPreserved++
        continue
      }

      if (decision === 'needs-context') {
        // NOT converted to anything. An unanswered question is not a
        // decision, and writing `cut` here would hide it forever.
        stillNeedContext++
        continue
      }

      const patch: Partial<TransitionSettings> = {
        mode: decision === 'ai' ? 'ai' : 'cut',
        modeProvenance: 'analysis'
      }
      // A hand-written prompt outranks the analyzer, always.
      if (pair.prompt && !existing?.promptProvenance?.manuallyEdited) {
        patch.prompt = pair.prompt
      }
      live.transitions[key] = { ...(existing ?? blankTransition()), ...patch }
    }

    live.updatedAt = Date.now()
    saveProject(live)

    // ── F. THE FEED ANALYSIS ITSELF — BEFORE THE WORDING ────────────
    //
    // ORDER MATTERS, and getting it wrong blocked eight AI pairs in the
    // operator's project. The rebuild below stamps each prompt with what
    // the canonical resolver says governs that pair. The resolver reports
    // `feed-analysis` only when an ACCEPTED feed analysis covers the pair
    // — so rebuilding first meant it could not yet see this one and
    // answered `global-analysis`. Preflight, running after this write,
    // answered `feed-analysis`. Two honest answers about two different
    // moments, and every prompt in between reading as stale.
    //
    // The feed analysis is therefore accepted first, and the wording is
    // stamped against the state that will still be true when generation
    // asks. Both writes are inside the same savepoint, so an ordering
    // that is correct for the resolver costs nothing in atomicity.
    saveTransitionDraft(projectId, {
      ...draft,
      status: 'accepted',
      // Pinned to the map it was accepted against, so a later analysis
      // can tell that this one is no longer current — and so the feed
      // fingerprint has an identity of its own that does not move when
      // the map is re-saved for unrelated reasons.
      acceptedAnalysisUpdatedAt: acceptedAnalysis.updatedAt
    } as TransitionDraft)

    // ── G. WORDING, FROM THE MAP AND FEED ANALYSIS NOW IN FORCE ─────
    const rebuild = rebuildPromptsFromAnalysis(projectId)

    db.run('RELEASE accept_feed')
    scheduleFlush()
    return {
      ok: true,
      promptsUpdated: rebuild.rebuiltCount,
      manualPromptsPreserved: rebuild.preservedCount,
      stillNeedContext: Math.max(stillNeedContext, rebuild.needsContextCount),
      operatorDecisionsPreserved
    }
  } catch (err) {
    db.run('ROLLBACK TO accept_feed')
    db.run('RELEASE accept_feed')
    console.error('[accept-feed-analysis] rolled back', err)
    return empty(err instanceof Error ? err.message : 'Accepting the analysis failed.')
  }
}

function blankTransition(): TransitionSettings {
  return { prompt: '', durationSec: 5, status: 'not-generated', clip: null }
}

function empty(reason: string): AcceptResult {
  return {
    ok: false,
    reason,
    promptsUpdated: 0,
    manualPromptsPreserved: 0,
    stillNeedContext: 0,
    operatorDecisionsPreserved: 0
  }
}
