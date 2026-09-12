import { useEffect, useState } from 'react'
import type { Project } from '../../types'
import {
  MOTION_LABEL,
  MOTION_TYPES,
  motionSegmentLabel,
  motionSegments,
  type MotionType
} from '../../../../shared/motionSegment'
import { motionPromptSummary } from '../../../../shared/motionPrompt'
import type { MotionGenerationReadiness } from '../../../../shared/motionGenerationReadiness'
import type { MotionConfirmation } from '../../../../shared/motionConfirmation'
import { MotionGenerateDialog } from './MotionGenerateDialog'

/**
 * ONE PHOTOGRAPH, MOVING.
 *
 * ── WHY THIS IS NOT THE TRANSITION INSPECTOR ─────────────────────────
 *
 * The transition inspector is mostly about the relationship between two
 * rooms: which doorway connects them, what the analyzer concluded, what
 * the operator corrected, whether the evidence behind the prompt is
 * still current. None of that exists for a single photograph, and
 * showing it would be worse than useless — it would invite the operator
 * to reason about spatial evidence that has no bearing on this clip.
 *
 * So this panel deliberately shows THREE things and nothing else:
 * what the motion is, whether it can be generated, and the clip if one
 * exists. No pair evidence. No cross-room analysis. No approval state.
 */

type Tab = 'motion' | 'generation' | 'clip'

