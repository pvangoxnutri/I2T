import { useEffect, useRef, useState } from 'react'
import { feedTransitionState } from '../../../../shared/feedTransitionState'
import {
  MOTION_LABEL,
  motionSegmentsForImage,
  type MotionSegment
} from '../../../../shared/motionSegment'
import type { GenerationRecord } from '../../../../shared/types'
import { useAppState } from '../../state/AppState'
import { transitionKey, type Project, type TransitionStatus } from '../../types'
import { resolveGenerationAction } from '../../../../shared/generationState'
import { roomOfImage, relateImages, type PropertyAnalysis } from '../../../../shared/propertyAnalysis'
import { dropTargetIndex, scrollIntoViewOffset } from '../../../../shared/sequence'
import { getFeedImages } from '../../../../shared/feedSequence'
import type { EditorSelection } from '../../../../shared/editorSelection'
import { MODE_LABEL, type ResolvedModeRow } from '../../../../shared/transitionMode'
import { analyzeFeedMutation, type FeedMutationReport } from '../../../../shared/feedMutationGuard'
import { FeedMutationWarningDialog } from './FeedMutationWarningDialog'

/**
 * The sequence, as a horizontal timeline.
 *
 *   [IMG 1] ─ [1→2] ─ [IMG 2] ─ [2→3] ─ [IMG 3]
 *
 * ── THE ORDER HERE IS THE VIDEO ──────────────────────────────────────
 *
 * This strip is the authority on playback order, and nothing else writes
 * it. Property Analysis works out how the rooms relate; it never reorders
 * the sequence, because which way to walk a buyer through a home is an
 * editorial decision, not a spatial one.
 *
 * ── AN IMAGE BLOCK IS ONE UNIT ───────────────────────────────────────
 *
 * Thumbnail, number, room, warning. Everything else about a photograph
 * lives in its inspector. Metadata rendered into a timeline block is
 * metadata nobody reads and horizontal space nobody gets back.
 *
 * ── STATE IS NEVER COLOUR ALONE ──────────────────────────────────────
 *
 * Every transition block carries a WORD — Ready, Missing, Generating,
 * Failed, Download pending — with the tint as reinforcement only. Colour
 * alone would fail anyone who cannot separate the hues, and this is the
 * screen where "is it done?" has to be unambiguous.
 *
 * ── PERFORMANCE ──────────────────────────────────────────────────────
 *
 * Blocks show a static poster frame, never a live <video>. A dozen
 * autoplaying elements would make the timeline stutter for no benefit —
 * only the selected item plays, and it plays in the main preview.
 */
const STATUS_WORD: Record<TransitionStatus, string> = {
  'not-generated': 'Missing',
  queued: 'Queued',
  generating: 'Generating',
  completed: 'Ready',
  failed: 'Failed'
}

