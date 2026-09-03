import type { Project } from '../../types'
import { getFeedSequenceIds, getFeedImages } from '../../../../shared/feedSequence'
import type { TransitionDraft } from '../../../../shared/transitionAnalysisExtractor'

/**
 * Transition Analysis Review — modal/panel showing analysis results for current feed.
 *
 * Displays each adjacent pair's recommendation:
 * - Image pair (visual + names)
 * - Safety level (SAFE / UNCERTAIN / UNSAFE)
 * - Recommendation (AI / CUT)
 * - Evidence/reasoning
 * - Prompt (if AI recommended)
 *
 * User can accept or decline to review further.
 */

export function TransitionAnalysisReview({
  project,
  draft,
  visible,
  onAccept,
  onDecline
}: {
  project: Project
  draft: TransitionDraft | null
  visible: boolean
  onAccept: () => void
  onDecline: () => void
}): React.JSX.Element | null {
  if (!visible || !draft) return null

  const feedIds = getFeedSequenceIds(project)
  const feedImages = getFeedImages(project)
  const currentFeedChanged = feedIds.length !== draft.feedImageIds.length ||
    !feedIds.every((id, i) => id === draft.feedImageIds[i])

  return (
    <div className="transition-analysis-review">
      <div className="transition-review-backdrop" onClick={onDecline} />
      <div className="transition-review-modal">
        <div className="transition-review-head">
          <h3>Transition Analysis Review</h3>
          <button
            type="button"
            className="transition-review-close"
            onClick={onDecline}
          >
            ✕
          </button>
        </div>

        {currentFeedChanged && (
          <div className="transition-review-warning">
            <p className="transition-review-warning-title">⚠ Feed Changed</p>
            <p className="transition-review-warning-text">
              Transition Feed has changed since this analysis. Results may not match current state.
              Re-analyse transitions to get updated recommendations.
            </p>
          </div>
        )}

        <div className="transition-review-body">
          <div className="transition-review-list">
            {draft.pairs.map((pair, index) => {
              const fromImg = project.images.find((i) => i.id === pair.fromId)
              const toImg = project.images.find((i) => i.id === pair.toId)

              return (
                <div key={`${pair.fromId}-${pair.toId}`} className="transition-review-item">
                  <div className="transition-review-pair">
                    <div className="transition-review-image">
                      {fromImg && (
                        <img src={fromImg.src} alt="" />
                      )}
                      <span className="transition-review-number">{index + 1}</span>
                    </div>
                    <div className="transition-review-arrow">→</div>
                    <div className="transition-review-image">
                      {toImg && (
                        <img src={toImg.src} alt="" />
                      )}
                      <span className="transition-review-number">{index + 2}</span>
                    </div>
                  </div>

                  <div className="transition-review-details">
                    <div className="transition-review-names">
                      <span>{fromImg?.fileName || 'Image'}</span>
                      <span className="transition-review-arrow-text">→</span>
                      <span>{toImg?.fileName || 'Image'}</span>
                    </div>

                    <div className="transition-review-recommendation">
                      <span className={`transition-review-mode mode-${pair.recommendation}`}>
                        {pair.recommendation === 'ai' ? '→ AI' : '→ CUT'}
                      </span>
                      {pair.safety && (
                        <span className={`transition-review-safety safety-${pair.safety.level}`}>
                          {pair.safety.level.toUpperCase()}
                        </span>
                      )}
                    </div>

                    {pair.safety?.reasoning && (
                      <p className="transition-review-evidence">
                        <span className="transition-review-evidence-label">Evidence:</span>
                        {pair.safety.reasoning}
                      </p>
                    )}

                    {pair.prompt && (
                      <div className="transition-review-prompt">
                        <span className="transition-review-prompt-label">Prompt:</span>
                        <p className="transition-review-prompt-text">{pair.prompt}</p>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <div className="transition-review-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={onAccept}
            disabled={currentFeedChanged}
            title={currentFeedChanged ? 'Re-analyse transitions first' : 'Accept this analysis'}
          >
            Accept Analysis
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onDecline}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
