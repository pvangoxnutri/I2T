import { useCallback, useEffect, useRef, useState } from 'react'
import type { Project } from '../../types'
import {
  isEditableTarget,
  selectTimeline,
  type EditorSelection
} from '../../../../shared/editorSelection'
import {
  itemDurationSec,
  itemStartTimes,
  locateAtTime,
  timelineDurationSec,
  type TimelineItem,
  type TimelineViewPayload
} from '../../../../shared/timeline'
import { MOTION_SHORT_LABEL, type MotionType } from '../../../../shared/motionSegment'

/**
 * THE FINAL EDIT, ON SCREEN.
 *
 * ── WHAT THIS IS AND IS NOT ──────────────────────────────────────────
 *
 * The Feed above is the production plan: photographs, transition modes,
 * analysis, what to generate. This is the film. Everything here changes
 * only what gets exported — never `feedSequence`, never a transition's
 * mode, never the generation history.
 *
 * Deliberately small: rectangles, a ruler, a playhead, and three verbs.
 * Split, delete, reorder. No tracks, no ripple modes, no effects rack.
 * The one thing it must communicate is "this is the finished video".
 *
 * ── PIXELS ARE DERIVED FROM SECONDS, ALWAYS ──────────────────────────
 *
 * One scale constant turns seconds into pixels, and every position —
 * block widths, the ruler, the playhead, a click's time — goes through
 * it. A second mapping would let the playhead and the blocks disagree
 * about where 7.4s is, which is the classic timeline bug.
 */

/**
 * ── ONE COORDINATE SYSTEM, DERIVED FROM THE VIEWPORT ────────────────
 *
 * The scale used to be a FIXED 26 px/s, which produced two faults at
 * once. A 38-second film came to 991px of content inside a 1244px
 * viewport, so a quarter of the strip was dead space. And the blocks
 * were laid out by flexbox with their own "duration or a minimum"
 * widths plus gaps, so they summed to 3146px while the ruler and the
 * playhead still measured in seconds — three elements, three different
 * ideas of where 17 seconds was.
 *
 * The scale is now computed from the actual viewport: the film fills
 * the width when it fits, and only exceeds it when the floor below
 * forces more room. Blocks are positioned ABSOLUTELY from their start
 * time, so the ruler, the playhead, the clips and the scrub surface
 * are the same mapping by construction rather than by coincidence.
 */
const MIN_PX_PER_SEC = 8
/** Nothing narrower than this is clickable, however short the clip. */
const MIN_BLOCK_PX = 18
/** Arrow-key nudge. A frame at 25fps, rounded to something visible. */
const NUDGE_SEC = 0.04

function fmt(sec: number): string {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  const rest = s - m * 60
  return `${String(m).padStart(2, '0')}:${rest.toFixed(1).padStart(4, '0')}`
}

function itemLabel(item: TimelineItem, project: Project): { kind: string; detail: string } {
  if (item.sourceType === 'motion-clip') {
    const seg = (project.motionSegments ?? []).find((s) => s.id === item.sourceId)
    return {
      kind: 'MOTION',
      detail: seg ? (MOTION_SHORT_LABEL[seg.motion as MotionType] ?? seg.motion) : 'Single image'
    }
  }
  if (item.sourceType === 'still') {
    const image = project.images.find((i) => i.id === item.sourceId)
    return { kind: 'STILL', detail: image?.fileName ?? 'Photograph' }
  }
  // A transition names its position in the feed, which is what the rest
  // of the editor calls it.
  const feed = project.feedSequence ?? project.images.map((i) => i.id)
  const [from] = item.sourceId.split('->')
  const at = feed.indexOf(from)
  return { kind: 'AI', detail: at >= 0 ? `${at + 1} → ${at + 2}` : 'Transition' }
}

