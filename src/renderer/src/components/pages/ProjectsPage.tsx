import { useState } from 'react'
import { useAppState } from '../../state/AppState'
import type { Project, ProjectStatus, QueueJob } from '../../types'
import { formatPrice, priceSnapshot } from '../../../../shared/pricing'
import { deriveProjectStatus, PROJECT_STATUS_LABEL } from '../../../../shared/projectStatus'

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  })
}

function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  })
}

type Filter = 'all' | 'draft' | 'ready' | 'active' | 'review' | 'completed'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Draft' },
  { key: 'ready', label: 'Ready' },
  { key: 'active', label: 'Queued / Generating' },
  { key: 'review', label: 'Review' },
  { key: 'completed', label: 'Completed' }
]

function matchesFilter(status: ProjectStatus, filter: Filter): boolean {
  if (filter === 'all') return true
  if (filter === 'active') return status === 'queued' || status === 'generating'
  return status === filter
}

function ProjectCard({
  project,
  status,
  priceLabel,
  scheduledFor,
  onOpen,
  onDelete
}: {
  project: Project
  status: ProjectStatus
  priceLabel: string
  scheduledFor: number | null
  onOpen: () => void
  onDelete: () => void
}): React.JSX.Element {
  const cover = project.images[0]?.src ?? null

  return (
    <article className="project-card" onClick={onOpen}>
      <div className="project-card-cover">
        {cover ? (
          <img src={cover} alt="" draggable={false} />
        ) : (
          <div className="project-card-cover-empty">
            <span className="cover-empty-glyph">▣</span>
            <span>No photos yet</span>
          </div>
        )}
        <span className="project-card-count">
          {project.images.length} {project.images.length === 1 ? 'photo' : 'photos'}
        </span>
        <span className={`status-chip project-status-${status} project-card-status`}>
          {PROJECT_STATUS_LABEL[status]}
        </span>
      </div>
      <div className="project-card-body">
        <h3 className="project-card-name">{project.name}</h3>
        <p className="project-card-meta">
          <span className="project-card-price">{priceLabel}</span> · updated{' '}
          {formatDate(project.updatedAt)}
        </p>
        {scheduledFor !== null && (
          <p className="project-card-scheduled">◷ Scheduled {formatWhen(scheduledFor)}</p>
        )}
      </div>
      <button
        type="button"
        className="project-card-delete"
        title="Delete project"
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
      >
        ✕
      </button>
    </article>
  )
}

export function ProjectsPage({
  onOpenProject
}: {
  onOpenProject: (projectId: string) => void
}): React.JSX.Element {
  const { projects, queue, settings, createProject, deleteProject } = useAppState()
  const [filter, setFilter] = useState<Filter>('all')
  const [deleteConfirm, setDeleteConfirm] = useState<{ projectId: string; projectName: string } | null>(null)

  const handleNew = (): void => {
    void createProject().then((project) => onOpenProject(project.id))
  }

  const handleConfirmDelete = (): void => {
    if (deleteConfirm) {
      deleteProject(deleteConfirm.projectId)
      setDeleteConfirm(null)
    }
  }

  /** Soonest upcoming scheduled job for a project, if any. */
  const nextSchedule = (projectId: string, jobs: QueueJob[]): number | null => {
    const times = jobs
      .filter((j) => j.projectId === projectId && j.status === 'scheduled' && j.scheduledFor)
      .map((j) => j.scheduledFor!)
    return times.length > 0 ? Math.min(...times) : null
  }

  const decorated = projects.map((project) => ({
    project,
    status: deriveProjectStatus(project, queue),
    scheduledFor: nextSchedule(project.id, queue)
  }))
  const visible = decorated.filter((d) => matchesFilter(d.status, filter))

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">Projects</h1>
          <p className="page-subtitle">Each project becomes one finished property video.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={handleNew}>
          + New Project
        </button>
      </header>

      {projects.length > 0 && (
        <div className="filter-row">
          {FILTERS.map((f) => {
            const count = decorated.filter((d) => matchesFilter(d.status, f.key)).length
            return (
              <button
                key={f.key}
                type="button"
                className={`filter-pill${filter === f.key ? ' is-active' : ''}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label} <span className="filter-count">{count}</span>
              </button>
            )
          })}
        </div>
      )}

      {projects.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-mark" aria-hidden>
            <span>1</span>
            <span className="empty-state-arrow">→</span>
            <span>2</span>
            <span className="empty-state-arrow">→</span>
            <span>3</span>
          </div>
          <h2>Start your first property video</h2>
          <p>
            Import the listing photos, put them in walk-through order, and I2T will turn
            every photo pair into a cinematic AI transition — then cut them into one finished film.
          </p>
          <button type="button" className="btn btn-primary" onClick={handleNew}>
            + New Project
          </button>
        </div>
      ) : visible.length === 0 ? (
        <p className="queue-empty">No projects with this status.</p>
      ) : (
        <div className="project-grid">
          {visible.map(({ project, status, scheduledFor }) => {
            const price = priceSnapshot(project.images.length, settings.pricing)
            return (
              <ProjectCard
                key={project.id}
                project={project}
                status={status}
                priceLabel={formatPrice(price.totalPrice, price.currency)}
                scheduledFor={scheduledFor}
                onOpen={() => onOpenProject(project.id)}
                onDelete={() => setDeleteConfirm({ projectId: project.id, projectName: project.name })}
              />
            )
          })}
        </div>
      )}

      {deleteConfirm && (
        <div className="dialog-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="dialog-box" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-header">
              <h2>Delete project?</h2>
            </div>

            <div className="dialog-body">
              <p>
                Are you sure you want to delete <strong>{deleteConfirm.projectName}</strong>? This action cannot be undone.
              </p>
              <p className="dialog-note">
                All imported images, generated transitions, and project data will be permanently removed.
              </p>
            </div>

            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteConfirm(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-destructive" onClick={handleConfirmDelete}>
                Delete project
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
