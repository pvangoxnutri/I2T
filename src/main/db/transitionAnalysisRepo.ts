import { getDb, scheduleFlush } from './index'
import type { TransitionDraft } from '../../shared/transitionAnalysisExtractor'

/**
 * Transition analysis draft persistence.
 *
 * Stores feed-specific transition analysis drafts.
 * One draft per project. Persists across restarts.
 * Marked as outdated if feed structure changes.
 */

export interface PersistedTransitionDraft extends TransitionDraft {
  projectId: string
  updatedAt: number
  isOutdated: boolean // Becomes true if feed changes since creation
}

export function readTransitionDraft(projectId: string): PersistedTransitionDraft | null {
  const db = getDb()
  const stmt = db.prepare('SELECT json FROM transition_analysis_draft WHERE project_id = ?')
  try {
    stmt.bind([projectId])
    if (!stmt.step()) return null
    const row = stmt.getAsObject() as { json: string }
    return JSON.parse(row.json) as PersistedTransitionDraft
  } catch (err) {
    console.error('[transitionAnalysisRepo] Failed to read draft:', err)
    return null
  } finally {
    stmt.free()
  }
}

export function saveTransitionDraft(projectId: string, draft: TransitionDraft): PersistedTransitionDraft {
  const persisted: PersistedTransitionDraft = {
    ...draft,
    projectId,
    updatedAt: Date.now(),
    isOutdated: false
  }

  const db = getDb()
  db.run(
    'INSERT OR REPLACE INTO transition_analysis_draft (project_id, json, updated_at, is_outdated) VALUES (?, ?, ?, ?)',
    [projectId, JSON.stringify(persisted), persisted.updatedAt, 0]
  )
  scheduleFlush()
  return persisted
}

export function markTransitionDraftOutdated(projectId: string): void {
  const db = getDb()
  db.run('UPDATE transition_analysis_draft SET is_outdated = 1 WHERE project_id = ?', [projectId])
  scheduleFlush()
}

export function deleteTransitionDraft(projectId: string): void {
  const db = getDb()
  db.run('DELETE FROM transition_analysis_draft WHERE project_id = ?', [projectId])
  scheduleFlush()
}

export function acceptTransitionDraft(projectId: string): void {
  const db = getDb()
  const stmt = db.prepare('SELECT json FROM transition_analysis_draft WHERE project_id = ?')
  try {
    stmt.bind([projectId])
    if (!stmt.step()) return

    const row = stmt.getAsObject() as { json: string }
    const draft = JSON.parse(row.json) as PersistedTransitionDraft

    // Update status to accepted
    const accepted: PersistedTransitionDraft = {
      ...draft,
      status: 'accepted',
      updatedAt: Date.now()
    }

    db.run(
      'INSERT OR REPLACE INTO transition_analysis_draft (project_id, json, updated_at, is_outdated) VALUES (?, ?, ?, ?)',
      [projectId, JSON.stringify(accepted), accepted.updatedAt, accepted.isOutdated ? 1 : 0]
    )
    scheduleFlush()
  } finally {
    stmt.free()
  }
}
