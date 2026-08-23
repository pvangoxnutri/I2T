import type { CameraOrientation, PropertyAnalysis } from './propertyAnalysis'
import { imageAnalysis } from './propertyAnalysis'

/**
 * WHAT WE ACTUALLY KNOW ABOUT ONE PAIR OF PHOTOGRAPHS.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────
 *
 * The planner used to write motion words first and reason backwards:
 * every same-room pair got `slow forward dolly, slight clockwise
 * rotation`, and the "clockwise" came from a helper that returned
 * clockwise when it had nothing to go on. Thirty photographs in one
 * unsorted room produced twenty-nine byte-identical prompts, each
 * confidently naming a direction nobody had observed.
 *
 * That is fabricated spatial information, and it is the exact failure mode
 * this whole subsystem exists to prevent — a video that turns the wrong
 * way through a home someone is selling.
 *
 * So evidence is gathered FIRST, as facts, and the wording is rendered
 * from it afterwards. Where a fact is not available the field says
 * `unknown` rather than carrying a plausible default.
 */

export type RotationDirection = 'clockwise' | 'counter-clockwise' | 'none' | 'unknown'
export type TranslationDirection = 'forward' | 'lateral' | 'none' | 'unknown'

/** Compass headings in clockwise order. The only orientations that can
 *  yield a turn DIRECTION; the rest describe facing, not bearing. */
const COMPASS: CameraOrientation[] = ['north', 'east', 'south', 'west']

export interface PairEvidence {
  fromImageId: string
  toImageId: string
  startOrientation: CameraOrientation
  endOrientation: CameraOrientation
  /** Landmarks visible in BOTH — the anchor a camera move can hold on. */
  sharedLandmarks: string[]
  /** Visible in the start frame and not the end: the camera turned away. */
  leavingLandmarks: string[]
  /** Visible in the end frame and not the start: the camera turned toward. */
  enteringLandmarks: string[]
  /** Openings visible in the START frame. The only basis for moving through one. */
  startOpenings: string[]
  /** True when the analysis records these two as overlapping viewpoints. */
  overlaps: boolean
  /** Image ids this evidence was actually drawn from. */
  evidenceImageIds: string[]
}

const norm = (s: string): string => s.trim().toLowerCase()

function diff(a: string[], b: string[]): string[] {
  const inB = new Set(b.map(norm))
  return a.filter((x) => !inB.has(norm(x)))
}

function intersect(a: string[], b: string[]): string[] {
  const inB = new Set(b.map(norm))
  return a.filter((x) => inB.has(norm(x)))
}

export function gatherPairEvidence(
  analysis: PropertyAnalysis | null,
  fromImageId: string,
  toImageId: string
): PairEvidence {
  const start = analysis ? imageAnalysis(analysis, fromImageId) : null
  const end = analysis ? imageAnalysis(analysis, toImageId) : null

  const startLandmarks = start?.landmarks ?? []
  const endLandmarks = end?.landmarks ?? []

  return {
    fromImageId,
    toImageId,
    startOrientation: start?.orientation ?? 'unknown',
    endOrientation: end?.orientation ?? 'unknown',
    sharedLandmarks: intersect(startLandmarks, endLandmarks),
    leavingLandmarks: diff(startLandmarks, endLandmarks),
    enteringLandmarks: diff(endLandmarks, startLandmarks),
    startOpenings: start?.openings ?? [],
    overlaps:
      (start?.overlapWith ?? []).includes(toImageId) ||
      (end?.overlapWith ?? []).includes(fromImageId),
    // Only ids that actually contributed something.
    evidenceImageIds: [start ? fromImageId : null, end ? toImageId : null].filter(
      (x): x is string => x !== null
    )
  }
}

/**
 * Which way the camera turned — derived, never assumed.
 *
 * ── THE RULES, AND WHY THEY STOP WHERE THEY DO ───────────────────────
 *
 * Only two compass headings can produce a direction, because only a
 * bearing has a sense of rotation. One step around the compass is a
 * quarter turn and its direction is unambiguous.
 *
 * A HALF TURN IS DELIBERATELY `unknown`. North to south is 180°, and
 * there is no evidence anywhere in the analysis saying whether the camera
 * swung left or right to get there. Picking one would look identical to
 * knowing, which is precisely the mistake being corrected here.
 *
 * `into-room` and `out-of-room` describe what the camera FACES, not a
 * bearing, so they yield no rotation at all — not a default one.
 */
export function deriveRotation(
  start: CameraOrientation,
  end: CameraOrientation
): RotationDirection {
  const a = COMPASS.indexOf(start)
  const b = COMPASS.indexOf(end)
  if (a === -1 || b === -1) return 'unknown'
  const steps = (b - a + 4) % 4
  if (steps === 0) return 'none'
  if (steps === 1) return 'clockwise'
  if (steps === 3) return 'counter-clockwise'
  // steps === 2: a half turn. Which way round is genuinely unrecorded.
  return 'unknown'
}

/**
 * How the camera moved through space.
 *
 * `forward` is claimed ONLY when the camera is travelling through an
 * opening it can actually see — that is the one case where the direction
 * of travel is established by evidence rather than by convention.
 *
 * `lateral` means the viewpoint moved but the direction is not
 * determinable: two overlapping views of one room, or a shared anchor seen
 * from a new angle. It says "the camera repositioned" without inventing
 * left or right, because nothing in a scene graph records which.
 */
export function deriveTranslation(
  evidence: PairEvidence,
  navigatingThroughOpening: boolean
): TranslationDirection {
  if (navigatingThroughOpening) return 'forward'
  if (evidence.overlaps) return 'lateral'
  if (evidence.sharedLandmarks.length > 0) return 'lateral'
  return 'unknown'
}

/**
 * Whether anything specific to THIS pair was found.
 *
 * False means every downstream field is a default, and the planner must
 * fall back to neutral wording rather than describing a camera path it
 * cannot support.
 */
export function hasPairEvidence(
  evidence: PairEvidence,
  rotation: RotationDirection,
  translation: TranslationDirection
): boolean {
  return (
    evidence.sharedLandmarks.length > 0 ||
    evidence.enteringLandmarks.length > 0 ||
    evidence.leavingLandmarks.length > 0 ||
    evidence.startOpenings.length > 0 ||
    rotation === 'clockwise' ||
    rotation === 'counter-clockwise' ||
    translation === 'forward' ||
    translation === 'lateral'
  )
}

/** Human wording for an orientation, for the inspector's evidence list. */
export function orientationLabel(o: CameraOrientation): string {
  switch (o) {
    case 'into-room':
      return 'Facing into the room'
    case 'out-of-room':
      return 'Facing out of the room'
    case 'unknown':
      return 'Not recorded'
    default:
      return `Facing ${o}`
  }
}
