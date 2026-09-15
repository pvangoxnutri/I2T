import { app, BrowserWindow, net, protocol, shell } from 'electron'
import { createReadStream, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { openDatabase, flushNow } from './db/index'
import { registerIpc } from './ipc'
import { IMAGE_PROTOCOL, resolveImageRequest } from './files'
import { initQueue, stopQueue } from './services/queueService'
// Importing these registers their job runners with the queue.
import './services/exportService'
import './services/generationService'
import './services/motionGenerationService'
import { reconcileMotionSegments } from './services/motionGenerationService'
import { runSmokeTest } from './smoke'
import { runDbDiagnostics } from './dbDiagnostics'
import { cleanSmokeOrphans } from './orphanCleanup'
import { runUiProbe } from './uiProbe'
import { pinUserDataDir } from './paths'
import { runReanalyseProof } from './reanalyseProof'
import { runExportProof } from './exportProof'
import { runRealExportProof } from './realExportProof'
import { repairRetiredPromptOntology } from './services/promptOntologyRepair'

/**
 * FrameToFrame — Electron main process.
 *
 * Owns everything privileged: the SQLite database (src/main/db), the
 * managed project files on disk (src/main/files), and the custom f2f://
 * protocol that serves imported images to the renderer. Future seams:
 * FFmpeg (src/main/ffmpeg/), AI providers (src/main/providers/), the job
 * queue/scheduler (src/main/queue/).
 */

/** Content types for what the managed protocol can serve. A video without
 *  one is at the browser's mercy about whether it plays at all. */
const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
}

function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

// ── THE DATA DIRECTORY, BEFORE ANYTHING READS A PATH ─────────────────
//
// `pinUserDataDir` existed, was documented as required, and was called
// from nowhere. The consequence is the one its own comment predicts:
// Electron derives userData from the product name, the product was
// renamed to "Image 2 Transition", and the app started reading
// %APPDATA%/Image 2 Transition — an empty database — while the
// operator's 37 images, 84 transitions and 10 stored prompts sat in
// %APPDATA%/FrameToFrame. The library came up empty with nothing lost
// and nothing said.
//
// Measured, both present on this machine right now:
//   FrameToFrame        1,515,520 bytes  1 project, 37 images
//   Image 2 Transition    737,280 bytes  0 projects, 0 images
//
// Must precede app ready — Electron caches its userData location the
// first time anything asks for it.
pinUserDataDir()

// Must run before app ready: gives f2f:// standard-URL semantics.
protocol.registerSchemesAsPrivileged([
  { scheme: IMAGE_PROTOCOL, privileges: { standard: true, secure: true, stream: true } }
])

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    // Matches the app background so the window never flashes white.
    backgroundColor: '#101214',
    title: 'FrameToFrame',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.on('ready-to-show', () => win.show())

  // External links (e.g. the brand website field) open in the OS browser,
  // never inside the app shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * ── WHY THERE IS NO SINGLE-INSTANCE LOCK HERE ──────────────────────
 *
 * There was one, briefly, and it made the app unstartable.
 *
 * On Windows Electron's lock is a file in userData. A process killed
 * hard — a crash, Task Manager, a CI teardown — never removes it, and
 * every launch afterwards gets `false` from
 * `requestSingleInstanceLock()` and exits silently. Observed here: one
 * force-kill left a zero-byte `lockfile` behind and the next four
 * launches did nothing at all, with no window and no output.
 *
 * A database that two processes can clobber is a real hazard, but an
 * app that will not start is a worse one. The guard that remains is the
 * narrow one that matters: a maintenance command that WRITES refuses
 * while another process has the database open, decided by a heartbeat
 * that goes stale on its own — see db/owner.ts.
 */

