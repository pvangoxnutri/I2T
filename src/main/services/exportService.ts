import { activeGenerationForPair } from '../db/generationCatalogueRepo'
import { qualityAllowsActive } from '../../shared/qualityValidation'
import type { GenerationRecord, JobMetadata } from '../../shared/types'
import {
  applyExportFormat,
  DEFAULT_EXPORT_FORMAT,
  type ExportFormatId
} from '../../shared/exportFormat'
import { getFeedImages } from '../../shared/feedSequence'
import { motionSegmentLabel, motionSegments } from '../../shared/motionSegment'
import { readTimeline } from '../db/timelineRepo'
import { app, BrowserWindow, dialog } from 'electron'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { transitionKey, type ExportDefaults, type Project, type QueueJob } from '../../shared/types'
import type { CompareAssemblyResult } from '../../shared/seamBlend'
import { DEFAULT_PRICING, priceSnapshot } from '../../shared/pricing'
import { listProjects, getSettingsJson } from '../db/projectsRepo'
import { clipPath, EDITOR_PREVIEW_NAME, exportUrl, imagePath } from '../files'
import { projectDir, safeManagedPath } from '../paths'
import { assemble, type AssembleSegment } from './ffmpegService'
import { enqueue, registerRunner } from './queueService'
import { readAnalysis } from '../db/analysisRepo'
import { listOverrides } from '../db/overrideRepo'
import { reviewMap } from '../db/reviewRepo'
import { applyImageOverrides } from '../../shared/imageFacts'
import { planSequence } from '../../shared/transitionPlan'
import { planAssembly } from '../../shared/assemblyPlan'
import {
  resolveTransitionMode,
  type EffectiveTransitionMode
} from '../../shared/transitionMode'

/**
 * Turns "export this project" into a validated, persisted job.
 *
 * The overlay PNGs are written into the project's MANAGED export directory
 * (not a temp dir) precisely so the job stays runnable after an app restart:
 * a queued export contains its clips, its overlays and its destination.
 * They are removed when the job finishes.
 */

export type ExportKind = 'preview' | 'final'

export interface ExportOverlays {
  /** Full-frame transparent PNGs rendered by the UI at output resolution. */
  watermarkPng?: ArrayBuffer | null
  signaturePng?: ArrayBuffer | null
}

export type ExportStartResult =
  | { ok: true; jobId: string }
  | { ok: false; canceled: true }
  | { ok: false; canceled?: false; missing: string[]; reason: string }

const DEFAULT_EXPORT: ExportDefaults = {
  aspectRatio: '16:9',
  resolution: '1080p',
  fps: 25,
  defaultTransitionDurationSec: 5,
  // Seamless Assembly is ON by default: adjacent clips share a key frame,
  // and without a short blend every joint reads as a cut.
  seamBlend: 'subtle'
}

function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*]/g, '')
    .trim()
    .replace(/\s+/g, '_')
  return cleaned || 'frametoframe'
}

function exportsDir(projectId: string): string {
  return join(projectDir(projectId), 'exports')
}

function readSettings(): { exportDefaults: ExportDefaults; pricing: typeof DEFAULT_PRICING } {
  const json = getSettingsJson()
  const parsed = json ? JSON.parse(json) : {}
  return {
    // Merged, not substituted: settings stored before seamBlend existed
    // must gain the default rather than losing the operator's aspect
    // ratio, resolution and fps.
    exportDefaults: { ...DEFAULT_EXPORT, ...(parsed.exportDefaults ?? {}) },
    pricing: parsed.pricing ?? DEFAULT_PRICING
  }
}

/**
 * The assembly timeline for one project, with cuts and crossfades resolved.
 *
 * ── ONE PLACE DECIDES ────────────────────────────────────────────────
 *
 * Missing-clip checks, the editor preview, Compare Assembly and the export
 * runner all used to walk the image pairs themselves and demand a clip for
 * every one. With cuts in the picture that is simply wrong, so they all
 * come here instead and get the same answer.
 */
/**
 * WHAT ACTUALLY GETS EXPORTED.
 *
 * ── THE TIMELINE IS THE LAST WORD ────────────────────────────────────
 *
 * When an explicit timeline exists it decides the film: the order, the
 * in and out points, and which segments survived the operator's cuts.
 * The feed-derived plan is still computed — readiness, the cut/crossfade
 * readout and the editor's own diagnostics all come from it — but it no
 * longer chooses what is encoded. Anything else would mean an operator
 * could split and delete on screen and export something different.
 *
 * A project that has never had a timeline falls straight through to the
 * feed plan, byte-for-byte as before.
 */
