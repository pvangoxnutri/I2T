import { BrowserWindow } from 'electron'

import type { Project } from '../shared/types'
import { listProjects } from './db/projectsRepo'

/**
 * Main → renderer project push.
 *
 * ── THE BUG THIS EXISTS FOR ──────────────────────────────────────────
 *
 * A transition could generate successfully, download, validate and be
 * written to the database — and never appear in the Project Editor. The
 * database was right the whole time; the renderer simply never learned.
 *
 * The only main → renderer channel was `queue:changed`, which carries a
 * QUEUE snapshot. AppState's handler updated `queue` and `queuePaused`
 * and nothing else, so the Queue page flipped to Completed while the
 * editor kept rendering the project it had loaded at mount — with
 * `clip: null`.
 *
 * `refreshProjects()` did exist, but every caller was a user-initiated
 * click, and the one on the generation path fires the moment generation
 * STARTS, before any clip can exist. Nothing ran when generation
 * FINISHED. That is why the clip "sometimes" appeared: only if the user
 * happened to click something else afterwards, or reopened the project,
 * or restarted the app.
 *
 * ── WHY IT RE-READS ──────────────────────────────────────────────────
 *
 * This deliberately does NOT broadcast the object the caller just
 * mutated. It re-reads the project from the persistence layer, so what
 * the renderer receives is what actually survived the write. If a save
 * silently failed, the UI shows the truth rather than an optimistic copy
 * of something that was never stored.
 *
 * Headless-safe: under `--f2f-smoke` there are no windows and this is a
 * no-op, so the smoke suite can drive the same code paths.
 */
export const PROJECT_UPDATED_CHANNEL = 'project:updated'

/** Broadcast the CURRENT stored state of one project. */
export function broadcastProjectUpdated(projectId: string): Project | null {
  const fresh = listProjects().find((p) => p.id === projectId) ?? null
  if (!fresh) return null
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(PROJECT_UPDATED_CHANNEL, fresh)
  }
  return fresh
}
