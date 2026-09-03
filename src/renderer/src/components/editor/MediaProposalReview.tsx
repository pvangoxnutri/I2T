import type { Project } from '../../types'
import type { PropertyAnalysis } from '../../../../shared/propertyAnalysis'
import { roomOfImage } from '../../../../shared/propertyAnalysis'
import { transitionKey } from '../../../../shared/types'
import {
  evaluateTransitionSafety,
  type SafetyLevel
} from '../../../../shared/transitionSafety'
import { assessAnalysisQuality, qualityHeadline } from '../../../../shared/analysisQuality'

/**
 * MEDIA PROPOSAL REVIEW — what the analyzer suggests, before it is applied.
 *
 * ── WHY THIS IS ITS OWN COMPONENT ────────────────────────────────────
 *
 * This dialog used to live inside MediaBrowser, which only mounts on the
 * Media tab. Driving the workflow from the Tools tab therefore produced a
 * proposal that existed in state and was never rendered — Accept and
 * Review both appeared to do nothing. It is rendered by the panel that
 * OWNS the proposal state instead, so it is reachable from every tab.
 *
 * ── ACCEPT IS NEVER A BLIND BUTTON ───────────────────────────────────
 *
 * Everything the decision rests on is on screen: which images were kept,
 * in what order, which were left out, how each joint will behave and the
 * analyzer's own reason for saying so. Nothing here is invented — a pair
 * the analyzer said nothing about says exactly that.
 */

export interface MediaProposal {
  sequence: string[]
  modes: Record<string, 'ai' | 'cut'>
  /** The analyzer result the proposal came from — the source of reasoning. */
  analysis: PropertyAnalysis | null
}

