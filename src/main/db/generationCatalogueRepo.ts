import type { Database } from 'sql.js'
import { getDb, scheduleFlush } from './index'
import { clipUrl } from '../files'
import type { TransitionClip, ClipSource, GenerationRecord } from '../../shared/types'
import type {
  QualityOutcome,
  QualityOverride,
  QualityStatus,
  SuspiciousFrame
} from '../../shared/qualityValidation'

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
  queue_job_id: string
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
  quality_status: string | null
  quality_reason: string | null
  quality_checked_at: number | null
  quality_frames_json: string | null
  quality_validator: string | null
  quality_override: string | null
  /** Present only on single-image motion rows. NULL on every transition. */
  motion_segment_id: string | null
  motion_type: string | null
  /** The length THIS run was made at. NULL on rows written before v31. */
  duration_sec: number | null
}

/**
 * The quality half of a row.
 *
 * A missing or unrecognised status reads as `not-run` — "nobody looked" —
 * never as `passed`. Rows written before migration 24 have no value at
 * all, and inventing approval for them would be a claim about content
 * that was never inspected.
 */
function qualityOf(r: GenerationRow): {
  qualityStatus: QualityStatus
  qualityReason: string | null
  qualityCheckedAt: number | null
  suspiciousFrames: SuspiciousFrame[]
  qualityValidator: string | null
  qualityOverride: QualityOverride
} {
  const known: QualityStatus[] = ['passed', 'failed', 'needs-review', 'not-run']
  const status = known.includes(r.quality_status as QualityStatus)
    ? (r.quality_status as QualityStatus)
    : 'not-run'
  let frames: SuspiciousFrame[] = []
  if (r.quality_frames_json) {
    try {
      const parsed: unknown = JSON.parse(r.quality_frames_json)
      if (Array.isArray(parsed)) frames = parsed as SuspiciousFrame[]
    } catch {
      // A corrupt blob loses the detail, not the verdict.
    }
  }
  return {
    qualityStatus: status,
    qualityReason: r.quality_reason,
    qualityCheckedAt: r.quality_checked_at,
    suspiciousFrames: frames,
    qualityValidator: r.quality_validator,
    qualityOverride: r.quality_override === 'manual' ? 'manual' : null
  }
}

