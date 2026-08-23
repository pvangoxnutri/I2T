import { useCallback, useEffect, useState } from 'react'
import type { PropertyAnalysis } from '../../../../shared/propertyAnalysis'
import type { ReviewScope, ReviewVerdict } from '../../../../shared/analysisReview'
import type { ReviewFactsPayload } from '../../../../preload/index'

/**
 * GROUND-TRUTH REVIEW — was the analysis actually right?
 *
 * ── A TOOL, NOT A SURVEY ─────────────────────────────────────────────
 *
 * Every reviewable fact is one line with three tiny buttons. A form with
 * headings and paragraphs per fact would be honest and unusable: an
 * eighteen-image property has thirty-odd facts, and anything that takes
 * more than a glance-and-click per fact simply will not get filled in.
 * The rows are dense and scroll inside their own box for that reason.
 *
 * ── IT EVALUATES; IT DOES NOT EDIT ───────────────────────────────────
 *
 * Marking a connection Incorrect records a judgement. It does not delete
 * the edge, reassign an image or touch the draft in any way — correcting
 * the analysis is done in Rooms/Connections above, deliberately as a
 * separate action. If clicking Incorrect also removed the edge, an
 * operator measuring accuracy would be destroying the thing measured, and
 * the next run's numbers would describe a set nobody analysed.
 *
 * Nothing here is transmitted. There is no channel that sends a verdict
 * to a provider, and the analyzer never sees one.
 */

const VERDICTS: Array<{ value: ReviewVerdict; glyph: string; title: string }> = [
  { value: 'correct', glyph: '✓', title: 'Correct' },
  { value: 'incorrect', glyph: '✗', title: 'Incorrect' },
  { value: 'unsure', glyph: '?', title: 'Unsure' }
]

export function GroundTruthReview({
  projectId,
  scope,
  analysis,
  onReviewed
}: {
  projectId: string
  scope: ReviewScope
  analysis: PropertyAnalysis
  /** Accepted-scope verdicts feed the planner, so the caller re-reads. */
  onReviewed?: () => void
}): React.JSX.Element {
  const [data, setData] = useState<ReviewFactsPayload | null>(null)
  const [open, setOpen] = useState(scope === 'draft')

  const load = useCallback((): void => {
    void window.f2f.projects.review.facts(projectId, scope, analysis).then(setData)
  }, [projectId, scope, analysis])

  useEffect(load, [load])

  const set = (
    factKey: string,
    kind: ReviewFactsPayload['facts'][number]['kind'],
    label: string,
    current: ReviewVerdict,
    next: ReviewVerdict
  ): void => {
    // Clicking the active verdict clears it — the only way back to
    // Unreviewed, and better than a fourth button nobody would use.
    const verdict = current === next ? 'unreviewed' : next
    void window.f2f.projects.review
      .set(projectId, scope, factKey, kind, label, verdict)
      .then(() => {
        load()
        onReviewed?.()
      })
  }

  if (!data || data.facts.length === 0) return <></>
  const { summary } = data

  return (
    <div className="review-block">
      <div className="review-head">
        <button type="button" className="review-toggle" onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'} Ground-truth review
        </button>
        <span className="review-counts">
          Reviewed: {summary.reviewed} / {summary.total}
        </span>
        <span className="review-tally">
          <span className="review-tally-correct">✓ {summary.correct}</span>
          <span className="review-tally-incorrect">✗ {summary.incorrect}</span>
          <span className="review-tally-unsure">? {summary.unsure}</span>
        </span>
        {/* Unsure is in neither the numerator nor the denominator. */}
        {summary.accuracyPct !== null && (
          <span
            className={`review-accuracy${summary.sampleTooSmall ? ' is-weak' : ''}`}
            title="Correct ÷ (Correct + Incorrect). Unsure is excluded from both."
          >
            {summary.accuracyPct}% of {summary.correct + summary.incorrect}
          </span>
        )}
      </div>

      {summary.sampleTooSmall && open && (
        <p className="review-caveat">
          Too few judged facts to mean anything — this is a running tally, not a measurement of the
          analyzer.
        </p>
      )}

      {open && (
        <>
          <div className="review-rows">
            {data.facts.map((fact) => (
              <div
                key={fact.factKey}
                className={`review-row${fact.highRisk ? ' is-high-risk' : ''} verdict-${fact.verdict}`}
              >
                <span className="review-row-label" title={fact.label}>
                  {fact.highRisk && (
                    <span
                      className="review-risk-dot"
                      title="A confirmed connection — this one can license camera movement through a doorway."
                    >
                      ●
                    </span>
                  )}
                  {fact.label}
                </span>
                <span className="review-verdicts">
                  {VERDICTS.map((v) => (
                    <button
                      key={v.value}
                      type="button"
                      title={v.title}
                      aria-label={`${fact.label}: ${v.title}`}
                      aria-pressed={fact.verdict === v.value}
                      className={`review-vote review-vote-${v.value}${
                        fact.verdict === v.value ? ' is-active' : ''
                      }`}
                      onClick={() => set(fact.factKey, fact.kind, fact.label, fact.verdict, v.value)}
                    >
                      {v.glyph}
                    </button>
                  ))}
                </span>
              </div>
            ))}
          </div>

          <p className="review-note">
            Review records a judgement only — it never changes the analysis. Correct a fact in Rooms
            / Connections above. A connection marked Incorrect or Unsure does disable physical
            navigation across it.
          </p>
        </>
      )}
    </div>
  )
}

/**
 * The warning that belongs NEXT TO the transition plans: connections the
 * analyzer called confirmed and a human did not back up. Rendered by the
 * panel, kept here so the wording lives with the review model.
 */
export function UnvalidatedConnectionWarning({
  items
}: {
  items: Array<{ factKey: string; label: string; verdict: ReviewVerdict }>
}): React.JSX.Element {
  if (items.length === 0) return <></>
  return (
    <p className="review-warning">
      ⚠ {items.length} confirmed connection{items.length === 1 ? '' : 's'} ({' '}
      {items.map((i) => `${i.label} — ${i.verdict}`).join('; ')} ) {items.length === 1 ? 'is' : 'are'}{' '}
      not backed up by review. Physical navigation is disabled across{' '}
      {items.length === 1 ? 'it' : 'them'}.
    </p>
  )
}
