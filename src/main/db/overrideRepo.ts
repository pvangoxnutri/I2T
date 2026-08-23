import { getDb, scheduleFlush } from './index'
import {
  isOverridden,
  type ImageOverride,
  type OverrideField
} from '../../shared/imageFacts'
import type { CameraOrientation } from '../../shared/propertyAnalysis'

/**
 * Manual corrections to analysis-derived image facts.
 *
 * ── WHY A ROW DISAPPEARS WHEN IT IS EMPTY ────────────────────────────
 *
 * "Use analyzed value" clears one field. When the last overridden field is
 * cleared the row is deleted rather than left behind holding four NULLs,
 * because a surviving row means "this image is overridden" everywhere
 * downstream — the inspector badge, the re-analysis protection, the count
 * in the summary. A row that claims an override nobody made would keep
 * showing a Manual override badge over an analyzed value.
 */

interface Row {
  project_id: string
  image_id: string
  has_room: number
  room_label: string | null
  orientation: string | null
  openings: string | null
  landmarks: string | null
  updated_at: number
}

const parseList = (json: string | null): string[] | undefined => {
  if (json === null) return undefined
  try {
    const parsed = JSON.parse(json) as unknown
    return Array.isArray(parsed) ? parsed.map(String) : undefined
  } catch {
    return undefined
  }
}

function toOverride(row: Row): ImageOverride {
  return {
    projectId: row.project_id,
    imageId: row.image_id,
    // `has_room` separates "deliberately unassigned" (has_room = 1,
    // room_label NULL) from "no room override at all" (has_room = 0).
    ...(row.has_room === 1 ? { roomLabel: row.room_label } : {}),
    ...(row.orientation !== null
      ? { orientation: row.orientation as CameraOrientation }
      : {}),
    ...(parseList(row.openings) !== undefined ? { openings: parseList(row.openings)! } : {}),
    ...(parseList(row.landmarks) !== undefined ? { landmarks: parseList(row.landmarks)! } : {}),
    updatedAt: row.updated_at
  }
}

export function listOverrides(projectId: string): ImageOverride[] {
  const stmt = getDb().prepare('SELECT * FROM image_overrides WHERE project_id = ?')
  const out: ImageOverride[] = []
  try {
    stmt.bind([projectId])
    while (stmt.step()) out.push(toOverride(stmt.getAsObject() as unknown as Row))
  } finally {
    stmt.free()
  }
  return out
}

export function overrideFor(projectId: string, imageId: string): ImageOverride | null {
  return listOverrides(projectId).find((o) => o.imageId === imageId) ?? null
}

function write(override: ImageOverride): void {
  const db = getDb()
  if (!isOverridden(override)) {
    db.run('DELETE FROM image_overrides WHERE project_id = ? AND image_id = ?', [
      override.projectId,
      override.imageId
    ])
    scheduleFlush()
    return
  }
  db.run(
    `INSERT OR REPLACE INTO image_overrides
       (project_id, image_id, has_room, room_label, orientation, openings, landmarks, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      override.projectId,
      override.imageId,
      override.roomLabel !== undefined ? 1 : 0,
      override.roomLabel ?? null,
      override.orientation ?? null,
      override.openings !== undefined ? JSON.stringify(override.openings) : null,
      override.landmarks !== undefined ? JSON.stringify(override.landmarks) : null,
      Date.now()
    ]
  )
  scheduleFlush()
}

/** Set or replace ONE field. Everything already overridden is preserved. */
export function setOverrideField(
  projectId: string,
  imageId: string,
  field: OverrideField,
  value: string | string[] | null
): ImageOverride | null {
  const existing = overrideFor(projectId, imageId)
  const next: ImageOverride = {
    ...(existing ?? { projectId, imageId, updatedAt: 0 }),
    projectId,
    imageId,
    [field]: value,
    updatedAt: Date.now()
  } as ImageOverride
  write(next)
  return overrideFor(projectId, imageId)
}

/**
 * "Use analyzed value" — drop one manual field so the analysis shows
 * through again. Passing no field clears the whole override.
 */
export function clearOverrideField(
  projectId: string,
  imageId: string,
  field?: OverrideField
): ImageOverride | null {
  const existing = overrideFor(projectId, imageId)
  if (!existing) return null
  if (!field) {
    getDb().run('DELETE FROM image_overrides WHERE project_id = ? AND image_id = ?', [
      projectId,
      imageId
    ])
    scheduleFlush()
    return null
  }
  const next = { ...existing }
  delete next[field]
  next.updatedAt = Date.now()
  write(next)
  return overrideFor(projectId, imageId)
}

/** Teardown support — see the note in costRepo's equivalent. */
export function deleteOverridesForProject(projectId: string): void {
  getDb().run('DELETE FROM image_overrides WHERE project_id = ?', [projectId])
  scheduleFlush()
}
