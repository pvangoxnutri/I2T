import type { PropertyAnalysis } from './propertyAnalysis'
import { planSequence, type TransitionPlan } from './transitionPlan'
import type { ReviewVerdict } from './analysisReview'
import { pairKeysFor } from './editorSelection'

/**
 * PROPERTY ANALYSIS, AT THE SIZE A PERSON ACTUALLY READS.
 *
 * ── THE PROBLEM THIS SOLVES ──────────────────────────────────────────
 *
 * The analysis panel grew to show everything it knew: every room, every
 * landmark, every camera orientation, a confidence control per connection,
 * the raw scene graph. All of it true, all of it available — and together
 * it buried the only two questions the operator has after pressing
 * Analyze: did it work, and is anything wrong?
 *
 * So the default view answers exactly those two, and the detail moves
 * behind Advanced. Nothing is removed; it stops being the first thing.
 *
 * ── THE COUNTS COME FROM THE PLANNER ─────────────────────────────────
 *
 * "9 transitions understood confidently" is derived from `planSequence` —
 * the same function that decides what the prompts say. A summary computed
 * from its own reading of the graph could reassure the operator about a
 * transition the planner had quietly given up on.
 */

export type AnalysisPhase = 'not-analyzed' | 'draft' | 'analyzed'

/**
 * How serious an issue is.
 *
 * There is deliberately no `blocking` level. Analysis is CONTEXT: a
 * transition with no spatial understanding still generates, using the base
 * cinematic prompt and inventing no navigation. Making review mandatory
 * would stall a working pipeline behind a form, and the safety rules that
 * actually matter enforce themselves in the planner regardless.
 */
export type IssueSeverity = 'warning' | 'info'

export interface AnalysisIssue {
  id: string
  severity: IssueSeverity
  /** What the operator should click to resolve it. */
  target: { kind: 'image'; imageId: string } | { kind: 'transition'; pairKey: string }
  title: string
  detail: string
}

export interface AnalysisSummary {
  phase: AnalysisPhase
  imageCount: number
  /** Rooms that actually hold at least one photograph. */
  spaceCount: number
  transitionCount: number
  /** Same room, or a confirmed connection. */
  confidentTransitions: number
  /** Unknown, or only probable. */
  uncertainTransitions: number
  /** Images with no room, after manual overrides. */
  unassignedImages: number
  /** Confirmed connections a reviewer rejected or doubted. */
  reviewBlockedTransitions: number
  issues: AnalysisIssue[]
}

/** A transition the planner understands well enough to act on. */
export function isConfidentPlan(plan: TransitionPlan): boolean {
  if (plan.relationType === 'SAME_ROOM') return true
  return plan.relationType === 'ADJACENT_ROOM' && plan.confidence === 'confirmed'
}

