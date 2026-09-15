import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import type { Project } from '../../shared/types'
import { listProjects } from '../db/projectsRepo'
import { broadcastProjectUpdated } from '../events'
import { readTimeline, saveTimeline, deleteTimeline } from '../db/timelineRepo'
import { clipPath, imagePath } from '../files'
import { projectAssembly } from './exportService'
import { probeDurationSec } from './ffmpegService'
import { getAllProjectGenerations } from '../db/generationCatalogueRepo'
import { motionSegments } from '../../shared/motionSegment'
import {
  feedFingerprintOf,
  locateAtTime,
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
  removeItem,
  reorderItems,
  splitItemAt,
  timelineDrift,
  timelineDurationSec,
  timelineFromPlan,
  type Timeline,
  type TimelineDrift,
  type TimelineItem
} from '../../shared/timeline'
import type { AssemblySegment } from '../../shared/assemblyPlan'

/**
 * THE TIMELINE, OWNED IN MAIN.
 *
 * ── WHEN IT IS BUILT, AND WHEN IT IS NOT ─────────────────────────────
 *
 * Materialised ONCE, lazily, the first time a project's timeline is
 * asked for. After that it is persistent and authoritative, and NOTHING
 * here rebuilds it on its own — not a feed reorder, not a regeneration,
 * not a re-render. That is the whole point of §3: an operator who has
 * started cutting must never lose it to a background refresh.
 *
 * Drift is REPORTED instead. `timelineDrift` compares the fingerprint
 * the timeline was built from against the current plan, and the UI shows
 * a banner with an explicit Rebuild action. A rebuild with manual edits
 * present requires a confirm flag that only a deliberate click supplies.
 */

function findProject(projectId: string): Project | null {
  return listProjects().find((p) => p.id === projectId) ?? null
}

/**
 * The real length of a managed clip, in seconds.
 *
 * Probed with FFmpeg rather than taken from the request that made it: a
 * provider can deliver 5.04s for a 5s request, and an out point past the
 * real end produces a frozen tail on export.
 */
function clipDurationSec(projectId: string, storedName: string): number {
  const path = clipPath(projectId, storedName)
  if (!path) return 0
  const probed = probeDurationSec(path)
  return Number.isFinite(probed) && probed > 0 ? Math.round(probed * 1000) / 1000 : 0
}

/**
 * Which generation produced the clip a segment plays.
 *
 * Pinned into the item so a later regeneration cannot move the
 * operator's in/out points onto different footage (§20).
 */
function generationIndex(projectId: string): Map<string, string> {
  const byClip = new Map<string, string>()
  try {
    for (const gen of getAllProjectGenerations(projectId)) {
      if (gen.clip?.storedName) byClip.set(gen.clip.storedName, gen.id)
    }
  } catch {
    // History is a convenience here. A project whose catalogue cannot be
    // read still gets a timeline; its items simply carry no generation id.
  }
  return byClip
}

function clipNameForSegment(project: Project, segment: AssemblySegment): string | null {
  if (segment.kind === 'motion') {
    const seg = motionSegments(project).find((s) => s.id === segment.motionSegmentId)
    return seg?.clip?.storedName ?? null
  }
  if (segment.kind === 'clip' && segment.pairKey) {
    return project.transitions[segment.pairKey]?.clip?.storedName ?? null
  }
  return null
}

function imageNameForSegment(project: Project, segment: AssemblySegment): string | null {
  const image = project.images.find((i) => i.id === segment.imageId)
  return image?.storedName ?? null
}

/** The project's default blend, for boundaries that store no explicit seam. */
export function defaultSeamSec(projectId: string): number {
  const { plan } = projectAssembly(findProject(projectId) as Project)
  // Any boundary the plan itself blended tells us the project setting;
  // an all-cut plan legitimately has no blend at all.
  return plan.seamSeconds.find((s) => s > 0) ?? 0
}

/**
 * Materialise from the canonical plan.
 *
 * Deliberately the SAME `projectAssembly` the exporter uses, so a fresh
 * timeline reproduces today's export exactly.
 */
