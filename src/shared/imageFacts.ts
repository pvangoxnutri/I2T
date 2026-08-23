import type {
  AnalysisConfidence,
  CameraOrientation,
  PropertyAnalysis,
  RoomRecord
} from './propertyAnalysis'
import { imageAnalysis, roomOfImage } from './propertyAnalysis'

/**
 * WHAT WE KNOW ABOUT ONE PHOTOGRAPH, AND WHERE IT CAME FROM.
 *
 * ── WHY SOURCE IS PART OF THE VALUE ──────────────────────────────────
 *
 * The Image Inspector shows a room, an orientation, a list of doorways.
 * Some of that a vision model inferred; some of it a person typed because
 * the model got it wrong. Those two look identical on screen and mean
 * completely different things — one is a guess worth re-checking, the
 * other is a decision that must not be quietly reverted by the next run.
 *
 * So every displayable fact carries its own provenance, and the inspector
 * renders it. This is the same rule the transition prompts already follow:
 * a manual edit is a judgement, and re-analysis must never erase one
 * without saying so.
 *
 * ── OVERRIDES LIVE OUTSIDE THE ANALYSIS ──────────────────────────────
 *
 * Deliberately NOT stored inside the PropertyAnalysis document. Accepting
 * a new draft replaces that document wholesale, which is exactly the
 * behaviour the draft workflow needs — and exactly what would destroy a
 * manual correction. Overrides therefore live in their own table, keyed by
 * the project's own stable image id, and are layered on at read time.
 */

export type FactSource = 'analysis' | 'manual' | 'none'

export interface ImageOverride {
  projectId: string
  imageId: string
  /** Room label the operator chose. `null` = deliberately unassigned. */
  roomLabel?: string | null
  orientation?: CameraOrientation
  openings?: string[]
  landmarks?: string[]
  updatedAt: number
}

/** Which fields an override may carry. Used to clear one field at a time. */
export type OverrideField = 'roomLabel' | 'orientation' | 'openings' | 'landmarks'
export const OVERRIDE_FIELDS: OverrideField[] = [
  'roomLabel',
  'orientation',
  'openings',
  'landmarks'
]

export function hasOverride(override: ImageOverride | null, field: OverrideField): boolean {
  return override !== null && override[field] !== undefined
}

/** True when the operator has changed anything at all about this image. */
export function isOverridden(override: ImageOverride | null): boolean {
  return OVERRIDE_FIELDS.some((f) => hasOverride(override, f))
}

export interface Fact<T> {
  value: T
  source: FactSource
}

export interface ImageFacts {
  /** Room label, or null when nothing assigns one. */
  room: Fact<string | null>
  orientation: Fact<CameraOrientation>
  /** Openings visible HERE — the only basis for a move-through instruction. */
  openings: Fact<string[]>
  landmarks: Fact<string[]>
  /** Other images sharing part of the same space. Analysis-only. */
  overlapWith: string[]
  /** How sure the analyzer was about the room. Null once overridden. */
  roomConfidence: AnalysisConfidence | null
  /** False when no accepted analysis mentions this image at all. */
  analyzed: boolean
  /** True when any field is a manual override. */
  overridden: boolean
}

const fact = <T>(value: T, source: FactSource): Fact<T> => ({ value, source })

/**
 * The facts to SHOW for one image: accepted analysis, with any manual
 * override layered on top and labelled as such.
 */
