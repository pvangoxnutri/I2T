import { basename } from 'node:path'
import type { GenerationRequest, ModelCapabilities } from '../types'
import { fitPromptToLimit } from '../../../shared/prompts'
import { FAL_FIELDS, FAL_PROMPT_MAX_CHARS } from './falConfig'

/**
 * FrameToFrame → fal.ai request mapping. Pure functions only: no I/O, no
 * network, no filesystem reads — so the preview UI, the dry run and the live
 * submitter all go through the exact same code path.
 *
 * THE DIRECTION IS THE PRODUCT: `request.startImagePath` is always
 * `image_url` and `request.endImagePath` is always `end_image_url`.
 *
 * The duration/resolution helpers are duplicated rather than shared with the
 * Kling mapper on purpose: each provider directory stays self-contained, so
 * nothing outside src/main/providers/fal needs to know fal.ai exists.
 */

/** Sanitized placeholder used in DRY RUN, where nothing is uploaded. */
export function imagePlaceholder(path: string): string {
  return `managed://${basename(path)}`
}

/** fal's duration enum — closest allowed value, never invented. */
export function mapDuration(requestedSec: number, model: ModelCapabilities): number {
  if (model.durationsSec.length === 0) return requestedSec
  return model.durationsSec.reduce((best, candidate) =>
    Math.abs(candidate - requestedSec) < Math.abs(best - requestedSec) ? candidate : best
  )
}

/**
 * The o3 *standard* tier fixes output quality at the endpoint level — there
 * is no resolution request field — so any requested resolution maps to the
 * tier itself, and the preview says so rather than pretending otherwise.
 */
export function mapResolution(resolution: string, model: ModelCapabilities): string {
  if (model.resolutions.includes(resolution)) return resolution
  return model.defaultResolution ?? model.resolutions[model.resolutions.length - 1] ?? resolution
}

/**
 * The request body. Identical in shape for dry run and live — only the two
 * image values differ (placeholder vs uploaded fal CDN url), so a preview
 * shows exactly what will be sent.
 *
 * `duration` is a STRING: the endpoint's schema is a DurationEnum whose
 * default is "5".
 */
export function buildFalBody(
  request: GenerationRequest,
  model: ModelCapabilities,
  startImage: string,
  endImage: string
): Record<string, unknown> {
  // ── THE LIMIT IS ENFORCED HERE, ON THE WAY INTO THE BODY ──────────
  //
  // Not at the call sites, and not by trusting whoever composed the
  // prompt. This is the last point before the request is serialised, so
  // a prompt that is too long cannot reach fal from ANY path — a preset
  // edit, an operator's custom wording, or a motion instruction appended
  // by the planner. Over-length previously meant HTTP 422 and a rejected
  // request on every single generation.
  //
  // `fitPromptToLimit` drops tone and camera-feel first and never the
  // reflection or geometry constraints; see shared/prompts.
  const fitted = fitPromptToLimit(request.prompt, FAL_PROMPT_MAX_CHARS)
  if (fitted.dropped.length > 0 || fitted.truncatedCustomText) {
    console.warn(
      `[fal] prompt ${request.prompt.length} → ${fitted.prompt.length} / ${FAL_PROMPT_MAX_CHARS} chars` +
        (fitted.dropped.length > 0 ? ` — dropped: ${fitted.dropped.join(', ')}` : '') +
        (fitted.truncatedCustomText ? ' — custom text shortened, constraints kept' : '')
    )
  }

  return {
    [FAL_FIELDS.startImage]: startImage,
    [FAL_FIELDS.endImage]: endImage,
    [FAL_FIELDS.prompt]: fitted.prompt,
    [FAL_FIELDS.duration]: String(mapDuration(request.durationSec, model)),
    // Explicitly off: the field name is confirmed, so we send it rather than
    // relying on a default we do not control. Audio also costs 33 % more.
    [FAL_FIELDS.generateAudio]: request.nativeAudio === true
  }
}

// ── Response readers (defensive, even though the shape is confirmed) ──────

function unwrap(data: Record<string, unknown>): Record<string, unknown> {
  // The result endpoint may return the payload directly or nested under
  // `response`/`data` depending on how it is reached.
  for (const key of ['response', 'data']) {
    const nested = data[key]
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const inner = nested as Record<string, unknown>
      if (inner.video || inner.request_id) return inner
    }
  }
  return data
}

export function extractRequestId(data: Record<string, unknown>): string | null {
  const d = unwrap(data)
  const id = d.request_id ?? d.requestId
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null
}

export function extractQueueStatus(data: Record<string, unknown>): string | undefined {
  const d = unwrap(data)
  const status = d.status ?? d.queue_status
  return typeof status === 'string' ? status : undefined
}

/** The confirmed result location is `video.url`; the alternatives below cost
 * nothing and stop a shape change from losing a paid result. */
export function extractResultUrl(data: Record<string, unknown>): string | undefined {
  const d = unwrap(data)
  const video = d.video
  if (video && typeof video === 'object') {
    const url = (video as Record<string, unknown>).url
    if (typeof url === 'string') return url
  }
  const videos = d.videos
  if (Array.isArray(videos) && videos.length > 0) {
    const first = videos[0]
    if (first && typeof first === 'object') {
      const url = (first as Record<string, unknown>).url
      if (typeof url === 'string') return url
    }
  }
  return typeof d.video_url === 'string' ? d.video_url : undefined
}

/**
 * Keeps only small, non-sensitive scalars from a fal response.
 *
 * status_url / response_url / cancel_url are fal's OWN queue urls for this
 * request, and they belong here. This allowlist used to drop them, which is
 * exactly how a paid request became unpollable: with the urls gone the only
 * option left was rebuilding them from the model id, and that path answers
 * HTTP 405. They carry no credentials, are scoped to the one request, and
 * are the authoritative way to reach it.
 */
export function sanitizeMeta(data: Record<string, unknown>): Record<string, unknown> {
  const d = unwrap(data)
  const out: Record<string, unknown> = {}
  for (const key of [
    'status',
    'queue_position',
    'request_id',
    'status_url',
    'response_url',
    'cancel_url'
  ]) {
    const value = d[key]
    if (typeof value === 'string' || typeof value === 'number') out[key] = value
  }
  const video = d.video
  if (video && typeof video === 'object') {
    const file = video as Record<string, unknown>
    if (typeof file.file_size === 'number') out['file_size'] = file.file_size
    if (typeof file.content_type === 'string') out['content_type'] = file.content_type
  }
  return out
}
