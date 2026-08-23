import { app } from 'electron'
import { join, resolve, sep } from 'node:path'
import { mkdirSync } from 'node:fs'

/**
 * Every disk location FrameToFrame owns, derived from Electron's per-user
 * application data directory — never a hardcoded OS path.
 *
 *   <userData>/frametoframe.db                      the SQLite database
 *   <userData>/projects/<project-id>/images/…       imported originals
 */

export function userDataDir(): string {
  return app.getPath('userData')
}

export function databaseFile(): string {
  return join(userDataDir(), 'frametoframe.db')
}

export function projectsRoot(): string {
  return join(userDataDir(), 'projects')
}

export function projectDir(projectId: string): string {
  return safeManagedPath(projectsRoot(), projectId)
}

export function projectImagesDir(projectId: string): string {
  return join(projectDir(projectId), 'images')
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

/**
 * Joins segments under a managed root and REFUSES any result that escapes
 * it. This is the single guard that makes deletion/serving safe: no
 * `..`, absolute-path or drive tricks can ever reach outside the
 * FrameToFrame-managed directory.
 */
export function safeManagedPath(root: string, ...segments: string[]): string {
  const target = resolve(root, ...segments)
  const normalizedRoot = resolve(root)
  if (target !== normalizedRoot && !target.startsWith(normalizedRoot + sep)) {
    throw new Error(`Refusing path outside managed root: ${segments.join('/')}`)
  }
  return target
}
