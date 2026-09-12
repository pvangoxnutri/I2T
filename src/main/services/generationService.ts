import { currentPairEvidence } from './currentEvidence'
import { join } from 'node:path'
import type {
  AiProviderConfig,
  AppSettings,
  Project,
  ProjectImage,
  ProviderJobState,
  QueueJob,
  TransitionSettings
} from '../../shared/types'
import type { JobMetadata } from '../../shared/types'
import { NATIVE_AUDIO_DEFAULT, transitionKey } from '../../shared/types'
import { DEFAULT_PRICING, priceSnapshot } from '../../shared/pricing'
import { promptForTransition } from '../../shared/prompts'
import { getFeedImages, getFeedSequenceIds } from '../../shared/feedSequence'
import { assessAiGenerationReadiness } from '../../shared/aiGenerationReadiness'
import { readAnalysis } from '../db/analysisRepo'
import { listOverrides } from '../db/overrideRepo'
import { applyImageOverrides } from '../../shared/imageFacts'
import type { PropertyAnalysis } from '../../shared/propertyAnalysis'
import {
  FALLBACK_DURATION_SEC,
  resolveTransitionDuration
} from '../../shared/transitionDuration'
import { getSettingsJson, listProjects, saveProject } from '../db/projectsRepo'
import { broadcastProjectUpdated } from '../events'
import { listCostEntries, recordGenerationSpend, settleGenerationSpend } from '../db/costRepo'
import {
  recordGeneration,
  archivePreviousGenerations,
  archivePreviousMotionGenerations,
  getGenerationsForPair,
  setActiveGeneration
} from '../db/generationCatalogueRepo'
import { GEMINI_DEFAULT_MODEL } from '../analysis/providers/gemini/geminiConfig'
import { reflectionEvidenceForPair } from '../../shared/reflectionRisk'
import { resolvePairSpatialEvidence } from '../../shared/pairEvidence'
import { evidenceFingerprintOf } from '../../shared/promptPlanner'
import type { EvidenceSource } from '../../shared/pairAnalysis'
import { readPairAnalysis } from '../db/pairAnalysisRepo'
import { readTransitionDraft } from '../db/transitionAnalysisRepo'
import { imageAnalysis } from '../../shared/propertyAnalysis'
import {
  countsAsSpend,
  entryAmount,
  formatSpend,
  nextAttemptNumber
} from '../../shared/costLedger'
import { clipPath, projectTransitionsDir } from '../files'
import { projectImagesDir } from '../paths'
import { randomUUID } from 'node:crypto'
import { existsSync, rmSync, statSync } from 'node:fs'
import { createProvider } from '../providers/registry'
import { FAL_DEFAULT_MODEL_ID, resolveFalModel, falRunCost, clampDurationForModel } from '../providers/fal/falModels'
import { motionSegments, type MotionType } from '../../shared/motionSegment'
import { buildMotionPrompt } from '../../shared/motionPrompt'
import type {
  GenerationRequest,
  GenerationSubject,
  ProviderError,
  SanitizedRequestPreview,
  VideoProvider
} from '../providers/types'
import { clipUrl, projectTransitionsDir as transitionsDir } from '../files'
import { ensureDir, safeManagedPath } from '../paths'
import { probeDurationSec } from './ffmpegService'
import {
  enqueue,
  isJobCancelled,
  listJobs,
  registerRunner,
  updateJobMetadata,
  updateJobProvider
} from './queueService'

/**
 * Provider-aware AI transition generation.
 *
 * This replaces the hardwired mock path: the job carries WHICH provider and
 * model it belongs to, and the runner drives that provider through the
 * generic interface. Kling in Dry Run is a real provider path with the
 * network disabled — not a simulation of one.
 *
 * ── RETRY / IDEMPOTENCY STATE MACHINE ────────────────────────────────────
 * The rule that protects us from paying twice once Live mode exists:
 *
 *   no providerTaskId            → SUBMIT      (nothing exists remotely)
 *   providerTaskId + not final   → RESUME_POLL (a remote task already exists;
 *                                               never submit again)
 *   providerTaskId + succeeded   → DOWNLOAD    (fetch + attach only)
 *   explicit Regenerate          → clears providerTaskId, then SUBMIT
 *
 * A crash mid-generation therefore recovers by polling the task the provider
 * is already running, and the queue's Retry can never silently create a
 * duplicate paid task.
 */

// The state machine itself now lives in `shared` so the renderer resolves
// it with the SAME function instead of a second copy of the rule. Re-exported
// here so every existing import of it keeps working unchanged.
export {
  resolveGenerationAction,
  STATUS_ENDPOINT_UNVERIFIED,
  STATUS_ENDPOINT_UNVERIFIED_MESSAGE,
  type GenerationAction
} from '../../shared/generationState'
import {
  isTerminalProviderErrorCode,
  resolveGenerationAction,
  STATUS_ENDPOINT_UNVERIFIED,
  STATUS_ENDPOINT_UNVERIFIED_MESSAGE
} from '../../shared/generationState'

function readSettings(): AppSettings | null {
  const json = getSettingsJson()
  return json ? (JSON.parse(json) as AppSettings) : null
}

/**
 * The provider the app generates with. `activeProviderId` selects one entry;
 * settings saved before fal existed have no such field and fall back to the
 * first entry — the exact pre-fal behaviour.
 */
/**
 * The ACCEPTED analysis with manual corrections folded in — the same
 * document the planner and the inspectors read, so a generation is judged
 * against exactly what the operator was shown.
 */
/**
 * Store WHY a provider call failed, classified, on the job.
 *
 * The distinction being preserved is the one the recovery UI depends on:
 * a refusal kills the remote task id, losing contact does not. Both look
 * identical once the queue has reduced them to a message string.
 */
function recordProviderFailure(jobId: string, error: ProviderError): void {
  try {
    updateJobProvider(jobId, {
      providerFailure: {
        code: error.code,
        message: error.message,
        httpStatus: error.httpStatus,
        terminal: isTerminalProviderErrorCode(error.code)
      }
    })
  } catch (err) {
    // Never let bookkeeping mask the failure it is describing.
    console.error('[generation] could not record the provider failure', err)
  }
}

/**
 * The model the newest generation for this pair actually used.
 *
 * Read from the catalogue, which records the exact model per run. Null
 * when the pair has never been generated, or when the row predates that
 * column — an older row must not force a guess.
 */
function previousGenerationModel(projectId: string, pairKey: string): string | null {
  const [fromImageId, toImageId] = pairKey.split('->') as [string, string]
  try {
    return getGenerationsForPair(projectId, fromImageId, toImageId)[0]?.model ?? null
  } catch {
    // History is a convenience here; never let it block a generation.
    return null
  }
}

function acceptedAnalysisFor(projectId: string): PropertyAnalysis {
  return applyImageOverrides(readAnalysis(projectId), listOverrides(projectId))
}

/**
 * The two readiness inputs that describe THIS project's stored state.
 *
 * Built once and handed to `assessAiGenerationReadiness` so the
 * confirmation dialog and the submit path ask the identical question.
 * Two call sites deriving this separately is precisely how a screen came
 * to say one thing while the paid path did another.
 */
