import type { MotionConfirmation } from '../../../../shared/motionConfirmation'

/**
 * THE PAID CONFIRMATION FOR ONE PHOTOGRAPH IN MOTION.
 *
 * ── WHY NOT THE TRANSITION DIALOG ────────────────────────────────────
 *
 * That dialog is built around two frames with an arrow between them,
 * spatial guidance, and an override warning about moving through a
 * doorway the map does not support. None of that exists here, and
 * showing it would describe a product the operator is not buying.
 *
 * What IS shared is everything that matters for spending: the model
 * selector, the duration the model actually accepts, the verified rate,
 * and the fact that nothing is sent until the button is pressed. The
 * payload comes from `motionConfirmation` in main, which asks the same
 * evaluator the submit path asks — so this dialog cannot offer a run
 * that would then be refused.
 */
export function MotionGenerateDialog({
  data,
  busy,
  onMotionChange,
  onModelChange,
  onDurationChange,
  onConfirm,
  onCancel
}: {
  data: MotionConfirmation
  busy: boolean
  onMotionChange: (motion: string) => void
  onModelChange: (modelId: string) => void
  onDurationChange: (seconds: number) => void
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog-card" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog-title">
          {data.isRegeneration
            ? 'Regenerate single-image motion with fal.ai'
            : 'Generate single-image motion with fal.ai'}
        </h3>

        <p className="dialog-body">
          This sends ONE paid request to fal.ai for a single photograph. Nothing has been sent yet.
        </p>

        {/* ── WHAT EXISTS TODAY ──────────────────────────────────────
            Read off the previous generation's own row, so it describes
            the clip currently playing rather than the choices about to
            replace it. Regenerating never edits this — it becomes one
            more entry in History. */}
        {data.previous && (
          <p className="confirm-previous">
            <span className="confirm-previous-label">Previous generation</span>
            {data.previous.motionLabel}
            {data.previous.model ? ` · ${data.previous.model.split('/').slice(-3).join('/')}` : ''}
            {data.previous.durationSec ? ` · ${data.previous.durationSec}s` : ''}
          </p>
        )}

        {/* The subject, spelled out. Never an arrow, never a pair. */}
        <dl className="confirm-list">
          <div>
            <dt>Image</dt>
            <dd>
              {data.imageLabel} · {data.imageName}
            </dd>
          </div>
        </dl>

        {/* ── MOTION ─────────────────────────────────────────────────
            A per-run choice, like the model and the length. Changing it
            re-asks main, so the prompt below and the cost beside it are
            always the ones this run would actually use. */}
        <label className="confirm-model">
          <span className="confirm-model-label">Motion</span>
          <select
            className="select-input"
            value={data.motion}
            disabled={busy}
            onChange={(e) => onMotionChange(e.target.value)}
          >
            {data.motionOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <p className="field-hint">{data.motionSummary}</p>

        {data.imageSrc && (
          <div className="confirm-frames">
            <figure>
              <img src={data.imageSrc} alt={data.imageName} />
              <figcaption>{data.imageName}</figcaption>
            </figure>
          </div>
        )}

        {/* ── MODEL ──────────────────────────────────────────────────
            Only models that can actually generate from a single image
            appear here. A model that requires an end frame is EXCLUDED
            rather than offered and then refused, and never silently
            substituted for the one the operator picked. */}
        <label className="confirm-model">
          <span className="confirm-model-label">Model</span>
          <select
            className="select-input"
            value={data.modelId}
            disabled={busy || !data.ok}
            onChange={(e) => onModelChange(e.target.value)}
          >
            {data.models.map((m) => (
              <option key={m.id} value={m.id} disabled={!m.confirmed}>
                {m.displayName}
                {m.confirmed ? '' : ' — contract not verified'}
              </option>
            ))}
          </select>
        </label>

        <label className="confirm-model">
          <span className="confirm-model-label">Duration</span>
          <select
            className="select-input"
            value={data.durationSec}
            disabled={busy || !data.ok}
            onChange={(e) => onDurationChange(Number(e.target.value))}
          >
            {data.modelDurations.map((d) => (
              <option key={d} value={d}>
                {d}s
              </option>
            ))}
          </select>
        </label>

        <dl className="confirm-list">
          <div>
            <dt>Audio</dt>
            {/* Off by default and never enabled implicitly: native audio
                costs 50 % more per second. */}
            <dd>{data.nativeAudio ? 'On' : 'Off'}</dd>
          </div>
          <div>
            <dt>Estimated API cost</dt>
            <dd>
              {data.estimatedCostLabel}
              {data.priceUnavailableReason && (
                <span className="confirm-basis">{data.priceUnavailableReason}</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Attempt</dt>
            <dd>
              {data.attemptNumber}
              {data.isRegeneration ? ' — regeneration' : ''}
            </dd>
          </div>
          <div>
            <dt>Prompt</dt>
            <dd className="confirm-prompt" title={data.prompt}>
              {data.prompt}
            </dd>
          </div>
        </dl>

        {!data.ok && data.reason && (
          <ul className="confirm-blockers">
            <li>{data.reason}</li>
          </ul>
        )}

        <p className="confirm-warning">
          ⚠ This costs money. The charge is recorded as soon as fal.ai accepts the request.
        </p>

        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost btn-tiny" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-tiny btn-primary"
            disabled={!data.ok || busy}
            onClick={onConfirm}
          >
            {busy ? 'Submitting…' : 'Generate 1 Motion Clip'}
          </button>
        </div>
      </div>
    </div>
  )
}
