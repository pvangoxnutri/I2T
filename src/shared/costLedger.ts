/**
 * OUR PRODUCTION SPEND — what FrameToFrame actually pays providers.
 *
 * ── TWO NUMBERS THAT MUST NEVER MIX ──────────────────────────────────
 *
 * CUSTOMER PRICE   images × price per image, in SEK. Revenue. Unchanged
 *                  by anything in this file.
 * PRODUCTION SPEND provider charges for real generations, in the
 *                  PROVIDER's currency (fal.ai bills USD).
 *
 * They are different currencies, different directions and different
 * meanings. Nothing here converts one into the other, and no FX rate is
 * invented — a made-up SEK figure on a USD charge would be a number
 * nobody could reconcile against an invoice.
 *
 * ── APPEND-ONLY ──────────────────────────────────────────────────────
 *
 * Generating Image 2 → Image 3 three times costs three times. The ledger
 * therefore RECORDS each attempt and never replaces the previous one:
 *
 *   attempt 1  $0.42
 *   attempt 2  $0.42
 *   attempt 3  $0.42
 *   project spend $1.26
 *
 * Replacing the old clip does not refund the old generation, so removing
 * its cost would understate what the business actually spent.
 */

export type CostEntryStatus = 'submitted' | 'succeeded' | 'failed' | 'unknown'

/**
 * What KIND of spend an entry is.
 *
 * Video generation and whole-property analysis are different providers,
 * different units and different reasons. They are reported side by side
 * and summed only into an explicit total — never silently merged, and
 * never converted between currencies.
 *
 * Every entry that existed before categories are video generation, and
 * migration 10 backfills them rather than leaving a null for readers to
 * guess about.
 */
export type CostCategory = 'video-generation' | 'vision-analysis'

export const COST_CATEGORY_LABEL: Record<CostCategory, string> = {
  'video-generation': 'Video generation',
  'vision-analysis': 'Property analysis'
}

export interface GenerationCostEntry {
  id: string
  projectId: string
  /** Transition pair key — the stable identity of the image pair. */
  pairKey: string
  /** Human label at the time of the charge, e.g. "Image 2 → Image 3". */
  transitionPair: string
  provider: string
  model: string
  durationSec: number | null
  resolution: string | null
  createdAt: number
  /** The provider's task id. Also the idempotency key for the charge. */
  remoteTaskId: string | null
  jobId: string | null
  /** 1 for the first generation of this pair, 2 for the first regenerate… */
  attemptNumber: number
  estimatedCost: number | null
  /** Filled once the real rate is known; estimate stands until then. */
  actualCost: number | null
  currency: string
  status: CostEntryStatus
  isRegeneration: boolean
  /** Optional so entries written before categories still parse. */
  category?: CostCategory
}

/** Category totals, kept separate. Never added behind the operator's back. */
export interface SpendByCategory {
  videoGeneration: number
  visionAnalysis: number
  total: number
  currency: string
}

export function spendByCategory(
  entries: GenerationCostEntry[],
  currency: string
): SpendByCategory {
  const counted = entries.filter(countsAsSpend).filter((e) => e.currency === currency)
  const sum = (category: CostCategory): number =>
    counted
      // Absent category means video generation — that is what every
      // pre-category entry was.
      .filter((e) => (e.category ?? 'video-generation') === category)
      .reduce((s, e) => s + entryAmount(e), 0)
  const round = (n: number): number => Math.round(n * 100) / 100
  const video = round(sum('video-generation'))
  const vision = round(sum('vision-analysis'))
  return {
    videoGeneration: video,
    visionAnalysis: vision,
    total: round(video + vision),
    currency
  }
}

/**
 * What one entry contributes to "Spent".
 *
 * The actual charge when we know it, otherwise the estimate. A submitted
 * remote task that we then lost track of still cost money — see
 * `countsAsSpend` — so falling back to the estimate is the honest answer
 * rather than counting it as zero.
 */
export function entryAmount(entry: GenerationCostEntry): number {
  return entry.actualCost ?? entry.estimatedCost ?? 0
}

/**
 * WHEN SPEND IS REAL.
 *
 * A provider request that has been ACCEPTED remotely has been charged for.
 * That is true even if the download fails afterwards, the app is closed,
 * or attaching the clip locally goes wrong — the provider ran the job.
 * So acceptance, not local success, is the moment spend becomes real.
 *
 * A failed remote task is left in the ledger at its recorded amount too:
 * whether a provider refunds a failure is their policy, not something we
 * may assume. It is visible as `failed` so the operator can reconcile.
 *
 * Nothing that never reached a provider is spend: dry runs, the mock
 * provider, Attach Test Clip, validation failures before submit, and
 * queue items cancelled before submission all create NO entry at all —
 * they never get this far.
 */
export function countsAsSpend(entry: GenerationCostEntry): boolean {
  return entry.status !== 'unknown'
}

export interface ProjectSpendSummary {
  /** Sum of every real generation attempt already submitted/charged. */
  spent: number
  /** Estimated cost of transitions still needing a generation. */
  remainingEstimate: number
  /** spent + remainingEstimate. */
  projectedTotal: number
  currency: string
  entryCount: number
  /** Pairs with a live paid task, excluded from the remaining estimate. */
  activePairKeys: string[]
}

export interface SpendInput {
  entries: GenerationCostEntry[]
  /** Pair keys that still need a clip (no valid local clip today). */
  pairsNeedingClip: string[]
  /** Pair keys with an accepted remote task still in flight. */
  pairsWithActiveTask: string[]
  /** Estimated cost of ONE generation, in the provider's currency. */
  perGenerationEstimate: number
  currency: string
}

/**
 * Spent / remaining / projected.
 *
 * The subtle rule is the remaining estimate: a pair that already has an
 * ACCEPTED remote task must not be counted again. It has been charged, so
 * its money is already inside `spent`; adding it to `remaining` too would
 * double-count the same generation and overstate the projected total.
 */
export function summarizeSpend(input: SpendInput): ProjectSpendSummary {
  const counted = input.entries.filter(countsAsSpend)
  const spent = counted.reduce((sum, e) => sum + entryAmount(e), 0)

  const active = new Set(input.pairsWithActiveTask)
  const stillToPayFor = input.pairsNeedingClip.filter((pair) => !active.has(pair))
  const remainingEstimate = stillToPayFor.length * input.perGenerationEstimate

  const round = (n: number): number => Math.round(n * 100) / 100
  return {
    spent: round(spent),
    remainingEstimate: round(remainingEstimate),
    projectedTotal: round(spent + remainingEstimate),
    currency: input.currency,
    entryCount: counted.length,
    activePairKeys: [...active]
  }
}

/** Attempt history for one image pair, oldest first. */
export function attemptsForPair(
  entries: GenerationCostEntry[],
  pairKey: string
): GenerationCostEntry[] {
  return entries.filter((e) => e.pairKey === pairKey).sort((a, b) => a.createdAt - b.createdAt)
}

/** The next attempt number for a pair — 1 when nothing has been charged. */
export function nextAttemptNumber(entries: GenerationCostEntry[], pairKey: string): number {
  return attemptsForPair(entries, pairKey).length + 1
}

/** `$4.62` — provider currency, never converted. */
export function formatSpend(amount: number, currency: string): string {
  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : ''
  const value = amount.toFixed(2)
  return symbol ? `${symbol}${value}` : `${value} ${currency}`
}