export function readinessInputs(projectId: string): {
  transitionFor: (pairKey: string) => TransitionSettings | undefined
  currentEvidence: (pairKey: string) => {
    source: EvidenceSource
    fingerprint: string
    operatorContextFingerprint?: string
  } | null
} {
  const project = listProjects().find((p) => p.id === projectId)

  return {
    transitionFor: (pairKey) => project?.transitions[pairKey],
    // ONE computation, shared with prompt stamping. The gate deriving
    // precedence separately from the writer is what let a prompt be
    // stamped `global-analysis` and then judged against `feed-analysis`.
    currentEvidence: (pairKey) => {
      const current = currentPairEvidence(projectId, pairKey, project)
      if (!current) return null
      return {
        source: current.source,
        fingerprint: current.fingerprint,
        operatorContextFingerprint: current.operatorContextFingerprint
      }
    }
  }
}

/**
 * Record which stage of the work this job is in.
 *
 * Best-effort by design: a phase is a progress READOUT, and failing to
 * write one must never abort a generation that is otherwise fine. The
 * decisions are made from provider status and the quality verdict, both
 * of which are written on their own paths.
 */
function setJobPhase(jobId: string, phase: NonNullable<JobMetadata['phase']>): void {
  try {
    const job = listJobs().find((j) => j.id === jobId)
    if (!job) return
    updateJobMetadata(jobId, { ...job.metadata, phase })
  } catch (err) {
    console.error('[generation] could not record the job phase', err)
  }
}

/**
 * Automatic post-generation quality validation has been removed from the
 * product. The operator watches the clip; if it is wrong they re-analyse,
 * edit the prompt and regenerate. Historical verdicts remain readable in
 * the catalogue but nothing consults them.
 */

export function activeProviderConfig(settings: AppSettings | null): AiProviderConfig | undefined {
  const providers = settings?.providers ?? []
  if (settings?.activeProviderId) {
    const chosen = providers.find((p) => p.id === settings.activeProviderId)
    if (chosen) return chosen
  }
  return providers[0]
}

/** Builds the provider-neutral request for one transition pair. */
/**
 * THE PAIR, LOCATED IN THE VIDEO — NOT IN THE LIBRARY.
 *
 * ── THE BUG THIS EXISTS FOR ──────────────────────────────────────────
 *
 * Every pair lookup in this file walked `project.images`, which is the
 * imported LIBRARY, not the Transition Feed. The moment a feed stops
 * matching library order — which is what accepting a proposal does, and
 * what dragging one photo does — a pair that is perfectly adjacent in the
 * video is not adjacent in that list. Generation then reported
 * "Transition … is not in the image sequence" about a transition sitting
 * in the sequence, and refused to build a request for it.
 *
 * The feed is what becomes the video, so the feed is where a transition
 * lives. Position also decides START vs END, so reading the wrong list
 * could not merely fail — it could have paired the wrong two frames.
 */
function feedPairAt(
  project: Project,
  pairKey: string
): { index: number; start: ProjectImage; end: ProjectImage } | null {
  const feed = getFeedImages(project)
  for (let i = 0; i < feed.length - 1; i++) {
    if (transitionKey(feed[i].id, feed[i + 1].id) === pairKey) {
      return { index: i, start: feed[i], end: feed[i + 1] }
    }
  }
  return null
}

export function buildGenerationRequest(
  projectId: string,
  pairKey: string,
  settings: AppSettings | null,
  /**
   * The model chosen for THIS run, when one was.
   *
   * ── WHY PER RUN ────────────────────────────────────────────────────
   *
   * The model was a single global setting, so comparing two models on
   * the same transition meant changing a preference that then applied to
   * every future generation. Choosing per run is the point of the
   * selector; the global value is only where the dialog starts.
   */
  modelIdOverride?: string | null
): { ok: true; request: GenerationRequest } | { ok: false; reason: string } {
  const project = listProjects().find((p) => p.id === projectId)
  if (!project) return { ok: false, reason: 'Project no longer exists' }

  // Located in FEED order, so START/END can never be swapped.
  const pair = feedPairAt(project, pairKey)
  if (!pair) {
    return {
      ok: false,
      reason:
        'This transition is no longer part of the current Transition Feed. ' +
        'Select an active transition to generate.'
    }
  }

  const startImage = pair.start
  const endImage = pair.end
  const transition: TransitionSettings | undefined = project.transitions[pairKey]
  const config = activeProviderConfig(settings)

  return {
    ok: true,
    request: {
      projectId: project.id,
      pairKey,
      // Image ORDER is the product: earlier image = START, later = END.
      startImagePath: join(projectImagesDir(project.id), startImage.storedName),
      endImagePath: join(projectImagesDir(project.id), endImage.storedName),
      startImageName: startImage.fileName,
      endImageName: endImage.fileName,
      prompt: promptForTransition(transition?.prompt),
      // The SAME resolver the inspector and the timeline display, so the
      // number the operator was shown is the number that gets submitted.
      // Legacy/partial settings rows may lack whole sections — never assume.
      durationSec: resolveTransitionDuration(
        transition,
        settings?.exportDefaults?.defaultTransitionDurationSec
      ),
      resolution: settings?.exportDefaults?.resolution ?? '1080p',
      // Audio is never enabled implicitly — see NATIVE_AUDIO_DEFAULT.
      nativeAudio: NATIVE_AUDIO_DEFAULT,
      // The run's model, then the global default, then the registry's.
      modelId: modelIdOverride ?? config?.model ?? FAL_DEFAULT_MODEL_ID
    }
  }
}

/** Sanitized request preview for the developer "View Request" action. */
export function previewRequest(
  projectId: string,
  pairKey: string
): { ok: true; preview: SanitizedRequestPreview } | { ok: false; reason: string } {
  const settings = readSettings()
  const built = buildGenerationRequest(projectId, pairKey, settings)
  if (!built.ok) return built
  const provider = createProvider(activeProviderConfig(settings), settings)
  const config = provider.validateConfiguration(built.request.modelId)
  if (!config.ok) return { ok: false, reason: config.error.message }
  const valid = provider.validateRequest(built.request)
  if (!valid.ok) return { ok: false, reason: valid.error.message }
  return { ok: true, preview: provider.buildRequest(built.request) }
}

/** Queues generation for the given transition pairs. */
export function queueGeneration(
  projectId: string,
  pairKeys: string[],
  /** The model chosen for this run; falls back to the global default. */
  modelIdOverride: string | null | undefined,
  scheduledFor?: number | null
): QueueJob | null {
  const project = listProjects().find((p) => p.id === projectId)
  if (!project || pairKeys.length === 0) return null

  const settings = readSettings()
  const config = activeProviderConfig(settings)
  const provider = createProvider(config, settings)
  const dryRun = config?.mode !== 'live'

  // Mark the selected transitions as queued for generation.
  for (const key of pairKeys) {
    const current = project.transitions[key]
    if (current) project.transitions[key] = { ...current, status: 'queued' }
  }
  project.updatedAt = Date.now()
  saveProject(project)
  broadcastProjectUpdated(project.id)

  // Best-effort estimates. Credits are the provider's real billing unit;
  // money stays null unless a verified conversion exists.
  let estimatedCost: number | null = null
  let estimatedCredits: number | null = null
  const first = buildGenerationRequest(projectId, pairKeys[0], settings, modelIdOverride)
  if (first.ok) {
    const per = provider.estimateCost(first.request)
    if (per !== null) estimatedCost = Math.round(per * pairKeys.length * 100) / 100
    const usage = provider.estimateUsage(first.request)
    if (usage?.credits !== null && usage?.credits !== undefined) {
      estimatedCredits = usage.credits * pairKeys.length
    }
  }

  const providerState: ProviderJobState = {
    provider: config?.id ?? 'mock',
    // The RUN's model — what is persisted, submitted and later compared.
    model: modelIdOverride ?? config?.model ?? null,
    dryRun,
    providerTaskId: null,
    providerStatus: null,
    submittedAt: null,
    lastPolledAt: null,
    providerMeta: null,
    estimatedCost,
    actualCost: null,
    estimatedCredits,
    actualCredits: null,
    retryCount: 0
  }

  return enqueue({
    projectId: project.id,
    projectName: project.name,
    kind: 'ai-generation',
    transitionCount: pairKeys.length,
    price: priceSnapshot(project.images.length, settings?.pricing ?? DEFAULT_PRICING),
    scheduledFor,
    metadata: {
      mock: providerState.provider === 'mock',
      pairKeys,
      provider: providerState.provider,
      model: providerState.model ?? undefined
    },
    provider: providerState
  })
}