export function imageFacts(
  analysis: PropertyAnalysis | null,
  imageId: string,
  override: ImageOverride | null
): ImageFacts {
  const entry = analysis ? imageAnalysis(analysis, imageId) : null
  const analyzedRoom = analysis ? (roomOfImage(analysis, imageId)?.label ?? null) : null
  const analyzed = entry !== null

  const roomOverridden = hasOverride(override, 'roomLabel')
  return {
    room: roomOverridden
      ? fact(override!.roomLabel ?? null, 'manual')
      : fact(analyzedRoom, analyzedRoom === null ? 'none' : 'analysis'),
    orientation: hasOverride(override, 'orientation')
      ? fact(override!.orientation!, 'manual')
      : fact(entry?.orientation ?? 'unknown', entry ? 'analysis' : 'none'),
    openings: hasOverride(override, 'openings')
      ? fact(override!.openings!, 'manual')
      : fact(entry?.openings ?? [], entry ? 'analysis' : 'none'),
    landmarks: hasOverride(override, 'landmarks')
      ? fact(override!.landmarks!, 'manual')
      : fact(entry?.landmarks ?? [], entry ? 'analysis' : 'none'),
    overlapWith: entry?.overlapWith ?? [],
    // A room the operator chose is not something the analyzer was
    // confident about, so the analyzer's confidence no longer describes it.
    roomConfidence: roomOverridden ? null : (entry?.roomConfidence ?? null),
    analyzed,
    overridden: isOverridden(override)
  }
}

const norm = (s: string): string => s.trim().toLowerCase()

/**
 * The analysis the PLANNER should read: accepted analysis with manual
 * overrides applied.
 *
 * ── ONE CODE PATH ────────────────────────────────────────────────────
 *
 * The alternative — teaching the planner about overrides — would mean
 * every safety rule needed a second version that also consults a side
 * table, and the two would drift. Folding the corrections in first means
 * `relateImages`, `planSequence` and every guard already written keep
 * working unchanged, and keep applying to the corrected picture.
 *
 * An override is a CORRECTION, not a new capability: everything it can set
 * is something the manual analysis editor could already set. In particular
 * it cannot bypass the visible-opening rule — it can only change what the
 * openings are said to be, exactly as typing them in the analysis panel
 * always could.
 */
export function applyImageOverrides(
  analysis: PropertyAnalysis,
  overrides: ImageOverride[]
): PropertyAnalysis {
  if (overrides.length === 0) return analysis

  const rooms: RoomRecord[] = analysis.rooms.map((r) => ({ ...r, imageIds: [...r.imageIds] }))
  const images = analysis.images.map((i) => ({ ...i }))

  /** The room for a label, reusing an existing one where the label matches. */
  const roomFor = (label: string): RoomRecord => {
    const existing = rooms.find((r) => norm(r.label) === norm(label))
    if (existing) return existing
    // A label the analysis never produced becomes a room of its own,
    // deliberately marked manual rather than pretending to be inferred.
    const created: RoomRecord = {
      id: `manual-room-${norm(label).replace(/[^a-z0-9]+/g, '-')}`,
      label: label.trim(),
      imageIds: [],
      landmarks: [],
      confidence: 'confirmed',
      notes: 'Assigned manually'
    }
    rooms.push(created)
    return created
  }

  for (const override of overrides) {
    let entry = images.find((i) => i.imageId === override.imageId)
    if (!entry) {
      // An image the analysis never covered can still be corrected by
      // hand — that is the whole point of an override on an unanalysed
      // project.
      entry = {
        imageId: override.imageId,
        roomId: null,
        orientation: 'unknown',
        landmarks: [],
        openings: []
      }
      images.push(entry)
    }

    if (override.roomLabel !== undefined) {
      // Detach from whichever room currently claims it, whatever that was.
      for (const room of rooms) {
        room.imageIds = room.imageIds.filter((id) => id !== override.imageId)
      }
      if (override.roomLabel === null) {
        entry.roomId = null
      } else {
        const room = roomFor(override.roomLabel)
        room.imageIds = [...new Set([...room.imageIds, override.imageId])]
        entry.roomId = room.id
      }
      entry.roomConfidence = undefined
    }
    if (override.orientation !== undefined) entry.orientation = override.orientation
    if (override.openings !== undefined) entry.openings = [...override.openings]
    if (override.landmarks !== undefined) entry.landmarks = [...override.landmarks]
  }

  return { ...analysis, rooms, images }
}
