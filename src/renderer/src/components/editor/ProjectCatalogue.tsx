import { useCallback, useEffect, useState } from 'react'
import type { GenerationRecord } from '../../types'
import { getFeedImages } from '../../../../shared/feedSequence'
import { MOTION_SHORT_LABEL, type MotionType } from '../../../../shared/motionSegment'

/**
 * Project Catalogue — historical record of all generated transitions.
 *
 * Shows every generation for the project, newest first, including inactive
 * ones that have been superseded. Preserved across feed reorders.
 *
 * Every generation is real, paid-for work: the list is the record of
 * what this project has produced, and any row can be made active again.
 */

/**
 * A stored motion type as a readable phrase.
 *
 * Derived from the shared label map, so the catalogue and the timeline
 * cannot end up calling the same movement two different things. Falls
 * back to the raw value: a row written by a future build with a motion
 * this one has never heard of must still be legible.
 */
function motionWord(motion: string): string {
  return MOTION_SHORT_LABEL[motion as MotionType] ?? motion
}

/** The registry's display name for a model id, else the id itself. */
function modelName(id: string): string {
  return id.split('/').slice(-3).join('/')
}

export function ProjectCatalogue({
  projectId,
  open,
  onClose,
  onRegenerate,
  currentPairKeys = [],
  focusGenerationId = null
}: {
  projectId: string
  open: boolean
  onClose: () => void
  /** Opens the normal paid-generation confirmation for this pair. */
  onRegenerate?: (fromImageId: string, toImageId: string) => void
  /**
   * Pairs the CURRENT feed contains.
   *
   * History outlives feed edits deliberately, so a row can describe two
   * photographs that are no longer adjacent. Those rows stay visible and
   * previewable — the clip is real and was paid for — but Regenerate is
   * disabled, because there is no such transition to spend money on.
   */
  currentPairKeys?: string[]
  /** Open with this generation already expanded. */
  focusGenerationId?: string | null
}): React.JSX.Element {
  const [generations, setGenerations] = useState<GenerationRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [attaching, setAttaching] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  /** Which row's clip is expanded for viewing. */
  const [previewing, setPreviewing] = useState<string | null>(null)

  /**
   * Feed positions, so a motion row can say IMAGE 11 rather than a uuid.
   *
   * Read from the project because history stores IDS, deliberately: a
   * position is a fact about the current feed and changes when photos
   * are reordered, so storing it would make old rows lie.
   */
  const [positions, setPositions] = useState<Record<string, number>>({})

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    const data = await window.f2f.projects.catalogue.getAll(projectId)
    setGenerations(data)
    const project = (await window.f2f.projects.list()).find((p) => p.id === projectId)
    if (project) {
      const feed = getFeedImages(project)
      setPositions(Object.fromEntries(feed.map((img, i) => [img.id, i + 1])))
    }
    setLoading(false)
  }, [projectId])

  /** `IMAGE 11`, or an honest note when the photo has left the feed. */
  const imageLabel = (imageId: string): string => {
    const at = positions[imageId]
    return at ? `IMAGE ${String(at).padStart(2, '0')}` : 'IMAGE (not in feed)'
  }

  useEffect(() => {
    if (!open) return
    void load()
  }, [open, load])

  // Expand the generation that was asked about, so Review quality lands
  // on the clip rather than on a list to search.
  useEffect(() => {
    if (open && focusGenerationId) setPreviewing(focusGenerationId)
  }, [open, focusGenerationId])

  if (!open) return <></>

  const attach = (gen: GenerationRecord): void => {
    setAttaching(gen.id)
    void window.f2f.projects.catalogue.attach(projectId, gen.id).then((res) => {
      setAttaching(null)
      setNote(res.ok ? 'Now the active clip for its transition.' : res.reason)
      if (res.ok) void load()
    })
  }

  return (
    <div className="catalogue-overlay" onClick={onClose}>
      <div className="catalogue-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="catalogue-header">
          <h2>Generation History</h2>
          {note && <span className="catalogue-note">{note}</span>}
          <button type="button" className="catalogue-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="catalogue-body">
          {loading ? (
            <p className="catalogue-empty">Loading generations...</p>
          ) : generations.length === 0 ? (
            <p className="catalogue-empty">No generations yet</p>
          ) : (
            <ul className="catalogue-list">
              {generations.map((gen) => {
                return (
                  <li key={gen.id} className="catalogue-item">
                    {gen.clip && (
                      <div className="catalogue-item-preview">
                        <video
                          src={gen.clip.src}
                          controls={previewing === gen.id}
                          playsInline
                          // Load the first frame and the duration without
                          // waiting for playback, so the row shows a real
                          // thumbnail rather than an empty box.
                          preload="metadata"
                          // ── WHY NOT autoPlay ──────────────────────────
                          //
                          // The `autoPlay` attribute is subject to
                          // Chromium's autoplay policy: unmuted media that
                          // has not been started inside a user-activation
                          // window is refused. React mounts this element
                          // AFTER the click that asked for it, so the
                          // activation has lapsed and the attribute does
                          // nothing.
                          //
                          // Measured on the real clip: duration 3.04,
                          // readyState 4 — fully loaded — and paused=true,
                          // currentTime=0. The video was there the whole
                          // time and simply never started, which is exactly
                          // "it opens but stays at 0:00 and never loads".
                          //
                          // An explicit play() from here is permitted and
                          // does start it. If a future policy refuses it,
                          // the controls are right there and the reason is
                          // logged rather than swallowed.
                          // Driven from the ref rather than `onCanPlay`:
                          // the element is mounted for every row as a
                          // thumbnail, so `canplay` has already fired long
                          // before Preview is pressed and never fires
                          // again. The ref runs on the render that follows
                          // the click, which is exactly when to start.
                          ref={(el) => {
                            if (!el) return
                            if (previewing === gen.id && el.paused) {
                              void el.play().catch((err: Error) => {
                                console.warn(
                                  `[catalogue] playback did not start gen=${gen.id} ${err.name}: ${err.message}`
                                )
                              })
                            } else if (previewing !== gen.id && !el.paused) {
                              el.pause()
                            }
                          }}
                          // A player that fails silently is why this took
                          // so long to find: the url was malformed, the
                          // protocol handler answered 404, and the element
                          // simply showed nothing. Say what happened.
                          onError={(e) => {
                            const el = e.currentTarget
                            console.error(
                              `[catalogue] clip failed to load gen=${gen.id} src=${gen.clip?.src}` +
                                ` code=${el.error?.code ?? '?'} message=${el.error?.message ?? ''}`
                            )
                            setNote(
                              'The clip could not be played in the app. Use Show in folder to open it directly.'
                            )
                          }}
                        />
                      </div>
                    )}
                    <div className="catalogue-item-info">
                      {/* ── WHAT THIS GENERATION WAS ──────────────────
                          A single-image motion clip is NEVER rendered as
                          "Image 11 → Image 11". It was made from one
                          photograph, and the arrow would describe a
                          journey between two rooms that never happened.
                          The discriminator is `motionSegmentId`, not the
                          two image ids being equal — they are not. */}
                      {gen.motionSegmentId ? (
                        <div className="catalogue-pair catalogue-pair-motion">
                          SINGLE IMAGE MOTION
                          {/* Each generation's OWN motion and length, off
                              its own row — never the segment's current
                              values, which a later regeneration moves on. */}
                          <span className="catalogue-motion-detail">
                            {imageLabel(gen.fromImageId)}
                            {gen.motionType ? ` · ${motionWord(gen.motionType)}` : ''}
                            {gen.durationSec ? ` · ${gen.durationSec}s` : ''}
                          </span>
                        </div>
                      ) : (
                        <div className="catalogue-pair">
                          {gen.fromImageId} → {gen.toImageId}
                        </div>
                      )}
                      <div className="catalogue-provider">
                        {gen.provider}
                        {gen.model ? ` · ${modelName(gen.model)}` : ''}
                      </div>
                      <div className="catalogue-timestamp">
                        {new Date(gen.createdAt).toLocaleString()}
                      </div>

                      {/* PROVIDER AND QUALITY, SEPARATELY.
                          A quality failure is not a provider failure —
                          the provider did its job and was paid. */}
                      <div className="catalogue-status-row">
                        <span className="catalogue-provider-status">
                          Generated successfully
                        </span>
                        {gen.active && <span className="catalogue-active">● Active</span>}
                      </div>

                    </div>

                    <div className="catalogue-actions">
                      {gen.clip && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-tiny"
                          onClick={() =>
                            setPreviewing(previewing === gen.id ? null : gen.id)
                          }
                        >
                          {previewing === gen.id ? 'Stop preview' : 'Preview'}
                        </button>
                      )}

                      {/* ── REUSE, WITHOUT PAYING AGAIN ──────────────────
                          Attaching is bookkeeping over work already done:
                          no file copy, no provider request, no new spend.
                          The pair comes from the GENERATION, never from
                          whatever is selected, so a clip can only ever
                          become active for the two images it was made
                          from. */}
                      {gen.clip && !gen.active && !gen.motionSegmentId && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-tiny catalogue-attach"
                          disabled={attaching === gen.id}
                          onClick={() => attach(gen)}
                        >
                          {attaching === gen.id ? 'Attaching…' : 'Use for its transition'}
                        </button>
                      )}

                      {/* A motion generation is regenerated from its own
                          inspector, where the model selector for
                          single-image runs lives. Offering the pair
                          Regenerate here would submit a TRANSITION for
                          two images that were never a pair. */}
                      {gen.motionSegmentId && (
                        <span
                          className="catalogue-motion-hint"
                          title="Open this motion clip in the timeline to regenerate it — single-image runs have their own model selector."
                        >
                          Regenerate from the timeline
                        </span>
                      )}

                      {onRegenerate &&
                        !gen.motionSegmentId &&
                        (() => {
                          const stale =
                            currentPairKeys.length > 0 &&
                            !currentPairKeys.includes(`${gen.fromImageId}->${gen.toImageId}`)
                          return (
                            <button
                              type="button"
                              className="btn btn-ghost btn-tiny"
                              disabled={stale}
                              title={
                                stale
                                  ? 'These two photographs are no longer next to each other in the Transition Feed, so this transition does not exist any more. Reorder the feed to bring them back together before regenerating.'
                                  : 'Submits a new paid generation for this pair. Existing generations stay in History.'
                              }
                              onClick={() => onRegenerate(gen.fromImageId, gen.toImageId)}
                            >
                              Regenerate — costs again
                            </button>
                          )
                        })()}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

      </div>
    </div>
  )
}
