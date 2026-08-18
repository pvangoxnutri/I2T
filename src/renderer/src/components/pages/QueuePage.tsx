import { useAppState } from '../../state/AppState'
import type { JobKind, JobStatus, QueueJob } from '../../types'

const STATUS_LABEL: Record<JobStatus, string> = {
  queued: 'Queued',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed'
}

const KIND_LABEL: Record<JobKind, string> = {
  transitions: 'AI transitions',
  assembly: 'Video assembly',
  'preview-export': 'Preview export (watermarked)',
  'final-export': 'Final export'
}

function timeAgo(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  return `${hours} h ago`
}

function JobRow({ job }: { job: QueueJob }): React.JSX.Element {
  return (
    <article className={`queue-row status-${job.status}`}>
      <div className="queue-row-main">
        <div className="queue-row-title">
          <span className="queue-row-project">{job.projectName}</span>
          <span className="queue-row-kind">{KIND_LABEL[job.kind]}</span>
        </div>
        <div className="queue-row-meta">
          {job.transitionCount} transitions · added {timeAgo(job.createdAt)}
          {job.note ? <span className="queue-row-note"> — {job.note}</span> : null}
        </div>
        {job.status === 'processing' && (
          <div className="queue-progress">
            <div className="queue-progress-bar" style={{ width: `${job.progressPct}%` }} />
          </div>
        )}
      </div>
      <span className={`status-chip status-chip-${job.status}`}>
        {job.status === 'processing' ? `${STATUS_LABEL[job.status]} · ${job.progressPct}%` : STATUS_LABEL[job.status]}
      </span>
    </article>
  )
}

export function QueuePage(): React.JSX.Element {
  const { queue } = useAppState()

  const active = queue.filter((j) => j.status === 'queued' || j.status === 'processing')
  const finished = queue.filter((j) => j.status === 'completed' || j.status === 'failed')

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">Queue</h1>
          <p className="page-subtitle">
            Render jobs across all projects. Scheduling and real processing arrive in a later
            milestone — this data is mocked.
          </p>
        </div>
      </header>

      <div className="queue-columns">
        <section>
          <h2 className="queue-group-title">Active</h2>
          {active.length === 0 ? (
            <p className="queue-empty">Nothing queued right now.</p>
          ) : (
            active.map((j) => <JobRow key={j.id} job={j} />)
          )}
        </section>
        <section>
          <h2 className="queue-group-title">History</h2>
          {finished.length === 0 ? (
            <p className="queue-empty">No finished jobs yet.</p>
          ) : (
            finished.map((j) => <JobRow key={j.id} job={j} />)
          )}
        </section>
      </div>
    </div>
  )
}
