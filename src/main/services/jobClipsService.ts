import { statSync } from 'node:fs'
import type { JobClipStatus } from '../../shared/types'
import { transitionKey } from '../../shared/types'
import { listProjects } from '../db/projectsRepo'
import { listJobs } from './queueService'
import { getFeedImages } from '../../shared/feedSequence'
import { clipPath as resolveClipPath } from '../files'
import { generationForJobPair, getGenerationsForMotion } from '../db/generationCatalogueRepo'
import { MOTION_SHORT_LABEL, motionSegments, type MotionType } from '../../shared/motionSegment'

/**
 * WHAT ONE QUEUE JOB PRODUCED.
 *
 * ── ONE RESOLVER, FOR BOTH SUBJECTS ─────────────────────────────────
 *
 * The Queue row renders its clip section — View clip, Show in folder,
 * the size, the missing-file warning — entirely from this list. It used
 * to live inline in the IPC handler and to start with
 *
 *     const pairKeys = job.metadata?.pairKeys ?? []
 *     if (pairKeys.length === 0) return []
 *
 * so every single-image motion job resolved to nothing and the whole
 * section, Show in folder included, was never drawn. The button was not
 * broken; it did not exist.
 *
 * Extracted here so the resolver is callable — by the handler and by the
 * test that proves a motion job resolves to the exact file it produced.
 * A resolver that can only be reached through IPC is a resolver whose
 * behaviour nothing can pin.
 *
 * The renderer never sees a path: it gets a storedName and asks main to
 * reveal it.
 */
export function clipsForJob(jobId: string): JobClipStatus[] {
    const job = listJobs().find((j) => j.id === jobId)
    if (!job) return []

    const project = listProjects().find((p) => p.id === job.projectId)
    if (!project) return []

    // ── A MOTION JOB HAS NO PAIR KEYS ─────────────────────────────────
    //
    // THE BUG THIS FIXES. The guard below returned `[]` for any job with
    // no `pairKeys` — which is every single-image motion job. The Queue
    // row's whole clip section is rendered from this list, so a motion
    // job that had generated a real, playable file showed no clip, no
    // View clip and no Show in folder at all. The button was not broken;
    // it was never rendered, because the resolver only knew about pairs.
    //
    // Resolved through the SEGMENT, exactly as the rest of the feature
    // is: job → motionSegmentId → this job's own generation row → its
    // clip. The renderer still receives a stored name and asks main to
    // reveal it, so no path is ever built in the renderer.
    if (job.kind === 'motion-generation') {
      const segmentId = job.metadata?.motionSegmentId
      if (!segmentId) return []
      const segment = motionSegments(project).find((s) => s.id === segmentId)

      // THIS JOB's output, not whatever the segment currently plays. A
      // regeneration moves the segment on; the older job's row must keep
      // pointing at the file that job produced.
      // ── NO FALLBACK TO THE SEGMENT'S CLIP ─────────────────────────
      //
      // The transition branch below falls back to the transition's own
      // clip for jobs written before the catalogue existed. Motion jobs
      // have no such history — the catalogue predates the feature — so
      // the same fallback here does nothing but lie: the segment's clip
      // belongs to whichever run last succeeded, and attaching it to a
      // FAILED job made that job report a 7.5 MB file it never produced.
      // A job reports its own output or none.
      const produced =
        getGenerationsForMotion(project.id, segmentId).find((g) => g.queueJobId === job.id) ?? null
      const clip = produced?.clip ?? null
      const path = clip ? resolveClipPath(project.id, clip.storedName) : null

      const feedIndex = segment ? getFeedImages(project).findIndex((i) => i.id === segment.imageId) : -1
      const motion = (produced?.motionType ?? segment?.motion) as MotionType | undefined
      return [
        {
          // No pair, and none invented. The queue row keys its playback state on
          // this, so it must be stable and unique — the segment id is both.
          pairKey: segmentId,
          label:
            `SINGLE IMAGE MOTION · ` +
            (feedIndex >= 0 ? `IMAGE ${String(feedIndex + 1).padStart(2, '0')}` : 'IMAGE (not in feed)') +
            (motion ? ` · ${MOTION_SHORT_LABEL[motion] ?? motion}` : ''),
          storedName: clip?.storedName ?? null,
          originalName: clip?.originalName ?? null,
          source: clip?.source ?? null,
          src: clip?.src ?? null,
          exists: path !== null,
          bytes: path ? (() => { try { return statSync(path).size } catch { return 0 } })() : 0,
          quality: produced?.qualityStatus ?? null,
          qualityReason: produced?.qualityReason ?? null,
          downloadedButNotActive: path !== null && !(produced?.active ?? false)
        }
      ]
    }

    const pairKeys = job.metadata?.pairKeys ?? []
    if (pairKeys.length === 0) return []

    // Image ORDER gives the human label, exactly as the editor numbers them in the feed.
    const labels = new Map<string, string>()
    const feedImages = getFeedImages(project)
    for (let i = 0; i < feedImages.length - 1; i++) {
      labels.set(
        transitionKey(feedImages[i].id, feedImages[i + 1].id),
        `Image ${i + 1} → Image ${i + 2}`
      )
    }

    return pairKeys.map((pairKey) => {
      /**
       * WHAT THIS JOB PRODUCED — not what the transition is playing.
       *
       * These differ exactly when a clip downloaded successfully and was
       * then rejected by quality validation: the file is on disk, the
       * catalogue row records the verdict, and the transition correctly
       * refuses to adopt it. Reading the transition here reported
       * `No local clip` and drove `Download pending` for a job whose
       * 2.6 MB file had been sitting on disk for ten minutes — while the
       * quality panel, reading the catalogue, said `Failed quality check`
       * about the same job. One job, two sources, two contradictory
       * stories.
       *
       * The transition's clip remains the fallback for jobs that predate
       * the catalogue, where no per-job row exists.
       */
      const [fromId, toId] = pairKey.split('->') as [string, string]
      const produced = generationForJobPair(jobId, project.id, fromId, toId)
      const clip = produced?.clip ?? project.transitions[pairKey]?.clip ?? null
      const path = clip ? resolveClipPath(project.id, clip.storedName) : null
      let bytes = 0
      if (path) {
        try {
          bytes = statSync(path).size
        } catch {
          bytes = 0
        }
      }
      return {
        pairKey,
        label: labels.get(pairKey) ?? pairKey,
        storedName: clip?.storedName ?? null,
        originalName: clip?.originalName ?? null,
        source: clip?.source ?? null,
        src: clip?.src ?? null,
        exists: path !== null,
        bytes,
        // The verdict travels with the file, so the panel can say the
        // clip arrived AND was rejected — two facts, not one contradiction.
        quality: produced?.qualityStatus ?? null,
        qualityReason: produced?.qualityReason ?? null,
        /** True when the file is here but deliberately not in use. */
        downloadedButNotActive: path !== null && !(produced?.active ?? false)
      }
    })
}
