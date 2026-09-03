import type { Project } from './types'
import type { AnalysisSummary } from './analysisSummary'
import { pairKeysFor } from './editorSelection'
import type { ModeTally } from './transitionMode'
import { getFeedImages } from './feedSequence'

/**
 * WHAT MATTERS NEXT — and nothing else.
 *
 * ── NOT THE SAME AS `projectReadiness` ───────────────────────────────
 *
 * `projectStatus.ts` already has a `projectReadiness`, answering a
 * narrower question: is this project assemblable — at least two images and
 * every clip present? That one genuinely gates something (export), and it
 * is deliberately left alone.
 *
 * This is the EDITOR's readout: five lines telling a person where they are
 * in the workflow. It gates nothing at all, which is why it is a separate
 * function with a separate name rather than a field bolted onto one that
 * does.
 *
 * ── NOT A WIZARD ─────────────────────────────────────────────────────
 *
 * A wizard implies steps that must be completed in order before the tool
 * will let you proceed. That is the opposite of what this app is: images
 * can be generated without analysis, order can be changed at any point,
 * and analysis review is optional by design. Gating any of that behind a
 * checklist would slow down the normal case to protect against a problem
 * the safety rules already handle.
 *
 * So this is a READOUT, not a gate. Five lines that say where the project
 * stands, with exactly one of them highlighted as the useful next move.
 * Nothing here disables a button anywhere.
 */

export type StepState =
  /** Done — nothing to do. */
  | 'done'
  /** Worth a look, but the project works without it. */
  | 'attention'
  /** Not started. */
  | 'todo'

export interface ReadinessStep {
  id: 'images' | 'sequence' | 'analysis' | 'review' | 'clips'
  state: StepState
  label: string
  /** Shown only when this is the highlighted next action. */
  hint?: string
}

export interface EditorReadiness {
  steps: ReadinessStep[]
  /** The one step worth doing next, or null when everything is done. */
  next: ReadinessStep | null
  /** Transitions with a clip, over transitions that exist. */
  clipsReady: number
  clipsTotal: number
}

export function editorReadiness(
  project: Project,
  summary: AnalysisSummary,
  /**
   * How each transition will behave. Without it every pair is assumed to
   * need a generated clip — which is what made a project of mostly cuts
   * report "27 transitions missing clips" and look permanently unfinished.
   */
  tally?: ModeTally
): EditorReadiness {
  // Distinguish between library (all imported) and sequence (video feed)
  const libraryCount = project.images.length
  const feedImages = getFeedImages(project)
  const feedImageIds = feedImages.map((i) => i.id)
  const pairs = pairKeysFor(feedImageIds)
  const withClips = tally ? tally.aiReady : pairs.filter((k) => project.transitions[k]?.clip).length
  // ONLY missing AI clips block a complete video. A cut is finished the
  // moment it is chosen; a crossfade is rendered locally by FFmpeg.
  //
  // WITHOUT THE TALLY WE DO NOT KNOW THE MODES, so we may not claim
  // anything is missing. The old fallback was `pairs.length - withClips`,
  // which counts every clipless pair — every cut included — as missing.
  // That is the same rule that made a finished feed look permanently
  // incomplete; guessing pessimistically is not better than waiting for
  // the real answer.
  const missingClips = tally ? tally.aiMissing : 0
  const warnings = summary.issues.filter((i) => i.severity === 'warning').length

  const steps: ReadinessStep[] = [
    {
      id: 'images',
      state: libraryCount > 0 ? 'done' : 'todo',
      label:
        libraryCount > 0
          ? `${libraryCount} image${libraryCount === 1 ? '' : 's'} imported`
          : 'Add images',
      hint: 'Drop property photos into the Media panel.'
    },
    {
      // The sequence is arranged the moment there is one in the feed —
      // there is no "correct" order to check against, only the operator's.
      id: 'sequence',
      state: feedImages.length > 0 ? 'done' : 'todo',
      label:
        feedImages.length > 0
          ? `${feedImages.length} image${feedImages.length === 1 ? '' : 's'} in sequence · ${pairs.length} transition${pairs.length === 1 ? '' : 's'}`
          : 'Arrange the sequence',
      hint: 'Drag photos from Imported Images to the Transition Feed.'
    },
    {
      id: 'analysis',
      state:
        summary.phase === 'analyzed' ? 'done' : summary.phase === 'draft' ? 'attention' : 'todo',
      label:
        summary.phase === 'analyzed'
          ? `Property analyzed · ${summary.spaceCount} space${summary.spaceCount === 1 ? '' : 's'}`
          : summary.phase === 'draft'
            ? 'Analysis draft awaiting review'
            : 'Property not analyzed',
      hint: 'Optional. Improves spatial accuracy; transitions still generate without it.'
    },
    {
      id: 'review',
      state: warnings > 0 ? 'attention' : 'done',
      label:
        warnings > 0
          ? `${warnings} item${warnings === 1 ? '' : 's'} need review`
          : 'No spatial issues',
      hint: 'Each one is safe to ignore — the planner already handles it conservatively.'
    },
    {
      id: 'clips',
      state: pairs.length === 0 ? 'todo' : missingClips > 0 ? 'attention' : 'done',
      label:
        pairs.length === 0
          ? 'No transitions yet'
          : missingClips > 0
            ? `${missingClips} AI clip${missingClips === 1 ? '' : 's'} missing`
            : tally
              ? `${tally.total} transitions · ${tally.ai} AI · ${tally.cut} cut${tally.cut === 1 ? '' : 's'}${tally.crossfade > 0 ? ` · ${tally.crossfade} crossfade` : ''}`
              : `All ${pairs.length} clip${pairs.length === 1 ? '' : 's'} generated`,
      hint: 'Generate from the transition inspector, one at a time. Cuts and crossfades need none.'
    }
  ]

  // The first UNFINISHED step in pipeline order, because that is the one
  // whose absence is holding up everything after it. An attention-state
  // step later on is not "next" while an earlier one is still not started.
  const next =
    steps.find((s) => s.state === 'todo') ?? steps.find((s) => s.state === 'attention') ?? null

  return { steps, next, clipsReady: withClips, clipsTotal: pairs.length }
}

