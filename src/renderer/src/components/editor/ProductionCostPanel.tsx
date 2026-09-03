import { useCallback, useEffect, useState } from 'react'
import { transitionKey, type Project } from '../../types'
import { getFeedImages } from '../../../../shared/feedSequence'
import {
  attemptsForPair,
  COST_CATEGORY_LABEL,
  formatSpend,
  spendByCategory,
  type GenerationCostEntry,
  type ProjectSpendSummary
} from '../../../../shared/costLedger'

/**
 * PRODUCTION COST — what WE pay providers for this project.
 *
 * Deliberately not the customer price. That figure is revenue, in SEK, and
 * lives in the production panel; this one is cost, in the provider's own
 * currency, and the two are never added, converted or shown as one number.
 * fal.ai bills USD, so this says `$4.62` rather than inventing an exchange
 * rate nobody could reconcile against an invoice.
 *
 * The history is per attempt on purpose. Generating Image 2 → Image 3
 * three times cost three times, and replacing the clip did not refund the
 * earlier generations.
 */
export function ProductionCostPanel({ project }: { project: Project }): React.JSX.Element {
  const [summary, setSummary] = useState<ProjectSpendSummary | null>(null)
  const [entries, setEntries] = useState<GenerationCostEntry[]>([])
  const [open, setOpen] = useState(false)

  const load = useCallback((): void => {
    void window.f2f.projects.cost.summary(project.id).then(setSummary)
    void window.f2f.projects.cost.entries(project.id).then(setEntries)
  }, [project.id])

  useEffect(() => {
    load()
    // A finished generation writes a ledger entry in main, so the same push
    // that reveals the clip is the signal to re-read the spend.
    return window.f2f.projects.onUpdated((incoming) => {
      if (incoming.id === project.id) load()
    })
  }, [project.id, load])

  if (!summary) return <></>

  const currency = summary.currency
  const byCategory = spendByCategory(entries, currency)
  // Pairs in the order the operator sees them, so the history reads like
  // the timeline rather than like the database.
  //
  // FROM THE FEED, not the library: a transition exists between two
  // images that are adjacent IN THE VIDEO. Built from library order this
  // listed pairs the project never had and missed the ones it was
  // actually charged for.
  const feedImages = getFeedImages(project)
  const pairs = feedImages.slice(0, -1).map((image, i) => ({
    label: `Image ${i + 1} → Image ${i + 2}`,
    attempts: attemptsForPair(entries, transitionKey(image.id, feedImages[i + 1].id))
  }))
  const withHistory = pairs.filter((p) => p.attempts.length > 0)

  return (
    <section className="panel cost-panel">
      <header className="panel-head">
        <h3 className="panel-title">Production Cost</h3>
        <span className="panel-sub">Our real AI spend · {currency}</span>
      </header>

      {/* Categories, kept apart. Video generation and property analysis
          are different providers charging for different things; they are
          shown side by side and summed only into an explicit total. */}
      <div className="cost-categories">
        <div className="cost-category">
          <span>{COST_CATEGORY_LABEL['video-generation']}</span>
          <span>{formatSpend(byCategory.videoGeneration, currency)}</span>
        </div>
        <div className="cost-category">
          <span>{COST_CATEGORY_LABEL['vision-analysis']}</span>
          <span>{formatSpend(byCategory.visionAnalysis, currency)}</span>
        </div>
        <div className="cost-category is-total">
          <span>Total</span>
          <span>{formatSpend(byCategory.total, currency)}</span>
        </div>
      </div>

      <div className="cost-figures">
        <div className="cost-figure">
          <span className="cost-figure-label">Spent</span>
          <span className="cost-figure-value">{formatSpend(summary.spent, currency)}</span>
          <span className="cost-figure-hint">
            {summary.entryCount} paid generation{summary.entryCount === 1 ? '' : 's'}
          </span>
        </div>
        <div className="cost-figure">
          <span className="cost-figure-label">Remaining estimate</span>
          <span className="cost-figure-value">
            {formatSpend(summary.remainingEstimate, currency)}
          </span>
          <span className="cost-figure-hint">
            transitions still without a clip
            {summary.activePairKeys.length > 0
              ? ` · ${summary.activePairKeys.length} already running, not counted twice`
              : ''}
          </span>
        </div>
        <div className="cost-figure cost-figure-total">
          <span className="cost-figure-label">Projected total</span>
          <span className="cost-figure-value">
            {formatSpend(summary.projectedTotal, currency)}
          </span>
          <span className="cost-figure-hint">spent + remaining</span>
        </div>
      </div>

      {withHistory.length > 0 && (
        <>
          <button
            type="button"
            className="btn btn-ghost btn-tiny cost-history-toggle"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Hide history' : `Show history (${entries.length})`}
          </button>
          {open && (
            <ul className="cost-history">
              {withHistory.map((pair) => (
                <li key={pair.label} className="cost-history-pair">
                  <span className="cost-history-label">{pair.label}</span>
                  <ul>
                    {/* One row PER ATTEMPT. A regeneration adds a row; it
                        never replaces the row above it, because the earlier
                        generation was really paid for. */}
                    {pair.attempts.map((a) => (
                      <li key={a.id} className={`cost-attempt cost-attempt-${a.status}`}>
                        <span className="cost-attempt-main">
                          Attempt {a.attemptNumber} · {a.provider} · {a.model}
                          {a.durationSec ? ` · ${a.durationSec}s` : ''}
                          {a.resolution ? ` · ${a.resolution}` : ''}
                        </span>
                        <span className="cost-attempt-money">
                          {formatSpend(a.actualCost ?? a.estimatedCost ?? 0, a.currency)}{' '}
                          {a.actualCost != null ? 'actual' : 'estimated'} · {a.status}
                        </span>
                        <span className="cost-attempt-when">
                          {new Date(a.createdAt).toLocaleString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