export function exportAssembly(project: Project): {
  plan: ReturnType<typeof planAssembly>
  segments: AssembleSegment[]
  seamOverrideSec: (number | null)[]
  /** Set when the timeline decided this, for honest reporting. */
  fromTimeline: boolean
  /** Timeline items whose source file is gone. Blocks the export. */
  missingItems: { index: number; label: string }[]
} {
  const feed = projectAssembly(project)
  const timeline = readTimeline(project.id)

  if (!timeline || timeline.items.length === 0) {
    return {
      ...feed,
      seamOverrideSec: feed.plan.seamSeconds,
      fromTimeline: false,
      missingItems: []
    }
  }

  const segments: AssembleSegment[] = []
  const seams: (number | null)[] = []
  const missingItems: { index: number; label: string }[] = []

  timeline.items.forEach((item, i) => {
    const path =
      item.sourceType === 'still'
        ? item.sourceImageName
          ? imagePath(project.id, item.sourceImageName)
          : null
        : item.sourceClipName
          ? clipPath(project.id, item.sourceClipName)
          : null

    if (!path || !existsSync(path)) {
      // Named precisely (§21): "clip 4 is missing its source video" is
      // actionable; "missing transition clips" sends the operator to a
      // feed that is perfectly fine.
      missingItems.push({ index: i + 1, label: timelineItemLabel(item, i) })
      return
    }

    segments.push(
      item.sourceType === 'still'
        ? {
            kind: 'still',
            path,
            // A still's "source range" IS its hold: splitting one just
            // makes two shorter holds of the same photograph.
            holdSeconds: Math.max(0, item.endOffsetSec - item.startOffsetSec)
          }
        : {
            kind: 'clip',
            path,
            sourceStartSec: item.startOffsetSec,
            sourceEndSec: item.endOffsetSec
          }
    )
    if (i < timeline.items.length - 1) seams.push(item.seamAfterSec)
  })

  return {
    plan: feed.plan,
    segments,
    // Trailing seams are dropped along with any skipped item, so the
    // boundary list always matches segments − 1.
    seamOverrideSec: seams.slice(0, Math.max(0, segments.length - 1)),
    fromTimeline: true,
    missingItems
  }
}

function timelineItemLabel(item: { sourceType: string; sourceId: string }, index: number): string {
  const kind =
    item.sourceType === 'motion-clip'
      ? 'single-image motion'
      : item.sourceType === 'still'
        ? 'still'
        : 'transition'
  return `Timeline clip ${index + 1} (${kind})`
}

