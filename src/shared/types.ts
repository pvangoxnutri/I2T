/**
 * Core domain types for FrameToFrame.
 *
 * These shapes are written to survive the move to SQLite persistence and a
 * real job queue later: everything is plain serializable data, ids are
 * stable strings, and derived things (like which transitions exist) are
 * computed from image order rather than stored twice.
 */

import type { TransitionMode } from './transitionMode'
export type { TransitionMode }

// ── Images & transitions ─────────────────────────────────────────────────

export interface ProjectImage {
  id: string
  /** The user's original file name, for display. */
  fileName: string
  /** Unique file name inside the project's managed images directory. */
  storedName: string
  /** Display URL (custom f2f:// protocol served by the main process). */
  src: string
}

/**
 * AI generation state for one transition. Deliberately SEPARATE from clip
 * availability: a mock/failed generation never invents a video, and a
 * manually attached test clip counts as completed.
 */
export type GenerationStatus = 'not-generated' | 'queued' | 'generating' | 'completed' | 'failed'

/** Legacy alias — the transition's `status` field IS its generation state. */
export type TransitionStatus = GenerationStatus

/** Where a transition's output clip came from. The pipeline deliberately
 * does not care — Kling and future providers populate the SAME field the
 * manual test import uses today. */
export type ClipSource = 'manual' | 'kling' | 'fal'

/** A local output video associated with one transition pair. */
export interface TransitionClip {
  /** Unique file name inside the project's managed transitions directory. */
  storedName: string
  /** Original file name (manual imports) or a provider label. */
  originalName: string
  source: ClipSource
  /** Playable URL (custom f2f:// protocol served by the main process). */
  src: string
}

/** Historical record of one generation in the project catalogue. */
export interface GenerationRecord {
  id: string
  projectId: string
  fromImageId: string
  toImageId: string
  provider: string
  model: string | null
  createdAt: number
  status: 'completed' | 'failed' | 'cancelled'
  clip: TransitionClip | null
  promptUsed: string
  providerMeta: Record<string, unknown> | null
  generationCost: number | null
  generationCredits: number | null
  active: boolean
}

/** Settings for the AI transition between two specific images. Keyed by the
 * image PAIR so reordering unrelated images never loses a prompt. */
export interface TransitionSettings {
  prompt: string
  durationSec: number
  status: TransitionStatus
  /** The transition's local output video, when one exists. */
  clip: TransitionClip | null
  /**
   * Where this transition's prompt came from. Null means it has never been
   * planned — which is how every transition written before provenance
   * existed reads, and correctly allows a rebuild.
   *
   * The load-bearing field is `manuallyEdited`: once a human has written
   * the wording, rebuilding from Property Analysis must skip it.
   */
  promptProvenance?: PromptProvenance | null
  /**
   * Generated, cut or dissolved.
   *
   * ABSENT MEANS `auto`, which is what keeps the row lazy: a transition
   * nobody has configured stores nothing and lets the spatial evidence
   * decide. A stored value is a DECISION, and re-analysis never overwrites
   * one — see shared/transitionMode.ts.
   */
  mode?: TransitionMode
  /**
   * WHO CHOSE THAT MODE.
   *
   * A stored `mode` records WHAT was decided; this records who decided
   * it, and the two need separating because they carry different
   * permissions. An AI mode the analyzer proposed must be backed by an
   * accepted spatial map before money is spent on it — that map is the
   * whole reason it was proposed. An AI mode a human deliberately set is
   * their call to make on a property they may know better than the
   * photographs show, and is allowed through with a stated risk.
   *
   * ABSENT MEANS NOT MANUAL. Rows written before this field existed —
   * including eight that generated against an empty analysis — must not
   * read as deliberate human overrides, because `manual` is the
   * permissive branch. Only an explicit marker unlocks it.
   */
  modeProvenance?: 'analysis' | 'manual'
}