/** Where a downloaded provider clip will land — always a managed path. */
export function managedClipTarget(projectId: string, fileName: string): string {
  return join(transitionsDir(projectId), fileName)
}

// ── Live single-transition generation ────────────────────────────────────

/** LIVE MODE IS SINGLE-TRANSITION ONLY in this milestone. Enforced here in
 * main, not merely by disabled buttons. */
export const LIVE_MAX_TRANSITIONS = 1

export interface LiveEligibility {
  allowed: boolean
  reasons: string[]
  /** True when settings ask for live but something blocks it. */
  liveRequested: boolean
}

export function liveEligibility(settings: AppSettings | null, pairCount: number): LiveEligibility {
  const config = activeProviderConfig(settings)
  const liveRequested = config?.mode === 'live'
  const reasons: string[] = []
  if (!liveRequested) reasons.push('Provider mode is Dry Run.')

  // Per-provider requirements. Each provider has its OWN safety lock —
  // unlocking one must never unlock the other.
  if (config?.id === 'fal') {
    if (!settings?.production?.allowLiveFalRequests) {
      reasons.push('Safety lock “Allow live fal.ai requests” is OFF.')
    }
    if (!config?.model) reasons.push('No fal.ai model is selected.')
  } else if (config?.id === 'kling') {
    if (!settings?.production?.allowLiveKlingRequests) {
      reasons.push('Safety lock “Allow live Kling requests” is OFF.')
    }
    if (!settings?.production?.klingContract?.acknowledged) {
      reasons.push('The Kling API contract has not been acknowledged in Settings.')
    }
    if (!config?.model) reasons.push('No Kling model is selected.')
  } else {
    reasons.push('Live generation is only implemented for fal.ai and Kling.')
  }

  if (pairCount > LIVE_MAX_TRANSITIONS) {
    reasons.push(`Live generation is limited to ${LIVE_MAX_TRANSITIONS} transition per request.`)
  }
  if (pairCount < 1) reasons.push('No transition selected.')
  return { allowed: liveRequested && reasons.length === 0, reasons, liveRequested }
}

/** Everything the paid-confirmation dialog must show. */
export interface LiveConfirmation {
  ok: boolean
  reasons: string[]
  projectName: string
  transitionLabel: string
  provider: string
  model: string
  durationSec: number
  resolution: string
  /** Whether audio is enabled for THIS generation — not the model's ability. */
  nativeAudio: boolean
  /** The prompt that will actually be sent. */
  prompt: string
  /** Managed f2f:// thumbnails of the exact frames being sent. */
  startImage: { name: string; src: string } | null
  endImage: { name: string; src: string } | null
  /** API cost in the provider's billing unit, e.g. "40 credits" or "$0.42". */
  estimatedCostLabel: string
  /** How that number was reached, e.g. "5s × 8 credits/s" or "5s × $0.084/s". */
  estimatedCostBasis: string
  /** The customer's project price — a DIFFERENT concept entirely. */
  customerPriceLabel: string
  warning: string
  /** 1 = first generation of this pair; 2+ = a regeneration. */
  attemptNumber: number
  isRegeneration: boolean
  /** What THIS generation adds to production spend, or 'unavailable'. */
  additionalCostLabel: string
  /** Production spend on this project so far, in the provider's currency. */
  spentSoFarLabel: string
  /**
   * What is guiding this generation.
   *
   *   analysis — the accepted map supports the move and supplies anchors
   *   none     — an operator override; no spatial guidance at all
   *   blocked  — cannot be generated, see `reasons`
   *
   * `none` must never be presented as a safe or analysis-based
   * transition; it is the state that produced a moved sofa.
   */
  spatialGuidance: 'analysis' | 'none' | 'blocked'
  /** The endpoint id of the model this run will use. */
  modelId: string
  /** FALSE when this model's contract has not been verified. */
  modelConfirmed: boolean
  /** Why it is unverified, when it is. Null for a confirmed model. */
  modelNote: string | null
  /**
   * Capabilities of the SELECTED model.
   *
   * The dialog offers only what this model accepts, from the same
   * registry the request mapper reads — so an operator cannot choose a
   * duration the endpoint will reject.
   */
  modelDurations: number[]
  modelResolutions: string[]
  modelAudioSupport: boolean
  /** Present only for an override: what the operator is agreeing to. */
  overrideWarning: string | null
  /** Why the evidence is missing, for the same dialog. */
  overrideReason: string | null
  /** Spend after this generation, or 'unavailable' with no verified rate. */
  projectedAfterLabel: string
}

