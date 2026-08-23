import { useEffect, useState } from 'react'
import { useAppState } from '../../state/AppState'
import { transitionKey, type Project } from '../../types'
import { LiveGenerateDialog } from './LiveGenerateDialog'
import type { LiveConfirmationPayload } from '../../../../preload/index'
import { markManuallyEdited } from '../../../../shared/promptPlanner'
import { relateImages, type PropertyAnalysis } from '../../../../shared/propertyAnalysis'
import { attemptsForPair, formatSpend, type GenerationCostEntry } from '../../../../shared/costLedger'

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
  const { updateTransition, settings, refreshProjects } = useAppState()
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
  const transition = pairKey ? project.transitions[pairKey] : undefined

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

  if (!pairKey || !transition || !start || !end) {
    return (
      <section className="inspector inspector-empty">
        <p>Select a transition in the timeline to configure it.</p>
      </section>
    )
  }

  const hasAnalysis = analysis !== null && analysis.rooms.length > 0
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

            <div className="inspector-planned">
              <span className="inspector-planned-label">Planned motion</span>
              <p>
                {transition.promptProvenance?.motionInstruction ??
                  'No analysis-derived motion instruction — the base safety prompt is used unchanged.'}
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
              <button type="button" className="btn btn-primary btn-tiny" onClick={openGenerate}>
                {transition.clip ? 'Regenerate' : 'Generate'} with {providerName}
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
