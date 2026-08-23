import { app, BrowserWindow, dialog } from 'electron'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { transitionKey, type ExportDefaults, type Project, type QueueJob } from '../../shared/types'
import type { CompareAssemblyResult } from '../../shared/seamBlend'
import { DEFAULT_PRICING, priceSnapshot } from '../../shared/pricing'
import { listProjects, getSettingsJson } from '../db/projectsRepo'
import { clipPath, EDITOR_PREVIEW_NAME, exportUrl } from '../files'
import { projectDir, safeManagedPath } from '../paths'
import { assemble } from './ffmpegService'
import { enqueue, registerRunner } from './queueService'

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

/** Human list of image pairs that still lack a clip, e.g. ["2 → 3"]. */
export function missingClipPairs(project: Project): string[] {
  const missing: string[] = []
  for (let i = 0; i < project.images.length - 1; i++) {
    const key = transitionKey(project.images[i].id, project.images[i + 1].id)
    const clip = project.transitions[key]?.clip
    const exists = clip ? clipPath(project.id, clip.storedName) !== null : false
    if (!exists) missing.push(`${i + 1} → ${i + 2}`)
  }
  return missing
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

  const missing = missingClipPairs(project)
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Missing transition clips: ${missing.join(', ')}. Build Preview only assembles clips that already exist — it never generates.`
    }
  }

  const clipPaths = project.images.slice(0, -1).map((image, i) => {
    const key = transitionKey(image.id, project.images[i + 1].id)
    const stored = project.transitions[key]?.clip?.storedName
    const path = stored ? clipPath(project.id, stored) : null
    if (!path) throw new Error(`Transition clip ${i + 1} → ${i + 2} is missing on disk`)
    return path
  })
  if (clipPaths.length === 0) return { ok: false, reason: 'Nothing to assemble yet' }

  const dir = exportsDir(projectId)
  mkdirSync(dir, { recursive: true })
  const outputPath = safeManagedPath(dir, EDITOR_PREVIEW_NAME)
  const defaults = readSettings().exportDefaults

  await assemble({
    clipPaths,
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

  const clipPaths = project.images.slice(0, -1).map((image, i) => {
    const key = transitionKey(image.id, project.images[i + 1].id)
    const stored = project.transitions[key]?.clip?.storedName
    const path = stored ? clipPath(project.id, stored) : null
    if (!path) throw new Error(`Transition clip ${i + 1} → ${i + 2} is missing on disk`)
    return path
  })
  if (clipPaths.length < 2) {
    return {
      ok: false,
      reason: 'Comparing assembly needs at least two clips — a single clip has no seam.'
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

  const missing = missingClipPairs(project)
  if (missing.length > 0) throw new Error(`Missing transition clips: ${missing.join(', ')}`)

  const clipPaths = project.images.slice(0, -1).map((image, i) => {
    const key = transitionKey(image.id, project.images[i + 1].id)
    const path = clipPath(project.id, project.transitions[key]!.clip!.storedName)
    if (!path) throw new Error(`Transition clip ${i + 1} → ${i + 2} is missing on disk`)
    return path
  })

  const overlayPngPaths = (job.metadata.overlayFiles ?? [])
    .map((name) => safeManagedPath(exportsDir(project.id), name))
    .filter((p) => existsSync(p))

  try {
    const handle = assemble({
      clipPaths,
      defaults: readSettings().exportDefaults,
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
  scheduledFor?: number | null
): Promise<ExportStartResult> {
  const project = listProjects().find((p) => p.id === projectId)
  if (!project) return { ok: false, missing: [], reason: 'Project not found' }
  if (project.images.length < 2) {
    return { ok: false, missing: [], reason: 'At least two images are required' }
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
    transitionCount: Math.max(0, project.images.length - 1),
    price: priceSnapshot(project.images.length, readSettings().pricing),
    scheduledFor,
    metadata: { exportKind: kind, outputPath: save.filePath, overlayFiles }
  })

  return { ok: true, jobId: job.id }
}
