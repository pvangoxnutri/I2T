import { useEffect, useRef, useState } from 'react'
import { useAppState } from '../../state/AppState'
import type { Project } from '../../types'
import { SEAM_SECONDS, type SeamBlend } from '../../../../shared/seamBlend'
import type { EditorSelection, PreviewMode } from '../../../../shared/editorSelection'
import { resolvePreviewSource, statusWordFor } from '../../../../shared/previewSource'

export type { PreviewMode }

/**
 * The main preview — the largest thing on screen, because it is the thing
 * being made.
 *
 * ── IT FOLLOWS THE SELECTION ─────────────────────────────────────────
 *
 * There is no mode switch beside the selection any more. Selecting a
 * photograph shows that photograph; selecting a transition shows that
 * transition's clip. The old four-button mode row let the preview disagree
 * with the timeline — you could select an image and still be watching a
 * clip — and every one of those states was a small lie about what the
 * editor was working on.
 *
 * Full Video is the single mode that is genuinely not about a selected
 * item, so it stays as one button.
 *
 * Start / End frame comparison survives, but only where it is useful: on a
 * transition that has no clip yet, where seeing the two endpoints is the
 * whole question. It is not a top-level mode competing with the others.
 *
 * ── NEVER RENDERS ON ITS OWN ─────────────────────────────────────────
 *
 * Switching selection and reordering images change what is DISPLAYED,
 * never what is encoded. Assembly is expensive and the editor would
 * otherwise re-render a whole video every time someone clicked a clip.
 * `Build Preview` is the only thing that starts an assembly, and it goes
 * through the existing export queue.
 *
 * ── STALE IS SAID OUT LOUD ───────────────────────────────────────────
 *
 * A built preview is a snapshot. Once clips or order change it no longer
 * shows the project, and silently playing an old file would be worse than
 * showing nothing — so it is labelled out of date rather than replaced or
 * hidden.
 */
