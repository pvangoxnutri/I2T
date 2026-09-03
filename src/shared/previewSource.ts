import { defaultTransitionSettings, transitionKey, type Project, type TransitionSettings, type TransitionStatus } from './types'
import type { EditorSelection } from './editorSelection'
import { getFeedImages } from './feedSequence'

/**
 * WHAT THE MAIN PREVIEW SHOWS, decided once.
 *
 * ── WHY THIS IS NOT INSIDE THE COMPONENT ─────────────────────────────
 *
 * Two user-visible bugs came from this decision being spread across a
 * component's render body, where it could not be asserted:
 *
 *  - a transition whose settings row did not exist yet resolved to
 *    "nothing", so clicking it appeared to do nothing at all;
 *  - the still-image branch was correct but nothing proved it, so a
 *    layout fault that pushed the image off-screen looked identical to
 *    the image never being resolved.
 *
 * As a discriminated union the decision is a value: the component renders
 * it, and the tests pin it.
 */

export type PreviewSource =
  /** A selected photograph. Rendered `contain`; never stretched. */
  | { kind: 'image'; imageId: string; index: number; src: string; fileName: string }
  /** A selected transition that has a generated clip. */
  | { kind: 'clip'; pairKey: string; index: number; src: string }
  /**
   * A selected transition with no clip.
   *
   * NOT an empty state. The pair exists the moment two photographs are
   * adjacent — the settings row is written lazily — so this carries
   * everything needed to understand and act on it.
   */
  | {
      kind: 'transition-endpoints'
      pairKey: string
      index: number
      startSrc: string
      endSrc: string
      status: TransitionStatus
      canGenerate: boolean
    }
  /** The assembled editor preview, or null when none has been built. */
  | { kind: 'full'; src: string | null }
  /** A selection that no longer names anything — e.g. a stale pair key. */
  | { kind: 'unavailable'; reason: string }

/**
 * The settings for one pair, with defaults when no row exists yet.
 *
 * `project.transitions` is written LAZILY: a row appears the first time
 * something about that transition is edited. A freshly imported project
 * has thirty photographs, twenty-nine transitions and zero rows. Absence
 * means "not configured yet", never "does not exist" — conflating the two
 * is what made a transition click look like a no-op.
 */
export function transitionSettingsFor(
  project: Project,
  pairKey: string,
  defaultDurationSec: number
): TransitionSettings {
  return project.transitions[pairKey] ?? defaultTransitionSettings(defaultDurationSec)
}

/** The index of the pair in the CURRENT feed sequence, or -1 if not adjacent. */
export function pairIndexOf(project: Project, pairKey: string): number {
  const feedImages = getFeedImages(project)
  return feedImages.findIndex(
    (img, i) =>
      i < feedImages.length - 1 && transitionKey(img.id, feedImages[i + 1].id) === pairKey
  )
}

export function resolvePreviewSource(
  project: Project,
  selection: EditorSelection,
  assembledUrl: string | null,
  defaultDurationSec: number
): PreviewSource {
  if (selection.kind === 'full') return { kind: 'full', src: assembledUrl }

  if (selection.kind === 'image') {
    const feedImages = getFeedImages(project)
    const feedIndex = feedImages.findIndex((i) => i.id === selection.imageId)
    if (feedIndex === -1) {
      return { kind: 'unavailable', reason: 'That photograph is not in the Transition Feed.' }
    }
    const image = feedImages[feedIndex]
    return { kind: 'image', imageId: image.id, index: feedIndex, src: image.src, fileName: image.fileName }
  }

  const feedImages = getFeedImages(project)
  const index = pairIndexOf(project, selection.pairKey)
  if (index === -1) {
    // A reorder can leave a selection naming a pair that is no longer
    // adjacent. Said plainly rather than rendered as a blank frame.
    return {
      kind: 'unavailable',
      reason: 'This pair is no longer adjacent in the sequence.'
    }
  }

  const settings = transitionSettingsFor(project, selection.pairKey, defaultDurationSec)
  if (settings.clip) {
    return { kind: 'clip', pairKey: selection.pairKey, index, src: settings.clip.src }
  }

  return {
    kind: 'transition-endpoints',
    pairKey: selection.pairKey,
    index,
    startSrc: feedImages[index].src,
    endSrc: feedImages[index + 1].src,
    status: settings.status,
    // Generating while one is already in flight would submit a second
    // paid request for the same transition.
    canGenerate: settings.status !== 'queued' && settings.status !== 'generating'
  }
}

/** Status as a word. Colour alone would fail anyone who cannot see it. */
export function statusWordFor(status: TransitionStatus): string {
  switch (status) {
    case 'queued':
      return 'Queued'
    case 'generating':
      return 'Generating…'
    case 'failed':
      return 'Failed'
    case 'completed':
      return 'Ready'
    default:
      return 'Not generated'
  }
}
