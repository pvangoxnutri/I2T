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
  onConfirm,
  onCancel
}: {
  /** Payload from `feed.analyzeConfirmation`; null hides the dialog. */
  confirmation: any
  running: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element | null {
  if (!confirmation) return null

  const blockers: string[] = confirmation.blockers ?? []
  const blocked = blockers.length > 0

  return (
    <div className="media-proposal">
      <div className="media-proposal-backdrop" onClick={running ? undefined : onCancel} />
      <div className="media-proposal-dialog">
        <div className="media-proposal-head">
          <h3>Analyse Imported Media</h3>
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
              <p className="media-proposal-info">
                {confirmation.analyzer} will analyse all {confirmation.imageCount} imported photos
                to suggest a feed order and which joints can use an AI transition.
              </p>
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
            {running ? 'Analysing…' : 'Analyse'}
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