export function liveConfirmation(
  projectId: string,
  pairKey: string,
  /**
   * The model the dialog is currently showing. Changing it re-asks this
   * function, so the duration, the resolution and the cost the operator
   * sees are always the ones that model will actually use.
   */
  modelIdOverride?: string | null
): LiveConfirmation | null {
  const settings = readSettings()
  const project = listProjects().find((p) => p.id === projectId)
  if (!project) return null

  const eligibility = liveEligibility(settings, 1)
  const built = buildGenerationRequest(projectId, pairKey, settings, modelIdOverride)
  const provider = createProvider(activeProviderConfig(settings), settings)
  const meta = provider.metadata()
  // The model this run will actually use — the per-run choice, else the
  // global default, else the registry's. Resolved once and reused by the
  // label, the capability lists and the price, so the dialog cannot show
  // one model's durations beside another's cost.
  // ── WHERE THE DIALOG STARTS ─────────────────────────────────────────
  //
  // An explicit choice first. Then, for a regeneration, the model the
  // LAST attempt used — so "try this pair again" begins from what was
  // actually tried, and switching model is a deliberate act rather than
  // a silent one. Falls through to the global default when that model is
  // no longer registered, which is also what an older row resolves to.
  const previousModelId = previousGenerationModel(projectId, pairKey)
  const runModel = resolveFalModel(
    modelIdOverride ?? previousModelId ?? activeProviderConfig(settings)?.model
  )
  // The duration THIS model accepts, nearest to what the transition asks
  // for — so the price quoted is the price of the run that will happen.
  const runSeconds = built.ok
    ? clampDurationForModel(runModel, built.request.durationSec)
    : FALLBACK_DURATION_SEC
  const runCost = falRunCost(runModel, runSeconds, NATIVE_AUDIO_DEFAULT)
  const isFalRun = (activeProviderConfig(settings)?.id ?? 'fal') === 'fal'
  const model = meta.models.find((m) => m.id === (activeProviderConfig(settings)?.model ?? ''))

  // Human "Image X → Image Y" label + the exact frames, in FEED order —
  // the same list the request is built from, so the dialog cannot describe
  // one pair while the payload carries another.
  const pair = feedPairAt(project, pairKey)
  const label = pair ? `Image ${pair.index + 1} → Image ${pair.index + 2}` : pairKey
  const startImage = pair ? { name: pair.start.fileName, src: pair.start.src } : null
  const endImage = pair ? { name: pair.end.fileName, src: pair.end.src } : null

  const price = priceSnapshot(project.images.length, settings?.pricing ?? DEFAULT_PRICING)
  // Providers bill in their own unit (fal.ai in dollars, Kling in credits);
  // only ever from a VERIFIED published rate, and never mixed with the
  // customer's project price.
  const usage = built.ok ? provider.estimateUsage(built.request) : null

  // THE SAME GATE THE SUBMIT PATH USES, ASKED BEFORE THE BUTTON LIGHTS UP.
  //
  // A confirmation that says "ok" for a pair the submit path will refuse
  // is a confirmation that teaches the operator to distrust the dialog.
  // THE OPERATOR'S OWN EVIDENCE IS PART OF THE INPUT.
  //
  // Re-running the raw evaluator and concluding "still needs context"
  // ignores the fact that the operator answered the question. The gate
  // stays canonical; what changes is that it is asked with everything
  // that is known, not only with what the analyzer found.
  const confirmationInputs = readinessInputs(projectId)
  const readiness = assessAiGenerationReadiness(
    acceptedAnalysisFor(projectId),
    getFeedSequenceIds(project),
    pairKey,
    project.transitions[pairKey]?.modeProvenance,
    undefined,
    project.transitions[pairKey]?.operatorContext,
    confirmationInputs.transitionFor,
    confirmationInputs.currentEvidence
  )
  const override = readiness.ok && readiness.kind === 'manual-override' ? readiness : null

  return {
    ok: eligibility.allowed && built.ok && readiness.ok,
    reasons: [
      ...eligibility.reasons,
      ...(built.ok ? [] : [built.reason]),
      ...(readiness.ok ? [] : [readiness.reason])
    ],
    // WHAT IS GUIDING THIS GENERATION. Stated plainly so an override can
    // never be mistaken for a supported transition: the dialog shows the
    // risk, and the operator agrees to it explicitly or cancels.
    spatialGuidance: readiness.ok
      ? readiness.kind === 'analysis-backed'
        ? 'analysis'
        : 'none'
      : 'blocked',
    overrideWarning: override ? override.warning : null,
    overrideReason: override ? override.reason : null,
    projectName: project.name,
    transitionLabel: label,
    provider: meta.label,
    // ── THE SELECTED MODEL, FROM THE REGISTRY ───────────────────────
    //
    // Named from the canonical entry rather than from provider metadata
    // or a settings string, so the dialog cannot show one model while
    // the request carries another.
    model: runModel.displayName,
    modelId: runModel.id,
    modelConfirmed: runModel.confirmed,
    modelNote: runModel.confirmed ? null : runModel.verificationNote,
    modelDurations: runModel.durationsSec,
    modelResolutions: runModel.resolutions,
    modelAudioSupport: runModel.audioSupport,
    // What will actually be sent, after the provider's own mapping.
    //
    // NEVER ZERO. This fell back to a literal 0 whenever the request could
    // not be built, so a blocked confirmation announced "Duration: 0s" —
    // a length no provider offers and nothing would ever have been sent
    // at. The resolver answers the same question the request would ask,
    // so a dialog that cannot submit still states the truth about what it
    // would submit.
    durationSec:
      usage?.seconds ??
      (built.ok
        ? built.request.durationSec
        : resolveTransitionDuration(
            project.transitions[pairKey],
            settings?.exportDefaults?.defaultTransitionDurationSec
          )),
    resolution: usage?.resolution ?? (built.ok ? built.request.resolution : '—'),
    nativeAudio: built.ok ? built.request.nativeAudio : false,
    prompt: built.ok ? built.request.prompt : '',
    startImage,
    endImage,
    // Never invent a cost: unavailable stays unavailable.
    // ── PRICE OF THE SELECTED MODEL ─────────────────────────────────
    //
    // From the registry entry for THIS run. A model with no verified
    // rate says so — a guessed price is worse than no price, because it
    // gets reconciled against an invoice.
    // fal prices per output second from the registry entry for THIS run.
    // Kling bills in credits and keeps its own estimator — this must not
    // impose a dollar rate on a provider that does not publish one.
    estimatedCostLabel: isFalRun
      ? runCost
        ? `$${runCost.usd.toFixed(2)}`
        : 'unavailable — rate not verified'
      : usage
        ? usage.label
        : 'unavailable',
    estimatedCostBasis: isFalRun
      ? runCost
        ? `${runSeconds}s × $${runCost.usdPerSecond}/s · ${runModel.displayName}`
        : `No verified rate is published for ${runModel.displayName}.`
      : usage
        ? `${usage.seconds}s × ${usage.rateLabel} · ${usage.resolution} · audio ${usage.nativeAudio ? 'on' : 'off'}`
        : 'No verified rate for this combination.',
    customerPriceLabel: `${price.totalPrice} ${price.currency}`,
    // A non-blocking advisory rides along with the spend warning rather
    // than becoming a second gate — see `advisory` in the readiness
    // result. Today that is the mirror note on a hand-written prompt.
    warning: [
      meta.id === 'fal'
        ? 'This sends one paid request to fal.ai.'
        : 'This action sends a paid request to Kling.',
      readiness.ok && readiness.kind === 'analysis-backed' ? readiness.advisory : null
    ]
      .filter(Boolean)
      .join(' '),
    ...productionSpendPreview(projectId, pairKey, usage?.money ?? null)
  }
}

/**
 * What this generation ADDS to our production spend.
 *
 * The ledger is append-only, so a regeneration never replaces an earlier
 * charge — it stacks on it. The operator therefore needs three numbers
 * before pressing the button: what this one costs, what the project has
 * already cost, and what it will have cost afterwards.
 *
 * Every figure comes from the real ledger and the provider's own verified
 * rate for THIS transition's duration, model and resolution. Nothing is
 * hardcoded, and an unavailable rate stays unavailable rather than being
 * guessed — an invented cost is worse than no cost, because it looks
 * reconcilable and is not.
 */
function productionSpendPreview(
  projectId: string,
  pairKey: string,
  money: { amount: number; currency: string } | null
): {
  attemptNumber: number
  isRegeneration: boolean
  additionalCostLabel: string
  spentSoFarLabel: string
  projectedAfterLabel: string
} {
  const entries = listCostEntries(projectId)
  const attemptNumber = nextAttemptNumber(entries, pairKey)
  const counted = entries.filter(countsAsSpend)
  // A project can in principle hold charges in more than one currency (a
  // provider switch mid-project). Totalling across currencies would be a
  // fiction, so only entries in the currency being quoted are summed.
  const currency = money?.currency ?? counted[0]?.currency ?? 'USD'
  const spent = counted
    .filter((e) => e.currency === currency)
    .reduce((sum, e) => sum + entryAmount(e), 0)

  const spentLabel = formatSpend(spent, currency)
  if (!money) {
    return {
      attemptNumber,
      isRegeneration: attemptNumber > 1,
      additionalCostLabel: 'unavailable',
      spentSoFarLabel: spentLabel,
      // Without a rate we cannot project honestly. Saying so beats a
      // number that would silently be wrong.
      projectedAfterLabel: 'unavailable'
    }
  }

  return {
    attemptNumber,
    isRegeneration: attemptNumber > 1,
    additionalCostLabel: formatSpend(money.amount, currency),
    spentSoFarLabel: spentLabel,
    projectedAfterLabel: formatSpend(spent + money.amount, currency)
  }
}

/** Queues exactly ONE live transition. Rejects batches before any network
 * call can happen. */
