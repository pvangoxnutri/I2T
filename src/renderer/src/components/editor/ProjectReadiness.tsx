import type { Project } from '../../types'
import type { AnalysisSummary } from '../../../../shared/analysisSummary'
import { editorReadiness, type ReadinessStep } from '../../../../shared/editorReadiness'

/**
 * WHERE THE PROJECT STANDS.
 *
 * ── A READOUT, NOT A WIZARD ──────────────────────────────────────────
 *
 * Five lines, one of them marked as the useful next move. Nothing here
 * disables a button anywhere in the app: images generate without analysis,
 * order changes at any point, and review is optional by design. A
 * checklist that gated any of that would slow the normal case down to
 * protect against a problem the planner already handles by refusing to
 * invent navigation it cannot see.
 *
 * So the ✓/⚠/○ marks describe state. They never withhold anything.
 */
const MARK: Record<ReadinessStep['state'], string> = {
  done: '✓',
  attention: '⚠',
  todo: '○'
}

export function ProjectReadiness({
  project,
  summary
}: {
  project: Project
  summary: AnalysisSummary
}): React.JSX.Element {
  const readiness = editorReadiness(project, summary)

  return (
    <div className="readiness">
      <span className="readiness-title">Project readiness</span>
      <ul className="readiness-steps">
        {readiness.steps.map((step) => (
          <li
            key={step.id}
            className={`readiness-step is-${step.state}${
              readiness.next?.id === step.id ? ' is-next' : ''
            }`}
          >
            <span className="readiness-mark" aria-hidden>
              {MARK[step.state]}
            </span>
            <span className="readiness-label">{step.label}</span>
          </li>
        ))}
      </ul>
      {readiness.next?.hint && <p className="readiness-hint">{readiness.next.hint}</p>}
    </div>
  )
}
