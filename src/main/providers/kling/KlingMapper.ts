import { basename } from 'node:path'
import type { GenerationRequest, ModelCapabilities } from '../types'
import { KLING_FIELDS, resolveContract, type KlingContractOverrides } from './klingConfig'

/**
 * FrameToFrame → Kling request mapping. Pure functions only: no I/O, no
 * network, no filesystem reads — so the preview UI and the tests use the
 * exact same code path the live submitter would.
 *
 * THE DIRECTION IS THE PRODUCT: `request.startImagePath` is always the
 * Kling START frame and `request.endImagePath` is always the END frame.
 * Reversing them would silently produce backwards property tours, so the
 * mapping is asserted in the test suite.
 */

/** How the frame images will be handed to Kling once Live mode exists. */
export type ImageInputMode = 'reference' | 'url' | 'base64'

/**
 * Placeholder reference for an image that has not been prepared for upload
 * yet. Milestone 5A uploads NOTHING: the mapper emits a stable, non-secret
 * identifier so the request shape is complete and reviewable, and the real
 * preparation step (upload / URL / base64 per the official docs) plugs in
 * behind `prepareImageInput` later.
 */
export function imageReference(path: string): string {
  return `managed://${basename(path)}`
}

/**
 * The seam for real image preparation. In dry run it never runs; when Live
 * mode arrives this becomes an async step that follows whatever input form
 * the official documentation specifies.
 */
export interface PreparedImages {
  mode: ImageInputMode
  start: string
  end: string
}

export function prepareImagesForDryRun(request: GenerationRequest): PreparedImages {
  return {
    mode: 'reference',
    start: imageReference(request.startImagePath),
    end: imageReference(request.endImagePath)
  }
}

/** Kling's duration vocabulary — closest allowed value, never invented. */
export function mapDuration(requestedSec: number, model: ModelCapabilities): number {
  if (model.durationsSec.length === 0) return requestedSec
  return model.durationsSec.reduce((best, candidate) =>
    Math.abs(candidate - requestedSec) < Math.abs(best - requestedSec) ? candidate : best
  )
}

/** FrameToFrame's export resolution → the model's supported vocabulary. */
export function mapResolution(resolution: string, model: ModelCapabilities): string {
  if (model.resolutions.includes(resolution)) return resolution
  // Fall back to the model's DEFAULT, never to the last entry — that would
  // silently upgrade an unknown request to the most expensive mode.
  return model.defaultResolution ?? model.resolutions[model.resolutions.length - 1] ?? resolution
}

/** Builds the request body. Contains no credentials by construction. */
export function buildKlingBody(
  request: GenerationRequest,
  model: ModelCapabilities,
  images: PreparedImages
): Record<string, unknown> {
  return {
    [KLING_FIELDS.model]: model.id,
    [KLING_FIELDS.prompt]: request.prompt,
    // START frame → first-frame field; END frame → tail/last-frame field.
    [KLING_FIELDS.startImage]: images.start,
    [KLING_FIELDS.endImage]: images.end,
    [KLING_FIELDS.duration]: mapDuration(request.durationSec, model),
    [KLING_FIELDS.mode]: mapResolution(request.resolution, model)
  }
}

export const imageToVideoEndpoint = (overrides?: KlingContractOverrides): string =>
  resolveContract(overrides).imageToVideoPath

export const taskStatusEndpoint = (taskId: string, overrides?: KlingContractOverrides): string =>
  resolveContract(overrides).taskStatusPath.replace('{id}', encodeURIComponent(taskId))

/**
 * The LIVE request body: identical shape to the dry-run preview, except the
 * frame fields carry the real base64 payloads instead of display
 * references. The direction is enforced by the caller's assertion.
 */
export function buildKlingLiveBody(
  request: GenerationRequest,
  model: ModelCapabilities,
  startBase64: string,
  endBase64: string
): Record<string, unknown> {
  return {
    [KLING_FIELDS.model]: model.id,
    [KLING_FIELDS.prompt]: request.prompt,
    [KLING_FIELDS.startImage]: startBase64,
    [KLING_FIELDS.endImage]: endBase64,
    [KLING_FIELDS.duration]: mapDuration(request.durationSec, model),
    [KLING_FIELDS.mode]: mapResolution(request.resolution, model)
  }
}
