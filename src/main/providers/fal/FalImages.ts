import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { providerError, type ProviderError } from '../types'

/**
 * Frame image preparation for fal.ai.
 *
 * This module only READS managed bytes — it never uploads. The upload itself
 * lives in FalClient, so "did anything leave the machine?" stays a single
 * observable fact, and dry run can prepare nothing at all.
 *
 * The file NAME sent to fal is deliberately the managed storedName (a uuid),
 * not the customer's original file name and never an absolute path.
 */

/** Hard ceiling so a huge photo cannot stall a paid submission. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp'
}

export interface FalImageBytes {
  bytes: Buffer
  /** Managed file name only — no directory component. */
  fileName: string
  contentType: string
  size: number
}

export type FalImageResult =
  | { ok: true; image: FalImageBytes }
  | { ok: false; error: ProviderError }

export function readFrameBytes(path: string): FalImageResult {
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
    return {
      ok: true,
      image: {
        bytes: readFileSync(path),
        fileName: basename(path),
        contentType: MIME_BY_EXT[extname(path).toLowerCase()] ?? 'image/jpeg',
        size
      }
    }
  } catch {
    return {
      ok: false,
      error: providerError('invalid-image', 'A frame image could not be read from managed storage.')
    }
  }
}

/** Reads BOTH frames. All-or-nothing: a paid submission must never go out
 * with one frame missing, and the two must not be the same picture. */
export function readFramePair(
  startPath: string,
  endPath: string
): { ok: true; start: FalImageBytes; end: FalImageBytes } | { ok: false; error: ProviderError } {
  const start = readFrameBytes(startPath)
  if (!start.ok) return start
  const end = readFrameBytes(endPath)
  if (!end.ok) return end
  if (start.image.bytes.equals(end.image.bytes)) {
    return {
      ok: false,
      error: providerError('invalid-request', 'Start and end frames are identical — refusing to submit.')
    }
  }
  return { ok: true, start: start.image, end: end.image }
}
