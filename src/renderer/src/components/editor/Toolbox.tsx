import type { Project } from '../../types'
import type { PropertyAnalysis } from '../../../../shared/propertyAnalysis'
import type { TransitionDraft } from '../../../../shared/transitionAnalysisExtractor'
import { getFeedSequenceIds } from '../../../../shared/feedSequence'
import { feedAnalysisLabel, feedAnalysisStatus } from '../../../../shared/feedAnalysisState'

/**
 * THE WORKFLOW PANEL — three questions, three actions, never merged.
 *
 * ── WHY THE SEPARATION IS THE POINT ──────────────────────────────────
 *
 * A single "Analyse Transitions" button hid three genuinely different
 * questions behind one word, and an operator could not tell which one
 * they were about to ask — or pay for:
 *
 *   MEDIA    Which photographs belong in the film, and in what order?
 *            The ONLY action allowed to propose a feed.
 *
 *   FEED     Given EXACTLY this order, what is true about each adjacent
 *            transition, and is a generated camera move defensible?
 *            Never adds, removes or reorders an image.
 *
 *   PROMPTS  Given evidence already accepted, what should the generation
 *            prompt actually say? Writes wording only.
 *
 * Collapsing any two of these is what made the app feel unpredictable,
 * so they are three groups with three statuses that never share a label.
 *
 * ── NOTHING SILENT ───────────────────────────────────────────────────
 *
 * Every action either does something visible or is disabled with the
 * reason written next to it. An action that cannot apply at all is
 * hidden rather than shown greyed with no explanation.
 */

export interface PromptStatus {
  /** Feed pairs that will be generated and therefore need wording. */
  eligible: number
  /** Of those, how many carry an analysis-derived prompt. */
  analysed: number
  /** Hand-written prompts, which an All run will not touch. */
  manual: number
}

