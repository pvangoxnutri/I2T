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

/** Pure decision function — the heart of the idempotency guarantee. */
export function resolveGenerationAction(provider: ProviderJobState | undefined): GenerationAction {
  if (!provider) return 'submit'
  if (!provider.providerTaskId) return 'submit'
  const status = (provider.providerStatus ?? '').toLowerCase()
  if (/succe|complete|finish/.test(status)) return 'download'
  if (/fail|error|reject/.test(status)) return 'blocked'
  return 'resume-poll'
}
