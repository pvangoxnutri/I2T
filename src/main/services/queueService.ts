import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import type {
  JobKind,
  JobMetadata,
  PriceSnapshot,
  ProviderJobState,
  QueueJob
} from '../../shared/types'
import {
  deleteAllJobsForProject,
  deletePendingJobsForProject,
  deleteJob,
  insertJob,
  isPausedRow,
  listJobRows,
  maxQueueOrder,
  setPausedRow,
  updateJob
} from '../db/queueRepo'
import type { AssembleHandle } from './ffmpegService'

/**
 * The persistent production queue.
 *
 * DESIGN: jobs are SELF-DESCRIBING rows in SQLite — everything needed to run
 * one lives in its metadata — so nothing depends on an in-memory closure and
 * a queued/scheduled job survives app termination. Runners are registered by
 * job KIND (see registerRunner) and looked up when a job starts.
 *
 * CONCURRENCY: FFmpeg work stays strictly serial (one process at a time).
 * `maxConcurrentAiGenerations` exists in Settings for future AI work; mock
 * generation currently also runs serially, deliberately conservative.
 *
 * RECOVERY (documented policy): a job found in `processing` at startup was
 * interrupted by termination — its OS process is gone and its output file may
 * be truncated. We NEVER silently resume it. It is failed with
 * "Interrupted by application shutdown", stays visible in History and keeps
 * its frozen PriceSnapshot, so a human can Retry it deliberately.
 */

export type JobRunner = (
  job: QueueJob,
  ctx: {
    onProgress: (pct: number) => void
    registerHandle: (handle: AssembleHandle) => void
  }
) => Promise<{ outputPath?: string; note?: string }>

const runners = new Map<JobKind, JobRunner>()
const handles = new Map<string, AssembleHandle>()
/** Jobs the user asked to stop — long-running runners poll this. */
const cancelledJobIds = new Set<string>()

export function isJobCancelled(jobId: string): boolean {
  return cancelledJobIds.has(jobId)
}

let jobs: QueueJob[] = []
let paused = false
let running = false
let tickTimer: ReturnType<typeof setInterval> | null = null

const TICK_MS = 5_000

export function registerRunner(kind: JobKind, runner: JobRunner): void {
  runners.set(kind, runner)
}

/**
 * Persists a patch to a job's provider lifecycle IMMEDIATELY (synchronous
 * DB write + broadcast). The live submit path uses this to store the remote
 * task id the instant Kling returns it — before anything else can fail.
 */
export function updateJobProvider(jobId: string, patch: Partial<ProviderJobState>): QueueJob | null {
  const job = jobs.find((j) => j.id === jobId)
  if (!job) return null

  // providerMeta MERGES rather than replaces. A status poll returns a much
  // smaller blob than the submit did, so a plain overwrite would delete the
  // queue urls fal handed back at submit time — leaving a PAID remote task
  // with no authoritative way to reach it, which is the exact failure this
  // path exists to prevent. Newer keys still win; an explicit null clears
  // nothing, because losing these urls is never what a caller means.
  const mergedMeta =
    patch.providerMeta && typeof patch.providerMeta === 'object'
      ? { ...(job.provider?.providerMeta ?? {}), ...patch.providerMeta }
      : (job.provider?.providerMeta ?? null)

  job.provider = {
    provider: 'kling',
    model: null,
    dryRun: true,
    providerTaskId: null,
    providerStatus: null,
    submittedAt: null,
    lastPolledAt: null,
    estimatedCost: null,
    actualCost: null,
    estimatedCredits: null,
    actualCredits: null,
    retryCount: 0,
    ...(job.provider ?? {}),
    ...patch,
    providerMeta: mergedMeta
  }
  persist(job)
  broadcast()
  return job
}

/**
 * Clears provider state for an explicit Regenerate — the ONE place a task id
 * and its queue urls may legitimately be dropped, because the operator has
 * asked for a new paid submission.
 */
export function resetJobProvider(jobId: string): QueueJob | null {
  const job = jobs.find((j) => j.id === jobId)
  if (!job || !job.provider) return job ?? null
  job.provider = {
    ...job.provider,
    providerTaskId: null,
    providerStatus: null,
    submittedAt: null,
    lastPolledAt: null,
    providerMeta: null
  }
  persist(job)
  broadcast()
  return job
}

function broadcast(): void {
  const snapshot = listJobs()
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('queue:changed', snapshot)
  }
}

export function listJobs(): QueueJob[] {
  return jobs.map((j) => ({ ...j }))
}

export function isPaused(): boolean {
  return paused
}

function persist(job: QueueJob): void {
  updateJob(job)
}

// ── Startup ──────────────────────────────────────────────────────────────

/**
 * Loads persisted jobs and recovers unsafe states. Called once after the
 * database opens, before any window exists.
 */
