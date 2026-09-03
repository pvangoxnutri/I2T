import {
  applyExportFormat,
  DEFAULT_EXPORT_FORMAT,
  type ExportFormatId
} from '../../shared/exportFormat'
import { getFeedImages } from '../../shared/feedSequence'
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
  const plans = planSequence(analysis, imageIds, reviewMap(project.id, 'accepted'))

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
    seamBlend: exportDefaults.seamBlend ?? 'subtle'
  })

  return {
    plan,
    segments: plan.segments.map((s) => ({
      kind: s.kind,
      path: (s.kind === 'clip' ? s.clipPath : s.imagePath) ?? '',
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
      cutPairs: [],
      crossfadePairs: [],
      sequenceLength: feedLength,
      reason: 'Add at least two images to the Transition Feed before exporting.'
    }
  }

  const { plan } = projectAssembly(project)
  return {
    ready: plan.ok && plan.missingClipPairs.length === 0,
    missingAiClips: plan.missingClipPairs,
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
  // can block a preview.
  const { plan, segments } = projectAssembly(project)
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
    seamOverrideSec: plan.seamSeconds,
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
  const { plan, segments } = projectAssembly(project)
  if (!plan.ok) throw new Error(plan.reason ?? 'Nothing to assemble')
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
  const { defaults: formatDefaults, fit } = applyExportFormat(
    readSettings().exportDefaults,
    job.metadata.exportFormat as ExportFormatId | undefined
  )

  try {
    const handle = assemble({
      clipPaths: [],
      segments,
      seamOverrideSec: plan.seamSeconds,
      defaults: formatDefaults,
      fit,
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
  const defaultName = `${sanitizeFileName(project.name)}_${kind}.mp4`
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const save = await dialog.showSaveDialog(win, {
    title: kind === 'preview' ? 'Export Preview with Watermark' : 'Export Final',
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
  if (kind === 'preview' && overlays.watermarkPng) {
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
    metadata: { exportKind: kind, outputPath: save.filePath, overlayFiles }
  })

  return { ok: true, jobId: job.id }
}
