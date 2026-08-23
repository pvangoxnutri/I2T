import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppSettings,
  FfmpegStatus,
  JobClipStatus,
  Project,
  ProjectImage,
  ProjectStatus,
  QueueJob,
  TransitionClip
} from '../shared/types'
import type { PropertyAnalysis } from '../shared/propertyAnalysis'
import type { AnalyzerDebugPreview, AnalyzerMetadata } from '../shared/analyzerTypes'
import type { AnalysisDiff } from '../shared/analysisDiff'
import type { TransitionPlan } from '../shared/transitionPlan'
import type {
  AccuracySummary,
  ReviewableFact,
  ReviewEntry,
  ReviewFactKind,
  ReviewScope,
  ReviewVerdict
} from '../shared/analysisReview'

import type { RebuildPlanSummary, TransitionPromptPlan } from '../shared/promptPlanner'
import type { GenerationCostEntry, ProjectSpendSummary } from '../shared/costLedger'
import type { CompareAssemblyResult } from '../shared/seamBlend'
import type { ImageFacts, ImageOverride, OverrideField } from '../shared/imageFacts'
import type { AnalyzerStatus } from '../shared/analysisWorkflow'

export interface ReviewFactsPayload {
  facts: Array<ReviewableFact & { verdict: ReviewVerdict }>
  summary: AccuracySummary
  /** Confirmed connections the reviewer has rejected or doubted. */
  unvalidatedConfirmed: Array<{ factKey: string; label: string; verdict: ReviewVerdict }>
}

/** What the paid-analysis confirmation shows. Never carries a key. */
export interface AnalysisConfirmationPayload {
  ok: boolean
  blockers: string[]
  analyzer: string
  provider: string
  model: string | null
  imageCount: number
  imageRange: string
  incursCost: boolean
  /** True when a REAL, billable request is about to be sent. */
  paidLive: boolean
  /** False means the cost figure is NOT dependable and says so. */
  rateVerified: boolean
  estimatedCostLabel: string
  estimatedCostBasis: string
  hasAcceptedAnalysis: boolean
  warning: string
  /** One-shot. `analysis.run` consumes it; a second click is refused. */
  token: string | null
}

/**
 * The ONLY bridge between the sandboxed renderer and the privileged main
 * process. Every capability is an explicit, typed function — the renderer
 * has no Node, no fs, no database and no process spawning of its own.
 */

export interface ImportFilePayload {
  sourcePath?: string
  bytes?: ArrayBuffer
  name: string
}

/** Mirrors the provider capability metadata, minus anything sensitive. */
export interface ProviderMetadataPayload {
  id: string
  label: string
  models: {
    id: string
    label: string
    startFrame: boolean
    endFrame: boolean
    durationsSec: number[]
    resolutions: string[]
    nativeAudio: boolean
    confirmed: boolean
    verificationNote?: string
  }[]
  supportsRemoteCancel: boolean
  docsUrl?: string
}

/** A request rendered for display — never contains credentials. */
export interface SanitizedRequestPreview {
  provider: string
  model: string
  endpoint: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown>
  display: { startImage: string; endImage: string; durationSec: number; resolution: string }
  dryRun: boolean
  warnings: string[]
}

/** Everything shown before a PAID request is sent. */
export interface LiveConfirmationPayload {
  ok: boolean
  reasons: string[]
  projectName: string
  transitionLabel: string
  provider: string
  model: string
  durationSec: number
  resolution: string
  nativeAudio: boolean
  /** The prompt that will actually be sent. */
  prompt: string
  /** Managed f2f:// thumbnails of the exact frames being sent. */
  startImage: { name: string; src: string } | null
  endImage: { name: string; src: string } | null
  /** API cost in the provider's billing unit, e.g. "40 credits" or "$0.42". */
  estimatedCostLabel: string
  /** How that number was reached, e.g. "5s × $0.084/s". */
  estimatedCostBasis: string
  /** The customer's project price — a different concept entirely. */
  customerPriceLabel: string
  warning: string
  /** 1 = first generation of this pair; 2+ = a regeneration. */
  attemptNumber: number
  isRegeneration: boolean
  /** What THIS generation adds to production spend, or 'unavailable'. */
  additionalCostLabel: string
  /** Production spend on this project so far, in the provider's currency. */
  spentSoFarLabel: string
  /** Spend after this generation, or 'unavailable' with no verified rate. */
  projectedAfterLabel: string
}

