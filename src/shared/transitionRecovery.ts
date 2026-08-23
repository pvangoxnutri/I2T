import type { QueueJob, TransitionSettings } from './types'
import { resolveGenerationAction } from './generationState'

/**
 * WHAT TO OFFER FOR ONE TRANSITION — and, above all, what NOT to offer.
 *
 * ── THE MONEY RULE ───────────────────────────────────────────────────
 *
 * Three recoveries look identical to a frustrated user and cost wildly
 * different amounts:
 *
 *   Resume         continue polling a paid task that is still running.
 *                  Costs nothing. The provider is already working.
 *   Retry download the remote task SUCCEEDED and we owe a file transfer.
 *                  Costs nothing. The video already exists and is paid for.
 *   Regenerate     submit a NEW paid task. Costs the full amount again.
 *
 * Labelling all three "Retry" is how someone pays twice for a clip that
 * was already sitting on the provider's server. So they are three
 * different words, and the decision between them is made here from the
 * remote task state rather than from how the UI feels about it.
 *
 * The underlying idempotency answer comes from `resolveGenerationAction`,
 * which both processes already share. This adds the presentation layer
 * without getting a second opinion about the facts.
 */

export type RecoveryKind =
  | 'generate'
  | 'preview'
  | 'waiting'
  | 'resume'
  | 'retry-download'
  | 'regenerate'
  | 'unavailable'

export interface TransitionRecovery {
  kind: RecoveryKind
  /** The exact button text. Never "Retry" for more than one meaning. */
  label: string
  /** One line of context, or the sanitized failure reason. */
  detail: string
  /** TRUE only for actions that submit a new paid provider request. */
  costsMoney: boolean
  /** The queue job to act on, for resume/retry-download. */
  jobId: string | null
  /** A second, deliberately de-emphasised option. */
  secondary: { kind: RecoveryKind; label: string; costsMoney: boolean } | null
}

const REGENERATE_LABEL = 'Regenerate — costs again'

/**
 * The most recent job covering this pair.
 *
 * Most recent by creation, because a Regenerate creates a newer job and
 * its remote task is the one that matters. An older failed attempt must
 * not keep offering Resume for a task nobody is waiting on.
 */
export function latestJobForPair(jobs: QueueJob[], projectId: string, pairKey: string): QueueJob | null {
  const mine = jobs
    .filter((j) => j.projectId === projectId && (j.metadata?.pairKeys ?? []).includes(pairKey))
    .sort((a, b) => b.createdAt - a.createdAt)
  return mine[0] ?? null
}

export function transitionRecovery(
  transition: TransitionSettings | undefined,
  job: QueueJob | null,
  label: string
): TransitionRecovery {
  const clip = transition?.clip ?? null
  const status = transition?.status ?? 'not-generated'

  // ── A finished clip is a finished clip ───────────────────────────────
  if (clip) {
    return {
      kind: 'preview',
      label: 'Preview',
      detail: 'A generated clip is attached.',
      costsMoney: false,
      jobId: null,
      // Offered, but never as the primary action and never as a "retry".
      secondary: { kind: 'regenerate', label: REGENERATE_LABEL, costsMoney: true }
    }
  }

  // ── In flight ────────────────────────────────────────────────────────
  if (status === 'queued' || status === 'generating') {
    return {
      kind: 'waiting',
      label: status === 'queued' ? 'Queued' : 'Generating…',
      detail:
        status === 'queued'
          ? 'Waiting for a free generation slot.'
          : 'The provider is working on this transition.',
      costsMoney: false,
      jobId: job?.id ?? null,
      secondary: null
    }
  }

  // ── THE DECISION THAT PROTECTS MONEY ─────────────────────────────────
  //
  // Only reached with no clip and nothing running. The remote task state
  // — not the local status word — decides whether anything must be paid
  // for again.
  const action = resolveGenerationAction(job?.provider)
  const reason = sanitizeReason(job?.note)

  if (action === 'download') {
    return {
      kind: 'retry-download',
      label: 'Retry download',
      detail:
        'The provider finished this generation and it is already paid for. Only the file transfer failed.',
      costsMoney: false,
      jobId: job?.id ?? null,
      secondary: { kind: 'regenerate', label: REGENERATE_LABEL, costsMoney: true }
    }
  }

  if (action === 'resume-poll') {
    return {
      kind: 'resume',
      label: 'Resume',
      detail:
        'A paid request is already running at the provider. Resuming continues to track it and costs nothing.',
      costsMoney: false,
      jobId: job?.id ?? null,
      secondary: null
    }
  }

  if (status === 'failed' || action === 'blocked') {
    return {
      kind: 'regenerate',
      label: REGENERATE_LABEL,
      // A remote task that FAILED cannot be resumed or downloaded — there
      // is nothing there. Regenerating is the only way forward, and it is
      // a new paid request, which the label says out loud.
      detail: reason ?? 'The generation failed and there is no remote result to recover.',
      costsMoney: true,
      jobId: job?.id ?? null,
      secondary: null
    }
  }

  // ── Never generated ──────────────────────────────────────────────────
  return {
    kind: 'generate',
    label: `Generate ${label}`,
    detail: 'No clip for this transition yet.',
    costsMoney: true,
    jobId: null,
    secondary: null
  }
}

