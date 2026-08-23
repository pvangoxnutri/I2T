import type { AnalysisConfirmationPayload } from '../../../../preload/index'

/**
 * The paid-analysis confirmation.
 *
 * ── WHAT IT HAS TO MAKE UNMISSABLE ───────────────────────────────────
 *
 * Three things, because each one has a different way of going wrong:
 *
 *   every photo is sent    — the operator may not realise "analyse the
 *                            property" means uploading all of it;
 *   it may cost money      — and the estimate may be built on a rate
 *                            nobody has verified, which is said outright
 *                            rather than dressed as a figure;
 *   nothing changes yet    — the result is a DRAFT, and no transition
 *                            prompt moves until it is accepted.
 *
 * The primary button says exactly what will happen and how many images —
 * never "OK". The real gate is in main; this dialog is what makes the
 * decision informed, not what enforces it.
 */
export function AnalyzeConfirmDialog({
  data,
  busy,
  onCancel,
  onConfirm
}: {
  data: AnalysisConfirmationPayload
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <div className="dialog-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="dialog-card" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog-title">Analyze property with {data.analyzer}</h3>

        <dl className="confirm-list">
          <div>
            <dt>Analyzer</dt>
            <dd>
              {data.analyzer} · {data.provider}
            </dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>{data.model ?? '—'}</dd>
          </div>
          <div>
            <dt>Images</dt>
            <dd>
              {data.imageCount}
              <span className="confirm-basis">{data.imageRange}</span>
            </dd>
          </div>
          <div>
            <dt>Accepted analysis exists</dt>
            <dd>
              {data.hasAcceptedAnalysis ? 'Yes' : 'No'}
              {data.hasAcceptedAnalysis && (
                <span className="confirm-basis">
                  It stays exactly as it is — this run produces a separate draft.
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>Estimated analysis cost</dt>
            <dd className={data.rateVerified ? undefined : 'confirm-unverified'}>
              {data.estimatedCostLabel}
              <span className="confirm-basis">{data.estimatedCostBasis}</span>
            </dd>
          </div>
        </dl>

        {/* Said plainly, not implied by the numbers above. */}
        <ul className="confirm-statements">
          <li>
            <strong>All {data.imageCount} project images</strong> will be sent to {data.analyzer} in
            one request.
          </li>
          <li>
            The result becomes an <strong>analysis draft only</strong>.
          </li>
          <li>
            <strong>No transition prompt changes</strong> until you review the draft and accept it.
          </li>
          {!data.rateVerified && (
            <li>
              The configured rate has <strong>not been verified</strong> against current provider
              pricing, so no dependable cost figure can be shown. The request is still allowed.
            </li>
          )}
        </ul>

        <p className="confirm-warning">⚠ {data.warning}</p>

        {!data.ok && (
          <ul className="confirm-blockers">
            {data.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        )}

        <div className="dialog-actions">
          <button
            type="button"
            className="btn btn-ghost btn-tiny"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary btn-tiny"
            disabled={!data.ok || busy || !data.token}
            onClick={onConfirm}
          >
            {busy ? 'Analyzing…' : `Analyze ${data.imageCount} Images`}
          </button>
        </div>
      </div>
    </div>
  )
}
