import { useState } from 'react'
import { useAppState } from '../../state/AppState'
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
  onDecline,
  onRefresh
}: {
  project: Project
  draft: TransitionDraft | null
  visible: boolean
  onAccept: () => void
  onDecline: () => void
  /** Re-read the project after a per-pair decision is stored. */
  onRefresh?: () => void
}): React.JSX.Element | null {
  /** Unsaved edits per pair, so typing in one row never touches another. */
  const { updateTransition } = useAppState()
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string | null>(null)
  /** A failure the operator must see — never a silent no-op. */
  const [error, setError] = useState<string | null>(null)
  /**
   * Per-pair decisions made in THIS review session.
   *
   * The draft's own `decision` is frozen at analysis time. Persisting a
   * mode therefore changed the database and nothing on screen — which is
   * indistinguishable from a button that does not work, and is what was
   * actually reported. The row now re-renders from what the operator
   * just chose.
   */
  const [resolved, setResolved] = useState<Record<string, 'ai' | 'cut' | undefined>>({})

  /** Text that still counts as evidence. Withdrawn text returns null. */
  const activeContextText = (key: string): string | null => {
    const c = project.transitions[key]?.operatorContext
    return c && (c.status ?? 'current') === 'current' ? c.text : null
  }

  /** Text kept but no longer trusted, awaiting the operator's review. */
  const staleContextText = (key: string): string | null => {
    const c = project.transitions[key]?.operatorContext
    return c && c.status === 'needs-review' ? c.text : null
  }
  /** The pair whose no-context approval is being confirmed. */
  const [confirmBlind, setConfirmBlind] = useState<{
    from: string
    to: string
    key: string
  } | null>(null)

  /**
   * APPROVE — with the operator's own words when they wrote any.
   *
   * The two paths differ honestly rather than cosmetically. WITH text,
   * the unknown is genuinely resolved and the prompt gains real property
   * knowledge. WITHOUT it nothing was resolved — the operator simply
   * decided to proceed, which is an override and is confirmed as one.
   *
   * Either way the mode is stored with `manual` provenance: the analysis
   * did not reach this conclusion on its own, and the history must keep
   * saying so.
   */
  /**
   * ── WHY EVERY HANDLER IS WRAPPED ────────────────────────────────────
   *
   * `saving` disables the row's buttons. Without a `finally`, ANY throw —
   * a missing bridge method, a rejected IPC — left it set forever, and
   * the buttons stayed permanently disabled with nothing on screen. That
   * is indistinguishable from "the button does not work", which is
   * exactly the reported symptom.
   *
   * So the flag is always cleared and the failure is always shown. A
   * click now produces an action or a message, never silence.
   */
  const run = async (key: string, work: () => Promise<void>): Promise<void> => {
    console.log('[feed-review] run start pair=' + key)
    setSaving(key)
    setError(null)
    try {
      await work()
      onRefresh?.()
    } catch (err) {
      console.error('[feed-review] error pair=' + key, err)
      setError(err instanceof Error ? err.message : 'That action could not be completed.')
    } finally {
      setSaving(null)
    }
  }

  const approve = async (from: string, to: string, key: string): Promise<void> => {
    const text = (drafts[key] ?? activeContextText(key) ?? '').trim()
    if (text.length === 0) {
      setConfirmBlind({ from, to, key })
      return
    }
    await run(key, async () => {
      // Stored as CURRENT against this analysis: the operator has just
      // read the new verdict and written this in response to it.
      //
      // This used to save the context and set the mode, and stop there.
      // The prompt kept its old wording and — worse — no record of what
      // it was based on, so the generation gate saw a pair whose evidence
      // said `operator` and whose prompt said nothing, and refused it.
      // Approving now rebuilds and stamps in the same operation.
      console.log('[feed-review] approve-with-context ipc start pair=' + key)
      const res = await window.f2f.projects.pairAnalysis.approve(project.id, key, 'ai', text)
      if (!res.ok) throw new Error(res.reason ?? 'The approval could not be saved.')
      setResolved((r) => ({ ...r, [key]: 'ai' }))
      console.log(
        `[feed-review] approve-with-context ok pair=${key} basis=${res.evidenceSource}`
      )
    })
  }

  const approveWithoutContext = async (from: string, to: string): Promise<void> => {
    const key = `${from}->${to}`
    await run(key, async () => {
      console.log('[feed-review] approve-no-context pair=' + key)
      // No text, so nothing to store — but the wording still has to be
      // rebuilt and stamped, or this pair is left in the same unprovable
      // state as the one above.
      const res = await window.f2f.projects.pairAnalysis.approve(project.id, key, 'ai', '')
      if (!res.ok) throw new Error(res.reason ?? 'The approval could not be saved.')
      setResolved((r) => ({ ...r, [key]: 'ai' }))
      setConfirmBlind(null)
    })
  }

  const keepAsCut = async (from: string, to: string, key: string): Promise<void> => {
    // The operator's words are NOT deleted — they may be right about the
    // room even if this joint should cut. They simply stay withdrawn,
    // which is what `needs-review` already means.
    await run(key, async () => {
      console.log('[feed-review] keep-cut click pair=' + key)
      // Same single operation as approving — it records the decision and
      // leaves the stored text alone (undefined, not '').
      const res = await window.f2f.projects.pairAnalysis.approve(project.id, key, 'cut')
      if (!res.ok) throw new Error(res.reason ?? 'The decision could not be saved.')
      setResolved((r) => ({ ...r, [key]: 'cut' }))
      console.log('[feed-review] keep-cut persisted pair=' + key)
    })
  }

  /** Remove the stored text entirely. History keeps its own snapshots. */
  const clearContext = async (key: string): Promise<void> => {
    await run(key, async () => {
      await window.f2f.projects.transitions.setOperatorContext(project.id, key, '')
      setDrafts((d) => ({ ...d, [key]: '' }))
    })
  }

  /** Re-confirm old text against the NEW analysis, unchanged. */
  const keepContext = async (key: string, text: string): Promise<void> => {
    await run(key, async () => {
      await window.f2f.projects.transitions.setOperatorContext(project.id, key, text)
    })
  }

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
              const key = `${pair.fromId}->${pair.toId}`
              const decision: 'ai' | 'cut' | 'needs-context' =
                resolved[key] ?? pair.decision ?? pair.recommendation
              const saved = activeContextText(key)
              const stale = staleContextText(key)
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
                      {/* THREE OUTCOMES, NOT TWO.
                          A pair held only because one fact is missing must
                          not read as a refusal — the operator usually
                          knows the fact. */}
                      <span
                        className={`transition-review-mode mode-${decision === 'needs-context' ? 'needs-context' : pair.recommendation}`}
                      >
                        {decision === 'ai'
                          ? '→ AI'
                          : decision === 'needs-context'
                            ? '→ MISSING CONTEXT'
                            : '→ CUT'}
                      </span>
                      {pair.safety && (
                        <span className={`transition-review-safety safety-${pair.safety.level}`}>
                          {pair.safety.level === 'needs-context'
                            ? 'NEEDS CONTEXT'
                            : pair.safety.level.toUpperCase()}
                        </span>
                      )}
                    </div>

                    {pair.safety?.reasoning && (
                      <p className="transition-review-evidence">
                        <span className="transition-review-evidence-label">Evidence:</span>
                        {pair.safety.reasoning}
                      </p>
                    )}

                    {/* ── THE MISSING FACT, AND A PLACE TO SUPPLY IT ──
                        Asking beats refusing: the operator has usually
                        been in the room, and re-running a paid analysis
                        to learn one sentence would be absurd. */}
                    {/* ── OLD CONTEXT, VISIBLE AND REMOVABLE ────────
                        Shown for EVERY row that has it, not only
                        needs-context ones: the whole failure was text
                        acting invisibly, so hiding it behind a verdict
                        would reproduce the bug in a narrower form. */}
                    {stale && (
                      <div className="transition-review-stale">
                        <p className="transition-review-stale-title">
                          Previous operator context — review required
                        </p>
                        <p className="transition-review-stale-text">{stale}</p>
                        <p className="transition-review-stale-note">
                          Written before the latest Feed Analysis. It is NOT being used in new
                          prompts until you confirm it.
                        </p>
                        <div className="transition-review-context-actions">
                          <button
                            type="button"
                            className="btn btn-ghost btn-tiny"
                            disabled={saving === key}
                            onClick={() => void keepContext(key, stale)}
                          >
                            Keep context
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-tiny"
                            disabled={saving === key}
                            onClick={() => setDrafts((d) => ({ ...d, [key]: stale }))}
                          >
                            Replace
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-tiny"
                            disabled={saving === key}
                            onClick={() => void clearContext(key)}
                          >
                            Clear
                          </button>
                        </div>
                      </div>
                    )}

                    {resolved[key] && (
                      <p className="transition-review-resolved">
                        Resolved by you: {resolved[key] === 'ai' ? 'AI' : 'CUT'}. Press Accept below
                        to apply the analysis.
                      </p>
                    )}

                    {decision === 'needs-context' && (
                      <div className="transition-review-context">
                        {(pair.missingContext ?? []).map((m, i) => (
                          <p key={i} className="transition-review-missing">
                            <strong>Missing:</strong> {m.question}
                          </p>
                        ))}
                        <textarea
                          className="transition-review-context-input"
                          rows={3}
                          placeholder="Example: The white door is on the wall opposite the shower and aligned with the sink. The mirror should reflect only the beige wall and doorway."
                          value={drafts[key] ?? saved ?? ''}
                          onChange={(e) =>
                            setDrafts((d) => ({ ...d, [key]: e.target.value }))
                          }
                        />
                        {error && saving === null && (
                          <p className="transition-review-error">{error}</p>
                        )}
                        <div className="transition-review-context-actions">
                          <button
                            type="button"
                            className="btn btn-primary btn-tiny"
                            disabled={saving === key}
                            onClick={() => void approve(pair.fromId, pair.toId, key)}
                          >
                            {(drafts[key] ?? saved ?? '').trim().length > 0
                              ? 'Approve AI with context'
                              : 'Approve AI'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-tiny"
                            disabled={saving === key}
                            onClick={() => void keepAsCut(pair.fromId, pair.toId, key)}
                          >
                            Keep as CUT
                          </button>
                        </div>
                      </div>
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

        {/* ── APPROVING WITHOUT ANSWERING THE QUESTION ────────────────
            A legitimate choice, but a different one: nothing was
            resolved, so the model still has to invent the thing nobody
            described. Stated plainly rather than presented as approval
            of evidence that does not exist. */}
        {confirmBlind && (
          <div className="dialog-backdrop" onClick={() => setConfirmBlind(null)}>
            <div className="dialog-card" onClick={(e) => e.stopPropagation()}>
              <h3 className="dialog-title">Approve AI without additional spatial context?</h3>
              <p className="dialog-body">
                The analysis could not fully determine the reflective/spatial geometry. Generation
                may invent incorrect reflections or geometry.
              </p>
              <p className="dialog-body">
                The generated clip is still checked for people, cameras and filming equipment before
                it becomes active.
              </p>
              <div className="dialog-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-tiny"
                  onClick={() => setConfirmBlind(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-tiny"
                  onClick={() => void approveWithoutContext(confirmBlind.from, confirmBlind.to)}
                >
                  Approve AI
                </button>
              </div>
            </div>
          </div>
        )}

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
