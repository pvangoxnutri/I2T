import type { PropertyAnalysis, TransitionSafety } from './propertyAnalysis'
import { planSequence, type TransitionPlan } from './transitionPlan'
import { recommendedMode } from './transitionMode'

/**
 * TRANSITION ANALYSIS FOR THE CURRENT FEED.
 *
 * ── ONE EVIDENCE GATE, NOT TWO ───────────────────────────────────────
 *
 * This module briefly had its own safety rules (`transitionSafetyGates`),
 * written as a parallel implementation of a decision the codebase already
 * made in one place. That copy was weaker in a way that mattered: it read
 * `landmarks` looking for the word "doorway" instead of the `openings`
 * field, which is the ONLY recorded basis for moving through one, and it
 * ignored room adjacency entirely. Two gates guarding the same door means
 * the weaker one decides.
 *
 * So the recommendation comes from `planSequence` + `recommendedMode` —
 * the same rules the planner, the timeline and the mode resolver use, and
 * the ones the smoke suite pins. Nothing here re-decides anything.
 *
 * ── THE DEFAULT IS ALWAYS CUT ────────────────────────────────────────
 *
 * `recommendedMode(null)` is a cut, an unknown relation is a cut, and an
 * unevidenced adjacency is a cut. There is no path through this function
 * that produces AI from missing data.
 */

export interface TransitionDraft {
  /** The operator's ordered feed, exactly as analysed. */
  feedImageIds: string[]
  /**
   * Every imported image at analysis time.
   *
   * Recorded because library images are EVIDENCE for this analysis even
   * when they never appear in the video: one of them may be what proves
   * two feed images share a room. If the library changes, that evidence
   * base changed, and the analysis is outdated even though the feed is
   * untouched. Staleness therefore needs both fingerprints, not one.
   */
  mediaImageIds?: string[]
  /** Which analyzer produced this, so a draft can be attributed. */
  analyzer?: string
  model?: string | null
  pairs: Array<{
    fromId: string
    toId: string
    recommendation: 'ai' | 'cut'
    safety: TransitionSafety | null
    prompt?: string
  }>
  createdAt: number
  /**
   * `declined` exists so a dismissed draft stays in history without coming
   * back as a pending review after a restart. Deleting it would lose the
   * record that an analysis was ever run.
   */
  status: 'draft' | 'accepted' | 'declined'
}

export interface TransitionAnalysisResult {
  draft: TransitionDraft | null
  error: string | null
}

/**
 * How sure the evidence is, in the vocabulary the review dialog speaks.
 *
 * A confirmed relation that still recommends a cut is `uncertain`, not
 * `safe`: "safe" here means safe TO GENERATE, and a cut was chosen
 * precisely because generating was not defensible.
 */
function safetyLevel(
  plan: TransitionPlan | null,
  recommendation: 'ai' | 'cut'
): TransitionSafety['level'] {
  if (recommendation === 'ai') return 'safe'
  if (!plan || plan.relationType === 'UNKNOWN') return 'unsafe'
  return 'uncertain'
}

/** The concrete visible facts behind a recommendation, never a summary. */
function evidenceFor(plan: TransitionPlan | null): string[] {
  if (!plan) return []
  const facts: string[] = []
  if (plan.sharedLandmarks.length > 0) {
    facts.push(`Shared in both frames: ${plan.sharedLandmarks.join(', ')}`)
  }
  if (plan.visibleOpenings.length > 0) {
    facts.push(`Opening visible in the start frame: ${plan.visibleOpenings.join(', ')}`)
  }
  if (plan.anchorLandmark) facts.push(`Anchor: ${plan.anchorLandmark}`)
  return facts
}

export function extractTransitionAnalysis(
  propertyAnalysis: PropertyAnalysis | null,
  feedImageIds: string[],
  timestamp: number
): TransitionAnalysisResult {
  if (!propertyAnalysis) {
    return { draft: null, error: 'No property analysis available' }
  }
  if (feedImageIds.length < 2) {
    return { draft: null, error: 'A transition needs at least two images in the feed' }
  }

  try {
    // Planned over the CURRENT feed only, so the pairs analysed are exactly
    // the pairs the video will contain.
    const plans = planSequence(propertyAnalysis, feedImageIds)
    const planFor = new Map(plans.map((p) => [`${p.fromImageId}->${p.toImageId}`, p]))

    const pairs: TransitionDraft['pairs'] = []
    for (let i = 0; i < feedImageIds.length - 1; i++) {
      const fromId = feedImageIds[i]
      const toId = feedImageIds[i + 1]
      const plan = planFor.get(`${fromId}->${toId}`) ?? null

      const { mode, reason } = recommendedMode(plan)
      const facts = evidenceFor(plan)

      pairs.push({
        fromId,
        toId,
        recommendation: mode,
        safety: {
          fromImageId: fromId,
          toImageId: toId,
          level: safetyLevel(plan, mode),
          // The rule's own words, plus the visible facts it rested on.
          reasoning: facts.length > 0 ? `${reason} (${facts.join('; ')})` : reason
        }
      })
    }

    return {
      draft: { feedImageIds: [...feedImageIds], pairs, createdAt: timestamp, status: 'draft' },
      error: null
    }
  } catch (err) {
    return {
      draft: null,
      error: err instanceof Error ? err.message : 'Could not derive transition analysis'
    }
  }
}
