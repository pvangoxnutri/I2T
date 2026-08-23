/**
 * AI production-cost model — PREPARATION ONLY.
 *
 * This is deliberately empty of real numbers: no provider pricing is
 * hardcoded, and nothing is invented. Until a real rate is configured the
 * estimator returns null and the UI must render a placeholder ("—").
 *
 * Completely separate from customer pricing (shared/pricing.ts): that is
 * what we CHARGE, this is what production COSTS.
 */

export interface ProviderCostRate {
  provider: string
  model: string
  /** Rate applies to this output resolution, when the provider prices per
   * resolution (null = one rate for all). */
  resolution: string | null
  costPerSecond: number
  currency: string
  /** True for locally configured mock rates — must be labelled in the UI. */
  mock: boolean
}

export interface CostEstimate {
  seconds: number
  rate: ProviderCostRate
  /** seconds × costPerSecond. */
  estimatedCost: number
}

/** No configured rate → null. Never guess a price. */
export function estimateAiCost(
  seconds: number,
  rate: ProviderCostRate | null
): CostEstimate | null {
  if (!rate || !Number.isFinite(seconds) || seconds <= 0) return null
  return {
    seconds,
    rate,
    estimatedCost: Math.round(seconds * rate.costPerSecond * 100) / 100
  }
}

/** Builds the dev-only mock rate from Settings, or null when unset. */
export function mockRate(costPerSecond: number | null): ProviderCostRate | null {
  if (costPerSecond === null || !Number.isFinite(costPerSecond) || costPerSecond <= 0) return null
  return {
    provider: 'mock',
    model: 'mock-dev',
    resolution: null,
    costPerSecond,
    currency: 'USD',
    mock: true
  }
}

/** Actual cost is only known once a real provider reports it — never
 * estimated after the fact. */
export interface ActualCost {
  provider: string
  model: string
  seconds: number
  cost: number
  currency: string
}
