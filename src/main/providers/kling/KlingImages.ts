import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { providerError, type ProviderError } from '../types'

/**
 * Image input preparation, behind the provider abstraction.
 *
 * MECHANISM: the managed image bytes are base64-encoded and sent inline.
 * This is deliberately the only implemented mode because it is the one that
 * needs NO third-party image host, NO ad-hoc public server and NO external
 * cloud storage — and it never leaks a local filesystem path, since only
 * the encoded bytes travel.
 *
 * If verification shows Kling requires an uploaded asset id instead, that
 * implementation belongs here and nowhere else; the provider calls this
 * module and does not care which mechanism is used.
 */

/** Hard ceiling so a huge photo cannot blow up the request. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp'
}

export interface PreparedImage {
  /** Base64 payload — no data: prefix, which is what image APIs expect. */
  base64: string
  mime: string
  bytes: number
}

export type PrepareResult =
  | { ok: true; image: PreparedImage }
  | { ok: false; error: ProviderError }

export function prepareImage(path: string): PrepareResult {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return {
      ok: false,
      error: providerError('invalid-image', 'A frame image is missing from managed storage.')
    }
  }
  if (size === 0) {
    return { ok: false, error: providerError('invalid-image', 'A frame image is empty.') }
  }
  if (size > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: providerError(
        'invalid-image',
        `A frame image is too large (${Math.round(size / 1024 / 1024)} MB, limit ${MAX_IMAGE_BYTES / 1024 / 1024} MB).`
      )
    }
  }
  try {
    const buffer = readFileSync(path)
    return {
      ok: true,
      image: {
        base64: buffer.toString('base64'),
        mime: MIME_BY_EXT[extname(path).toLowerCase()] ?? 'image/jpeg',
        bytes: size
      }
    }
  } catch {
    return {
      ok: false,
      error: providerError('invalid-image', 'A frame image could not be read from managed storage.')
    }
  }
}

/** Prepares BOTH frames. The pair is all-or-nothing: a live submission must
 * never go out with one frame missing. */
export function prepareFramePair(
  startPath: string,
  endPath: string
): { ok: true; start: PreparedImage; end: PreparedImage } | { ok: false; error: ProviderError } {
  const start = prepareImage(startPath)
  if (!start.ok) return start
  const end = prepareImage(endPath)
  if (!end.ok) return end
  return { ok: true, start: start.image, end: end.image }
}
