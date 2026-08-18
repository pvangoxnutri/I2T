import type { QueueJob } from '../types'

/**
 * Mock queue data — UI only. The real queue arrives with the scheduler
 * milestone; these rows exercise every status the UI must render.
 */
export const mockQueueJobs: QueueJob[] = [
  {
    id: 'job-1',
    projectId: 'demo-1',
    projectName: 'Strandvägen 14 — Penthouse',
    kind: 'transitions',
    status: 'processing',
    progressPct: 62,
    transitionCount: 11,
    createdAt: Date.now() - 1000 * 60 * 14
  },
  {
    id: 'job-2',
    projectId: 'demo-2',
    projectName: 'Villa Ekbacken',
    kind: 'transitions',
    status: 'queued',
    progressPct: 0,
    transitionCount: 8,
    createdAt: Date.now() - 1000 * 60 * 6
  },
  {
    id: 'job-3',
    projectId: 'demo-2',
    projectName: 'Villa Ekbacken',
    kind: 'preview-export',
    status: 'queued',
    progressPct: 0,
    transitionCount: 8,
    createdAt: Date.now() - 1000 * 60 * 5
  },
  {
    id: 'job-4',
    projectId: 'demo-3',
    projectName: 'Sjöutsikten 3B',
    kind: 'final-export',
    status: 'completed',
    progressPct: 100,
    transitionCount: 9,
    createdAt: Date.now() - 1000 * 60 * 60 * 3
  },
  {
    id: 'job-5',
    projectId: 'demo-4',
    projectName: 'Kvarnholmen Loft',
    kind: 'transitions',
    status: 'failed',
    progressPct: 34,
    transitionCount: 12,
    createdAt: Date.now() - 1000 * 60 * 60 * 26,
    note: 'Provider timeout on transition 5 — retry when generation is wired up.'
  }
]
