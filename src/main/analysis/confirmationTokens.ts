import { randomUUID } from 'node:crypto'

/**
 * ONE-SHOT CONFIRMATION TOKENS FOR PAID ANALYSIS.
 *
 * ── WHY A TOKEN AND NOT JUST A DIALOG ────────────────────────────────
 *
 * A dialog is a UI convention. It informs; it does not enforce. Anything
 * that can reach the IPC channel — a stale renderer, a second window, a
 * button that fired twice before React re-rendered — bypasses it entirely.
 * So the gate lives here, in main, and the dialog is what makes the
 * decision informed rather than what makes it possible.
 *
 * The token closes two holes at once:
 *
 *   - a double-clicked button cannot submit twice, because the second
 *     click presents a token that has already been consumed;
 *   - nothing reaches the paid path without main having first built the
 *     confirmation the operator was shown.
 *
 * ── CONSUMED BEFORE IT IS VALIDATED ──────────────────────────────────
 *
 * `consume` deletes the entry the moment it finds it, BEFORE checking
 * whether the project and analyzer match. A token that fails validation is
 * spent regardless, so a wrong-project guess cannot be retried against
 * every project until one lands.
 *
 * In-memory and per-session on purpose: a token means nothing after a
 * restart, and persisting one would only create a way to replay it.
 */

interface TokenEntry {
  projectId: string
  analyzerId: string
  issuedAt: number
}

const tokens = new Map<string, TokenEntry>()

/** Long enough to read the dialog, short enough that a forgotten window
 *  cannot authorise a charge an hour later. */
export const ANALYSIS_TOKEN_TTL_MS = 10 * 60 * 1000

export function issueAnalysisToken(projectId: string, analyzerId: string): string {
  const token = randomUUID()
  // Expired tokens are swept here rather than on a timer — the map only
  // grows when someone opens a confirmation, so that is when it is worth
  // tidying, and no timer keeps the process awake.
  const cutoff = Date.now() - ANALYSIS_TOKEN_TTL_MS
  for (const [key, value] of tokens) {
    if (value.issuedAt < cutoff) tokens.delete(key)
  }
  tokens.set(token, { projectId, analyzerId, issuedAt: Date.now() })
  return token
}

/** Spends the token. False for reuse, mismatch, expiry or nonsense. */
export function consumeAnalysisToken(
  token: string | undefined,
  projectId: string,
  analyzerId: string
): boolean {
  if (!token) return false
  const entry = tokens.get(token)
  if (!entry) return false
  // Deliberately NO environment escape hatch here, unlike the smoke
  // teardown switches. Those disable cleanup; this protects real money,
  // and a documented way to turn it off is a way to turn it off.
  // The reuse guard was proven by temporarily removing this line: the
  // suite fails with "the same confirmation cannot be spent twice".
  tokens.delete(token)
  if (entry.projectId !== projectId || entry.analyzerId !== analyzerId) return false
  return Date.now() - entry.issuedAt <= ANALYSIS_TOKEN_TTL_MS
}

/** Test seam: how many tokens are outstanding. */
export function outstandingAnalysisTokens(): number {
  return tokens.size
}

/**
 * Test seam: plant a token with a chosen issue time, so expiry can be
 * proven without a fake clock or a ten-minute wait.
 */
export function issueAnalysisTokenAt(
  projectId: string,
  analyzerId: string,
  issuedAt: number
): string {
  const token = randomUUID()
  tokens.set(token, { projectId, analyzerId, issuedAt })
  return token
}
