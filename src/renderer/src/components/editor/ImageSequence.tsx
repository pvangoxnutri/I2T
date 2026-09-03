import { useEffect, useRef, useState } from 'react'
import { useAppState } from '../../state/AppState'
import { LiveGenerateDialog } from './LiveGenerateDialog'
import type { LiveConfirmationPayload, ProviderMetadataPayload } from '../../../../preload/index'
import { durationChoices } from '../../../../shared/transitionDuration'
import { resolveGenerationAction } from '../../../../shared/generationState'
import { markManuallyEdited } from '../../../../shared/promptPlanner'
import {
  defaultTransitionSettings,
  transitionKey,
  type Project,
  type TransitionStatus
} from '../../types'
import { getFeedImages } from '../../../../shared/feedSequence'

/** Human file size for the clip meta line. */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Generation state — deliberately independent of clip availability. */
const STATUS_LABEL: Record<TransitionStatus, string> = {
  'not-generated': 'Not generated',
  queued: 'Queued',
  generating: 'Generating',
  completed: 'Completed',
  failed: 'Failed'
}

/**
 * The ordered photo timeline: numbered image cards with native HTML5
 * drag-to-reorder, and a transition card between every consecutive pair
 * (Image 1 → Image 2, 2 → 3, …). Transition settings are keyed by the image
 * PAIR, so reordering other photos never loses a written prompt.
 */