export function buildTimelineFromFeed(projectId: string): Timeline | null {
  const project = findProject(projectId)
  if (!project) return null

  const { plan } = projectAssembly(project)
  const byClip = generationIndex(projectId)

  return timelineFromPlan(
    projectId,
    plan,
    {
      clipDurationSec: (name) => clipDurationSec(projectId, name),
      clipNameFor: (segment) => clipNameForSegment(project, segment),
      imageNameFor: (segment) => imageNameForSegment(project, segment),
      generationIdFor: (segment) => {
        const name = clipNameForSegment(project, segment)
        return name ? (byClip.get(name) ?? null) : null
      }
    },
    () => randomUUID(),
    Date.now()
  )
}

export interface TimelineView {
  timeline: Timeline | null
  /** Whether the feed has moved on, and whether edits are at stake. */
  drift: TimelineDrift
  durationSec: number
  defaultSeamSec: number
  /** Per item: does its source actually exist on disk right now? */
  missing: string[]
}

/**
 * Read the timeline, materialising it the first time.
 *
 * The lazy build is the ONLY automatic write. Everything after it is an
 * operator action.
 */
export function getTimeline(projectId: string): TimelineView | null {
  const project = findProject(projectId)
  if (!project) return null

  let timeline = readTimeline(projectId)
  if (!timeline) {
    timeline = buildTimelineFromFeed(projectId)
    if (timeline) saveTimeline(timeline)
  }

  const { plan } = projectAssembly(project)
  const seam = plan.seamSeconds.find((s) => s > 0) ?? 0

  return {
    timeline,
    drift: timelineDrift(timeline, feedFingerprintOf(plan)),
    durationSec: timeline ? timelineDurationSec(timeline.items, seam) : 0,
    defaultSeamSec: seam,
    missing: timeline ? missingSources(projectId, timeline.items) : []
  }
}

/** Item ids whose source file is not on disk. */
export function missingSources(projectId: string, items: TimelineItem[]): string[] {
  return items
    .filter((item) => {
      const path =
        item.sourceType === 'still'
          ? item.sourceImageName
            ? imagePath(projectId, item.sourceImageName)
            : null
          : item.sourceClipName
            ? clipPath(projectId, item.sourceClipName)
            : null
      if (!path) return true
      try {
        return !existsSync(path) || statSync(path).size === 0
      } catch {
        return true
      }
    })
    .map((i) => i.id)
}

type EditResult = { ok: true; view: TimelineView } | { ok: false; reason: string }

/**
 * Apply an edit and mark the timeline hand-edited.
 *
 * The flag is what makes a later Rebuild require confirmation, so it is
 * set here — in the one place every edit passes through — rather than at
 * each call site where it could be forgotten.
 */
function commit(projectId: string, items: TimelineItem[]): EditResult {
  const current = readTimeline(projectId)
  if (!current) return { ok: false, reason: 'This project has no timeline yet.' }

  saveTimeline({
    ...current,
    items,
    manuallyEdited: true,
    updatedAt: Date.now()
  })
  broadcastProjectUpdated(projectId)
  const view = getTimeline(projectId)
  return view ? { ok: true, view } : { ok: false, reason: 'Project no longer exists' }
}

/**
 * SPLIT AT THE PLAYHEAD.
 *
 * `atSec` is ABSOLUTE timeline time, because that is what the playhead
 * knows. It is resolved to an item and a local offset by the same
 * `locateAtTime` the preview uses, so the frame the operator is looking
 * at is the frame the cut lands on.
 *
 * No file is written. See `splitItemAt`.
 */
export function splitTimelineAt(projectId: string, itemId: string, atSec: number): EditResult {
  const view = getTimeline(projectId)
  if (!view?.timeline) return { ok: false, reason: 'This project has no timeline yet.' }

  const located = locateAtTime(view.timeline.items, atSec, view.defaultSeamSec)
  if (!located) return { ok: false, reason: 'The playhead is not over a clip.' }
  if (located.item.id !== itemId) {
    return {
      ok: false,
      reason: 'The playhead is not inside the selected clip. Move it, or select the clip under it.'
    }
  }

  const split = splitItemAt(view.timeline.items, itemId, located.localSec, () => randomUUID())
  if (!split.ok) return { ok: false, reason: split.reason }

  const result = commit(projectId, split.items)
  if (result.ok) {
    console.log(
      `[timeline] split ${itemId} at ${located.localSec}s → ${split.newItemId} (no file was written)`
    )
  }
  return result
}