app.whenReady().then(async () => {
  await openDatabase()

  // Serves managed project images AND generated transition clips.
  // resolveImageRequest refuses anything outside the managed projects
  // directory, so this stays a read-only window onto our own files.
  protocol.handle(IMAGE_PROTOCOL, async (request) => {
    const path = resolveImageRequest(request.url)
    if (!path) return new Response('Not found', { status: 404 })

    // RANGE REQUESTS — required by <video>, irrelevant to <img>.
    //
    // Chromium asks a media element's source for byte ranges. Answering a
    // plain 200 makes it load the whole file with no seeking, and a
    // multi-megabyte generated transition then scrubs badly or sits blank.
    // Images never send a Range header, so they keep the simple path below.
    const range = request.headers.get('range')
    if (range) {
      const size = statSync(path).size
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
      if (match && (match[1] || match[2])) {
        const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
        const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
        if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < size) {
          return new Response(
            Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream,
            {
              status: 206,
              headers: {
                'Content-Range': `bytes ${start}-${end}/${size}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': String(end - start + 1),
                'Content-Type': contentTypeFor(path)
              }
            }
          )
        }
      }
      return new Response('Range not satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` }
      })
    }

    const res = await net.fetch(pathToFileURL(path).toString())
    // Advertise range support so the player knows it may seek at all.
    const headers = new Headers(res.headers)
    headers.set('Accept-Ranges', 'bytes')
    headers.set('Content-Type', contentTypeFor(path))
    return new Response(res.body, { status: res.status, headers })
  })

  registerIpc()

  // READ-ONLY database forensics: `electron . --f2f-dbdiag`.
  //
  // Runs on the connection openDatabase() built, after the real
  // migrations, because several of the things it inspects are
  // per-connection rather than stored in the file — an external script
  // would report its own state and call it the app's. Writes nothing, so
  // it deliberately does NOT flush on the way out.
  if (process.argv.includes('--f2f-dbdiag')) {
    runDbDiagnostics()
    app.exit(0)
    return
  }

  // Historical orphan cleanup: `electron . --f2f-orphan-cleanup [--confirm]`.
  //
  // DRY RUN unless --confirm is passed. Removes only rows belonging to
  // proven smoke-owned project ids; anything else — including the remains
  // of a project the operator deleted — is reported and left alone.
  if (process.argv.includes('--f2f-orphan-cleanup')) {
    let code = 0
    try {
      cleanSmokeOrphans(!process.argv.includes('--confirm'))
    } catch (err) {
      console.error('[cleanup] FAILED:', err)
      code = 1
    }
    app.exit(code)
    return
  }

  // Prompt-contract repair: `electron . --f2f-prompt-repair [--confirm]`.
  //
  // DRY RUN unless --confirm is passed, because this rewrites stored
  // prompts — work the operator may have planned and paid to plan.
  // Hand-edited prompts are reported and never rewritten.
  //
  // Pair it with --user-data-dir to audit a COPY of the real database:
  //   electron . --f2f-prompt-repair --user-data-dir=<copy>
  // Electron's own switch is the thing that moves userData; setting
  // APPDATA or an app-specific env var does NOT, and an audit run that
  // way hits the real database while reporting that it did not.
  if (process.argv.includes('--f2f-prompt-repair')) {
    let code = 0
    try {
      repairRetiredPromptOntology(undefined, !process.argv.includes('--confirm'))
    } catch (err) {
      console.error('[prompt-ontology] FAILED:', err)
      code = 1
    }
    flushNow()
    app.exit(code)
    return
  }

  // Re-analyse consistency proof: `electron . --f2f-reanalyse-proof`.
  //
  // Runs the real Re-analyse workflow with a canned analyzer response —
  // no network, no key, no spend — and reports whether the prompt it
  // leaves behind is the canonical one. It WRITES, so point it at a copy
  // with --user-data-dir.
  if (process.argv.includes('--f2f-reanalyse-proof')) {
    let code = 0
    try {
      code = await runReanalyseProof()
    } catch (err) {
      console.error('[reanalyse-proof] FAILED:', err)
      code = 1
    }
    flushNow()
    app.exit(code)
    return
  }

  // Export geometry proof: `electron . --f2f-export-proof`.
  //
  // Encodes a real clip through the real assemble() at both formats and
  // reads the pixels back. Local files only; writes to a temp directory
  // and touches nothing in the project.
  if (process.argv.includes('--f2f-export-proof')) {
    let code = 0
    try {
      code = await runExportProof()
    } catch (err) {
      console.error('[export-proof] FAILED:', err)
      code = 1
    }
    app.exit(code)
    return
  }

  // Real customer export proof: `electron . --f2f-real-export-proof`.
  //
  // Runs the EXPORT VIDEO path the product uses — startExport, the queue
  // job, the registered runner, exportAssembly, the filter graph — and
  // reads the pixels of the MP4 that comes out. The only substitution is
  // the native save dialog, via the F2F_EXPORT_DEST seam the product
  // already has. It WRITES projects and settings, so point it at a
  // scratch directory with --user-data-dir.
  if (process.argv.includes('--f2f-real-export-proof')) {
    let code = 0
    try {
      code = await runRealExportProof()
    } catch (err) {
      console.error('[real-export] FAILED:', err)
      code = 1
    }
    flushNow()
    app.exit(code)
    return
  }

  // Headless persistence smoke test: `electron . --f2f-smoke`.
  // The queue is NOT started for the smoke run — the tests drive the
  // scheduler deterministically instead of racing a live worker.
  if (process.argv.includes('--f2f-smoke')) {
    let code = 0
    try {
      await runSmokeTest()
    } catch (err) {
      console.error('[smoke] FAILED:', err)
      code = 1
    }
    flushNow()
    app.exit(code)
    return
  }

  // Loads persisted jobs, recovers interrupted/overdue ones, starts the
  // scheduler tick.
  initQueue()

  // ── STALE "ALREADY RUNNING" MARKERS ────────────────────────────────
  //
  // A motion segment’s status is a cache of what the queue says. A
  // process killed mid-run leaves that cache claiming a run that ended
  // long ago, and the operator has no way to clear it. Reconciling here
  // means the lock cannot outlive the job it belonged to across a
  // restart.
  //
  // Runs AFTER initQueue so the jobs it reads are the persisted ones it
  // recovered, and it never widens a status: a segment whose job holds a
  // real provider task stays `generating`, so Resume — not a second
  // payment — is the remedy.
  try {
    reconcileMotionSegments()
  } catch (err) {
    console.error('[motion] reconciliation skipped', err)
  }

  createWindow()

  // TEMPORARY: drives the real renderer and reports DOM state after each
  // interaction. `electron . --f2f-uicheck`.
  if (process.argv.includes('--f2f-uicheck')) {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      void runUiProbe(win)
        .catch((err) => console.error('[uicheck] FAILED:', err))
        .finally(() => app.exit(0))
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Nothing may be lost on close: write any pending database state to disk.
app.on('before-quit', () => {
  stopQueue()
  flushNow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