export function PreviewStage({
  project,
  selection,
  mode,
  onShowFullVideo,
  onGenerate,
  generating = false
}: {
  project: Project
  selection: EditorSelection
  mode: PreviewMode
  onShowFullVideo: () => void
  /**
   * Opens the existing paid-request confirmation for the selected
   * transition. Routed through the editor page rather than called here so
   * the preview never reaches the generation path itself — the safety
   * gate, the provider lock and the cost dialog are all unchanged.
   */
  onGenerate?: () => void
  generating?: boolean
}): React.JSX.Element {
  const { settings, updateSettings } = useAppState()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [building, setBuilding] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const selectedPairKey = selection.kind === 'transition' ? selection.pairKey : null

  /**
   * The editor's working preview: a managed file, so it can be played
   * over f2f:// without the renderer ever seeing a filesystem path.
   * `builtAt` is the file's own mtime, so staleness survives a restart.
   */
  const [preview, setPreview] = useState<{
    url: string | null
    builtAt: number | null
    missing: string[]
  }>({ url: null, builtAt: null, missing: [] })

  useEffect(() => {
    void window.f2f.exports.previewState(project.id).then(setPreview)
  }, [project.id, project.updatedAt])

  // Stale when the project changed after the build. `updatedAt` moves on
  // clip attach, reorder and prompt edits — exactly the things that make
  // an assembled file stop representing the project. Playing an old file
  // silently would be worse than saying so.
  const previewStale = preview.builtAt !== null && project.updatedAt > preview.builtAt

  // ONE decision, made in `shared` where it can be asserted. The component
  // renders the answer rather than working it out inline — which is where
  // both of the reported bugs were able to hide.
  const source = resolvePreviewSource(
    project,
    selection,
    preview.url,
    settings.exportDefaults.defaultTransitionDurationSec
  )

  const src =
    source.kind === 'clip' ? source.src : source.kind === 'full' ? source.src : null
  const stillSrc = source.kind === 'image' ? source.src : null

  // Reset transport state whenever the source changes.
  useEffect(() => {
    setPlaying(false)
    setTime(0)
    setDuration(0)
  }, [src, stillSrc])

  const toggle = (): void => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      void v.play()
      setPlaying(true)
    } else {
      v.pause()
      setPlaying(false)
    }
  }

  const buildPreview = (): void => {
    setBuilding(true)
    setNote(null)
    void window.f2f.exports
      .buildPreview(project.id)
      .then((res) => {
        if (res.ok) {
          // Cache-bust: same managed path, new bytes.
          setPreview({ url: `${res.url}?t=${res.builtAt}`, builtAt: res.builtAt, missing: [] })
          onShowFullVideo()
          setNote(null)
        } else {
          setNote(res.reason)
        }
      })
      .finally(() => setBuilding(false))
  }

  const seam = (settings.exportDefaults.seamBlend ?? 'subtle') as SeamBlend

  const heading =
    source.kind === 'image'
      ? `IMAGE ${String(source.index + 1).padStart(2, '0')} · ${source.fileName}`
      : source.kind === 'clip' || source.kind === 'transition-endpoints'
        ? `TRANSITION ${source.index + 1} → ${source.index + 2}`
        : 'FULL VIDEO'

  return (
    <section className="preview-stage">
      <div className="preview-modes">
        {/* What the preview is showing, stated — not a control that can
            disagree with the timeline. */}
        <span className={`preview-context preview-context-${mode}`}>{heading}</span>

        <button
          type="button"
          className={`preview-mode${mode === 'full' ? ' is-active' : ''}`}
          aria-pressed={mode === 'full'}
          onClick={onShowFullVideo}
        >
          Full Video
        </button>

        <span className="preview-modes-spacer" />

        {/* Compact, next to the thing it affects — not buried in a form. */}
        <label className="preview-seam" title="Blend length at the joint between adjacent clips">
          <span>Assembly</span>
          <select
            value={seam}
            onChange={(e) =>
              updateSettings({
                exportDefaults: {
                  ...settings.exportDefaults,
                  seamBlend: e.target.value as SeamBlend
                }
              })
            }
          >
            <option value="off">Off</option>
            <option value="subtle">Subtle · {SEAM_SECONDS.subtle.toFixed(2)}s</option>
            <option value="smooth">Smooth · {SEAM_SECONDS.smooth.toFixed(2)}s</option>
          </select>
        </label>
      </div>

      <div className="preview-frame">
        {src ? (
          <video
            key={src}
            ref={videoRef}
            className="preview-video"
            src={src}
            playsInline
            preload="metadata"
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            onEnded={() => setPlaying(false)}
            onClick={toggle}
          />
        ) : stillSrc ? (
          /* `contain`, in CSS — a property photo stretched to the frame is
             a misrepresentation of the room it shows. */
          <img className="preview-still" src={stillSrc} alt="" />
        ) : source.kind === 'transition-endpoints' ? (
          /* ── A TRANSITION WITH NO CLIP IS NOT AN EMPTY SCREEN ────────
             It is two photographs and a question about how to get from
             one to the other. Showing the endpoints, the status and the
             action in one place is the difference between "nothing
             happened" and "here is what this is, and here is how to make
             it". The old version showed a bare line of text and hid
             Generate two tabs away. */
          <div className="preview-endpoints">
            <figure>
              <img src={source.startSrc} alt="" />
              <figcaption>Start · Image {source.index + 1}</figcaption>
            </figure>
            <div className="preview-endpoints-mid">
              <span className="preview-endpoints-arrow" aria-hidden>
                →
              </span>
              <span className="preview-endpoints-status">{statusWordFor(source.status)}</span>
              {onGenerate && source.canGenerate && (
                <button
                  type="button"
                  className="btn btn-primary btn-tiny"
                  onClick={onGenerate}
                  disabled={generating}
                  title="Opens the paid-request confirmation before anything is sent"
                >
                  {generating ? 'Opening…' : `Generate ${source.index + 1} → ${source.index + 2}`}
                </button>
              )}
            </div>
            <figure>
              <img src={source.endSrc} alt="" />
              <figcaption>End · Image {source.index + 2}</figcaption>
            </figure>
          </div>
        ) : (
          <div className="preview-empty">
            {mode === 'full' ? (
              <>
                <span className="preview-empty-title">No assembled preview yet</span>
                <span className="preview-empty-body">
                  Build one from the clips that already exist. This runs FFmpeg only — it never
                  generates AI video.
                </span>
              </>
            ) : source.kind === 'unavailable' ? (
              /* Reached only when the selection names nothing in the
                 current order — a stale pair key after a reorder. A pair
                 that exists always renders the endpoint view above. */
              <>
                <span className="preview-empty-title">Selection unavailable</span>
                <span className="preview-empty-body">{source.reason}</span>
              </>
            ) : (
              <>
                <span className="preview-empty-title">Nothing selected</span>
                <span className="preview-empty-body">
                  Pick an image or a transition in the timeline below.
                </span>
              </>
            )}
          </div>
        )}
      </div>

      <div className="preview-transport">
        <button
          type="button"
          className="preview-play"
          onClick={toggle}
          disabled={!src}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? '❚❚' : '▶'}
        </button>

        <input
          className="preview-scrub"
          type="range"
          min={0}
          max={duration || 0}
          step={0.01}
          value={time}
          disabled={!src || duration === 0}
          onChange={(e) => {
            const v = videoRef.current
            if (!v) return
            v.currentTime = Number(e.target.value)
            setTime(Number(e.target.value))
          }}
          aria-label="Scrub"
        />

        <span className="preview-time">
          {formatTime(time)} / {formatTime(duration)}
        </span>

        <button
          type="button"
          className="btn btn-ghost btn-tiny"
          onClick={() => void videoRef.current?.requestFullscreen?.()}
          disabled={!src}
        >
          Fullscreen
        </button>

        <button
          type="button"
          className="btn btn-ghost btn-tiny"
          onClick={buildPreview}
          disabled={building}
          title="Assemble the existing clips with FFmpeg. No AI generation."
        >
          {building ? 'Queuing…' : 'Build Preview'}
        </button>
      </div>

      {previewStale && mode === 'full' && (
        <p className="preview-stale">
          Preview out of date — clips or order changed since it was built.{' '}
          <button type="button" className="linklike" onClick={buildPreview}>
            Build Preview
          </button>
        </p>
      )}
      {note && <p className="preview-note">{note}</p>}
    </section>
  )
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
