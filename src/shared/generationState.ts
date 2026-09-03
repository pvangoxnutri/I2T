import type { ProviderJobState } from './types'

/**
 * The idempotency state machine for one remote generation.
 *
 *   no task id                    → SUBMIT (the only paying action)
 *   task id + running             → RESUME POLL
 *   task id + succeeded           → DOWNLOAD (already paid for — never resubmit)
 *   task id + failed              → BLOCKED (needs an explicit Regenerate)
 *
 * Lives in `shared` because BOTH sides need the same answer. The renderer
 * has to tell "this transition has no clip because nothing was ever
 * generated" apart from "the remote generation succeeded and we still owe
 * a download" — and if it reimplemented that rule, the two could drift and
 * the UI would eventually offer to pay for a clip that already exists
 * remotely.
 */
export type GenerationAction = 'submit' | 'resume-poll' | 'download' | 'blocked'

/**
 * The recovery state for the one contract value we could not verify: a PAID
 * task exists remotely, but our status-query path is wrong. It is stored as
 * the provider status so it survives a restart, and it is deliberately NOT a
 * failure word — this resolves it to resume-poll, which can never resubmit.
 */
export const STATUS_ENDPOINT_UNVERIFIED = 'status-endpoint-unverified'
export const STATUS_ENDPOINT_UNVERIFIED_MESSAGE =
  'Remote task submitted — status endpoint needs verification'

/**
 * Provider error codes that mean the REMOTE TASK IS DEAD.
 *
 * The provider answered, and its answer was a refusal. Polling the same
 * task id can only return the same refusal, so Resume is not merely
 * useless here — it is a lie about what the button does.
 *
 * Everything absent from this list is treated as recoverable, which is
 * the deliberate direction: `network`, `timeout`, `rate-limit` and
 * `endpoint-unverified` all mean WE lost track of a task that may still
 * be running and already paid for. Hiding Resume there would push an
 * operator into buying a second copy of work they already own.
 */
const TERMINAL_ERROR_CODES = new Set([
  'invalid-request',
  'invalid-image',
  'moderation',
  'authentication',
  'billing',
  'not-configured',
  'unsupported-capability',
  'task-failed'
])

export function isTerminalProviderErrorCode(code: string | null | undefined): boolean {
  return code !== null && code !== undefined && TERMINAL_ERROR_CODES.has(code)
}

/**
 * LEGACY READER — jobs failed before the structured code was recorded.
 *
 * Those rows kept the provider's own sentence in `error` and nothing
 * else, so the text is genuinely all there is. Matched against the
 * messages fal's own classifier produces for terminal statuses; anything
 * unrecognised stays resumable, because guessing "dead" costs money and
 * guessing "alive" costs a click.
 */
export function looksTerminalFromMessage(message: string | null | undefined): boolean {
  if (!message) return false
  return /rejected the request as invalid|rejected one of the frame images|content moderation|invalid api key|authentication failed|insufficient (funds|balance|credit)/i.test(
    message
  )
}

/** Provider status words that are terminal on their own. */
function statusIsTerminal(status: string): boolean {
  return /fail|error|reject|cancel|abort/.test(status)
}

/**
 * CAN THIS REMOTE TASK STILL BE TRACKED?
 *
 * ── THE BUG THIS EXISTS FOR ──────────────────────────────────────────
 *
 * A fal request rejected with HTTP 422 still offered "Resume polling".
 * The reason is visible in the stored rows: the job's LOCAL status was
 * `failed`, but its `providerStatus` was still `IN_QUEUE` — the last
 * thing the provider ever said before the rejection arrived from a
 * different call. `resolveGenerationAction` saw a task id and a status
 * that was neither success nor failure, and answered `resume-poll`.
 *
 * So Resume led straight back to the same rejection, while the one
 * action that could help — buying a new generation — was not offered.
 *
 * ── THE DISTINCTION THAT MATTERS ─────────────────────────────────────
 *
 * A PROVIDER REFUSAL is terminal: the task id is dead.
 * LOSING CONTACT is not: the task may be running and already paid for.
 *
 * Both surface locally as "the job failed", which is exactly why this
 * decision is made from the recorded provider failure rather than from
 * the local status word.
 */
export function canResumeProviderTask(
  provider: ProviderJobState | undefined,
  /** The provider's own message, for jobs failed before codes were stored. */
  recordedError?: string | null
): boolean {
  if (!provider?.providerTaskId) return false
  if (provider.providerFailure?.terminal) return false
  if (isTerminalProviderErrorCode(provider.providerFailure?.code)) return false

  const status = (provider.providerStatus ?? '').toLowerCase()
  // The unverified sentinel is explicitly NOT a failure — it exists to
  // keep a paid, running task resumable when our status path is wrong.
  if (status === STATUS_ENDPOINT_UNVERIFIED) return true
  if (statusIsTerminal(status)) return false

  // No structured code: fall back to what the provider actually said.
  if (!provider.providerFailure && looksTerminalFromMessage(recordedError)) return false

  return true
}

/** Pure decision function — the heart of the idempotency guarantee. */
export function resolveGenerationAction(
  provider: ProviderJobState | undefined,
  /** Optional recorded error, so pre-classification jobs decide correctly. */
  recordedError?: string | null
): GenerationAction {
  if (!provider) return 'submit'
  if (!provider.providerTaskId) return 'submit'
  const status = (provider.providerStatus ?? '').toLowerCase()
  // A finished task is downloadable whatever else happened afterwards —
  // it is paid for and the file exists remotely.
  if (/succe|complete|finish/.test(status)) return 'download'
  return canResumeProviderTask(provider, recordedError) ? 'resume-poll' : 'blocked'
}
