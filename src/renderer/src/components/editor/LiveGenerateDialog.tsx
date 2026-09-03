import type { LiveConfirmationPayload } from '../../../../preload/index'

/**
 * The paid-request confirmation. Deliberately explicit: it names the exact
 * transition, the model, what it costs (or that the cost is unavailable),
 * and it separates the API cost from the customer's project price. The
 * primary button says exactly what will happen — never "OK".
 */
export function LiveGenerateDialog({
  data,
  busy,
  onCancel,
  onConfirm
}: {
  data: LiveConfirmationPayload
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  // Generating without any spatial map behind it — allowed only because
  // the operator chose this mode themselves, and only once they say so.
  const isOverride = data.spatialGuidance === 'none'

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog-card" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog-title">
          {data.isRegeneration
            ? `Regenerate 1 transition with ${data.provider}`
            : `Generate 1 transition with ${data.provider}`}
        </h3>
        <p className="dialog-body">
          This will create a new paid {data.provider} generation.
        </p>

        {/* The EXACT frames being sent — a backwards pair is caught here. */}
        {data.startImage && data.endImage && (
          <div className="confirm-frames">
            <figure>
              <img src={data.startImage.src} alt="" />
              <figcaption title={data.startImage.name}>Start · {data.startImage.name}</figcaption>
            </figure>
            <span className="confirm-frames-arrow" aria-hidden>
              →
            </span>
            <figure>
              <img src={data.endImage.src} alt="" />
              <figcaption title={data.endImage.name}>End · {data.endImage.name}</figcaption>
            </figure>
          </div>
        )}

        <dl className="confirm-list">
          <div>
            <dt>Project</dt>
            <dd>{data.projectName}</dd>
          </div>
          <div>
            <dt>Transition</dt>
            <dd>{data.transitionLabel}</dd>
          </div>
          <div>
            <dt>Provider</dt>
            <dd>{data.provider}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>{data.model}</dd>
          </div>
          <div>
            <dt>Duration</dt>
            <dd>{data.durationSec}s</dd>
          </div>
          <div>
            <dt>Resolution</dt>
            <dd>{data.resolution}</dd>
          </div>
          <div>
            <dt>Native audio</dt>
            <dd>{data.nativeAudio ? 'On' : 'Off'}</dd>
          </div>
          <div>
            <dt>Prompt</dt>
            <dd className="confirm-prompt" title={data.prompt}>
              {data.prompt}
            </dd>
          </div>
          <div>
            <dt>Estimated API cost</dt>
            <dd>
              {data.estimatedCostLabel}
              <span className="confirm-basis">{data.estimatedCostBasis}</span>
            </dd>
          </div>
          <div>
            <dt>Customer project price</dt>
            <dd className="confirm-customer">
              {data.customerPriceLabel}
              <span className="confirm-basis">
                What the customer pays — unrelated to the API cost above.
              </span>
            </dd>
          </div>
        </dl>

        {/* PRODUCTION SPEND.
            The ledger is append-only, so this generation STACKS on every
            earlier attempt rather than replacing one. Regenerating a
            transition three times costs three times, and the operator
            should see that before pressing the button, not afterwards in
            an invoice. */}
        <div className={`confirm-spend${data.isRegeneration ? ' is-regeneration' : ''}`}>
          <span className="confirm-spend-head">
            {data.isRegeneration
              ? `Regeneration — attempt ${data.attemptNumber} for this transition`
              : 'Production cost'}
          </span>
          <dl className="confirm-spend-list">
            <div>
              <dt>Estimated additional production cost</dt>
              <dd>{data.additionalCostLabel}</dd>
            </div>
            <div>
              <dt>Spent so far</dt>
              <dd>{data.spentSoFarLabel}</dd>
            </div>
            <div>
              <dt>After this generation</dt>
              <dd>
                {data.projectedAfterLabel === 'unavailable'
                  ? 'unavailable'
                  : `approximately ${data.projectedAfterLabel}`}
              </dd>
            </div>
          </dl>
          {data.isRegeneration && (
            <p className="confirm-spend-note">
              The previous {data.attemptNumber - 1} generation
              {data.attemptNumber - 1 === 1 ? '' : 's'} stay{data.attemptNumber - 1 === 1 ? 's' : ''}{' '}
              in the ledger — replacing the clip does not refund what was already spent.
            </p>
          )}
          {data.additionalCostLabel === 'unavailable' && (
            <p className="confirm-spend-note">
              No verified rate for this combination, so the cost cannot be estimated. Generation
              is still allowed — the charge will be recorded once the provider accepts it.
            </p>
          )}
        </div>

        <p className="confirm-warning">⚠ {data.warning}</p>

        {!data.ok && (
          <ul className="confirm-blockers">
            {data.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}

        {/* ── AN OVERRIDE IS NAMED AS AN OVERRIDE ────────────────────
            The operator may generate a transition the map does not
            support — they may know the property better than the
            photographs show — but nothing here may let that read as a
            safe, analysis-backed move. This is the exact state that
            produced a moved sofa and a duplicated television, so it is
            described in those words and the button says what it does. */}
        {isOverride && (
          <div className="confirm-override" role="alert">
            <p className="confirm-override-title">{data.overrideWarning}</p>
            {data.overrideReason && <p className="confirm-override-why">{data.overrideReason}</p>}
            <p className="confirm-override-guidance">Spatial guidance: none — manual override</p>
          </div>
        )}

        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost btn-tiny" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn btn-tiny ${isOverride ? 'btn-danger' : 'btn-primary'}`}
            disabled={!data.ok || busy}
            onClick={onConfirm}
          >
            {busy ? 'Submitting…' : isOverride ? 'Generate anyway' : 'Generate 1 Transition'}
          </button>
        </div>
      </div>
    </div>
  )
}
