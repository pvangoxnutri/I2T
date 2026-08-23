import { useEffect, useState } from 'react'
import { useAppState } from '../../state/AppState'
import { defaultTransitionSettings, transitionKey, type Project } from '../../types'
import { LiveGenerateDialog } from './LiveGenerateDialog'
import type { LiveConfirmationPayload } from '../../../../preload/index'
import { markManuallyEdited } from '../../../../shared/promptPlanner'
import { relateImages, type PropertyAnalysis } from '../../../../shared/propertyAnalysis'
import { attemptsForPair, formatSpend, type GenerationCostEntry } from '../../../../shared/costLedger'
import { latestJobForPair, transitionRecovery } from '../../../../shared/transitionRecovery'
import { NEUTRAL_MOTION, planSequence } from '../../../../shared/transitionPlan'
import { orientationLabel } from '../../../../shared/transitionEvidence'

type Tab = 'motion' | 'prompt' | 'generation' | 'clip'

/**
 * Everything about ONE transition, along the bottom.
 *
 * ── WHY IT MOVED HERE ────────────────────────────────────────────────
 *
 * The prompt, the provider settings and the clip used to live in a tall
 * card per transition, so configuring the third transition meant
 * scrolling past the first two. As a horizontal inspector it is always in
 * the same place, and the timeline above stays visible while you work.
 *
 * Tabs rather than stacking: four small groups that are rarely needed at
 * once, and a panel that never grows past its share of the screen.
 */
