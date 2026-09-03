/**
 * WHOLE-PROPERTY ANALYSIS — what the app understands about a property as a
 * whole, rather than one image pair at a time.
 *
 * ── WHY ──────────────────────────────────────────────────────────────
 *
 * Today every transition is planned in isolation: two images, one generic
 * cinematic prompt. The model is never told that Image 2 and Image 5 are
 * the same living room from opposite corners, or that the kitchen is
 * genuinely through the doorway visible on the right. So it invents
 * plausible-looking navigation, which is exactly where AI video goes
 * wrong for real estate — a corridor that does not exist, a door that
 * opens onto the wrong room.
 *
 * ── CONFIDENCE IS PART OF THE MODEL, NOT A FOOTNOTE ──────────────────
 *
 * An inferred layout is a guess, and the cost of a confident wrong guess
 * is a video that misrepresents a property being sold. So confidence is
 * required on every relationship, and `unknown` is a first-class answer
 * that the prompt planner is required to respect: no visible doorway, no
 * instruction to move through one.
 *
 * ── NOT SLAM ─────────────────────────────────────────────────────────
 *
 * This is a scene GRAPH, not geometry. Rooms, which images belong to
 * them, what is visibly shared, and how confident we are. No 3D
 * reconstruction, no metric camera poses. Enough to plan a camera move;
 * deliberately not enough to pretend we surveyed the flat.
 *
 * Provider-independent on purpose — see PropertyAnalyzer. Nothing here
 * calls a model.
 */

/** How much visual evidence stands behind a claim. */
export type AnalysisConfidence = 'confirmed' | 'probable' | 'unknown'

// Analyzer metadata moved to `analyzerTypes.ts` when the provider
// architecture landed — it grew a provider, a model, image limits and an
// `available` flag, none of which belong to the domain model. Re-exported
// so existing imports keep working.
export type { AnalyzerCapabilities, AnalyzerMetadata } from './analyzerTypes'
import type { AnalysisProvenance } from './analysisWorkflow'
export type { AnalysisProvenance }

/** Where the analysis came from. Manual is a real, supported answer. */
export type AnalysisSource = 'manual' | 'mock' | 'provider'

/** Coarse camera facing, good enough to plan a rotation direction. */
export type CameraOrientation =
  | 'unknown'
  | 'north'
  | 'east'
  | 'south'
  | 'west'
  | 'into-room'
  | 'out-of-room'

export interface RoomRecord {
  id: string
  /** Display label — "Living Room", "Balcony". Operator-editable. */
  label: string
  /** Project image ids assigned to this room, in no particular order. */
  imageIds: string[]
  /** Things visible in more than one of this room's images. */
  landmarks: string[]
  /** How sure we are these images really are one room. */
  confidence?: AnalysisConfidence
  /**
   * Marketing importance of this room as a selling point. 0-10 scale.
   * Pool, patio, or spectacular views: 9-10.
   * Primary social spaces (living, dining, kitchen): 8-9.
   * Master suite: 7-8.
   * Secondary spaces: 5-7.
   * Functional/utility: 2-4.
   */
  marketingImportance?: number
  notes?: string
}

export interface ImageAnalysis {
  imageId: string
  roomId: string | null
  /** How sure we are this image belongs to that room. */
  roomConfidence?: AnalysisConfidence
  orientation: CameraOrientation
  /** Named objects visible in this image. */
  landmarks: string[]
  /** Openings visible in THIS image — the only basis for "move through". */
  openings: string[]
  /**
   * Other images sharing a region of the same space. Overlap is what makes
   * a camera move between two viewpoints plausible, so it is recorded
   * separately from room membership: two photos can be the same room with
   * no overlap at all (opposite corners, facing away).
   */
  overlapWith?: string[]
  /**
   * Marketing importance score 0-10. Used to prioritize highlights and
   * selling points in feed order. A pool, spectacular view, or strong USP
   * would score 9-10. Functional spaces score 2-4.
   */
  marketingImportance?: number
  /** Hero/highlight status. True for standout images that should be featured prominently. */
  isHero?: boolean
  notes?: string
}