export function queueLiveGeneration(
  projectId: string,
  pairKeys: string[],
  modelIdOverride?: string | null
): { ok: true; job: QueueJob } | { ok: false; reasons: string[] } {
  const settings = readSettings()
  const eligibility = liveEligibility(settings, pairKeys.length)
  if (!eligibility.allowed) return { ok: false, reasons: eligibility.reasons }

  // ── AN UNVERIFIED MODEL IS NOT SUBMITTABLE ──────────────────────────
  //
  // Its endpoint path, field names, duration vocabulary and price have
  // not been read from fal.ai. Submitting anyway would spend the
  // operator's money to discover a 404 or a 422. Confirming a model is
  // a small job; guessing on their behalf is not ours to do.
  const runModel = resolveFalModel(modelIdOverride ?? activeProviderConfig(settings)?.model)
  if (!runModel.confirmed) {
    return {
      ok: false,
      reasons: [
        runModel.displayName +
          ' has not been verified against fal.ai yet, so it cannot be submitted. ' +
          'Its endpoint, request fields, durations and price still need confirming.'
      ]
    }
  }

  // ── PREFLIGHT: NOTHING STALE IS EVER PAID FOR ──────────────────────
  //
  // The dialog already disables Generate for a pair the feed no longer
  // contains, but this is the door money actually goes through and it
  // must not take the renderer's word for what is current. A feed can
  // also change between the dialog opening and Generate being pressed.
  //
  // Checked for EVERY pair before any job exists: a batch containing one
  // stale transition is refused whole rather than partly submitted.
  const project = listProjects().find((p) => p.id === projectId)
  if (!project) return { ok: false, reasons: ['Project no longer exists.'] }

  const stale = pairKeys.filter((key) => feedPairAt(project, key) === null)
  if (stale.length > 0) {
    return {
      ok: false,
      reasons: [
        stale.length === 1
          ? 'This transition is no longer part of the current Transition Feed. Select an active transition to generate.'
          : `${stale.length} of these transitions are no longer part of the current Transition Feed.`
      ]
    }
  }

  // ── EVIDENCE, RE-ASKED AT THE MOMENT OF SPENDING ───────────────────
  //
  // A stored `mode: 'ai'` is not enough. The accepted analysis must be
  // able to justify the move NOW and yield an anchored instruction; the
  // alternative is a paid request carrying only the generic prompt, which
  // is what produced a moved sofa and a duplicated television.
  const accepted = acceptedAnalysisFor(projectId)
  const feedIds = getFeedSequenceIds(project)
  const submitInputs = readinessInputs(projectId)
  const readiness = pairKeys.map((key) => ({
    key,
    result: assessAiGenerationReadiness(
      accepted,
      feedIds,
      key,
      // An operator's own AI choice may proceed on their acknowledged
      // risk; one the analyzer made may not, without the map behind it.
      project.transitions[key]?.modeProvenance,
      undefined,
      project.transitions[key]?.operatorContext,
      // THE SAME INPUTS THE CONFIRMATION USED. A dialog that says yes
      // and a submit that says no is the failure mode this closes.
      submitInputs.transitionFor,
      submitInputs.currentEvidence
    )
  }))
  const unsupported = readiness.filter((r) => !r.result.ok)
  if (unsupported.length > 0) {
    const first = unsupported[0].result
    return {
      ok: false,
      reasons: [first.ok ? '' : first.reason]
    }
  }

  const job = queueGeneration(projectId, pairKeys, modelIdOverride, null)
  if (!job) return { ok: false, reasons: ['Could not queue the generation.'] }
  return { ok: true, job }
}

/** Result validation before a downloaded file is ever attached. */
function validateDownloadedClip(path: string): { ok: true } | { ok: false; reason: string } {
  if (!existsSync(path)) return { ok: false, reason: 'The downloaded file is missing.' }
  const size = statSync(path).size
  if (size <= 0) return { ok: false, reason: 'The downloaded file is empty.' }
  // FFmpeg must be able to open it — a truncated or non-video payload has
  // no readable duration.
  const duration = probeDurationSec(path)
  if (!Number.isFinite(duration) || duration <= 0) {
    return { ok: false, reason: 'The downloaded file is not a readable video.' }
  }
  return { ok: true }
}

/**
 * Downloads a finished provider result into managed storage, validates it
 * and attaches it to the SAME transition clip fields Attach Test Clip uses.
 * A failed validation NEVER attaches and never marks the transition
 * completed — the remote task metadata is kept so the download can be
 * retried without paying for a new generation.
 */
export async function downloadAndAttachResult(
  provider: VideoProvider,
  projectId: string,
  /**
   * WHAT THE CLIP BELONGS TO.
   *
   * A bare string used to be enough because everything was a pair. It is
   * accepted still — that string is a pairKey — so no existing caller
   * changes meaning; a motion run passes its subject instead.
   */
  target: string | GenerationSubject,
  resultUrl: string,
  queueJobId: string,
  /** The model this run actually used, recorded with the generation. */
  modelId: string | null
): Promise<
  // `ok: true` means the DOWNLOAD succeeded — the provider's work arrived
  // intact. Whether the clip was adopted is a separate fact, carried in
  // `quality`, because a clip that fails inspection is still a real
  // delivered result that was paid for and kept.
  { ok: true; storedName: string } | { ok: false; reason: string }
