import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { statSync } from 'node:fs'
import type {
  AppSettings,
  FfmpegStatus,
  JobClipStatus,
  Project,
  ProjectStatus,
  ProviderId,
  QueueJob,
  TransitionClip
} from '../shared/types'
import { transitionKey } from '../shared/types'
import {
  listProjects,
  saveProject,
  deleteProjectRows,
  getSettingsJson,
  saveSettingsJson
} from './db/projectsRepo'
import {
  attachClipFromPath,
  deleteProjectFiles,
  importImages,
  removeClipFile,
  removeImageFile,
  resolveClipPath,
  type ImportItem
} from './files'
import { ffmpegStatus } from './services/ffmpegService'
import { readAnalysis, saveAnalysis } from './db/analysisRepo'
import {
  applyAnalysisPromptToTransition,
  planPromptRebuild,
  rebuildPromptsFromAnalysis
} from './services/promptService'
import {
  analyzerById,
  availableAnalyzers,
  plannedAnalyzers,
  type AnalyzerRuntime
} from './analysis/PropertyAnalyzer'
import {
  GEMINI_DEFAULT_MODEL,
  GEMINI_MODELS,
  rateFor
} from './analysis/providers/gemini/geminiConfig'
import { sanitizeApiKey } from './providers/keyHygiene'
import { consumeAnalysisToken, issueAnalysisToken } from './analysis/confirmationTokens'
import {
  clearOverrideField,
  listOverrides,
  overrideFor,
  setOverrideField
} from './db/overrideRepo'
import { applyImageOverrides, imageFacts, type OverrideField } from '../shared/imageFacts'
import {
  clearDraftReviews,
  listReviews,
  promoteDraftReviews,
  reviewMap,
  setReview
} from './db/reviewRepo'
import {
  reviewableFacts,
  summarizeAccuracy,
  unvalidatedConfirmedConnections,
  type ReviewFactKind,
  type ReviewScope,
  type ReviewVerdict
} from '../shared/analysisReview'
import { ALL_CAPABILITIES, type AnalyzerRequest } from '../shared/analyzerTypes'
import { diffAnalyses } from '../shared/analysisDiff'
import { planSequence } from '../shared/transitionPlan'

/**
 * Builds the provider-independent analyzer request.
 *
 * Images are passed as MANAGED references (f2f:// urls), never as
 * filesystem paths — an adapter resolves bytes itself, and nothing that
 * could leave this process carries a local path.
 */
/**
 * The analyzer's runtime, assembled from stored settings.
 *
 * The API key is read HERE and handed straight to the analyzer instance.
 * It is never returned to the renderer, never logged and never included
 * in a debug preview — the renderer can only ask whether one exists.
 */
function analyzerRuntimeFrom(settings: AppSettings | null): AnalyzerRuntime {
  return {
    apiKey: settings?.analyzer?.apiKey ?? '',
    model: settings?.analyzer?.model ?? GEMINI_DEFAULT_MODEL,
    mode: settings?.analyzer?.mode ?? 'dry-run',
    // Absent means OFF. A settings row written before the lock existed
    // must never read as unlocked.
    allowLive: settings?.production?.allowLiveGeminiAnalysis === true
  }
}

function buildAnalyzerRequest(
  project: Project,
  existing: PropertyAnalysis,
  notes: string
): AnalyzerRequest {
  return {
    projectId: project.id,
    projectName: project.name,
    images: project.images.map((image, i) => ({
      imageId: image.id,
      sequence: i + 1,
      fileName: image.fileName,
      ref: image.src
    })),
    existing: existing.rooms.length > 0 ? existing : null,
    notes,
    capabilities: ALL_CAPABILITIES
  }
}
import { listCostEntries, recordAnalysisSpend } from './db/costRepo'
import { GeminiPropertyAnalyzer } from './analysis/providers/gemini/GeminiPropertyAnalyzer'
import type { PropertyAnalysis } from '../shared/propertyAnalysis'
import { planTransitionPrompt } from '../shared/promptPlanner'
import { summarizeSpend, type GenerationCostEntry } from '../shared/costLedger'
import { resolveGenerationAction } from '../shared/generationState'
import {
  cancelJob,
  isPaused,
  listJobs,
  pauseQueue,
  purgePendingJobsForProject,
  recoverRemoteTaskUrls,
  remoteTaskHandles,
  remoteTaskId,
  removeJob,
  reorderJob,
  resumePolling,
  resumeQueue,
  retryJob
} from './services/queueService'
import {
  buildEditorPreview,
  compareAssembly,
  editorPreviewState,
  startExport,
  type ExportKind,
  type ExportOverlays,
  type ExportStartResult
} from './services/exportService'
import {
  liveConfirmation,
  perGenerationEstimate,
  previewRequest,
  queueGeneration,
  queueLiveGeneration
} from './services/generationService'
import { createProvider, providerCatalog } from './providers/registry'
import { FalProvider } from './providers/fal/FalProvider'
import { hasProviderApiKey, storeProviderApiKey } from './services/apiKeyStore'
import {
  KLING_CONTRACT_STATUS,
  KLING_CREDIT_RATES,
  KLING_DEFAULT_TASK_STATUS_PATH,
  KLING_LOCKED_CONTRACT,
  KLING_NATIVE_AUDIO_DEFAULT
} from './providers/kling/klingConfig'
import {
  FAL_CONTRACT_STATUS,
  FAL_COST_RATES,
  FAL_MODEL_ID,
  FAL_NATIVE_AUDIO_DEFAULT,
  FAL_QUEUE_HOST
} from './providers/fal/falConfig'

