import { useEffect, useRef, useState } from 'react'
import type { FeedTransitionView } from '../../../../shared/feedTransitionState'
import { useAppState } from '../../state/AppState'
import type { Project } from '../../types'
import { SEAM_SECONDS, type SeamBlend } from '../../../../shared/seamBlend'
import type { EditorSelection, PreviewMode } from '../../../../shared/editorSelection'
import { itemStartTimes, type TimelineItem } from '../../../../shared/timeline'
import { resolvePreviewSource, statusWordFor } from '../../../../shared/previewSource'
import {
  BRAND_MARGIN_FRACTION,
  brandRect,
  containFit,
  resolveBranding,
  type ContentBox
} from '../../../../shared/branding'
import { measureAlphaBounds } from '../../utils/alphaBounds'
import type { TransitionRecovery } from '../../../../shared/transitionRecovery'
import { MODE_LABEL, type ResolvedModeRow } from '../../../../shared/transitionMode'

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
  onRecover,
  recovery,
  transitionMode,
  view,
  timeline,
  onTimelineSeek,
  playing: playingProp,
  onPlayingChange,
  showWatermark = false,
  showCornerStamp = false,
  generating = false
}: {
  project: Project
  selection: EditorSelection
  /**
   * The final edit, owned by the page.
   *
   * Handed down rather than fetched here so the preview and the timeline
   * strip resolve the playhead from the SAME item list — two independent
   * fetches would let them disagree for a frame after every edit.
   */
  timeline?: { items: TimelineItem[]; defaultSeamSec: number } | null
  /**
   * Move the timeline playhead.
   *
   * The preview does not own the playhead — the selection does — so
   * playback reports where it has reached rather than storing it. The
   * second argument says whether this came from playback, so the strip
   * can avoid fighting a scrub with a frame update.
   */
  onTimelineSeek?: (absoluteSec: number, fromPlayback: boolean) => void
  /** Controlled in timeline mode, so the strip’s button agrees. */
  playing?: boolean
  onPlayingChange?: (next: boolean) => void
  /** PREVIEW VISIBILITY ONLY. Never consulted by the export. */
  showWatermark?: boolean
  showCornerStamp?: boolean
  mode: PreviewMode
  onShowFullVideo: () => void
  /**
   * Performs the recovery the preview is offering. Routed through the
   * editor page rather than called here so the preview never reaches the
   * generation path itself — the safety gate, the provider lock and the
   * cost dialog are all unchanged.
   */
  onRecover?: () => void
  /** What to offer for the selected transition, decided in `shared`. */
  recovery?: TransitionRecovery | null
  /** How the selected transition will behave — generated, cut, dissolved. */
  transitionMode?: ResolvedModeRow | null
  /**
   * What the CANONICAL derivation says about this transition.
   *
   * This pane had its own reading of `transition.status` and printed
   * "Transition 11 → 12 failed" for a generation that succeeded,
   * downloaded, and was merely held for review — the same overloaded
   * value the timeline was taught to stop trusting. The word comes from
   * one place now.
   */
  view?: FeedTransitionView | null
  generating?: boolean
}): React.JSX.Element {
  const { settings, updateSettings } = useAppState()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [localPlaying, setLocalPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [building, setBuilding] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  // Controlled while the timeline owns the preview; local otherwise, so
  // an individual clip keeps its own transport without the page caring.
  const playing = playingProp ?? localPlaying
  const setPlaying = (next: boolean): void => {
    setLocalPlaying(next)
    onPlayingChange?.(next)
  }

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
    settings.exportDefaults.defaultTransitionDurationSec,
    // The timeline is owned by the page and handed down, so the preview
    // and the timeline strip resolve the playhead from ONE list.
    timeline
  )

  const src =
    source.kind === 'clip' ||
    source.kind === 'motion-clip' ||
    source.kind === 'full' ||
    (source.kind === 'timeline' && !source.isStill)
      ? source.src
      : null
  // A timeline STILL is a held photograph: there is no file to seek, so
  // it renders through the same image path a selected photo does.
  const stillSrc =
    source.kind === 'image'
      ? source.src
      : source.kind === 'timeline' && source.isStill
        ? source.src
        : null
  // Whether the FILM owns the clock, rather than whichever file is
  // decoding. Declared here because the transport, the reset effect and
  // the boundary handover all branch on it.
  const isTimelineMode = source.kind === 'timeline'
  // The RESOLVED branding — the project’s own choice where it has
  // made one, the business default where it has not. The same resolver
  // the export uses, so the preview cannot show one image and ship
  // another. The toggles decide only whether it is drawn.
  const branding = resolveBranding(project, settings)
  const brandWatermark = branding.watermark
  const brandStamp = branding.signature

  /**
   * WHERE THE PICTURE ACTUALLY IS INSIDE THE FRAME.
   *
   * ── THE BUG THIS FIXES ────────────────────────────────────────────
   *
   * The overlays were positioned against `.preview-frame`, which is the
   * whole pane. The video is `object-fit: contain` inside it, so on a
   * 876×385 frame a 16:9 clip renders 573×383 with a 152px black bar
   * down each side — and `bottom-right: 3%` put the corner stamp at
   * x 1338–1443 while the picture ended at 1318. The stamp sat in the
   * letterbox, entirely off the film.
   *
   * That is wrong twice over. It does not show where the stamp will be
   * in the exported file, which composites onto the PICTURE; and a mark
   * floating in the black surround reads as permanent chrome rather than
   * as a layer over the video — which is exactly how it looked.
   *
   * The contain-fit rectangle is computed here from the media's own
   * intrinsic size, and both overlays are placed inside it.
   */
  const [frameBox, setFrameBox] = useState({ w: 0, h: 0 })
  const [mediaSize, setMediaSize] = useState({ w: 0, h: 0 })
  const frameRef = useRef<HTMLDivElement>(null)

  /**
   * THE BRAND ASSETS' OWN DIMENSIONS.
   *
   * Needed because a stamp is NOT square. `sizePct` sets the width; the
   * height has to come from the file, or the anchored rectangle is a
   * guess and the mark does not sit where the corner is.
   *
   * Captured from `onLoad` AND from a ref callback that reads
   * `naturalWidth` when the element is already `complete`. The ref path
   * is not belt-and-braces: an image whose bytes are already cached can
   * fire `load` before React has attached the handler, and then the
   * handler never runs. That left the size at 0, which made the
   * rectangle 0×0 — an overlay that is mounted, has its src, and is
   * invisible. It is one of the two ways the toggles could come back ON
   * and show nothing.
   */
  const [watermarkNatural, setWatermarkNatural] = useState({ w: 0, h: 0 })
  const [stampNatural, setStampNatural] = useState({ w: 0, h: 0 })
  /**
   * WHERE THE STAMP'S ARTWORK SITS INSIDE ITS OWN FILE.
   *
   * The operator's asset is a 1920x1080 canvas with a 643x253 mark at
   * (637, 416) — 640 px of transparency between the mark and the
   * canvas's right edge. Anchoring the file put the mark far inside the
   * corner; anchoring what is actually visible puts it in the corner.
   * Null until measured, and null is "use the whole canvas".
   */
  const [stampContent, setStampContent] = useState<ContentBox | null>(null)

  /**
   * ── AND IT MUST NOT SET STATE ON EVERY ATTACH ──────────────────────
   *
   * The first version of this stored `{ w, h }` unconditionally from a
   * ref callback, and took the editor down with React error #185,
   * "maximum update depth exceeded": an inline ref callback is a new
   * function on every render, so React detaches and reattaches it every
   * render, the callback called `setState` with a freshly allocated
   * object every time, a new object is never `Object.is`-equal to the
   * last one, and that re-render attached the ref again. Clicking a
   * timeline clip blanked the whole editor.
   *
   * Returning the PREVIOUS object when the numbers are unchanged makes
   * React bail out of the update, which ends the cycle at its source
   * rather than relying on the callback's identity being stable.
   */
  const captureNatural =
    (set: React.Dispatch<React.SetStateAction<{ w: number; h: number }>>) =>
    (el: HTMLImageElement | null): void => {
      if (!el?.complete || el.naturalWidth <= 0) return
      const w = el.naturalWidth
      const h = el.naturalHeight
      set((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
    }

  useEffect(() => {
    const el = frameRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) =>
      setFrameBox({ w: e.contentRect.width, h: e.contentRect.height })
    )
    ro.observe(el)
    setFrameBox({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  /** The displayed picture rectangle. One shared derivation — see containFit. */
  const pictureBox =
    frameBox.w && frameBox.h && mediaSize.w && mediaSize.h
      ? containFit(frameBox.w, frameBox.h, mediaSize.w, mediaSize.h)
      : null

  // ── WHERE EACH MARK GOES, IN PIXELS ────────────────────────────────
  //
  // Not CSS percentages. `right: 3%` resolves against the container's
  // WIDTH and `bottom: 3%` against its HEIGHT, so on a 16:9 picture the
  // two insets were different distances — and neither was the one the
  // export uses, which is a single margin off the SHORT side. Measured
  // on 1920×1080: export 32px on both edges, preview 57.6px right and
  // 32.4px bottom. `brandRect` is that export rule, shared.
  const watermarkRect =
    pictureBox && watermarkNatural.w && brandWatermark
      ? brandRect(
          pictureBox,
          watermarkNatural,
          brandWatermark.sizePct,
          brandWatermark.position,
          BRAND_MARGIN_FRACTION.watermark
        )
      : null
  const stampRect =
    pictureBox && stampNatural.w && brandStamp
      ? brandRect(
          pictureBox,
          stampNatural,
          brandStamp.sizePct,
          brandStamp.position,
          BRAND_MARGIN_FRACTION.stamp,
          // Anchor the artwork, not the file it arrived in.
          stampContent
        )
      : null
  // Only an AI transition has anything to generate or recover.
  const aiMode = !transitionMode || transitionMode.effectiveMode === 'ai'

  // Reset transport state whenever the source changes.
  //
  // EXCEPT IN TIMELINE MODE. There the source changes at every item
  // boundary, and stopping there is exactly what must not happen: the
  // film is one continuous thing that happens to be stored as several
  // files. Pausing on each handover would end playback at the first cut.
  useEffect(() => {
    if (isTimelineMode) return
    setPlaying(false)
    setTime(0)
    setDuration(0)
  }, [src, stillSrc, isTimelineMode])

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

  // ── TIMELINE MODE HAS ITS OWN CLOCK ─────────────────────────────────
  //
  // THE BUG THIS FIXES. The transport read `video.duration` — the length
  // of the FILE under the playhead. In timeline mode that is one clip, so
  // a 45-second film displayed "0:00 / 0:05" and the scrub bar covered
  // five seconds of a forty-five second edit.
  //
  // The film's length is a property of the TIMELINE, not of whichever
  // file happens to be decoding, so in timeline mode both numbers come
  // from the canonical total and the absolute playhead. `video.duration`
  // is never consulted.
  const shownTime = isTimelineMode ? source.absoluteSec : time
  const shownTotal = isTimelineMode ? source.totalSec : duration

  /**
   * ── THE SCRUBBER ────────────────────────────────────────────────────
   *
   * THE BUG THIS FIXES. In timeline mode the slider's VALUE is absolute
   * timeline seconds, but its handler did:
   *
   *     v.currentTime = Number(e.target.value)
   *
   * — feeding an absolute film position straight into the local clock of
   * whichever five-second file happened to be decoding. Dragging to 20s
   * on a 40s edit seeked that clip to 20s, which clamps to its end; the
   * element then reported ~5s, that was converted back to an absolute
   * position, and the thumb snapped away from the pointer. It also never
   * moved the timeline playhead, because it never told the selection
   * anything at all.
   *
   * Two mappings, chosen by mode and never mixed:
   *
   *   timeline   → absolute film seconds → the selection → locateAtTime
   *   individual → local file seconds    → the element
   *
   * `scrubbing` is a REF, not state: it is read inside `timeupdate`,
   * which fires between renders, and a stale closure over a state value
   * would let playback overwrite the drag exactly as before.
   */
  const scrubbing = useRef(false)
  const [scrubSec, setScrubSec] = useState<number | null>(null)

  /** What the control shows: the dragged value while dragging, else truth. */
  const displayTime = scrubSec !== null ? scrubSec : shownTime

  const seekTo = (target: number): void => {
    const clamped = Math.max(0, Math.min(shownTotal || 0, target))
    setScrubSec(clamped)
    if (isTimelineMode) {
      // ABSOLUTE. `resolvePreviewSource` turns it into a file and a local
      // offset and the seek effect honours that. Nothing here writes
      // `currentTime` directly — doing so is what caused the snap-back.
      onTimelineSeek?.(clamped, false)
    } else {
      const v = videoRef.current
      if (v) v.currentTime = clamped
      setTime(clamped)
    }
  }

  /**
   * PLAY THE WHOLE FILM.
   *
   * The element only knows about one clip, so when it reaches the end of
   * the current item's OUT point the playhead is advanced past it and the
   * next item takes over — which changes `src`, seeks, and keeps going.
   * `onTimeUpdate` drives this because it is the element's own clock: the
   * boundary is detected from real decoded time rather than a timer that
   * would drift away from the picture.
   */
  const advanceToNextItem = (): void => {
    if (!isTimelineMode || !onTimelineSeek || !timeline) return
    const idx = timeline.items.findIndex((i) => i.id === source.itemId)
    if (idx === -1) return

    if (idx === timeline.items.length - 1) {
      // The end of the film. Stop, and park the playhead on the last
      // frame rather than wherever the file happened to run out.
      setPlaying(false)
      videoRef.current?.pause()
      onTimelineSeek(source.totalSec, false)
      return
    }
    // The next item's absolute start, plus a hair, so `locateAtTime`
    // resolves to the NEXT item rather than to this one's last instant.
    const starts = itemStartTimes(timeline.items, timeline.defaultSeamSec)
    onTimelineSeek(starts[idx + 1] + 0.01, true)
  }

  const onTimelineTimeUpdate = (el: HTMLVideoElement): void => {
    if (!isTimelineMode || !onTimelineSeek || !timeline) return
    // THE DRAG WINS. While a pointer is down on the scrubber the
    // element is being seeked TO the requested position; letting its
    // own reports write back is the feedback loop that made the thumb
    // jump away from the cursor.
    if (scrubbing.current) return
    const item = timeline.items.find((i) => i.id === source.itemId)
    if (!item) return

    // Past this item's OUT point: hand over. The tolerance is a quarter
    // of a second because `timeupdate` fires roughly that often — a
    // tighter window would be stepped straight over, and the file would
    // reach its own end first.
    if (el.currentTime >= item.endOffsetSec - 0.25) {
      advanceToNextItem()
      return
    }

    // Ordinary playback: report the ABSOLUTE position, derived from how
    // far into this item's source we are.
    const idx = timeline.items.findIndex((i) => i.id === item.id)
    const starts = itemStartTimes(timeline.items, timeline.defaultSeamSec)
    const intoItem = el.currentTime - item.startOffsetSec
    onTimelineSeek(Math.max(0, starts[idx] + intoItem), true)
  }

  /**
   * A NEW ITEM TOOK OVER — KEEP PLAYING.
   *
   * `key={src}` remounts the element at every handover, so the new one
   * starts paused and has to be told to play.
   *
   * The retry matters. A remounted element can reject `play()` because
   * it has not finished loading, and the first version of this treated
   * that transient rejection as a reason to stop the film for good —
   * which is exactly what it did, silently, at the first boundary. Now a
   * rejection waits for the element to become ready and tries again;
   * only a genuine failure stops playback.
   */
  useEffect(() => {
    const el = videoRef.current
    if (!el || !isTimelineMode || !playing) return
    let cancelled = false

    const start = (): void => {
      if (cancelled || !videoRef.current) return
      void videoRef.current.play().catch(() => {
        if (cancelled) return
        // Not ready yet. `canplay` is the element telling us when it is.
        videoRef.current?.addEventListener(
          'canplay',
          () => {
            if (!cancelled) void videoRef.current?.play().catch(() => setPlaying(false))
          },
          { once: true }
        )
      })
    }
    start()
    return () => {
      cancelled = true
    }
  }, [isTimelineMode, playing, source.kind === 'timeline' ? source.itemId : null])

  // ── SCRUBBING SEEKS THE FILE ────────────────────────────────────────
  //
  // The timeline hands down an ABSOLUTE position; `resolvePreviewSource`
  // has already turned it into a file and a SOURCE offset. All this does
  // is honour it. It runs on every change of `sourceSec`, which is what
  // makes dragging the playhead update the frame continuously rather
  // than only on release.
  //
  // The 0.05s guard stops a feedback loop: `onTimeUpdate` writes the
  // element's own position back into React state, and seeking to a value
  // we are already at would fight normal playback.
  // ── NEVER SEEK WHILE PLAYING ──────────────────────────────────────
  //
  // THE STALL THIS FIXES. During playback the element reports its
  // position, that position becomes the selection, the selection
  // recomputes `sourceSec`, and this effect then seeked the element back
  // to it. Every frame: report, recompute, seek. The picture froze about
  // four seconds in and never recovered.
  //
  // While playing, the ELEMENT owns its own position and nothing here
  // touches it. Seeking is for scrubbing and for selection changes — the
  // two cases where something other than playback decided where to be.
  useEffect(() => {
    const el = videoRef.current
    if (!el || source.kind !== 'timeline' || source.isStill) return
    // Playback owns its own position; a scrub is exactly when we DO
    // want to move it, so only playback is excluded here.
    if (playing && !scrubbing.current) return
    if (Math.abs(el.currentTime - source.sourceSec) > 0.05) {
      el.currentTime = source.sourceSec
    }
  }, [
    playing,
    source.kind === 'timeline' ? source.sourceSec : null,
    source.kind === 'timeline' ? source.itemId : null
  ])

  /**
   * A HANDOVER, THOUGH, ALWAYS SEEKS.
   *
   * A new item means a new file, which starts at 0 while the item's IN
   * point may be anywhere. This runs on the item id alone — not on the
   * position — so it fires once per boundary and cannot participate in
   * the loop above.
   */
  const lastItemId = useRef<string | null>(null)
  useEffect(() => {
    const el = videoRef.current
    if (!el || source.kind !== 'timeline' || source.isStill) return
    // ── ONLY WHEN PLAYBACK CROSSED THE BOUNDARY ──────────────────
    //
    // A new file starts at 0 and has to jump to the item’s IN point
    // — but only when PLAYBACK walked into it. A scrub already knows
    // the exact position it wants, and this effect running afterwards
    // overwrote it with the item start: dragging to 12s landed on the
    // right clip at 0.00 instead of 2.3s into it.
    if (scrubbing.current || !playing) {
      lastItemId.current = source.itemId
      return
    }
    if (lastItemId.current === source.itemId) return
    lastItemId.current = source.itemId
    const item = timeline?.items.find((i) => i.id === source.itemId)
    if (item) el.currentTime = item.startOffsetSec
  }, [source.kind === 'timeline' ? source.itemId : null])

  const seam = (settings.exportDefaults.seamBlend ?? 'subtle') as SeamBlend

  const heading =
    source.kind === 'image'
      ? `IMAGE ${String(source.index + 1).padStart(2, '0')} · ${source.fileName}`
      : source.kind === 'timeline'
        ? 'TIMELINE · FINAL EDIT'
        : source.kind === 'motion-clip'
          ? 'SINGLE IMAGE MOTION'
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

      <div className="preview-frame" ref={frameRef}>
        {src ? (
          <video
            key={src}
            ref={videoRef}
            className="preview-video"
            src={src}
            playsInline
            preload="metadata"
            onLoadedMetadata={(e) => {
              setDuration(e.currentTarget.duration || 0)
              // The intrinsic size drives the contain-fit rectangle the
              // branding overlays are bounded to.
              setMediaSize({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })
            }}
            onTimeUpdate={(e) => {
              setTime(e.currentTarget.currentTime)
              onTimelineTimeUpdate(e.currentTarget)
            }}
            onEnded={() => {
              // In timeline mode the FILE ending is not the FILM ending:
              // it is a handover. Stopping here is what left playback
              // dead at the first boundary.
              if (isTimelineMode) advanceToNextItem()
              else setPlaying(false)
            }}
            onClick={toggle}
          />
        ) : stillSrc ? (
          /* `contain`, in CSS — a property photo stretched to the frame is
             a misrepresentation of the room it shows. */
          <img
            className="preview-still"
            src={stillSrc}
            alt=""
            onLoad={(e) =>
              setMediaSize({
                w: e.currentTarget.naturalWidth,
                h: e.currentTarget.naturalHeight
              })
            }
          />
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
              {/* THE CANONICAL WORD, not this pane's own reading.
                  `view.state === 'failed'` is a real failure; a clip that
                  downloaded and is awaiting a decision is not one, and
                  calling it "failed" here contradicted the Queue, which
                  was reading the catalogue and getting it right. */}
              <span
                className={`preview-endpoints-status${
                  view?.state === 'failed' ? ' is-failed' : ''
                }`}
              >
                {transitionMode && transitionMode.effectiveMode !== 'ai'
                  ? transitionMode.requestedMode === 'auto'
                    ? `AUTO → ${MODE_LABEL[transitionMode.effectiveMode]}`
                    : MODE_LABEL[transitionMode.effectiveMode]
                  : view?.state === 'failed'
                    ? `Transition ${source.index + 1} → ${source.index + 2} failed`
                    : (view?.word ?? statusWordFor(source.status))}
              </span>
              {view?.secondaryWord && (
                <span className="preview-recovery-detail">{view.secondaryWord}</span>
              )}

              {/* ── A CUT IS FINISHED, NOT MISSING ─────────────────────────
                  No Generate, because there is nothing to generate and
                  nothing to pay for. Offering one here would invite
                  someone to buy a transition the project decided against. */}
              {transitionMode && transitionMode.effectiveMode !== 'ai' && (
                <span className="preview-recovery-detail">{transitionMode.reason}</span>
              )}

              {/* ── RECOVERY, WHERE THE FAILURE IS ─────────────────────────
                  Resume, Retry download and Regenerate are three different
                  things costing wildly different amounts, so they get three
                  different words — and the right one is offered here rather
                  than behind an inspector tab. */}
              {aiMode && recovery && recovery.kind !== 'generate' && recovery.kind !== 'preview' && (
                <span className="preview-recovery-detail">{recovery.detail}</span>
              )}
              {aiMode &&
                onRecover &&
                recovery &&
                recovery.kind !== 'preview' &&
                recovery.kind !== 'waiting' && (
                  <button
                    type="button"
                    className={`btn btn-tiny ${recovery.costsMoney ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={onRecover}
                    disabled={generating}
                    title={
                      recovery.costsMoney
                        ? 'Opens the paid-request confirmation before anything is sent'
                        : 'Costs nothing — the provider work is already paid for'
                    }
                  >
                    {generating ? 'Working…' : recovery.label}
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

        {/* ── BRANDING, AS PLAIN POSITIONED IMAGES ──────────────────
            No encode, no FFmpeg, no temporary file: two <img> elements
            over the frame. That is what makes a toggle instant, and it
            is why hiding a layer costs nothing and changes nothing.
            They sit OUTSIDE the source branches above so a clip
            boundary — which swaps the <video> — cannot remount them.
            Positioning and opacity come from the saved config, so what
            is on screen matches what the export will rasterise. */}
        {/* Bounded to the PICTURE, not the pane — see `pictureBox`. Both
            overlays live inside it, so a percentage size and a corner
            offset mean the same thing here as they do in the export. */}
        {/* ── MOUNTED ONCE, HIDDEN BY CSS ────────────────────────────
            THE INTERMITTENT BUG THIS FIXES. These two were mounted
            CONDITIONALLY on the checkboxes, so every toggle destroyed
            the <img> and every re-toggle created a new one — a fresh
            request through the f2f:// protocol handler, a fresh decode,
            and a fresh chance to race. There was no `onError`, so a
            request that did not come back showed nothing and said
            nothing, which is exactly "sometimes it does not come back".

            The asset lifecycle no longer has anything to do with the
            checkbox. The elements exist whenever the project HAS the
            asset; `hidden` decides whether they are drawn. Toggling is
            now a style change on a loaded image, which cannot fail.

            The layer also stays mounted while the picture rectangle is
            still unknown — hidden, but keeping its children loaded —
            rather than unmounting everything until the media reports a
            size. */}
        {isTimelineMode && (brandWatermark?.imageSrc || brandStamp?.logoSrc) && (
          <div
            className="preview-brand-layer"
            hidden={!pictureBox}
            style={
              pictureBox
                ? {
                    left: `${pictureBox.left}px`,
                    top: `${pictureBox.top}px`,
                    width: `${pictureBox.width}px`,
                    height: `${pictureBox.height}px`
                  }
                : undefined
            }
          >
            {brandWatermark?.imageSrc && (
              <img
                className="preview-brand-watermark"
                src={brandWatermark.imageSrc}
                alt=""
                draggable={false}
                data-brand="watermark"
                hidden={!showWatermark || !watermarkRect}
                ref={captureNatural(setWatermarkNatural)}
                onLoad={(e) => {
                  const w = e.currentTarget.naturalWidth
                  const h = e.currentTarget.naturalHeight
                  setWatermarkNatural((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
                }}
                style={
                  watermarkRect
                    ? {
                        left: `${watermarkRect.left}px`,
                        top: `${watermarkRect.top}px`,
                        width: `${watermarkRect.width}px`,
                        height: `${watermarkRect.height}px`,
                        opacity: brandWatermark.opacityPct / 100
                      }
                    : undefined
                }
              />
            )}
            {brandStamp?.logoSrc && (
              <img
                className="preview-brand-stamp"
                src={brandStamp.logoSrc}
                alt=""
                draggable={false}
                data-brand="stamp"
                hidden={!showCornerStamp || !stampRect}
                ref={(el) => {
                  captureNatural(setStampNatural)(el)
                  if (el?.complete && el.naturalWidth > 0) {
                    const box = measureAlphaBounds(el)
                    setStampContent((prev) =>
                      prev && box && prev.x === box.x && prev.y === box.y && prev.w === box.w && prev.h === box.h
                        ? prev
                        : box
                    )
                  }
                }}
                onLoad={(e) => {
                  const w = e.currentTarget.naturalWidth
                  const h = e.currentTarget.naturalHeight
                  setStampNatural((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
                  const box = measureAlphaBounds(e.currentTarget)
                  setStampContent((prev) =>
                    prev && box && prev.x === box.x && prev.y === box.y && prev.w === box.w && prev.h === box.h
                      ? prev
                      : box
                  )
                }}
                style={
                  stampRect
                    ? {
                        left: `${stampRect.left}px`,
                        top: `${stampRect.top}px`,
                        width: `${stampRect.width}px`,
                        height: `${stampRect.height}px`,
                        opacity: brandStamp.opacityPct / 100
                      }
                    : undefined
                }
              />
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
          max={shownTotal || 0}
          step={0.01}
          value={displayTime}
          disabled={!src || shownTotal === 0}
          /* ── THE DRAG OWNS THE PLAYHEAD ──────────────────────────
             Pointer capture so the drag survives the cursor leaving
             the control, and `scrubbing` so nothing else may write the
             time while a finger is down on it. */
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            scrubbing.current = true
            setScrubSec(shownTime)
          }}
          onPointerUp={(e) => {
            try {
              e.currentTarget.releasePointerCapture(e.pointerId)
            } catch {
              /* already released; the committed value below is what matters */
            }
            scrubbing.current = false
            setScrubSec(null)
          }}
          onPointerCancel={() => {
            scrubbing.current = false
            setScrubSec(null)
          }}
          /* `onInput` rather than `onChange`: it fires on every movement
             of the thumb, which is what "follows the mouse" means. */
          onInput={(e) => seekTo(Number((e.target as HTMLInputElement).value))}
          onChange={(e) => seekTo(Number(e.target.value))}
          aria-label="Scrub"
        />

        <span className="preview-time">
          {formatTime(shownTime)} / {formatTime(shownTotal)}
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
