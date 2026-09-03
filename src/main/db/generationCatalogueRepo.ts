import type { Database } from 'sql.js'
import { getDb, scheduleFlush } from './index'
import type { TransitionClip, ClipSource, GenerationRecord } from '../../shared/types'

// Local helpers matching projectsRepo pattern
function run(db: Database, sql: string, params: unknown[] = []): void {
  const stmt = db.prepare(sql)
  stmt.bind(params as any)
  stmt.step()
  stmt.free()
}

function all<T>(db: Database, sql: string, params: unknown[] = []): T[] {
  const stmt = db.prepare(sql)
  stmt.bind(params as any)
  const result: T[] = []
  while (stmt.step()) {
    result.push(stmt.getAsObject() as T)
  }
  stmt.free()
  return result
}

interface GenerationRow {
  id: string
  project_id: string
  from_image_id: string
  to_image_id: string
  provider: string
  model: string | null
  created_at: number
  status: string
  clip_name: string | null
  clip_original_name: string | null
  clip_source: string | null
  prompt_used: string
  provider_meta_json: string | null
  generation_cost: number | null
  generation_credits: number | null
  active: number
}

const clipUrl = (projectId: string, clipName: string): string =>
  `f2f://project/${projectId}/transition/${clipName}`

/**
 * Record a new generation in the catalogue.
 * Called after a successful transition generation.
 *
 * IDEMPOTENCY: queueJobId is UNIQUE, so same job can't create duplicate rows
 * even if called multiple times via polling/retry/restart.
 * New regenerations get new job IDs → new catalogue rows.
 */
export function recordGeneration(generation: {
  queueJobId: string  // Stable idempotency key (unique per generation job)
  projectId: string
  fromImageId: string
  toImageId: string
  provider: string
  model: string | null
  clip: TransitionClip | null
  prompt: string
  cost?: { money: number; credits: number } | null
}): string {
  const db = getDb()
  const id = crypto.randomUUID()
  const now = Date.now()

  run(
    db,
    `INSERT INTO transition_generations
       (id, queue_job_id, project_id, from_image_id, to_image_id, provider, model,
        created_at, status, clip_name, clip_original_name, clip_source,
        prompt_used, provider_meta_json, generation_cost, generation_credits, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     -- Scoped to the project, matching the unique index. A job id seen
     -- under a DIFFERENT project must not silently suppress this row:
     -- the generation happened and the money was spent either way.
     ON CONFLICT(project_id, queue_job_id) DO NOTHING`,
    [
      id,
      generation.queueJobId,
      generation.projectId,
      generation.fromImageId,
      generation.toImageId,
      generation.provider,
      generation.model,
      now,
      'completed',
      generation.clip?.storedName ?? null,
      generation.clip?.originalName ?? null,
      generation.clip?.source ?? null,
      generation.prompt,
      null, // provider_meta_json — optional, populate if provider returns metadata
      generation.cost?.money ?? null,
      generation.cost?.credits ?? null,
      1 // active: true for newest generation
    ]
  )

  scheduleFlush()
  return id
}

/**
 * Mark previous generations of this pair as inactive when a new one is generated.
 * New generation becomes the "active" one automatically.
 */
export function archivePreviousGenerations(
  projectId: string,
  fromImageId: string,
  toImageId: string
): void {
  const db = getDb()
  run(
    db,
    `UPDATE transition_generations
     SET active = 0
     WHERE project_id = ? AND from_image_id = ? AND to_image_id = ? AND active = 1`,
    [projectId, fromImageId, toImageId]
  )
  scheduleFlush()
}

/**
 * Get all generations for a pair, newest first.
 */
export function getGenerationsForPair(
  projectId: string,
  fromImageId: string,
  toImageId: string
): GenerationRecord[] {
  const db = getDb()
  const rows = all<GenerationRow>(
    db,
    `SELECT * FROM transition_generations
     WHERE project_id = ? AND from_image_id = ? AND to_image_id = ?
     ORDER BY created_at DESC`,
    [projectId, fromImageId, toImageId]
  )

  return rows.map((r: GenerationRow) => ({
    id: r.id,
    projectId: r.project_id,
    fromImageId: r.from_image_id,
    toImageId: r.to_image_id,
    provider: r.provider,
    model: r.model,
    createdAt: r.created_at,
    status: (r.status as 'completed' | 'failed' | 'cancelled') || 'completed',
    clip: r.clip_name
      ? {
          storedName: r.clip_name,
          originalName: r.clip_original_name ?? r.clip_name,
          source: (r.clip_source ?? 'manual') as any,
          src: clipUrl(projectId, r.clip_name)
        }
      : null,
    promptUsed: r.prompt_used,
    providerMeta: r.provider_meta_json ? JSON.parse(r.provider_meta_json) : null,
    generationCost: r.generation_cost,
    generationCredits: r.generation_credits,
    active: r.active === 1
  }))
}

/**
 * Get all generations in a project (for catalogue view).
 */
export function getAllProjectGenerations(projectId: string): GenerationRecord[] {
  const db = getDb()
  const rows = all<GenerationRow>(
    db,
    `SELECT * FROM transition_generations
     WHERE project_id = ?
     ORDER BY created_at DESC`,
    [projectId]
  )

  return rows.map((r: GenerationRow) => ({
    id: r.id,
    projectId: r.project_id,
    fromImageId: r.from_image_id,
    toImageId: r.to_image_id,
    provider: r.provider,
    model: r.model,
    createdAt: r.created_at,
    status: (r.status as 'completed' | 'failed' | 'cancelled') || 'completed',
    clip: r.clip_name
      ? {
          storedName: r.clip_name,
          originalName: r.clip_original_name ?? r.clip_name,
          source: (r.clip_source ?? 'manual') as any,
          src: clipUrl(projectId, r.clip_name)
        }
      : null,
    promptUsed: r.prompt_used,
    providerMeta: r.provider_meta_json ? JSON.parse(r.provider_meta_json) : null,
    generationCost: r.generation_cost,
    generationCredits: r.generation_credits,
    active: r.active === 1
  }))
}

/**
 * Make ONE generation the active one for its pair.
 *
 * Paired with `archivePreviousGenerations`, which clears the flag across
 * the pair first — the two together are what keep "exactly one active"
 * true. Nothing is deleted: a generation that stops being active is
 * history, not a mistake.
 */
export function setActiveGeneration(projectId: string, generationId: string): void {
  const db = getDb()
  run(db, `UPDATE transition_generations SET active = 1 WHERE project_id = ? AND id = ?`, [
    projectId,
    generationId
  ])
  scheduleFlush()
}