export function Toolbox({
  project,
  analysis,
  transitionDraft,
  promptStatus,
  hasProposal,
  selectedPairKey,
  busy,
  onAnalyseImportedMedia,
  onReviewMediaProposal,
  onAnalyseFeed,
  onReviewFeedAnalysis,
  onAnalysePromptsAll,
  onAnalysePromptSelected
}: {
  project: Project
  analysis: PropertyAnalysis | null
  transitionDraft: TransitionDraft | null
  promptStatus: PromptStatus
  hasProposal: boolean
  /** The transition currently selected in the editor, if any. */
  selectedPairKey: string | null
  /** Which action is in flight, so a second click cannot start a second run. */
  busy: 'media' | 'feed' | 'prompts' | 'prompt-selected' | null
  onAnalyseImportedMedia: () => void
  onReviewMediaProposal: () => void
  onAnalyseFeed: () => void
  onReviewFeedAnalysis: () => void
  onAnalysePromptsAll: () => void
  onAnalysePromptSelected: () => void
}): React.JSX.Element {
  const importedCount = project.images.length
  const feedIds = getFeedSequenceIds(project)
  const libraryIds = project.images.map((i) => i.id)
  const feedStatus = feedAnalysisStatus(transitionDraft, feedIds, libraryIds)

  const mediaState =
    analysis && analysis.rooms.length > 0
      ? analysis.state === 'accepted'
        ? 'Accepted'
        : 'Draft ready'
      : hasProposal
        ? 'Draft ready'
        : 'Not analysed'

  // The selected pair must be one the CURRENT feed actually contains —
  // a stale selection is the state that once reached a paid dialog.
  const selectedIsCurrent =
    selectedPairKey !== null &&
    feedIds.some((id, i) => i < feedIds.length - 1 && `${id}->${feedIds[i + 1]}` === selectedPairKey)

  const promptsBlockedReason =
    importedCount === 0
      ? 'Import images first.'
      : feedIds.length < 2
        ? 'Add at least two images to the Transition Feed.'
        : !analysis || analysis.rooms.length === 0
          ? 'No accepted spatial analysis yet. Analyse the feed and accept it first.'
          : feedStatus.state === 'outdated'
            ? feedStatus.detail
            : promptStatus.eligible === 0
              ? 'No AI transitions in the current feed.'
              : null

  return (
    <div className="toolbox">
      {/* ── MEDIA ──────────────────────────────────────────────────── */}
      <section className="toolbox-group">
        <h4 className="toolbox-group-title">Media</h4>
        <p className="toolbox-status">
          Imported Media Analysis: <strong>{mediaState}</strong> · {importedCount} image
          {importedCount === 1 ? '' : 's'}
        </p>

        {importedCount === 0 ? (
          <p className="toolbox-help">Import images to get started.</p>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-primary btn-small"
              disabled={busy !== null}
              onClick={onAnalyseImportedMedia}
            >
              {busy === 'media'
                ? 'Analysing…'
                : mediaState === 'Not analysed'
                  ? 'Analyse Imported Media'
                  : 'Re-analyse Imported Media'}
            </button>
            <p className="toolbox-help">
              Suggests which images to use and in what order. The only analysis that proposes a
              feed.
            </p>
            {hasProposal && (
              <button
                type="button"
                className="btn btn-ghost btn-small"
                onClick={onReviewMediaProposal}
              >
                Review Media Proposal
              </button>
            )}
          </>
        )}
      </section>

      {/* ── FEED ───────────────────────────────────────────────────── */}
      <section className="toolbox-group">
        <h4 className="toolbox-group-title">Feed</h4>
        <p className="toolbox-status">
          Feed Analysis: <strong>{feedAnalysisLabel(feedStatus)}</strong> · {feedIds.length} image
          {feedIds.length === 1 ? '' : 's'}
        </p>
        {feedStatus.detail && <p className="toolbox-help">{feedStatus.detail}</p>}

        {feedIds.length < 2 ? (
          <p className="toolbox-help">
            Build a Transition Feed first — drag images in, or accept a media proposal.
          </p>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-primary btn-small"
              disabled={busy !== null}
              onClick={onAnalyseFeed}
            >
              {busy === 'feed'
                ? 'Analysing…'
                : feedStatus.state === 'not-analysed'
                  ? 'Analyse Feed'
                  : 'Re-analyse Feed'}
            </button>
            <p className="toolbox-help">
              Judges the {Math.max(feedIds.length - 1, 0)} transition
              {feedIds.length - 1 === 1 ? '' : 's'} in your chosen order. Never changes the order.
            </p>
            {(feedStatus.state === 'draft' || feedStatus.state === 'accepted') && (
              <button
                type="button"
                className="btn btn-ghost btn-small"
                onClick={onReviewFeedAnalysis}
              >
                Review Feed Analysis
              </button>
            )}
          </>
        )}
      </section>

      {/* ── PROMPTS ────────────────────────────────────────────────── */}
      <section className="toolbox-group">
        <h4 className="toolbox-group-title">Prompts</h4>
        <p className="toolbox-status">
          Prompts: <strong>{promptStatus.analysed} / {promptStatus.eligible}</strong> AI transitions
          analysed
          {promptStatus.manual > 0 && (
            <> · {promptStatus.manual} manual prompt{promptStatus.manual === 1 ? '' : 's'} protected</>
          )}
        </p>

        {promptsBlockedReason ? (
          <p className="toolbox-help">{promptsBlockedReason}</p>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-primary btn-small"
              disabled={busy !== null}
              onClick={onAnalysePromptsAll}
            >
              {busy === 'prompts' ? 'Analysing…' : 'Analyse Prompts — All'}
            </button>
            <p className="toolbox-help">
              Writes camera instructions from accepted evidence. Hand-written prompts are left
              alone.
            </p>
          </>
        )}

        {/* Shown only when it can mean something: a transition is selected
            AND it is one the current feed still contains. */}
        {selectedPairKey !== null && (
          <>
            <button
              type="button"
              className="btn btn-ghost btn-small"
              disabled={busy !== null || !selectedIsCurrent || promptsBlockedReason !== null}
              onClick={onAnalysePromptSelected}
            >
              {busy === 'prompt-selected' ? 'Analysing…' : 'Analyse Prompt — Selected'}
            </button>
            {!selectedIsCurrent && (
              <p className="toolbox-help">
                The selected transition is not part of the current Transition Feed.
              </p>
            )}
          </>
        )}
      </section>
    </div>
  )
}