/**
 * The complete privileged surface. Every channel is explicit and typed —
 * the renderer can do exactly this and nothing more.
 */
export function registerIpc(): void {
  // ── Projects & settings ───────────────────────────────────────────────

  ipcMain.handle('projects:list', (): Project[] => listProjects())

  ipcMain.handle('projects:save', (_e, project: Project): void => {
    saveProject(project)
  })

  ipcMain.handle('projects:delete', (_e, projectId: string): void => {
    // Pending work for a deleted project is cancelled and removed; finished
    // history rows stay so completed customer value remains visible.
    purgePendingJobsForProject(projectId)
    deleteProjectRows(projectId)
    deleteProjectFiles(projectId)
  })

  ipcMain.handle('projects:setStatus', (_e, projectId: string, status: ProjectStatus): void => {
    const project = listProjects().find((p) => p.id === projectId)
    if (!project) return
    saveProject({ ...project, status, updatedAt: Date.now() })
  })

  // ── Property analysis ─────────────────────────────────────────────────
  //
  // Manual, Mock and Gemini. Gemini is the only paid one, and it is gated
  // three ways: its own safety lock (default OFF), Dry Run as the default
  // mode, and a stored API key. Every analyzer result is a DRAFT — nothing
  // here can write the accepted analysis.

  ipcMain.handle('analysis:get', (_e, projectId: string): PropertyAnalysis =>
    readAnalysis(projectId)
  )

  /**
   * The accepted analysis WITH manual corrections folded in — what the
   * planner and the inspectors read.
   *
   * `analysis:get` deliberately still returns the raw document: the draft
   * workflow compares analyses against each other, and a diff computed
   * against a corrected copy would misreport what the analyzer actually
   * proposed.
   */
  ipcMain.handle('analysis:effective', (_e, projectId: string): PropertyAnalysis =>
    applyImageOverrides(readAnalysis(projectId), listOverrides(projectId))
  )

  ipcMain.handle('analysis:save', (_e, analysis: PropertyAnalysis): PropertyAnalysis =>
    saveAnalysis(analysis)
  )

  /**
   * The prompt a transition WOULD get from the current analysis, without
   * writing anything. Lets the editor show what property analysis adds
   * before anyone commits to it.
   */
  ipcMain.handle(
    'analysis:planPrompt',
    (_e, projectId: string, startImageId: string, endImageId: string) =>
      planTransitionPrompt(readAnalysis(projectId), startImageId, endImageId)
  )

  /** What a rebuild WOULD do — counts and previews. Writes nothing. */
  ipcMain.handle('analysis:planRebuild', (_e, projectId: string) => planPromptRebuild(projectId))

  ipcMain.handle('analysis:rebuildPrompts', (_e, projectId: string) =>
    rebuildPromptsFromAnalysis(projectId)
  )

  /** Adopt the analysis prompt for ONE transition, custom wording included.
   *  The renderer warns before calling this. */
  ipcMain.handle('analysis:useAnalysisPrompt', (_e, projectId: string, pairKey: string) =>
    applyAnalysisPromptToTransition(projectId, pairKey)
  )

  /**
   * Everything the UI may offer: the implemented analyzers plus the
   * roadmap. Planned providers carry `available: false` and the run
   * handler refuses them, so the list can be honest without being
   * reachable.
   */
  ipcMain.handle('analysis:analyzers', () => [
    ...availableAnalyzers(analyzerRuntimeFrom(storedSettings())).map((a) => a.metadata()),
    ...plannedAnalyzers()
  ])

  /**
   * Run an analyzer over the whole photo set.
   *
   * ONLY analyzers from the local registry are reachable, and every one of
   * them reports `incursCost: false`. There is no code path from here to a
   * vision API — connecting one is a separate, deliberate change that must
   * register a new analyzer.
   *
   * The result is RETURNED, not saved. The operator reviews it and commits
   * it, so an analyzer can never silently overwrite work done by hand.
   */
  ipcMain.handle(
    'analysis:run',
    async (_e, projectId: string, analyzerId: string, notes: string = '', token?: string) => {
      const runtime = analyzerRuntimeFrom(storedSettings())
      const analyzer = analyzerById(analyzerId, runtime)
      if (!analyzer) return { ok: false as const, reason: `Unknown analyzer "${analyzerId}"` }
      const meta = analyzer.metadata()
      if (!meta.available) {
        return { ok: false as const, reason: `${meta.displayName} is not implemented in this build.` }
      }

      // ── CONFIRMATION IS MANDATORY FOR A PAID LIVE RUN ────────────────
      // Enforced HERE, not in the dialog. A renderer that skipped the
      // dialog, a stale window, or a double-clicked button all arrive
      // without a valid one-shot token and are refused. Dry Run does not
      // need one — it sends nothing and costs nothing.
      const paidLive = meta.capabilities.incursCost && runtime.mode === 'live'
      if (paidLive && !consumeAnalysisToken(token, projectId, analyzerId)) {
        return {
          ok: false as const,
          reason:
            'This paid analysis was not confirmed, or the confirmation was already used. Open Analyze Property again to review what will be sent.'
        }
      }

      // ── THE PAID GATE ────────────────────────────────────────────────
      // A paid analyzer needs its own safety lock ON, exactly like the
      // video providers, and unlocking one never unlocks another. The
      // analyzer ALSO refuses internally, so this is belt and braces
      // rather than the only thing standing between us and a charge.
      if (meta.capabilities.incursCost && !runtime.allowLive) {
        return {
          ok: false as const,
          reason: `Live ${meta.displayName} analysis is locked. Enable it in Settings → Property Analyzer.`
        }
      }
      const project = listProjects().find((p) => p.id === projectId)
      if (!project) return { ok: false as const, reason: 'Project no longer exists' }

      const request = buildAnalyzerRequest(project, readAnalysis(projectId), notes)
      const valid = analyzer.validateInput(request)
      if (!valid.ok) return { ok: false as const, reason: valid.reasons.join(' ') }

      const result = await analyzer.analyzeProperty(request)

      // ── SPEND, ONLY WHEN A PROVIDER REALLY RAN ─────────────────────
      // A dry run returns ok:false and never reaches here, and neither do
      // the local analyzers. Money is recorded because a vendor accepted
      // the request — and only in real currency when the configured rate
      // has actually been verified.
      if (result.ok && paidLive && analyzer instanceof GeminiPropertyAnalyzer) {
        const usage = analyzer.usage()
        const rate = meta.model ? rateFor(meta.model) : null
        const estimate = analyzer.estimateCost(request)
        try {
          recordAnalysisSpend({
            projectId,
            provider: meta.provider,
            model: meta.model ?? 'unknown',
            operationId: null,
            inputTokens: usage?.promptTokenCount ?? null,
            outputTokens: usage?.candidatesTokenCount ?? null,
            totalTokens: usage?.totalTokenCount ?? null,
            // Null unless the rate is verified — see recordAnalysisSpend.
            actualCost: rate?.verified ? (estimate?.amount ?? null) : null,
            estimatedCost: estimate?.amount ?? null,
            currency: estimate?.currency ?? 'USD'
          })
        } catch (err) {
          // Loud, never silent: unrecorded spend is money the business
          // cannot see. The analysis itself still stands.
          console.error('[cost] FAILED to record vision-analysis spend:', err)
        }
      }

      return result
    }
  )

  /** What WOULD be sent — credential-free and path-free, like the video
   *  providers' sanitized request preview. Sends nothing. */
  ipcMain.handle('analysis:preview', (_e, projectId: string, analyzerId: string) => {
    const analyzer = analyzerById(analyzerId, analyzerRuntimeFrom(storedSettings()))
    const project = listProjects().find((p) => p.id === projectId)
    if (!analyzer || !project) return null
    return analyzer.sanitizeDebugPreview(buildAnalyzerRequest(project, readAnalysis(projectId), ''))
  })

  /**
   * Everything the paid-analysis confirmation needs, in one call.
   *
   * Mirrors the video providers' liveConfirmation: the operator sees what
   * will be sent, what it may cost, and — crucially — that the result is
   * a DRAFT that changes nothing until reviewed.
   */
  ipcMain.handle('analysis:confirmation', (_e, projectId: string, analyzerId: string) => {
    const runtime = analyzerRuntimeFrom(storedSettings())
    const analyzer = analyzerById(analyzerId, runtime)
    const project = listProjects().find((p) => p.id === projectId)
    if (!analyzer || !project) return null
    const meta = analyzer.metadata()
    const existing = readAnalysis(projectId)
    const request = buildAnalyzerRequest(project, existing, '')
    const valid = analyzer.validateInput(request)
    const estimate = analyzer.estimateCost(request)

    const blockers: string[] = valid.ok ? [] : [...valid.reasons]
    if (meta.capabilities.incursCost) {
      if (!runtime.allowLive) blockers.push('The safety lock for live analysis is off.')
      if (runtime.mode !== 'live') blockers.push('The analyzer is in Dry Run.')
    }

    // An UNVERIFIED rate must not look authoritative. A dollar figure
    // built on a number nobody has checked is worse than no figure: it
    // reads as reconcilable against an invoice and is not.
    const rate = meta.model ? rateFor(meta.model) : null
    const rateVerified = rate?.verified === true

    return {
      ok: blockers.length === 0,
      blockers,
      analyzer: meta.displayName,
      provider: meta.provider,
      model: meta.model,
      imageCount: project.images.length,
      imageRange:
        project.images.length > 0
          ? `IMAGE_001 – IMAGE_${String(project.images.length).padStart(3, '0')}`
          : '—',
      incursCost: meta.capabilities.incursCost,
      // The EXACT condition `analysis:run` gates the token on, so the
      // renderer cannot disagree with main about whether a real request is
      // about to happen. A dry run is not confirmed — it sends nothing.
      paidLive: meta.capabilities.incursCost && runtime.mode === 'live',
      rateVerified,
      estimatedCostLabel: !estimate
        ? 'unavailable'
        : rateVerified
          ? `$${estimate.amount.toFixed(4)}`
          : 'unavailable — rate not verified',
      estimatedCostBasis: estimate?.basis ?? 'No rate configured for this model.',
      hasAcceptedAnalysis: existing.state === 'accepted' && existing.rooms.length > 0,
      warning: 'This sends all project images to Gemini and may incur API cost.',
      // One-shot. `analysis:run` consumes it, so a second click is refused.
      token: blockers.length === 0 ? issueAnalysisToken(projectId, analyzerId) : null
    }
  })

  // ── Ground-truth review ─────────────────────────────────────────────
  //
  // Local evaluation metadata. There is deliberately no channel that
  // sends any of this anywhere.

  ipcMain.handle('review:list', (_e, projectId: string, scope: ReviewScope) =>
    listReviews(projectId, scope)
  )

  ipcMain.handle(
    'review:set',
    (
      _e,
      projectId: string,
      scope: ReviewScope,
      factKey: string,
      kind: ReviewFactKind,
      label: string,
      verdict: ReviewVerdict
    ): void => {
      // Records a JUDGEMENT about the analysis. It does not touch the
      // analysis itself — removing a bad edge is a separate action.
      setReview({ projectId, scope, factKey, kind, label, verdict })
    }
  )

  ipcMain.handle('review:promoteDraft', (_e, projectId: string): void =>
    promoteDraftReviews(projectId)
  )

  ipcMain.handle('review:clearDraft', (_e, projectId: string): void => clearDraftReviews(projectId))

  /** The reviewable facts of an analysis, with their current verdicts. */
  ipcMain.handle(
    'review:facts',
    (_e, projectId: string, scope: ReviewScope, analysis: PropertyAnalysis) => {
      const project = listProjects().find((p) => p.id === projectId)
      const label = (imageId: string): string => {
        const index = project?.images.findIndex((i) => i.id === imageId) ?? -1
        return index >= 0 ? `Image ${index + 1}` : 'Image ?'
      }
      const facts = reviewableFacts(analysis, label)
      const verdicts = reviewMap(projectId, scope)
      return {
        facts: facts.map((f) => ({ ...f, verdict: verdicts.get(f.factKey) ?? 'unreviewed' })),
        summary: summarizeAccuracy(facts, verdicts),
        unvalidatedConfirmed: unvalidatedConfirmedConnections(analysis, verdicts)
      }
    }
  )

  // ── Analyzer settings ───────────────────────────────────────────────
  //
  // The key is WRITE-ONLY from the renderer. There is deliberately no
  // handler that returns it — only whether one exists.

  ipcMain.handle('analyzer:setApiKey', (_e, apiKey: string): boolean => {
    const settings = storedSettings()
    if (!settings) return false
    const analyzer = settings.analyzer ?? {
      analyzerId: 'manual',
      model: GEMINI_DEFAULT_MODEL,
      apiKey: '',
      mode: 'dry-run' as const
    }
    saveSettingsJson(
      JSON.stringify({ ...settings, analyzer: { ...analyzer, apiKey: sanitizeApiKey(apiKey) } })
    )
    return true
  })

  ipcMain.handle('analyzer:hasApiKey', (): boolean =>
    Boolean(sanitizeApiKey(storedSettings()?.analyzer?.apiKey ?? ''))
  )

  ipcMain.handle('analyzer:models', () => GEMINI_MODELS.map((m) => ({ ...m })))

  /** Every transition's structured plan, for the plan review list. */
  ipcMain.handle('analysis:transitionPlans', (_e, projectId: string) => {
    const project = listProjects().find((p) => p.id === projectId)
    if (!project) return []
    // ACCEPTED-scope reviews, because these are the plans that drive real
    // generation. A reviewer who rejected a connection has overridden the
    // model's confidence, and navigation across it is refused.
    return planSequence(
      // Manual corrections are part of what the planner knows. An operator
      // who fixed a wrong room assignment expects the transition prompts to
      // follow the fix, not the model's mistake.
      applyImageOverrides(readAnalysis(projectId), listOverrides(projectId)),
      project.images.map((i) => i.id),
      reviewMap(projectId, 'accepted')
    )
  })

  /** What a draft would change about the accepted analysis. */
  ipcMain.handle('analysis:diff', (_e, projectId: string, draft: PropertyAnalysis) =>
    diffAnalyses(readAnalysis(projectId), draft)
  )

  // ── Manual image overrides ────────────────────────────────────────────
  //
  // A correction someone typed, kept apart from the analysis document so
  // accepting a new draft cannot erase it — the same rule that protects a
  // manually edited transition prompt.

  ipcMain.handle('override:list', (_e, projectId: string) => listOverrides(projectId))

  ipcMain.handle(
    'override:set',
    (
      _e,
      projectId: string,
      imageId: string,
      field: OverrideField,
      value: string | string[] | null
    ) => setOverrideField(projectId, imageId, field, value)
  )

  /** "Use analyzed value" — one field, or the whole override. */
  ipcMain.handle(
    'override:clear',
    (_e, projectId: string, imageId: string, field?: OverrideField) =>
      clearOverrideField(projectId, imageId, field)
  )

  /** Everything the Image Inspector shows, with each value's provenance. */
  ipcMain.handle('override:facts', (_e, projectId: string, imageId: string) =>
    imageFacts(readAnalysis(projectId), imageId, overrideFor(projectId, imageId))
  )

  // ── Production cost ledger ────────────────────────────────────────────

  ipcMain.handle('cost:entries', (_e, projectId: string): GenerationCostEntry[] =>
    listCostEntries(projectId)
  )

  /**
   * COMPARE ASSEMBLY — development/evaluation only.
   *
   * Re-assembles clips that ALREADY EXIST, twice. No provider request is
   * possible from this path: it never touches generationService and never
   * constructs a provider.
   */
  /**
   * The editor's working preview. Assembly ONLY — it reuses clips that
   * already exist and can never reach a provider.
   */
  ipcMain.handle('preview:state', (_e, projectId: string) => editorPreviewState(projectId))
  ipcMain.handle('preview:build', async (_e, projectId: string) => {
    try {
      return await buildEditorPreview(projectId)
    } catch (err) {
      return { ok: false as const, reason: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('export:compareAssembly', async (_e, projectId: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const picked = await dialog.showOpenDialog(win, {
      title: 'Choose a folder for the comparison exports',
      properties: ['openDirectory', 'createDirectory']
    })
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false, canceled: true }
    }
    const dir = picked.filePaths[0]

    const first = await compareAssembly(projectId, dir)
    if (!first.ok && first.wouldOverwrite && first.wouldOverwrite.length > 0) {
      // Never overwrite silently — ask, in the OS dialog, naming the files.
      const confirm = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Cancel', 'Replace'],
        defaultId: 0,
        cancelId: 0,
        message: 'Replace existing comparison exports?',
        detail: first.wouldOverwrite.join('\n')
      })
      if (confirm.response !== 1) return { ok: false, canceled: true }
      return compareAssembly(projectId, dir, { overwrite: true })
    }
    return first
  })

  /**
   * Spent / remaining / projected for one project.
   *
   * "Remaining" is computed HERE rather than in the renderer because it
   * depends on two facts only the main process can establish honestly:
   * which pairs actually have a valid clip ON DISK, and which pairs have an
   * accepted remote task still in flight. A pair with a live paid task is
   * excluded — its money is already inside `spent`, and counting it again
   * would overstate the projected total.
   */
  ipcMain.handle('cost:summary', (_e, projectId: string) => {
    const project = listProjects().find((p) => p.id === projectId)
    const entries = listCostEntries(projectId)
    if (!project) {
      return summarizeSpend({
        entries,
        pairsNeedingClip: [],
        pairsWithActiveTask: [],
        perGenerationEstimate: 0,
        currency: 'USD'
      })
    }

    const pairsNeedingClip: string[] = []
    for (let i = 0; i < project.images.length - 1; i++) {
      const key = transitionKey(project.images[i].id, project.images[i + 1].id)
      const clip = project.transitions[key]?.clip
      const onDisk = clip ? resolveClipPath(projectId, clip.storedName) !== null : false
      if (!onDisk) pairsNeedingClip.push(key)
    }

    const pairsWithActiveTask = listJobs()
      .filter((j) => j.projectId === projectId && resolveGenerationAction(j.provider) !== 'submit')
      .flatMap((j) => j.metadata?.pairKeys ?? [])

    const settings = storedSettings()
    const estimate = perGenerationEstimate(projectId, settings)
    return summarizeSpend({
      entries,
      pairsNeedingClip,
      pairsWithActiveTask,
      perGenerationEstimate: estimate.amount,
      currency: estimate.currency
    })
  })

  ipcMain.handle(
    'projects:markWorkflow',
    (_e, projectId: string, field: 'previewSentAt' | 'paidAt' | 'finalSentAt', value: number | null): void => {
      const project = listProjects().find((p) => p.id === projectId)
      if (!project) return
      saveProject({
        ...project,
        workflow: { ...project.workflow, [field]: value },
        updatedAt: Date.now()
      })
    }
  )

  ipcMain.handle(
    'images:import',
    (_e, projectId: string, items: ImportItem[]) => importImages(projectId, items)
  )

  ipcMain.handle('images:remove', (_e, projectId: string, storedName: string): void => {
    removeImageFile(projectId, storedName)
  })

  /**
   * API keys are WRITE-ONLY across the bridge: reads always return an empty
   * string, so a saved key can never be read back by the renderer (or by
   * anything that can reach it). `providers:setApiKey` is the only way in,
   * and `settings:save` deliberately ignores whatever key the renderer
   * sends so a redacted round-trip cannot erase the stored value.
   */
  const storedSettings = (): AppSettings | null => {
    const json = getSettingsJson()
    return json ? (JSON.parse(json) as AppSettings) : null
  }

  const withoutKeys = (settings: AppSettings): AppSettings => ({
    ...settings,
    providers: (settings.providers ?? []).map((p) => ({ ...p, apiKey: '', legacySecret: '' }))
  })

  ipcMain.handle('settings:get', (): AppSettings | null => {
    const stored = storedSettings()
    return stored ? withoutKeys(stored) : null
  })

  ipcMain.handle('settings:save', (_e, settings: AppSettings): void => {
    const stored = storedSettings()
    const merged: AppSettings = {
      ...settings,
      providers: (settings.providers ?? []).map((p) => {
        const previous = stored?.providers?.find((x) => x.id === p.id)
        return { ...p, apiKey: previous?.apiKey ?? '', legacySecret: previous?.legacySecret ?? '' }
      })
    }
    saveSettingsJson(JSON.stringify(merged))
  })

  /** Sanitises the key and CREATES a missing provider entry rather than
   * silently dropping the key — see apiKeyStore for both rules. */
  ipcMain.handle('providers:setApiKey', (_e, providerId: string, apiKey: string): void => {
    storeProviderApiKey(providerId as ProviderId, apiKey)
  })

  /** Whether a key exists — never the key itself. */
  ipcMain.handle('providers:hasApiKey', (_e, providerId: string): boolean =>
    hasProviderApiKey(providerId as ProviderId)
  )

  /**
   * FREE fal.ai auth/config test — storage-slot initiate (unused) plus a
   * status probe for a nonexistent request. No model call, no upload, no
   * generation credits. Reachable only from the Settings button.
   */
  ipcMain.handle('providers:testConnection', async () => {
    const settings = storedSettings()
    const fal = settings?.providers?.find((p) => p.id === 'fal')
    const provider = createProvider(
      fal ?? { id: 'fal', label: 'fal.ai', apiKey: '', mode: 'dry-run', model: null },
      settings
    )
    if (!(provider instanceof FalProvider)) {
      return { status: 'network', detail: ['fal.ai provider unavailable.'] }
    }
    return provider.testConnection()
  })

  // ── FFmpeg ────────────────────────────────────────────────────────────

  ipcMain.handle('ffmpeg:status', (): FfmpegStatus => ffmpegStatus())

  // ── Transition clips (manual test import today, providers later) ──────

  ipcMain.handle('clips:attach', async (_e, projectId: string): Promise<TransitionClip | null> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const picked = await dialog.showOpenDialog(win, {
      title: 'Attach test clip',
      properties: ['openFile'],
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv'] }]
    })
    if (picked.canceled || picked.filePaths.length === 0) return null
    return attachClipFromPath(projectId, picked.filePaths[0], 'manual')
  })

  ipcMain.handle('clips:remove', (_e, projectId: string, storedName: string): void => {
    removeClipFile(projectId, storedName)
  })

  /**
   * Reveals a generated clip in the OS file manager.
   *
   * The renderer names a project and a STORED clip name, never a path — the
   * absolute path is resolved here through safeManagedPath, so this cannot
   * be pointed at anything outside the managed projects directory. Returns
   * false when the file is not there, so the caller can say so instead of
   * opening an empty window.
   */
  ipcMain.handle('clips:showInFolder', (_e, projectId: string, storedName: string): boolean => {
    const path = resolveClipPath(projectId, storedName)
    if (!path) return false
    shell.showItemInFolder(path)
    return true
  })

  /** Whether a clip's bytes are actually on disk, plus its size. Lets the UI
   *  distinguish "attached and playable" from "row says completed". */
  ipcMain.handle(
    'clips:info',
    (_e, projectId: string, storedName: string): { exists: boolean; bytes: number } => {
      const path = resolveClipPath(projectId, storedName)
      if (!path) return { exists: false, bytes: 0 }
      try {
        return { exists: true, bytes: statSync(path).size }
      } catch {
        return { exists: false, bytes: 0 }
      }
    }
  )

  // ── Generation (mock until a provider is connected) ───────────────────

  ipcMain.handle(
    'generation:queue',
    (_e, projectId: string, pairKeys: string[], scheduledFor: number | null): QueueJob | null =>
      queueGeneration(projectId, pairKeys, scheduledFor)
  )

  /** Sanitized request preview for the developer "View Request" action —
   * credential values are redacted inside the provider. */
  ipcMain.handle('generation:preview', (_e, projectId: string, pairKey: string) =>
    previewRequest(projectId, pairKey)
  )

  /** Provider capability catalog for Settings. Contains no credentials. */
  ipcMain.handle('providers:catalog', () => providerCatalog(storedSettings()))

  /** What is / is not confirmed about the external contract. */
  ipcMain.handle('providers:contractStatus', () => ({
    items: KLING_CONTRACT_STATUS,
    // Verified → locked application configuration, not operator input.
    locked: KLING_LOCKED_CONTRACT,
    // The one value still open to override.
    defaults: { taskStatusPath: KLING_DEFAULT_TASK_STATUS_PATH },
    rates: KLING_CREDIT_RATES,
    nativeAudioDefault: KLING_NATIVE_AUDIO_DEFAULT
  }))

  /** fal.ai contract & pricing for Settings. Everything here is verified —
   * there is nothing for the operator to confirm. */
  ipcMain.handle('providers:falStatus', () => ({
    items: FAL_CONTRACT_STATUS,
    modelId: FAL_MODEL_ID,
    queueHost: FAL_QUEUE_HOST,
    rates: FAL_COST_RATES,
    nativeAudioDefault: FAL_NATIVE_AUDIO_DEFAULT
  }))

  /** Everything the paid-confirmation dialog must show, computed in main. */
  ipcMain.handle('generation:liveConfirmation', (_e, projectId: string, pairKey: string) =>
    liveConfirmation(projectId, pairKey)
  )

  /**
   * The ONLY live entry point. Single transition only — a batch is refused
   * here, in main, before any network call is possible.
   */
  ipcMain.handle(
    'generation:generateLive',
    (_e, projectId: string, pairKeys: string[]) => queueLiveGeneration(projectId, pairKeys)
  )

  // ── Exports & queue ───────────────────────────────────────────────────

  ipcMain.handle(
    'exports:run',
    (
      _e,
      projectId: string,
      kind: ExportKind,
      overlays: ExportOverlays,
      scheduledFor: number | null
    ): Promise<ExportStartResult> => startExport(projectId, kind, overlays, scheduledFor)
  )

  ipcMain.handle('queue:list', (): QueueJob[] => listJobs())
  ipcMain.handle('queue:cancel', (_e, jobId: string): void => cancelJob(jobId))
  ipcMain.handle('queue:retry', (_e, jobId: string): void => retryJob(jobId))
  ipcMain.handle('queue:remove', (_e, jobId: string): void => removeJob(jobId))
  ipcMain.handle('queue:reorder', (_e, jobId: string, dir: 'up' | 'down'): void =>
    reorderJob(jobId, dir)
  )
  ipcMain.handle('queue:pause', (): void => pauseQueue())
  ipcMain.handle('queue:resume', (): void => resumeQueue())
  ipcMain.handle('queue:isPaused', (): boolean => isPaused())

  /**
   * Re-queues a job to keep tracking an EXISTING remote task. Refused when
   * there is no task id, so it can never become a second paid submission.
   */
  ipcMain.handle('queue:resumePolling', (_e, jobId: string) => resumePolling(jobId))

  /**
   * Copies the remote Kling task id to the clipboard and returns it. The
   * value comes from persisted state, never from the renderer — if our
   * status path is wrong, this id is the only handle on a paid task.
   */
  ipcMain.handle('queue:copyTaskId', (_e, jobId: string): string | null => {
    const taskId = remoteTaskId(jobId)
    if (taskId) clipboard.writeText(taskId)
    return taskId
  })

  /**
   * Reads what a job knows about reaching its remote task, so the Queue UI
   * can tell "we hold fal's own urls" from "we would have to rebuild one".
   */
  ipcMain.handle('queue:remoteTaskHandles', (_e, jobId: string) => remoteTaskHandles(jobId))

  /**
   * What a generation job actually PRODUCED, per transition.
   *
   * A finished remote task and a playable local file are two different
   * facts; the download between them can fail. The Queue asks for both here
   * so it never presents a job with no media as simply "Completed", and so
   * "View clip" / "Show in folder" appear only when there is really
   * something to view.
   */
  ipcMain.handle('queue:clips', (_e, jobId: string): JobClipStatus[] => {
    const job = listJobs().find((j) => j.id === jobId)
    if (!job) return []
    const pairKeys = job.metadata?.pairKeys ?? []
    if (pairKeys.length === 0) return []

    const project = listProjects().find((p) => p.id === job.projectId)
    if (!project) return []

    // Image ORDER gives the human label, exactly as the editor numbers them.
    const labels = new Map<string, string>()
    for (let i = 0; i < project.images.length - 1; i++) {
      labels.set(
        transitionKey(project.images[i].id, project.images[i + 1].id),
        `Image ${i + 1} → Image ${i + 2}`
      )
    }

    return pairKeys.map((pairKey) => {
      const clip = project.transitions[pairKey]?.clip ?? null
      const path = clip ? resolveClipPath(project.id, clip.storedName) : null
      let bytes = 0
      if (path) {
        try {
          bytes = statSync(path).size
        } catch {
          bytes = 0
        }
      }
      return {
        pairKey,
        label: labels.get(pairKey) ?? pairKey,
        storedName: clip?.storedName ?? null,
        originalName: clip?.originalName ?? null,
        source: clip?.source ?? null,
        src: clip?.src ?? null,
        exists: path !== null,
        bytes
      }
    })
  })

  /**
   * MANUAL RECOVERY — attaches fal's queue urls to an EXISTING paid task
   * whose urls were never persisted. It cannot submit anything and cannot
   * change the task id; it only adds a working way to reach something that
   * is already running. Urls are restricted to queue.fal.run in the service.
   */
  ipcMain.handle(
    'queue:recoverRemoteTaskUrls',
    (_e, jobId: string, urls: { statusUrl?: string; responseUrl?: string; cancelUrl?: string }) =>
      recoverRemoteTaskUrls(jobId, urls ?? {})
  )

  ipcMain.handle('queue:reveal', (_e, path: string): void => {
    shell.showItemInFolder(path)
  })
}