export interface ExportOverlaysPayload {
  watermarkPng?: ArrayBuffer | null
  signaturePng?: ArrayBuffer | null
}

export type ExportStartResult =
  | { ok: true; jobId: string }
  | { ok: false; canceled: true }
  | { ok: false; canceled?: false; missing: string[]; reason: string }

const api = {
  platform: process.platform as string,

  /** Real OS path for a picked/dropped File (empty string if unavailable). */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  projects: {
    list: (): Promise<Project[]> => ipcRenderer.invoke('projects:list'),
    save: (project: Project): Promise<void> => ipcRenderer.invoke('projects:save', project),
    delete: (projectId: string): Promise<void> => ipcRenderer.invoke('projects:delete', projectId),
    setStatus: (projectId: string, status: ProjectStatus): Promise<void> =>
      ipcRenderer.invoke('projects:setStatus', projectId, status),
    /**
     * A project changed in the MAIN process — a generation finished, a clip
     * was downloaded and attached, a status moved. Returns an unsubscribe
     * function, like queue.onChanged.
     *
     * This is the channel that was missing. Work completing asynchronously
     * has no user click to hang a refresh off, so without a push the
     * renderer kept rendering whatever it loaded when the view mounted.
     */
    onUpdated: (callback: (project: Project) => void): (() => void) => {
      const listener = (_e: unknown, project: Project): void => callback(project)
      ipcRenderer.on('project:updated', listener)
      return () => ipcRenderer.removeListener('project:updated', listener)
    },
    /**
     * Whole-property analysis. READ/WRITE ONLY — no analyzer is invoked
     * anywhere behind these channels, so nothing here can reach a paid
     * vision model.
     */
    analysis: {
      get: (projectId: string): Promise<PropertyAnalysis> =>
        ipcRenderer.invoke('analysis:get', projectId),
      /**
       * The accepted analysis with manual corrections folded in — what the
       * inspectors and the planner read. `get` stays raw so the draft diff
       * describes what the analyzer actually proposed.
       */
      effective: (projectId: string): Promise<PropertyAnalysis> =>
        ipcRenderer.invoke('analysis:effective', projectId),
      save: (analysis: PropertyAnalysis): Promise<PropertyAnalysis> =>
        ipcRenderer.invoke('analysis:save', analysis),
      /** What this transition's prompt WOULD become. Writes nothing. */
      planPrompt: (
        projectId: string,
        startImageId: string,
        endImageId: string
      ): Promise<TransitionPromptPlan> =>
        ipcRenderer.invoke('analysis:planPrompt', projectId, startImageId, endImageId),
      /** Counts + previews for a rebuild. Writes nothing. */
      planRebuild: (projectId: string): Promise<RebuildPlanSummary> =>
        ipcRenderer.invoke('analysis:planRebuild', projectId),
      rebuildPrompts: (
        projectId: string
      ): Promise<{ rebuiltCount: number; preservedCount: number }> =>
        ipcRenderer.invoke('analysis:rebuildPrompts', projectId),
      /** Replaces ONE transition's prompt, custom wording included. */
      useAnalysisPrompt: (
        projectId: string,
        pairKey: string
      ): Promise<{ ok: boolean; replacedManualPrompt: boolean }> =>
        ipcRenderer.invoke('analysis:useAnalysisPrompt', projectId, pairKey),
      /** Available analyzers. None of them calls a paid service. */
      analyzers: (): Promise<AnalyzerMetadata[]> => ipcRenderer.invoke('analysis:analyzers'),
      /**
       * What the configured analyzer IS — provider, model, mode, and
       * whether a key exists. Never the key. One call, so the panel cannot
       * disagree with itself about whether a run would be live.
       */
      status: (projectId: string, analyzerId: string): Promise<AnalyzerStatus | null> =>
        ipcRenderer.invoke('analysis:status', projectId, analyzerId),
      /**
       * Run one. The result is returned for review, never auto-saved —
       * an analyzer must not silently replace hand-entered rooms.
       */
      /**
       * `token` comes from `confirmation` and is REQUIRED for a paid live
       * run. It is consumed on use, so a double-clicked button cannot
       * submit twice.
       */
      run: (
        projectId: string,
        analyzerId: string,
        notes = '',
        token?: string
      ): Promise<
        { ok: true; analysis: PropertyAnalysis; notes: string[] } | { ok: false; reason: string }
      > => ipcRenderer.invoke('analysis:run', projectId, analyzerId, notes, token),
      /** Credential-free, path-free rendering of what would be sent. */
      preview: (projectId: string, analyzerId: string): Promise<AnalyzerDebugPreview | null> =>
        ipcRenderer.invoke('analysis:preview', projectId, analyzerId),
      /** Structured plan for every transition, for the plan review list. */
      transitionPlans: (projectId: string): Promise<TransitionPlan[]> =>
        ipcRenderer.invoke('analysis:transitionPlans', projectId),
      /** What a draft would change about the accepted analysis. */
      diff: (projectId: string, draft: PropertyAnalysis): Promise<AnalysisDiff> =>
        ipcRenderer.invoke('analysis:diff', projectId, draft),
      /** Everything the paid-analysis confirmation dialog needs. */
      confirmation: (
        projectId: string,
        analyzerId: string
      ): Promise<AnalysisConfirmationPayload | null> =>
        ipcRenderer.invoke('analysis:confirmation', projectId, analyzerId)
    },
    /**
     * Analyzer configuration. The API key is WRITE-ONLY: there is no
     * channel that returns it, only one that says whether it exists.
     */
    analyzerConfig: {
      setApiKey: (apiKey: string): Promise<boolean> =>
        ipcRenderer.invoke('analyzer:setApiKey', apiKey),
      hasApiKey: (): Promise<boolean> => ipcRenderer.invoke('analyzer:hasApiKey'),
      models: (): Promise<{ id: string; label: string; note: string }[]> =>
        ipcRenderer.invoke('analyzer:models')
    },
    /**
     * Ground-truth review — LOCAL evaluation metadata. There is no
     * channel here that transmits any of it.
     */
    review: {
      list: (projectId: string, scope: ReviewScope): Promise<ReviewEntry[]> =>
        ipcRenderer.invoke('review:list', projectId, scope),
      facts: (
        projectId: string,
        scope: ReviewScope,
        analysis: PropertyAnalysis
      ): Promise<ReviewFactsPayload> =>
        ipcRenderer.invoke('review:facts', projectId, scope, analysis),
      set: (
        projectId: string,
        scope: ReviewScope,
        factKey: string,
        kind: ReviewFactKind,
        label: string,
        verdict: ReviewVerdict
      ): Promise<void> =>
        ipcRenderer.invoke('review:set', projectId, scope, factKey, kind, label, verdict),
      promoteDraft: (projectId: string): Promise<void> =>
        ipcRenderer.invoke('review:promoteDraft', projectId),
      clearDraft: (projectId: string): Promise<void> =>
        ipcRenderer.invoke('review:clearDraft', projectId)
    },
    /**
     * Manual corrections to analysis-derived image facts. Stored apart from
     * the analysis document so accepting a new draft cannot erase one.
     */
    overrides: {
      list: (projectId: string): Promise<ImageOverride[]> =>
        ipcRenderer.invoke('override:list', projectId),
      set: (
        projectId: string,
        imageId: string,
        field: OverrideField,
        value: string | string[] | null
      ): Promise<ImageOverride | null> =>
        ipcRenderer.invoke('override:set', projectId, imageId, field, value),
      /** "Use analyzed value" — one field, or all of them. */
      clear: (
        projectId: string,
        imageId: string,
        field?: OverrideField
      ): Promise<ImageOverride | null> =>
        ipcRenderer.invoke('override:clear', projectId, imageId, field),
      facts: (projectId: string, imageId: string): Promise<ImageFacts> =>
        ipcRenderer.invoke('override:facts', projectId, imageId)
    },
    /**
     * OUR production spend — provider currency, never the customer price.
     */
    cost: {
      entries: (projectId: string): Promise<GenerationCostEntry[]> =>
        ipcRenderer.invoke('cost:entries', projectId),
      summary: (projectId: string): Promise<ProjectSpendSummary> =>
        ipcRenderer.invoke('cost:summary', projectId)
    },
    /** Internal customer tracking only — no payment processing. */
    markWorkflow: (
      projectId: string,
      field: 'previewSentAt' | 'paidAt' | 'finalSentAt',
      value: number | null
    ): Promise<void> => ipcRenderer.invoke('projects:markWorkflow', projectId, field, value)
  },

  images: {
    import: (projectId: string, items: ImportFilePayload[]): Promise<ProjectImage[]> =>
      ipcRenderer.invoke('images:import', projectId, items),
    remove: (projectId: string, storedName: string): Promise<void> =>
      ipcRenderer.invoke('images:remove', projectId, storedName)
  },

  settings: {
    get: (): Promise<AppSettings | null> => ipcRenderer.invoke('settings:get'),
    save: (settings: AppSettings): Promise<void> => ipcRenderer.invoke('settings:save', settings)
  },

  ffmpeg: {
    status: (): Promise<FfmpegStatus> => ipcRenderer.invoke('ffmpeg:status')
  },

  clips: {
    /** Opens the native picker and attaches the chosen video. */
    attach: (projectId: string): Promise<TransitionClip | null> =>
      ipcRenderer.invoke('clips:attach', projectId),
    remove: (projectId: string, storedName: string): Promise<void> =>
      ipcRenderer.invoke('clips:remove', projectId, storedName),
    /** Reveals the managed clip in the OS file manager. The renderer names a
     *  project and stored name; main resolves the path. False = not on disk. */
    showInFolder: (projectId: string, storedName: string): Promise<boolean> =>
      ipcRenderer.invoke('clips:showInFolder', projectId, storedName),
    /** Whether the clip's bytes are really there, and how large. */
    info: (projectId: string, storedName: string): Promise<{ exists: boolean; bytes: number }> =>
      ipcRenderer.invoke('clips:info', projectId, storedName)
  },

  generation: {
    /** Queues provider-aware generation. In Dry Run (the only enabled mode)
     * requests are validated and built but never sent, and no media is
     * created. */
    queue: (
      projectId: string,
      pairKeys: string[],
      scheduledFor: number | null = null
    ): Promise<QueueJob | null> =>
      ipcRenderer.invoke('generation:queue', projectId, pairKeys, scheduledFor),
    /** Sanitized preview of the request that WOULD be sent. */
    preview: (
      projectId: string,
      pairKey: string
    ): Promise<{ ok: true; preview: SanitizedRequestPreview } | { ok: false; reason: string }> =>
      ipcRenderer.invoke('generation:preview', projectId, pairKey),
    /** Data for the paid-request confirmation dialog. */
    liveConfirmation: (projectId: string, pairKey: string): Promise<LiveConfirmationPayload | null> =>
      ipcRenderer.invoke('generation:liveConfirmation', projectId, pairKey),
    /** Submits exactly ONE live transition. Batches are refused in main. */
    generateLive: (
      projectId: string,
      pairKeys: string[]
    ): Promise<{ ok: true; job: QueueJob } | { ok: false; reasons: string[] }> =>
      ipcRenderer.invoke('generation:generateLive', projectId, pairKeys)
  },

  providers: {
    catalog: (): Promise<ProviderMetadataPayload[]> => ipcRenderer.invoke('providers:catalog'),
    contractStatus: (): Promise<{
      items: { key: string; label: string; confirmed: boolean; locked: boolean; note: string }[]
      /** Verified values that now come from locked application config. */
      locked: { baseUrl: string; imageToVideoPath: string; modelId: string }
      /** Defaults for the values still open to operator override. */
      defaults: { taskStatusPath: string }
      /** Official credit rates, so Settings can show the price list. */
      rates: {
        modelId: string
        resolution: string
        nativeAudio: boolean
        creditsPerSecond: number
      }[]
      nativeAudioDefault: boolean
    }> => ipcRenderer.invoke('providers:contractStatus'),
    /** fal.ai contract & pricing — all verified, nothing to confirm. */
    falStatus: (): Promise<{
      items: { key: string; label: string; confirmed: boolean; note: string }[]
      modelId: string
      queueHost: string
      rates: { modelId: string; nativeAudio: boolean; usdPerSecond: number }[]
      nativeAudioDefault: boolean
    }> => ipcRenderer.invoke('providers:falStatus'),
    /** Write-only: keys never travel back across the bridge. */
    setApiKey: (providerId: string, apiKey: string): Promise<void> =>
      ipcRenderer.invoke('providers:setApiKey', providerId, apiKey),
    hasApiKey: (providerId: string): Promise<boolean> =>
      ipcRenderer.invoke('providers:hasApiKey', providerId),
    /** FREE fal.ai auth test — no model call, no upload, no credits. */
    testConnection: (): Promise<{
      status: 'connected' | 'auth-failed' | 'permission' | 'network'
      detail: string[]
    }> => ipcRenderer.invoke('providers:testConnection')
  },

  exports: {
    run: (
      projectId: string,
      kind: 'preview' | 'final',
      overlays: ExportOverlaysPayload,
      scheduledFor: number | null = null
    ): Promise<ExportStartResult> =>
      ipcRenderer.invoke('exports:run', projectId, kind, overlays, scheduledFor),
    /**
     * DEVELOPMENT/EVALUATION. Re-assembles the clips already on disk twice
     * — hard cuts and seamless — so the seam work can be judged by eye.
     * Generates no AI clips and sends no provider request.
     */
    compareAssembly: (
      projectId: string
    ): Promise<CompareAssemblyResult & { canceled?: boolean }> =>
      ipcRenderer.invoke('export:compareAssembly', projectId),
    /**
     * The editor's working preview: assemble the clips that already exist
     * into a MANAGED file the preview can play. No overlays, no provider,
     * no generation — the customer export is a separate action.
     */
    previewState: (
      projectId: string
    ): Promise<{ url: string | null; builtAt: number | null; missing: string[] }> =>
      ipcRenderer.invoke('preview:state', projectId),
    buildPreview: (
      projectId: string
    ): Promise<{ ok: true; url: string; builtAt: number } | { ok: false; reason: string }> =>
      ipcRenderer.invoke('preview:build', projectId)
  },

  queue: {
    list: (): Promise<QueueJob[]> => ipcRenderer.invoke('queue:list'),
    cancel: (jobId: string): Promise<void> => ipcRenderer.invoke('queue:cancel', jobId),
    retry: (jobId: string): Promise<void> => ipcRenderer.invoke('queue:retry', jobId),
    remove: (jobId: string): Promise<void> => ipcRenderer.invoke('queue:remove', jobId),
    reorder: (jobId: string, direction: 'up' | 'down'): Promise<void> =>
      ipcRenderer.invoke('queue:reorder', jobId, direction),
    pause: (): Promise<void> => ipcRenderer.invoke('queue:pause'),
    resume: (): Promise<void> => ipcRenderer.invoke('queue:resume'),
    isPaused: (): Promise<boolean> => ipcRenderer.invoke('queue:isPaused'),
    reveal: (path: string): Promise<void> => ipcRenderer.invoke('queue:reveal', path),
    /** Keeps tracking an EXISTING remote task. Never submits a new one. */
    resumePolling: (jobId: string): Promise<{ ok: true } | { ok: false; reason: string }> =>
      ipcRenderer.invoke('queue:resumePolling', jobId),
    /** Copies the remote provider task id and returns it. */
    copyTaskId: (jobId: string): Promise<string | null> =>
      ipcRenderer.invoke('queue:copyTaskId', jobId),
    /** What the job knows about reaching its remote task. */
    remoteTaskHandles: (
      jobId: string
    ): Promise<{
      providerTaskId: string | null
      statusUrl: string | null
      responseUrl: string | null
      cancelUrl: string | null
      authoritative: boolean
    } | null> => ipcRenderer.invoke('queue:remoteTaskHandles', jobId),
    /** What the job actually produced on disk, per transition. Empty for
     *  jobs that generate nothing (exports, assembly). */
    clips: (jobId: string): Promise<JobClipStatus[]> => ipcRenderer.invoke('queue:clips', jobId),
    /**
     * Attaches fal's own queue urls to an EXISTING paid task whose urls were
     * never stored. Adds a way to reach the task; never submits, never
     * changes the task id.
     */
    recoverRemoteTaskUrls: (
      jobId: string,
      urls: { statusUrl?: string; responseUrl?: string; cancelUrl?: string }
    ): Promise<{ ok: true; handles: unknown } | { ok: false; reason: string }> =>
      ipcRenderer.invoke('queue:recoverRemoteTaskUrls', jobId, urls),
    /** Live job updates. Returns an unsubscribe function. */
    onChanged: (callback: (jobs: QueueJob[]) => void): (() => void) => {
      const listener = (_e: unknown, jobs: QueueJob[]): void => callback(jobs)
      ipcRenderer.on('queue:changed', listener)
      return () => ipcRenderer.removeListener('queue:changed', listener)
    }
  }
}

contextBridge.exposeInMainWorld('f2f', api)

export type F2FBridge = typeof api