export function projectAssembly(project: Project): {
  plan: ReturnType<typeof planAssembly>
  segments: AssembleSegment[]
} {
  const { exportDefaults } = readSettings()
  const analysis = applyImageOverrides(readAnalysis(project.id), listOverrides(project.id))
  /**
   * THE VIDEO IS THE FEED.
   *
   * ── THE BUG THIS FIXES ─────────────────────────────────────────────
   *
   * This enumerated `project.images` — the imported LIBRARY — and
   * therefore planned an export out of pairs the video does not contain.
   * A library-adjacent pair has no stored transition row, so it read as
   * `auto`; where the analysis happened to support a move it then
   * resolved to AI; and having never been generated (it is not in the
   * film) it was reported as a MISSING CLIP.
   *
   * That is what produced "Missing transition clips: 5 → 6, 7 → 8,
   * 9 → 10, …" on a feed the operator had finished: every other library
   * pair that happened to look navigable. The positions in that message
   * were library positions, so they did not even name transitions the
   * video has.
   *
   * Readiness and the assembler both come through this one function, so
   * fixing it here fixes both — and keeps them incapable of disagreeing.
   */
  const imageIds = getFeedImages(project).map((i) => i.id)
  // Operator context is evidence, so the assembler must judge pairs with
  // the same information the prompt was built from.
  const contexts = new Map(
    Object.entries(project.transitions)
      .filter(([, t]) => t?.operatorContext && t.operatorContext.text.trim().length > 0)
      .map(([k, t]) => [k, t!.operatorContext!])
  )
  const plans = planSequence(analysis, imageIds, reviewMap(project.id, 'accepted'), contexts)

  const modes: EffectiveTransitionMode[] = []
  const clipPaths: (string | null)[] = []
  for (let i = 0; i < imageIds.length - 1; i++) {
    const key = transitionKey(imageIds[i], imageIds[i + 1])
    const stored = project.transitions[key]
    const clip = stored?.clip
    modes.push(
      resolveTransitionMode(stored?.mode ?? 'auto', plans[i] ?? null, Boolean(clip)).effectiveMode
    )
    clipPaths.push(clip ? clipPath(project.id, clip.storedName) : null)
  }

  const plan = planAssembly({
    imageIds,
    modes,
    clipPaths,
    // MUST be the same list, in the same order, as `imageIds` — the
    // planner indexes both by position. Built from the library while
    // `imageIds` came from the feed, position N would have named one
    // photograph and shown another.
    imagePaths: getFeedImages(project).map((img) => imagePath(project.id, img.storedName) ?? ''),
    seamBlend: exportDefaults.seamBlend ?? 'subtle',
    motions: motionSegments(project).map((m) => ({
      segmentId: m.id,
      imageId: m.imageId,
      label: motionSegmentLabel(m),
      clipPath: m.clip ? clipPath(project.id, m.clip.storedName) : null
    }))
  })

  return {
    plan,
    // FFmpeg only needs to know whether a segment is a video file or a
    // held photograph. A motion segment is a video file — that it was
    // made from one image rather than two changes nothing downstream.
    segments: plan.segments.map((s) => ({
      kind: s.kind === 'still' ? ('still' as const) : ('clip' as const),
      path: (s.kind === 'still' ? s.imagePath : s.clipPath) ?? '',
      holdSeconds: s.holdSeconds
    }))
  }
}

/**
 * Image pairs that still lack a clip AND actually need one.
 *
 * A cut or a crossfade needs no generated video, so it can never appear
 * here — reporting "27 transitions missing clips" for a project whose
 * transitions are mostly cuts was the old behaviour, and it made a
 * finished project look permanently incomplete.
 */
export function missingClipPairs(project: Project): string[] {
  return projectAssembly(project).plan.missingClipPairs
}

export interface ExportReadiness {
  ready: boolean
  /** Feed positions of AI pairs whose clip is missing. Empty when ready. */
  missingAiClips: string[]
  /** Motion segments on the timeline that were never generated. */
  missingMotionClips: string[]
  /** Pairs that need no clip at all, for an honest "N of M" readout. */
  cutPairs: string[]
  crossfadePairs: string[]
  /** Images in the FEED — what will actually be exported. */
  sequenceLength: number
  reason: string | null
}

/**
 * THE ONE ANSWER TO "CAN THIS PROJECT BE EXPORTED?"
 *
 * ── THE BUG THIS EXISTS FOR ──────────────────────────────────────────
 *
 * The export panel computed its own answer:
 *
 *   for each feed pair: if (!transitions[key]?.clip) missing.push(...)
 *
 * — demanding a generated clip for EVERY pair, never asking what the
 * transition actually is. A cut generates nothing by definition, so on a
 * finished feed every cut was reported as a missing clip and Export
 * stayed disabled. On the real project that produced exactly
 * "5 → 6, 7 → 8, 9 → 10, 11 → 12, 13 → 14": the five pairs that are
 * `auto` with no clip, which is precisely what a cut looks like.
 *
 * Fixing `projectAssembly` did nothing for that message, because the
 * panel never called it. So readiness is published from here, backed by
 * the same `projectAssembly` the exporter runs on — the two cannot
 * disagree, because there is only one of them.
 */