export function MotionInspector({
  project,
  segmentId
}: {
  project: Project
  segmentId: string | null
}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('motion')
  const [readiness, setReadiness] = useState<MotionGenerationReadiness | null>(null)
  const [busy, setBusy] = useState(false)
  /**
   * The paid dialog's payload, or null when it is closed.
   *
   * Held here rather than derived, because it is re-fetched whenever the
   * operator changes the model or the length — the cost shown must
   * always be the cost of the run that would actually happen.
   */
  const [confirm, setConfirm] = useState<MotionConfirmation | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const segment = segmentId ? motionSegments(project).find((s) => s.id === segmentId) ?? null : null
  const image = segment ? project.images.find((i) => i.id === segment.imageId) ?? null : null

  useEffect(() => {
    if (!segmentId) return
    setReadiness(null)
    void window.f2f.projects.motion.confirmation(project.id, segmentId).then(setReadiness)
  }, [project.id, segmentId, segment?.status, segment?.motion, segment?.durationSec])

  if (!segment) {
    return (
      <section className="inspector inspector-empty">
        <p>Select a motion clip in the timeline.</p>
      </section>
    )
  }

  const retime = async (patch: { motion?: MotionType; durationSec?: number }): Promise<void> => {
    setBusy(true)
    await window.f2f.projects.motion.update(project.id, segment.id, patch)
    setBusy(false)
  }

  const generatable = readiness?.ok === true

  /** Open the paid dialog. Reading the payload sends nothing. */
  const openDialog = async (): Promise<void> => {
    setSubmitError(null)
    const payload = await window.f2f.projects.motion.generateConfirmation(project.id, segment.id)
    setConfirm(payload)
  }

  /** Re-ask main with the new choice, so the price follows the choice. */
  const rechoose = async (
    modelId: string,
    durationSec: number,
    motion?: MotionType
  ): Promise<void> => {
    const payload = await window.f2f.projects.motion.generateConfirmation(
      project.id,
      segment.id,
      modelId,
      durationSec,
      motion
    )
    setConfirm(payload)
  }

  /**
   * THE PAID SUBMIT.
   *
   * Motion, model and duration all come from the dialog's own payload,
   * so what is submitted is exactly what was shown and agreed to. Main
   * re-checks all three before spending anything.
   */
  const submit = async (): Promise<void> => {
    if (!confirm?.ok) return
    setBusy(true)
    const res = await window.f2f.projects.motion.generate(
      project.id,
      segment.id,
      confirm.modelId,
      confirm.durationSec,
      confirm.motion as MotionType
    )
    setBusy(false)
    if (res.ok) setConfirm(null)
    else setSubmitError(res.reason ?? 'The generation could not be queued.')
  }

  return (
    <section className="inspector">
      <header className="inspector-head">
        {/* Spelled out, exactly as on the timeline. Whoever opened this
            panel must never have to work out whether they are looking at
            a transition between two rooms or one photograph moving. */}
        <span className="inspector-pair">{motionSegmentLabel(segment)}</span>
        <nav className="inspector-tabs" role="tablist">
          {(
            [
              ['motion', 'Motion'],
              ['generation', 'Generation'],
              ['clip', 'Clip']
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={`inspector-tab${tab === key ? ' is-active' : ''}`}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <div className="inspector-body">
        {/* ── MOTION ─────────────────────────────────────────────────── */}
        {tab === 'motion' && (
          <div className="inspector-grid">
            <Field label="Source photograph" value={image?.fileName ?? 'Unknown'} />
            <div className="inspector-field">
              <div className="inspector-label">Movement</div>
              <select
                className="input"
                value={segment.motion}
                // A generated clip keeps its motion: the stored video
                // would otherwise stop matching what the row claims.
                disabled={busy || segment.clip !== null}
                onChange={(e) => void retime({ motion: e.target.value as MotionType })}
              >
                {MOTION_TYPES.map((m) => (
                  <option key={m} value={m}>
                    {MOTION_LABEL[m]}
                  </option>
                ))}
              </select>
              {segment.clip !== null && (
                <p className="inspector-hint">
                  Locked here because a clip exists — this field describes what was made. To change
                  the movement, use Regenerate: it offers motion, model and length together, and the
                  current clip stays in History.
                </p>
              )}
            </div>
            <Field label="Length" value={`${segment.durationSec}s`} />
            <div className="inspector-field inspector-span">
              <div className="inspector-label">What is asked for</div>
              <p className="inspector-hint">{motionPromptSummary(segment.motion)}</p>
            </div>
          </div>
        )}

        {/* ── GENERATION ─────────────────────────────────────────────── */}
        {tab === 'generation' && (
          <div className="inspector-grid">
            <Field label="Status" value={segment.status} />
            <div className="inspector-field inspector-span">
              <div className="inspector-label">Model</div>
              {readiness === null ? (
                <p className="inspector-hint">Checking which models can do this…</p>
              ) : readiness.ok ? (
                <>
                  {/* The canonical selector. A paid single-image run can
                      only be started from here, and only on a model this
                      evaluator returned as capable and confirmed. */}
                  <select className="input" disabled={busy}>
                    {readiness.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.displayName}
                      </option>
                    ))}
                  </select>
                  {readiness.advisory && <p className="inspector-hint">{readiness.advisory}</p>}
                </>
              ) : (
                <p className="inspector-hint inspector-hint-warn">{readiness.reason}</p>
              )}
            </div>
            <div className="inspector-field inspector-span">
              <button
                className="btn btn-primary"
                disabled={busy || !generatable}
                onClick={() => void openDialog()}
              >
                {segment.clip ? 'Regenerate — costs again' : 'Generate — costs money'}
              </button>
              {submitError && <p className="inspector-hint inspector-hint-warn">{submitError}</p>}
            </div>
            <div className="inspector-field inspector-span">
              <div className="inspector-label">Prompt</div>
              <textarea className="input" readOnly rows={7} value={segment.prompt} />
            </div>
          </div>
        )}

        {/* ── CLIP ───────────────────────────────────────────────────── */}
        {tab === 'clip' && (
          <div className="inspector-grid">
            {segment.clip ? (
              <>
                <Field label="File" value={segment.clip.originalName} />
                <Field label="Source" value={segment.clip.source} />
                <div className="inspector-field inspector-span">
                  <video className="motion-clip-preview" src={segment.clip.src} controls />
                </div>
              </>
            ) : (
              <p className="inspector-hint inspector-span">
                No clip yet. This motion segment is on the timeline, so the video cannot be exported
                until it is generated or removed.
              </p>
            )}
          </div>
        )}
      </div>

      {confirm && (
        <MotionGenerateDialog
          data={confirm}
          busy={busy}
          onMotionChange={(m) => void rechoose(confirm.modelId, confirm.durationSec, m as MotionType)}
          onModelChange={(id) => void rechoose(id, confirm.durationSec, confirm.motion as MotionType)}
          onDurationChange={(d) => void rechoose(confirm.modelId, d, confirm.motion as MotionType)}
          onConfirm={() => void submit()}
          onCancel={() => setConfirm(null)}
        />
      )}
    </section>
  )
}

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="inspector-field">
      <div className="inspector-label">{label}</div>
      <div className="inspector-value">{value}</div>
    </div>
  )
}
