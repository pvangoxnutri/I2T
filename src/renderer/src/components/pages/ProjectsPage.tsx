import { useAppState } from '../../state/AppState'
import type { Project } from '../../types'

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  })
}

function ProjectCard({
  project,
  onOpen,
  onDelete
}: {
  project: Project
  onOpen: () => void
  onDelete: () => void
}): React.JSX.Element {
  const cover = project.images[0]?.src ?? null
  const transitionCount = Math.max(0, project.images.length - 1)

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
      </div>
      <div className="project-card-body">
        <h3 className="project-card-name">{project.name}</h3>
        <p className="project-card-meta">
          {transitionCount} {transitionCount === 1 ? 'transition' : 'transitions'} · updated{' '}
          {formatDate(project.updatedAt)}
        </p>
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
  const { projects, createProject, deleteProject } = useAppState()

  const handleNew = (): void => {
    const project = createProject()
    onOpenProject(project.id)
  }

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
            Import the listing photos, put them in walk-through order, and FrameToFrame will turn
            every photo pair into a cinematic AI transition — then cut them into one finished film.
          </p>
          <button type="button" className="btn btn-primary" onClick={handleNew}>
            + New Project
          </button>
        </div>
      ) : (
        <div className="project-grid">
          {projects.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              onOpen={() => onOpenProject(p.id)}
              onDelete={() => deleteProject(p.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