export function exportReadiness(project: Project): ExportReadiness {
  const feedLength = getFeedImages(project).length
  if (feedLength < 2) {
    return {
      ready: false,
      missingAiClips: [],
        missingMotionClips: [],
      cutPairs: [],
      crossfadePairs: [],
      sequenceLength: feedLength,
      reason: 'Add at least two images to the Transition Feed before exporting.'
    }
  }

  // ── READINESS ASKS THE EXPORTER'S QUESTION ────────────────────────
  //
  // Through `exportAssembly`, so it judges what will ACTUALLY be
  // encoded. Reading the feed plan alone meant a timeline referencing a
  // deleted file reported "ready" and then threw at encode time, while a
  // feed clip the operator had already cut out of the film blocked an
  // export that no longer needed it. Both directions were wrong.
  const { plan, fromTimeline, missingItems, segments } = exportAssembly(project)

  if (fromTimeline) {
    return {
      ready: missingItems.length === 0 && segments.length > 0,
      // A timeline export is not blocked by feed pairs it does not use.
      missingAiClips: [],
      missingMotionClips: [],
      cutPairs: plan.cutPairs,
      crossfadePairs: plan.crossfadePairs,
      sequenceLength: feedLength,
      reason:
        missingItems.length > 0
          ? missingItems.map((m) => `${m.label} is missing its source video.`).join(' ')
          : segments.length === 0
            ? 'The timeline is empty — every clip has been removed.'
            : null
    }
  }

  // Export no longer asks a quality verdict. Automatic validation was
  // removed from the product; an attached clip is one the operator chose
  // to keep, and refusing to export their own accepted work would be the
  // worse failure.
  // `plan.ok` already accounts for ungenerated motion segments, so the
  // conjunct below stays exactly as it was and the new case still
  // reaches here — one planner, one verdict.
  const ready = plan.ok && plan.missingClipPairs.length === 0
  return {
    ready,
    missingAiClips: plan.missingClipPairs,
    missingMotionClips: plan.missingMotionSegments,
    cutPairs: plan.cutPairs,
    crossfadePairs: plan.crossfadePairs,
    sequenceLength: feedLength,
    reason:
      plan.missingClipPairs.length > 0
        ? `Missing transition clips: ${plan.missingClipPairs.join(', ')}`
        : (plan.reason ?? null)
  }
}

/**
 * The export runner — resolves everything from the persisted job, so it
 * behaves identically whether the job ran immediately or was picked up on a
 * later launch. Validates AGAIN at run time: clips or projects may have
 * disappeared while the job waited in the queue.
 */
/**
 * COMPARE ASSEMBLY — a development/evaluation tool.
 *
 * Exports the SAME existing clips twice, once with hard cuts and once
 * with seamless blending, so the two can be watched back to back. This is
 * the only honest way to judge whether the seam work is worth having:
 * described in prose it always sounds good, and on screen it either
 * disappears or it looks like a dissolve.
 *
 * NO AI IS INVOLVED. It reuses clips that already exist on disk and the
 * existing FFmpeg pipeline. No provider request is made, nothing is
 * regenerated and nothing is charged — the only cost is local CPU.
 *
 * Refuses to overwrite: existing files are reported back and the caller
 * confirms before anything is replaced.
 */
/**
 * BUILD PREVIEW — the editor's working assembly.
 *
 * Distinct from a customer export on purpose:
 *   customer export  → save dialog, watermark/signature, queued, delivered
 *   editor preview   → managed file, no overlays, immediate, for looking at
 *
 * It exists so the main preview can play the whole property video without
 * the renderer ever being handed a filesystem path. Same clips, same seam
 * setting, no AI generation and no provider request — assembly only.
 *
 * `builtAt` is the file's own mtime, so staleness survives a restart
 * without anything extra being persisted.
 */
export interface EditorPreviewState {
  url: string | null
  builtAt: number | null
  missing: string[]
}

export function editorPreviewState(projectId: string): EditorPreviewState {
  const project = listProjects().find((p) => p.id === projectId)
  const missing = project ? missingClipPairs(project) : []
  try {
    const path = safeManagedPath(exportsDir(projectId), EDITOR_PREVIEW_NAME)
    if (!existsSync(path)) return { url: null, builtAt: null, missing }
    return {
      url: exportUrl(projectId, EDITOR_PREVIEW_NAME),
      builtAt: statSync(path).mtimeMs,
      missing
    }
  } catch {
    return { url: null, builtAt: null, missing }
  }
}