export function summarizeAnalysis(
  analysis: PropertyAnalysis | null,
  imageIds: string[],
  imageLabel: (imageId: string) => string,
  reviews?: Map<string, ReviewVerdict>
): AnalysisSummary {
  const pairKeys = pairKeysFor(imageIds)
  const hasAnalysis = analysis !== null && analysis.rooms.length > 0
  const phase: AnalysisPhase = !hasAnalysis
    ? 'not-analyzed'
    : analysis.state === 'draft' || analysis.state === 'needs-review'
      ? 'draft'
      : 'analyzed'

  const plans = planSequence(analysis, imageIds, reviews)
  const issues: AnalysisIssue[] = []

  // ── Images with nowhere to be ────────────────────────────────────────
  let unassignedImages = 0
  if (hasAnalysis) {
    for (const imageId of imageIds) {
      const entry = analysis.images.find((i) => i.imageId === imageId)
      if (entry?.roomId) continue
      unassignedImages++
      issues.push({
        id: `image-room:${imageId}`,
        severity: 'warning',
        target: { kind: 'image', imageId },
        title: `${imageLabel(imageId)} has no room`,
        detail:
          'Transitions touching this photo fall back to the base cinematic prompt. Assign a room in the Image inspector, or leave it — nothing is blocked.'
      })
    }
  }

  // ── Transitions the planner is not confident about ───────────────────
  let confidentTransitions = 0
  let uncertainTransitions = 0
  let reviewBlockedTransitions = 0

  plans.forEach((plan, i) => {
    const pairKey = pairKeys[i]
    if (!pairKey) return
    const label = `${imageLabel(plan.fromImageId)} → ${imageLabel(plan.toImageId)}`

    if (plan.reviewBlock) {
      reviewBlockedTransitions++
      issues.push({
        id: `review-block:${pairKey}`,
        severity: 'info',
        target: { kind: 'transition', pairKey },
        title: `${label} — navigation disabled by review`,
        detail: plan.reviewBlock
      })
    }

    if (isConfidentPlan(plan)) {
      confidentTransitions++
      return
    }
    uncertainTransitions++

    // ── AN UNANALYSED PROJECT IS NOT A LIST OF PROBLEMS ────────────────
    //
    // With no analysis every transition is UNKNOWN, so the loop above
    // would emit one warning per pair — a twelve-photo property would open
    // as eleven warnings before anyone had done anything wrong. That reads
    // as "this project is broken" when the truth is simply "nothing has
    // been analysed yet", which the headline and the readiness readout
    // already say once, in the right place.
    //
    // The COUNTS still reflect reality: every transition is uncertain, and
    // none is claimed as confident. Only the issue list stays quiet.
    if (!hasAnalysis) return

    issues.push(
      plan.relationType === 'UNKNOWN'
        ? {
            id: `transition-unknown:${pairKey}`,
            severity: 'warning',
            target: { kind: 'transition', pairKey },
            title: `${label} — spatial connection unknown`,
            detail:
              'No physical navigation will be invented. A safe cinematic transition is used instead.'
          }
        : {
            id: `transition-probable:${pairKey}`,
            severity: 'info',
            target: { kind: 'transition', pairKey },
            title: `${label} — connection only probable`,
            detail:
              'The rooms are believed adjacent but not confirmed, so the camera is not moved through an opening.'
          }
    )
  })

  return {
    phase,
    imageCount: imageIds.length,
    spaceCount: hasAnalysis ? analysis.rooms.filter((r) => r.imageIds.length > 0).length : 0,
    transitionCount: pairKeys.length,
    confidentTransitions,
    uncertainTransitions,
    unassignedImages,
    reviewBlockedTransitions,
    // Warnings first: an unknown connection is more actionable than a
    // note about a connection the planner already handled conservatively.
    issues: issues.sort((a, b) =>
      a.severity === b.severity ? 0 : a.severity === 'warning' ? -1 : 1
    )
  }
}

/**
 * HOW MUCH OF THE PROJECT THE ANALYSIS ACTUALLY COVERS.
 *
 * ── WHY THIS IS SEPARATE FROM THE IMAGE COUNT ────────────────────────
 *
 * "30 images" says how many the PROJECT has. It says nothing about how
 * many the analyzer placed, and an analyzer can return a structure that
 * omits photographs — a truncated response, or a model that could not
 * place a dark hallway. Reporting only the project total turns that
 * silence into a claim of whole-property completeness nobody checked.
 */
export interface AnalysisCoverage {
  total: number
  /** Images the accepted analysis actually assigns to a room. */
  covered: number
  missingImageIds: string[]
  complete: boolean
}

export function analysisCoverage(
  analysis: PropertyAnalysis | null,
  imageIds: string[]
): AnalysisCoverage {
  if (!analysis || analysis.rooms.length === 0) {
    return { total: imageIds.length, covered: 0, missingImageIds: [...imageIds], complete: false }
  }
  const missing = imageIds.filter(
    (id) => !analysis.images.find((i) => i.imageId === id)?.roomId
  )
  return {
    total: imageIds.length,
    covered: imageIds.length - missing.length,
    missingImageIds: missing,
    complete: missing.length === 0
  }
}

/**
 * The one-line headline for the summary card.
 *
 * "Property analyzed" whether or not there are warnings, on purpose. The
 * analysis DID succeed; a couple of uncertain connections is a normal
 * result, not a failure, and a headline that flipped to something alarming
 * would teach the operator to distrust a working run. The warnings get
 * their own line.
 */
export function summaryHeadline(summary: AnalysisSummary): string {
  if (summary.phase === 'not-analyzed') return 'Not analyzed'
  if (summary.phase === 'draft') return 'Draft awaiting review'
  return 'Property analyzed'
}

/** The reassuring second line, when there is genuinely nothing to fix. */
export function summarySubline(summary: AnalysisSummary): string {
  if (summary.phase === 'not-analyzed') {
    return 'Transitions use the base cinematic prompt, and no navigation is invented.'
  }
  const warnings = summary.issues.filter((i) => i.severity === 'warning').length
  if (warnings === 0) return 'No critical spatial issues found'
  return `${warnings} item${warnings === 1 ? '' : 's'} need${warnings === 1 ? 's' : ''} review`
}
