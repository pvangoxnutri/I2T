import type { JobStatus, QueueJob } from './types'
import type { MotionSegment } from './motionSegment'

/**
 * IS THIS MOTION CLIP ACTUALLY RUNNING?
 *
 * ── THE BUG THIS EXISTS FOR ──────────────────────────────────────────
 *
 * `queueMotionGeneration` wrote `status: 'queued'` onto the segment and
 * THEN enqueued the job. The runner's first act was to rebuild the
 * request, which asked readiness whether the segment could run — and
 * readiness refused, because the segment's status said `queued`.
 *
 * The queue's own lock refused the queue's own job. The job failed with
 * "already running", the failure path never reached the code that clears
 * the status, and the segment sat at `queued` forever. Four automatic
 * retries hit the same deadlock. No fal request was ever sent, so there
 * was nothing to recover — only a local marker nobody could clear.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────
 *
 * A stored status is a CACHE, never evidence. A motion segment is
 * running only if a queue job exists that is itself live. Everything
 * else — a terminal job, a missing job, a status word left behind by a
 * crash — resolves to idle, and Generate becomes available again.
 *
 * This is derived, not stored, so there is no second copy to go stale
 * and no repair migration to remember to run.
 */

/** Job statuses that mean work is genuinely still in flight. */
const LIVE_JOB_STATUSES: JobStatus[] = ['scheduled', 'queued', 'processing']

export function isLiveJobStatus(status: JobStatus): boolean {
  return LIVE_JOB_STATUSES.includes(status)
}

export type MotionRunState =
  /** Nothing is in flight. Generate is available. */
  | { kind: 'idle' }
  /** A live job owns this segment. A second paid submit is refused. */
  | { kind: 'running'; jobId: string; jobStatus: JobStatus }
  /**
   * The job is over but a PAID provider task exists and was never
   * downloaded. Resume polls it; generating again would pay twice.
   */
  | { kind: 'recoverable'; jobId: string; providerTaskId: string; reason: string }
  /** The job ended without producing anything. Regenerate is available. */
  | { kind: 'failed'; jobId: string; reason: string }

/**
 * Jobs belonging to ONE motion segment, newest first.
 *
 * Matched on `metadata.motionSegmentId`, which the job carries so it can
 * describe itself after a restart. Never on the pair fields — a motion
 * job has none.
 */
export function jobsForMotionSegment(jobs: QueueJob[], segmentId: string): QueueJob[] {
  return jobs
    .filter((j) => j.kind === 'motion-generation' && j.metadata?.motionSegmentId === segmentId)
    .sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * What is actually true about this segment right now.
 *
 * `excludeJobId` is how the runner asks about its OWN segment without
 * being blocked by the lock the queue set for it — idempotency keyed to
 * job identity rather than to a boolean, which is the whole point.
 */
export function motionRunState(
  segment: MotionSegment,
  jobs: QueueJob[],
  excludeJobId?: string | null
): MotionRunState {
  const mine = jobsForMotionSegment(jobs, segment.id).filter((j) => j.id !== excludeJobId)

  const live = mine.find((j) => isLiveJobStatus(j.status))
  if (live) return { kind: 'running', jobId: live.id, jobStatus: live.status }

  // A clip already attached means the last run delivered. Whatever older
  // rows say, there is nothing in flight and nothing to recover.
  if (segment.clip) return { kind: 'idle' }

  const newest = mine[0]
  if (!newest) {
    // No job at all. If the segment still claims to be running, that
    // claim is a leftover — the caller repairs it; the answer is idle.
    return { kind: 'idle' }
  }

  // ── A PAID TASK THAT WAS NEVER COLLECTED ──────────────────────────
  //
  // The job is terminal but the provider accepted a request, so the
  // money is already spent. Never offer a fresh paid generation as the
  // remedy for that: Resume fetches what was bought.
  const taskId = newest.provider?.providerTaskId
  if (taskId && !newest.provider?.dryRun) {
    return {
      kind: 'recoverable',
      jobId: newest.id,
      providerTaskId: taskId,
      reason:
        newest.note ??
        'A paid fal.ai task exists for this motion clip but its result was never downloaded.'
    }
  }

  if (newest.status === 'failed' || newest.status === 'cancelled') {
    return {
      kind: 'failed',
      jobId: newest.id,
      reason: newest.note ?? 'The last attempt did not produce a clip.'
    }
  }

  return { kind: 'idle' }
}

/**
 * The status the segment SHOULD carry, given what is really happening.
 *
 * Startup reconciliation writes this back, so the timeline and the
 * inspector stop describing a run that ended hours ago. It is the same
 * derivation as above — the stored value is only ever a rendering of it.
 */
export function reconciledMotionStatus(
  segment: MotionSegment,
  jobs: QueueJob[]
): MotionSegment['status'] {
  if (segment.clip) return 'completed'
  const state = motionRunState(segment, jobs)
  switch (state.kind) {
    case 'running':
      return state.jobStatus === 'processing' ? 'generating' : 'queued'
    case 'recoverable':
      // Still legitimately in flight from the operator's point of view:
      // a paid task exists and can be collected.
      return 'generating'
    case 'failed':
      return 'failed'
    case 'idle':
      return 'not-generated'
  }
}

/** True when the stored status disagrees with reality and must be fixed. */
export function motionStatusIsStale(segment: MotionSegment, jobs: QueueJob[]): boolean {
  return reconciledMotionStatus(segment, jobs) !== segment.status
}
