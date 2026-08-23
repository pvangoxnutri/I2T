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
import { runSmokeTest } from './smoke'
import { runDbDiagnostics } from './dbDiagnostics'
import { cleanSmokeOrphans } from './orphanCleanup'
import { runUiProbe } from './uiProbe'

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
