import type { Database } from 'sql.js'
import type { JobMetadata, PriceSnapshot, ProviderId, ProviderJobState, QueueJob } from '../../shared/types'
import { getDb, scheduleFlush } from './index'

/**
 * Persistence for the queue. Jobs are stored as complete, self-describing
 * rows: everything a job needs to run lives in the row (metadata_json), so
 * a queued or scheduled job survives app termination and runs on the next
 * launch without any in-memory state.
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

interface JobRow {
  id: string
  project_id: string
  project_name: string
  kind: string
  status: string
  queue_order: number
  progress_pct: number
  transition_count: number
  created_at: number
  scheduled_for: number | null
  started_at: number | null
  completed_at: number | null
  error: string | null
  price_json: string | null
  metadata_json: string
  output_path: string | null
  provider: string | null
  provider_model: string | null
  provider_dry_run: number | null
  provider_task_id: string | null
  provider_status: string | null
  provider_submitted_at: number | null
  provider_last_polled_at: number | null
  provider_meta_json: string | null
  estimated_cost: number | null
  actual_cost: number | null
  estimated_credits: number | null
  actual_credits: number | null
  retry_count: number | null
}

function toJob(row: JobRow): QueueJob {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    kind: row.kind as QueueJob['kind'],
    status: row.status as QueueJob['status'],
    queueOrder: row.queue_order,
    progressPct: row.progress_pct,
    transitionCount: row.transition_count,
    createdAt: row.created_at,
    scheduledFor: row.scheduled_for,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    metadata: JSON.parse(row.metadata_json || '{}') as JobMetadata,
    note: row.error ?? undefined,
    outputPath: row.output_path ?? undefined,
    price: row.price_json ? (JSON.parse(row.price_json) as PriceSnapshot) : undefined,
    provider: row.provider
      ? ({
          provider: row.provider as ProviderId,
          model: row.provider_model,
          dryRun: (row.provider_dry_run ?? 1) === 1,
          providerTaskId: row.provider_task_id,
          providerStatus: row.provider_status,
          submittedAt: row.provider_submitted_at,
          lastPolledAt: row.provider_last_polled_at,
          providerMeta: row.provider_meta_json
            ? (JSON.parse(row.provider_meta_json) as Record<string, unknown>)
            : null,
          estimatedCost: row.estimated_cost,
          actualCost: row.actual_cost,
          estimatedCredits: row.estimated_credits ?? null,
          actualCredits: row.actual_credits ?? null,
          retryCount: row.retry_count ?? 0
        } satisfies ProviderJobState)
      : undefined
  }
}

/** Column values for the provider lifecycle, in a fixed order shared by
 * INSERT and UPDATE. */
function providerParams(p: ProviderJobState | undefined): unknown[] {
  return [
    p?.provider ?? null,
    p?.model ?? null,
    p ? (p.dryRun ? 1 : 0) : 1,
    p?.providerTaskId ?? null,
    p?.providerStatus ?? null,
    p?.submittedAt ?? null,
    p?.lastPolledAt ?? null,
    p?.providerMeta ? JSON.stringify(p.providerMeta) : null,
    p?.estimatedCost ?? null,
    p?.actualCost ?? null,
    p?.estimatedCredits ?? null,
    p?.actualCredits ?? null,
    p?.retryCount ?? 0
  ]
}

export function listJobRows(): QueueJob[] {
  return all<JobRow>(
    getDb(),
    'SELECT * FROM queue_jobs ORDER BY queue_order ASC, created_at ASC'
  ).map(toJob)
}