> {
  const subject: GenerationSubject =
    typeof target === 'string' ? { kind: 'transition', pairKey: target } : target

  const dir = transitionsDir(projectId)
  ensureDir(dir)
  const storedName = `${randomUUID()}.mp4`
  const downloadPath = safeManagedPath(dir, storedName)

  const fetched = await provider.fetchResult(resultUrl, downloadPath)
  if (!fetched.ok) {
    rmSync(downloadPath, { force: true })
    return { ok: false, reason: fetched.error.message }
  }

  const valid = validateDownloadedClip(downloadPath)
  if (!valid.ok) {
    rmSync(downloadPath, { force: true })
    return { ok: false, reason: valid.reason }
  }

  const project = listProjects().find((p) => p.id === projectId)
  if (!project) {
    rmSync(downloadPath, { force: true })
    return { ok: false, reason: 'Project no longer exists' }
  }
  // The clip source records WHICH provider produced it, but the structure is
  // the SAME one Attach Test Clip uses — one output type, no special cases.
  const providerId = provider.metadata().id
  const source: 'kling' | 'fal' = providerId === 'fal' ? 'fal' : 'kling'
  const newClip = {
    storedName,
    originalName: `${source}-generation.mp4`,
    source,
    src: clipUrl(projectId, storedName)
  }

  // ── SINGLE-IMAGE MOTION ───────────────────────────────────────────
  //
  // The download, the validation and the managed directory above are
  // shared: a clip is a clip. What differs is where it is attached and
  // what the catalogue row says it is — and that difference is here,
  // once, rather than in a parallel copy of this whole function.
  if (subject.kind === 'motion') {
    const segments = motionSegments(project)
    const existing = segments.find((s) => s.id === subject.segmentId)
    if (!existing) {
      rmSync(downloadPath, { force: true })
      return { ok: false, reason: 'That motion clip was removed while it was generating.' }
    }

    // ── THE ROW RECORDS THE RUN, NOT THE SEGMENT ────────────────────
    //
    // Movement, prompt and length come from the JOB — `subject.motion`
    // is what was submitted and `job` carries what was confirmed. The
    // segment is live state that a later regeneration moves on, so a row
    // built from it would silently rewrite itself: regenerate a Pan
    // Right at 5s as a Smooth Forward at 10s and the OLD row would start
    // claiming it had been Smooth Forward too. History has to describe
    // what happened, not what is current.
    const runJob = listJobs().find((j) => j.id === queueJobId)
    const runMotion = (subject.motion as MotionType) ?? existing.motion
    const generationId = recordGeneration({
      queueJobId,
      projectId,
      // The SOURCE image, and an EMPTY end. See migration 30: an empty id
      // matches no photograph, so a motion row can never be returned as
      // the active generation for any pair.
      fromImageId: existing.imageId,
      toImageId: '',
      motionSegmentId: existing.id,
      motionType: runMotion,
      durationSec: runJob?.metadata?.motionDurationSec ?? existing.durationSec,
      provider: source,
      model: modelId,
      clip: newClip,
      prompt: buildMotionPrompt(runMotion),
      active: false
    })

    project.motionSegments = segments.map((s) =>
      s.id === subject.segmentId
        ? {
            ...s,
            status: 'completed' as const,
            // The segment now IS what was just delivered, so the
            // inspector and the timeline describe the clip that plays.
            motion: runMotion,
            durationSec: runJob?.metadata?.motionDurationSec ?? s.durationSec,
            prompt: buildMotionPrompt(runMotion),
            clip: newClip
          }
        : s
    )
    project.updatedAt = Date.now()

    // The previous generation of THIS SEGMENT stops being current but
    // stays in history — it was paid for, and a regeneration is not a
    // decision to forget what came before.
    archivePreviousMotionGenerations(projectId, existing.id)
    setActiveGeneration(projectId, generationId)
    setJobPhase(queueJobId, 'complete')

    saveProject(project)
    broadcastProjectUpdated(projectId)
    return { ok: true, storedName }
  }

  const pairKey = subject.pairKey
  const current = project.transitions[pairKey]

  // CATALOGUE FIRST, AND NOT YET ACTIVE.
  //
  // The money is already spent, so the attempt is recorded whatever the
  // inspection concludes. `active: false` is the load-bearing part: until
  // the clip has been looked at it must not displace a good one that
  // already has. See the regenerate case below.
  const [fromImageId, toImageId] = pairKey.split('->') as [string, string]
  const generationId = recordGeneration({
    queueJobId, // IDEMPOTENCY: Same job = same catalogue row, even if called multiple times
    projectId,
    fromImageId,
    toImageId,
    provider: source,
    // THE EXACT MODEL THIS RUN USED.
    //
    // Was null with a note that the source was 'sufficient'. It was not:
    // comparing O3 against another model on the same transition is the
    // reason the selector exists, and history that records only 'fal'
    // cannot tell the two attempts apart afterwards.
    model: modelId,
    clip: newClip,
    prompt: current?.prompt ?? '',
    active: false
  })

  // ── THE CLIP IS THE RESULT. IT IS ATTACHED. ────────────────────────
  //
  // Automatic post-generation validation used to run here: sample frames,
  // send them to a vision model, and refuse to attach the clip on its
  // verdict. It is gone from the product flow by decision.
  //
  // The operator judges the clip by watching it, which is both cheaper
  // and better than a second model's opinion — and if it is wrong the
  // remedy is theirs: re-analyse, edit the prompt, regenerate. What the
  // gate actually produced was a generation the operator had paid for,
  // could see, and could not use without arguing with a dialog.
  //
  // Historical verdicts stay in the catalogue for old rows. They describe
  // what happened at the time and are not consulted here.
  project.transitions[pairKey] = {
    ...(current ?? {
      prompt: '',
      durationSec: FALLBACK_DURATION_SEC,
      status: 'not-generated',
      clip: null
    }),
    status: 'completed',
    clip: newClip
  }
  project.updatedAt = Date.now()

  // Archive previous generations of this pair so only newest shows as
  // "active" — reached only once the new clip has earned the place.
  archivePreviousGenerations(projectId, fromImageId, toImageId)
  setActiveGeneration(projectId, generationId)
  setJobPhase(queueJobId, 'complete')

  saveProject(project)
  // THE fix for "the clip generated but never showed up". The write above
  // was always correct; nothing told the renderer. This re-reads the stored
  // project and pushes it, so the transition card updates on its own — no
  // restart, no reopening the project, no manual refresh.
  broadcastProjectUpdated(projectId)
  return { ok: true, storedName }
}

/** Poll cadence for a live remote task. The override exists so the test
 * suite can drive the lifecycle quickly; production uses the default. */
const POLL_INTERVAL_MS = Number(process.env['F2F_POLL_MS']) || 6_000
const POLL_TIMEOUT_MS = Number(process.env['F2F_POLL_TIMEOUT_MS']) || 20 * 60 * 1000

/**
 * Drives ONE live transition through the full remote lifecycle:
 * submit → persist task id IMMEDIATELY → poll → download → validate →
 * attach. Honours the state machine: if a task id already exists we resume
 * polling instead of submitting (and paying) again.
 */
/**
 * A wrong status path must never cost anything. Everything about the remote
 * task is preserved: the task id, the submission time, the provider
 * metadata. Only the status marker and the poll timestamp are written, and
 * nothing is resubmitted, cleared or claimed to be cancelled.
 */
function markStatusEndpointUnverified(
  jobId: string,
  providerLabel: string,
  taskId: string,
  detail: string
): { ok: false; endpointUnverified: true; reason: string } {
  updateJobProvider(jobId, {
    providerStatus: STATUS_ENDPOINT_UNVERIFIED,
    lastPolledAt: Date.now()
  })
  return {
    ok: false,
    endpointUnverified: true,
    reason:
      `${STATUS_ENDPOINT_UNVERIFIED_MESSAGE}. ${providerLabel} task ${taskId} is still running remotely — it was NOT resubmitted, NOT cancelled and its id is kept. ` +
      `${detail} Correct the task-status path in Settings, then press “Resume polling”.`
  }
}

/**
 * Human label for the image pair at the time of the charge, e.g.
 * "Image 2 → Image 3". Stored on the entry rather than derived later
 * because reordering the photos must not rewrite spend history.
 */
export function pairLabel(projectId: string, pairKey: string): string {
  const project = listProjects().find((p) => p.id === projectId)
  if (!project) return pairKey
  const pair = feedPairAt(project, pairKey)
  return pair ? `Image ${pair.index + 1} → Image ${pair.index + 2}` : pairKey
}

/**
 * What ONE more generation would cost, in the provider's currency.
 *
 * Used for the "remaining estimate" and for the Regenerate confirmation.
 * Derived from a REAL built request for this project so duration and
 * resolution match what would actually be submitted — an estimate built
 * from defaults would quietly disagree with the charge.
 *
 * Returns 0 when no request can be built (no images, no provider, no
 * verified rate). A zero estimate is honest; a guessed one is not.
 */
export function perGenerationEstimate(
  projectId: string,
  settings: AppSettings | null
): { amount: number; currency: string } {
  const project = listProjects().find((p) => p.id === projectId)
  const config = activeProviderConfig(settings)
  if (!project || !config) return { amount: 0, currency: 'USD' }

  // A REPRESENTATIVE PAIR FROM THE FEED.
  //
  // This took the first two LIBRARY images, which are not necessarily a
  // transition at all. Now that a request can only be built for a pair
  // the feed actually contains, that would have made the estimate read
  // 0.00 for every project whose feed differs from library order — a
  // silent zero standing in for "we did not look in the right place".
  const feed = getFeedImages(project)
  if (feed.length < 2) return { amount: 0, currency: 'USD' }

  try {
    const provider = createProvider(config, settings)
    const key = transitionKey(feed[0].id, feed[1].id)
    const built = buildGenerationRequest(projectId, key, settings)
    if (!built.ok) return { amount: 0, currency: 'USD' }
    const usage = provider.estimateUsage(built.request)
    return {
      amount: usage?.money?.amount ?? 0,
      currency: usage?.money?.currency ?? 'USD'
    }
  } catch {
    return { amount: 0, currency: 'USD' }
  }
}

