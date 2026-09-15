import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppSettings,
  FfmpegStatus,
  JobClipStatus,
  Project,
  ProjectImage,
  ProjectStatus,
  QueueJob,
  TransitionClip,
  GenerationRecord
} from '../shared/types'
import type { PropertyAnalysis } from '../shared/propertyAnalysis'
import type { MotionSegment, MotionType } from '../shared/motionSegment'
import type { MotionGenerationReadiness } from '../shared/motionGenerationReadiness'
import type { MotionConfirmation } from '../shared/motionConfirmation'
import type { TimelineEditResult, TimelineViewPayload } from '../shared/timeline'
import type { TransitionDraft } from '../shared/transitionAnalysisExtractor'
import type { AnalyzerDebugPreview, AnalyzerMetadata } from '../shared/analyzerTypes'
import type { AnalysisDiff } from '../shared/analysisDiff'
import type { TransitionPlan } from '../shared/transitionPlan'
import type { EvidenceSource, PairAnalysisRecord } from '../shared/pairAnalysis'
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
import type { ResolvedModeRow } from '../shared/transitionMode'

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

/** One selectable fal.ai model, straight from main's canonical registry. */
export interface FalModelOption {
  id: string
  displayName: string
  durationsSec: number[]
  resolutions: string[]
  defaultResolution: string
  audioSupport: boolean
  /** FALSE means it cannot be submitted — its contract is unverified. */
  confirmed: boolean
  verificationNote: string
  rates: Array<{ nativeAudio: boolean; usdPerSecond: number }>
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
  /**
   * What is guiding this generation: the accepted spatial map
   * (`analysis`), nothing at all because the operator overrode
   * (`none`), or it cannot be generated (`blocked`).
   *
   * `none` must never be rendered as a safe transition.
   */
  spatialGuidance: 'analysis' | 'none' | 'blocked'
  /** The endpoint id of the model this run will use. */
  modelId: string
  /** FALSE when this model has not been verified against fal.ai. */
  modelConfirmed: boolean
  modelNote: string | null
  /** What the SELECTED model accepts — the dialog offers only these. */
  modelDurations: number[]
  modelResolutions: string[]
  modelAudioSupport: boolean
  /** Present only for an override: what the operator is agreeing to. */
  overrideWarning: string | null
  /** Why the evidence is missing. */
  overrideReason: string | null
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
       * The last analyzer DRAFT for this project — exactly what the model
       * returned, kept so an expensive run stays inspectable after a
       * restart. Null when no run has been stored. Never the accepted
       * analysis, and reading it changes nothing.
       */
      draft: (projectId: string): Promise<PropertyAnalysis | null> =>
        ipcRenderer.invoke('analysis:draft', projectId),
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
      /**
       * How every logical transition will actually behave — generated, cut
       * or dissolved — resolved once in main so nothing downstream can
       * disagree about the same transition.
       */
      transitionModes: (projectId: string): Promise<ResolvedModeRow[]> =>
        ipcRenderer.invoke('analysis:transitionModes', projectId),
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
    /** Transition analysis draft persistence. */
    transitionAnalysis: {
      read: (projectId: string) => ipcRenderer.invoke('transitionAnalysis:read', projectId),
      save: (projectId: string, draft: any) =>
        ipcRenderer.invoke('transitionAnalysis:save', projectId, draft),
      markOutdated: (projectId: string) =>
        ipcRenderer.invoke('transitionAnalysis:markOutdated', projectId),
      accept: (projectId: string) => ipcRenderer.invoke('transitionAnalysis:accept', projectId),
      delete: (projectId: string) => ipcRenderer.invoke('transitionAnalysis:delete', projectId)
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
    ): Promise<void> => ipcRenderer.invoke('projects:markWorkflow', projectId, field, value),
    /**
     * Propose a feed order and transition modes based on property analysis.
     */
    feed: {
      propose: (projectId: string): Promise<
        | { ok: true; proposedFeedSequence: string[]; proposedTransitionModes: Record<string, 'ai' | 'cut'> }
        | { ok: false; reason: string }
      > => ipcRenderer.invoke('feed:propose', projectId),
      analyzeConfirmation: (projectId: string): Promise<AnalysisConfirmationPayload | null> =>
        ipcRenderer.invoke('feed:analyzeConfirmation', projectId),
      analyze: (
        projectId: string,
        notes?: string,
        token?: string
      ): Promise<
        | {
            ok: true
            analysis: PropertyAnalysis
            proposedFeedSequence: string[]
            proposedTransitionModes: Record<string, 'ai' | 'cut'>
            notes: string[]
          }
        | { ok: false; reason: string }
      > => ipcRenderer.invoke('feed:analyze', projectId, notes, token),
      /**
       * ANALYSE FEED — judge the operator's chosen sequence as given.
       *
       * Distinct from `analyze` above, which PROPOSES a feed. This one
       * evaluates exactly the adjacent pairs of the current
       * feedSequence and can never add, remove or reorder an image. The
       * whole library is still sent as supporting evidence.
       */
      /**
       * Accept the feed analysis. ONE call: promotes the property map,
       * applies pair decisions without overwriting operator ones,
       * rebuilds wording, and marks the analysis accepted — or does
       * none of it.
       */
      acceptAnalysis: (
        projectId: string,
        draft: TransitionDraft
      ): Promise<{
        ok: boolean
        reason?: string
        promptsUpdated: number
        manualPromptsPreserved: number
        stillNeedContext: number
        operatorDecisionsPreserved: number
      }> => ipcRenderer.invoke('feed:acceptAnalysis', projectId, draft),
      analyzeFeed: (
        projectId: string,
        notes?: string,
        token?: string
      ): Promise<
        | { ok: true; draft: TransitionDraft; analysis: PropertyAnalysis; notes: string[] }
        | { ok: false; reason: string }
      > => ipcRenderer.invoke('feed:analyzeFeed', projectId, notes, token)
    },
    /**
     * SINGLE-IMAGE MOTION SEGMENTS.
     *
     * Its own namespace, deliberately not folded into `transition` — a
     * motion clip is not a transition, and every call site that reaches
     * for one should have to say so.
     */
    motion: {
      add: (
        projectId: string,
        imageId: string,
        motion: MotionType,
        durationSec: number
      ): Promise<{ ok: boolean; reason?: string; segment?: MotionSegment }> =>
        ipcRenderer.invoke('motion:add', projectId, imageId, motion, durationSec),
      update: (
        projectId: string,
        segmentId: string,
        patch: { motion?: MotionType; durationSec?: number }
      ): Promise<{ ok: boolean; reason?: string; segment?: MotionSegment }> =>
        ipcRenderer.invoke('motion:update', projectId, segmentId, patch),
      remove: (
        projectId: string,
        segmentId: string
      ): Promise<{ ok: boolean; reason?: string }> =>
        ipcRenderer.invoke('motion:remove', projectId, segmentId),
      /** Free. The same evaluator the paid path uses. */
      confirmation: (projectId: string, segmentId: string): Promise<MotionGenerationReadiness> =>
        ipcRenderer.invoke('motion:confirmation', projectId, segmentId),
      /** Free. Everything the paid dialog shows, for a given model+length. */
      generateConfirmation: (
        projectId: string,
        segmentId: string,
        modelId?: string | null,
        durationSec?: number | null,
        motion?: MotionType | null
      ): Promise<MotionConfirmation | null> =>
        ipcRenderer.invoke(
          'motion:generateConfirmation',
          projectId,
          segmentId,
          modelId,
          durationSec,
          motion
        ),
      /** PAID. The model is not optional. */
      generate: (
        projectId: string,
        segmentId: string,
        modelId: string,
        durationSec: number,
        motion?: MotionType
      ): Promise<{ ok: boolean; jobId?: string; reason?: string }> =>
        ipcRenderer.invoke('motion:generate', projectId, segmentId, modelId, durationSec, motion)
    },
    /**
     * THE FINAL EDIT — what actually gets exported.
     *
     * Its own namespace because a timeline is not a feed concept: these
     * calls never touch `feedSequence`, the spatial analysis, a
     * transition's mode or the generation history. Reading materialises
     * it once; everything else is an operator action, and none of it
     * costs anything.
     */
    timeline: {
      get: (projectId: string): Promise<TimelineViewPayload | null> =>
        ipcRenderer.invoke('timeline:get', projectId),
      /** Split at ABSOLUTE timeline seconds. No file is written. */
      split: (
        projectId: string,
        itemId: string,
        atSec: number
      ): Promise<TimelineEditResult> => ipcRenderer.invoke('timeline:split', projectId, itemId, atSec),
      /**
       * Retime ONE item. 1 is the footage's own speed, 2 plays it in half
       * the time, 0.5 takes twice as long. No file is written and nothing
       * upstream is regenerated: the two halves of a split can run at
       * different speeds over the same source.
       */
      speed: (
        projectId: string,
        itemId: string,
        playbackRate: number
      ): Promise<TimelineEditResult> =>
        ipcRenderer.invoke('timeline:speed', projectId, itemId, playbackRate),
      /** Remove one segment from the video. The clip and its history stay. */
      delete: (projectId: string, itemId: string): Promise<TimelineEditResult> =>
        ipcRenderer.invoke('timeline:delete', projectId, itemId),
      reorder: (
        projectId: string,
        itemId: string,
        toIndex: number
      ): Promise<TimelineEditResult> =>
        ipcRenderer.invoke('timeline:reorder', projectId, itemId, toIndex),
      /** Discards manual edits — hence the explicit confirm flag. */
      rebuild: (
        projectId: string,
        confirmDiscardEdits: boolean
      ): Promise<TimelineEditResult> =>
        ipcRenderer.invoke('timeline:rebuild', projectId, confirmDiscardEdits)
    },
    /**
     * BRANDING ASSETS.
     *
     * The bytes go to a managed file; the caller stores the short url
     * that comes back. Nothing here touches what branding is ENABLED —
     * that is settings, saved separately.
     */
    branding: {
      save: (
        dataUrl: string,
        name: string,
        replacing?: string | null
      ): Promise<{ ok: true; url: string } | { ok: false; reason: string }> =>
        ipcRenderer.invoke('branding:saveAsset', dataUrl, name, replacing),
      remove: (url: string | null): Promise<{ ok: true }> =>
        ipcRenderer.invoke('branding:removeAsset', url)
    },
    /**
     * Historical record of all generated transitions in the project.
     */
    catalogue: {
      getAll: (projectId: string): Promise<GenerationRecord[]> =>
        ipcRenderer.invoke('catalogue:getAll', projectId),
      /**
       * Reuse a clip this project already generated, as the active one
       * for its own pair. Bookkeeping only — no file copy, no provider
       * request, no new spend, and nothing removed from history.
       */
      attach: (
        projectId: string,
        generationId: string
      ): Promise<{ ok: true; pairKey: string } | { ok: false; reason: string }> =>
        ipcRenderer.invoke('catalogue:attach', projectId, generationId),
      /**
       * Accept a clip the automatic quality check rejected.
       *
       * Requires explicit confirmation in the UI first — the operator is
       * agreeing to ship a clip something objected to. The verdict is
       * kept and the override is recorded alongside it, so history shows
       * both the objection and the decision.
       */
      approveQuality: (
        projectId: string,
        generationId: string
      ): Promise<{ ok: true; pairKey: string } | { ok: false; reason: string }> =>
        ipcRenderer.invoke('catalogue:approveQuality', projectId, generationId)
    },
    /**
     * ONE transition, analysed on its own. Never reorders the feed and
     * never rewrites the whole property map — see pairAnalysisService.
     */
    pairAnalysis: {
      analyze: (
        projectId: string,
        pairKey: string,
        token?: string
      ): Promise<{ ok: boolean; reason?: string; record?: PairAnalysisRecord }> =>
        ipcRenderer.invoke('pair:analyze', projectId, pairKey, token),
      read: (projectId: string, pairKey: string): Promise<PairAnalysisRecord | null> =>
        ipcRenderer.invoke('pair:read', projectId, pairKey),
      accept: (
        projectId: string,
        pairKey: string
      ): Promise<{ ok: boolean; reason?: string; record?: PairAnalysisRecord }> =>
        ipcRenderer.invoke('pair:accept', projectId, pairKey),
      /**
       * Settle one pair completely: their context, their decision, and the
       * wording rebuilt and stamped against whatever evidence that leaves
       * in force. One call, so no half-applied approval can exist — the
       * shape that let a fully approved pair still read as outdated.
       */
      approve: (
        projectId: string,
        pairKey: string,
        mode: 'ai' | 'cut',
        contextText?: string
      ): Promise<{
        ok: boolean
        reason?: string
        evidenceSource?: string
        evidenceFingerprint?: string
        manualPromptPreserved?: boolean
      }> => ipcRenderer.invoke('pair:approve', projectId, pairKey, mode, contextText),
      /**
       * Swap a held suggestion in for the operator's own wording. Only
       * ever called from an explicit action — never as a side effect.
       */
      /**
       * What main says this pair's wording is currently based on. The
       * panel must not resolve precedence itself — a badge that
       * disagrees with the generation gate is worse than no badge.
       */
      currentEvidence: (
        projectId: string,
        pairKey: string
      ): Promise<{
        source: EvidenceSource
        fingerprint: string
        operatorContextFingerprint?: string
      } | null> => ipcRenderer.invoke('pair:currentEvidence', projectId, pairKey),
      replacePrompt: (
        projectId: string,
        pairKey: string
      ): Promise<{ ok: boolean; reason?: string }> =>
        ipcRenderer.invoke('pair:replacePrompt', projectId, pairKey)
    },
    transitions: {
      /**
       * Record what the operator knows about this pair that the photos do
       * not show. Empty text clears it.
       */
      setOperatorContext: (
        projectId: string,
        pairKey: string,
        text: string
      ): Promise<{ ok: true } | { ok: false; reason: string }> =>
        ipcRenderer.invoke('transitions:setOperatorContext', projectId, pairKey, text),
      /**
       * Detach the active clip. The generation, its file and the pair all
       * survive; only the assignment goes, so it can be re-attached.
       */
      clearClip: (
        projectId: string,
        pairKey: string
      ): Promise<{ ok: true } | { ok: false; reason: string }> =>
        ipcRenderer.invoke('transitions:clearClip', projectId, pairKey)
    }
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
    /** Every registered fal.ai model — ONE list, from main's registry. */
    models: (): Promise<FalModelOption[]> => ipcRenderer.invoke('generation:models'),
    liveConfirmation: (
      projectId: string,
      pairKey: string,
      /** The model the dialog is showing; recomputes cost and capabilities. */
      modelId?: string | null
    ): Promise<LiveConfirmationPayload | null> =>
      ipcRenderer.invoke('generation:liveConfirmation', projectId, pairKey, modelId),
    /** Submits exactly ONE live transition. Batches are refused in main. */
    generateLive: (
      projectId: string,
      pairKeys: string[],
      /** The model chosen for THIS run. */
      modelId?: string | null
    ): Promise<{ ok: true; job: QueueJob } | { ok: false; reasons: string[] }> =>
      ipcRenderer.invoke('generation:generateLive', projectId, pairKeys, modelId)
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
    /**
     * Whether this project can be exported, and what is stopping it.
     *
     * The ONE answer, from the same assembly the exporter runs on. The
     * export panel used to compute its own and demanded a generated clip
     * for every pair — so every cut, which generates nothing by
     * definition, was reported as a missing clip.
     */
    readiness: (
      projectId: string
    ): Promise<{
      ready: boolean
      missingAiClips: string[]
      cutPairs: string[]
      crossfadePairs: string[]
      sequenceLength: number
      reason: string | null
    }> => ipcRenderer.invoke('exports:readiness', projectId),
    run: (
      projectId: string,
      kind: 'preview' | 'final',
      overlays: ExportOverlaysPayload,
      scheduledFor: number | null = null,
      /** Output shape — see shared/exportFormat. Omitted is the desktop one. */
      format: 'computer' | 'instagram' = 'computer',
      /** Smoothness only. Never changes duration or speed — see exportFormat. */
      motionQuality: 'standard60' | 'premium120' = 'premium120'
    ): Promise<ExportStartResult> =>
      ipcRenderer.invoke('exports:run', projectId, kind, overlays, scheduledFor, format, motionQuality),
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
