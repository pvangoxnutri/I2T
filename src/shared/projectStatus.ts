import {
  transitionKey,
  type Project,
  type ProjectStatus,
  type QueueJob,
  type TransitionSettings
} from './types'

/**
 * THE single source of truth for project status and readiness.
 *
 * Two kinds of status exist and must never be confused:
 *  - PERSISTED (draft → ready → review → completed): set deliberately by the
 *    user, stored in SQLite.
 *  - DERIVED (queued, generating): a pure function of live queue activity,
 *    never stored — so a crash can't leave a project stuck "Generating".
 *
 * Every component reads status through `deriveProjectStatus`; nothing
 * computes its own version.
 */

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  draft: 'Draft',
  ready: 'Ready',
  queued: 'Queued',
  generating: 'Generating',
  review: 'Review',
  completed: 'Completed'
}

/** Statuses the user can set directly. */
export const PERSISTED_STATUSES: ProjectStatus[] = ['draft', 'ready', 'review', 'completed']

const ACTIVE_JOB_STATUSES = new Set(['processing'])
const PENDING_JOB_STATUSES = new Set(['queued', 'scheduled'])

export function deriveProjectStatus(project: Project, jobs: QueueJob[]): ProjectStatus {
  const mine = jobs.filter((j) => j.projectId === project.id)
  if (mine.some((j) => ACTIVE_JOB_STATUSES.has(j.status))) return 'generating'
  if (mine.some((j) => PENDING_JOB_STATUSES.has(j.status))) return 'queued'
  return project.status
}

// ── Readiness ────────────────────────────────────────────────────────────

export interface ProjectReadiness {
  imageCount: number
  transitionCount: number
  /** Pair labels still without a clip, e.g. ["2 → 3"]. */
  missingClipPairs: string[]
  /** Sum of every transition's configured duration. */
  totalSeconds: number
  /** Enough images AND every transition has a clip. */
  readyToAssemble: boolean
}

/** Transition settings in image order, filling defaults for untouched pairs. */
export function orderedTransitions(
  project: Project,
  defaultDurationSec: number
): { pairKey: string; label: string; settings: TransitionSettings }[] {
  const out: { pairKey: string; label: string; settings: TransitionSettings }[] = []
  for (let i = 0; i < project.images.length - 1; i++) {
    const pairKey = transitionKey(project.images[i].id, project.images[i + 1].id)
    out.push({
      pairKey,
      label: `${i + 1} → ${i + 2}`,
      settings: project.transitions[pairKey] ?? {
        prompt: '',
        durationSec: defaultDurationSec,
        status: 'not-generated',
        clip: null
      }
    })
  }
  return out
}

export function projectReadiness(project: Project, defaultDurationSec: number): ProjectReadiness {
  const pairs = orderedTransitions(project, defaultDurationSec)
  const missing = pairs.filter((p) => !p.settings.clip).map((p) => p.label)
  return {
    imageCount: project.images.length,
    transitionCount: pairs.length,
    missingClipPairs: missing,
    totalSeconds: pairs.reduce((sum, p) => sum + (p.settings.durationSec || 0), 0),
    readyToAssemble: project.images.length >= 2 && missing.length === 0
  }
}
