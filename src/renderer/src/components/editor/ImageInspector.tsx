import { useCallback, useEffect, useState } from 'react'
import type { Project } from '../../types'
import type { CameraOrientation, PropertyAnalysis } from '../../../../shared/propertyAnalysis'
import type { ImageFacts, OverrideField } from '../../../../shared/imageFacts'
import { imageRoomFactKey, type ReviewVerdict } from '../../../../shared/analysisReview'
import { getFeedImages } from '../../../../shared/feedSequence'

type Tab = 'basics' | 'spatial' | 'analysis' | 'advanced'

/**
 * Everything about ONE photograph.
 *
 * ── WHY AN IMAGE NEEDS ITS OWN INSPECTOR ─────────────────────────────
 *
 * Image facts used to live inside the Property Analysis panel: one form
 * holding rooms, connections, landmarks and orientations for the whole
 * project, with a "Selected image" section buried at the bottom. To change
 * one photograph's room you had to find it inside a project-level form —
 * so the answer to "where do I edit this image?" was "somewhere else".
 *
 * A photograph is an editable unit. It gets an inspector, in the same
 * place a transition's inspector appears, with the same shape.
 *
 * ── NOTHING HERE IS MANDATORY ────────────────────────────────────────
 *
 * Every field is either analysis-derived or optional. There is no required
 * input on this panel and nothing here gates generation — which is why the
 * default tabs SHOW values rather than offering empty inputs. Editable
 * controls appear under Advanced, where someone has gone looking for them.
 */
