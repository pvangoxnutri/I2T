import { net } from 'electron'
import { createReadStream, statSync } from 'node:fs'
import { extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { resolveImageRequest } from './files'

/**
 * SERVING MANAGED MEDIA OVER f2f://.
 *
 * Extracted from index.ts so the exact code the app runs can be driven by
 * a test. A protocol handler that only exists inside `app.whenReady` can
 * be reasoned about but never exercised, and this one had a bug that no
 * amount of reading found.
 */

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

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** Set by a diagnostic run to observe every request and response. */
export type MediaTrace = (entry: {
  url: string
  range: string | null
  status: number
  headers: Record<string, string>
  path: string | null
}) => void

let trace: MediaTrace | null = null
export function setMediaTrace(fn: MediaTrace | null): void {
  trace = fn
}

function traced(
  url: string,
  range: string | null,
  path: string | null,
  response: Response
): Response {
  if (trace) {
    const headers: Record<string, string> = {}
    response.headers.forEach((v, k) => {
      headers[k] = v
    })
    trace({ url, range, status: response.status, headers, path })
  }
  return response
}

export async function handleMediaRequest(request: Request): Promise<Response> {
  const path = resolveImageRequest(request.url)
  const range = request.headers.get('range')
  if (!path) {
    return traced(request.url, range, null, new Response('Not found', { status: 404 }))
  }

  // RANGE REQUESTS — required by <video>, irrelevant to <img>.
  //
  // Chromium asks a media element's source for byte ranges. Answering a
  // plain 200 makes it load the whole file with no seeking, and a
  // multi-megabyte generated transition then scrubs badly or sits blank.
  // Images never send a Range header, so they keep the simple path below.
  if (range) {
    const size = statSync(path).size
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (match && (match[1] || match[2])) {
      const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
      const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < size) {
        return traced(
          request.url,
          range,
          path,
          new Response(
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
        )
      }
    }
    return traced(
      request.url,
      range,
      path,
      new Response('Range not satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` }
      })
    )
  }

  const res = await net.fetch(pathToFileURL(path).toString())
  // Advertise range support so the player knows it may seek at all.
  const headers = new Headers(res.headers)
  headers.set('Accept-Ranges', 'bytes')
  headers.set('Content-Type', contentTypeFor(path))
  return traced(request.url, range, path, new Response(res.body, { status: res.status, headers }))
}