export function TimelineEditor({
  project,
  view,
  selection,
  onSelect,
  onViewChanged,
  playing,
  onPlayingChange,
  showWatermark,
  showCornerStamp,
  onShowWatermarkChange,
  onShowCornerStampChange
}: {
  project: Project
  /** Owned by the page. See the note on ProjectEditorPage. */
  view: TimelineViewPayload | null
  /** The ONE selection. This component never keeps a second copy. */
  selection: EditorSelection
  onSelect: (next: EditorSelection) => void
  onViewChanged: (next: TimelineViewPayload) => void
  /** Transport, owned by the page — the preview is what decodes. */
  playing: boolean
  onPlayingChange: (next: boolean) => void
  /**
   * WHAT THE EDITOR PREVIEW SHOWS — not what gets exported.
   *
   * These are VIEW state. Unchecking a layer hides it on screen so the
   * operator can judge the footage underneath; it does not disable the
   * layer, delete its image, or change anything the export reads. The
   * export rasterises from the saved branding config and never sees
   * these values.
   */
  showWatermark: boolean
  showCornerStamp: boolean
  onShowWatermarkChange: (next: boolean) => void
  onShowCornerStampChange: (next: boolean) => void
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [confirmRebuild, setConfirmRebuild] = useState(false)
  /** True while the pointer is held down on the track. Enables scrubbing. */
  const scrubbing = useRef(false)

  const trackRef = useRef<HTMLDivElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const items = view?.timeline?.items ?? []
  const seam = view?.defaultSeamSec ?? 0
  const total = timelineDurationSec(items, seam)
  const starts = itemStartTimes(items, seam)

  /**
   * The scrub surface's real width, measured.
   *
   * A ResizeObserver rather than a one-off read: the editor grid resizes
   * with the window and with the workspace below, and a scale computed
   * once at mount would leave the strip the wrong width for the rest of
   * the session.
   */
  const [viewportPx, setViewportPx] = useState(0)
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setViewportPx(entry.contentRect.width))
    ro.observe(el)
    setViewportPx(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  /**
   * Pixels per second, so the film FILLS the viewport when it fits.
   *
   * The floor is what makes a genuinely long edit scroll: below
   * `MIN_PX_PER_SEC` a clip becomes too narrow to see or grab, and at
   * that point horizontal scrolling is the honest answer. Above it, the
   * viewport is never wider than the content and never narrower.
   */
  const pxPerSec = total > 0 && viewportPx > 0
    ? Math.max(viewportPx / total, MIN_PX_PER_SEC)
    : MIN_PX_PER_SEC
  const contentPx = Math.max(total * pxPerSec, viewportPx)
  /** Ruler spacing that stays readable however far the film is zoomed out. */
  const tickStep = pxPerSec >= 24 ? 1 : pxPerSec >= 12 ? 2 : pxPerSec >= 6 ? 5 : 10

  // ── DERIVED, NEVER STORED ───────────────────────────────────────────
  //
  // The selected item and the playhead come OUT of the one selection
  // rather than being kept beside it. That is what makes clicking a
  // transition in the Feed genuinely take the preview back: this
  // component has nothing of its own left to disagree with.
  const isTimelineMode = selection.kind === 'timeline'
  const selectedId = isTimelineMode ? selection.itemId : null
  const playheadSec = isTimelineMode ? selection.atSec : 0

  /** Move the playhead, keeping whatever item is selected. */
  const setPlayhead = (sec: number, itemId: string | null = selectedId): void => {
    onSelect(selectTimeline(itemId, Math.max(0, Math.min(total, sec))))
  }

  // ── NO CLOCK HERE ───────────────────────────────────────────────────
  //
  // This component used to advance the playhead on its own
  // requestAnimationFrame loop. Once the preview began driving the
  // playhead from the VIDEO's decoded time, that was a second clock
  // fighting the first: the strip would run ahead on wall time while the
  // picture lagged behind on decode time, and the two would argue over
  // the same selection every frame.
  //
  // Playback is the preview's, because the preview is what actually
  // decodes frames. The strip renders the position and asks for changes;
  // it does not keep time.

  const split = async (): Promise<void> => {
    if (!selectedId) {
      setError('Select a clip first.')
      return
    }
    const res = await window.f2f.projects.timeline.split(project.id, selectedId, playheadSec)
    if (res.ok) {
      onViewChanged(res.view)
      setError(null)
    } else setError(res.reason)
  }

  const remove = async (): Promise<void> => {
    if (!selectedId) return
    const res = await window.f2f.projects.timeline.delete(project.id, selectedId)
    if (res.ok) {
      onViewChanged(res.view)
      // The playhead survives; the item under it does not. Clearing the
      // selected id keeps the mode without pointing at a gone clip.
      onSelect(selectTimeline(null, Math.min(playheadSec, timelineDurationSec(res.view.timeline?.items ?? [], seam))))
      setError(null)
    } else setError(res.reason)
  }

  // ── KEYBOARD ────────────────────────────────────────────────────────
  //
  // Guarded by the CANONICAL `isEditableTarget`, the same one the feed's
  // arrow-key handling uses. Typing an "s" in a prompt must never cut the
  // film, and Delete in a text field must never remove a clip.
  //
  // The second guard is the mode: these keys only act while the TIMELINE
  // owns the preview. With a transition selected, Delete belongs to
  // whatever the feed decides — not to a clip the operator is not looking
  // at.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isEditableTarget(e.target as HTMLElement | null)) return
      if (!isTimelineMode) return

      if (e.key === 's' || e.key === 'S') {
        e.preventDefault()
        void split()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        void remove()
      } else if (e.key === ' ') {
        e.preventDefault()
        onPlayingChange(!playing)
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        setPlayhead(playheadSec + (e.key === 'ArrowRight' ? NUDGE_SEC : -NUDGE_SEC))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isTimelineMode, selectedId, playheadSec, total, project.id])

  /**
   * Seconds under the pointer.
   *
   * `scrollLeft` is added because the track scrolls horizontally: without
   * it, every position past the first screenful would be wrong by exactly
   * how far the operator had scrolled.
   */
  const timeAtPointer = (clientX: number): number => {
    const track = trackRef.current
    if (!track) return 0
    const rect = track.getBoundingClientRect()
    return Math.max(0, Math.min(total, (clientX - rect.left + track.scrollLeft) / pxPerSec))
  }

  // ── SCRUBBING ───────────────────────────────────────────────────────
  //
  // Pointer capture on the track, so a drag keeps working when the
  // pointer leaves the element — which it will, because the operator is
  // watching the preview rather than the strip. Every move updates the
  // playhead, and the preview seeks from it; there is no separate
  // approximation and no click-only path.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    // Blocks handle their own selection; scrubbing is the ruler and the
    // empty space around it.
    if ((e.target as HTMLElement).closest('.tl-block')) return
    scrubbing.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    onPlayingChange(false)
    setPlayhead(timeAtPointer(e.clientX))
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!scrubbing.current) return
    setPlayhead(timeAtPointer(e.clientX))
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!scrubbing.current) return
    scrubbing.current = false
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* the capture may already be gone; the final value below is what matters */
    }
    setPlayhead(timeAtPointer(e.clientX))
  }

  const rebuild = async (confirmDiscard: boolean): Promise<void> => {
    const res = await window.f2f.projects.timeline.rebuild(project.id, confirmDiscard)
    if (res.ok) {
      onViewChanged(res.view)
      onSelect(selectTimeline(null, 0))
      setConfirmRebuild(false)
      setError(null)
    } else {
      // The service refuses without a confirm when edits exist; that
      // refusal is what raises the confirmation rather than a guess here.
      setConfirmRebuild(true)
      setError(res.reason)
    }
  }

  const drift = view?.drift
  const missing = new Set(view?.missing ?? [])

  return (
    <section className="tl-editor" ref={rootRef} tabIndex={-1}>
      <header className="tl-editor-head">
        <div className="tl-editor-title">
          <span className="tl-editor-name">TIMELINE</span>
          <span className="tl-editor-sub">The video that gets exported</span>
        </div>

        <div className="tl-editor-transport">
          <button
            type="button"
            className="btn btn-ghost btn-tiny"
            onClick={() => onPlayingChange(!playing)}
            title="Play / pause (Space)"
          >
            {playing ? '❚❚' : '▶'}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-tiny"
            onClick={() => {
              onPlayingChange(false)
              setPlayhead(0, null)
            }}
            title="Back to start"
          >
            |◀
          </button>
          <span className="tl-editor-clock">
            {fmt(playheadSec)} / {fmt(total)}
          </span>
        </div>

        {/* ── PREVIEW LAYERS ─────────────────────────────────────────
            Next to the transport, because that is what they affect: what
            is on screen right now. Deliberately labelled as preview so
            nobody reads them as export settings — they are not. */}
        <div className="tl-layers" role="group" aria-label="Preview layers">
          <label className="tl-layer-toggle">
            <input
              type="checkbox"
              checked={showWatermark}
              onChange={(e) => onShowWatermarkChange(e.target.checked)}
            />
            Watermark
          </label>
          <label className="tl-layer-toggle">
            <input
              type="checkbox"
              checked={showCornerStamp}
              onChange={(e) => onShowCornerStampChange(e.target.checked)}
            />
            Corner stamp
          </label>
        </div>

        <div className="tl-editor-actions">
          <span className="tl-editor-hint">S = Split · Delete = Remove · Drag = Reorder</span>
          <button
            type="button"
            className="btn btn-ghost btn-tiny"
            onClick={() => void rebuild(false)}
            title="Discard this timeline and rebuild it from the current Feed"
          >
            Rebuild from Feed
          </button>
        </div>
      </header>

      {/* ── DRIFT ──────────────────────────────────────────────────────
          Reported, never acted on. A feed change must not silently
          rewrite an edit someone made by hand. */}
      {drift && drift.kind !== 'none' && (
        <div className={`tl-drift is-${drift.kind}`} role="status">
          <span>{drift.reason}</span>
          {drift.kind === 'conflict' ? (
            <span className="tl-drift-note">
              This timeline has manual edits. Rebuilding discards them.
            </span>
          ) : null}
          <button type="button" className="btn btn-ghost btn-tiny" onClick={() => void rebuild(false)}>
            Rebuild from Feed
          </button>
        </div>
      )}

      {confirmRebuild && (
        <div className="tl-confirm" role="alert">
          <span>Rebuilding will discard your splits, deletions and reordering.</span>
          <button type="button" className="btn btn-danger btn-tiny" onClick={() => void rebuild(true)}>
            Discard edits and rebuild
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-tiny"
            onClick={() => {
              setConfirmRebuild(false)
              setError(null)
            }}
          >
            Keep Timeline
          </button>
        </div>
      )}

      {error && !confirmRebuild && <p className="tl-error">{error}</p>}

      <div
        className="tl-scroll"
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="tl-inner" style={{ width: `${contentPx}px` }}>
          {/* ── RULER ─────────────────────────────────────────────── */}
          <div className="tl-ruler">
            {Array.from({ length: Math.floor(total / tickStep) + 1 }, (_, n) => n * tickStep).map((s) => (
              <span
                key={s}
                className={`tl-tick${s % (tickStep * 5) === 0 ? ' is-major' : ''}`}
                style={{ left: `${s * pxPerSec}px` }}
              >
                {s % (tickStep * 5) === 0 ? `${s}s` : ''}
              </span>
            ))}
          </div>

          <div className="tl-track">
            {items.length === 0 && (
              <p className="tl-empty">
                Nothing to show yet — generate clips in the Feed above, and the timeline appears
                here.
              </p>
            )}

            {items.map((item, i) => {
              const dur = itemDurationSec(item)
              const label = itemLabel(item, project)
              // ABSOLUTE, from this item's own start time — the very
              // number the ruler and the playhead use. Flex layout is
              // what previously let the three drift apart.
              const left = starts[i] * pxPerSec
              const width = Math.max(dur * pxPerSec, MIN_BLOCK_PX)
              const isMissing = missing.has(item.id)
              return (
                <div
                  key={item.id}
                  className={
                    `tl-block kind-${item.sourceType}` +
                    (selectedId === item.id ? ' is-selected' : '') +
                    (isMissing ? ' is-missing' : '') +
                    (dropIndex === i ? ' is-drop-target' : '')
                  }
                  style={{ left: `${left}px`, width: `${width}px` }}
                  draggable
                  onDragStart={() => setDragId(item.id)}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDropIndex(i)
                  }}
                  onDragEnd={() => {
                    setDragId(null)
                    setDropIndex(null)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (dragId && dragId !== item.id) {
                      void window.f2f.projects.timeline
                        .reorder(project.id, dragId, i)
                        .then((res) => {
                          if (res.ok) onViewChanged(res.view)
                          else setError(res.reason)
                        })
                    }
                    setDragId(null)
                    setDropIndex(null)
                  }}
                  onClick={(e) => {
                    // ── THE TIMELINE CLICK RULE ────────────────────
                    //
                    // Select the item, take ownership of the preview,
                    // and put the playhead at this item's ABSOLUTE
                    // start. It does not touch the feed selection, does
                    // not scroll the feed, and does not rebuild.
                    e.stopPropagation()
                    onPlayingChange(false)
                    onSelect(selectTimeline(item.id, starts[i]))
                  }}
                >
                  {item.sourceType === 'still' && item.sourceImageName ? (
                    <img className="tl-block-thumb" src={stillSrc(project, item)} alt="" />
                  ) : (
                    <video
                      className="tl-block-thumb"
                      src={clipSrc(project, item) ?? undefined}
                      preload="metadata"
                      muted
                    />
                  )}
                  <span className="tl-block-kind">{label.kind}</span>
                  <span className="tl-block-detail">{label.detail}</span>
                  <span className="tl-block-dur">{dur.toFixed(1)}s</span>
                  {isMissing && <span className="tl-block-warn">source missing</span>}
                </div>
              )
            })}
          </div>

          {/* The playhead spans ruler and track, so its position reads
              against both without a second calculation. */}
          <div className="tl-playhead" style={{ left: `${playheadSec * pxPerSec}px` }} />
        </div>
      </div>

      {/* ── SELECTED CLIP ──────────────────────────────────────────────
          Small on purpose: what it is, where it came from, and the exact
          in/out points a split produced. */}
      {selectedId && (
        <SelectedClipInfo
          item={items.find((i) => i.id === selectedId) ?? null}
          project={project}
          playheadSec={playheadSec}
          startSec={starts[items.findIndex((i) => i.id === selectedId)] ?? 0}
        />
      )}

      {/* NO <video> HERE.
          This component used to keep a hidden one and seek it itself,
          which made it a second preview competing with the real one.
          The playhead now lives in the selection, and PreviewStage —
          the only thing on screen that shows video — resolves it. */}
    </section>
  )
}