export function initQueue(): void {
  jobs = listJobRows()
  paused = isPausedRow()

  for (const job of jobs) {
    if (job.status === 'processing') {
      // The process that owned this job is gone with the previous run.
      // If a REMOTE task exists it is still running and already paid for —
      // say so, because Retry resumes polling instead of resubmitting.
      job.status = 'failed'
      job.note = job.provider?.providerTaskId
        ? `Interrupted by application shutdown — remote task ${job.provider.providerTaskId} may still be running. Retry resumes polling; it will NOT submit a new paid task.`
        : 'Interrupted by application shutdown'
      job.completedAt = Date.now()
      persist(job)
    } else if (job.status === 'scheduled' && job.scheduledFor !== null && job.scheduledFor <= Date.now()) {
      // Overdue while the app was closed → eligible immediately.
      job.status = 'queued'
      job.scheduledFor = null
      persist(job)
    }
  }

  if (!tickTimer) {
    tickTimer = setInterval(() => {
      promoteDueJobs()
      void pump()
    }, TICK_MS)
  }
  void pump()
}

export function stopQueue(): void {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
}

/** Scheduled jobs whose time has arrived become queued. */
function promoteDueJobs(): void {
  const now = Date.now()
  let changed = false
  for (const job of jobs) {
    if (job.status === 'scheduled' && job.scheduledFor !== null && job.scheduledFor <= now) {
      job.status = 'queued'
      job.scheduledFor = null
      persist(job)
      changed = true
    }
  }
  if (changed) broadcast()
}

// ── Enqueue ──────────────────────────────────────────────────────────────

export interface EnqueueSpec {
  projectId: string
  projectName: string
  kind: JobKind
  transitionCount: number
  price?: PriceSnapshot
  metadata?: JobMetadata
  /** Provider lifecycle for AI generation jobs. */
  provider?: ProviderJobState
  /** Epoch ms to run at; omitted/null = as soon as the queue reaches it. */
  scheduledFor?: number | null
}

export function enqueue(spec: EnqueueSpec): QueueJob {
  const scheduled = spec.scheduledFor != null && spec.scheduledFor > Date.now()
  const job: QueueJob = {
    id: randomUUID(),
    projectId: spec.projectId,
    projectName: spec.projectName,
    kind: spec.kind,
    status: scheduled ? 'scheduled' : 'queued',
    progressPct: 0,
    transitionCount: spec.transitionCount,
    createdAt: Date.now(),
    queueOrder: maxQueueOrder() + 1,
    scheduledFor: scheduled ? spec.scheduledFor! : null,
    startedAt: null,
    completedAt: null,
    metadata: spec.metadata ?? {},
    price: spec.price,
    provider: spec.provider
  }
  jobs.push(job)
  insertJob(job)
  broadcast()
  void pump()
  return job
}

// ── Controls ─────────────────────────────────────────────────────────────

export function pauseQueue(): void {
  paused = true
  setPausedRow(true)
  broadcast()
}

export function resumeQueue(): void {
  paused = false
  setPausedRow(false)
  broadcast()
  void pump()
}

export function cancelJob(jobId: string): void {
  const job = jobs.find((j) => j.id === jobId)
  if (!job) return
  // HONEST SEMANTICS: a remote provider task is NOT cancelled by us — we
  // only stop tracking it. It may keep running and may still be billed.
  // (fal.ai has a real cancel endpoint, but until the runner calls it and
  // sees 202 we still only claim "stopped tracking".)
  const remoteLabel = job.provider?.provider === 'fal' ? 'fal.ai' : 'Kling'
  const remoteNote = job.provider?.providerTaskId
    ? `Stopped tracking — the ${remoteLabel} task ${job.provider.providerTaskId} may continue remotely and may still be billed.`
    : 'Cancelled'

  if (job.status === 'scheduled' || job.status === 'queued') {
    job.status = 'cancelled'
    job.note = remoteNote
    job.completedAt = Date.now()
    persist(job)
    broadcast()
  } else if (job.status === 'processing') {
    handles.get(jobId)?.cancel()
    cancelledJobIds.add(jobId)
    if (job.provider?.providerTaskId) {
      job.note = remoteNote
      persist(job)
      broadcast()
    }
    // The worker's catch marks it failed once the work stops.
  }
}

/** Retry resets execution state but NEVER touches the frozen price
 * snapshot — historical customer value is not recalculated. */