export function TimelineStrip({
  project,
  analysis,
  selection,
  modes,
  generations,
  scrollToSelectionNonce,
  selectedMotionId,
  onSelectImage,
  onSelectTransition,
  onSelectMotion
}: {
  project: Project
  analysis: PropertyAnalysis | null
  selection: EditorSelection
  /** How each transition will behave. Resolved once in main. */
  modes: ResolvedModeRow[]
  /**
   * Every generation in the project.
   *
   * The feed cannot describe a transition from its stored row alone: a
   * clip held back by quality is on disk and playable while the row
   * carries no clip at all. Without this the timeline called that FAILED.
   */
  generations: GenerationRecord[]
  /**
   * Changes ONLY when keyboard navigation moved the selection.
   *
   * The scroll-into-view effect keys off this rather than off the
   * selection itself, so a mouse click — which can only ever land on
   * something already visible — never moves the track.
   */
  scrollToSelectionNonce: number
  /** The selected single-image motion segment, when one is selected. */
  selectedMotionId?: string | null
  onSelectImage: (imageId: string) => void
  onSelectTransition: (pairKey: string) => void
  onSelectMotion?: (segmentId: string) => void
}): React.JSX.Element {
  const { moveFeedImage, queue } = useAppState()
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropSlot, setDropSlot] = useState<number | null>(null)
  const [dragWarning, setDragWarning] = useState<{ mutation: () => void; report: FeedMutationReport } | null>(null)
  const dragRef = useRef<number | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const cellRefs = useRef(new Map<string, HTMLDivElement>())

  const feedImages = getFeedImages(project)

  const selectedImageId = selection.kind === 'image' ? selection.imageId : null
  const selectedPairKey = selection.kind === 'transition' ? selection.pairKey : null

  /**
   * AUTO-SCROLL TO THE SELECTION.
   *
   * Arrow-key review is the point of the shortcuts, and a selection that
   * walks off the edge of a scrolling track defeats it. Deliberately only
   * scrolls when the target is genuinely out of view — nudging the track
   * on every keypress makes a sequence impossible to read.
   */
  useEffect(() => {
    // ── ONLY KEYBOARD NAVIGATION MAY MOVE THE TRACK ──────────────────
    //
    // This used to depend on the SELECTION, so every mouse click ran it.
    // Clicking a transition after scrolling right therefore dragged the
    // strip back leftwards — the operator had just scrolled to something,
    // and selecting it moved it out from under the pointer.
    //
    // A click cannot reach anything off-screen: they clicked what they
    // could see, so there is nothing to bring into view and the correct
    // scroll adjustment is none. Arrow-key review genuinely can step onto
    // an off-screen item, and that is the only case this serves.
    //
    // Nonce-driven, not selection-driven: the value changes only in the
    // keyboard handler, so no other cause of a selection change — a
    // click, a reorder, a reconcile after a feed edit — can reach it.
    if (scrollToSelectionNonce === 0) return
    const id = selectedImageId ?? selectedPairKey
    if (!id) return
    const track = trackRef.current
    const cell = cellRefs.current.get(id)
    if (!track || !cell) return
    // Minimal movement, and never to the left edge: `scrollIntoViewOffset`
    // returns null when the item is already visible and otherwise the
    // smallest offset that reveals it.
    const offset = scrollIntoViewOffset(
      { left: cell.offsetLeft, width: cell.offsetWidth },
      { scrollLeft: track.scrollLeft, width: track.clientWidth }
    )
    if (offset !== null) track.scrollTo({ left: offset, behavior: 'smooth' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToSelectionNonce])

  const roomLabel = (imageId: string): string | null =>
    analysis ? (roomOfImage(analysis, imageId)?.label ?? null) : null

  /** A remote generation that succeeded but whose file never arrived. */
  const downloadPending = (pairKey: string): boolean =>
    queue.some(
      (j) =>
        j.projectId === project.id &&
        (j.metadata?.pairKeys ?? []).includes(pairKey) &&
        resolveGenerationAction(j.provider) === 'download'
    )

  /**
   * The newest generation for a pair, whatever became of it.
   *
   * Newest rather than active on purpose: the active one is already on
   * the transition, and what the feed is missing is the attempt that
   * produced a file nobody adopted.
   */
  const latestFor = (pairKey: string): GenerationRecord | null => {
    const [from, to] = pairKey.split('->')
    return (
      generations
        .filter((g) => g.fromImageId === from && g.toImageId === to)
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
    )
  }

  /** The motion clips anchored to one photograph, in the order added. */
  const motionsFor = (imageId: string): MotionSegment[] =>
    motionSegmentsForImage(project, imageId)

  const endDrag = (): void => {
    dragRef.current = null
    setDragIndex(null)
    setDropSlot(null)
  }

  const commitDrop = (slot: number): void => {
    const from = dragRef.current
    if (from === null) return
    const target = dropTargetIndex(from, slot)
    if (target === from) {
      endDrag()
      return
    }

    // Simulate the reorder to check if it breaks generated clips
    const feedIds = getFeedImages(project).map((i) => i.id)
    const newFeedIds = [...feedIds]
    const [moved] = newFeedIds.splice(from, 1)
    newFeedIds.splice(target, 0, moved)

    const report = analyzeFeedMutation(project, newFeedIds)
    if (report.requiresConfirmation) {
      setDragWarning({
        mutation: () => moveFeedImage(project.id, from, target),
        report
      })
    } else {
      moveFeedImage(project.id, from, target)
    }
    endDrag()
  }

  /** Which gap the pointer is nearest, given the block it is over. */
  const slotFor = (event: React.DragEvent, index: number): number => {
    const box = event.currentTarget.getBoundingClientRect()
    return event.clientX - box.left < box.width / 2 ? index : index + 1
  }

  return (
    <section className="timeline" aria-label="Sequence timeline">
      <div className="timeline-head">
        <span className="timeline-title">Timeline</span>
        <span className="timeline-hint">
          {feedImages.length} images · {Math.max(0, feedImages.length - 1)} transitions ·
          drag to reorder · ← → to review · Shift + ← → to move
        </span>
      </div>

      <div className="timeline-track" ref={trackRef}>
        {feedImages.length === 0 && (
          <p className="timeline-empty">Add photos to the Transition Feed to build the sequence.</p>
        )}

        {feedImages.map((image, index) => {
          const next = feedImages[index + 1]
          const key = next ? transitionKey(image.id, next.id) : null
          const transition = key ? project.transitions[key] : undefined
          const room = roomLabel(image.id)
          const pending = key ? downloadPending(key) : false
          // ONE derivation, from three facts. `transition.status` alone
          // cannot tell a fal rejection from a clip the inspection held
          // back — and it reported both as FAILED.
          const latestGeneration = key ? latestFor(key) : null
          const view = feedTransitionState(transition, latestGeneration, pending)
          const word = view.word
          const stateClass = view.tone

          // The one status worth a badge on the photo itself: nothing knows
          // where it is, so every transition touching it stays generic.
          const needsRoom = analysis !== null && analysis.rooms.length > 0 && room === null
          // And the one worth a badge on the transition: no understood
          // spatial relationship, so no navigation will be planned.
          const relationUnknown =
            next && analysis
              ? relateImages(analysis, image.id, next.id).kind === 'unknown'
              : false

          const modeRow = key ? modes.find((m) => m.pairKey === key) : undefined
          const modeClass = modeRow?.effectiveMode ?? 'ai'

          return (
            <div
              className={`timeline-cell${dragIndex === index ? ' is-dragging' : ''}`}
              key={image.id}
              ref={(el) => {
                if (el) cellRefs.current.set(image.id, el)
                else cellRefs.current.delete(image.id)
              }}
            >
              {dropSlot === index && dragIndex !== null && (
                <span className="timeline-drop" aria-hidden />
              )}

              <button
                type="button"
                className={`timeline-image${selectedImageId === image.id ? ' is-selected' : ''}`}
                aria-pressed={selectedImageId === image.id}
                draggable
                onDragStart={(e) => {
                  dragRef.current = index
                  setDragIndex(index)
                  e.dataTransfer.effectAllowed = 'move'
                  // Some platforms cancel a drag with no payload.
                  e.dataTransfer.setData('text/plain', image.id)
                }}
                onDragOver={(e) => {
                  if (dragRef.current === null) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  setDropSlot(slotFor(e, index))
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  commitDrop(slotFor(e, index))
                }}
                onDragEnd={endDrag}
                onClick={() => onSelectImage(image.id)}
                title={image.fileName}
              >
                <img src={image.src} alt="" />
                <span className="timeline-image-no">{index + 1}</span>
                {needsRoom && (
                  <span className="timeline-image-warn" title="No room assigned">
                    ⚠
                  </span>
                )}
                <span className="timeline-image-meta">
                  <span className="timeline-image-name">IMAGE {String(index + 1).padStart(2, '0')}</span>
                  <span className="timeline-image-room">{room ?? (analysis && analysis.rooms.length > 0 ? 'Room uncertain' : 'Not analysed')}</span>
                </span>
              </button>

              {/* ── SINGLE-IMAGE MOTION, WHERE IT PLAYS ──────────────────
                  After this photograph is shown and before the transition
                  that leaves it.

                  Labelled in WORDS, with its own shape and tint, because
                  the one thing that must never happen is an operator
                  reading a moving still as a journey between two rooms.
                  An icon alone would not carry that. */}
              {motionsFor(image.id).map((segment) => (
                <button
                  key={segment.id}
                  type="button"
                  className={`timeline-motion${
                    selectedMotionId === segment.id ? ' is-selected' : ''
                  }`}
                  onClick={() => onSelectMotion?.(segment.id)}
                  aria-pressed={selectedMotionId === segment.id}
                  title={`One photograph in motion — ${MOTION_LABEL[segment.motion]}`}
                >
                  <span className="timeline-motion-kind">SINGLE IMAGE</span>
                  <span className="timeline-motion-type">
                    {MOTION_LABEL[segment.motion].toUpperCase()}
                  </span>
                  <span className="timeline-motion-state">
                    <span
                      className={`state-dot state-dot-${
                        segment.clip
                          ? 'ready'
                          : segment.status === 'failed'
                            ? 'failed'
                            : 'missing'
                      }`}
                      aria-hidden
                    />
                    {segment.clip
                      ? 'Ready'
                      : segment.status === 'failed'
                        ? 'Failed'
                        : 'Missing'}
                  </span>
                </button>
              ))}

              {key && next && (
                <button
                  type="button"
                  className={`timeline-transition is-${stateClass} mode-${modeClass}${
                    selectedPairKey === key ? ' is-selected' : ''
                  }`}
                  ref={(el) => {
                    if (el) cellRefs.current.set(key, el as unknown as HTMLDivElement)
                    else cellRefs.current.delete(key)
                  }}
                  onClick={() => onSelectTransition(key)}
                  aria-pressed={selectedPairKey === key}
                  title={`Image ${index + 1} → Image ${index + 2} — ${word}`}
                >
                  <span className="timeline-transition-pair">
                    {index + 1}→{index + 2}
                    {relationUnknown && (
                      <span className="timeline-transition-warn" title="Spatial connection unknown">
                        ⚠
                      </span>
                    )}
                  </span>
                  {/* Poster frame, not a video element. */}
                  {transition?.clip ? (
                    <span className="timeline-transition-strip" aria-hidden>
                      <img src={next.src} alt="" />
                    </span>
                  ) : (
                    <span className="timeline-transition-strip is-blank" aria-hidden />
                  )}
                  {/* ── TYPE, IN WORDS ─────────────────────────────────────
                      A cut and an ungenerated AI transition look identical
                      if only the state is shown, and one of them is
                      finished while the other is waiting to be paid for.
                      The word carries it; the tint only reinforces. */}
                  <span className={`timeline-transition-state is-${modeClass}`}>
                    {modeClass === 'ai' ? (
                      <>
                        <span className={`state-dot state-dot-${stateClass}`} aria-hidden />
                        AI · {word}
                        {/* RULE F. The transition works — an older clip is
                            still in use — and the newest attempt does not.
                            Hiding the second fact would leave a paid
                            regeneration silently waiting; letting it
                            overwrite the first would make a usable
                            transition look broken. Both, ranked. */}
                        {view.secondaryWord && (
                          <span className="timeline-transition-secondary">
                            {view.secondaryWord}
                          </span>
                        )}
                      </>
                    ) : (
                      <>
                        <span className="timeline-mode-glyph" aria-hidden>
                          {modeClass === 'cut' ? '▮▮' : '◑'}
                        </span>
                        {modeRow?.requestedMode === 'auto' ? 'AUTO → ' : ''}
                        {MODE_LABEL[modeClass]}
                      </>
                    )}
                  </span>
                </button>
              )}
            </div>
          )
        })}

        {/* Drop target past the last image. */}
        {dragIndex !== null && (
          <div
            className="timeline-tail-drop"
            onDragOver={(e) => {
              e.preventDefault()
              setDropSlot(feedImages.length)
            }}
            onDrop={(e) => {
              e.preventDefault()
              commitDrop(feedImages.length)
            }}
          >
            {dropSlot === feedImages.length && <span className="timeline-drop" aria-hidden />}
          </div>
        )}
      </div>

      {dragWarning && (
        <FeedMutationWarningDialog
          project={project}
          report={dragWarning.report}
          onCancel={() => setDragWarning(null)}
          onContinue={() => {
            dragWarning.mutation()
            setDragWarning(null)
          }}
        />
      )}
    </section>
  )
}
