import { useRef, useState } from 'react'
import { useAppState } from '../../state/AppState'
import {
  defaultTransitionSettings,
  transitionKey,
  type Project,
  type TransitionStatus
} from '../../types'

const STATUS_LABEL: Record<TransitionStatus, string> = {
  'not-generated': 'Not generated',
  queued: 'Queued',
  processing: 'Processing',
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
  const { moveImage, removeImage, updateTransition, settings } = useAppState()
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
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

  return (
    <div className="sequence" onDrop={drop} onDragOver={(e) => e.preventDefault()}>
      {project.images.map((image, index) => {
        const next = project.images[index + 1]
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
                    <span className="transition-card-title">
                      Transition · Image {index + 1} <span className="transition-arrow">→</span>{' '}
                      Image {index + 2}
                    </span>
                    <span className={`status-chip status-chip-${transition.status}`}>
                      {STATUS_LABEL[transition.status]}
                    </span>
                  </header>
                  <textarea
                    className="input transition-prompt"
                    rows={2}
                    placeholder="Describe this camera move… e.g. “glide forward through the doorway into the living room”"
                    value={transition.prompt}
                    onChange={(e) =>
                      updateTransition(project.id, image.id, next.id, { prompt: e.target.value })
                    }
                  />
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
                        {[2, 3, 4, 5, 6].map((s) => (
                          <option key={s} value={s}>
                            {s} s
                          </option>
                        ))}
                      </select>
                    </label>
                    <span className="transition-note">AI generation arrives in a later step</span>
                  </div>
                </article>
                <div className="transition-line" aria-hidden />
              </div>
            )}
          </div>
        )
      })}

      {dropIndex === project.images.length && dragIndex !== null && (
        <div className="drop-indicator" />
      )}
    </div>
  )
}
