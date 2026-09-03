import { useEffect, useRef, useState } from 'react'
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
  onSelectImage,
  onSelectTransition
}: {
  project: Project
  analysis: PropertyAnalysis | null
  selection: EditorSelection
  /** How each transition will behave. Resolved once in main. */
  modes: ResolvedModeRow[]
  onSelectImage: (imageId: string) => void
  onSelectTransition: (pairKey: string) => void
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
    const id = selectedImageId ?? selectedPairKey
    if (!id) return
    const track = trackRef.current
    const cell = cellRefs.current.get(id)
    if (!track || !cell) return
    const offset = scrollIntoViewOffset(
      { left: cell.offsetLeft, width: cell.offsetWidth },
      { scrollLeft: track.scrollLeft, width: track.clientWidth }
    )
    if (offset !== null) track.scrollTo({ left: offset, behavior: 'smooth' })
  }, [selectedImageId, selectedPairKey])

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
          const status: TransitionStatus = transition?.status ?? 'not-generated'
          const word = pending ? 'Download pending' : STATUS_WORD[status]
          const stateClass = pending
            ? 'pending'
            : transition?.clip
              ? 'ready'
              : status === 'failed'
                ? 'failed'
                : status === 'generating' || status === 'queued'
                  ? 'busy'
                  : 'missing'

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
