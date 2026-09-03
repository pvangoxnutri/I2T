import type { PropertyAnalysis } from './propertyAnalysis'

/**
 * THE WHOLE-PROPERTY ANALYZER CONTRACT.
 *
 * ── THE PROBLEM IT EXISTS FOR ────────────────────────────────────────
 *
 * A video model sees exactly two frames: start and end. It has no way to
 * know that Image 2 and Image 5 are the same living room from opposite
 * corners, or that the kitchen really is through the doorway on the
 * right. So it invents plausible-looking navigation — which, for a home
 * someone is selling, means a tour of a property that does not exist.
 *
 * Analysing ALL photos together is the only way to get that context, and
 * it has to happen before any transition is planned.
 *
 * ── PROVIDER-INDEPENDENT ON PURPOSE ──────────────────────────────────
 *
 * These types live in `shared` and mention no vendor. A future OpenAI,
 * Gemini, Claude or local-model analyzer implements the same interface
 * and everything downstream — scene graph, planner, UI — is unchanged.
 * Vendor code stays isolated behind it.
 *
 * NOTHING HERE CALLS ANYTHING. The only registered analyzers today are
 * manual and mock, both free and local.
 */

/** What an analyzer is being asked to work out. */
export type AnalysisCapability =
  | 'room-clustering'
  | 'room-labels'
  | 'shared-landmarks'
  | 'openings'
  | 'adjacency'
  | 'image-overlap'
  | 'camera-orientation'
  | 'confidence'
  | 'transition-hints'

export const ALL_CAPABILITIES: AnalysisCapability[] = [
  'room-clustering',
  'room-labels',
  'shared-landmarks',
  'openings',
  'adjacency',
  'image-overlap',
  'camera-orientation',
  'confidence',
  'transition-hints'
]

/**
 * One image, as the analyzer sees it.
 *
 * `ref` is a MANAGED reference (the f2f:// url), never a filesystem path.
 * A provider adapter resolves it to bytes itself; nothing that leaves this
 * process — least of all a debug preview — should carry a local path.
 */
export interface AnalyzerImageInput {
  imageId: string
  /** 1-based position in the walk-through sequence. */
  sequence: number
  fileName: string
  ref: string
}

export interface AnalyzerRequest {
  projectId: string
  projectName: string
  images: AnalyzerImageInput[]
  /** Analysis the operator has already accepted, if any. */
  existing: PropertyAnalysis | null
  /** Free-text context from the operator ("the balcony is off the kitchen"). */
  notes: string
  capabilities: AnalysisCapability[]
  /**
   * DECISIONS vs EVIDENCE.
   *
   * When present, this is the operator's chosen ordered feed, and the
   * ONLY transitions being decided are its adjacent pairs. `images` still
   * carries the whole imported library, because a photograph that will
   * never appear in the video can still prove two that will belong to the
   * same room.
   *
   * The distinction is the entire point of the Analyse Feed workflow: the
   * operator already chose the story, so the analyzer may explain that
   * story but never rewrite it. Absent means the older whole-library
   * analysis, which IS allowed to propose an ordering.
   */
  feedImageIds?: string[]
}

export interface AnalyzerCapabilities {
  roomDetection: boolean
  landmarkDetection: boolean
  openingDetection: boolean
  adjacencyInference: boolean
  orientationEstimation: boolean
  overlapDetection: boolean
  /** True when running it costs money. Manual and mock are false. */
  incursCost: boolean
  /** Whether the provider can reason over the whole set at once. */
  supportsMultipleImages: boolean
  /** Provider limit, when one is published. */
  maxImages: number | null
  /** Per-image byte ceiling, when one is published. */
  maxImageBytes: number | null
}

export interface AnalyzerMetadata {
  id: string
  displayName: string
  /** Vendor, or 'local' for manual/mock. */
  provider: string
  /** Model identifier, or null when there is no model. */
  model: string | null
  description: string
  capabilities: AnalyzerCapabilities
  /**
   * False until a provider is implemented AND verified. The UI offers
   * these but refuses to run them, so a half-finished adapter can never
   * be reached by accident.
   */
  available: boolean
  /**
   * A DEVELOPMENT TOOL, not a property analyzer.
   *
   * The mock produces a deterministic placeholder structure for exercising
   * the review workflow. It is genuinely useful for that and genuinely
   * useless as spatial understanding — thirty photographs in one unnamed
   * room with no landmarks, which then planned twenty-nine identical
   * camera moves.
   *
   * Listing it beside real analyzers made it possible to accept one by
   * accident and then treat the result as though the property had been
   * analysed. It is kept, and moved behind Developer / Testing.
   */
  developerOnly?: boolean
}

export interface AnalyzerCostEstimate {
  amount: number
  currency: string
  basis: string
}

export type AnalyzerValidation = { ok: true } | { ok: false; reasons: string[] }

export type AnalyzerResult =
  | { ok: true; analysis: PropertyAnalysis; notes: string[] }
  | { ok: false; reason: string }

/**
 * A request rendered for display. NEVER contains credentials, and never
 * contains a filesystem path — the same rule the video providers follow
 * for their sanitized request preview.
 */
export interface AnalyzerDebugPreview {
  analyzer: string
  provider: string
  model: string | null
  imageCount: number
  capabilities: AnalysisCapability[]
  /** The analysis instruction that would be sent. */
  instruction: string
  warnings: string[]
}
