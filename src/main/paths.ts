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

/**
 * The user's data directory is PINNED, not inherited.
 *
 * Electron derives userData from the application's name, which on Windows
 * comes from `productName` when packaged and from `name` when run from
 * source. Two consequences, both bad, and both invisible until someone
 * loses work:
 *
 *  - Renaming the product for release MOVES every existing customer's
 *    database and imported photographs to a directory the app no longer
 *    looks in. The data is still on disk; the app simply reports an empty
 *    library.
 *  - Running from source and running the installed .exe would otherwise
 *    read two DIFFERENT databases, so a bug reproduced in development is
 *    not the bug the customer has.
 *
 * The directory name is therefore a fixed identifier that the display
 * name cannot disturb. It is deliberately the historical one: changing it
 * is a data migration, not a rename.
 */
const USER_DATA_DIR_NAME = 'FrameToFrame'

/**
 * Must be called before anything reads a path — and before app ready,
 * since Electron caches its own userData location on first access.
 */
export function pinUserDataDir(): void {
  // ── AN EXPLICIT --user-data-dir STILL WINS ─────────────────────────
  //
  // Pinning is here to stop the directory moving when the PRODUCT NAME
  // changes. It is not here to override an operator who said where to
  // look, and overriding them breaks the one mechanism that makes
  // working on a copy of a real database possible.
  //
  // That is not hypothetical: the first version of this pin was
  // unconditional, and the next audit run — launched with
  // `--user-data-dir=<copy>` precisely so it could not touch anything —
  // wrote to the real database instead. Electron had already applied the
  // switch; this overwrote it.
  if (process.argv.some((a) => a === '--user-data-dir' || a.startsWith('--user-data-dir='))) return

  // ── A TEST RUN NEVER OPENS THE OPERATOR'S DATABASE ─────────────────
  //
  // THE HAZARD THIS CLOSES. The database is sql.js: the whole file is
  // read into memory on open and the WHOLE file is written back on every
  // flush — including one immediately at open. So any process that
  // loaded the database before someone else changed it will, on its next
  // write, replace the file with its own older snapshot. Last writer
  // wins, wholesale, and nothing warns.
  //
  // That is how deleted fixture rows kept reappearing: a smoke run held
  // a snapshot taken before a cleanup and wrote it back afterwards. The
  // rows were not recreated — an old copy of the file was restored over
  // the new one.
  //
  // The suite and the proofs create projects, accept analyses and purge
  // rows. None of that belongs in the operator's data, and the cheapest
  // guarantee is that they cannot reach it: a fresh directory per run,
  // thrown away with the temp folder. An explicit --user-data-dir still
  // wins above, which is how a proof is pointed at a COPY on purpose.
  const sandboxed = ['--f2f-smoke', '--f2f-export-proof', '--f2f-reanalyse-proof']
  if (process.argv.some((a) => sandboxed.includes(a))) {
    const dir = join(app.getPath('temp'), `f2f-test-${process.pid}-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    app.setPath('userData', dir)
    return
  }

  app.setPath('userData', join(app.getPath('appData'), USER_DATA_DIR_NAME))
}

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