export function retryJob(jobId: string): void {
  const job = jobs.find((j) => j.id === jobId)
  if (!job) return
  if (job.status !== 'failed' && job.status !== 'cancelled') return
  job.status = 'queued'
  job.progressPct = 0
  job.startedAt = null
  job.completedAt = null
  job.queueOrder = maxQueueOrder() + 1
  // Keep the previous failure readable in the note history.
  job.note = job.note ? `Retried after: ${job.note}` : undefined
  // The provider lifecycle is PRESERVED on purpose: an existing
  // providerTaskId means a remote task may already exist, and the runner's
  // idempotency gate resumes it instead of paying for a second submission.
  if (job.provider) {
    job.provider = { ...job.provider, retryCount: job.provider.retryCount + 1 }
  }
  persist(job)
  broadcast()
  void pump()
}

/**
 * The remote provider task id, read from persisted state rather than from
 * whatever the renderer happens to hold. This is what "Copy Task ID" copies:
 * if our status path turns out to be wrong, this id is the only handle on a
 * task that has already been paid for.
 */
export function remoteTaskId(jobId: string): string | null {
  return jobs.find((j) => j.id === jobId)?.provider?.providerTaskId ?? null
}

/** What a job knows about reaching its remote task — for the recovery UI. */
export interface RemoteTaskHandles {
  providerTaskId: string | null
  statusUrl: string | null
  responseUrl: string | null
  cancelUrl: string | null
  /** True when fal's own urls are stored; false means we would have to
   *  rebuild a path, which is what answers 405. */
  authoritative: boolean
}

export function remoteTaskHandles(jobId: string): RemoteTaskHandles | null {
  const job = jobs.find((j) => j.id === jobId)
  if (!job) return null
  const meta = (job.provider?.providerMeta ?? {}) as Record<string, unknown>
  const read = (key: string): string | null =>
    typeof meta[key] === 'string' && (meta[key] as string).length > 0 ? (meta[key] as string) : null
  const statusUrl = read('status_url')
  const responseUrl = read('response_url')
  const cancelUrl = read('cancel_url')
  return {
    providerTaskId: job.provider?.providerTaskId ?? null,
    statusUrl,
    responseUrl,
    cancelUrl,
    authoritative: !!(statusUrl || responseUrl || cancelUrl)
  }
}

/**
 * MANUAL RECOVERY for a job whose queue urls were never persisted.
 *
 * The first fal implementation discarded status_url / response_url /
 * cancel_url, so a real paid request exists with only its id stored and no
 * url that works. This lets the operator paste the urls fal shows for that
 * request (dashboard, or the original submit response) and attach them to
 * the existing job.
 *
 * It NEVER touches the task id and never submits anything: it only adds
 * ways to reach a task that already exists.
 */
export function recoverRemoteTaskUrls(
  jobId: string,
  urls: { statusUrl?: string | null; responseUrl?: string | null; cancelUrl?: string | null }
): { ok: true; handles: RemoteTaskHandles } | { ok: false; reason: string } {
  const job = jobs.find((j) => j.id === jobId)
  if (!job) return { ok: false, reason: 'Job no longer exists.' }
  if (!job.provider?.providerTaskId) {
    return {
      ok: false,
      reason: 'This job has no remote task id, so there is nothing to recover. Use Regenerate to create one.'
    }
  }

  const patch: Record<string, string> = {}
  const accept = (key: string, raw: string | null | undefined): string | null => {
    const value = (raw ?? '').trim()
    if (!value) return null
    // Only fal queue urls — this field must never become a way to point the
    // app's authenticated client at an arbitrary host.
    if (!/^https:\/\/queue\.fal\.run\//i.test(value)) {
      return `${key} must be a https://queue.fal.run/… url from fal.ai.`
    }
    patch[key] = value
    return null
  }

  for (const [key, raw] of [
    ['status_url', urls.statusUrl],
    ['response_url', urls.responseUrl],
    ['cancel_url', urls.cancelUrl]
  ] as const) {
    const problem = accept(key, raw)
    if (problem) return { ok: false, reason: problem }
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, reason: 'Enter at least one url to recover this task.' }
  }

  updateJobProvider(jobId, { providerMeta: patch })
  const handles = remoteTaskHandles(jobId)
  return handles ? { ok: true, handles } : { ok: false, reason: 'Recovery could not be verified.' }
}

/**
 * RESUME POLLING — re-queues a job to keep tracking a remote task that
 * already exists. It refuses outright when there is no task id, so it can
 * never become a disguised "generate again": the runner's idempotency gate
 * sees the task id and resolves to resume-poll or download, never submit.
 *
 * The provider lifecycle is passed through completely untouched.
 */