function clipSrc(project: Project, item: TimelineItem): string | null {
  if (!item.sourceClipName) return null
  return `f2f://clip/${project.id}/${item.sourceClipName}`
}

function stillSrc(project: Project, item: TimelineItem): string {
  return `f2f://image/${project.id}/${item.sourceImageName}`
}

function SelectedClipInfo({
  item,
  project,
  playheadSec,
  startSec
}: {
  item: TimelineItem | null
  project: Project
  playheadSec: number
  startSec: number
}): React.JSX.Element {
  if (!item) return <></>
  const label = itemLabel(item, project)
  return (
    <dl className="tl-clip-info">
      <div>
        <dt>Type</dt>
        <dd>
          {label.kind} · {label.detail}
        </dd>
      </div>
      <div>
        <dt>Source</dt>
        <dd className="tl-clip-source">
          {item.sourceClipName ?? item.sourceImageName ?? '—'}
        </dd>
      </div>
      <div>
        <dt>In / Out</dt>
        <dd>
          {item.startOffsetSec.toFixed(2)}s → {item.endOffsetSec.toFixed(2)}s
        </dd>
      </div>
      <div>
        <dt>Timeline duration</dt>
        <dd>{itemDurationSec(item).toFixed(2)}s</dd>
      </div>
      <div>
        <dt>Playhead in clip</dt>
        <dd>{Math.max(0, playheadSec - startSec).toFixed(2)}s</dd>
      </div>
    </dl>
  )
}