export async function buildEditorPreview(
  projectId: string
): Promise<{ ok: true; url: string; builtAt: number } | { ok: false; reason: string }> {
  const project = listProjects().find((p) => p.id === projectId)
  if (!project) return { ok: false, reason: 'Project no longer exists' }

  // Cuts and crossfades need no clip, so only genuinely missing AI clips
  // can block a preview. THE TIMELINE decides what is in it when one
  // exists, so the preview shows the film the operator is cutting.
  const { plan, segments, seamOverrideSec, missingItems } = exportAssembly(project)
  if (missingItems.length > 0) {
    return {
      ok: false,
      reason: missingItems.map((m) => `${m.label} is missing its source video.`).join(' ')
    }
  }
  if (!plan.ok) {
    return {
      ok: false,
      reason: `Missing transition clips: ${plan.missingClipPairs.join(', ')}. Build Preview only assembles clips that already exist — it never generates.`
    }
  }
  if (segments.length === 0) return { ok: false, reason: 'Nothing to assemble yet' }
  if (segments.some((s) => !s.path)) {
    return { ok: false, reason: 'An assembly segment is missing its file on disk' }
  }

  const dir = exportsDir(projectId)
  mkdirSync(dir, { recursive: true })
  const outputPath = safeManagedPath(dir, EDITOR_PREVIEW_NAME)
  const defaults = readSettings().exportDefaults

  await assemble({
    clipPaths: [],
    segments,
    // The TIMELINE's seams when it decided the segments, else the
    // feed plan’s — they always describe the same boundaries.
    seamOverrideSec,
    defaults,
    // No overlays: this is for looking at while editing, not for sending.
    // The watermark belongs to the customer preview export.
    overlayPngPaths: [],
    outputPath,
    seamBlend: defaults.seamBlend ?? 'subtle'
  }).done

  return {
    ok: true,
    url: exportUrl(projectId, EDITOR_PREVIEW_NAME),
    builtAt: statSync(outputPath).mtimeMs
  }
}

