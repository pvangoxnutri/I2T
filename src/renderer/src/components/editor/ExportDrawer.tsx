import { BrandingExportPanel } from './BrandingExportPanel'
import type { Project } from '../../types'

/**
 * Export + branding, in a drawer.
 *
 * ── WHY IT MOVED ─────────────────────────────────────────────────────
 *
 * Watermark and signature controls used to occupy a permanent right-hand
 * column, so a third of the editor was given over to settings that are
 * touched once per project and then left alone. The editing surface —
 * preview, timeline, inspector — now has that space, and this opens on
 * demand.
 *
 * The panel itself is UNCHANGED: same rasterization, same overlay
 * pipeline, same preview/final export actions. Only its location moved.
 */
export function ExportDrawer({
  project,
  open,
  onClose
}: {
  project: Project
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  if (!open) return null
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        className="drawer"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Export and branding"
      >
        <header className="drawer-head">
          <span className="drawer-title">Export &amp; Branding</span>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="drawer-body">
          <BrandingExportPanel project={project} />
        </div>
      </aside>
    </div>
  )
}