/** Writes ONE ledger entry for an accepted remote task. */
function recordSpendForSubmission(
  provider: VideoProvider,
  job: QueueJob,
  pairKey: string,
  request: GenerationRequest,
  taskId: string
): void {
  const usage = provider.estimateUsage(request)
  const meta = provider.metadata()
  recordGenerationSpend({
    projectId: job.projectId,
    pairKey,
    transitionPair: pairLabel(job.projectId, pairKey),
    provider: meta.id,
    model: request.modelId,
    durationSec: request.durationSec,
    resolution: request.resolution,
    remoteTaskId: taskId,
    jobId: job.id,
    estimatedCost: usage?.money?.amount ?? null,
    // fal bills USD. Kling bills credits, and no official credit→money
    // conversion is published, so its money stays null rather than being
    // invented — the entry still records that a generation was charged.
    currency: usage?.money?.currency ?? 'USD',
    status: 'submitted'
  })
}

export async function runLiveGenerationJob(
  provider: VideoProvider,
  job: QueueJob,
  /**
   * WHAT IS BEING GENERATED.
   *
   * A pairKey string, as every existing caller passes, or a motion
   * subject. The lifecycle below — submit, persist the task id, record
   * the spend, poll, download — is identical either way, and that is the
   * point: single-image motion gets the same idempotency, the same
   * ledger and the same recovery, because it is the same code.
   */
  target: string | GenerationSubject,
  request: GenerationRequest,
  ctx: { onProgress: (pct: number) => void }
): Promise<{ ok: true } | { ok: false; endpointUnverified?: true; reason: string }> {
  const subject: GenerationSubject =
    typeof target === 'string' ? { kind: 'transition', pairKey: target } : target
  // Only used for the ledger's human label and log lines.
  const pairKey = subject.kind === 'transition' ? subject.pairKey : subject.segmentId
  const action = resolveGenerationAction(job.provider, job.note)
  const label = provider.metadata().label
  let taskId = job.provider?.providerTaskId ?? null

  if (action === 'submit') {
    setJobPhase(job.id, 'submitting')
    const submitted = await provider.submitGeneration(request)
    if (!submitted.ok) {
      // CLASSIFY THE REFUSAL, DON'T JUST DESCRIBE IT.
      //
      // The queue's catch block keeps only a message string, so the
      // provider's own error CODE was lost the moment it was thrown —
      // and with it the difference between "the provider rejected this
      // request" and "we could not reach the provider". Recorded here,
      // while it still exists, so `canResumeProviderTask` can answer
      // from stored state instead of guessing from a status word.
      recordProviderFailure(job.id, submitted.error)
      return { ok: false, reason: submitted.error.message }
    }

    // ── PERSIST THE REMOTE TASK ID BEFORE ANYTHING ELSE ────────────────
    // From here on a paid task exists. If this write fails we must NOT
    // resubmit — we surface it loudly with the id in the message so the
    // task can be recovered by hand.
    taskId = submitted.providerTaskId
    try {
      const updated = updateJobProvider(job.id, {
        providerTaskId: taskId,
        providerStatus: submitted.providerStatus,
        submittedAt: Date.now(),
        // ── THE MODEL, ONTO THE TASK METADATA ────────────────────────
        //
        // The poll path derives its queue urls from meta.model. Without
        // this it falls back to the default model id — which happens to
        // resolve to the same {owner}/{app} for every Kling endpoint, so
        // it would work today by coincidence and break the first time a
        // non-Kling model is registered.
        providerMeta: { ...(submitted.meta ?? {}), model: request.modelId },
        dryRun: false
      })
      setJobPhase(job.id, 'generating')
      if (!updated || updated.provider?.providerTaskId !== taskId) {
        throw new Error('verification failed')
      }
    } catch (err) {
      return {
        ok: false,
        reason:
          `A PAID ${label} task was created (id ${taskId}) but storing it failed (${err instanceof Error ? err.message : String(err)}). ` +
          'It was NOT resubmitted. Recover it manually before retrying.'
      }
    }

    // ── THE MOMENT SPEND BECOMES REAL ──────────────────────────────────
    // The provider ACCEPTED the request, so it has been charged for. That
    // is true regardless of what happens next: the download may fail, the
    // app may be closed, attaching the clip locally may go wrong — the
    // provider still ran the job. Recording it here, not on success, is
    // what makes the ledger match the invoice.
    //
    // Only reachable in LIVE mode: dry runs and the mock provider never
    // enter runLiveTransition at all, and a validation failure returns
    // before submitGeneration. Idempotent on the task id, so a resumed
    // poll or a restart cannot charge the same generation twice.
    try {
      recordSpendForSubmission(provider, job, pairKey, request, taskId)
    } catch (err) {
      // A ledger write must never fail a paid generation that already
      // succeeded remotely — the clip matters more than the bookkeeping
      // row, and the entry can be reconciled from the task id.
      //
      // But it must never be SILENT either: unrecorded spend is money the
      // business cannot see, and a swallowed exception here would hide
      // that permanently. Loud, with the task id, so it can be recovered.
      console.error(
        `[cost] FAILED to record spend for ${label} task ${taskId} (project ${job.projectId}, pair ${pairKey}):`,
        err
      )
    }
    ctx.onProgress(20)
  }

  if (!taskId) return { ok: false, reason: 'No remote task id available to poll.' }

  // ── Poll the existing task ─────────────────────────────────────────────
  let resultUrl: string | undefined
  if (action !== 'download') {
    const deadline = Date.now() + POLL_TIMEOUT_MS
    for (;;) {
      if (isJobCancelled(job.id)) {
        return {
          ok: false,
          reason: `Stopped tracking — the ${label} task ${taskId} may continue remotely and may still be billed.`
        }
      }
      if (Date.now() > deadline) {
        return { ok: false, reason: `Timed out waiting for ${label} task ${taskId}. Retry resumes polling.` }
      }

      // The job's persisted metadata carries fal's own status_url /
      // response_url, so the provider polls the url fal gave us instead of
      // one we rebuilt. Re-read each pass: submit writes the urls, and a
      // recovery can add them to a job that is already being polled.
      const storedMeta = listJobs().find((j) => j.id === job.id)?.provider?.providerMeta ?? null
      const status = await provider.getGenerationStatus(taskId, storedMeta)
      if (!status.ok) {
        // Our path is wrong, not the generation. Stop polling, keep the task.
        if (status.error.code === 'endpoint-unverified') {
          return markStatusEndpointUnverified(job.id, label, taskId, status.error.message)
        }
        // A transport hiccup must not lose the task — keep polling.
        if (status.error.retryable) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
          continue
        }
        return { ok: false, reason: status.error.message }
      }

      updateJobProvider(job.id, {
        providerStatus: status.providerStatus,
        lastPolledAt: Date.now(),
        providerMeta: status.meta
      })

      if (status.state === 'succeeded') {
        resultUrl = status.resultUrl
        break
      }
      if (status.state === 'failed') {
        return {
          ok: false,
          reason: `${label} reported the task as failed (${status.providerStatus}). Use Regenerate to start a new paid generation.`
        }
      }
      ctx.onProgress(60)
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    }
  } else {
    // Resuming a succeeded task whose download did not land.
    const status = await provider.getGenerationStatus(taskId)
    if (!status.ok) {
      if (status.error.code === 'endpoint-unverified') {
        return markStatusEndpointUnverified(job.id, label, taskId, status.error.message)
      }
      return { ok: false, reason: status.error.message }
    }
    resultUrl = status.resultUrl
  }

  if (!resultUrl) {
    return { ok: false, reason: `${label} reported success but returned no result video reference.` }
  }

  // ── Download → validate → attach ───────────────────────────────────────
  ctx.onProgress(85)
  setJobPhase(job.id, 'downloading')
  const attached = await downloadAndAttachResult(
    provider,
    job.projectId,
    subject,
    resultUrl,
    job.id,
    job.provider?.model ?? null
  )
  if (!attached.ok) {
    // The remote task metadata is intentionally preserved so the DOWNLOAD
    // can be retried without paying for a new generation.
    return { ok: false, reason: `${attached.reason} The remote task is kept — Retry downloads again without regenerating.` }
  }

  // Actual cost: only a verified rate × duration, clearly derived. Credits
  // are the real unit; money stays null unless a verified conversion exists.
  const usage = provider.estimateUsage(request)
  updateJobProvider(job.id, {
    providerStatus: 'succeeded',
    actualCredits: usage?.credits ?? null,
    actualCost: usage?.money?.amount ?? null,
    lastPolledAt: Date.now()
  })
  // Refine the ledger entry rather than adding one: the charge was already
  // recorded at submission. This only fills in the outcome and the real
  // rate now that both are known — the row, and the money, stay.
  if (taskId) {
    settleGenerationSpend(job.projectId, taskId, {
      status: 'succeeded',
      actualCost: usage?.money?.amount ?? null
    })
  }
  return { ok: true }
}

