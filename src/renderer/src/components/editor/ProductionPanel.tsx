import { useState } from 'react'
import { useAppState } from '../../state/AppState'
import type { Project, ProjectStatus } from '../../types'
import { formatPrice, priceSnapshot } from '../../../../shared/pricing'
import {
  deriveProjectStatus,
  PROJECT_STATUS_LABEL,
  projectReadiness
} from '../../../../shared/projectStatus'
import { estimateAiCost, mockRate } from '../../../../shared/providerCost'
import { SectionCard } from '../common/controls'
import { ScheduleDialog } from './ScheduleDialog'

/**
 * The production section: what this project IS right now (counts, seconds,
 * customer price, readiness) and the actions that make sense for its
 * current status. Status transitions all go through shared/projectStatus —
 * nothing here invents its own state machine.
 */
export function ProductionPanel({ project }: { project: Project }): React.JSX.Element {
  const { settings, queue, setProjectStatus, markWorkflow, refreshProjects } = useAppState()
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const status = deriveProjectStatus(project, queue)
  const readiness = projectReadiness(project, settings.exportDefaults.defaultTransitionDurationSec)
  const price = priceSnapshot(project.images.length, settings.pricing)
  const cost = estimateAiCost(
    readiness.totalSeconds,
    mockRate(settings.production.mockAiCostPerSecond)
  )

  // Derived statuses are queue-owned; the user only sets the manual ones.
  const isBusy = status === 'queued' || status === 'generating'
  const can = (s: ProjectStatus): boolean => !isBusy && project.status !== s

  const queueAllIncomplete = (scheduledFor: number | null): void => {
    const pairs = Object.entries(project.transitions)
      .filter(([, t]) => t.status !== 'completed')
      .map(([key]) => key)
    if (pairs.length === 0) {
      setNote('Every transition is already generation-complete.')
      return
    }
    void window.f2f.generation.queue(project.id, pairs, scheduledFor).then((job) => {
      refreshProjects()
      setNote(
        job
          ? `Queued ${pairs.length} mock generation ${pairs.length === 1 ? 'job' : 'jobs'} — awaiting provider integration.`
          : 'Nothing to queue.'
      )
    })
  }

  return (
    <SectionCard
      title="Production"
      subtitle="Internal workflow — status, readiness and queueing."
      actions={<span className={`status-chip project-status-${status}`}>{PROJECT_STATUS_LABEL[status]}</span>}
    >
      <div className="production-grid">
        <div>
          <span className="production-label">Images</span>
          <span className="production-value">{readiness.imageCount}</span>
        </div>
        <div>
          <span className="production-label">Transitions</span>
          <span className="production-value">{readiness.transitionCount}</span>
        </div>
        <div>
          <span className="production-label">Video seconds</span>
          <span className="production-value">{readiness.totalSeconds}s</span>
        </div>
        <div>
          <span className="production-label">Customer price</span>
          <span className="production-value accent">
            {formatPrice(price.totalPrice, price.currency)}
          </span>
        </div>
        <div>
          <span className="production-label">Missing clips</span>
          <span className={`production-value${readiness.missingClipPairs.length ? ' warn' : ''}`}>
            {readiness.missingClipPairs.length}
          </span>
        </div>
        <div>
          <span className="production-label">Estimated AI cost</span>
          <span className="production-value">
            {cost ? `~${cost.estimatedCost} ${cost.rate.currency} (mock)` : '—'}
          </span>
        </div>
      </div>

      {readiness.missingClipPairs.length > 0 && (
        <p className="production-missing">
          Not ready to assemble — missing: <strong>{readiness.missingClipPairs.join(', ')}</strong>
        </p>
      )}

      <div className="production-actions">
        {can('ready') && project.status === 'draft' && (
          <button type="button" className="btn btn-ghost btn-tiny" onClick={() => setProjectStatus(project.id, 'ready')}>
            Mark Ready
          </button>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-tiny"
          disabled={isBusy}
          onClick={() => queueAllIncomplete(null)}
        >
          Add to Queue
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-tiny"
          disabled={isBusy}
          onClick={() => setScheduleOpen(true)}
        >
          Schedule…
        </button>
        {can('review') && (project.status === 'ready' || project.status === 'draft') && (
          <button type="button" className="btn btn-ghost btn-tiny" onClick={() => setProjectStatus(project.id, 'review')}>
            Review
          </button>
        )}
        {can('completed') && project.status === 'review' && (
          <button type="button" className="btn btn-ghost btn-tiny" onClick={() => setProjectStatus(project.id, 'completed')}>
            Mark Completed
          </button>
        )}
        {project.status === 'completed' && !isBusy && (
          <button type="button" className="btn btn-ghost btn-tiny" onClick={() => setProjectStatus(project.id, 'draft')}>
            Reopen as Draft
          </button>
        )}
      </div>

      {note && <p className="production-note">{note}</p>}

      {/* Internal customer tracking — no payment processing anywhere. */}
      <div className="workflow-row">
        <WorkflowStep
          label="Preview sent"
          at={project.workflow.previewSentAt}
          hint="Preview export may carry the large watermark"
          onToggle={(v) => markWorkflow(project.id, 'previewSentAt', v)}
        />
        <WorkflowStep
          label="Paid"
          at={project.workflow.paidAt}
          hint="Internal flag only"
          onToggle={(v) => markWorkflow(project.id, 'paidAt', v)}
        />
        <WorkflowStep
          label="Final sent"
          at={project.workflow.finalSentAt}
          hint="Final export removes the large watermark; the I2T signature stays per project settings"
          onToggle={(v) => markWorkflow(project.id, 'finalSentAt', v)}
        />
      </div>

      {scheduleOpen && (
        <ScheduleDialog
          onCancel={() => setScheduleOpen(false)}
          onConfirm={(when) => {
            setScheduleOpen(false)
            queueAllIncomplete(when)
          }}
        />
      )}
    </SectionCard>
  )
}

function WorkflowStep({
  label,
  at,
  hint,
  onToggle
}: {
  label: string
  at: number | null
  hint: string
  onToggle: (value: number | null) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`workflow-step${at ? ' is-done' : ''}`}
      title={hint}
      onClick={() => onToggle(at ? null : Date.now())}
    >
      <span className="workflow-check">{at ? '✓' : '○'}</span>
      <span className="workflow-text">
        <span className="workflow-label">{label}</span>
        <span className="workflow-date">
          {at ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : 'Not yet'}
        </span>
      </span>
    </button>
  )
}
