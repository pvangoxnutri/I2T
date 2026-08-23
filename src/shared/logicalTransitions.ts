import { defaultTransitionSettings, transitionKey, type Project, type TransitionSettings } from './types'

/**
 * THE TRANSITIONS A PROJECT HAS.
 *
 * ── THE INVARIANT ────────────────────────────────────────────────────
 *
 * A transition is defined by two ADJACENT ORDERED IMAGES. For N images
 * there are always exactly N − 1 of them. Thirty photographs is
 * twenty-nine transitions, whether or not anything has ever been stored
 * about any of them.
 *
 * ── THE BUG THIS EXISTS TO END ───────────────────────────────────────
 *
 * `project.transitions` is written LAZILY — a row appears the first time
 * something about a transition is edited or generated. Code that iterated
 * that map, or that walked the pairs but skipped any without a row,
 * silently saw only the configured ones. "Rebuild transition prompts"
 * offered 2 of 29 on a thirty-image project, and the other 27 did not
 * appear as unchanged or preserved — they simply did not exist as far as
 * the dialog was concerned.
 *
 * Absence of a row means "unconfigured", never "does not exist". Deriving
 * the list in one place makes that impossible to get wrong twice.
 *
 * ── STILL LAZY ───────────────────────────────────────────────────────
 *
 * This creates no rows. `settings` is the stored record where one exists
 * and defaults where none does, so callers can read every transition
 * without twenty-nine rows appearing merely because a dialog listed them.
 */

export interface LogicalTransition {
  startImageId: string
  endImageId: string
  pairKey: string
  /** 0-based index in the sequence. `position + 1` → `position + 2` reads. */
  position: number
  /** Human label, e.g. "Image 4 → Image 5". */
  label: string
  /** The stored record, when there is one. Undefined means unconfigured. */
  persisted?: TransitionSettings
  /** Stored record or defaults — always usable. */
  settings: TransitionSettings
}

/**
 * Every transition in the project, in sequence order.
 *
 * The ONE derivation. Anything that needs the list of transitions asks
 * here rather than reading the map, so no caller can quietly disagree
 * with another about how many there are.
 */
export function logicalTransitions(
  project: Project,
  defaultDurationSec: number
): LogicalTransition[] {
  const out: LogicalTransition[] = []
  for (let i = 0; i < project.images.length - 1; i++) {
    const start = project.images[i]
    const end = project.images[i + 1]
    const pairKey = transitionKey(start.id, end.id)
    const persisted = project.transitions[pairKey]
    out.push({
      startImageId: start.id,
      endImageId: end.id,
      pairKey,
      position: i,
      label: `Image ${i + 1} → Image ${i + 2}`,
      persisted,
      settings: persisted ?? defaultTransitionSettings(defaultDurationSec)
    })
  }
  return out
}

/** How many transitions a project has. Always images − 1, never fewer. */
export function logicalTransitionCount(project: Project): number {
  return Math.max(0, project.images.length - 1)
}

/**
 * Rows stored for pairs that are no longer adjacent.
 *
 * A reorder can leave these behind. They are NOT deleted — a prompt
 * someone wrote is worth keeping in case the order comes back — but they
 * must never be counted as transitions, which is the mirror image of the
 * bug above.
 */
export function strandedTransitionKeys(project: Project): string[] {
  const live = new Set(
    logicalTransitions(project, 5).map((t) => t.pairKey)
  )
  return Object.keys(project.transitions).filter((k) => !live.has(k))
}