registerRunner('ai-generation', async (job, ctx) => {
  const pairKeys = job.metadata.pairKeys ?? []
  const settings = readSettings()
  const config = activeProviderConfig(settings)
  // Settings carry the safety lock and the verified contract — the runner
  // must never construct a provider without them.
  const provider: VideoProvider = createProvider(config, settings)
  const dryRun = job.provider?.dryRun ?? config?.mode !== 'live'

  const project = listProjects().find((p) => p.id === job.projectId)
  if (!project) throw new Error('Project no longer exists')

  // Idempotency gate — see the state machine at the top of this file.
  // The recorded note is read too, so a job that failed before the
  // structured provider code existed is still recognised as terminal.
  const action = resolveGenerationAction(job.provider, job.note)
  // In DRY RUN we cannot poll a remote task — and we must never resubmit
  // one either. Live resume-poll is handled inside runLiveTransition.
  if (action === 'resume-poll' && dryRun) {
    throw new Error(
      `A remote task (${job.provider?.providerTaskId}) already exists for this job. Dry Run cannot poll it — switch to Live mode to resume, and it will never be resubmitted automatically.`
    )
  }
  if (action === 'blocked') {
    throw new Error(
      'The remote task for this job failed. Use Regenerate to start a deliberate new generation.'
    )
  }

  const previews: SanitizedRequestPreview[] = []
  const problems: string[] = []

  for (const [index, pairKey] of pairKeys.entries()) {
    const built = buildGenerationRequest(job.projectId, pairKey, settings)
    if (!built.ok) {
      problems.push(`${pairKey}: ${built.reason}`)
      continue
    }

    const configCheck = provider.validateConfiguration(built.request.modelId)
    if (!configCheck.ok) {
      problems.push(`${pairKey}: ${configCheck.error.message}`)
      continue
    }
    const valid = provider.validateRequest(built.request)
    if (!valid.ok) {
      problems.push(`${pairKey}: ${valid.error.message}`)
      continue
    }

    if (dryRun) {
      // DRY RUN: validate + build only. No client method is reachable from
      // here, so no HTTP request and no upload can occur.
      const result = provider.dryRun(built.request)
      if ('error' in result) problems.push(`${pairKey}: ${result.error.message}`)
      else previews.push(result.preview)
      ctx.onProgress(Math.round(((index + 1) / pairKeys.length) * 100))
      continue
    }

    // ── LIVE ────────────────────────────────────────────────────────────
    // Re-checked HERE in main; the renderer is never trusted for this.
    const eligibility = liveEligibility(settings, pairKeys.length)
    if (!eligibility.allowed) {
      throw new Error(`Live generation refused: ${eligibility.reasons.join(' ')}`)
    }
    const outcome = await runLiveGenerationJob(provider, job, pairKey, built.request, ctx)
    if (!outcome.ok && outcome.endpointUnverified) {
      // The remote task is alive and paid for — the transition really IS
      // generating, we just cannot read its status yet. Record that truth
      // and surface the message verbatim, without a pair-key prefix.
      const current = listProjects().find((p) => p.id === job.projectId)
      if (current) {
        const transition = current.transitions[pairKey]
        if (transition) current.transitions[pairKey] = { ...transition, status: 'generating' }
        current.updatedAt = Date.now()
        saveProject(current)
        broadcastProjectUpdated(current.id)
      }
      throw new Error(outcome.reason)
    }
    if (!outcome.ok) problems.push(`${pairKey}: ${outcome.reason}`)
    ctx.onProgress(100)
  }

  // Persist generation state. A dry run NEVER produces media, so the clip
  // field is untouched and the state says so plainly.
  const fresh = listProjects().find((p) => p.id === job.projectId)
  if (!fresh) throw new Error('Project no longer exists')
  let withClip = 0
  for (const key of pairKeys) {
    const current = fresh.transitions[key]
    if (!current) continue
    const hasClip = current.clip ? clipPath(fresh.id, current.clip.storedName) !== null : false
    if (hasClip) withClip++
    // `status` is the GENERATION state and is deliberately independent of
    // clip availability — a dry run legitimately completes having produced
    // nothing, and says so in its note rather than fabricating media.
    //
    // The one case that must NOT read as completed is a LIVE run that was
    // supposed to produce a clip and has none: that is the state where the
    // Queue and the editor disagree, and the honest answer is that the paid
    // generation did not finish delivering. `problems` normally catches it
    // and fails the job; this is the belt-and-braces so no path can leave a
    // live pair claiming completion with nothing to play.
    const liveWithoutClip = !dryRun && !hasClip
    fresh.transitions[key] = {
      ...current,
      status: problems.length > 0 || liveWithoutClip ? 'failed' : 'completed'
    }
  }
  fresh.updatedAt = Date.now()
  saveProject(fresh)
  broadcastProjectUpdated(fresh.id)

  if (problems.length > 0 && previews.length === 0) {
    throw new Error(problems.join('; '))
  }

  const providerLabel =
    job.provider?.provider === 'fal'
      ? 'fal.ai'
      : job.provider?.provider === 'kling'
        ? 'Kling'
        : 'mock provider'
  const withoutClip = pairKeys.length - withClip
  const note = dryRun
    ? `Dry run — no ${providerLabel} request sent (${previews.length}/${pairKeys.length} request${previews.length === 1 ? '' : 's'} built and validated).` +
      (withoutClip > 0 ? ` No video output for ${withoutClip} transition${withoutClip === 1 ? '' : 's'}.` : '') +
      (problems.length > 0 ? ` Issues: ${problems.join('; ')}` : '')
    : `Generation finished (${providerLabel}).`

  return { note }
})
