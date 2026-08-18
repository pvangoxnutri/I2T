import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'

/**
 * FrameToFrame — Electron main process.
 *
 * Deliberately thin for the UI-foundation milestone. The seams that later
 * work plugs into all live here:
 *   - SQLite project persistence  → an ipcMain data layer (src/main/db/)
 *   - FFmpeg probing/assembly     → a worker module (src/main/ffmpeg/)
 *   - Kling + future AI providers → src/main/providers/ behind one interface
 *   - Job queue & scheduling      → src/main/queue/
 * None of that exists yet on purpose: the renderer runs on mock/local state.
 */

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

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