/**
 * Provider failures in words the operator can act on.
 *
 * ── WHY MAP AT ALL ───────────────────────────────────────────────────
 *
 * A raw provider payload is the wrong thing to show twice over: it can
 * carry request ids and echoed headers, and it tells someone looking at a
 * broken video nothing about what to DO. The category answers that; the
 * original text stays available under Details.
 */
export type ProviderErrorCategory =
  | 'auth'
  | 'account'
  | 'endpoint'
  | 'generation'
  | 'network'
  | 'unknown'

export function categorizeProviderError(raw: string | null | undefined): ProviderErrorCategory {
  if (!raw) return 'unknown'
  const s = raw.toLowerCase()
  if (/401|403|unauthor|forbidden|invalid.*(key|token|credential)|authentication/.test(s)) {
    return 'auth'
  }
  if (/locked|suspend|disabled|quota|billing|insufficient|balance|credit/.test(s)) return 'account'
  if (/404|not found|endpoint|route|no such/.test(s)) return 'endpoint'
  // `ETIMEDOUT` deliberately spelled out: it contains "timedout", not
  // "timeout", so the obvious pattern misses the single most common
  // network failure Node reports.
  if (
    /timeout|timed ?out|etimedout|econn|enotfound|eai_again|network|socket|dns|unreachable|offline/.test(
      s
    )
  ) {
    return 'network'
  }
  if (/fail|error|reject|invalid/.test(s)) return 'generation'
  return 'unknown'
}

const MESSAGES: Record<ProviderErrorCategory, string> = {
  auth: 'Provider authentication failed — check the API key in Settings',
  account: 'Provider account unavailable — check billing or quota',
  endpoint: 'Provider endpoint unavailable',
  generation: 'Video generation failed',
  network: 'Connection to provider failed',
  unknown: 'Generation did not complete'
}

export function providerErrorMessage(raw: string | null | undefined): string {
  return MESSAGES[categorizeProviderError(raw)]
}

/** True when the category is something Settings can fix. */
export function isConfigurationError(raw: string | null | undefined): boolean {
  const c = categorizeProviderError(raw)
  return c === 'auth' || c === 'account'
}

/**
 * Strip anything that should not be shown twice.
 *
 * Belt and braces: notes are already written by sanitized paths, but this
 * is the last point before a provider string reaches a screen, so a key
 * that ever leaked into one dies here rather than being rendered.
 */
export function sanitizeReason(raw: string | null | undefined): string | null {
  if (!raw) return null
  return raw
    .replace(/AIza[0-9A-Za-z_\-]{10,}/g, '[redacted]')
    .replace(/sk-[A-Za-z0-9_\-]{10,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._\-]{10,}/gi, 'Bearer [redacted]')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '[path]')
    .slice(0, 300)
}