/**
 * THE CANONICAL RESOLVER, NOT A SECOND SPELLING OF IT.
 *
 * This file used to build its own url:
 *
 *   f2f://project/<projectId>/transition/<clipName>
 *
 * which the protocol handler cannot serve. It reads the HOST to choose a
 * directory — `image`, `clip`, `export` — and `project` is not one of
 * them, so every catalogue clip resolved to null and came back 404. The
 * `<video>` element had nothing to play, while Show in folder used a real
 * path and worked, which is exactly the reported "plays in Explorer, not
 * in I2T".
 *
 * Neither was the id encoded, so anything needing escaping broke a second
 * way. `clipUrl` in files.ts is the one builder that matches the handler.
 */

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
  /**
   * SINGLE-IMAGE MOTION, when that is what this generation was.
   *
   * Absent for a transition, which is every existing caller. Present, it
   * is what makes the row unambiguously a motion run — the catalogue
   * never infers that from the image ids.
   */
  motionSegmentId?: string | null
  motionType?: string | null
  /** The length this run was submitted at, recorded per generation. */
  durationSec?: number | null
  clip: TransitionClip | null
  prompt: string
  cost?: { money: number; credits: number } | null
  /**
   * Whether this generation is the one in use.
   *
   * DEFAULTS TO TRUE for compatibility with callers written before
   * quality validation, but the live path now passes FALSE and activates
   * only after the clip has been inspected. A generation that has not
   * been looked at must not take over from a good clip that has.
   */
  active?: boolean
}): string {
  const db = getDb()
  const id = crypto.randomUUID()
  const now = Date.now()

  run(
    db,
    `INSERT INTO transition_generations
       (id, queue_job_id, project_id, from_image_id, to_image_id, provider, model,
        created_at, status, clip_name, clip_original_name, clip_source,
        prompt_used, provider_meta_json, generation_cost, generation_credits, active,
        motion_segment_id, motion_type, duration_sec)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      (generation.active ?? true) ? 1 : 0,
      generation.motionSegmentId ?? null,
      generation.motionType ?? null,
      generation.durationSec ?? null
    ]
  )

  scheduleFlush()

  // ── THE ID MUST NAME A ROW THAT EXISTS ──────────────────────────────
  //
  // `DO NOTHING` inserts nothing when this job already has a row, and
  // this used to return the freshly minted `id` regardless — an
  // identifier for a row nobody ever wrote. Every caller then addressed
  // that phantom: `applyQualityResult` updated zero rows and the verdict
  // was silently discarded, while the catalogue kept pointing at the
  // first attempt's clip.
  //
  // Seen on the operator's own job: a Retry download wrote a second,
  // byte-identical file, recorded nothing, dropped its quality result,
  // and left 2.6 MB on disk that no row references.
  const existing = all<{ id: string }>(
    db,
    `SELECT id FROM transition_generations WHERE project_id = ? AND queue_job_id = ?`,
    [generation.projectId, generation.queueJobId]
  )
  return existing[0]?.id ?? id
}

/**
 * Store what the quality check found.
 *
 * Writes the verdict ONLY — never `active`. Whether a clip may be used is
 * a separate decision made by the caller from this verdict plus any
 * operator override, so that a validator result can never silently
 * promote or demote a clip as a side effect of being recorded.
 */
export function applyQualityResult(generationId: string, outcome: QualityOutcome): void {
  run(
    getDb(),
    `UPDATE transition_generations
     SET quality_status = ?, quality_reason = ?, quality_checked_at = ?,
         quality_frames_json = ?, quality_validator = ?
     WHERE id = ?`,
    [
      outcome.status,
      outcome.reason,
      outcome.checkedAt,
      outcome.suspiciousFrames.length > 0 ? JSON.stringify(outcome.suspiciousFrames) : null,
      outcome.validator,
      generationId
    ]
  )
  scheduleFlush()
}

/**
 * An operator knowingly accepting a clip the check rejected.
 *
 * The verdict is NOT rewritten. `quality_status` keeps saying `failed`
 * and the reason stays readable — what changes is that a human took
 * responsibility, recorded separately as provenance. Flipping the status
 * to `passed` would erase the fact that the automatic check objected,
 * which is the one thing a later review needs to see.
 */
export function approveQualityManually(projectId: string, generationId: string): void {
  run(
    getDb(),
    `UPDATE transition_generations SET quality_override = 'manual'
     WHERE project_id = ? AND id = ?`,
    [projectId, generationId]
  )
  scheduleFlush()
}

/** The generation currently in use for a pair, if any. */
export function activeGenerationForPair(
  projectId: string,
  fromImageId: string,
  toImageId: string
): GenerationRecord | null {
  return (
    getGenerationsForPair(projectId, fromImageId, toImageId).find((g) => g.active) ?? null
  )
}

/**
 * WHAT ONE QUEUE JOB ACTUALLY PRODUCED.
 *
 * Distinct from `activeGenerationForPair`, and the distinction is the
 * whole point: a generation that downloaded successfully and was then
 * REJECTED by quality validation is deliberately not active. Asking the
 * transition what it is playing therefore answers "nothing" for a job
 * that produced a real file sitting on disk — which the queue panel
 * reported as `Download pending / No local clip` while the quality panel,
 * reading the catalogue, reported `Failed quality check` for the very
 * same job.
 *
 * A job's output is a fact about the job. It is read from the job's own
 * row.
 */
export function generationForJobPair(
  queueJobId: string,
  projectId: string,
  fromImageId: string,
  toImageId: string
): GenerationRecord | null {
  return (
    getGenerationsForPair(projectId, fromImageId, toImageId).find(
      (g) => g.queueJobId === queueJobId
    ) ?? null
  )
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
 * One row → one record.
 *
 * Extracted so every read path produces the identical shape. The
 * mapping was inline in each query, which is exactly how a new column
 * comes to be returned by two readers and silently dropped by a third.
 */
function toGenerationRecord(r: GenerationRow): GenerationRecord {
  return {
    id: r.id,
    queueJobId: r.queue_job_id,
    projectId: r.project_id,
    fromImageId: r.from_image_id,
    toImageId: r.to_image_id,
    motionSegmentId: r.motion_segment_id ?? null,
    motionType: r.motion_type ?? null,
    durationSec: r.duration_sec ?? null,
    provider: r.provider,
    model: r.model,
    createdAt: r.created_at,
    status: (r.status as 'completed' | 'failed' | 'cancelled') || 'completed',
    clip: r.clip_name
      ? {
          storedName: r.clip_name,
          originalName: r.clip_original_name ?? r.clip_name,
          source: (r.clip_source ?? 'manual') as TransitionClip['source'],
          src: clipUrl(r.project_id, r.clip_name)
        }
      : null,
    promptUsed: r.prompt_used,
    providerMeta: r.provider_meta_json ? JSON.parse(r.provider_meta_json) : null,
    generationCost: r.generation_cost,
    generationCredits: r.generation_credits,
    active: r.active === 1,
    ...qualityOf(r)
  }
}

/**
 * Every generation of ONE MOTION SEGMENT, newest first.
 *
 * Scoped by segment id, never by image: a photograph may carry a push-in
 * and a pan, and each keeps its own history.
 */
export function getGenerationsForMotion(
  projectId: string,
  motionSegmentId: string
): GenerationRecord[] {
  const db = getDb()
  const rows = all<GenerationRow>(
    db,
    `SELECT * FROM transition_generations
     WHERE project_id = ? AND motion_segment_id = ?
     -- rowid breaks ties: two rows written in the same millisecond
     -- must still come back in a stable, meaningful order.
     ORDER BY created_at DESC, rowid DESC`,
    [projectId, motionSegmentId]
  )
  return rows.map(toGenerationRecord)
}

/**
 * Retire the previous generations of ONE MOTION SEGMENT.
 *
 * Scoped by segment id rather than by image, because a photograph may
 * carry more than one motion clip and regenerating a pan must not retire
 * the push-in beside it. Nothing is deleted: history outlives the clip
 * that happens to be current.
 */
export function archivePreviousMotionGenerations(
  projectId: string,
  motionSegmentId: string
): void {
  const db = getDb()
  run(
    db,
    `UPDATE transition_generations
     SET active = 0
     WHERE project_id = ? AND motion_segment_id = ? AND active = 1`,
    [projectId, motionSegmentId]
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
     -- Insertion order breaks a timestamp tie. Two regenerations of the
     -- same pair inside one millisecond are perfectly ordinary, and
     -- 'which model did the last run use' must not be arbitrary when
     -- they collide: rowid is monotonic, created_at is not unique.
     ORDER BY created_at DESC, rowid DESC`,
    [projectId, fromImageId, toImageId]
  )

  return rows.map((r: GenerationRow) => ({
    id: r.id,
    queueJobId: r.queue_job_id,
    projectId: r.project_id,
    fromImageId: r.from_image_id,
    toImageId: r.to_image_id,
    motionSegmentId: r.motion_segment_id ?? null,
    motionType: r.motion_type ?? null,
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
    active: r.active === 1,
    ...qualityOf(r)
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
     -- Insertion order breaks a timestamp tie. Two regenerations of the
     -- same pair inside one millisecond are perfectly ordinary, and
     -- 'which model did the last run use' must not be arbitrary when
     -- they collide: rowid is monotonic, created_at is not unique.
     ORDER BY created_at DESC, rowid DESC`,
    [projectId]
  )

  return rows.map((r: GenerationRow) => ({
    id: r.id,
    queueJobId: r.queue_job_id,
    projectId: r.project_id,
    fromImageId: r.from_image_id,
    toImageId: r.to_image_id,
    motionSegmentId: r.motion_segment_id ?? null,
    motionType: r.motion_type ?? null,
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
    active: r.active === 1,
    ...qualityOf(r)
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
