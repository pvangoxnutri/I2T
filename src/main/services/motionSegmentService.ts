import { listProjects, saveProject } from '../db/projectsRepo'
import { broadcastProjectUpdated } from '../events'
import { getFeedSequenceIds } from '../../shared/feedSequence'
import { buildMotionPrompt } from '../../shared/motionPrompt'
import {
  makeMotionSegmentId,
  motionSegments,
  type MotionSegment,
  type MotionType
} from '../../shared/motionSegment'

/**
 * SINGLE-IMAGE MOTION SEGMENTS — create, retime, remove.
 *
 * Their own store, their own ids. Nothing here touches
 * `project.transitions`, and nothing that reasons about image PAIRS can
 * see what this writes — which is the point: a photograph with gentle
 * motion is a presentation choice, not evidence that two rooms connect.
 */

export interface MotionSegmentOutcome {
  ok: boolean
  reason?: string
  segment?: MotionSegment
}

/** Adds a motion clip to one photograph. Never generates anything. */
export function addMotionSegment(input: {
  projectId: string
  imageId: string
  motion: MotionType
  durationSec: number
}): MotionSegmentOutcome {
  const project = listProjects().find((p) => p.id === input.projectId)
  if (!project) return { ok: false, reason: 'Project not found' }

  // It must be a photograph the video actually shows. A motion clip for
  // an image outside the feed would be paid for and never played.
  if (!getFeedSequenceIds(project).includes(input.imageId)) {
    return {
      ok: false,
      reason: 'That photograph is not in the Transition Feed, so a motion clip would never play.'
    }
  }

  const segment: MotionSegment = {
    id: makeMotionSegmentId(),
    kind: 'single-motion',
    imageId: input.imageId,
    motion: input.motion,
    durationSec: input.durationSec,
    status: 'not-generated',
    clip: null,
    // Its own prompt builder — the transition preset describes a START
    // and an END frame, and there is no end frame here to describe.
    prompt: buildMotionPrompt(input.motion),
    createdAt: Date.now()
  }

  project.motionSegments = [...motionSegments(project), segment]
  project.updatedAt = Date.now()
  saveProject(project)
  broadcastProjectUpdated(project.id)
  console.log(`[motion] added ${segment.id} ${segment.motion} on ${input.imageId}`)
  return { ok: true, segment }
}

/**
 * Change the motion or the length of a segment that has not been paid for.
 *
 * A generated segment keeps its clip: changing the motion would make the
 * stored video no longer match what the row claims. Regenerating with a
 * different motion is a new paid run, decided in the confirmation.
 */
export function updateMotionSegment(
  projectId: string,
  segmentId: string,
  patch: { motion?: MotionType; durationSec?: number }
): MotionSegmentOutcome {
  const project = listProjects().find((p) => p.id === projectId)
  if (!project) return { ok: false, reason: 'Project not found' }

  const segments = motionSegments(project)
  const existing = segments.find((s) => s.id === segmentId)
  if (!existing) return { ok: false, reason: 'That motion clip no longer exists.' }

  const motion = patch.motion ?? existing.motion
  const updated: MotionSegment = {
    ...existing,
    motion,
    durationSec: patch.durationSec ?? existing.durationSec,
    // The wording follows the motion, unless a clip already exists for
    // the old one — then the row must keep describing what was made.
    prompt: existing.clip ? existing.prompt : buildMotionPrompt(motion)
  }

  project.motionSegments = segments.map((s) => (s.id === segmentId ? updated : s))
  project.updatedAt = Date.now()
  saveProject(project)
  broadcastProjectUpdated(project.id)
  return { ok: true, segment: updated }
}

/**
 * Remove a motion segment from the video.
 *
 * The generated clip stays on disk and in the catalogue: it was paid for,
 * and removing a segment from the sequence is not a decision to destroy
 * the work.
 */
export function removeMotionSegment(projectId: string, segmentId: string): MotionSegmentOutcome {
  const project = listProjects().find((p) => p.id === projectId)
  if (!project) return { ok: false, reason: 'Project not found' }

  const remaining = motionSegments(project).filter((s) => s.id !== segmentId)
  project.motionSegments = remaining
  project.updatedAt = Date.now()
  saveProject(project)
  broadcastProjectUpdated(project.id)
  console.log(`[motion] removed ${segmentId}; its clip is kept in History`)
  return { ok: true }
}
