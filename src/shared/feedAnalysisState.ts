import type { TransitionDraft } from './transitionAnalysisExtractor'

/**
 * IS THE FEED ANALYSIS STILL ABOUT THIS PROJECT?
 *
 * ── TWO FINGERPRINTS, NOT ONE ────────────────────────────────────────
 *
 * A feed analysis rests on two things, and either can move underneath it:
 *
 *   THE FEED    — the ordered images and therefore the exact adjacent
 *                 pairs that were judged. Reorder it and the judgements
 *                 describe transitions the video no longer contains.
 *
 *   THE LIBRARY — every imported photograph, because Analyse Feed uses
 *                 the whole library as EVIDENCE. An image that never
 *                 appears in the video can still be what proved two that
 *                 do belong to the same room. Remove it and that proof is
 *                 gone; add one and there is evidence the analysis never
 *                 saw.
 *
 * Tracking only the feed was the tempting simplification, and it would
 * have quietly kept an analysis whose supporting evidence had changed.
 *
 * ── RECOMPUTED, NEVER TRUSTED ────────────────────────────────────────
 *
 * Staleness is derived from the live project every time it is asked for.
 * A stored `outdated` flag can be missed — the feed can change in a
 * session that never tells the draft about it — so the flag is a cache
 * and this comparison is the actual answer.
 */

export type FeedAnalysisState =
  /** The feed is too short to contain a transition. */
  | 'unavailable'
  | 'not-analysed'
  | 'draft'
  | 'accepted'
  | 'declined'
  /** A draft exists but describes a feed or library that has since moved. */
  | 'outdated'

export interface FeedAnalysisStatus {
  state: FeedAnalysisState
  /** True when the ordered feed no longer matches what was analysed. */
  feedChanged: boolean
  /** True when the imported library no longer matches. */
  libraryChanged: boolean
  /** One sentence for the Toolbox. Empty when there is nothing to say. */
  detail: string
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

/**
 * Library membership is compared as a SET: importing changes the evidence
 * base, but the order photographs happen to sit in the library does not.
 */
function sameMembership(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(b)
  return a.every((id) => set.has(id))
}

export function feedAnalysisStatus(
  draft: TransitionDraft | null | undefined,
  currentFeedIds: readonly string[],
  currentLibraryIds: readonly string[]
): FeedAnalysisStatus {
  if (currentFeedIds.length < 2) {
    return {
      state: 'unavailable',
      feedChanged: false,
      libraryChanged: false,
      detail: 'Add at least two images to the Transition Feed.'
    }
  }
  if (!draft) {
    return { state: 'not-analysed', feedChanged: false, libraryChanged: false, detail: '' }
  }

  const feedChanged = !sameOrder(draft.feedImageIds, currentFeedIds)
  // Absent on drafts written before the library was fingerprinted. Absence
  // is not evidence of a change, so it does not raise staleness on its own.
  const libraryChanged = draft.mediaImageIds
    ? !sameMembership(draft.mediaImageIds, currentLibraryIds)
    : false

  if (feedChanged || libraryChanged) {
    return {
      state: 'outdated',
      feedChanged,
      libraryChanged,
      detail: feedChanged
        ? 'The Transition Feed changed since this analysis. Re-analyse the feed.'
        : 'Imported media changed since this analysis, so its supporting evidence did too. Re-analyse the feed.'
    }
  }

  if (draft.status === 'declined') {
    return {
      state: 'declined',
      feedChanged: false,
      libraryChanged: false,
      detail: 'This analysis was declined. Re-analyse the feed to review again.'
    }
  }

  return {
    state: draft.status === 'accepted' ? 'accepted' : 'draft',
    feedChanged: false,
    libraryChanged: false,
    detail: ''
  }
}

/** Short label for a status row. */
export function feedAnalysisLabel(status: FeedAnalysisStatus): string {
  switch (status.state) {
    case 'unavailable':
      return 'Unavailable'
    case 'not-analysed':
      return 'Not analysed'
    case 'draft':
      return 'Draft ready'
    case 'accepted':
      return 'Accepted'
    case 'declined':
      return 'Declined'
    case 'outdated':
      return 'Outdated'
  }
}
