import { useCallback, useEffect, useState } from 'react'
import { useAppState } from '../../state/AppState'
import type { Project } from '../../types'
import { formatPrice, priceSnapshot } from '../../../../shared/pricing'
import { deriveProjectStatus, PROJECT_STATUS_LABEL } from '../../../../shared/projectStatus'
import { formatSpend, type ProjectSpendSummary } from '../../../../shared/costLedger'
import { BrandMark } from '../common/Brand'

/**
 * The editor's top bar.
 *
 * ── ONE LINE, FOUR FACTS ─────────────────────────────────────────────
 *
 * Which project, what state it is in, what the customer pays, and what it
 * has cost us. Everything else lives in a panel — a toolbar that grows
 * controls is a toolbar nobody reads.
 *
 * Customer value and production spend sit side by side but are never
 * added: different directions, different currencies. They are labelled
 * and styled differently for exactly that reason.
 */
export function EditorToolbar({
  project,
  onBack,
  onOpenExport
}: {
  project: Project
  onBack: () => void
  onOpenExport: () => void
}): React.JSX.Element {
  const { queue, renameProject, settings } = useAppState()
  const [spend, setSpend] = useState<ProjectSpendSummary | null>(null)

  const loadSpend = useCallback((): void => {
    void window.f2f.projects.cost.summary(project.id).then(setSpend)
  }, [project.id])

  useEffect(() => {
    loadSpend()
    return window.f2f.projects.onUpdated((incoming) => {
      if (incoming.id === project.id) loadSpend()
    })
  }, [project.id, loadSpend])

  const status = deriveProjectStatus(project, queue)
  const price = priceSnapshot(project.images.length, settings.pricing)

  return (
    <header className="editor-toolbar">
      <button type="button" className="toolbar-back" onClick={onBack} title="Back to projects">
        ←
      </button>

      <BrandMark size="sm" />

      <span className="toolbar-divider" aria-hidden />

      <input
        className="toolbar-project-name"
        value={project.name}
        placeholder="Untitled property"
        onChange={(e) => renameProject(project.id, e.target.value)}
        aria-label="Project name"
      />

      <span className={`toolbar-status project-status-${status}`}>
        {PROJECT_STATUS_LABEL[status]}
      </span>

      <span className="toolbar-spacer" />

      {/* Revenue. */}
      <span className="toolbar-metric" title="What the customer pays for this project">
        <span className="toolbar-metric-label">Customer</span>
        <span className="toolbar-metric-value is-customer">
          {formatPrice(price.totalPrice, price.currency)}
        </span>
      </span>

      {/* Our cost, in the provider's currency. Never converted, never
          added to the figure on its left. */}
      <span
        className="toolbar-metric"
        title="What we have paid providers for this project so far"
      >
        <span className="toolbar-metric-label">Spend</span>
        <span className="toolbar-metric-value">
          {spend ? formatSpend(spend.spent, spend.currency) : '—'}
        </span>
      </span>

      <span className="toolbar-divider" aria-hidden />

      <button type="button" className="btn btn-ghost btn-tiny" onClick={onOpenExport}>
        Export…
      </button>
    </header>
  )
}
