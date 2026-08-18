import { contextBridge } from 'electron'

/**
 * The renderer ↔ main bridge. Today it only reports the platform; this is
 * the single place future IPC surfaces are added (project persistence,
 * FFmpeg status, queue control, provider calls) so the renderer never
 * touches Node APIs directly.
 */
const api = {
  platform: process.platform as string,
  appVersion: process.env['npm_package_version'] ?? '0.1.0'
}

contextBridge.exposeInMainWorld('f2f', api)

export type F2FBridge = typeof api