export interface RoomEdge {
  id: string
  fromRoomId: string
  toRoomId: string
  confidence: AnalysisConfidence
  /** Image ids that actually show the connection. */
  supportingImageIds: string[]
  /**
   * Images in which the opening itself is VISIBLE. Distinct from
   * `supportingImageIds`: an adjacency can be supported by continuous
   * flooring or a shared landmark without any image actually showing the
   * doorway — and only a visible doorway licenses "move through it".
   */
  visibleOpeningImageIds?: string[]
  /** Human reason — "balcony doors visible behind the sofa". */
  notes?: string
}

/**
 * Safety assessment for a specific image-to-image transition.
 * Replaces vague "probable" with explicit safety levels.
 */
export interface TransitionSafety {
  fromImageId: string
  toImageId: string
  /** safe: strong visual evidence supports this transition without invented geometry
   *  uncertain: evidence is weak or requires inference
   *  unsafe: would require invented/hidden geometry */
  level: 'safe' | 'uncertain' | 'unsafe'
  /** Short explanation of why (e.g., "Same sofa and window visible in both frames" or "No visible path between pool and interior") */
  reasoning: string
  /** Visualconfidence 0-1 based on overlap, shared landmarks, visible openings */
  visualOverlap?: number
  /** Risk of hallucinated geometry 0-1 */
  hallucinationRisk?: number
}

/**
 * Optional planner hints an analyzer may volunteer. Advisory only — the
 * planner's own confidence rules always win, so a hint can never talk it
 * into navigation the evidence does not support.
 */
export interface TransitionHint {
  fromImageId: string
  toImageId: string
  suggestedMotion?: string
  anchorLandmark?: string
  notes?: string
  /** Safety level: safe, uncertain, or unsafe */
  safetyLevel?: 'safe' | 'uncertain' | 'unsafe'
}

/**
 * Where an analysis stands in the review workflow.
 *
 * An analyzer result NEVER becomes the accepted analysis on its own — a
 * bad automatic run must not silently destroy assignments someone made by
 * hand. It arrives as a draft, gets compared, and is accepted explicitly.
 */
export type AnalysisState = 'not-analyzed' | 'draft' | 'needs-review' | 'accepted'

export interface PropertyAnalysis {
  projectId: string
  /** Bumped whenever the shape changes so stored documents stay readable. */
  version: 1
  source: AnalysisSource
  updatedAt: number
  /** Absent on documents written before the review workflow existed. */
  state?: AnalysisState
  /** Which analyzer produced this, when one did. */
  analyzerId?: string
  /**
   * WHERE THIS CAME FROM — provider, model, and whether it was a real
   * request or a mock.
   *
   * Stored WITH the document rather than beside it, so it cannot drift
   * from the analysis it describes and cannot be lost by a settings
   * change. It exists to answer one question without reading logs: was
   * this actually analyzed by a vision model, or is it a placeholder that
   * looks like one? Absent on documents written before it existed.
   */
  provenance?: AnalysisProvenance
  rooms: RoomRecord[]
  images: ImageAnalysis[]
  edges: RoomEdge[]
  /** Advisory planner hints. The planner's rules still win. */
  transitionHints?: TransitionHint[]
}

export function emptyAnalysis(projectId: string): PropertyAnalysis {
  return {
    projectId,
    version: 1,
    source: 'manual',
    updatedAt: 0,
    state: 'not-analyzed',
    rooms: [],
    images: [],
    edges: [],
    transitionHints: []
  }
}

/**
 * Parse a stored document defensively.
 *
 * A malformed or half-written analysis must degrade to "we know nothing"
 * — which the planner already handles safely — rather than throwing and
 * taking the project editor down with it.
 */
