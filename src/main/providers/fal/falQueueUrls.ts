import { falCancelUrl, falResultUrl, falStatusUrl, FAL_MODEL_ID } from './falConfig'

/**
 * THE AUTHORITATIVE QUEUE URLS FOR ONE fal.ai REQUEST.
 *
 * WHY THIS EXISTS. We used to rebuild every queue url from the model id:
 *
 *   https://queue.fal.run/{model}/requests/{id}/status
 *
 * For `fal-ai/kling-video/o3/standard/image-to-video` that produced a path
 * fal answers with **HTTP 405** — the method is not allowed there, because
 * queue operations do not live under the full endpoint path. A real paid
 * request was left unpollable by a url we invented.
 *
 * fal's submit response already carries the exact urls:
 *
 *   { request_id, status_url, response_url, cancel_url }
 *
 * Those are the only ones we should ever use. They are persisted at submit
 * time and reused verbatim for the whole lifecycle, which also makes the
 * app immune to fal changing its routing later — the urls come from fal,
 * so they change when fal changes.
 */

export interface FalQueueUrls {
  statusUrl: string
  responseUrl: string
  cancelUrl: string
}

/** Where a resolved url came from — surfaced in diagnostics and tests. */
export type FalUrlSource = 'submit-response' | 'derived'

export interface ResolvedFalUrls extends FalQueueUrls {
  source: FalUrlSource
}

/** The metadata keys the three urls are persisted under. Snake case matches
 *  fal's own payload, so a stored blob reads exactly like the response. */
export const FAL_URL_KEYS = ['status_url', 'response_url', 'cancel_url'] as const

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * Pulls the three queue urls out of a fal submit response. Returns null for
 * any url fal did not send, so a partial response degrades to derivation
 * for the missing pieces rather than fabricating a string.
 */
export function extractQueueUrls(data: Record<string, unknown> | null | undefined): Partial<FalQueueUrls> {
  const d = (data ?? {}) as Record<string, unknown>
  const out: Partial<FalQueueUrls> = {}
  const status = str(d.status_url) ?? str(d.statusUrl)
  const response = str(d.response_url) ?? str(d.responseUrl)
  const cancel = str(d.cancel_url) ?? str(d.cancelUrl)
  if (status) out.statusUrl = status
  if (response) out.responseUrl = response
  if (cancel) out.cancelUrl = cancel
  return out
}

/**
 * Derived urls — the FALLBACK only, for a request whose urls were never
 * persisted. The path shape lives in falConfig (one place owns fal's
 * external contract); note that queue operations are namespaced by the
 * APPLICATION (`{owner}/{app}`), not the full endpoint path, which is why
 * the original reconstruction answered 405.
 */
export function deriveQueueUrls(requestId: string, modelId: string = FAL_MODEL_ID): FalQueueUrls {
  return {
    statusUrl: falStatusUrl(requestId, modelId),
    responseUrl: falResultUrl(requestId, modelId),
    cancelUrl: falCancelUrl(requestId, modelId)
  }
}

/**
 * The urls to actually use for a job.
 *
 * Persisted values win, individually — a job recovered by pasting only a
 * status url keeps that url and derives the rest, rather than being all or
 * nothing. `source` is 'submit-response' only when EVERY url came from
 * fal, so diagnostics never claim authority the data does not have.
 */
export function resolveQueueUrls(
  meta: Record<string, unknown> | null | undefined,
  requestId: string,
  modelId: string = FAL_MODEL_ID
): ResolvedFalUrls {
  const stored = extractQueueUrls(meta)
  const derived = deriveQueueUrls(requestId, modelId)
  const complete = !!stored.statusUrl && !!stored.responseUrl && !!stored.cancelUrl
  return {
    statusUrl: stored.statusUrl ?? derived.statusUrl,
    responseUrl: stored.responseUrl ?? derived.responseUrl,
    cancelUrl: stored.cancelUrl ?? derived.cancelUrl,
    source: complete ? 'submit-response' : 'derived'
  }
}

/** True when a job has at least one fal-supplied url stored. */
export function hasAuthoritativeUrls(meta: Record<string, unknown> | null | undefined): boolean {
  const stored = extractQueueUrls(meta)
  return !!(stored.statusUrl || stored.responseUrl || stored.cancelUrl)
}

/** The metadata patch that persists recovered/submitted urls. */
export function queueUrlMeta(urls: Partial<FalQueueUrls>): Record<string, string> {
  const out: Record<string, string> = {}
  if (urls.statusUrl) out['status_url'] = urls.statusUrl
  if (urls.responseUrl) out['response_url'] = urls.responseUrl
  if (urls.cancelUrl) out['cancel_url'] = urls.cancelUrl
  return out
}
