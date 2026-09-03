import type { Project } from '../../types'
import { describeAffectedTransitions, type FeedMutationReport } from '../../../../shared/feedMutationGuard'

/**
 * Warning before a feed mutation breaks generated transitions.
 */
export function FeedMutationWarningDialog({
  project,
  report,
  onCancel,
  onContinue
}: {
  project: Project
  report: FeedMutationReport
  onCancel: () => void
  onContinue: () => void
}): React.JSX.Element {
  const affected = describeAffectedTransitions(report, project)
  const count = report.generatedClipsLosingUse.length
  const plural = count === 1 ? '' : 's'

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog-box" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2>Generated Transition Will Be Removed</h2>
        </div>

        <div className="dialog-body">
          <p>
            This change will remove {count} generated transition{plural} from the active
            sequence.
          </p>

          {affected.length > 0 && (
            <div className="affected-transitions">
              <p className="affected-label">Affected transition{plural}:</p>
              <ul>
                {affected.map((desc, i) => (
                  <li key={i}>{desc}</li>
                ))}
              </ul>
            </div>
          )}

          <p className="dialog-note">
            The generated video clip{plural} will remain in storage for your reference, but
            won't be used in the video since these image{plural} are no longer adjacent in
            the sequence.
          </p>
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={onContinue}>
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}
