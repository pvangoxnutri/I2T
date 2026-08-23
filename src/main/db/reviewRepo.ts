import { getDb, scheduleFlush } from './index'
import type { ReviewEntry, ReviewFactKind, ReviewScope, ReviewVerdict } from '../../shared/analysisReview'

/**
 * Ground-truth review persistence. Local evaluation metadata only —
 * nothing here is ever transmitted.
 */

interface Row {
  project_id: string
  scope: string
  fact_key: string
  kind: string
  label: string
  verdict: string
  updated_at: number
}

const toEntry = (row: Row): ReviewEntry => ({
  projectId: row.project_id,
  scope: row.scope as ReviewScope,
  factKey: row.fact_key,
  kind: row.kind as ReviewFactKind,
  label: row.label,
  verdict: row.verdict as ReviewVerdict,
  updatedAt: row.updated_at
})

export function listReviews(projectId: string, scope: ReviewScope): ReviewEntry[] {
  const stmt = getDb().prepare(
    'SELECT * FROM analysis_reviews WHERE project_id = ? AND scope = ? ORDER BY updated_at ASC'
  )
  const out: ReviewEntry[] = []
  try {
    stmt.bind([projectId, scope])
    while (stmt.step()) out.push(toEntry(stmt.getAsObject() as unknown as Row))
  } finally {
    stmt.free()
  }
  return out
}

/** Verdicts as a lookup, with `unreviewed` implied by absence. */
export function reviewMap(projectId: string, scope: ReviewScope): Map<string, ReviewVerdict> {
  return new Map(listReviews(projectId, scope).map((r) => [r.factKey, r.verdict]))
}

export function setReview(entry: Omit<ReviewEntry, 'updatedAt'>): void {
  const db = getDb()
  // 'unreviewed' is stored as ABSENCE, so clearing a verdict really
  // clears it rather than leaving a row that means "no opinion" and has
  // to be filtered everywhere downstream.
  if (entry.verdict === 'unreviewed') {
    db.run('DELETE FROM analysis_reviews WHERE project_id = ? AND scope = ? AND fact_key = ?', [
      entry.projectId,
      entry.scope,
      entry.factKey
    ])
    scheduleFlush()
    return
  }
  db.run(
    `INSERT OR REPLACE INTO analysis_reviews
       (project_id, scope, fact_key, kind, label, verdict, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
    [entry.projectId, entry.scope, entry.factKey, entry.kind, entry.label, entry.verdict, Date.now()]
  )
  scheduleFlush()
}

/**
 * Accepting a draft: its reviews become the accepted analysis's reviews,
 * replacing what the previous accepted analysis carried.
 *
 * This is the moment the old review history is superseded — and it only
 * happens on an explicit accept, which is the whole point of keeping the
 * two scopes apart.
 */
export function promoteDraftReviews(projectId: string): void {
  const db = getDb()
  db.run('DELETE FROM analysis_reviews WHERE project_id = ? AND scope = ?', [projectId, 'accepted'])
  db.run(
    "UPDATE analysis_reviews SET scope = 'accepted' WHERE project_id = ? AND scope = 'draft'",
    [projectId]
  )
  scheduleFlush()
}

/** Discarding a draft throws away only the draft's reviews. */
export function clearDraftReviews(projectId: string): void {
  getDb().run('DELETE FROM analysis_reviews WHERE project_id = ? AND scope = ?', [
    projectId,
    'draft'
  ])
  scheduleFlush()
}

/** Test/teardown support — see the note in costRepo's equivalent. */
export function deleteReviewsForProject(projectId: string): void {
  getDb().run('DELETE FROM analysis_reviews WHERE project_id = ?', [projectId])
  scheduleFlush()
}
