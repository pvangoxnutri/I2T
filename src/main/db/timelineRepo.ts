import type { Database } from 'sql.js'
import { getDb, scheduleFlush } from './index'
import type { Timeline, TimelineItem, TimelineSourceType } from '../../shared/timeline'

/**
 * Timeline persistence.
 *
 * The item list is REPLACED whole on every save, exactly as the
 * project's transitions are: a split changes positions from the cut
 * onward, a reorder changes most of them, and a delete renumbers
 * everything after it. Diffing that would be more code and more ways to
 * leave a gap in the ordering.
 *
 * Reads and writes go through one SAVEPOINT so a half-written timeline
 * can never be loaded.
 */

function run(db: Database, sql: string, params: unknown[] = []): void {
  const stmt = db.prepare(sql)
  try {
    stmt.run(params as never)
  } finally {
    stmt.free()
  }
}

function all<T>(db: Database, sql: string, params: unknown[] = []): T[] {
  const stmt = db.prepare(sql)
  const rows: T[] = []
  try {
    stmt.bind(params as never)
    while (stmt.step()) rows.push(stmt.getAsObject() as T)
  } finally {
    stmt.free()
  }
  return rows
}

interface TimelineRow {
  project_id: string
  feed_fingerprint: string
  manually_edited: number
  updated_at: number
}

interface ItemRow {
  id: string
  project_id: string
  position: number
  source_type: string
  source_id: string
  source_generation_id: string | null
  source_clip_name: string | null
  source_image_name: string | null
  start_offset_sec: number
  end_offset_sec: number
  seam_after_sec: number | null
}

/** The stored timeline, or null when this project has never had one. */
export function readTimeline(projectId: string): Timeline | null {
  const db = getDb()
  const head = all<TimelineRow>(db, 'SELECT * FROM timelines WHERE project_id = ?', [projectId])[0]
  if (!head) return null

  const rows = all<ItemRow>(
    db,
    'SELECT * FROM timeline_items WHERE project_id = ? ORDER BY position',
    [projectId]
  )

  return {
    projectId,
    feedFingerprint: head.feed_fingerprint,
    manuallyEdited: head.manually_edited === 1,
    updatedAt: head.updated_at,
    items: rows.map(
      (r): TimelineItem => ({
        id: r.id,
        order: r.position,
        sourceType: r.source_type as TimelineSourceType,
        sourceId: r.source_id,
        sourceGenerationId: r.source_generation_id,
        sourceClipName: r.source_clip_name,
        sourceImageName: r.source_image_name,
        startOffsetSec: r.start_offset_sec,
        endOffsetSec: r.end_offset_sec,
        // NULL survives as null — it means "the project's seam setting
        // decides", which is not the same as a stored zero.
        seamAfterSec: r.seam_after_sec
      })
    )
  }
}

export function saveTimeline(timeline: Timeline): void {
  const db = getDb()
  // A unique savepoint name per call: nesting two saves under the same
  // name releases the outer one early.
  const sp = `tl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  run(db, `SAVEPOINT ${sp}`)
  try {
    run(
      db,
      `INSERT INTO timelines (project_id, feed_fingerprint, manually_edited, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         feed_fingerprint = excluded.feed_fingerprint,
         manually_edited  = excluded.manually_edited,
         updated_at       = excluded.updated_at`,
      [
        timeline.projectId,
        timeline.feedFingerprint,
        timeline.manuallyEdited ? 1 : 0,
        timeline.updatedAt
      ]
    )

    run(db, 'DELETE FROM timeline_items WHERE project_id = ?', [timeline.projectId])
    for (const item of timeline.items) {
      run(
        db,
        `INSERT INTO timeline_items
           (id, project_id, position, source_type, source_id, source_generation_id,
            source_clip_name, source_image_name, start_offset_sec, end_offset_sec, seam_after_sec)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.id,
          timeline.projectId,
          item.order,
          item.sourceType,
          item.sourceId,
          item.sourceGenerationId,
          item.sourceClipName,
          item.sourceImageName,
          item.startOffsetSec,
          item.endOffsetSec,
          item.seamAfterSec
        ]
      )
    }
    run(db, `RELEASE ${sp}`)
  } catch (err) {
    run(db, `ROLLBACK TO ${sp}`)
    run(db, `RELEASE ${sp}`)
    throw err
  }
  scheduleFlush()
}

/**
 * Forget a project's timeline entirely.
 *
 * Only used by an explicit Rebuild from Feed, which writes a fresh one
 * immediately afterwards. Nothing here touches clips, generations or the
 * feed — a timeline is a view of those, never their owner.
 */
export function deleteTimeline(projectId: string): void {
  const db = getDb()
  run(db, 'DELETE FROM timeline_items WHERE project_id = ?', [projectId])
  run(db, 'DELETE FROM timelines WHERE project_id = ?', [projectId])
  scheduleFlush()
}

export type { TimelineItem }
