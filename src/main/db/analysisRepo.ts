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
  // UPSERT ON THE ACCEPTED COLUMNS ONLY.
  //
  // This was `INSERT OR REPLACE`, which rewrites the whole row — and
  // would therefore have destroyed the stored draft as a side effect of
  // saving an accepted analysis. The draft records what an expensive run
  // actually returned; losing it to an unrelated write is exactly the
  // kind of silent erasure this table is not allowed to do.
  db.run(
    `INSERT INTO property_analysis (project_id, json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       json = excluded.json,
       updated_at = excluded.updated_at`,
    [stored.projectId, serializeAnalysis(stored), stored.updatedAt]
  )
  scheduleFlush()
  return stored
}

/**
 * THE ANALYZER DRAFT — what the model actually returned.
 *
 * Stored beside the accepted analysis, never over it. A paid run is the
 * only chance to capture this: `feed:analyze` hands the draft to the
 * renderer and nothing else keeps it, so after a restart the evidence
 * behind a feed proposal was simply gone.
 *
 * Forced to `state: 'draft'` and `source: 'provider'` on the way in, so a
 * document read back out of this column can never be mistaken for one
 * somebody accepted.
 */
export function saveAnalysisDraft(analysis: PropertyAnalysis): PropertyAnalysis {
  const stored: PropertyAnalysis = {
    ...analysis,
    state: 'draft',
    source: 'provider',
    updatedAt: Date.now()
  }
  const db = getDb()
  db.run(
    `INSERT INTO property_analysis (project_id, json, updated_at, draft_json, draft_updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       draft_json = excluded.draft_json,
       draft_updated_at = excluded.draft_updated_at`,
    [
      stored.projectId,
      // Only used when no row exists yet: a project with a draft but no
      // accepted analysis has an EMPTY accepted document, not a copy of
      // the draft.
      serializeAnalysis(emptyAnalysis(stored.projectId)),
      0,
      serializeAnalysis(stored),
      stored.updatedAt
    ]
  )
  scheduleFlush()
  return stored
}

/** The last analyzer draft for this project, or null if none was stored. */
export function readAnalysisDraft(projectId: string): PropertyAnalysis | null {
  const db = getDb()
  const stmt = db.prepare('SELECT draft_json FROM property_analysis WHERE project_id = ?')
  try {
    stmt.bind([projectId])
    if (!stmt.step()) return null
    const row = stmt.getAsObject() as { draft_json: string | null }
    if (!row.draft_json) return null
    return parseAnalysis(projectId, row.draft_json)
  } finally {
    stmt.free()
  }
}

export function clearAnalysisDraft(projectId: string): void {
  const db = getDb()
  db.run(
    'UPDATE property_analysis SET draft_json = NULL, draft_updated_at = NULL WHERE project_id = ?',
    [projectId]
  )
  scheduleFlush()
}

export function deleteAnalysis(projectId: string): void {
  const db = getDb()
  db.run('DELETE FROM property_analysis WHERE project_id = ?', [projectId])
  scheduleFlush()
}