export function MediaProposalReview({
  project,
  proposal,
  visible,
  applying,
  error,
  onAccept,
  onDismiss
}: {
  project: Project
  proposal: MediaProposal | null
  visible: boolean
  applying: boolean
  error: string | null
  onAccept: () => void
  onDismiss: () => void
}): React.JSX.Element | null {
  if (!visible) return null

  const imageById = new Map(project.images.map((img) => [img.id, img]))
  const selected = proposal?.sequence ?? []
  const selectedSet = new Set(selected)
  const excluded = project.images.filter((img) => !selectedSet.has(img.id))

  /**
   * A result that cannot be right. Not a hardcoded minimum feed length —
   * a two-image property legitimately proposes two — but keeping one or
   * none out of a substantial library means selection failed, not that
   * the photographs were worthless.
   */
  const suspicious = project.images.length >= 5 && selected.length <= 1

  /**
   * HOW WELL THE PROPERTY WAS MAPPED.
   *
   * A thin analysis used to be presented exactly like a strong one: the
   * proposal looked confident, every thumbnail read "No room", and
   * nothing said the mapping was too weak to trust. Coverage is stated
   * before the list, and an unusable mapping blocks Accept — a feed whose
   * AI decisions rest on nothing is not something to click past.
   */
  const quality = assessAnalysisQuality(
    proposal?.analysis ?? null,
    project.images.map((i) => i.id)
  )
  const mappingUnusable = quality.level === 'unusable'

  /**
   * WHY THIS PAIR GOT THE ANSWER IT GOT.
   *
   * ── THE BUG THIS REPLACES ────────────────────────────────────────
   *
   * This used to read ONLY `analysis.transitionHints`, and printed "No
   * analyzer detail for this pair" whenever a hint was missing — which
   * was always, because the hints were never parsed. So every row said
   * the system knew nothing, while the evaluator that actually made the
   * decision had a specific, quotable reason for each one. The review
   * looked broken because it was describing a different thing from the
   * one deciding.
   *
   * The reason now comes from `evaluateTransitionSafety` — the same call
   * that produced the mode — so the explanation shown is by construction
   * the explanation used. A Gemini hint, when there is one, is appended
   * as additional colour; it can never be the only thing on the row.
   */
  const explain = (
    fromId: string,
    toId: string
  ): { safety: SafetyLevel; reason: string; hint: string | null } => {
    const verdict = evaluateTransitionSafety(proposal?.analysis ?? null, fromId, toId)
    const rawHint = proposal?.analysis?.transitionHints?.find(
      (h) => h.fromImageId === fromId && h.toImageId === toId
    )
    const hint =
      rawHint?.notes ??
      (rawHint?.anchorLandmark ? `Anchored on ${rawHint.anchorLandmark}` : null) ??
      rawHint?.suggestedMotion ??
      null
    return { safety: verdict.safety, reason: verdict.reason, hint }
  }

  return (
    <div className="media-proposal">
      <div className="media-proposal-backdrop" onClick={applying ? undefined : onDismiss} />
      <div className="media-proposal-dialog">
        <div className="media-proposal-head">
          <h3>Suggested Feed</h3>
          <button
            type="button"
            className="media-proposal-close"
            onClick={onDismiss}
            disabled={applying}
          >
            ✕
          </button>
        </div>

        {/* NO PROPOSAL IS A STATE, NOT AN EMPTY DIALOG WITH A LIVE BUTTON. */}
        {!proposal ? (
          <>
            <div className="media-proposal-preview">
              <p className="media-proposal-error">No proposal available to accept.</p>
              <p className="media-proposal-info">
                Run “Analyse imported media” to produce a suggested feed.
              </p>
            </div>
            <div className="media-proposal-actions">
              <button type="button" className="media-proposal-reject" onClick={onDismiss}>
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="media-proposal-preview">
              <p className="media-proposal-info">
                Keeping <strong>{selected.length}</strong> of {project.images.length} imported
                images
                {excluded.length > 0 ? <> · leaving out {excluded.length}</> : null}.
              </p>

              {/* A PROPOSAL THAT KEEPS ALMOST NOTHING IS A BUG REPORT.
                  Selection removing an entire library has happened, and
                  accepting it would replace a working feed with an empty
                  one. Treated as suspect rather than offered as a choice. */}
              {quality.level !== 'good' && (
                <div
                  className={`media-proposal-quality is-${quality.level}`}
                  role={mappingUnusable ? 'alert' : undefined}
                >
                  <p className="media-proposal-quality-title">{qualityHeadline(quality)}</p>
                  <ul>
                    {quality.problems.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                  <p className="media-proposal-quality-counts">
                    {quality.assignedCount} of {quality.imageCount} images placed in a room ·{' '}
                    {quality.roomCount} rooms · {quality.roomsWithMultipleViews} seen from more than
                    one viewpoint · {quality.confirmedEdgeCount} confirmed connections
                  </p>
                  {mappingUnusable && (
                    <p>
                      Re-analyse the imported media, or build the Transition Feed manually by
                      dragging images into it.
                    </p>
                  )}
                </div>
              )}

              {suspicious && (
                <div className="media-proposal-suspect">
                  <p className="media-proposal-suspect-title">
                    No usable feed was produced.
                  </p>
                  <p>
                    Selection removed {selected.length === 0 ? 'every' : 'almost every'} imported
                    image, which is not a normal result for {project.images.length} photographs.
                    Re-analyse the imported media, or build the feed manually by dragging images
                    into the Transition Feed.
                  </p>
                </div>
              )}

              <ol className="media-proposal-list">
                {selected.map((imageId, i) => {
                  const img = imageById.get(imageId)
                  const nextId = selected[i + 1]
                  const room = proposal.analysis
                    ? roomOfImage(proposal.analysis, imageId)?.label
                    : null
                  const key = nextId ? transitionKey(imageId, nextId) : null
                  const mode = key ? proposal.modes[key] : null
                  const detail = nextId ? explain(imageId, nextId) : null

                  return (
                    <li key={`${imageId}-${i}`}>
                      <div className="media-proposal-item">
                        <span className="media-proposal-index">{i + 1}</span>
                        {img && <img className="media-proposal-thumb" src={img.src} alt="" />}
                        <span className="media-proposal-filename">
                          {img?.fileName ?? 'Missing image'}
                        </span>
                        {room && <span className="media-proposal-room">{room}</span>}
                      </div>

                      {nextId && detail && (
                        <div className="media-proposal-joint">
                          <span className={`media-proposal-mode mode-${mode ?? 'auto'}`}>
                            {mode === 'ai' ? 'AI' : mode === 'cut' ? 'CUT' : 'AUTO'}
                          </span>
                          <span className={`media-proposal-safety safety-${detail.safety}`}>
                            {detail.safety.toUpperCase()}
                          </span>
                          <span className="media-proposal-reason">
                            {detail.reason}
                            {detail.hint && (
                              <span className="media-proposal-hint"> — {detail.hint}</span>
                            )}
                          </span>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ol>

              {excluded.length > 0 && (
                <details className="media-proposal-excluded">
                  <summary>Left out of the feed ({excluded.length})</summary>
                  <ul>
                    {excluded.map((img) => (
                      <li key={img.id}>{img.fileName}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>

            <div className="media-proposal-actions">
              {error && <p className="media-proposal-error">{error}</p>}
              <button
                type="button"
                className="media-proposal-accept"
                onClick={onAccept}
                disabled={applying || selected.length === 0 || suspicious || mappingUnusable}
                title={
                  suspicious ? 'This proposal kept almost nothing — re-analyse instead' : undefined
                }
              >
                {applying ? 'Applying…' : `Accept feed (${selected.length})`}
              </button>
              <button
                type="button"
                className="media-proposal-reject"
                onClick={onDismiss}
                disabled={applying}
              >
                Dismiss
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
