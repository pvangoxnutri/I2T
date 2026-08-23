import { getDb, scheduleFlush } from './index'
import {
  emptyAnalysis,
  parseAnalysis,
  serializeAnalysis,
  type PropertyAnalysis
} from '../../shared/propertyAnalysis'

/**
 * Property analysis persistence — one JSON document per project.
 *
 * See migration 6 for why this is a document rather than normalized rooms
 * and edges: the shape is still being learned, and swapping the analyzer
 * (mock today, a vision model later) changes what a room record carries.
 */

export function readAnalysis(projectId: string): PropertyAnalysis {
  const db = getDb()
  const stmt = db.prepare('SELECT json FROM property_analysis WHERE project_id = ?')
  try {
    stmt.bind([projectId])
    if (!stmt.step()) return emptyAnalysis(projectId)
    const row = stmt.getAsObject() as { json: string }
    return parseAnalysis(projectId, row.json)
  } finally {
    stmt.free()
  }
}

export function saveAnalysis(analysis: PropertyAnalysis): PropertyAnalysis {
  const stored: PropertyAnalysis = { ...analysis, updatedAt: Date.now() }
  const db = getDb()
  db.run('INSERT OR REPLACE INTO property_analysis (project_id, json, updated_at) VALUES (?, ?, ?)', [
    stored.projectId,
    serializeAnalysis(stored),
    stored.updatedAt
  ])
  scheduleFlush()
  return stored
}

export function deleteAnalysis(projectId: string): void {
  const db = getDb()
  db.run('DELETE FROM property_analysis WHERE project_id = ?', [projectId])
  scheduleFlush()
}
