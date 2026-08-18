/**
 * Core domain types for FrameToFrame.
 *
 * These shapes are written to survive the move to SQLite persistence and a
 * real job queue later: everything is plain serializable data, ids are
 * stable strings, and derived things (like which transitions exist) are
 * computed from image order rather than stored twice.
 */

// ── Images & transitions ─────────────────────────────────────────────────

export interface ProjectImage {
  id: string
  fileName: string
  /** Local object URL / data URL for display. Later: a file path on disk. */
  src: string
}

export type TransitionStatus = 'not-generated' | 'queued' | 'processing' | 'completed' | 'failed'

/** Settings for the AI transition between two specific images. Keyed by the
 * image PAIR so reordering unrelated images never loses a prompt. */
export interface TransitionSettings {
  prompt: string
  durationSec: number
  status: TransitionStatus
}

export const defaultTransitionSettings = (durationSec: number): TransitionSettings => ({
  prompt: '',
  durationSec,
  status: 'not-generated'
})

export const transitionKey = (fromImageId: string, toImageId: string): string =>
  `${fromImageId}->${toImageId}`

// ── Branding ─────────────────────────────────────────────────────────────

export type WatermarkPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'center-left'
  | 'center'
  | 'center-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right'

export type CornerPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/** Large watermark shown on PREVIEW exports (before the customer has paid).
 * Removed entirely on the final export. */
export interface PreviewWatermark {
  enabled: boolean
  imageSrc: string | null
  imageName: string | null
  position: WatermarkPosition
  /** Percent of video width. */
  sizePct: number
  /** 0–100. */
  opacityPct: number
}

/** Small permanent FrameToFrame signature — separate from the preview
 * watermark, designed to sit subtly in a corner on EVERY export. */
export interface BrandSignature {
  enabled: boolean
  logoSrc: string | null
  logoName: string | null
  brandName: string
  websiteUrl: string
  position: CornerPosition
  /** Percent of video width. */
  sizePct: number
  /** 0–100. */
  opacityPct: number
}

// ── Project ──────────────────────────────────────────────────────────────

export interface Project {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  images: ProjectImage[]
  /** Transition settings per image pair (see transitionKey). */
  transitions: Record<string, TransitionSettings>
  watermark: PreviewWatermark
  signature: BrandSignature
}

// ── Queue ────────────────────────────────────────────────────────────────

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed'

export type JobKind = 'transitions' | 'assembly' | 'preview-export' | 'final-export'

/** One unit of future work. Multiple projects can queue multiple jobs; the
 * scheduler that drains this list arrives in a later milestone. */
export interface QueueJob {
  id: string
  projectId: string
  projectName: string
  kind: JobKind
  status: JobStatus
  /** 0–100, only meaningful while processing. */
  progressPct: number
  transitionCount: number
  createdAt: number
  /** Human note — e.g. the failure reason for failed jobs. */
  note?: string
}

// ── Settings ─────────────────────────────────────────────────────────────

/** One entry per AI video provider. Kling is first; the array shape is what
 * lets more providers slot in later without a migration. */
export interface AiProviderConfig {
  id: 'kling'
  label: string
  apiKey: string
  apiSecret: string
}

export type AspectRatio = '16:9' | '9:16' | '1:1' | '4:5'

export interface ExportDefaults {
  aspectRatio: AspectRatio
  resolution: '1080p' | '4K' | '720p'
  fps: 24 | 25 | 30 | 60
  defaultTransitionDurationSec: number
}

export interface AppSettings {
  providers: AiProviderConfig[]
  exportDefaults: ExportDefaults
  /** Defaults applied to NEW projects' FrameToFrame signature. */
  defaultSignature: BrandSignature
}