export function ImageSequence({ project }: { project: Project }): React.JSX.Element {
  const { moveImage, removeImage, updateTransition, settings, refreshProjects, queue } =
    useAppState()
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // Developer detail: the sanitized request preview for one transition.
  const [preview, setPreview] = useState<{ pairKey: string; json: string } | null>(null)
  /** Pair whose clip row is recorded in the database but whose file is gone
   *  from disk — the one case where "completed" is not the whole truth. */
  const [clipMissing, setClipMissing] = useState<string | null>(null)
  // Paid-request confirmation for exactly ONE transition.
  const [liveConfirm, setLiveConfirm] = useState<{
    pairKey: string
    data: LiveConfirmationPayload
  } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  /**
   * Whether each attached clip's BYTES are actually on disk, and how big.
   *
   * A database row is not proof of a file. Checked up front rather than
   * only when someone happens to press "Open clip folder", so a transition
   * whose file was deleted underneath us says so immediately instead of
   * rendering a <video> that silently fails to load.
   */
  const [clipInfo, setClipInfo] = useState<Record<string, { exists: boolean; bytes: number }>>({})
  const [providerCatalog, setProviderCatalog] = useState<ProviderMetadataPayload[]>([])
  const clipNames = Object.values(project.transitions)
    .map((t) => t.clip?.storedName)
    .filter((n): n is string => typeof n === 'string')
  const clipNamesKey = clipNames.join('|')

  // Provider capabilities decide which durations may be offered.
  useEffect(() => {
    void window.f2f.providers.catalog().then(setProviderCatalog)
  }, [])

  useEffect(() => {
    let cancelled = false
    if (clipNames.length === 0) {
      setClipInfo({})
      return
    }
    void Promise.all(
      clipNames.map((name) =>
        window.f2f.clips.info(project.id, name).then((info) => [name, info] as const)
      )
    ).then((entries) => {
      if (!cancelled) setClipInfo(Object.fromEntries(entries))
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, clipNamesKey])

  /**
   * A job whose REMOTE generation already succeeded but whose clip is not
   * attached locally — the download still owes us. Resolved with the same
   * shared state machine the main process uses, so the UI can never decide
   * "nothing was generated" about a task that has already been paid for.
   */
  const pendingDownloadJob = (pairKey: string): (typeof queue)[number] | null =>
    queue.find(
      (j) =>
        j.projectId === project.id &&
        (j.metadata?.pairKeys ?? []).includes(pairKey) &&
        resolveGenerationAction(j.provider) === 'download'
    ) ?? null
  // The ACTIVE provider decides both whether Live is on and what the button
  // says. Each provider has its own safety lock.
  const activeProvider =
    settings.providers.find((p) => p.id === (settings.activeProviderId ?? settings.providers[0]?.id)) ??
    settings.providers[0]
  const providerName = activeProvider?.id === 'fal' ? 'fal.ai' : 'Kling'
  // The lengths the configured model actually publishes.
  const allowedDurations = durationChoices(
    providerCatalog
      .find((p) => p.id === activeProvider?.id)
      ?.models.find((m) => m.id === activeProvider?.model)?.durationsSec
  )
  const liveLockOn =
    activeProvider?.id === 'fal'
      ? settings.production.allowLiveFalRequests
      : settings.production.allowLiveKlingRequests
  const liveEnabled = activeProvider?.mode === 'live' && liveLockOn
  // Ref mirrors dragIndex for the drop handler (state can lag drop events).
  const dragIndexRef = useRef<number | null>(null)

  const beginDrag = (index: number) => (e: React.DragEvent): void => {
    dragIndexRef.current = index
    setDragIndex(index)
    e.dataTransfer.effectAllowed = 'move'
    // Some platforms need data set for the drag to start.
    e.dataTransfer.setData('text/plain', String(index))
  }

  const endDrag = (): void => {
    dragIndexRef.current = null
    setDragIndex(null)
    setDropIndex(null)
  }

  const overCard = (index: number) => (e: React.DragEvent): void => {
    if (dragIndexRef.current === null) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    // Above the midpoint → insert before; below → insert after.
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const before = e.clientY < rect.top + rect.height / 2
    setDropIndex(before ? index : index + 1)
  }

  const drop = (e: React.DragEvent): void => {
    e.preventDefault()
    const from = dragIndexRef.current
    if (from === null || dropIndex === null) return endDrag()
    // Removing the dragged card first shifts later indexes down by one.
    const to = dropIndex > from ? dropIndex - 1 : dropIndex
    moveImage(project.id, from, to)
    endDrag()
  }

  // Every pair key in feed sequence order, for the selection toolbar.
  const feedImages = getFeedImages(project)
  const pairKeys: { key: string; completed: boolean }[] = []
  for (let i = 0; i < feedImages.length - 1; i++) {
    const key = transitionKey(feedImages[i].id, feedImages[i + 1].id)
    pairKeys.push({ key, completed: project.transitions[key]?.status === 'completed' })
  }

  const toggleSelected = (key: string): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const queueSelected = (): void => {
    const keys = [...selected]
    if (keys.length === 0) return
    void window.f2f.generation.queue(project.id, keys).then(() => {
      setSelected(new Set())
      refreshProjects()
    })
  }

  return (
    <div className="sequence" onDrop={drop} onDragOver={(e) => e.preventDefault()}>
      {pairKeys.length > 0 && (
        <div className="generation-toolbar">
          <span className="generation-toolbar-title">AI generation</span>
          <button
            type="button"
            className="btn btn-ghost btn-tiny"
            onClick={() => setSelected(new Set(pairKeys.filter((p) => !p.completed).map((p) => p.key)))}
          >
            Select all incomplete
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-tiny"
            disabled={selected.size === 0}
            onClick={() => setSelected(new Set())}
          >
            Clear
          </button>
          <button
            type="button"
            className="btn btn-primary btn-tiny"
            disabled={selected.size === 0}
            title="Creates persistent MOCK generation jobs — no provider is called and no video is produced"
            onClick={queueSelected}
          >
            Queue selected ({selected.size}) · mock
          </button>
        </div>
      )}

      {feedImages.map((image, index) => {
        const next = feedImages[index + 1]
        const key = next ? transitionKey(image.id, next.id) : null
        const transition =
          key !== null
            ? (project.transitions[key] ??
              defaultTransitionSettings(settings.exportDefaults.defaultTransitionDurationSec))
            : null

        return (
          <div key={image.id} className="sequence-block">
            {dropIndex === index && dragIndex !== null && <div className="drop-indicator" />}

            <article
              className={`image-card${dragIndex === index ? ' is-dragging' : ''}`}
              draggable
              onDragStart={beginDrag(index)}
              onDragEnd={endDrag}
              onDragOver={overCard(index)}
            >
              <span className="image-card-number">{index + 1}</span>
              <div className="image-card-thumb">
                <img src={image.src} alt={image.fileName} draggable={false} />
              </div>
              <div className="image-card-info">
                <span className="image-card-name" title={image.fileName}>
                  {image.fileName}
                </span>
                <span className="image-card-hint">Drag to reorder</span>
              </div>
              <button
                type="button"
                className="image-card-remove"
                title="Remove photo"
                onClick={() => removeImage(project.id, image.id)}
              >
                ✕
              </button>
            </article>

            {next && transition && key && (
              <div className="transition-wrap">
                <div className="transition-line" aria-hidden />
                <article className="transition-card">
                  <header className="transition-card-head">
                    <label className="transition-select" title="Select for AI generation">
                      <input
                        type="checkbox"
                        checked={selected.has(key)}
                        onChange={() => toggleSelected(key)}
                      />
                      <span className="transition-card-title">
                        Transition · Image {index + 1} <span className="transition-arrow">→</span>{' '}
                        Image {index + 2}
                      </span>
                    </label>
                    <span className="transition-head-right">
                      {transition.status === 'completed' && !transition.clip && (
                        <span
                          className="mock-warning"
                          title="Mock generation completed without producing media — connect a provider for real clips"
                        >
                          no video output
                        </span>
                      )}
                      {/* Live generation: ONE transition, explicit confirm. */}
                      {liveEnabled && (
                        <button
                          type="button"
                          className="btn btn-primary btn-tiny"
                          title={`Sends a paid request to ${providerName} for this single transition`}
                          onClick={() =>
                            void window.f2f.generation
                              .liveConfirmation(project.id, key)
                              .then((data) => {
                                if (data) setLiveConfirm({ pairKey: key, data })
                              })
                          }
                        >
                          Generate with {providerName}
                        </button>
                      )}
                      {transition.status === 'completed' && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-tiny"
                          title={
                            liveEnabled
                              ? `This will create a NEW paid ${providerName} generation`
                              : 'Queue a fresh generation job for this transition'
                          }
                          onClick={() => {
                            if (liveEnabled) {
                              void window.f2f.generation
                                .liveConfirmation(project.id, key)
                                .then((data) => {
                                  if (data) setLiveConfirm({ pairKey: key, data })
                                })
                              return
                            }
                            void window.f2f.generation.queue(project.id, [key]).then(refreshProjects)
                          }}
                        >
                          Regenerate
                        </button>
                      )}
                      <span className={`status-chip status-chip-${transition.status}`}>
                        {STATUS_LABEL[transition.status]}
                      </span>
                    </span>
                  </header>
                  <textarea
                    className="input transition-prompt"
                    rows={2}
                    placeholder="Describe this camera move… e.g. “glide forward through the doorway into the living room”"
                    value={transition.prompt}
                    onChange={(e) =>
                      // A REAL edit is the only thing that may set
                      // manuallyEdited. Once set, Property Analysis can no
                      // longer rebuild this prompt — which is the whole
                      // protection, so it must never be inferred from the
                      // text merely differing from the plan.
                      updateTransition(project.id, image.id, next.id, {
                        prompt: e.target.value,
                        promptProvenance: markManuallyEdited(
                          transition.promptProvenance,
                          e.target.value,
                          Date.now()
                        )
                      })
                    }
                  />
                  {/* Provenance, stated plainly: the operator should know
                      whether a rebuild will touch this prompt BEFORE they
                      run one — not discover it afterwards. */}
                  <div className="prompt-provenance">
                    {transition.promptProvenance?.manuallyEdited ? (
                      <>
                        <span className="prompt-provenance-tag is-manual">Manually edited</span>
                        <span className="prompt-provenance-note">
                          Property Analysis will not overwrite this.
                        </span>
                        <button
                          type="button"
                          className="btn btn-ghost btn-tiny"
                          onClick={() => {
                            if (
                              !window.confirm(
                                'Replace your custom prompt with the one planned from Property Analysis?\n\nYour wording for this transition will be discarded and the transition becomes analysis-managed again.'
                              )
                            ) {
                              return
                            }
                            void window.f2f.projects.analysis.useAnalysisPrompt(project.id, key)
                          }}
                        >
                          Use analysis prompt
                        </button>
                      </>
                    ) : transition.promptProvenance ? (
                      <>
                        <span className="prompt-provenance-tag">
                          From analysis · {transition.promptProvenance.basis}
                        </span>
                        <span className="prompt-provenance-note">
                          {transition.promptProvenance.rationale}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="prompt-provenance-tag">Default prompt</span>
                        <button
                          type="button"
                          className="btn btn-ghost btn-tiny"
                          onClick={() =>
                            void window.f2f.projects.analysis.useAnalysisPrompt(project.id, key)
                          }
                        >
                          Use analysis prompt
                        </button>
                      </>
                    )}
                  </div>
                  <div className="transition-card-foot">
                    <label className="transition-duration">
                      Duration
                      <select
                        className="input select"
                        value={String(transition.durationSec)}
                        onChange={(e) =>
                          updateTransition(project.id, image.id, next.id, {
                            durationSec: Number(e.target.value)
                          })
                        }
                      >
                        {/* Offered by the CONFIGURED model, not by a literal.
                            Offering a value the model cannot honour would
                            silently snap on submit, handing back a clip of a
                            length nobody chose. */}
                        {allowedDurations.map((s) => (
                          <option key={s} value={s}>
                            {s} s
                          </option>
                        ))}
                      </select>
                    </label>
                    <span className="transition-note">
                      <button
                        type="button"
                        className="link-button"
                        title="Show the sanitized request that WOULD be sent (no credentials, nothing is sent)"
                        onClick={() =>
                          void window.f2f.generation.preview(project.id, key).then((res) => {
                            setPreview(
                              res.ok
                                ? { pairKey: key, json: JSON.stringify(res.preview, null, 2) }
                                : { pairKey: key, json: `Cannot build a request:\n\n${res.reason}` }
                            )
                          })
                        }
                      >
                        View Request
                      </button>
                    </span>
                  </div>

                  {/* This transition's output clip. Generation writes the same
                      field a manual attach does, so a finished fal.ai clip and
                      a hand-picked test video are shown and handled
                      identically from here on. */}
                  <div className="clip-row">
                    {transition.clip ? (
                      <>
                        {/* The generated video itself. A finished clip is the
                            POINT of the transition, so it is shown here in
                            full rather than hidden behind a filename — the
                            customer should never need to know AppData
                            exists. */}
                        <video
                          className="clip-preview"
                          src={transition.clip.src}
                          controls
                          playsInline
                          preload="metadata"
                        />
                        <div className="clip-meta">
                          <span className={`clip-source clip-source-${transition.clip.source}`}>
                            {transition.clip.source === 'fal'
                              ? 'Generated with fal.ai'
                              : transition.clip.source === 'kling'
                                ? 'Generated with Kling'
                                : 'Attached manually'}
                          </span>
                          <span className="clip-name" title={transition.clip.originalName}>
                            {transition.clip.originalName}
                          </span>
                          {clipInfo[transition.clip.storedName]?.exists && (
                            <span className="clip-size">
                              {formatBytes(clipInfo[transition.clip.storedName].bytes)}
                            </span>
                          )}
                        </div>
                        <div className="clip-actions">
                          <button
                            type="button"
                            className="btn btn-ghost btn-tiny"
                            title="Show this clip in your file manager"
                            onClick={() => {
                              const clip = transition.clip
                              if (!clip) return
                              void window.f2f.clips
                                .showInFolder(project.id, clip.storedName)
                                .then((shown) => {
                                  if (!shown) setClipMissing(key)
                                })
                            }}
                          >
                            Open clip folder
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-tiny"
                            onClick={() => {
                              const old = transition.clip
                              void window.f2f.clips.attach(project.id).then((clip) => {
                                if (!clip) return
                                if (old) void window.f2f.clips.remove(project.id, old.storedName)
                                updateTransition(project.id, image.id, next.id, {
                                  clip,
                                  status: 'completed'
                                })
                              })
                            }}
                          >
                            Replace
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-tiny"
                            onClick={() => {
                              const old = transition.clip
                              if (old) void window.f2f.clips.remove(project.id, old.storedName)
                              updateTransition(project.id, image.id, next.id, {
                                clip: null,
                                status: 'not-generated'
                              })
                            }}
                          >
                            Remove clip
                          </button>
                        </div>
                        {/* Recoverable, and honest about which recovery
                            applies. If the remote task still holds the
                            result, the fix is a FREE re-download — offering
                            Regenerate here would charge for a clip we have
                            already paid for. */}
                        {(clipMissing === key ||
                          clipInfo[transition.clip.storedName]?.exists === false) && (
                          <div className="clip-missing">
                            <p>
                              The clip file is no longer on disk. The transition still says
                              completed, but there is nothing to play or export.
                            </p>
                            {pendingDownloadJob(key) ? (
                              <button
                                type="button"
                                className="btn btn-ghost btn-tiny"
                                onClick={() => {
                                  const job = pendingDownloadJob(key)
                                  if (job) void window.f2f.queue.resumePolling(job.id)
                                }}
                              >
                                Retry download (free — the remote result is kept)
                              </button>
                            ) : (
                              <p className="clip-missing-hint">
                                Use Regenerate to create it again — this starts a new paid
                                generation.
                              </p>
                            )}
                          </div>
                        )}
                      </>
                    ) : pendingDownloadJob(key) ? (
                      /* The remote generation SUCCEEDED — this transition is
                         already paid for and the provider is holding the
                         result. The only thing missing is our download, so
                         the offer here is a free retry. Never a new paid
                         generation: that would charge twice for one clip. */
                      <div className="clip-pending">
                        <span className="clip-pending-label">Download pending</span>
                        <p className="clip-pending-body">
                          The generation finished at the provider. The video has not been
                          downloaded yet — retrying costs nothing and does not start a new
                          generation.
                        </p>
                        <button
                          type="button"
                          className="btn btn-ghost btn-tiny"
                          onClick={() => {
                            const job = pendingDownloadJob(key)
                            if (job) void window.f2f.queue.resumePolling(job.id)
                          }}
                        >
                          Retry download
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-ghost btn-tiny clip-attach"
                        title="Local development action — imports an MP4 as this transition's output so the export pipeline can be tested without an AI provider"
                        onClick={() =>
                          void window.f2f.clips.attach(project.id).then((clip) => {
                            if (!clip) return
                            updateTransition(project.id, image.id, next.id, {
                              clip,
                              status: 'completed'
                            })
                          })
                        }
                      >
                        ⚙ Attach Test Clip (dev)
                      </button>
                    )}
                  </div>
                </article>
                <div className="transition-line" aria-hidden />
              </div>
            )}
          </div>
        )
      })}

      {dropIndex === feedImages.length && dragIndex !== null && (
        <div className="drop-indicator" />
      )}

      {liveConfirm && (
        <LiveGenerateDialog
          data={liveConfirm.data}
          busy={submitting}
          onCancel={() => setLiveConfirm(null)}
          onConfirm={() => {
            setSubmitting(true)
            void window.f2f.generation
              .generateLive(project.id, [liveConfirm.pairKey])
              .then(() => {
                setSubmitting(false)
                setLiveConfirm(null)
                refreshProjects()
              })
          }}
        />
      )}

      {preview && (
        <div className="dialog-backdrop" onClick={() => setPreview(null)}>
          <div className="dialog-card dialog-card-wide" onClick={(e) => e.stopPropagation()}>
            <h3 className="dialog-title">Request preview · {preview.pairKey.slice(0, 8)}…</h3>
            <p className="dialog-body">
              Sanitized — credentials are redacted and nothing is sent. This is the exact request
              the provider path would submit in Live mode.
            </p>
            <pre className="request-preview">{preview.json}</pre>
            <div className="dialog-actions">
              <button type="button" className="btn btn-ghost btn-tiny" onClick={() => setPreview(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
