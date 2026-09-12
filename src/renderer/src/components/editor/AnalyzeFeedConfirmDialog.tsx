/**
 * WHAT A LIBRARY ANALYSIS WOULD COST, before one is sent.
 *
 * Extracted out of MediaBrowser for the same reason as the proposal
 * dialog: it is step one of a two-step flow that can be started from the
 * Tools tab, and a confirmation rendered only on the Media tab meant the
 * second step could never be reached from there — the run simply stalled
 * with nothing on screen.
 */
export function AnalyzeFeedConfirmDialog({
  confirmation,
  running,
  error,
  kind = 'media',
  feed,
  onConfirm,
  onCancel
}: {
  /** Payload from `feed.analyzeConfirmation`; null hides the dialog. */
  confirmation: any
  running: boolean
  error: string | null
  /**
   * WHICH ANALYSIS IS BEING PAID FOR.
   *
   * The two runs cost the same and send the same photographs, but they
   * decide different things, and the dialog used to say "Analyse
   * Imported Media" for both. Someone approving a spend should be told
   * which one they are approving — above all that a FEED analysis will
   * not reorder anything, which is the difference an operator cares
   * about most.
   */
  kind?: 'media' | 'feed'
  /** Feed sizes, for the feed variant. */
  feed?: { imageCount: number; pairCount: number }
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element | null {
  if (!confirmation) return null
  const isFeed = kind === 'feed'

  const blockers: string[] = confirmation.blockers ?? []
  const blocked = blockers.length > 0

  return (
    <div className="media-proposal">
      <div className="media-proposal-backdrop" onClick={running ? undefined : onCancel} />
      <div className="media-proposal-dialog">
        <div className="media-proposal-head">
          <h3>{isFeed ? 'Analyse Feed' : 'Analyse Imported Media'}</h3>
          <button
            type="button"
            className="media-proposal-close"
            onClick={onCancel}
            disabled={running}
          >
            ✕
          </button>
        </div>

        <div className="media-proposal-preview">
          {blocked ? (
            <div>
              <p className="media-proposal-error">Cannot analyse:</p>
              <ul>
                {blockers.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </div>
          ) : (
            <>
              {isFeed ? (
                <>
                  <p className="media-proposal-info">
                    {confirmation.analyzer} will judge the {feed?.pairCount ?? 0} transition
                    {feed?.pairCount === 1 ? '' : 's'} between the {feed?.imageCount ?? 0} images
                    currently in the Transition Feed.
                  </p>
                  {/* The two facts an operator most needs before paying:
                      what leaves the machine, and what cannot come back
                      changed. */}
                  <p className="media-proposal-basis">
                    All {confirmation.imageCount} imported photos are sent as supporting evidence,
                    not just the ones in the feed.
                  </p>
                  <p className="media-proposal-basis">
                    <strong>The feed order will not be changed.</strong> This run only decides which
                    joints can use an AI transition.
                  </p>
                </>
              ) : (
                <p className="media-proposal-info">
                  {confirmation.analyzer} will analyse all {confirmation.imageCount} imported photos
                  to suggest a feed order and which joints can use an AI transition.
                </p>
              )}
              <p>
                <strong>Cost:</strong> {confirmation.estimatedCostLabel}
              </p>
              <p className="media-proposal-basis">{confirmation.estimatedCostBasis}</p>
              {confirmation.warning && (
                <p className="media-proposal-warning">{confirmation.warning}</p>
              )}
            </>
          )}
        </div>

        <div className="media-proposal-actions">
          {error && <p className="media-proposal-error">{error}</p>}
          <button
            type="button"
            className="media-proposal-accept"
            onClick={onConfirm}
            disabled={running || blocked}
          >
            {running ? 'Analysing…' : isFeed ? 'Analyse Feed' : 'Analyse'}
          </button>
          <button
            type="button"
            className="media-proposal-reject"
            onClick={onCancel}
            disabled={running}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
