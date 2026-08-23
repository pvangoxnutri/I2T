import { copyFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProjectImage, TransitionClip } from '../shared/types'
import { ensureDir, projectDir, projectImagesDir, projectsRoot, safeManagedPath } from './paths'

/**
 * Managed project files. Imported originals are COPIED into
 * <userData>/projects/<project-id>/images/ under a unique safe name; only
 * that stored name + the original display name go into SQLite. Everything
 * here goes through safeManagedPath, so no operation — especially deletion —
 * can ever touch a path outside the FrameToFrame-managed directory.
 */

export const IMAGE_PROTOCOL = 'f2f'

export function imageUrl(projectId: string, storedName: string): string {
  return `${IMAGE_PROTOCOL}://image/${encodeURIComponent(projectId)}/${encodeURIComponent(storedName)}`
}

export function clipUrl(projectId: string, storedName: string): string {
  return `${IMAGE_PROTOCOL}://clip/${encodeURIComponent(projectId)}/${encodeURIComponent(storedName)}`
}

/**
 * The editor's working preview — a MANAGED file, unlike a customer export.
 *
 * Customer exports go wherever the operator picks in a save dialog, which
 * is outside the managed root and therefore not servable over f2f://.
 * Widening the protocol to reach arbitrary paths would hand the renderer
 * the filesystem, so the editor builds its own copy inside the project
 * instead. Same FFmpeg pipeline, same clips, same seam setting.
 */
export const EDITOR_PREVIEW_NAME = 'editor-preview.mp4'

export function projectExportsDir(projectId: string): string {
  return join(projectDir(projectId), 'exports')
}

export function exportUrl(projectId: string, storedName: string): string {
  return `${IMAGE_PROTOCOL}://export/${encodeURIComponent(projectId)}/${encodeURIComponent(storedName)}`
}

/** Maps the f2f:// host to the managed subdirectory it serves. */
const PROTOCOL_DIRS: Record<string, string> = {
  image: 'images',
  clip: 'transitions',
  export: 'exports'
}

/** Resolves an f2f://image/... or f2f://clip/... request to a managed path,
 * or null. */
export function resolveImageRequest(url: string): string | null {
  try {
    const parsed = new URL(url)
    // With a standard scheme, "image"/"clip" parses as the host.
    const subdir = PROTOCOL_DIRS[parsed.host]
    if (!subdir) return null
    const [projectId, storedName] = parsed.pathname
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent)
    if (!projectId || !storedName) return null
    const path = safeManagedPath(projectsRoot(), projectId, subdir, storedName)
    return existsSync(path) ? path : null
  } catch {
    return null
  }
}

export function projectTransitionsDir(projectId: string): string {
  return join(projectDir(projectId), 'transitions')
}

/**
 * The absolute path of a managed clip, or null when it is not on disk.
 *
 * The caller supplies a project id and a STORED name — never a path — and
 * safeManagedPath refuses anything that would escape the managed root. This
 * is the only way "reveal this clip in Explorer" reaches the filesystem.
 */
export function resolveClipPath(projectId: string, storedName: string): string | null {
  try {
    const path = safeManagedPath(projectsRoot(), projectId, 'transitions', storedName)
    return existsSync(path) ? path : null
  } catch {
    return null
  }
}

const SAFE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif'])

function storedNameFor(originalName: string): string {
  const ext = extname(originalName).toLowerCase()
  return `${randomUUID()}${SAFE_EXTENSIONS.has(ext) ? ext : '.img'}`
}

export interface ImportItem {
  /** Absolute source path when the OS gave us one (normal case). */
  sourcePath?: string
  /** Raw bytes fallback when no path is available. */
  bytes?: ArrayBuffer
  name: string
}

/** Copies picked/dropped files into the project's managed images dir. */
export function importImages(projectId: string, items: ImportItem[]): ProjectImage[] {
  const dir = projectImagesDir(projectId)
  ensureDir(dir)

  const imported: ProjectImage[] = []
  for (const item of items) {
    const storedName = storedNameFor(item.name)
    const target = safeManagedPath(dir, storedName)
    try {
      if (item.sourcePath) {
        copyFileSync(item.sourcePath, target)
      } else if (item.bytes) {
        writeFileSync(target, Buffer.from(item.bytes))
      } else {
        continue
      }
      imported.push({
        id: randomUUID(),
        fileName: item.name,
        storedName,
        src: imageUrl(projectId, storedName)
      })
    } catch (err) {
      // One unreadable file must not sink the whole import batch.
      console.error(`[files] failed to import ${item.name}:`, err)
    }
  }
  return imported
}

const SAFE_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv'])

/**
 * Copies a local video into the project's managed transitions directory and
 * returns the clip record. Used by the manual test-clip import today; the
 * Kling service later produces clips through this same shape.
 */
export function attachClipFromPath(
  projectId: string,
  sourcePath: string,
  source: TransitionClip['source'] = 'manual'
): TransitionClip {
  const dir = projectTransitionsDir(projectId)
  ensureDir(dir)
  const originalName = basename(sourcePath)
  const ext = extname(originalName).toLowerCase()
  const storedName = `${randomUUID()}${SAFE_VIDEO_EXTENSIONS.has(ext) ? ext : '.mp4'}`
  const target = safeManagedPath(dir, storedName)
  copyFileSync(sourcePath, target)
  return { storedName, originalName, source, src: clipUrl(projectId, storedName) }
}

/** Removes one managed transition clip file. Missing files are fine. */
export function removeClipFile(projectId: string, storedName: string): void {
  try {
    const path = safeManagedPath(projectTransitionsDir(projectId), storedName)
    rmSync(path, { force: true })
  } catch (err) {
    console.error(`[files] failed to remove clip ${storedName}:`, err)
  }
}

/** Absolute path of a managed clip, or null if it does not exist. */
export function clipPath(projectId: string, storedName: string): string | null {
  try {
    const path = safeManagedPath(projectTransitionsDir(projectId), storedName)
    return existsSync(path) ? path : null
  } catch {
    return null
  }
}

/**
 * Absolute path of a managed IMAGE, or null if it does not exist.
 *
 * Mirrors `clipPath`. Needed because a sequence containing cuts can put a
 * still photograph directly into the assembled video, so FFmpeg needs its
 * real path — still resolved through `safeManagedPath`, so it can only
 * ever name a file inside this project's own managed directory.
 */
export function imagePath(projectId: string, storedName: string): string | null {
  try {
    const path = safeManagedPath(projectImagesDir(projectId), storedName)
    return existsSync(path) ? path : null
  } catch {
    return null
  }
}

/** Removes one managed image file. Missing files are fine. */
export function removeImageFile(projectId: string, storedName: string): void {
  try {
    const path = safeManagedPath(projectImagesDir(projectId), storedName)
    rmSync(path, { force: true })
  } catch (err) {
    console.error(`[files] failed to remove image ${storedName}:`, err)
  }
}

/** Deletes the project's ENTIRE managed directory — and nothing else. */
export function deleteProjectFiles(projectId: string): void {
  try {
    const dir = projectDir(projectId) // safeManagedPath inside
    rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    // A locked file must not block DB deletion; the orphan dir is harmless
    // and can be cleaned up on a later delete attempt.
    console.error(`[files] failed to delete project dir ${projectId}:`, err)
  }
}