export async function compareAssembly(
  projectId: string,
  outputDir: string,
  options: { overwrite?: boolean; onProgress?: (pct: number) => void } = {}
): Promise<CompareAssemblyResult> {
  const project = listProjects().find((p) => p.id === projectId)
  if (!project) return { ok: false, reason: 'Project no longer exists' }

  const missing = missingClipPairs(project)
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Missing transition clips: ${missing.join(', ')}. Compare Assembly never generates — it only re-assembles clips that already exist.`
    }
  }

  // ── COMPARE ASSEMBLY STAYS ABOUT SEAMS ───────────────────────────────
  //
  // This tool exists to judge whether seam blending between two GENERATED
  // clips is worth having. Deliberately restricted to the clip segments,
  // because comparing a timeline that also contains cuts and held stills
  // would answer a different question than the one being asked.
  const clipPaths = projectAssembly(project)
    .segments.filter((s) => s.kind === 'clip')
    .map((s) => s.path)
  if (clipPaths.length < 2) {
    return {
      ok: false,
      reason:
        'Comparing assembly needs at least two generated clips — a single clip has no seam, and cuts have nothing to blend.'
    }
  }

  const stem = sanitizeFileName(project.name)
  const hardCutsPath = join(outputDir, `${stem}_hard-cuts.mp4`)
  const seamlessPath = join(outputDir, `${stem}_seamless.mp4`)

  const clashes = [hardCutsPath, seamlessPath].filter((p) => existsSync(p))
  if (clashes.length > 0 && !options.overwrite) {
    return { ok: false, wouldOverwrite: clashes, reason: 'Files already exist' }
  }

  const defaults = readSettings().exportDefaults
  // Overlays are deliberately omitted: the point of the comparison is the
  // seam, and a watermark over both would only make them harder to judge.
  await assemble({
    clipPaths,
    defaults,
    overlayPngPaths: [],
    outputPath: hardCutsPath,
    seamBlend: 'off',
    onProgress: (pct) => options.onProgress?.(Math.round(pct / 2))
  }).done

  await assemble({
    clipPaths,
    defaults,
    overlayPngPaths: [],
    outputPath: seamlessPath,
    // The project's configured blend, so what is compared is what would
    // actually ship — not a hardcoded demo value.
    seamBlend: defaults.seamBlend ?? 'subtle',
    onProgress: (pct) => options.onProgress?.(50 + Math.round(pct / 2))
  }).done

  return { ok: true, hardCutsPath, seamlessPath }
}

const runExportJob = async (
  job: QueueJob,
  ctx: { onProgress: (pct: number) => void; registerHandle: (h: ReturnType<typeof assemble>) => void }
): Promise<{ outputPath?: string }> => {
  const project = listProjects().find((p) => p.id === job.projectId)
  if (!project) throw new Error('Project no longer exists')

  const outputPath = job.metadata.outputPath
  if (!outputPath) throw new Error('Job is missing its output destination')

  // The mixed timeline: AI clips where they exist, cuts and crossfades
  // where the evidence or the operator chose them, and a held still only
  // where an image would otherwise never reach the screen.
  const { plan, segments, seamOverrideSec, missingItems, fromTimeline } = exportAssembly(project)
  if (missingItems.length > 0) {
    throw new Error(missingItems.map((m) => `${m.label} is missing its source video.`).join(' '))
  }
  // ── THE FEED PLAN DOES NOT GATE A TIMELINE EXPORT ─────────────────
  //
  // `plan.ok` is a statement about the FEED: does every pair that needs
  // a clip have one. With a timeline that is the wrong question — the
  // operator may have deleted the very segment whose clip is missing,
  // and refusing to export a film that no longer contains it would be
  // refusing on behalf of a plan nobody is following. The timeline's own
  // sources are checked above, which is the question that matters.
  if (!fromTimeline && !plan.ok) throw new Error(plan.reason ?? 'Nothing to assemble')
  if (segments.length === 0) throw new Error('Nothing to assemble')
  for (const s of segments) {
    if (!s.path) throw new Error('An assembly segment is missing its file on disk')
  }

  const overlayPngPaths = (job.metadata.overlayFiles ?? [])
    .map((name) => safeManagedPath(exportsDir(project.id), name))
    .filter((p) => existsSync(p))

  // THE FORMAT IS THE JOB'S, NOT THE PROJECT'S. Chosen when the export
  // was started and carried on the job, so a queued export renders the
  // shape it was queued for even if the setting changes meanwhile — the
  // same reason its price is snapshotted.
  const { defaults: formatDefaults, fit, padColor } = applyExportFormat(
    readSettings().exportDefaults,
    job.metadata.exportFormat as ExportFormatId | undefined
  )

  try {
    const handle = assemble({
      clipPaths: [],
      segments,
      // The TIMELINE's seams when it decided the segments, else the
      // feed plan's — they always describe the same boundaries.
      seamOverrideSec,
      defaults: formatDefaults,
      fit,
      padColor,
      overlayPngPaths,
      outputPath,
      onProgress: ctx.onProgress
    })
    ctx.registerHandle(handle)
    await handle.done
    return { outputPath }
  } finally {
    // Managed overlay files exist only for the lifetime of the job.
    for (const name of job.metadata.overlayFiles ?? []) {
      try {
        rmSync(safeManagedPath(exportsDir(project.id), name), { force: true })
      } catch {
        /* best effort */
      }
    }
  }
}

registerRunner('preview-export', runExportJob)
registerRunner('final-export', runExportJob)
registerRunner('assembly', runExportJob)

/**
 * WHAT THE QUEUE JOB CARRIES ABOUT AN EXPORT.
 *
 * ── THE BUG THIS EXISTS TO PREVENT ───────────────────────────────────
 *
 * `JobMetadata` declared `exportFormat`, `runExportJob` read it, and the
 * object literal that created the job simply did not set it. Every real
 * export therefore ran as the default format: "Export Instagram Reel"
 * wrote a landscape 1920x1080 file, which Instagram showed letterboxed
 * inside a portrait slot.
 *
 * Nothing caught it. The field was optional, so TypeScript was content;
 * the geometry proof called `assemble()` directly with the right
 * arguments, so it was testing the layer below the fault.
 *
 * A named constructor is what a test can pin. An inline literal is not.
 */
export function exportJobMetadata(
  kind: ExportKind,
  outputPath: string,
  overlayFiles: string[],
  format: ExportFormatId | undefined
): JobMetadata {
  return { exportKind: kind, outputPath, overlayFiles, exportFormat: format }
}

/** Test seam: the metadata a real export of this format would queue. */
export function exportJobMetadataForTests(format: ExportFormatId): JobMetadata {
  return exportJobMetadata('final', 'C:/out.mp4', [], format)
}

export async function startExport(
  projectId: string,
  kind: ExportKind,
  overlays: ExportOverlays,
  scheduledFor?: number | null,
  format?: ExportFormatId
): Promise<ExportStartResult> {
  const project = listProjects().find((p) => p.id === projectId)
  if (!project) return { ok: false, missing: [], reason: 'Project not found' }
  // The FEED is what gets exported, so it is the feed that must have two.
  if (getFeedImages(project).length < 2) {
    return {
      ok: false,
      missing: [],
      reason: 'Add at least two images to the Transition Feed before exporting.'
    }
  }

  // Sequence validation — assembly must never silently skip a gap.
  const missing = missingClipPairs(project)
  if (missing.length > 0) {
    return { ok: false, missing, reason: 'Missing transition clips' }
  }

  // Explicit user destination via the native save dialog.
  const isReel = format === 'instagram'
  const defaultName = `${sanitizeFileName(project.name)}_${isReel ? 'instagram_reel' : 'video'}.mp4`
  // ── THE ONLY THING A TEST MAY REPLACE IS THE FILE PICKER ─────────
  //
  // Set F2F_EXPORT_DEST and the native save dialog is skipped; every
  // other step — rasterisation, IPC, this function, the queue job, the
  // assembly and FFmpeg — runs exactly as it does for a click. It exists
  // because a native dialog cannot be driven from a test, and because
  // the last round of "proof" tested a path the product does not use.
  // Environment only: nothing in the UI can reach it.
  const forcedDest = process.env.F2F_EXPORT_DEST
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const save = forcedDest
    ? { canceled: false, filePath: join(forcedDest, defaultName) }
    : await dialog.showSaveDialog(win, {
    title: isReel ? 'Export Instagram Reel (1080×1920)' : 'Export Video',
    defaultPath: join(app.getPath('videos'), defaultName),
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }]
      })
  if (save.canceled || !save.filePath) return { ok: false, canceled: true }

  // Overlays live in the MANAGED export dir so the job survives a restart.
  const dir = exportsDir(project.id)
  mkdirSync(dir, { recursive: true })
  const prefix = randomUUID()
  const overlayFiles: string[] = []
  // Watermark under the signature: watermark first, signature last on top.
  // ── WHAT ARRIVES IS WHAT IS COMPOSITED ────────────────────────────
  //
  // This used to read `kind === 'preview' && overlays.watermarkPng` — a
  // second rule about whether the watermark appears, sitting behind the
  // one the operator actually sets. A "final" export could not carry a
  // watermark however it was configured, and a "preview" export always
  // did. Two authorities for one question.
  //
  // Inclusion is now decided once, by the export's own branding
  // checkboxes, and expressed by whether a PNG was rasterised at all.
  // Saved Branding Settings still decide WHICH asset, where, how big and
  // how opaque; this decides only whether it is in THIS file.
  if (overlays.watermarkPng) {
    const name = `${prefix}-watermark.png`
    writeFileSync(safeManagedPath(dir, name), Buffer.from(overlays.watermarkPng))
    overlayFiles.push(name)
  }
  if (overlays.signaturePng) {
    const name = `${prefix}-signature.png`
    writeFileSync(safeManagedPath(dir, name), Buffer.from(overlays.signaturePng))
    overlayFiles.push(name)
  }

  // Customer price is SNAPSHOTTED here, when the job is created — later
  // Settings changes never rewrite what queued/completed work was worth.
  const job = enqueue({
    projectId: project.id,
    projectName: project.name,
    kind: kind === 'preview' ? 'preview-export' : 'final-export',
    // Transitions come from the FEED — that is how many the video has.
    transitionCount: Math.max(0, getFeedImages(project).length - 1),
    // The CUSTOMER price is per IMPORTED image and is deliberately
    // unrelated to how many made the final cut.
    price: priceSnapshot(project.images.length, readSettings().pricing),
    scheduledFor,
    // ── THE FORMAT TRAVELS WITH THE JOB ────────────────────────────
    //
    // THE BUG THIS FIXES. `JobMetadata` declared `exportFormat` and
    // `runExportJob` read it — but this line never wrote it. Every real
    // export therefore rendered with `exportFormat: undefined`, which
    // resolves to the first entry in the list: the desktop format, in
    // the project's own aspect ratio. "Export Instagram Reel" produced a
    // landscape 1920x1080 file, and Instagram showed that letterboxed
    // inside a portrait slot — the reported screenshot exactly.
    //
    // It survived a passing proof because the proof called assemble()
    // directly with the right arguments. It was testing the layer BELOW
    // the fault.
    metadata: exportJobMetadata(kind, save.filePath, overlayFiles, format)
  })

  return { ok: true, jobId: job.id }
}
