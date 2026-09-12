import type { Project, TransitionClip } from './types'
import type { PromptProvenance } from './promptPlanner'

/**
 * A VIDEO SEGMENT MADE FROM ONE PHOTOGRAPH.
 *
 * ── WHY THIS IS ITS OWN TYPE ─────────────────────────────────────────
 *
 * The feed is a list of image ids, and every segment is DERIVED from
 * adjacency: position i means the pair (feed[i], feed[i+1]), keyed by
 * `"fromId->toId"`. There is no segment list to add to, which is why a
 * single-image clip has nowhere to live in that model.
 *
 * The tempting shortcut is `A -> A`. It is not safe here, and the reasons
 * are specific rather than stylistic:
 *
 *   • `feedPairAt` locates a pair by finding `feed[i] === from` AND
 *     `feed[i+1] === to`, so `A -> A` would require the photograph to
 *     appear twice in the feed — changing what the video shows.
 *   • The spatial analysis reasons about adjacent pairs. `A -> A` would
 *     enter that reasoning as evidence that a room connects to itself.
 *   • Assembly emits `images - 1` transitions. A duplicated image adds a
 *     still to the timeline that nobody asked for.
 *   • `transitionKey(A, A)` is a legitimate-looking key that every
 *     existing consumer would treat as a transition.
 *
 * So motion segments live in their own list with their own ids, and
 * nothing that reasons about pairs can see them.
 *
 * ── ORDERING ─────────────────────────────────────────────────────────
 *
 * A motion segment plays immediately AFTER its anchor image is shown and
 * before the transition that leaves it. The anchor's still is replaced by
 * the motion clip rather than added to — the clip already shows that
 * photograph, and holding the still as well would show it twice.
 */

export type MotionType =
  | 'smooth-forward'
  | 'push-in'
  | 'pull-out'
  | 'pan-left'
  | 'pan-right'
  | 'turn-left'
  | 'turn-right'

/**
 * ── SMOOTH FORWARD vs SLOW PUSH IN ───────────────────────────────────
 *
 * These are two different physical things, and the old wording blurred
 * them. `push-in` asked for "forward, with MINIMAL PERSPECTIVE CHANGE" —
 * which is a contradiction: real forward travel through a room changes
 * perspective, because near objects slide past faster than far ones.
 * Asking for forward motion without that parallax is a description of a
 * DIGITAL ZOOM, and that is what it tended to produce.
 *
 * They are kept separate rather than merged, because both are real
 * real-estate moves and an operator wants to choose:
 *
 *   SMOOTH FORWARD — the viewpoint TRAVELS. It moves through the room,
 *   past the doorway, with the parallax that implies. This is the
 *   "walk slowly forward" the product was missing.
 *
 *   SLOW PUSH IN — the framing TIGHTENS. The viewpoint barely moves;
 *   the shot closes in on the subject. Near-static, no meaningful
 *   parallax, the counterpart to Slow Pull Out.
 *
 * The labels say which is which so the choice is not a guess, and the
 * two prompts now contradict each other rather than overlapping: one
 * demands parallax, the other explicitly does not travel. `pull-out`
 * keeps its meaning as push-in's mirror, so nothing is orphaned.
 */
export const MOTION_LABEL: Record<MotionType, string> = {
  'smooth-forward': 'Smooth Forward (move through room)',
  'push-in': 'Slow Push In (tighten framing)',
  'pull-out': 'Slow Pull Out (widen framing)',
  'pan-left': 'Pan Left',
  'pan-right': 'Pan Right',
  'turn-left': 'Turn Left',
  'turn-right': 'Turn Right'
}

/**
 * The same movements, named short.
 *
 * The labels above carry a parenthetical because a PICKER is where the
 * Smooth Forward / Push In distinction has to be unmissable. A timeline
 * block is not a picker: it is a badge a few characters wide, and
 * "SINGLE IMAGE · SLOW PUSH IN (TIGHTEN FRAMING)" does not belong in
 * one. Same keys, so the two can never drift to different sets.
 */
export const MOTION_SHORT_LABEL: Record<MotionType, string> = {
  'smooth-forward': 'Smooth Forward',
  'push-in': 'Slow Push In',
  'pull-out': 'Slow Pull Out',
  'pan-left': 'Pan Left',
  'pan-right': 'Pan Right',
  'turn-left': 'Turn Left',
  'turn-right': 'Turn Right'
}

/**
 * The order they are offered in.
 *
 * Smooth Forward first: it is the move an operator reaches for most, and
 * burying it under two framing adjustments is how the product ended up
 * without an obvious "go forward".
 */
export const MOTION_TYPES: MotionType[] = [
  'smooth-forward',
  'push-in',
  'pull-out',
  'pan-left',
  'pan-right',
  'turn-left',
  'turn-right'
]

/**
 * How long a new motion clip is, before anyone changes it.
 *
 * Five seconds because that is the shortest length every registered fal
 * model offers, so the default never depends on which model is selected.
 */
export const DEFAULT_MOTION_SECONDS = 5

export interface MotionSegment {
  /** Own key space. Never a pairKey — nothing may mistake it for one. */
  id: string
  kind: 'single-motion'
  /** The ONE photograph this clip is made from. */
  imageId: string
  motion: MotionType
  durationSec: number
  status: 'not-generated' | 'queued' | 'generating' | 'completed' | 'failed'
  clip: TransitionClip | null
  prompt: string
  promptProvenance?: PromptProvenance | null
  createdAt: number
}

/** The id namespace, so a motion id is recognisable anywhere it appears. */
export const MOTION_ID_PREFIX = 'motion:'

export function isMotionSegmentId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(MOTION_ID_PREFIX)
}

export function makeMotionSegmentId(): string {
  return `${MOTION_ID_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Every motion segment in the project, in feed order.
 *
 * Absent on every project written before this existed, which reads as
 * "none" — the backwards-compatible answer.
 */
export function motionSegments(project: Project): MotionSegment[] {
  return project.motionSegments ?? []
}

/** The motion segments anchored to one image, in the order they were added. */
export function motionSegmentsForImage(project: Project, imageId: string): MotionSegment[] {
  return motionSegments(project)
    .filter((s) => s.imageId === imageId)
    .sort((a, b) => a.createdAt - b.createdAt)
}

export function findMotionSegment(project: Project, id: string): MotionSegment | undefined {
  return motionSegments(project).find((s) => s.id === id)
}

/**
 * How a motion segment reads in the feed.
 *
 * Text, never an icon alone: an operator must be able to tell at a glance
 * that this item is one photograph moving rather than a journey between
 * two rooms. Mistaking the two is the failure this labelling exists to
 * prevent.
 */
export function motionSegmentLabel(segment: MotionSegment): string {
  // The SHORT name: this is a badge, not a picker. See MOTION_SHORT_LABEL.
  return `SINGLE IMAGE · ${MOTION_SHORT_LABEL[segment.motion].toUpperCase()}`
}