export function TransitionInspector({
  project,
  analysis,
  pairKey
}: {
  project: Project
  analysis: PropertyAnalysis | null
  pairKey: string | null
}): React.JSX.Element {
  const { updateTransition, settings, queue, refreshProjects } = useAppState()
  const [tab, setTab] = useState<Tab>('motion')
  const [liveConfirm, setLiveConfirm] = useState<LiveConfirmationPayload | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [entries, setEntries] = useState<GenerationCostEntry[]>([])
  const [clipInfo, setClipInfo] = useState<{ exists: boolean; bytes: number } | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const index = project.images.findIndex(
    (img, i) =>
      i < project.images.length - 1 && transitionKey(img.id, project.images[i + 1].id) === pairKey
  )
  const start = index >= 0 ? project.images[index] : null
  const end = index >= 0 ? project.images[index + 1] : null

  /**
   * A TRANSITION EXISTS AS SOON AS TWO PHOTOS ARE ADJACENT.
   *
   * ── THE BUG THIS FIXES ───────────────────────────────────────────────
   *
   * `project.transitions` is keyed by image pair and written LAZILY — a
   * row appears the first time something about that transition is edited.
   * A freshly imported project has thirty photographs, twenty-nine
   * transitions and zero rows.
   *
   * This inspector used to bail out when the row was missing, showing
   * "Select a transition in the timeline to configure it." — the exact
   * message it showed when nothing was selected at all. So clicking a
   * transition selected it, switched the preview and highlighted the
   * block, and the inspector still said "select a transition". It read as
   * the click having done nothing, and there was no way to reach Generate
   * because the panel holding it never rendered.
   *
   * The absence of a settings row means "not configured yet", not "does
   * not exist". Defaults are supplied so the transition can be inspected
   * and generated, and the row is written when something is actually
   * changed — which keeps the lazy-write behaviour the rest of the app
   * relies on.
   */
  const stored = pairKey ? project.transitions[pairKey] : undefined
  const transition =
    stored ?? defaultTransitionSettings(settings.exportDefaults.defaultTransitionDurationSec)

  useEffect(() => {
    if (!pairKey) return
    void window.f2f.projects.cost.entries(project.id).then(setEntries)
  }, [project.id, pairKey, project.updatedAt])

  useEffect(() => {
    const stored = transition?.clip?.storedName
    if (!stored) {
      setClipInfo(null)
      return
    }
    void window.f2f.clips.info(project.id, stored).then(setClipInfo)
  }, [project.id, transition?.clip?.storedName])

  // Only a genuinely unresolvable pair falls back — an id that names no
  // adjacent pair in the current order, which a reorder can produce.
  if (!pairKey || !start || !end) {
    return (
      <section className="inspector inspector-empty">
        <p>Select a transition in the timeline to configure it.</p>
      </section>
    )
  }

  // Decided in `shared` from the REMOTE task state — the same answer the
  // preview shows, so the two can never offer different recoveries.
  const recovery = transitionRecovery(
    stored,
    latestJobForPair(queue, project.id, pairKey),
    `${index + 1} → ${index + 2}`
  )

  const hasAnalysis = analysis !== null && analysis.rooms.length > 0
  // The plan for THIS pair, from the whole-sequence planner so continuity
  // is the same value the prompt was built with.
  const plan =
    planSequence(
      analysis,
      project.images.map((i) => i.id)
    )[index] ?? null
  const relation = analysis ? relateImages(analysis, start.id, end.id) : { kind: 'unknown' as const }
  const attempts = attemptsForPair(entries, pairKey)
  const provider = settings.providers.find(
    (p) => p.id === (settings.activeProviderId ?? settings.providers[0]?.id)
  )
  const providerName = provider?.id === 'fal' ? 'fal.ai' : 'Kling'
  const pendingDownload = transition.clip === null && attempts.length > 0

  const openGenerate = (): void => {
    void window.f2f.generation.liveConfirmation(project.id, pairKey).then((data) => {
      if (data) setLiveConfirm(data)
    })
  }

  return (
    <section className="inspector">
      <header className="inspector-head">
        <span className="inspector-pair">
          TRANSITION {index + 1} → {index + 2}
        </span>
        <nav className="inspector-tabs" role="tablist">
          {(
            [
              ['motion', 'Motion'],
              ['prompt', 'Prompt'],
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
        {/* ── MOTION: what the system believes about these two frames ── */}
        {tab === 'motion' && (
          <div className="inspector-motion">
            {relation.kind === 'same-room' && (
              <>
                <Field label="Room relation" value={`${relation.room.label} (same room)`} />
                <Field label="Confidence" value="Confirmed — both images assigned to one room" />
                <Field
                  label="Shared landmarks"
                  value={relation.shared.length > 0 ? relation.shared.join(', ') : 'None recorded'}
                />
              </>
            )}
            {relation.kind === 'adjacent-room' && (
              <>
                <Field
                  label="Room relation"
                  value={`${relation.from.label} → ${relation.to.label}`}
                />
                <Field
                  label="Confidence"
                  value={relation.confidence === 'confirmed' ? 'Confirmed' : 'Probable'}
                />
                <Field
                  label="Visible openings"
                  value={
                    relation.openings.length > 0
                      ? relation.openings.join(', ')
                      : 'None visible in the start frame'
                  }
                />
              </>
            )}
            {relation.kind === 'unknown' && (
              /* THE SAFETY MESSAGE. If the system cannot see how two rooms
                 connect it says so, and says what it will therefore NOT
                 do. A tour that walks through a wall misrepresents a home
                 someone is selling.

                 Two different situations produce this, and they need
                 different advice: nothing has been analysed at all (a
                 recommendation), or analysis ran and honestly could not
                 place these two photographs (a statement of fact). Showing
                 "analyze first" to someone who already did would be a lie
                 about why the transition is generic. */
              <div className="inspector-unknown">
                <span className="inspector-unknown-title">
                  Physical navigation unavailable — safe cinematic transition will be used
                </span>
                {!hasAnalysis ? (
                  <p>
                    Analyze Property first for better spatial accuracy. Without it the system has no
                    whole-property context and will not pretend otherwise.
                  </p>
                ) : (
                  <p>
                    The analysis could not place these two photographs relative to each other. No
                    doorway or corridor will be invented.
                  </p>
                )}
                <p className="inspector-hint">
                  This transition still generates normally — nothing is blocked.
                </p>
              </div>
            )}

            {relation.kind === 'adjacent-room' && relation.openings.length === 0 && (
              /* Confirmed adjacency is not enough on its own. The camera
                 can only move through an opening it can actually see. */
              <div className="inspector-unknown">
                <span className="inspector-unknown-title">
                  Physical navigation unavailable — safe cinematic transition will be used
                </span>
                <p>
                  No opening is visible in the start frame, so the camera is moved toward the end
                  viewpoint without depicting travel through a doorway.
                </p>
              </div>
            )}

            {/* ── WHY THIS MOTION AND NOT ANOTHER ────────────────────────
                Every transition used to read `slow forward dolly, slight
                clockwise rotation` because the wording came first and the
                direction was invented. Showing the evidence a plan was
                built from is what makes a generic plan visibly generic. */}
            {plan && (
              <div className="inspector-evidence">
                <span className="inspector-planned-label">Evidence</span>
                {plan.hasEvidence ? (
                  <dl className="evidence-list">
                    {plan.sharedLandmarks.length > 0 && (
                      <div>
                        <dt>Shared landmarks</dt>
                        <dd>{plan.sharedLandmarks.join(', ')}</dd>
                      </div>
                    )}
                    {plan.leavingLandmarks.length > 0 && (
                      <div>
                        <dt>Leaves frame</dt>
                        <dd>{plan.leavingLandmarks.join(', ')}</dd>
                      </div>
                    )}
                    {plan.enteringLandmarks.length > 0 && (
                      <div>
                        <dt>Enters frame</dt>
                        <dd>{plan.enteringLandmarks.join(', ')}</dd>
                      </div>
                    )}
                    <div>
                      <dt>Start orientation</dt>
                      <dd>{orientationLabel(plan.startOrientation)}</dd>
                    </div>
                    <div>
                      <dt>End orientation</dt>
                      <dd>{orientationLabel(plan.endOrientation)}</dd>
                    </div>
                    <div>
                      <dt>Rotation</dt>
                      <dd className={plan.rotationDirection === 'unknown' ? 'is-unknown' : undefined}>
                        {plan.rotationDirection === 'unknown'
                          ? 'Not determinable from the recorded orientations'
                          : plan.rotationDirection === 'none'
                            ? 'No turn'
                            : plan.rotationDirection}
                      </dd>
                    </div>
                    {plan.visiblePassage && (
                      <div>
                        <dt>Passage</dt>
                        <dd>{plan.visiblePassage}</dd>
                      </div>
                    )}
                    <div>
                      <dt>Derived from</dt>
                      <dd>
                        {plan.evidenceImageIds
                          .map((id) => {
                            const i = project.images.findIndex((x) => x.id === id)
                            return i >= 0 ? `IMAGE_${String(i + 1).padStart(3, '0')}` : null
                          })
                          .filter(Boolean)
                          .join(', ') || 'none'}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <p className="inspector-hint">
                    Insufficient spatial evidence for a directional camera path. Safe cinematic
                    motion will be used — no rotation or travel direction is invented.
                  </p>
                )}
              </div>
            )}

            <div className="inspector-planned">
              <span className="inspector-planned-label">Planned motion</span>
              <p>
                {transition.promptProvenance?.motionInstruction ??
                  (plan && !plan.hasEvidence
                    ? NEUTRAL_MOTION
                    : 'No analysis-derived motion instruction — the base safety prompt is used unchanged.')}
              </p>
            </div>
          </div>
        )}

        {/* ── PROMPT ─────────────────────────────────────────────────── */}
        {tab === 'prompt' && (
          <div className="inspector-prompt">
            <textarea
              className="inspector-textarea"
              value={transition.prompt}
              placeholder="Leave empty to use the default I2T transition prompt."
              onChange={(e) =>
                updateTransition(project.id, start.id, end.id, {
                  prompt: e.target.value,
                  // Only a REAL edit sets this. Once set, rebuilding from
                  // Property Analysis skips this transition for good.
                  promptProvenance: markManuallyEdited(
                    transition.promptProvenance,
                    e.target.value,
                    Date.now()
                  )
                })
              }
            />
            <div className="inspector-prompt-side">
              {transition.promptProvenance?.manuallyEdited ? (
                <>
                  <span className="prompt-provenance-tag is-manual">Manually edited</span>
                  <p className="inspector-hint">Property Analysis will not overwrite this.</p>
                  <button
                    type="button"
                    className="btn btn-ghost btn-tiny"
                    onClick={() => {
                      if (
                        !window.confirm(
                          'Replace your custom prompt with the one planned from Property Analysis?\n\nYour wording for this transition will be discarded.'
                        )
                      )
                        return
                      void window.f2f.projects.analysis
                        .useAnalysisPrompt(project.id, pairKey)
                        .then(() => refreshProjects())
                    }}
                  >
                    Use analysis prompt
                  </button>
                </>
              ) : (
                <>
                  <span className="prompt-provenance-tag">
                    {transition.promptProvenance ? 'From analysis' : 'Default prompt'}
                  </span>
                  <p className="inspector-hint">
                    {transition.promptProvenance?.rationale ??
                      'Rebuilt automatically when Property Analysis changes.'}
                  </p>
                  <button
                    type="button"
                    className="btn btn-ghost btn-tiny"
                    onClick={() =>
                      void window.f2f.projects.analysis
                        .useAnalysisPrompt(project.id, pairKey)
                        .then(() => refreshProjects())
                    }
                  >
                    Use analysis prompt
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {/* ── GENERATION ─────────────────────────────────────────────── */}
        {tab === 'generation' && (
          <div className="inspector-generation">
            <Field label="Provider" value={providerName} />
            <Field label="Model" value={provider?.model ?? '—'} />
            <label className="inspector-inline">
              <span>Duration</span>
              <select
                value={String(transition.durationSec)}
                onChange={(e) =>
                  updateTransition(project.id, start.id, end.id, {
                    durationSec: Number(e.target.value)
                  })
                }
              >
                {[5, 10].map((s) => (
                  <option key={s} value={s}>
                    {s}s
                  </option>
                ))}
              </select>
            </label>
            <Field
              label="Spent on this transition"
              value={
                attempts.length > 0
                  ? `${formatSpend(
                      attempts.reduce((s, a) => s + (a.actualCost ?? a.estimatedCost ?? 0), 0),
                      attempts[0].currency
                    )} over ${attempts.length} attempt${attempts.length === 1 ? '' : 's'}`
                  : 'Nothing yet'
              }
            />
            <div className="inspector-actions">
              {/* ── THREE ACTIONS, THREE COSTS ────────────────────────────
                  Resume continues a paid task that is already running.
                  Retry download fetches a result that already exists and
                  is already paid for. Regenerate submits a NEW paid task.
                  Calling all three "Retry" is how someone pays twice for a
                  clip sitting on the provider's server, so each gets its
                  own word — and the decision comes from the remote task
                  state, not from how the UI feels about it. */}
              <button
                type="button"
                className={`btn btn-tiny ${recovery.costsMoney ? 'btn-primary' : 'btn-ghost'}${
                  recovery.kind === 'regenerate' ? ' btn-regenerate' : ''
                }`}
                disabled={recovery.kind === 'waiting'}
                onClick={() => {
                  if (recovery.kind === 'resume' || recovery.kind === 'retry-download') {
                    if (recovery.jobId) {
                      void window.f2f.queue
                        .resumePolling(recovery.jobId)
                        .then(() => refreshProjects())
                    }
                    return
                  }
                  openGenerate()
                }}
                title={
                  recovery.costsMoney
                    ? 'Opens the paid-request confirmation before anything is sent'
                    : 'Costs nothing — the provider work is already paid for'
                }
              >
                {recovery.kind === 'preview' ? `Regenerate — costs again` : recovery.label}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-tiny"
                onClick={() =>
                  void window.f2f.generation.queue(project.id, [pairKey]).then(() => {
                    refreshProjects()
                    setNote('Queued.')
                  })
                }
              >
                Add to Queue
              </button>
            </div>
            <p className={`inspector-cost-note${recovery.costsMoney ? '' : ' is-free'}`}>
              {recovery.detail}
            </p>
            {transition.clip && (
              <p className="inspector-cost-note">
                A clip already exists. Regenerating submits a new paid request and does not replace
                the spend already recorded for this transition.
              </p>
            )}
            {attempts.length > 0 && (
              <ul className="inspector-attempts">
                {attempts.map((a) => (
                  <li key={a.id}>
                    Attempt {a.attemptNumber} · {a.provider} ·{' '}
                    {formatSpend(a.actualCost ?? a.estimatedCost ?? 0, a.currency)} · {a.status}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* ── CLIP ───────────────────────────────────────────────────── */}
        {tab === 'clip' && (
          <div className="inspector-clip">
            {transition.clip ? (
              <>
                <Field
                  label="Source"
                  value={
                    transition.clip.source === 'fal'
                      ? 'Generated with fal.ai'
                      : transition.clip.source === 'kling'
                        ? 'Generated with Kling'
                        : 'Attached manually'
                  }
                />
                <Field
                  label="File"
                  value={
                    clipInfo?.exists
                      ? `${transition.clip.originalName} · ${formatBytes(clipInfo.bytes)}`
                      : 'Missing on disk'
                  }
                />
                <div className="inspector-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-tiny"
                    onClick={() =>
                      void window.f2f.clips.showInFolder(project.id, transition.clip!.storedName)
                    }
                  >
                    Open folder
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-tiny"
                    onClick={() => {
                      const old = transition.clip
                      if (old) void window.f2f.clips.remove(project.id, old.storedName)
                      updateTransition(project.id, start.id, end.id, {
                        clip: null,
                        status: 'not-generated'
                      })
                    }}
                  >
                    Remove clip
                  </button>
                  {/* Development action, marked as one. */}
                  <button
                    type="button"
                    className="btn btn-ghost btn-tiny btn-dev"
                    title="Development: import an MP4 as this transition's output"
                    onClick={() =>
                      void window.f2f.clips.attach(project.id).then((clip) => {
                        if (!clip) return
                        updateTransition(project.id, start.id, end.id, {
                          clip,
                          status: 'completed'
                        })
                      })
                    }
                  >
                    ⚙ Attach Test Clip
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="inspector-hint">
                  {pendingDownload
                    ? 'A generation was paid for but no clip is attached. Retrying the download costs nothing.'
                    : 'No clip yet for this transition.'}
                </p>
                <div className="inspector-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-tiny btn-dev"
                    title="Development: import an MP4 as this transition's output"
                    onClick={() =>
                      void window.f2f.clips.attach(project.id).then((clip) => {
                        if (!clip) return
                        updateTransition(project.id, start.id, end.id, {
                          clip,
                          status: 'completed'
                        })
                      })
                    }
                  >
                    ⚙ Attach Test Clip
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {note && <p className="inspector-note">{note}</p>}

      {liveConfirm && (
        <LiveGenerateDialog
          data={liveConfirm}
          busy={submitting}
          onCancel={() => setLiveConfirm(null)}
          onConfirm={() => {
            setSubmitting(true)
            void window.f2f.generation.generateLive(project.id, [pairKey]).then(() => {
              setSubmitting(false)
              setLiveConfirm(null)
              refreshProjects()
            })
          }}
        />
      )}
    </section>
  )
}

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="inspector-field">
      <span className="inspector-field-label">{label}</span>
      <span className="inspector-field-value">{value}</span>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