export function resumePolling(jobId: string): { ok: true } | { ok: false; reason: string } {
  const job = jobs.find((j) => j.id === jobId)
  if (!job) return { ok: false, reason: 'Job no longer exists.' }
  const taskId = job.provider?.providerTaskId
  if (!taskId) {
    return {
      ok: false,
      reason: 'This job has no remote task to resume — there is nothing to poll.'
    }
  }
  if (job.status === 'processing' || job.status === 'queued') {
    return { ok: false, reason: 'This job is already being tracked.' }
  }

  job.status = 'queued'
  job.progressPct = 0
  job.startedAt = null
  job.completedAt = null
  job.queueOrder = maxQueueOrder() + 1
  const providerName = job.provider?.provider === 'fal' ? 'fal.ai' : 'Kling'
  job.note = `Resuming polling for ${providerName} task ${taskId} — no new generation will be submitted.`
  // job.provider is intentionally NOT modified: not the task id, not the
  // status, not the metadata, not the retry count.
  persist(job)
  broadcast()
  void pump()
  return { ok: true }
}

export function removeJob(jobId: string): void {
  const job = jobs.find((j) => j.id === jobId)
  if (!job || job.status === 'processing') return
  jobs = jobs.filter((j) => j.id !== jobId)
  deleteJob(jobId)
  broadcast()
}

/** Moves a not-yet-started job within the waiting order. Active and
 * finished jobs cannot be reordered. */
export function reorderJob(jobId: string, direction: 'up' | 'down'): void {
  const waiting = jobs
    .filter((j) => j.status === 'queued' || j.status === 'scheduled')
    .sort((a, b) => a.queueOrder - b.queueOrder)
  const index = waiting.findIndex((j) => j.id === jobId)
  if (index === -1) return
  const target = direction === 'up' ? index - 1 : index + 1
  if (target < 0 || target >= waiting.length) return

  const [moved] = waiting.splice(index, 1)
  waiting.splice(target, 0, moved)
  // Renumber the waiting set so the order persists deterministically.
  waiting.forEach((job, i) => {
    job.queueOrder = i + 1
    persist(job)
  })
  broadcast()
}

/**
 * TEST SUPPORT ONLY — removes every queue row for a project, finished
 * history included, and drops it from the in-memory list so the two
 * cannot diverge.
 *
 * PRODUCTION RETENTION IS UNCHANGED. Deleting a project in the app still
 * keeps its completed history (see `purgePendingJobsForProject` below):
 * that is why queue_jobs has no foreign key to projects, and why the
 * product deliberately spares terminal rows. This is the escape hatch a
 * test harness needs in order to own and reclaim exactly what it created.
 *
 * Returns how many database rows were removed, so teardown can ASSERT it
 * did something rather than trusting a silent call — which is precisely
 * how the previous leak stayed invisible.
 */
export function purgeAllJobsForProjectForTests(projectId: string): number {
  for (const j of jobs) {
    if (j.projectId === projectId && j.status === 'processing') handles.get(j.id)?.cancel()
  }
  jobs = jobs.filter((j) => j.projectId !== projectId)
  const removed = deleteAllJobsForProject(projectId)
  broadcast()
  return removed
}

/** Project deletion: pending work is cancelled and removed, finished
 * history rows are kept so completed customer value stays visible. */
export function purgePendingJobsForProject(projectId: string): void {
  jobs = jobs.filter((j) => {
    const pending = j.status === 'scheduled' || j.status === 'queued' || j.status === 'processing'
    if (j.projectId === projectId && pending) {
      if (j.status === 'processing') handles.get(j.id)?.cancel()
      return false
    }
    return true
  })
  deletePendingJobsForProject(projectId)
  broadcast()
}

// ── Worker ───────────────────────────────────────────────────────────────

async function pump(): Promise<void> {
  if (running || paused) return
  promoteDueJobs()

  const job = jobs
    .filter((j) => j.status === 'queued')
    .sort((a, b) => a.queueOrder - b.queueOrder || a.createdAt - b.createdAt)[0]
  if (!job) return

  const runner = runners.get(job.kind)
  if (!runner) {
    // Never silently process an invalid job.
    job.status = 'failed'
    job.note = `No runner registered for job type "${job.kind}"`
    job.completedAt = Date.now()
    persist(job)
    broadcast()
    void pump()
    return
  }

  running = true
  cancelledJobIds.delete(job.id)
  job.status = 'processing'
  job.progressPct = 0
  job.startedAt = Date.now()
  job.note = undefined
  persist(job)
  broadcast()

  try {
    const result = await runner(job, {
      onProgress: (pct) => {
        if (job.progressPct !== pct) {
          job.progressPct = pct
          persist(job)
          broadcast()
        }
      },
      registerHandle: (handle) => handles.set(job.id, handle)
    })
    job.status = 'completed'
    job.progressPct = 100
    job.outputPath = result.outputPath
    job.note = result.note
  } catch (err) {
    job.status = 'failed'
    job.note = err instanceof Error ? err.message : String(err)
  } finally {
    job.completedAt = Date.now()
    handles.delete(job.id)
    cancelledJobIds.delete(job.id)
    persist(job)
    running = false
    broadcast()
    void pump()
  }
}