export const defaultTransitionSettings = (durationSec: number): TransitionSettings => ({
  prompt: '',
  durationSec,
  status: 'not-generated',
  clip: null,
  promptProvenance: null,
  mode: 'auto'
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

/**
 * Where a project sits in the internal production workflow. `draft`,
 * `ready`, `review` and `completed` are SET by the user and persisted;
 * `queued` and `generating` are DERIVED from live queue activity — see
 * shared/projectStatus.ts, the single place that decides.
 */
export type ProjectStatus = 'draft' | 'ready' | 'queued' | 'generating' | 'review' | 'completed'

/** Internal customer tracking only — no payment processing anywhere. */
export interface CustomerWorkflow {
  previewSentAt: number | null
  paidAt: number | null
  finalSentAt: number | null
}

/** Optional customer/property information for delivery and invoicing. */
export interface CustomerDetails {
  /** Customer or company name. */
  name?: string
  /** Primary contact person. */
  contactPerson?: string
  /** Contact email. */
  email?: string
  /** Contact phone. */
  phone?: string
  /** Additional notes or property address. */
  notes?: string
}

export interface Project {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  /** All imported images (library). */
  images: ProjectImage[]
  /** Ordered subset of image IDs that form the video sequence (Transition Feed).
   * If undefined, defaults to all images in order for backward compatibility. */
  feedSequence?: string[]
  /** Transition settings per image pair (see transitionKey). */
  transitions: Record<string, TransitionSettings>
  watermark: PreviewWatermark
  signature: BrandSignature
  /** Persisted, user-set status (never `queued`/`generating`). */
  status: ProjectStatus
  workflow: CustomerWorkflow
  /** Optional customer/property details for delivery. */
  customer?: CustomerDetails
}

// ── Queue ────────────────────────────────────────────────────────────────

export type JobStatus = 'scheduled' | 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled'

export type JobKind =
  | 'ai-generation'
  | 'transitions'
  | 'assembly'
  | 'preview-export'
  | 'final-export'

/** Everything a persisted job needs to run itself after a restart — no
 * closures, so a queued job survives app termination intact. */
export interface JobMetadata {
  /** Mock AI generation: orchestration only, never produces media. */
  mock?: boolean
  /** Transition pair keys an AI-generation job covers. */
  pairKeys?: string[]
  /** Export jobs: which branding layers apply and where output goes. */
  exportKind?: 'preview' | 'final'
  outputPath?: string
  /** Managed overlay PNG file names, composited in order. */
  overlayFiles?: string[]
  /**
   * Which shape this export renders to — see shared/exportFormat.
   *
   * Carried on the JOB rather than read from settings at run time, so a
   * queued export produces the format it was queued for. Absent on jobs
   * written before formats existed, which correctly read as the desktop
   * default.
   */
  exportFormat?: 'computer' | 'instagram'
  /** Provider attribution for AI work. */
  provider?: string
  model?: string
}

/**
 * Provider-side lifecycle for an AI generation job. Persisted in dedicated
 * columns so a future real generation survives an app restart: the remote
 * task keeps running on the provider, and the recovered job can resume
 * POLLING it rather than paying for a second submission.
 */
export interface ProviderJobState {
  provider: ProviderId
  model: string | null
  /** True while no network call may happen. */
  dryRun: boolean
  /** Remote task id — the idempotency anchor. Its presence means a task may
   * already exist provider-side and MUST NOT be blindly resubmitted. */
  providerTaskId: string | null
  /** Last status string reported by the provider. */
  providerStatus: string | null
  /**
   * WHY A PROVIDER CALL FAILED, classified rather than described.
   *
   * `terminal` is the load-bearing bit: it separates "the provider
   * refused this request" from "we lost contact with a task that may
   * still be running and is already paid for". Both look like a failed
   * job locally, and treating them alike is how a rejected request kept
   * offering Resume — which could only return the same rejection.
   *
   * Absent on jobs that never failed, and on jobs failed before this was
   * recorded; see `looksTerminalFromMessage` for the latter.
   */
  providerFailure?: {
    code: string
    message: string
    httpStatus?: number
    terminal: boolean
  } | null
  submittedAt: number | null
  lastPolledAt: number | null
  /** Sanitized provider response metadata (never credentials). */
  providerMeta: Record<string, unknown> | null
  /** MONEY. Null unless the provider publishes a verified conversion. */
  estimatedCost: number | null
  actualCost: number | null
  /** CREDITS — the provider's actual billing unit. Kept in its own columns
   * so the two are never confused with each other. */
  estimatedCredits: number | null
  actualCredits: number | null
  retryCount: number
}

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
  /** Position among jobs waiting to run — lower runs first. */
  queueOrder: number
  /** Local epoch ms the job becomes eligible; null = run as soon as possible. */
  scheduledFor: number | null
  startedAt: number | null
  completedAt: number | null
  /** Self-describing payload so a persisted job can run after a restart. */
  metadata: JobMetadata
  /** Human note — e.g. the failure reason for failed jobs. */
  note?: string
  /** Absolute path of the produced file, set when completed. */
  outputPath?: string
  /** Customer price snapshot taken when the job was created — NEVER
   * recalculated afterwards, so Settings changes cannot rewrite the value
   * of historical work. */
  price?: PriceSnapshot
  /** Provider lifecycle for AI generation jobs. */
  provider?: ProviderJobState
}

/**
 * What actually landed on disk for one transition of a generation job.
 *
 * "The remote task succeeded" and "the customer has a video" are different
 * facts, and the download between them can fail. The Queue needs both so a
 * job whose media never arrived is never presented as simply finished.
 */
export interface JobClipStatus {
  pairKey: string
  /** Human position in the sequence, e.g. "Image 2 → Image 3". */
  label: string
  storedName: string | null
  originalName: string | null
  source: ClipSource | null
  /** f2f:// url for playback, null when there is no clip row. */
  src: string | null
  /** Whether the bytes are really there — a row alone proves nothing. */
  exists: boolean
  bytes: number
}

// ── Pricing ──────────────────────────────────────────────────────────────

export type Currency = 'SEK' | 'EUR' | 'USD'

/** What we charge the CUSTOMER — unrelated to future AI/API costs. */
export interface PricingSettings {
  /** Price per project image (per photo, not per transition). ≥ 0. */
  pricePerImage: number
  currency: Currency
}

/** Frozen pricing attached to a job at creation time. */
export interface PriceSnapshot {
  pricePerImage: number
  imageCount: number
  currency: Currency
  totalPrice: number
}

/** Result of the FFmpeg availability probe. */
export interface FfmpegStatus {
  available: boolean
  version: string | null
  source: 'bundled' | 'system' | null
}

// ── Settings ─────────────────────────────────────────────────────────────

export type ProviderId = 'fal' | 'kling' | 'mock'

/** Offered in Settings, in the order they are presented. fal.ai leads: it
 * needs no large upfront API package, so it is the recommended default. */
export const SELECTABLE_PROVIDERS: { id: ProviderId; label: string; recommended?: boolean }[] = [
  { id: 'fal', label: 'fal.ai', recommended: true },
  { id: 'kling', label: 'Kling (direct API)' }
]

/**
 * Generation mode. `dry-run` is the default and the ONLY mode wired up in
 * milestone 5A: it validates and builds the exact request but performs no
 * HTTP call, uploads nothing and consumes no credits.
 */
export type ProviderMode = 'dry-run' | 'live'

/** One entry per AI video provider. The array shape lets more providers
 * slot in later without a migration. */
export interface AiProviderConfig {
  id: ProviderId
  label: string
  /** Modern Kling auth: sent as `Authorization: Bearer <apiKey>`. Empty by
   * default; never logged and never returned to the renderer. */
  apiKey: string
  /** Legacy Secret — NOT used by the current Kling API. Retained only so
   * older saved settings hydrate without loss. */
  legacySecret?: string
  mode: ProviderMode
  /** Selected model id from the provider's capability catalog. */
  model: string | null
}

/**
 * FrameToFrame policy: native audio is OFF unless a human turns it on.
 * Property tours are scored in post, and audio costs 50 % more per second.
 * Never flip this to enable audio implicitly.
 */
export const NATIVE_AUDIO_DEFAULT = false

import type { SeamBlend } from './seamBlend'
import type { PromptProvenance } from './promptPlanner'
export type { SeamBlend, PromptProvenance }

export type AspectRatio = '16:9' | '9:16' | '1:1' | '4:5'

export interface ExportDefaults {
  aspectRatio: AspectRatio
  resolution: '1080p' | '4K' | '720p'
  fps: 24 | 25 | 30 | 60
  defaultTransitionDurationSec: number
  /**
   * Seam handling between adjacent generated clips. OPTIONAL so settings
   * stored before this field existed keep loading unchanged — the
   * assembler applies the default. See shared/seamBlend.ts for why the
   * blend is measured in frames rather than as "a nice crossfade".
   */
  seamBlend?: SeamBlend
}

/**
 * Operator-supplied values for the parts of the provider contract that are
 * NOT confirmed in code. Base URL, submit endpoint and model id are verified
 * and LOCKED in application configuration — they are deliberately absent
 * here, so a stale override can never redirect a paid request.
 */
export interface ProviderContractOverrides {
  /** The one path still unverified. `{id}` is replaced with the task id. */
  taskStatusPath?: string
  /** The operator states they have seen the remaining unconfirmed items. */
  acknowledged: boolean
}

/** Production/orchestration knobs. */
export interface ProductionSettings {
  /** Prepared for future AI concurrency. FFmpeg stays at 1 regardless. */
  maxConcurrentAiGenerations: number
  /** DEV-ONLY mock rate for exercising the cost estimator. null = no rate
   * configured, and the UI must show a placeholder instead of a number. */
  mockAiCostPerSecond: number | null
  /**
   * SAFETY LOCK — enables paid Kling API requests. Default OFF. No live
   * request may happen while this is false, regardless of API key or mode.
   */
  allowLiveKlingRequests: boolean
  /**
   * SAFETY LOCK for fal.ai — separate from Kling's on purpose. Unlocking one
   * provider must never unlock the other.
   */
  allowLiveFalRequests: boolean
  /** Operator-verified transport contract for Kling. */
  klingContract: ProviderContractOverrides
  /**
   * SAFETY LOCK for whole-property analysis with Gemini. Separate from the
   * two video locks on purpose: unlocking video generation must never
   * unlock a vision provider, and vice versa. Default OFF, and no live
   * analysis can happen while it is false regardless of key or mode.
   *
   * Optional so settings rows written before the analyzer existed hydrate
   * to OFF rather than failing to parse.
   */
  allowLiveGeminiAnalysis?: boolean
}

/**
 * Whole-property analyzer configuration.
 *
 * Deliberately NOT an entry in `providers`: that list is video generation,
 * and a vision analyzer shares none of its shape — no model duration, no
 * resolution, no clip. Keeping them apart is what stops one provider's
 * safety state from being read as another's.
 */
export interface AnalyzerSettings {
  /** 'manual' | 'mock' | 'gemini'. */
  analyzerId: string
  /** Vendor model id. Isolated here so a stronger model is a settings change. */
  model: string
  /** Write-only from the renderer's perspective — never read back. */
  apiKey: string
  /** Dry Run builds and validates the request without sending it. */
  mode: ProviderMode
}

export interface AppSettings {
  providers: AiProviderConfig[]
  /** Which entry of `providers` the app generates with. Optional so older
   * settings rows hydrate: absent means "the first entry", the pre-fal
   * behaviour. */
  activeProviderId?: ProviderId
  exportDefaults: ExportDefaults
  /** Defaults applied to NEW projects' FrameToFrame signature. */
  defaultSignature: BrandSignature
  /** Customer pricing. */
  pricing: PricingSettings
  production: ProductionSettings
  /**
   * Whole-property analyzer. Optional so pre-analyzer settings rows
   * hydrate to the manual analyzer with no key and no live access.
   */
  analyzer?: AnalyzerSettings
}