/**
 * Remove one item from the final edit.
 *
 * The clip file, its catalogue row and the feed are all untouched: this
 * removes a segment from the video, not the work that produced it.
 */
export function deleteTimelineItem(projectId: string, itemId: string): EditResult {
  const view = getTimeline(projectId)
  if (!view?.timeline) return { ok: false, reason: 'This project has no timeline yet.' }
  if (!view.timeline.items.some((i) => i.id === itemId)) {
    return { ok: false, reason: 'That clip is no longer on the timeline.' }
  }
  return commit(projectId, removeItem(view.timeline.items, itemId))
}

/**
 * RETIME ONE ITEM.
 *
 * ── WHY THIS EDITS THE ITEM AND NOTHING ELSE ─────────────────────────
 *
 * Speed is a decision about one piece of the finished edit, so it is
 * stored on that piece. No file is touched, nothing is re-encoded and
 * nothing upstream is consulted: the same clip can appear twice on the
 * timeline at two different speeds, and a split leaves two halves that
 * can be retimed independently.
 *
 * Marking the timeline manually edited is what stops a later rebuild
 * from the feed silently discarding the operator's retiming, the same
 * protection splits and deletions already have.
 */
export function setTimelineItemSpeed(
  projectId: string,
  itemId: string,
  playbackRate: number
): EditResult {
  const view = getTimeline(projectId)
  if (!view?.timeline) return { ok: false, reason: 'This project has no timeline yet.' }
  if (!view.timeline.items.some((i) => i.id === itemId)) {
    return { ok: false, reason: 'That clip is no longer on the timeline.' }
  }
  if (!Number.isFinite(playbackRate)) {
    return { ok: false, reason: 'That speed is not a number.' }
  }
  if (playbackRate < MIN_PLAYBACK_RATE || playbackRate > MAX_PLAYBACK_RATE) {
    return {
      ok: false,
      reason:
        `Speed must be between ${MIN_PLAYBACK_RATE}x and ${MAX_PLAYBACK_RATE}x. ` +
        `Outside that range a generated clip has too few real frames to retime convincingly.`
    }
  }
  // Rounded to two decimals: the inspector offers steps and a slider, and
  // storing 1.2999999 would make the readout disagree with itself.
  const rate = Math.round(playbackRate * 100) / 100
  return commit(
    projectId,
    view.timeline.items.map((item) => (item.id === itemId ? { ...item, playbackRate: rate } : item))
  )
}

export function reorderTimelineItem(
  projectId: string,
  itemId: string,
  toIndex: number
): EditResult {
  const view = getTimeline(projectId)
  if (!view?.timeline) return { ok: false, reason: 'This project has no timeline yet.' }
  return commit(projectId, reorderItems(view.timeline.items, itemId, toIndex))
}

/**
 * REBUILD FROM FEED — always explicit, never automatic.
 *
 * `confirmDiscardEdits` exists so that discarding an operator's cuts
 * requires a caller that has said, in so many words, that it means to.
 */
export function rebuildTimeline(
  projectId: string,
  confirmDiscardEdits: boolean
): EditResult {
  const current = readTimeline(projectId)
  if (current?.manuallyEdited && !confirmDiscardEdits) {
    return {
      ok: false,
      reason:
        'This timeline has manual edits — splits, deletions or reordering. ' +
        'Rebuilding from the Feed will discard them. Confirm to continue.'
    }
  }

  const rebuilt = buildTimelineFromFeed(projectId)
  if (!rebuilt) return { ok: false, reason: 'Project no longer exists' }

  deleteTimeline(projectId)
  saveTimeline(rebuilt)
  broadcastProjectUpdated(projectId)
  console.log(`[timeline] rebuilt ${projectId} from feed (${rebuilt.items.length} items)`)

  const view = getTimeline(projectId)
  return view ? { ok: true, view } : { ok: false, reason: 'Project no longer exists' }
}