export function ImageInspector({
  project,
  analysis,
  imageId,
  onOverridesChanged
}: {
  project: Project
  analysis: PropertyAnalysis | null
  imageId: string
  onOverridesChanged: () => void
}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('basics')
  const [facts, setFacts] = useState<ImageFacts | null>(null)
  const [verdict, setVerdict] = useState<ReviewVerdict>('unreviewed')

  const feedImages = getFeedImages(project)
  const feedIndex = feedImages.findIndex((i) => i.id === imageId)
  const image = project.images.find((i) => i.id === imageId) ?? null
  // Position in the video sequence (for display), or null if not in feed
  const sequencePosition = feedIndex >= 0 ? feedIndex + 1 : null
  const sequenceTotal = feedImages.length

  const load = useCallback((): void => {
    if (!imageId) return
    void window.f2f.projects.overrides.facts(project.id, imageId).then(setFacts)
  }, [project.id, imageId])

  useEffect(load, [load, analysis?.updatedAt])

  // The room-assignment verdict for THIS image, so ground-truth review is
  // available where the fact is, rather than only in a project-wide list.
  useEffect(() => {
    if (!analysis) return
    void window.f2f.projects.review.list(project.id, 'accepted').then((entries) => {
      const room = facts?.room.value
      if (!room) {
        setVerdict('unreviewed')
        return
      }
      const key = imageRoomFactKey(imageId, room)
      setVerdict(entries.find((e) => e.factKey === key)?.verdict ?? 'unreviewed')
    })
  }, [project.id, imageId, analysis, facts?.room.value])

  if (!image || !facts) {
    return (
      <section className="inspector inspector-empty">
        <p>Select an image in the timeline.</p>
      </section>
    )
  }

  const setOverride = (field: OverrideField, value: string | string[] | null): void => {
    void window.f2f.projects.overrides.set(project.id, imageId, field, value).then(() => {
      load()
      onOverridesChanged()
    })
  }

  const clearOverride = (field: OverrideField): void => {
    void window.f2f.projects.overrides.clear(project.id, imageId, field).then(() => {
      load()
      onOverridesChanged()
    })
  }

  const setVerdictFor = (next: ReviewVerdict): void => {
    const room = facts.room.value
    if (!room) return
    const key = imageRoomFactKey(imageId, room)
    const value = verdict === next ? 'unreviewed' : next
    const label = sequencePosition !== null ? `Image ${sequencePosition} → ${room}` : `Image (not in sequence) → ${room}`
    void window.f2f.projects.review
      .set(project.id, 'accepted', key, 'image-room', label, value)
      .then(() => setVerdict(value))
  }

  const rooms = analysis?.rooms.map((r) => r.label) ?? []

  return (
    <section className="inspector">
      <header className="inspector-head">
        <span className="inspector-pair">
          {sequencePosition !== null ? (
            <>
              IMAGE {String(sequencePosition).padStart(2, '0')}
              {sequenceTotal > 0 && <span className="inspector-pair-total">/ {sequenceTotal}</span>}
            </>
          ) : (
            <>IMAGE (library)</>
          )}
          {facts.overridden && (
            <span className="override-badge" title="This image has manual corrections">
              Manual override
            </span>
          )}
        </span>
        <nav className="inspector-tabs" role="tablist">
          {(
            [
              ['basics', 'Basics'],
              ['spatial', 'Spatial'],
              ['analysis', 'Analysis'],
              ['advanced', 'Advanced']
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={`inspector-tab${tab === key ? ' is-active' : ''}${
                key === 'advanced' ? ' is-advanced' : ''
              }`}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <div className="inspector-body">
        {/* ── BASICS ─────────────────────────────────────────────────── */}
        {tab === 'basics' && (
          <div className="inspector-grid">
            <Sourced label="File" value={image.fileName} />
            {sequencePosition !== null ? (
              <Sourced
                label="Position in sequence"
                value={`${sequencePosition} of ${sequenceTotal}`}
                note="Drag in the timeline, or Shift + ← →"
              />
            ) : (
              <Sourced
                label="Position in sequence"
                value="Not in Transition Feed"
                note="Drag from Imported Images to add to sequence"
              />
            )}
            <Sourced
              label="Room / Space"
              value={facts.room.value ?? 'Not assigned'}
              source={facts.room.source}
              onUseAnalyzed={
                facts.room.source === 'manual' ? () => clearOverride('roomLabel') : undefined
              }
            />
          </div>
        )}

        {/* ── SPATIAL ────────────────────────────────────────────────── */}
        {tab === 'spatial' && (
          <div className="inspector-grid">
            {!facts.analyzed && (
              <p className="inspector-hint inspector-span">
                Not analyzed. Run Property Analysis for spatial context — transitions still generate
                without it, using the base cinematic prompt.
              </p>
            )}
            <Sourced
              label="Camera orientation"
              value={facts.orientation.value}
              source={facts.orientation.source}
              onUseAnalyzed={
                facts.orientation.source === 'manual'
                  ? () => clearOverride('orientation')
                  : undefined
              }
            />
            <Sourced
              label="Visible openings"
              value={facts.openings.value.length > 0 ? facts.openings.value.join(', ') : 'None'}
              source={facts.openings.source}
              note="The only thing that licenses moving the camera through a doorway."
              onUseAnalyzed={
                facts.openings.source === 'manual' ? () => clearOverride('openings') : undefined
              }
            />
            <Sourced
              label="Landmarks"
              value={facts.landmarks.value.length > 0 ? facts.landmarks.value.join(', ') : 'None'}
              source={facts.landmarks.source}
              onUseAnalyzed={
                facts.landmarks.source === 'manual' ? () => clearOverride('landmarks') : undefined
              }
            />
            <Sourced
              label="Overlaps with"
              value={
                facts.overlapWith
                  .map((id) => project.images.findIndex((i) => i.id === id))
                  // An id the project no longer holds is simply dropped —
                  // it names a photograph that was removed.
                  .filter((i) => i >= 0)
                  .map((i) => `Image ${i + 1}`)
                  .join(', ') || 'None recorded'
              }
              source={facts.analyzed ? 'analysis' : 'none'}
            />
          </div>
        )}

        {/* ── ANALYSIS ───────────────────────────────────────────────── */}
        {tab === 'analysis' && (
          <div className="inspector-grid">
            {!facts.analyzed ? (
              <p className="inspector-hint inspector-span">
                No accepted analysis covers this image yet.
              </p>
            ) : (
              <>
                <Sourced
                  label="AI interpretation"
                  value={
                    facts.room.source === 'manual'
                      ? 'Overridden manually — the analyzer’s answer is no longer in use'
                      : `Assigned to ${facts.room.value ?? 'no room'}`
                  }
                />
                <Sourced
                  label="Room confidence"
                  value={facts.roomConfidence ?? 'Not stated'}
                />
                {/* Ground truth lives WHERE THE FACT IS. Optional: nothing
                    requires a verdict before generating anything. */}
                <div className="inspector-field inspector-span">
                  <span className="inspector-field-label">
                    Is this room assignment correct?
                    <span className="req-tag req-optional">optional</span>
                  </span>
                  <span className="review-verdicts">
                    {(
                      [
                        ['correct', '✓ Correct'],
                        ['incorrect', '✗ Incorrect'],
                        ['unsure', '? Unsure']
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        disabled={!facts.room.value}
                        className={`review-vote review-vote-${value} review-vote-wide${
                          verdict === value ? ' is-active' : ''
                        }`}
                        aria-pressed={verdict === value}
                        onClick={() => setVerdictFor(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </span>
                  <span className="inspector-hint">
                    Evaluation only — a verdict never changes the analysis or this image.
                  </span>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── ADVANCED ───────────────────────────────────────────────────
            The editable controls. Deliberately behind a tab: the normal
            flow is to look at what the analyzer found, not to fill a form
            in, and empty inputs on the default view read as work owed. */}
        {tab === 'advanced' && (
          <div className="inspector-grid">
            <p className="inspector-hint inspector-span">
              Manual corrections. These survive re-analysis — accepting a new draft will not
              overwrite them, and each one is marked <em>Manual override</em> wherever it appears.
            </p>

            <label className="inspector-inline">
              <span>Room / Space</span>
              <input
                list={`rooms-${project.id}`}
                value={facts.room.value ?? ''}
                placeholder="Living Room"
                onChange={(e) =>
                  setOverride('roomLabel', e.target.value.trim() === '' ? null : e.target.value)
                }
              />
              <datalist id={`rooms-${project.id}`}>
                {rooms.map((r) => (
                  <option key={r} value={r} />
                ))}
              </datalist>
            </label>

            <label className="inspector-inline">
              <span>Camera orientation</span>
              <select
                value={facts.orientation.value}
                onChange={(e) => setOverride('orientation', e.target.value as CameraOrientation)}
              >
                {(
                  [
                    'unknown',
                    'into-room',
                    'out-of-room',
                    'north',
                    'east',
                    'south',
                    'west'
                  ] as CameraOrientation[]
                ).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </label>

            <TagInput
              label="Visible openings / doorways"
              hint="Only what is VISIBLE here. This is what licenses a move-through instruction."
              value={facts.openings.value}
              onChange={(v) => setOverride('openings', v)}
            />
            <TagInput
              label="Landmarks"
              value={facts.landmarks.value}
              onChange={(v) => setOverride('landmarks', v)}
            />

            {facts.overridden && (
              <div className="inspector-actions inspector-span">
                <button
                  type="button"
                  className="btn btn-ghost btn-tiny"
                  onClick={() =>
                    void window.f2f.projects.overrides
                      .clear(project.id, imageId)
                      .then(() => {
                        load()
                        onOverridesChanged()
                      })
                  }
                >
                  Use analyzed values for everything
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

/**
 * A read-only fact with its provenance.
 *
 * The badge is the whole point: an analyzer's guess and a person's
 * correction look identical as text, and confusing the two is how a manual
 * fix gets silently reverted or an inference gets trusted like a decision.
 */
function Sourced({
  label,
  value,
  source,
  note,
  onUseAnalyzed
}: {
  label: string
  value: string
  source?: 'analysis' | 'manual' | 'none'
  note?: string
  onUseAnalyzed?: () => void
}): React.JSX.Element {
  return (
    <div className="inspector-field">
      <span className="inspector-field-label">
        {label}
        {source === 'manual' && <span className="source-tag is-manual">Manual override</span>}
        {source === 'analysis' && <span className="source-tag">From analysis</span>}
        {source === 'none' && <span className="source-tag is-none">Not analyzed</span>}
      </span>
      <span className="inspector-field-value">{value}</span>
      {note && <span className="inspector-hint">{note}</span>}
      {onUseAnalyzed && (
        <button type="button" className="linklike" onClick={onUseAnalyzed}>
          Use analyzed value
        </button>
      )}
    </div>
  )
}

/** Comma-separated tags — plain text is faster than a chip editor here. */
function TagInput({
  label,
  hint,
  value,
  onChange
}: {
  label: string
  hint?: string
  value: string[]
  onChange: (next: string[]) => void
}): React.JSX.Element {
  return (
    <label className="inspector-inline">
      <span>{label}</span>
      <input
        value={value.join(', ')}
        placeholder="balcony doors, kitchen doorway"
        onChange={(e) =>
          onChange(
            e.target.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          )
        }
      />
      {hint && <span className="inspector-hint">{hint}</span>}
    </label>
  )
}
