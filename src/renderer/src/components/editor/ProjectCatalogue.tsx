import { useCallback, useEffect, useState } from 'react'
import type { Project, GenerationRecord } from '../../types'

/**
 * Project Catalogue — historical record of all generated transitions.
 *
 * Shows every generation for the project, newest first, including inactive
 * ones that have been superseded. Preserved across feed reorders.
 */
export function ProjectCatalogue({
  projectId,
  open,
  onClose
}: {
  projectId: string
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const [generations, setGenerations] = useState<GenerationRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [attaching, setAttaching] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    const data = await window.f2f.projects.catalogue.getAll(projectId)
    setGenerations(data)
    setLoading(false)
  }, [projectId])

  useEffect(() => {
    if (!open) return
    void load()
  }, [open, load])

  if (!open) return <></>

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
              {generations.map((gen) => (
                <li key={gen.id} className="catalogue-item">
                  {gen.clip && (
                    <div className="catalogue-item-preview">
                      <video src={gen.clip.src} />
                    </div>
                  )}
                  <div className="catalogue-item-info">
                    <div className="catalogue-pair">
                      {gen.fromImageId} → {gen.toImageId}
                    </div>
                    <div className="catalogue-provider">{gen.provider}</div>
                    <div className="catalogue-timestamp">
                      {new Date(gen.createdAt).toLocaleString()}
                    </div>
                    {gen.active && <span className="catalogue-active">● Active</span>}
                  </div>

                  {/* ── REUSE, WITHOUT PAYING AGAIN ──────────────────
                      Attaching is bookkeeping over work already done:
                      no file copy, no provider request, no new spend.
                      The pair comes from the GENERATION, never from
                      whatever is selected, so a clip can only ever
                      become active for the two images it was made
                      from. */}
                  {gen.clip && !gen.active && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-tiny catalogue-attach"
                      disabled={attaching === gen.id}
                      onClick={() => {
                        setAttaching(gen.id)
                        void window.f2f.projects.catalogue
                          .attach(projectId, gen.id)
                          .then((res) => {
                            setAttaching(null)
                            setNote(
                              res.ok
                                ? 'Now the active clip for its transition.'
                                : res.reason
                            )
                            if (res.ok) void load()
                          })
                      }}
                    >
                      {attaching === gen.id ? 'Attaching…' : 'Use for its transition'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