export function parseAnalysis(projectId: string, json: string | null): PropertyAnalysis {
  if (!json) return emptyAnalysis(projectId)
  try {
    const raw = JSON.parse(json) as Partial<PropertyAnalysis>
    const rooms = Array.isArray(raw.rooms) ? raw.rooms : []
    return {
      projectId,
      version: 1,
      source: raw.source ?? 'manual',
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
      // Documents written before the review workflow existed have no
      // state. Anything with rooms was, by definition, in use — so it is
      // treated as accepted rather than demoted to a draft under someone.
      state: raw.state ?? (rooms.length > 0 ? 'accepted' : 'not-analyzed'),
      analyzerId: raw.analyzerId,
      // Absent on documents written before provenance existed. Left
      // undefined rather than invented: claiming an unknown analysis was
      // "manual" would be a guess presented as a fact, and the whole point
      // of this field is that it can be trusted.
      provenance: raw.provenance,
      rooms,
      images: Array.isArray(raw.images) ? raw.images : [],
      edges: Array.isArray(raw.edges) ? raw.edges : [],
      transitionHints: Array.isArray(raw.transitionHints) ? raw.transitionHints : []
    }
  } catch {
    return emptyAnalysis(projectId)
  }
}

export function serializeAnalysis(analysis: PropertyAnalysis): string {
  return JSON.stringify(analysis)
}

// ── Queries the prompt planner needs ───────────────────────────────────

export function roomOfImage(analysis: PropertyAnalysis, imageId: string): RoomRecord | null {
  const entry = analysis.images.find((i) => i.imageId === imageId)
  if (!entry?.roomId) return null
  return analysis.rooms.find((r) => r.id === entry.roomId) ?? null
}

export function imageAnalysis(analysis: PropertyAnalysis, imageId: string): ImageAnalysis | null {
  return analysis.images.find((i) => i.imageId === imageId) ?? null
}

/** The edge joining two rooms, in either direction. */
export function edgeBetween(
  analysis: PropertyAnalysis,
  roomA: string,
  roomB: string
): RoomEdge | null {
  return (
    analysis.edges.find(
      (e) =>
        (e.fromRoomId === roomA && e.toRoomId === roomB) ||
        (e.fromRoomId === roomB && e.toRoomId === roomA)
    ) ?? null
  )
}

/** Landmarks visible in BOTH images — the anchor a camera move can hold on. */
export function sharedLandmarks(
  analysis: PropertyAnalysis,
  startImageId: string,
  endImageId: string
): string[] {
  const a = imageAnalysis(analysis, startImageId)
  const b = imageAnalysis(analysis, endImageId)
  if (!a || !b) return []
  const inB = new Set(b.landmarks.map((l) => l.toLowerCase()))
  return a.landmarks.filter((l) => inB.has(l.toLowerCase()))
}

/**
 * The spatial relationship between two images, as far as we can honestly
 * claim it. This is the single question the prompt planner asks.
 */
export type SpatialRelation =
  | { kind: 'same-room'; room: RoomRecord; shared: string[] }
  | {
      kind: 'adjacent-room'
      from: RoomRecord
      to: RoomRecord
      confidence: AnalysisConfidence
      /** Openings visible in the START image — never assumed. */
      openings: string[]
    }
  | { kind: 'unknown' }

export function relateImages(
  analysis: PropertyAnalysis,
  startImageId: string,
  endImageId: string
): SpatialRelation {
  const from = roomOfImage(analysis, startImageId)
  const to = roomOfImage(analysis, endImageId)
  if (!from || !to) return { kind: 'unknown' }

  if (from.id === to.id) {
    return { kind: 'same-room', room: from, shared: sharedLandmarks(analysis, startImageId, endImageId) }
  }

  const edge = edgeBetween(analysis, from.id, to.id)
  if (!edge || edge.confidence === 'unknown') return { kind: 'unknown' }

  return {
    kind: 'adjacent-room',
    from,
    to,
    confidence: edge.confidence,
    // Only openings the START image actually shows. An edge marked
    // confirmed still does not license "walk through the doorway" if no
    // doorway is visible from where the camera is standing.
    openings: imageAnalysis(analysis, startImageId)?.openings ?? []
  }
}