export function insertJob(job: QueueJob): void {
  run(
    getDb(),
    `INSERT INTO queue_jobs
       (id, project_id, project_name, kind, status, queue_order, progress_pct,
        transition_count, created_at, scheduled_for, started_at, completed_at,
        error, price_json, metadata_json, output_path,
        provider, provider_model, provider_dry_run, provider_task_id,
        provider_status, provider_submitted_at, provider_last_polled_at,
        provider_meta_json, estimated_cost, actual_cost,
        estimated_credits, actual_credits, retry_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      job.id,
      job.projectId,
      job.projectName,
      job.kind,
      job.status,
      job.queueOrder,
      job.progressPct,
      job.transitionCount,
      job.createdAt,
      job.scheduledFor,
      job.startedAt,
      job.completedAt,
      job.note ?? null,
      job.price ? JSON.stringify(job.price) : null,
      JSON.stringify(job.metadata ?? {}),
      job.outputPath ?? null,
      ...providerParams(job.provider)
    ]
  )
  scheduleFlush()
}

/** Writes the whole job row — the price snapshot included, unchanged. */
export function updateJob(job: QueueJob): void {
  run(
    getDb(),
    `UPDATE queue_jobs SET
       project_name = ?, kind = ?, status = ?, queue_order = ?, progress_pct = ?,
       transition_count = ?, scheduled_for = ?, started_at = ?, completed_at = ?,
       error = ?, price_json = ?, metadata_json = ?, output_path = ?,
       provider = ?, provider_model = ?, provider_dry_run = ?, provider_task_id = ?,
       provider_status = ?, provider_submitted_at = ?, provider_last_polled_at = ?,
       provider_meta_json = ?, estimated_cost = ?, actual_cost = ?,
       estimated_credits = ?, actual_credits = ?, retry_count = ?
     WHERE id = ?`,
    [
      job.projectName,
      job.kind,
      job.status,
      job.queueOrder,
      job.progressPct,
      job.transitionCount,
      job.scheduledFor,
      job.startedAt,
      job.completedAt,
      job.note ?? null,
      job.price ? JSON.stringify(job.price) : null,
      JSON.stringify(job.metadata ?? {}),
      job.outputPath ?? null,
      ...providerParams(job.provider),
      job.id
    ]
  )
  scheduleFlush()
}

export function deleteJob(jobId: string): void {
  run(getDb(), 'DELETE FROM queue_jobs WHERE id = ?', [jobId])
  scheduleFlush()
}

/**
 * Removes EVERY queue row for a project, finished history included.
 *
 * ── NOT A PRODUCT OPERATION ──────────────────────────────────────────
 *
 * Production deliberately does the opposite: deleting a project keeps its
 * completed history so the customer value that was already delivered
 * stays visible, which is why queue_jobs has no foreign key to projects
 * and why `deletePendingJobsForProject` is careful to spare terminal
 * rows. That retention is intentional and is NOT changed here.
 *
 * This exists for one caller: test teardown, which owns the rows it
 * created and must be able to remove them completely so a suite run is
 * repeatable. It goes straight to SQL rather than through the queue's
 * in-memory list, because that list is a UI projection and anything it
 * filters or misses would silently leak rows.
 */
export function deleteAllJobsForProject(projectId: string): number {
  const db = getDb()
  const before = all<{ n: number }>(
    db,
    'SELECT COUNT(*) AS n FROM queue_jobs WHERE project_id = ?',
    [projectId]
  )[0]?.n
  run(db, 'DELETE FROM queue_jobs WHERE project_id = ?', [projectId])
  scheduleFlush()
  return before ?? 0
}

/** Removes a project's PENDING work (scheduled/queued/processing) while
 * keeping finished history rows readable. */
export function deletePendingJobsForProject(projectId: string): void {
  run(
    getDb(),
    `DELETE FROM queue_jobs
     WHERE project_id = ? AND status IN ('scheduled', 'queued', 'processing')`,
    [projectId]
  )
  scheduleFlush()
}

export function maxQueueOrder(): number {
  const rows = all<{ m: number | null }>(getDb(), 'SELECT MAX(queue_order) AS m FROM queue_jobs')
  return rows[0]?.m ?? 0
}

// ── Queue-level state ────────────────────────────────────────────────────

export function isPausedRow(): boolean {
  const rows = all<{ paused: number }>(getDb(), 'SELECT paused FROM queue_state WHERE id = 1')
  return (rows[0]?.paused ?? 0) === 1
}

export function setPausedRow(paused: boolean): void {
  run(
    getDb(),
    `INSERT INTO queue_state (id, paused) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET paused = excluded.paused`,
    [paused ? 1 : 0]
  )
  scheduleFlush()
}
