import type { Project } from '../../types'
import { getFeedSequenceIds } from '../../../../shared/feedSequence'
import type { PropertyAnalysis } from '../../../../shared/propertyAnalysis'
import { isFeedSnapshotStale, isMediaLibrarySnapshotStale, type FeedSnapshot } from '../../../../shared/feedFingerprint'

/**
 * Toolbox state guards and workflow logic.
 * Determines what actions are available and why.
 */

export interface ActionGuard {
  allowed: boolean
  reason?: string // Why not allowed, for tooltip/help text
}

export interface ToolboxState {
  importedCount: number
  feedLength: number
  hasAnalysis: boolean
  hasMediaProposal: boolean
  analysisState: 'not-analyzed' | 'draft' | 'needs-review' | 'accepted'
  // Feed/media snapshots for staleness detection
  feedSnapshot?: FeedSnapshot | null
  mediaLibrarySnapshot?: { imageIds: string } | null
  isFeedStale?: boolean
  isMediaStale?: boolean
  /** Status of the persisted transition draft, absent when none exists. */
  transitionDraftStatus?: 'draft' | 'accepted' | 'declined' | null
  /** The stored draft describes a feed this project no longer has. */
  isTransitionAnalysisStale?: boolean
}

export function getToolboxState(
  project: Project,
  analysis: PropertyAnalysis | null,
  feedSnapshot?: FeedSnapshot | null,
  mediaLibrarySnapshot?: { imageIds: string } | null,
  /**
   * Whether a proposal is ACTUALLY held in state and reviewable right now.
   *
   * This used to be inferred from `analysis.transitionHints`, which is a
   * different fact entirely: hints exist whenever a property analysis has
   * been accepted, proposal or not. So "Review Media Proposal" could offer
   * to open a dialog with nothing in it, and could hide itself while a real
   * proposal was waiting.
   */
  hasLiveProposal?: boolean,
  /**
   * The persisted transition draft, when one was loaded for this project.
   * Passed in rather than re-read here so the panel stays the single
   * owner of that state.
   */
  transitionDraft?: { feedImageIds: string[]; status: 'draft' | 'accepted' | 'declined' } | null
): ToolboxState {
  const importedCount = project.images.length
  const feedSequenceIds = getFeedSequenceIds(project)
  const feedLength = feedSequenceIds.length
  const imageIds = project.images.map((i) => i.id)

  const isFeedStale = isFeedSnapshotStale(feedSequenceIds, feedSnapshot)
  const isMediaStale = isMediaLibrarySnapshotStale(imageIds, mediaLibrarySnapshot)

  // STALENESS IS RECOMPUTED, NOT TRUSTED. A stored `outdated` flag can be
  // missed — the feed can change in a session that never told the draft
  // about it — so the saved feed is compared against the live one on every
  // read. This comparison is the actual safety net.
  const isTransitionAnalysisStale = transitionDraft
    ? transitionDraft.feedImageIds.length !== feedSequenceIds.length ||
      !transitionDraft.feedImageIds.every((id, i) => id === feedSequenceIds[i])
    : false

  return {
    importedCount,
    feedLength,
    hasAnalysis: analysis !== null,
    hasMediaProposal: hasLiveProposal === true,
    analysisState: analysis?.state ?? 'not-analyzed',
    feedSnapshot,
    mediaLibrarySnapshot,
    isFeedStale,
    isMediaStale,
    transitionDraftStatus: transitionDraft?.status ?? null,
    isTransitionAnalysisStale
  }
}

/**
 * Can analyze imported media (whole-property analysis)
 * Requires: at least 1 imported image
 */
export function canAnalyzeImportedMedia(state: ToolboxState): ActionGuard {
  if (state.importedCount === 0) {
    return {
      allowed: false,
      reason: 'Import images first'
    }
  }
  return { allowed: true }
}

/**
 * Can analyze transitions in the feed
 * Requires: feed with at least 2 images
 */
export function canAnalyzeTransitions(state: ToolboxState): ActionGuard {
  if (state.feedLength < 2) {
    return {
      allowed: false,
      reason: `Need at least 2 images in Transition Feed (currently ${state.feedLength})`
    }
  }
  return { allowed: true }
}

/**
 * Can review media proposal (feed order suggestion)
 * Requires: media analysis exists with proposal
 */
export function canReviewMediaProposal(state: ToolboxState): ActionGuard {
  if (!state.hasMediaProposal) {
    return {
      allowed: false,
      reason: 'Analyse imported media first to generate a proposal'
    }
  }
  return { allowed: true }
}

/**
 * Can review transition analysis/prompts
 * Requires: transition analysis draft exists AND feed hasn't changed since analysis
 */
export function canReviewTransitionAnalysis(state: ToolboxState): ActionGuard {
  // Gated on the TRANSITION draft, not on the property-analysis workflow
  // state. Those are different questions: a project can have an accepted
  // property analysis and no transition analysis at all.
  if (!state.transitionDraftStatus) {
    return { allowed: false, reason: 'Analyse transitions to review' }
  }
  if (state.transitionDraftStatus === 'declined') {
    return { allowed: false, reason: 'This analysis was declined. Re-analyse transitions.' }
  }
  if (state.isTransitionAnalysisStale) {
    return {
      allowed: false,
      reason: 'Transition Feed changed since this analysis. Re-analyse transitions.'
    }
  }
  return { allowed: true }
}

/**
 * Get human-readable state summary
 */
export function getStateSummary(state: ToolboxState): {
  media: string
  feed: string
  mediaAnalysis: string
  transitionAnalysis: string
} {
  return {
    media: `${state.importedCount} image${state.importedCount === 1 ? '' : 's'}`,
    feed: `${state.feedLength} image${state.feedLength === 1 ? '' : 's'}`,
    mediaAnalysis:
      state.analysisState === 'not-analyzed'
        ? 'Not analysed'
        : state.analysisState === 'draft'
          ? 'Proposal ready'
          : 'Accepted',
    transitionAnalysis: transitionAnalysisSummary(state)
  }
}

/**
 * The transition-analysis line used to read "Not analysed" whatever had
 * happened, so an operator who had just accepted an analysis — or whose
 * analysis had been invalidated by a feed change — was told the same thing
 * as someone who had never run one.
 */
function transitionAnalysisSummary(state: ToolboxState): string {
  if (state.feedLength < 2) return 'Unavailable'
  if (!state.transitionDraftStatus) return 'Not analysed'
  if (state.isTransitionAnalysisStale) return 'Outdated — re-analyse transitions'
  if (state.transitionDraftStatus === 'accepted') return 'Accepted'
  if (state.transitionDraftStatus === 'declined') return 'Declined'
  return 'Draft ready for review'
}
