import type { Project } from './types'
import type { AnalysisSummary } from './analysisSummary'
import { pairKeysFor } from './editorSelection'

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
  summary: AnalysisSummary
): EditorReadiness {
  const imageIds = project.images.map((i) => i.id)
  const pairs = pairKeysFor(imageIds)
  const withClips = pairs.filter((k) => project.transitions[k]?.clip).length
  const missingClips = pairs.length - withClips
  const warnings = summary.issues.filter((i) => i.severity === 'warning').length

  const steps: ReadinessStep[] = [
    {
      id: 'images',
      state: project.images.length > 0 ? 'done' : 'todo',
      label:
        project.images.length > 0
          ? `${project.images.length} image${project.images.length === 1 ? '' : 's'} added`
          : 'Add images',
      hint: 'Drop property photos into the Media panel.'
    },
    {
      // The sequence is arranged the moment there is one to arrange —
      // there is no "correct" order to check against, only the operator's.
      id: 'sequence',
      state: pairs.length > 0 ? 'done' : 'todo',
      label:
        pairs.length > 0
          ? `Sequence arranged · ${pairs.length} transition${pairs.length === 1 ? '' : 's'}`
          : 'Arrange the sequence',
      hint: 'Drag photos in the timeline. The order is the video.'
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
            ? `${missingClips} transition${missingClips === 1 ? '' : 's'} missing clips`
            : `All ${pairs.length} clip${pairs.length === 1 ? '' : 's'} generated`,
      hint: 'Generate from the transition inspector, one at a time.'
    }
  ]

  // The first UNFINISHED step in pipeline order, because that is the one
  // whose absence is holding up everything after it. An attention-state
  // step later on is not "next" while an earlier one is still not started.
  const next =
    steps.find((s) => s.state === 'todo') ?? steps.find((s) => s.state === 'attention') ?? null

  return { steps, next, clipsReady: withClips, clipsTotal: pairs.length }
}

