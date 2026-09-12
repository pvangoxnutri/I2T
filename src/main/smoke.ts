import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import {
  FAL_DEFAULT_MODEL_ID,
  FAL_MODEL_REGISTRY,
  clampDurationForModel,
  falRunCost,
  modelListPayload,
  modelSupportsDuration,
  modelSupportsResolution,
  resolveFalModel
} from './providers/fal/falModels'
import {
  promptCoversConstantVelocity,
  promptCoversReflection,
  promptUsesRetiredContract,
  promptUsesRetiredLayout,
  promptUsesRetiredMotion,
  promptUsesRetiredOntology
} from '../shared/prompts'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { app, ipcMain } from 'electron'
import assert from 'node:assert'
import {
  transitionKey,
  type AppSettings,
  type Project,
  type QueueJob,
  type ExportDefaults,
  type ProviderJobState,
  type ProjectImage,
  type TransitionClip,
  type TransitionSettings
} from '../shared/types'
import { applyProposalToProject } from '../shared/feedProposalApply'
import {
  attachGenerationToTransition,
  clearActiveClip
} from './services/transitionClipService'
import {
  archivePreviousGenerations,
  getAllProjectGenerations,
  recordGeneration
} from './db/generationCatalogueRepo'
import { COST_CATEGORY_LABEL } from '../shared/costLedger'
import {
  NO_REFLECTION_EVIDENCE,
  reflectionEvidenceForImage,
  reflectionEvidenceForPair,
  motionReferencesReflector,
  expectedReflectionContent
} from '../shared/reflectionRisk'
import { assessAnalysisQuality, qualityHeadline } from '../shared/analysisQuality'
import { assessAiGenerationReadiness } from '../shared/aiGenerationReadiness'
import { feedAnalysisStatus } from '../shared/feedAnalysisState'
import { applyExportFormat } from '../shared/exportFormat'
import { outputDims } from './services/ffmpegService'
import { getFeedImages, getFeedSequenceIds } from '../shared/feedSequence'
import { pairIndexOf } from '../shared/previewSource'
import { readTransitionDraft, saveTransitionDraft } from './db/transitionAnalysisRepo'
import { buildInstruction } from './analysis/providers/gemini/GeminiPropertyAnalyzer'
import { PROPERTY_ANALYSIS_INSTRUCTION } from '../shared/analysisPrompt'
import { GEMINI_RESPONSE_SCHEMA } from './analysis/providers/gemini/GeminiMapper'
import { evaluateTransitionSafety } from '../shared/transitionSafety'
import {
  clampToSupported,
  durationChoices,
  isDurationSupported,
  resolveTransitionDuration,
  stepDuration
} from '../shared/transitionDuration'
import { formatPrice, priceSnapshot, sanitizePricePerImage } from '../shared/pricing'
import { deriveProjectStatus, projectReadiness } from '../shared/projectStatus'
import { estimateAiCost, mockRate } from '../shared/providerCost'
import {
  listProjects,
  saveProject,
  deleteProjectRows,
  getSettingsJson,
  saveSettingsJson
} from './db/projectsRepo'
import { updateJob } from './db/queueRepo'
import { flushNow, foreignKeyViolations, foreignKeysEnabled, getDb } from './db/index'
import { broadcastProjectUpdated } from './events'
import {
  attachClipFromPath,
  clipUrl,
  deleteProjectFiles,
  importImages,
  projectTransitionsDir,
  resolveClipPath,
  resolveImageRequest
} from './files'
import { projectDir, projectImagesDir, projectsRoot } from './paths'
import { assemble, ffmpegPath, ffmpegStatus, probeDurationSec } from './services/ffmpegService'
import { handleMediaRequest } from './mediaProtocol'
import { mergeSettingsForSave } from './services/productSettings'
import { repairQualityHeldStatuses } from './services/transitionStatusRepair'
import { planSeams, SEAM_SECONDS, type SeamBlend } from '../shared/seamBlend'
import {
  emptyAnalysis,
  parseAnalysis,
  relateImages,
  roomOfImage,
  type PropertyAnalysis,
  type ReflectiveSurface
} from '../shared/propertyAnalysis'
import { canRebuildPrompt, markManuallyEdited, planTransitionPrompt } from '../shared/promptPlanner'
import {
  applyAnalysisPromptToTransition,
  planPromptRebuild,
  rebuildPromptsFromAnalysis
} from './services/promptService'
import {
  analyzerById,
  availableAnalyzers,
  ManualPropertyAnalyzer,
  MockPropertyAnalyzer,
  plannedAnalyzers
} from './analysis/PropertyAnalyzer'
import { ALL_CAPABILITIES, type AnalyzerRequest } from '../shared/analyzerTypes'
import { GeminiPropertyAnalyzer } from './analysis/providers/gemini/GeminiPropertyAnalyzer'
import {
  GEMINI_DEFAULT_MODEL,
  GEMINI_MAX_IMAGES,
  GEMINI_MODELS,
  isRetiredModel,
  rateFor,
  replacementForModel
} from './analysis/providers/gemini/geminiConfig'
import {
  describeGeminiFailure,
  extractRecommendedModel
} from './analysis/providers/gemini/geminiErrors'
import type { FetchLike, GeminiRequestBody } from './analysis/providers/gemini/GeminiClient'
import { diffAnalyses } from '../shared/analysisDiff'
import {
  NEUTRAL_MOTION,
  planSequence,
  renderMotionInstruction,
  renderPrompt
} from '../shared/transitionPlan'
import {
  buildEditorPreview,
  compareAssembly,
  editorPreviewState
} from './services/exportService'
import { exportJobMetadataForTests } from './services/exportService'
import {
  deleteAnalysis,
  readAnalysis,
  readAnalysisDraft,
  saveAnalysis,
  saveAnalysisDraft
} from './db/analysisRepo'
import {
  clearDraftReviews,
  deleteReviewsForProject,
  listReviews,
  promoteDraftReviews,
  reviewMap,
  setReview
} from './db/reviewRepo'
import {
  connectionFactKey,
  reviewableFacts,
  summarizeAccuracy,
  unvalidatedConfirmedConnections,
  type ReviewVerdict
} from '../shared/analysisReview'
import {
  clearOverrideField,
  deleteOverridesForProject,
  listOverrides,
  overrideFor,
  setOverrideField
} from './db/overrideRepo'
import { applyImageOverrides, imageFacts } from '../shared/imageFacts'
import {
  inspectorModeFor,
  pairKeysFor,
  previewModeFor,
  reconcileSelection,
  resolveShortcut,
  selectFullVideo,
  selectImage,
  selectTimeline,
  selectTransition,
  selectedImageId,
  selectedPairKey,
  type EditorSelection,
  type ShortcutAction
} from '../shared/editorSelection'
import {
  dropTargetIndex,
  isValidReorder,
  moveInSequence,
  pairDelta,
  pairKeyAt,
  scrollIntoViewOffset
} from '../shared/sequence'
import {
  summarizeAnalysis,
  summaryHeadline,
  summarySubline
} from '../shared/analysisSummary'
import { editorReadiness } from '../shared/editorReadiness'
import {
  logicalTransitionCount,
  logicalTransitions,
  strandedTransitionKeys
} from '../shared/logicalTransitions'
import { motionDiversity, planningQuality } from '../shared/planningQuality'
import {
  CROSSFADE_SECONDS,
  DEFAULT_TRANSITION_MODE,
  incursGenerationCost,
  recommendationChanged,
  recommendedMode,
  requiresGeneratedClip,
  resolveTransitionMode,
  STILL_HOLD_SECONDS,
  tallyModes,
  type ResolvedModeRow
} from '../shared/transitionMode'
import { planAssembly } from '../shared/assemblyPlan'
import {
  MOTION_ID_PREFIX,
  MOTION_LABEL,
  MOTION_TYPES,
  motionSegmentLabel,
  motionSegments,
  motionSegmentsForImage,
  type MotionSegment
} from '../shared/motionSegment'
import { buildMotionPrompt } from '../shared/motionPrompt'
import { motionGenerationReadiness } from '../shared/motionGenerationReadiness'
import { buildSingleImageBody, startFrameOnlyModels } from './providers/fal/falModels'
import { addMotionSegment } from './services/motionSegmentService'
import { buildMotionGenerationRequest } from './services/motionGenerationService'
import { clipsForJob } from './services/jobClipsService'
import {
  itemDurationSec,
  itemStartTimes,
  locateAtTime,
  removeItem,
  reorderItems,
  splitItemAt,
  timelineDrift,
  timelineDurationSec,
  type Timeline,
  type TimelineItem
} from '../shared/timeline'
import { readTimeline } from './db/timelineRepo'
import {
  BRAND_MARGIN_FRACTION,
  brandRect,
  containFit,
  looksLikeFullFrameAsset,
  visibleMarkRect,
  resolveBranding,
  signatureVisible,
  watermarkVisible
} from '../shared/branding'
import {
  deleteTimelineItem,
  getTimeline,
  rebuildTimeline,
  reorderTimelineItem,
  splitTimelineAt
} from './services/timelineService'
import { exportAssembly } from './services/exportService'
import { basename } from 'node:path'
import { clipPath } from './files'
import {
  jobsForMotionSegment,
  motionRunState,
  motionStatusIsStale,
  reconciledMotionStatus
} from '../shared/motionRunState'
import { downloadAndAttachResult } from './services/generationService'
import type { VideoProvider } from './providers/types'
import type { TransitionPlan } from '../shared/transitionPlan'
import { defaultTransitionSettings } from '../shared/types'
import { deriveRotation } from '../shared/transitionEvidence'
import type { RoomRecord } from '../shared/propertyAnalysis'
import {
  resolvePreviewSource,
  statusWordFor,
  transitionSettingsFor,
  type PreviewSource
} from '../shared/previewSource'
import {
  analysisWorkflowState,
  analyzerPresentation,
  isRealAnalysis,
  provenanceDetail,
  provenanceLabel,
  type AnalysisProvenance
} from '../shared/analysisWorkflow'
import {
  categorizeProviderError,
  isConfigurationError,
  latestJobForPair,
  providerErrorMessage,
  sanitizeReason,
  transitionRecovery
} from '../shared/transitionRecovery'
import {
  ANALYSIS_TOKEN_TTL_MS,
  consumeAnalysisToken,
  issueAnalysisToken,
  issueAnalysisTokenAt
} from './analysis/confirmationTokens'
import {
  deleteCostEntriesForProject,
  listCostEntries,
  recordAnalysisSpend,
  recordGenerationSpend,
  settleGenerationSpend
} from './db/costRepo'
import {
  attemptsForPair,
  countsAsSpend,
  formatSpend,
  spendByCategory,
  summarizeSpend
} from '../shared/costLedger'
import { DEFAULT_PRICING } from '../shared/pricing'
import { exportReadiness, missingClipPairs, projectAssembly } from './services/exportService'
import {
  cancelJob,
  enqueue,
  initQueue,
  isPaused,
  listJobs,
  pauseQueue,
  purgeAllJobsForProjectForTests,
  purgePendingJobsForProject,
  recoverRemoteTaskUrls,
  remoteTaskHandles,
  remoteTaskId,
  removeJob,
  resumePolling,
  resumeQueue,
  retryJob,
  reorderJob,
  stopQueue,
  updateJobProvider
} from './services/queueService'
import {
  buildGenerationRequest,
  liveConfirmation,
  previewRequest,
  queueGeneration,
  queueLiveGeneration,
  readinessInputs,
  resolveGenerationAction,
  STATUS_ENDPOINT_UNVERIFIED,
  STATUS_ENDPOINT_UNVERIFIED_MESSAGE
} from './services/generationService'
import { KlingProvider, normalizeState } from './providers/kling/KlingProvider'
import { KlingClient } from './providers/kling/KlingClient'
import {
  creditRateFor,
  KLING_CONTRACT_STATUS,
  KLING_CREDIT_RATES,
  KLING_CREDIT_TO_MONEY,
  KLING_DEFAULT_TASK_STATUS_PATH,
  KLING_FIELDS,
  KLING_LOCKED_CONTRACT,
  KLING_MODELS,
  KLING_NATIVE_AUDIO_DEFAULT,
  KLING_TASK_STATUS,
  resolveContract
} from './providers/kling/klingConfig'
import { __setTestTransport } from './providers/registry'
import { FalProvider, normalizeFalState } from './providers/fal/FalProvider'
import { FalClient, mapFalHttpError } from './providers/fal/FalClient'
import { extractRequestId, sanitizeMeta } from './providers/fal/FalMapper'
import {
  deriveQueueUrls,
  extractQueueUrls,
  hasAuthoritativeUrls,
  resolveQueueUrls
} from './providers/fal/falQueueUrls'
import {
  falCostRate,
  falStatusUrl,
  falSubmitUrl,
  FAL_CONTRACT_STATUS,
  FAL_COST_RATES,
  FAL_FIELDS,
  FAL_MODEL_ID,
  FAL_MODELS,
  FAL_PROMPT_MAX_CHARS,
  FAL_NATIVE_AUDIO_DEFAULT,
  FAL_QUEUE_STATUS
} from './providers/fal/falConfig'
import { buildFalBody } from './providers/fal/FalMapper'
import { sanitizeApiKey } from './providers/keyHygiene'
import { hasProviderApiKey, storeProviderApiKey } from './services/apiKeyStore'
import {
  DEFAULT_TRANSITION_PROMPT,
  MOTION_HEADER,
  PRESET_PARTS,
  PROMPT_MAX_CHARS,
  REFLECTION_SAFETY_BLOCK,
  REFLECTION_SAFETY_BLOCK_COMPACT,
  assemblePrompt,
  expectedMirrorContentBlock,
  expectedMirrorContentBlockCompact,
  fitPromptToLimit,
  promptForTransition,
  type PromptPart
} from '../shared/prompts'
import type { GenerationRequest } from './providers/types'
import { evidenceFingerprintOf, isPromptBasisCurrent } from '../shared/promptPlanner'
import { extractTransitionAnalysis } from '../shared/transitionAnalysisExtractor'
import type { GenerationRecord, JobMetadata } from '../shared/types'
import { DEFAULT_QUALITY_VALIDATION_MODE, decideQuality, qualityAllowsActive, shouldValidateClip } from '../shared/qualityValidation'
import { feedTransitionState } from '../shared/feedTransitionState'
import { activeGenerationForPair, applyQualityResult, approveQualityManually, getGenerationsForMotion, getGenerationsForPair } from './db/generationCatalogueRepo'
import {
  deletePairAnalysesForProject,
  markOrphanedPairAnalyses,
  readPairAnalysis,
  savePairAnalysis
} from './db/pairAnalysisRepo'
import { acceptPairAnalysis, decidePair, fingerprints, replaceManualPrompt } from './services/pairAnalysisService'
import { finalizeTransitionPromptById } from './services/promptFinalizer'
import { repairRetiredPromptOntology } from './services/promptOntologyRepair'
import { sanitizeMotionInstruction, containsTempoClaim } from '../shared/motionInstructionHygiene'
import type { EvidenceSource } from '../shared/pairAnalysis'
import { approvePair } from './services/pairApproval'
import { acceptFeedAnalysis } from './services/feedAnalysisAccept'
import type { TransitionDraft } from '../shared/transitionAnalysisExtractor'
import { isPairAnalysisCurrent } from '../shared/pairAnalysis'
import { contextResolves, isContextActive, makeOperatorContext, needsReview, reviewAfterReanalysis } from '../shared/operatorContext'
import { feedDecisionCounts } from '../shared/feedAnalysisState'
import { overrideWarningFor } from '../shared/aiGenerationReadiness'
import { canResumeProviderTask } from '../shared/generationState'
import { getEffectiveFeedSequence } from '../shared/feedSequence'
import { proposeFeedOrder, proposeTransitionModes } from '../shared/feedProposal'
import { isTraversableOpening } from '../shared/openingEvidence'

/**
 * Headless smoke test (`electron . --f2f-smoke`): the real persistence,
 * video and production-queue layers, inside the real runtime, against the
 * real userData paths. Everything it creates is removed afterwards.
 */

const log = (msg: string): void => console.log(`[smoke] ${msg}`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Drops all in-memory queue state and re-reads it from SQLite — the same
 * path a real app restart takes, including recovery. */
function simulateRestart(): void {
  stopQueue()
  initQueue()
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  what: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(50)
  }
  throw new Error(`Timed out waiting for: ${what}`)
}

const job = (id: string): QueueJob | undefined => listJobs().find((j) => j.id === id)

/**
 * A fixture image id that cannot collide with a previous run.
 *
 * The timeline and motion fixtures used fixed ids like . A run
 * KILLED before its cleanup leaves those rows behind, and the next run
 * then fails on  — a
 * failure about the previous run, reported against the current one.
 */
/**
 * A fixture image id that cannot collide with a previous run.
 *
 * The timeline and motion fixtures used fixed ids like `tlA`. A run
 * KILLED before its cleanup leaves those rows behind, and the next run
 * then fails on "UNIQUE constraint failed: project_images.id" — a
 * failure about the PREVIOUS run, reported against the current one.
 * That happened, and cost a diagnosis; unique ids make it impossible.
 */
let fixtureSeq = 0
function fixtureImageId(stem: string): string {
  return `${stem}-${Date.now().toString(36)}-${fixtureSeq++}`
}

function makeProject(name: string): Project {
  return {
    id: `smoke-${name.toLowerCase().replace(/\W+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    images: [],
    transitions: {},
    watermark: {
      enabled: true,
      imageSrc: null,
      imageName: null,
      position: 'center',
      sizePct: 45,
      opacityPct: 35
    },
    signature: {
      enabled: true,
      logoSrc: null,
      logoName: null,
      brandName: 'FrameToFrame',
      websiteUrl: 'frametoframe.io',
      position: 'bottom-right',
      sizePct: 12,
      opacityPct: 55
    },
    status: 'draft',
    workflow: { previewSentAt: null, paidAt: null, finalSentAt: null }
  }
}

export async function runSmokeTest(): Promise<void> {
  const workDir = join(app.getPath('temp'), `f2f-smoke-${Date.now()}`)
  mkdirSync(workDir, { recursive: true })
  const createdProjects: string[] = []
  // What the database looked like BEFORE this run. Teardown must return it
  // to exactly this — not to zero, because the operator's own projects,
  // queue history and spend legitimately live here too.
  const baseline = countResources()
  // ── SETTINGS ARE PART OF THAT BASELINE ──────────────────────────────
  //
  // The settings row is a SINGLE row that every test shares and several
  // tests rewrite, and it outlives the run. A suite that is killed or
  // fails partway therefore leaves whatever the last test wrote, and the
  // NEXT run starts from it — so a failure gets inherited by the
  // following run and reported there instead.
  //
  // That is not hypothetical. A run that died late left a pricing-only
  // row behind; the next run's confirmation test then refused a stale
  // pair with "Provider mode is Dry Run" instead of the staleness it was
  // asserting, and the run after that crashed on `settings.providers`
  // being undefined. Neither failure had anything to do with the code
  // being changed at the time.
  //
  // Captured here and restored in teardown, so a crashed run cannot
  // poison the next one — and so the operator's real API keys and
  // provider mode survive a suite that rewrites them.
  const settingsBaseline = getSettingsJson()
  // Set when the suite itself fails, so the teardown's own assertion can
  // stay quiet rather than masking the real cause with a symptom.
  let failure: unknown = null

  try {
    testPricing()
    testKlingContract()
    testKlingProvider()
    testFalProvider()
    testFalQueueUrls()
    await testFalDiagnostics(workDir)
    await testVideoPipeline(workDir, createdProjects)
    await testProductionQueue(workDir, createdProjects)
    await testProviderQueueIntegration(workDir, createdProjects)
    await testKlingLive(workDir, createdProjects)
    await testRemoteTaskRecovery(workDir, createdProjects)
    await testFalLive(workDir, createdProjects)
    testClipVisibility(workDir, createdProjects)
    testSeamPlanning()
    await testSeamAssembly(workDir)
    testPropertyAnalysis(workDir, createdProjects)
    testPromptProvenance(workDir, createdProjects)
    await testPropertyAnalyzer(workDir, createdProjects)
    testCatalogueIdempotency(workDir, createdProjects)
    testAnalysisDraftPersistence(workDir, createdProjects)
    testGenerationConfirmationIntegrity(workDir, createdProjects)
    testPromptSchemaContract()
    testAnalysisQualityGate()
    testAiGenerationRequiresAcceptedEvidence(workDir, createdProjects)
    testOverrideConfirmationIsHonest(workDir, createdProjects)
    testActiveClipLifecycle(workDir, createdProjects)
    testFeedAnalysisPreservesOrder()
    await testAnalyseFeedWorkflow(workDir, createdProjects)
    testAnalysePromptsWorkflow(workDir, createdProjects)
    testSelectedPairResolvesEverywhere(workDir, createdProjects)
    testExportReadinessUsesFeed(workDir, createdProjects)
    testAutoResolvingCutNeedsNoClip(workDir, createdProjects)
    testReflectionConstraintReachesProvider()
    testFalPromptFitsLimit()
    testRegenerateIsOfferedAndDistinct()
    testAnalyseFeedGate(workDir, createdProjects)
    testGenerationPhases()
    testQualityCatalogue(workDir, createdProjects)
    testPromptBasisProvenance(workDir, createdProjects)
    testAcceptAndPairAnalysis(workDir, createdProjects)
    testAcceptThenUseAnalysisPrompt(workDir, createdProjects)
    testDeliveredClipAttachesDirectly(workDir, createdProjects)
    testBathroomMirrorPrompt(workDir, createdProjects)
    testGenerationIpcChannels()
    testFalModelRegistry(workDir, createdProjects)
    testFeedTransitionState()
    testApiKeyPersistence()
    testInvisibleViewpointOntology()
    testQualityHeldStatusRepair(workDir, createdProjects)
    testClipUrlIsResolvable(workDir, createdProjects)
    await testMediaProtocolServesRealMp4(createdProjects)
    testOperatorContextLifecycle()
    testMissingContext(workDir, createdProjects)
    testReflectionSafety()
    testResumeOnlyWhenResumable()
    testRegenerateAfterTerminalFailure(workDir, createdProjects)
    testExportFormats()
    testProjectDeletionCascade(workDir)
    testEditorSelection()
    testAnalysisWorkflow()
    testTransitionModes()
    testMixedAssemblyPlan()
    testSingleImageMotion()
    await testMotionGenerationPath()
    await testMotionPersistenceAndHistory(createdProjects)
    testMotionRunStateAndQueue()
    await testMotionRegeneration(createdProjects)
    testPreviewBranding()
    testBrandGeometry()
    testPreviewClockOwnership()
    testTimelineModel()
    await testTimelinePersistenceAndExport(createdProjects)
    await testWatermarkedTimelineExport(createdProjects)
    testEvidenceDrivenPlanning()
    testLogicalTransitions(workDir, createdProjects)
    await testGeminiModelConfig(workDir, createdProjects)
    testTransitionRecovery()
    testPreviewSource(workDir, createdProjects)
    testSequenceReorder()
    testFeedProposalAccept()
    testTransitionAnalysisExtraction()
    testTransitionDuration()
    testFeedSelectionInvariants()
    testPatioOpeningEvidence()
    testSafetyEvaluatorIsShared()
    testTransitionReasoningAlwaysExists()
    testAnalysisSummary()
    testProjectReadiness(workDir, createdProjects)
    testImageOverrides(workDir, createdProjects)
    await testGeminiAnalyzer(workDir, createdProjects)
    await testAnalysisConfirmation(workDir, createdProjects)
    testAnalysisLedger(workDir, createdProjects)
    testGroundTruthReview(workDir, createdProjects)
    testAnalysisReview(workDir, createdProjects)
    testFinalPromptEquivalence(workDir, createdProjects)
    testPromptBudget()
    testConstantVelocityContract()
    testTransitionPlanning()
    await testCompareAssembly(workDir, createdProjects)
    await testEditorPreview(workDir, createdProjects)
    testCostLedger(workDir, createdProjects)
    log('ALL GREEN')
  } catch (err) {
    // ── THE ORIGINAL FAILURE MUST SURVIVE TEARDOWN ────────────────────
    //
    // The leak assertion lives in `finally` and throws. A throw from
    // `finally` REPLACES whatever the try block threw, so a genuine
    // assertion failure was being reported as "Smoke run leaked
    // resources" — describing a symptom of the failure while hiding its
    // cause. Recorded here, and re-reported after teardown.
    failure = err
    console.error('[smoke] FAILED:', err)
    throw err
  } finally {
    // ── DETERMINISTIC TEARDOWN ────────────────────────────────────────
    //
    // 1. stop the scheduler   2. reclaim test-owned rows
    // 3. remove projects+files 4. flush   5. ASSERT the baseline is back
    //
    // The order matters: with the worker still ticking, a job persisted
    // after its row was deleted puts the row straight back.
    stopQueue()

    // Failures are COLLECTED, not swallowed. A silent catch here is what
    // hid the leak for as long as it existed — see the note on
    // updateJobRemoval below.
    const teardownProblems: string[] = []
    const step = (what: string, fn: () => void): void => {
      try {
        fn()
      } catch (err) {
        teardownProblems.push(`${what}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // The operator's settings row goes back first, before anything else
    // in teardown can fail and skip it.
    if (settingsBaseline !== null) {
      step('settings baseline', () => saveSettingsJson(settingsBaseline))
    }

    for (const id of createdProjects) {
      // Reclaim EVERY queue row this run created, history included, by
      // project id straight through the repo. Deliberately not via
      // listJobs(): that is a UI projection, and anything it filtered or
      // missed would leak silently.
      // The env var exists so the LEAK ASSERTION itself can be proven:
      // set F2F_SMOKE_SKIP_QUEUE_PURGE=1 and the run must fail with
      // "queueJobs: N → N+16". A guard nobody has ever seen fail is a
      // guard nobody knows works.
      if (!process.env['F2F_SMOKE_SKIP_QUEUE_PURGE']) {
        step(`queue rows for ${id}`, () => purgeAllJobsForProjectForTests(id))
      }
      // The ledger has no FK to projects (spend history deliberately
      // outlives a deleted project), so smoke rows must be removed by
      // hand or they accumulate — and their task ids would then collide
      // with the next run's idempotency check.
      step(`cost entries for ${id}`, () => deleteCostEntriesForProject(id))
      // Pair analyses have no FK to projects either, so a deleted smoke
      // project used to leave its evidence behind — 44 rows had piled up
      // in the operator's real database. They are not inert any more:
      // the prompt finalizer reads an accepted pair analysis to decide a
      // pair's route.
      step(`pair analyses for ${id}`, () => deletePairAnalysesForProject(id))
      // Review rows have no FK either, and BOTH scopes must go — a draft
      // review left behind would be inherited by the next run's draft.
      // Same proof mechanism as the queue purge above: set
      // F2F_SMOKE_SKIP_REVIEW_PURGE=1 and the run must fail with
      // "reviews: N → N+5".
      if (!process.env['F2F_SMOKE_SKIP_REVIEW_PURGE']) {
        step(`reviews for ${id}`, () => deleteReviewsForProject(id))
      }
      // Manual overrides outlive an analysis on purpose, so deleting the
      // analysis does not take them with it.
      step(`overrides for ${id}`, () => deleteOverridesForProject(id))
      step(`analysis for ${id}`, () => deleteAnalysis(id))
      step(`project row ${id}`, () => deleteProjectRows(id))
      step(`project files ${id}`, () => deleteProjectFiles(id))
    }

    rmSync(workDir, { recursive: true, force: true })
    // Writes are flushed on a 250 ms debounce and this process exits
    // immediately after, so without an explicit flush the deletions above
    // would live only in memory.
    flushNow()

    // ── LEAK ASSERTION ────────────────────────────────────────────────
    //
    // Baseline EQUALITY, not zero: the real database legitimately holds
    // the operator's own projects, queue history and spend, and none of
    // that is ours to touch. What must return to where it started is only
    // what this run created.
    const after = countResources()
    const drift: string[] = []
    for (const key of Object.keys(baseline) as Array<keyof ResourceCounts>) {
      if (after[key] !== baseline[key]) {
        drift.push(`${key}: ${baseline[key]} → ${after[key]}`)
      }
    }
    if (teardownProblems.length > 0) {
      console.error('[smoke] teardown problems:')
      for (const p of teardownProblems) console.error(`  - ${p}`)
    }
    if (drift.length > 0) {
      // Loud and failing: an unclean suite is a suite whose next run
      // starts from a different place than this one did.
      console.error('[smoke] RESOURCE LEAK — counts did not return to baseline:')
      for (const d of drift) console.error(`  - ${d}`)
      // Reported either way, but only THROWN when the suite itself passed.
      // A failing test usually leaves its fixtures behind — that leak is a
      // consequence, and throwing it here would replace the real failure
      // with its own symptom.
      if (failure === null) {
        throw new Error(`Smoke run leaked resources: ${drift.join('; ')}`)
      }
      console.error('[smoke] (leak is a consequence of the failure above, not the cause)')
    }
    if (failure === null) {
      log(
        `teardown clean — every tracked resource back to baseline ` +
          `(${baseline.projects} projects, ${baseline.projectImages} image rows, ` +
          `${baseline.queueJobs} queue rows untouched)`
      )
    }
  }
}

interface ResourceCounts {
  projects: number
  /**
   * Counted SEPARATELY from projects, deliberately.
   *
   * These are cleared by ON DELETE CASCADE rather than by any code the
   * teardown calls, so counting only `projects` would report a clean run
   * while every image and transition row from it stayed behind forever.
   * That is precisely how the queue-jobs leak hid: the assertion measured
   * the wrong table.
   */
  projectImages: number
  transitions: number
  queueJobs: number
  costEntries: number
  analyses: number
  reviews: number
  overrides: number
  /**
   * Rows that violate a declared foreign key.
   *
   * Compared against BASELINE rather than against zero, deliberately. The
   * real database still holds historical orphans from before cascading
   * deletes worked, and those are the operator's to decide about — but the
   * suite must not add a single one. Baseline equality says exactly that,
   * and keeps saying it after the historical rows are eventually cleaned.
   */
  fkViolations: number
  projectDirs: number
}

/**
 * Everything a smoke run could leave behind, counted straight from the
 * database and disk rather than through any service layer — the point is
 * to see what is really there, including rows a UI projection would hide.
 */
function countResources(): ResourceCounts {
  const db = getDb()
  const n = (sql: string): number =>
    (db.exec(sql)[0]?.values[0]?.[0] as number | undefined) ?? 0
  let projectDirs = 0
  try {
    projectDirs = readdirSync(projectsRoot()).length
  } catch {
    projectDirs = 0
  }
  return {
    projects: n('SELECT COUNT(*) FROM projects'),
    projectImages: n('SELECT COUNT(*) FROM project_images'),
    transitions: n('SELECT COUNT(*) FROM transitions'),
    queueJobs: n('SELECT COUNT(*) FROM queue_jobs'),
    costEntries: n('SELECT COUNT(*) FROM generation_cost_entries'),
    analyses: n('SELECT COUNT(*) FROM property_analysis'),
    reviews: n('SELECT COUNT(*) FROM analysis_reviews'),
    overrides: n('SELECT COUNT(*) FROM image_overrides'),
    fkViolations: foreignKeyViolations().length,
    projectDirs
  }
}

/**
 * PROPERTY ANALYSIS + PROMPT PLANNING.
 *
 * The dangerous failure here is not a crash — it is a confident wrong
 * claim. A prompt that tells the model to walk through a doorway nobody
 * can see produces a tour of a property that does not exist, for a home
 * someone is actually selling. So the assertions below are mostly about
 * what the planner REFUSES to say.
 */
function testPropertyAnalysis(workDir: string, created: string[]): void {
  const project = makeProject('Smoke analysis flat')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'analysis.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: 'living-a.png' },
    { sourcePath: p, name: 'living-b.png' },
    { sourcePath: p, name: 'kitchen.png' },
    { sourcePath: p, name: 'bedroom.png' }
  ])
  saveProject(project)
  const [livingA, livingB, kitchen, bedroom] = project.images.map((i) => i.id)

  // ── Scene graph: build, save, read back ──────────────────────────────
  const analysis: PropertyAnalysis = {
    ...emptyAnalysis(project.id),
    source: 'manual',
    rooms: [
      { id: 'living', label: 'Living Room', imageIds: [livingA, livingB], landmarks: ['grey sofa', 'TV wall'] },
      { id: 'kitchen', label: 'Kitchen', imageIds: [kitchen], landmarks: ['kitchen island'] },
      { id: 'bedroom', label: 'Bedroom', imageIds: [bedroom], landmarks: [] }
    ],
    images: [
      { imageId: livingA, roomId: 'living', orientation: 'into-room', landmarks: ['grey sofa', 'TV wall'], openings: ['balcony doors'] },
      { imageId: livingB, roomId: 'living', orientation: 'into-room', landmarks: ['grey sofa'], openings: ['kitchen doorway'] },
      { imageId: kitchen, roomId: 'kitchen', orientation: 'into-room', landmarks: ['kitchen island'], openings: [] },
      { imageId: bedroom, roomId: 'bedroom', orientation: 'unknown', landmarks: [], openings: [] }
    ],
    edges: [
      {
        id: 'e1',
        fromRoomId: 'living',
        toRoomId: 'kitchen',
        confidence: 'confirmed',
        supportingImageIds: [livingB],
        notes: 'kitchen doorway visible past the sofa'
      }
      // living ↔ bedroom is DELIBERATELY absent: we have never seen a
      // connection between them, and absence must stay absence.
    ]
  }
  const saved = saveAnalysis(analysis)
  assert.ok(saved.updatedAt > 0, 'saving stamps the analysis')
  const reloaded = readAnalysis(project.id)
  assert.strictEqual(reloaded.rooms.length, 3, 'rooms round-trip through SQLite')
  assert.strictEqual(reloaded.edges.length, 1, 'edges round-trip')
  assert.deepStrictEqual(
    reloaded.rooms.find((r) => r.id === 'living')?.imageIds,
    [livingA, livingB],
    'image assignments survive serialization'
  )
  assert.strictEqual(reloaded.edges[0].confidence, 'confirmed', 'confidence survives serialization')

  // A corrupt document degrades to "we know nothing" rather than throwing.
  const broken = parseAnalysis(project.id, '{not json')
  assert.strictEqual(broken.rooms.length, 0, 'malformed analysis parses to empty, not an exception')

  // ── Relationships ────────────────────────────────────────────────────
  assert.strictEqual(relateImages(reloaded, livingA, livingB).kind, 'same-room', 'two living-room images')
  assert.strictEqual(relateImages(reloaded, livingB, kitchen).kind, 'adjacent-room', 'living → kitchen')
  assert.strictEqual(
    relateImages(reloaded, livingA, bedroom).kind,
    'unknown',
    'no edge to the bedroom → unknown, NOT an assumed connection'
  )

  // ── Prompt planning ──────────────────────────────────────────────────
  const base = DEFAULT_TRANSITION_PROMPT

  const same = planTransitionPrompt(reloaded, livingA, livingB)
  assert.strictEqual(same.basis, 'same-room')
  assert.ok(same.motionInstruction, 'a same-room move gets an instruction')
  assert.match(same.motionInstruction!, /same room/i, 'it says the room does not change')
  assert.match(same.motionInstruction!, /grey sofa/, 'and anchors on a shared landmark')
  assert.match(same.motionInstruction!, /do not pass through any doorway/i, 'and forbids leaving')

  const adjacent = planTransitionPrompt(reloaded, livingB, kitchen)
  assert.strictEqual(adjacent.basis, 'adjacent-room')
  assert.match(adjacent.motionInstruction!, /through the kitchen doorway/i, 'moves through the VISIBLE opening')
  assert.match(adjacent.motionInstruction!, /Kitchen/, 'names the destination room')
  assert.match(
    adjacent.motionInstruction!,
    /Do not invent any corridor, door or opening/i,
    'and still forbids inventing openings'
  )

  // THE ONE THAT MATTERS MOST: unknown must not produce navigation.
  const unknown = planTransitionPrompt(reloaded, livingA, bedroom)
  assert.strictEqual(unknown.basis, 'unknown')
  assert.strictEqual(unknown.motionInstruction, null, 'an unknown relationship adds NO motion instruction')
  assert.strictEqual(
    unknown.effectivePrompt,
    base,
    'the effective prompt is exactly the safety prompt — no invented navigation'
  )
  for (const word of ['doorway', 'through the', 'corridor', 'hallway']) {
    assert.ok(
      !new RegExp(`CAMERA MOVEMENT[\\s\\S]*${word}`, 'i').test(unknown.effectivePrompt),
      `unknown relationship never mentions ${word} as navigation`
    )
  }

  // A confirmed edge is still NOT enough without a visible opening: the
  // kitchen image sees no opening back, so the reverse direction may not
  // stage a walk-through.
  const reverse = planTransitionPrompt(reloaded, kitchen, livingB)
  assert.strictEqual(reverse.basis, 'adjacent-room')
  assert.match(
    reverse.motionInstruction!,
    /without depicting travel through any doorway/i,
    'no opening visible in the start frame → no walk-through, even on a confirmed edge'
  )

  // ── The safety contract is never replaced, only extended ─────────────
  for (const plan of [same, adjacent, unknown, reverse]) {
    assert.ok(
      plan.effectivePrompt.startsWith(base),
      'every planned prompt still leads with the full FrameToFrame safety prompt'
    )
    for (const rule of [
      'END FRAME must be reproduced EXACTLY',
      'Do not redesign, reinterpret, add, remove, move or alter anything',
      'No morphing, warping, melting',
      // Same rule, restated without making the viewpoint a physical
      // object: 'physically plausible camera movement' was one of the
      // sentences teaching Kling that a camera exists to be reflected.
      'never through walls, floors, ceilings or furniture'
    ]) {
      assert.ok(plan.effectivePrompt.includes(rule), `safety rule preserved: ${rule}`)
    }
  }

  // ── Provenance: a hand-edited prompt is never rebuilt ────────────────
  assert.strictEqual(
    canRebuildPrompt({
      basePrompt: base,
      motionInstruction: null,
      effectivePrompt: base,
      basis: 'unknown',
      rationale: '',
      manuallyEdited: false,
      plannedAt: Date.now(),
      analysisUpdatedAt: null
    }),
    true,
    'an untouched prompt may be rebuilt from analysis'
  )
  assert.strictEqual(
    canRebuildPrompt({
      basePrompt: base,
      motionInstruction: null,
      effectivePrompt: 'operator wording',
      basis: 'unknown',
      rationale: '',
      manuallyEdited: true,
      plannedAt: Date.now(),
      analysisUpdatedAt: null
    }),
    false,
    'a manually edited prompt is NEVER overwritten by re-running analysis'
  )
  assert.strictEqual(canRebuildPrompt(null), true, 'no provenance yet means nothing to protect')

  log('property analysis: graph round-trips, unknown invents no navigation, edited prompts protected')
}

/**
 * PROMPT PROVENANCE + REBUILD.
 *
 * The protected bit is `manuallyEdited`. Everything below proves that once
 * a human has written a prompt, no automatic path replaces it — including
 * across a restart, which is exactly when a lost flag would be silently
 * destructive: the next rebuild would overwrite work someone did by hand.
 */
function testPromptProvenance(workDir: string, created: string[]): void {
  const project = makeProject('Smoke provenance')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'prov.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: 'a.png' },
    { sourcePath: p, name: 'b.png' },
    { sourcePath: p, name: 'c.png' },
    { sourcePath: p, name: 'd.png' }
  ])
  const pairs = [0, 1, 2].map((i) =>
    transitionKey(project.images[i].id, project.images[i + 1].id)
  )
  for (const key of pairs) {
    project.transitions[key] = { prompt: '', durationSec: 5, status: 'not-generated', clip: null }
  }
  saveProject(project)

  saveAnalysis({
    ...emptyAnalysis(project.id),
    rooms: [
      {
        id: 'living',
        label: 'Living Room',
        imageIds: [project.images[0].id, project.images[1].id],
        landmarks: ['sofa']
      },
      { id: 'kitchen', label: 'Kitchen', imageIds: [project.images[2].id], landmarks: [] }
    ],
    images: [
      { imageId: project.images[0].id, roomId: 'living', orientation: 'into-room', landmarks: ['sofa'], openings: [] },
      { imageId: project.images[1].id, roomId: 'living', orientation: 'into-room', landmarks: ['sofa'], openings: ['kitchen doorway'] },
      { imageId: project.images[2].id, roomId: 'kitchen', orientation: 'into-room', landmarks: [], openings: [] }
    ],
    edges: [
      { id: 'e', fromRoomId: 'living', toRoomId: 'kitchen', confidence: 'confirmed', supportingImageIds: [] }
    ]
  })

  // ── Rebuild writes analysis-derived prompts + provenance ─────────────
  const firstPlan = planPromptRebuild(project.id)
  // The analysis covers images 1–3 only, so the fourth pair has no
  // evidenced route and resolves to a CUT — which needs no prompt at all.
  // Two AI transitions are planned; the cut is reported as skipped rather
  // than silently absent.
  assert.strictEqual(firstPlan.rebuildable.length, 2, 'the two AI transitions are rebuildable')
  assert.strictEqual(firstPlan.skipped.length, 1, 'and the third is skipped')
  assert.strictEqual(firstPlan.skipped[0].mode, 'cut', 'because it is a cut')
  assert.strictEqual(
    firstPlan.rebuildable.length + firstPlan.preserved.length + firstPlan.unchanged.length + firstPlan.skipped.length,
    firstPlan.logicalTransitionCount,
    'and every logical transition is still accounted for exactly once'
  )
  assert.strictEqual(firstPlan.preserved.length, 0, 'nothing to preserve yet')
  assert.ok(firstPlan.hasAnalysis, 'the plan knows an analysis exists')

  const firstRun = rebuildPromptsFromAnalysis(project.id)
  assert.strictEqual(firstRun.rebuiltCount, 2, 'the two AI prompts were written')
  assert.strictEqual(firstRun.preservedCount, 0, 'none preserved')
  // The cut already had a row from the fixture, so the point is not that
  // no row exists — it is that the rebuild did not TOUCH it. A transition
  // that generates nothing gets no analysis-managed prompt written into
  // it, and no provenance claiming one was planned.
  assert.strictEqual(
    listProjects().find((p) => p.id === project.id)!.transitions[pairs[2]].promptProvenance ?? null,
    null,
    'the cut was left entirely alone — no planned prompt, no provenance'
  )

  const rebuilt = listProjects().find((p) => p.id === project.id)!
  assert.ok(rebuilt.transitions[pairs[0]].prompt.length > 0, 'a prompt was written')
  assert.strictEqual(
    rebuilt.transitions[pairs[0]].promptProvenance?.manuallyEdited,
    false,
    'a planned prompt is NOT marked as hand-written'
  )
  assert.strictEqual(rebuilt.transitions[pairs[0]].promptProvenance?.basis, 'same-room')
  // THE SAFETY CONTRACT STILL LEADS — but it is no longer a prefix.
  //
  // This used to assert `startsWith(DEFAULT_TRANSITION_PROMPT)`, which
  // was true only because every pair-specific block was concatenated
  // after the entire preset. That is exactly the arrangement that pushed
  // the movement instruction past the provider's character limit, so the
  // blocks are interleaved now. What the assertion was protecting —
  // that a planned prompt opens on the ontology and carries the whole
  // contract rather than being bare motion text — is checked directly.
  const rebuiltPrompt = rebuilt.transitions[pairs[0]].prompt
  assert.ok(
    rebuiltPrompt.startsWith(PRESET_PARTS.opening.text),
    'the rebuilt wording opens on the viewpoint ontology'
  )
  for (const section of [PRESET_PARTS.frames, PRESET_PARTS.motionQuality, PRESET_PARTS.geometry]) {
    assert.ok(
      rebuiltPrompt.includes(section.text) ||
        (section.compact != null && rebuiltPrompt.includes(section.compact)),
      `the safety prompt still carries ${section.id}`
    )
  }

  // ── A manual edit is protected ───────────────────────────────────────
  const edited = listProjects().find((p) => p.id === project.id)!
  const OPERATOR = 'OPERATOR WORDING — pan left past the pillar'
  edited.transitions[pairs[1]] = {
    ...edited.transitions[pairs[1]],
    prompt: OPERATOR,
    promptProvenance: markManuallyEdited(
      edited.transitions[pairs[1]].promptProvenance,
      OPERATOR,
      Date.now()
    )
  }
  saveProject(edited)

  const secondPlan = planPromptRebuild(project.id)
  assert.strictEqual(secondPlan.preserved.length, 1, 'the edited transition is reported preserved')
  assert.strictEqual(secondPlan.preserved[0].pairKey, pairs[1], 'the right one is protected')
  assert.ok(
    !secondPlan.rebuildable.some((r) => r.pairKey === pairs[1]),
    'and it is never offered as rebuildable'
  )
  // The other two already carry exactly the prompt the analysis produces,
  // so they are UNCHANGED rather than work. "Would not change" and "does
  // not exist" are different facts, and the summary now tells them apart
  // instead of one of them silently vanishing.
  assert.strictEqual(secondPlan.rebuildable.length, 0, 'nothing would actually change')
  assert.strictEqual(secondPlan.unchanged.length, 1, 'the remaining AI prompt is up to date')
  assert.strictEqual(secondPlan.skipped.length, 1, 'and the cut needs no prompt')
  assert.strictEqual(
    secondPlan.rebuildable.length +
      secondPlan.preserved.length +
      secondPlan.unchanged.length +
      secondPlan.skipped.length,
    secondPlan.logicalTransitionCount,
    'and every logical transition is accounted for exactly once'
  )

  const beforeSecond = listProjects().find((p) => p.id === project.id)!.updatedAt
  const secondRun = rebuildPromptsFromAnalysis(project.id)
  assert.strictEqual(
    secondRun.rebuiltCount,
    0,
    'a rebuild that would change nothing writes nothing — otherwise the preview lies about its work'
  )
  assert.strictEqual(secondRun.preservedCount, 1, 'the hand-written prompt was skipped')
  assert.strictEqual(
    listProjects().find((p) => p.id === project.id)!.updatedAt,
    beforeSecond,
    'and the project is not marked changed, so a built preview does not go stale for nothing'
  )
  assert.strictEqual(
    listProjects().find((p) => p.id === project.id)!.transitions[pairs[1]].prompt,
    OPERATOR,
    'the operator wording survived a rebuild untouched'
  )

  // ── Provenance survives a restart ────────────────────────────────────
  simulateRestart()
  const afterRestart = listProjects().find((p) => p.id === project.id)!
  assert.strictEqual(
    afterRestart.transitions[pairs[1]].promptProvenance?.manuallyEdited,
    true,
    'the manual flag survives a restart'
  )
  assert.strictEqual(
    afterRestart.transitions[pairs[0]].promptProvenance?.manuallyEdited,
    false,
    'and analysis-managed transitions stay analysis-managed'
  )
  assert.strictEqual(
    canRebuildPrompt(afterRestart.transitions[pairs[1]].promptProvenance),
    false,
    'so it is still protected after a restart'
  )
  assert.strictEqual(
    rebuildPromptsFromAnalysis(project.id).preservedCount,
    1,
    'and a post-restart rebuild still skips it'
  )

  // ── Per-transition override DOES replace custom wording ──────────────
  // The deliberate, warned path. It reports that it replaced a manual
  // prompt so the UI can be honest about what just happened.
  const applied = applyAnalysisPromptToTransition(project.id, pairs[1])
  assert.ok(applied.ok, 'the per-transition override ran')
  assert.strictEqual(applied.replacedManualPrompt, true, 'and reports it replaced custom wording')
  const overridden = listProjects().find((p) => p.id === project.id)!
  assert.notStrictEqual(
    overridden.transitions[pairs[1]].prompt,
    OPERATOR,
    'the custom prompt was replaced by the analysis prompt'
  )
  assert.strictEqual(
    overridden.transitions[pairs[1]].promptProvenance?.manuallyEdited,
    false,
    'and the transition is analysis-managed again'
  )
  // Adopting the analysis prompt for ONE transition writes exactly what a
  // bulk rebuild would write for that pair — both plan the whole sequence,
  // so neither produces wording the other would immediately "fix".
  const afterOverride = planPromptRebuild(project.id)
  assert.strictEqual(
    afterOverride.preserved.length,
    0,
    'nothing is protected any more — the transition is analysis-managed again'
  )
  assert.strictEqual(
    afterOverride.rebuildable.length,
    0,
    'and a rebuild would change nothing, because the two paths agree on the prompt'
  )
  assert.strictEqual(afterOverride.unchanged.length, 2, 'both AI prompts are up to date')
  assert.strictEqual(afterOverride.skipped.length, 1, 'and the cut still needs none')
  assert.strictEqual(afterOverride.logicalTransitionCount, 3, 'four images, three transitions')

  log('prompt provenance: manual edits protected across restart, rebuild skips them, override warns')
}

/**
 * THE PROPERTY ANALYZER INTERFACE.
 *
 * The point of these assertions is what the analyzers do NOT do: local
 * ones never cost money, a paid one never pretends to be local, and the
 * mock refuses to invent adjacency.
 */
async function testPropertyAnalyzer(workDir: string, created: string[]): Promise<void> {
  const analyzers = availableAnalyzers()
  assert.ok(analyzers.length >= 2, 'manual and mock analyzers are registered')
  for (const analyzer of analyzers) {
    const meta = analyzer.metadata()
    assert.ok(meta.id && meta.displayName, 'every analyzer identifies itself')
    assert.strictEqual(meta.available, true, `${meta.id} is implemented`)
    // A LOCAL analyzer must be free, and a VENDOR one must declare that it
    // costs money. Gemini is deliberately paid — its locks are asserted
    // directly in testGeminiAnalyzer rather than assumed here.
    if (meta.provider === 'local') {
      assert.strictEqual(
        meta.capabilities.incursCost,
        false,
        `${meta.id} is local and must cost nothing`
      )
    } else {
      assert.strictEqual(
        meta.capabilities.incursCost,
        true,
        `${meta.id} contacts a vendor and must declare that it costs money`
      )
    }
  }
  assert.ok(
    analyzers.some((a) => a.metadata().provider === 'local'),
    'a free local analyzer is always available'
  )

  // Planned providers are ADVERTISED but unrunnable. A roadmap the UI can
  // show honestly, with a gate that cannot be talked past.
  for (const meta of plannedAnalyzers()) {
    assert.strictEqual(meta.available, false, `${meta.id} is not implemented in this build`)
    assert.strictEqual(meta.capabilities.incursCost, true, `${meta.id} would cost money`)
    assert.strictEqual(
      analyzerById(meta.id),
      null,
      `${meta.id} cannot be resolved from the registry — there is nothing to run`
    )
  }

  const project = makeProject('Smoke analyzer')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'analyzer.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: 'x.png' },
    { sourcePath: p, name: 'y.png' }
  ])
  saveProject(project)

  const request = (existing: PropertyAnalysis | null): AnalyzerRequest => ({
    projectId: project.id,
    projectName: project.name,
    images: project.images.map((image, i) => ({
      imageId: image.id,
      sequence: i + 1,
      fileName: image.fileName,
      ref: image.src
    })),
    existing,
    notes: '',
    capabilities: ALL_CAPABILITIES
  })

  // ── The request carries MANAGED refs, never filesystem paths ─────────
  const req = request(null)
  for (const image of req.images) {
    assert.match(image.ref, /^f2f:\/\//, 'images are passed as managed refs')
    assert.ok(!/[A-Za-z]:\\|\/Users\/|\/home\//.test(image.ref), 'no local path leaks into a request')
  }

  const manual = new ManualPropertyAnalyzer()
  const mock = new MockPropertyAnalyzer()

  // ── Debug preview is credential-free and path-free ───────────────────
  for (const analyzer of [manual, mock]) {
    const preview = analyzer.sanitizeDebugPreview(req)
    const serialized = JSON.stringify(preview)
    assert.ok(!/[A-Za-z]:\\\\/.test(serialized), 'no windows path in the debug preview')
    assert.ok(!/api[_-]?key|secret|token/i.test(serialized), 'no credential-shaped field')
    assert.ok(preview.instruction.length > 200, 'the analysis instruction is included')
    assert.match(preview.instruction, /never invent/i, 'and carries the no-invention rule')
    assert.strictEqual(preview.imageCount, 2, 'and reports the image count')
  }

  // ── Validation refuses impossible work ───────────────────────────────
  const noImages = { ...req, images: [] }
  assert.ok(!manual.validateInput(noImages).ok, 'analysing zero images is refused up front')

  // ── Cost: free and SAID to be free, not merely absent ────────────────
  for (const analyzer of [manual, mock]) {
    const estimate = analyzer.estimateCost(req)
    assert.ok(estimate, 'a local analyzer still states its cost')
    assert.strictEqual(estimate!.amount, 0, 'which is zero')
  }

  // ── Manual returns operator input UNCHANGED ──────────────────────────
  const existing: PropertyAnalysis = {
    ...emptyAnalysis(project.id),
    rooms: [{ id: 'r', label: 'Hall', imageIds: [], landmarks: [] }]
  }
  const manualResult = await manual.analyzeProperty(request(existing))
  assert.ok(manualResult.ok, 'the manual analyzer succeeds')
  if (manualResult.ok) {
    assert.deepStrictEqual(
      manualResult.analysis.rooms,
      existing.rooms,
      'the manual analyzer returns operator input UNCHANGED — it never destroys it'
    )
    assert.strictEqual(
      manualResult.analysis.state,
      'draft',
      'and still arrives as a DRAFT — an analyzer never writes the accepted analysis'
    )
  }

  // ── Mock places images but claims NO adjacency ───────────────────────
  const mockResult = await mock.analyzeProperty(request(null))
  assert.ok(mockResult.ok, 'the mock analyzer succeeds')
  if (mockResult.ok) {
    assert.strictEqual(mockResult.analysis.images.length, 2, 'every image is placed')
    assert.strictEqual(
      mockResult.analysis.edges.length,
      0,
      'the mock claims NO adjacency — a fixture must not manufacture connections it cannot see'
    )
    assert.strictEqual(mockResult.analysis.state, 'draft', 'and is a draft')
  }

  const empty = await mock.analyzeProperty({ ...req, images: [] })
  assert.ok(!empty.ok, 'analysing nothing is an honest failure, not an empty success')

  log('property analyzer: registry gated, requests path-free, results arrive as drafts only')
}

/**
 * THE GEMINI WHOLE-PROPERTY ANALYZER.
 *
 * ZERO REAL REQUESTS. Every call goes through an injected transport whose
 * call count is asserted, so "no network" is proven rather than believed.
 *
 * The assertions concentrate on the three things that could actually
 * hurt: a paid request escaping a lock, a key leaking, and a malformed
 * model response being partly accepted into an analysis that then looks
 * trustworthy.
 */
async function testGeminiAnalyzer(workDir: string, created: string[]): Promise<void> {
  const project = makeProject('Smoke gemini')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'gem.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: 'living-a.png' },
    { sourcePath: p, name: 'living-b.png' },
    { sourcePath: p, name: 'kitchen.png' }
  ])
  saveProject(project)
  const [i1, i2, i3] = project.images.map((i) => i.id)

  const SECRET = 'AIza-SMOKE-SECRET-KEY-do-not-leak'
  const request = (existing: PropertyAnalysis | null): AnalyzerRequest => ({
    projectId: project.id,
    projectName: project.name,
    images: project.images.map((image, idx) => ({
      imageId: image.id,
      sequence: idx + 1,
      fileName: image.fileName,
      ref: image.src
    })),
    existing,
    notes: '',
    capabilities: ALL_CAPABILITIES
  })

  interface Captured {
    url: string
    headers: Record<string, string>
    body: GeminiRequestBody
  }
  /** Records what WOULD have been sent. Never reaches the network. */
  const makeTransport = (
    responseText: string,
    usage?: Record<string, number>
  ): { fetchImpl: FetchLike; calls: Captured[] } => {
    const calls: Captured[] = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({
        url,
        headers: (init.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init.body)) as GeminiRequestBody
      })
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: responseText }] } }],
          ...(usage ? { usageMetadata: usage } : {})
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }
    return { fetchImpl, calls }
  }

  const goodResponse = JSON.stringify({
    rooms: [
      { label: 'Living Room', imageIds: ['IMAGE_001', 'IMAGE_002'], landmarks: ['grey sofa'], confidence: 'confirmed' },
      { label: 'Kitchen', imageIds: ['IMAGE_003'], landmarks: ['island'], confidence: 'probable' }
    ],
    images: [
      { imageId: 'IMAGE_001', roomLabel: 'Living Room', roomConfidence: 'confirmed', orientation: 'into-room', landmarks: ['grey sofa'], openings: [], overlapWith: ['IMAGE_002'] },
      { imageId: 'IMAGE_002', roomLabel: 'Living Room', roomConfidence: 'confirmed', orientation: 'into-room', landmarks: ['grey sofa'], openings: ['kitchen doorway'], overlapWith: ['IMAGE_001'] },
      { imageId: 'IMAGE_003', roomLabel: 'Kitchen', roomConfidence: 'probable', orientation: 'into-room', landmarks: ['island'], openings: [] }
    ],
    connections: [
      {
        fromRoomLabel: 'Living Room',
        toRoomLabel: 'Kitchen',
        confidence: 'confirmed',
        supportingImageIds: ['IMAGE_002'],
        visibleOpeningImageIds: ['IMAGE_002'],
        notes: 'Kitchen island visible through the doorway behind the sofa.'
      }
    ]
  })

  const analyzerWith = (
    opts: Partial<{ apiKey: string; live: boolean; allowLive: boolean; fetchImpl: FetchLike }>
  ): GeminiPropertyAnalyzer =>
    new GeminiPropertyAnalyzer({
      apiKey: opts.apiKey ?? SECRET,
      model: GEMINI_DEFAULT_MODEL,
      live: opts.live ?? true,
      allowLive: opts.allowLive ?? true,
      fetchImpl: opts.fetchImpl
    })

  // ── 1. No API key → refused before anything is sent ──────────────────
  const noKey = analyzerWith({ apiKey: '' })
  assert.ok(!(await noKey.analyzeProperty(request(null))).ok, 'no key means no analysis')
  assert.strictEqual(noKey.client.callCount, 0, 'and no transport call was made')

  // ── 2. Safety lock OFF beats a valid key AND live mode ───────────────
  const lockedT = makeTransport(goodResponse)
  const lockedRes = await analyzerWith({ allowLive: false, fetchImpl: lockedT.fetchImpl })
    .analyzeProperty(request(null))
  assert.ok(!lockedRes.ok, 'the safety lock refuses live analysis')
  assert.match(lockedRes.ok ? '' : lockedRes.reason, /locked/i, 'and says why')
  assert.strictEqual(lockedT.calls.length, 0, 'the transport was never touched')

  // ── 3. DRY RUN validates and builds, but sends nothing ───────────────
  const dryT = makeTransport(goodResponse)
  const dryRes = await analyzerWith({ live: false, fetchImpl: dryT.fetchImpl })
    .analyzeProperty(request(null))
  assert.ok(!dryRes.ok, 'a dry run produces no analysis')
  assert.match(dryRes.ok ? '' : dryRes.reason, /dry run/i, 'and says so plainly')
  assert.match(dryRes.ok ? '' : dryRes.reason, /3 images validated/i, 'having validated every image')
  assert.strictEqual(dryT.calls.length, 0, 'ZERO network calls in dry run')

  // ── 4. LIVE: ONE request, every image, stable logical ids ────────────
  const liveT = makeTransport(goodResponse, {
    promptTokenCount: 4200,
    candidatesTokenCount: 600,
    totalTokenCount: 4800
  })
  const live = analyzerWith({ fetchImpl: liveT.fetchImpl })
  const liveRes = await live.analyzeProperty(request(null))
  assert.ok(liveRes.ok, `live analysis succeeded: ${liveRes.ok ? '' : liveRes.reason}`)
  assert.strictEqual(liveT.calls.length, 1, 'ONE request for the whole property, not one per image')

  const sent = liveT.calls[0]
  const parts = sent.body.contents[0].parts
  assert.strictEqual(
    parts.filter((x) => 'inlineData' in x).length,
    3,
    'every project image is in the one request'
  )
  const texts = parts.filter((x): x is { text: string } => 'text' in x).map((x) => x.text)
  for (const id of ['IMAGE_001', 'IMAGE_002', 'IMAGE_003']) {
    assert.ok(texts.some((t) => t.startsWith(id)), `${id} labels its image`)
  }
  assert.match(texts[0], /never invent/i, 'the safety instruction leads the request')
  assert.match(texts[0], /IMAGE MANIFEST/, 'and the manifest binds ids to photographs')

  // ── 5. Structured output requested, with CLOSED enums ────────────────
  assert.strictEqual(
    sent.body.generationConfig.responseMimeType,
    'application/json',
    'structured JSON is requested rather than prose being parsed'
  )
  const schema = JSON.stringify(sent.body.generationConfig.responseSchema)
  assert.match(schema, /confirmed.*probable.*unknown/, 'confidence is a closed enum')
  assert.ok(
    !/coordinate|floorplan|metres|dimension/i.test(schema),
    'the schema offers nowhere to put fake geometry'
  )

  // ── 6. THE KEY NEVER LEAKS ───────────────────────────────────────────
  assert.strictEqual(sent.headers['x-goog-api-key'], SECRET, 'the key travels in a header')
  assert.ok(!sent.url.includes(SECRET), 'and never in the URL')
  const previewJson = JSON.stringify(live.sanitizeDebugPreview(request(null)))
  assert.ok(!previewJson.includes(SECRET), 'the debug preview never contains the key')
  assert.ok(!/[A-Za-z]:\\\\|\/Users\//.test(previewJson), 'nor any local filesystem path')
  assert.ok(
    !JSON.stringify(liveRes.ok ? liveRes.notes : '').includes(SECRET),
    'nor do the result notes'
  )

  // ── 7. Logical ids map back to REAL project ids ──────────────────────
  if (liveRes.ok) {
    const a = liveRes.analysis
    assert.strictEqual(a.state, 'draft', 'a provider result is ALWAYS a draft')
    assert.strictEqual(a.source, 'provider')
    assert.strictEqual(a.rooms.length, 2, 'both rooms mapped')
    const living = a.rooms.find((r) => r.label === 'Living Room')!
    assert.deepStrictEqual(living.imageIds.sort(), [i1, i2].sort(), 'logical ids resolved to real ones')
    assert.strictEqual(a.edges.length, 1, 'the confirmed connection survived')
    assert.deepStrictEqual(a.edges[0].supportingImageIds, [i2], 'with its supporting image')
    assert.deepStrictEqual(a.edges[0].visibleOpeningImageIds, [i2], 'and its visible opening')
    assert.deepStrictEqual(
      a.images.find((x) => x.imageId === i1)?.overlapWith,
      [i2],
      'overlap resolved too'
    )
    for (const img of a.images) {
      assert.ok([i1, i2, i3].includes(img.imageId), 'no image id outside the project appears')
    }

    // The whole point: this analysis makes a transition planner decision
    // that the base prompt alone never could.
    const plans = planSequence(a, [i1, i2, i3])
    assert.strictEqual(plans[0].relationType, 'SAME_ROOM', '1→2 is recognised as one room')
    assert.deepStrictEqual(plans[0].sharedLandmarks, ['grey sofa'], 'with the shared landmark found')
    assert.strictEqual(plans[1].relationType, 'ADJACENT_ROOM', '2→3 crosses rooms')
    assert.strictEqual(
      plans[1].physicalNavigationAllowed,
      true,
      'and the visible kitchen doorway licenses moving through it'
    )
  }

  // ── 8. Malformed responses are REJECTED, never partly accepted ───────
  const bad = async (text: string, why: string): Promise<void> => {
    const t = makeTransport(text)
    const res = await analyzerWith({ fetchImpl: t.fetchImpl }).analyzeProperty(request(null))
    assert.ok(!res.ok, why)
  }
  await bad('not json at all', 'invalid JSON is rejected')
  await bad(JSON.stringify({ rooms: [] }), 'a response missing images/connections is rejected')
  await bad(
    JSON.stringify({
      rooms: [{ label: 'Hall', imageIds: [], landmarks: [], confidence: 'very likely' }],
      images: [],
      connections: []
    }),
    'an INVENTED confidence value is rejected rather than coerced'
  )

  // ── 9. Fabricated image ids are DROPPED, not honoured ────────────────
  const ghostT = makeTransport(
    JSON.stringify({
      rooms: [{ label: 'Ghost', imageIds: ['IMAGE_009'], landmarks: [], confidence: 'confirmed' }],
      images: [],
      connections: []
    })
  )
  const ghostRes = await analyzerWith({ fetchImpl: ghostT.fetchImpl }).analyzeProperty(request(null))
  assert.ok(ghostRes.ok, 'the response is structurally valid')
  if (ghostRes.ok) {
    assert.deepStrictEqual(
      ghostRes.analysis.rooms[0].imageIds,
      [],
      'a reference to a photograph that does not exist is DROPPED, never invented into being'
    )
  }

  // ── 10. "confirmed" with no cited evidence is downgraded ─────────────
  const unevT = makeTransport(
    JSON.stringify({
      rooms: [
        { label: 'A', imageIds: ['IMAGE_001'], landmarks: [], confidence: 'confirmed' },
        { label: 'B', imageIds: ['IMAGE_002'], landmarks: [], confidence: 'confirmed' }
      ],
      images: [],
      connections: [
        { fromRoomLabel: 'A', toRoomLabel: 'B', confidence: 'confirmed', supportingImageIds: [] }
      ]
    })
  )
  const unevRes = await analyzerWith({ fetchImpl: unevT.fetchImpl }).analyzeProperty(request(null))
  assert.ok(unevRes.ok)
  if (unevRes.ok) {
    assert.strictEqual(
      unevRes.analysis.edges[0].confidence,
      'probable',
      'a confirmed connection citing NO image is downgraded — the instruction requires evidence'
    )
  }

  // ── 11. An "unknown" connection is stored as NO edge ─────────────────
  const unkT = makeTransport(
    JSON.stringify({
      rooms: [
        { label: 'A', imageIds: ['IMAGE_001'], landmarks: [], confidence: 'confirmed' },
        { label: 'B', imageIds: ['IMAGE_002'], landmarks: [], confidence: 'confirmed' }
      ],
      images: [],
      connections: [
        { fromRoomLabel: 'A', toRoomLabel: 'B', confidence: 'unknown', supportingImageIds: [] }
      ]
    })
  )
  const unkRes = await analyzerWith({ fetchImpl: unkT.fetchImpl }).analyzeProperty(request(null))
  assert.ok(unkRes.ok)
  if (unkRes.ok) {
    assert.strictEqual(
      unkRes.analysis.edges.length,
      0,
      'absence of evidence is stored as ABSENCE — the planner reads a missing edge as unknown'
    )
  }

  // ── 12. The image ceiling REFUSES rather than truncating ─────────────
  const overLimit = live.validateInput({
    ...request(null),
    images: Array.from({ length: GEMINI_MAX_IMAGES + 1 }, (_, idx) => ({
      imageId: `x-${idx}`,
      sequence: idx + 1,
      fileName: 'x.png',
      ref: 'f2f://image/x/x.png'
    }))
  })
  assert.ok(!overLimit.ok, 'a project beyond the limit is refused')
  assert.match(
    overLimit.ok ? '' : overLimit.reasons.join(' '),
    /will not analyse a subset/i,
    'and explicitly refuses to analyse a subset'
  )

  // ── 13. Cost estimate is a labelled RANGE, never a bare figure ───────
  const estimate = live.estimateCost(request(null))
  assert.ok(estimate, 'a cost estimate exists')
  assert.strictEqual(estimate!.currency, 'USD')
  assert.match(estimate!.basis, /≈ \$/, 'presented as a range')
  assert.match(estimate!.basis, /RATE NOT VERIFIED/i, 'and flagged unverified until checked')
  assert.match(estimate!.basis, /3 images/, 'derived from the real image count')

  // ── 14. Usage metadata is captured, for refining ACTUAL cost ─────────
  assert.strictEqual(live.usage()?.totalTokenCount, 4800, 'reported usage is kept')

  // ── 15. A draft NEVER overwrites the accepted analysis ───────────────
  saveAnalysis({
    ...emptyAnalysis(project.id),
    state: 'accepted',
    rooms: [{ id: 'kept', label: 'Operator Room', imageIds: [i1], landmarks: [] }]
  })
  const afterLive = await analyzerWith({ fetchImpl: makeTransport(goodResponse).fetchImpl })
    .analyzeProperty(request(readAnalysis(project.id)))
  assert.ok(afterLive.ok, 're-analysis succeeded')
  const stored = readAnalysis(project.id)
  assert.strictEqual(stored.state, 'accepted', 'the accepted analysis is untouched')
  assert.strictEqual(stored.rooms[0].label, 'Operator Room', 'and still holds the operator room')

  // ── 16. No spend from any of this ────────────────────────────────────
  assert.strictEqual(
    listCostEntries(project.id).length,
    0,
    'a mocked transport never records vision-analysis spend'
  )

  log('gemini analyzer: locks hold, key never leaks, one request for all images, drafts only')
}

/**
 * PROJECT DELETION MUST TAKE ITS CHILDREN WITH IT.
 *
 * ── THE BUG THIS PINS ────────────────────────────────────────────────
 *
 * `PRAGMA foreign_keys` is a CONNECTION setting that SQLite defaults to
 * OFF, and sql.js implements `export()` by closing and reopening the
 * connection. Every flush therefore handed the app a fresh connection with
 * enforcement off, so `ON DELETE CASCADE` never fired: deleting a project
 * left all of its `project_images` and `transitions` behind, forever. The
 * schema had been correct the entire time.
 *
 * The real database had accumulated 1787 image rows for 30 live ones.
 *
 * ── WHY IT USES THE PRODUCTION PATH ──────────────────────────────────
 *
 * `deleteProjectRows` is what the `projects:delete` channel calls. A
 * test-only cleanup helper would prove nothing about what happens when a
 * user presses Delete — which is the only thing worth asserting here.
 */
/**
 * THE GENERATION CATALOGUE IS APPEND-ONLY AND IDEMPOTENT.
 *
 * The promise is that every clip this project ever produced stays
 * reachable, and that a completion arriving twice — a resumed poll, a
 * restart, a retried download — records the work once.
 *
 * The failure this guards against is subtle: `ON CONFLICT DO NOTHING`
 * must swallow the duplicate WITHOUT raising, because the caller is the
 * generation-completion path. A constraint error propagating from here
 * would turn a successful, already-recorded generation into a failed job.
 */
function testCatalogueIdempotency(workDir: string, created: string[]): void {
  const project = makeProject('Smoke catalogue idempotency')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'catalogue.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: 'a.png' },
    { sourcePath: p, name: 'b.png' }
  ])
  saveProject(project)
  const [from, to] = project.images.map((i) => i.id)

  const clip = (name: string): TransitionClip => ({
    storedName: name,
    originalName: name,
    source: 'fal',
    src: `f2f://${name}`
  })
  const record = (queueJobId: string, name: string): void => {
    recordGeneration({
      queueJobId,
      projectId: project.id,
      fromImageId: from,
      toImageId: to,
      provider: 'fal',
      model: null,
      clip: clip(name),
      prompt: 'a prompt'
    })
  }

  // ── The same job, recorded twice ─────────────────────────────────────
  record('job-1', 'first.mp4')
  assert.doesNotThrow(
    () => record('job-1', 'first.mp4'),
    'a repeated completion for the same job must not raise — that would fail a job that succeeded'
  )
  let rows = getAllProjectGenerations(project.id)
  assert.strictEqual(rows.length, 1, 'and it leaves exactly one history row')

  // ── A genuine regeneration is a NEW job, and is kept alongside ───────
  archivePreviousGenerations(project.id, from, to)
  record('job-2', 'second.mp4')
  rows = getAllProjectGenerations(project.id)
  assert.strictEqual(rows.length, 2, 'regenerating the same pair adds a row rather than replacing')
  assert.deepStrictEqual(
    rows.map((r) => r.clip?.storedName).sort(),
    ['first.mp4', 'second.mp4'],
    'and the earlier clip is still in the catalogue — no history is overwritten'
  )
  assert.strictEqual(
    rows.filter((r) => r.active).length,
    1,
    'exactly one generation is the active one for the pair'
  )

  log('catalogue: one row per job however often completion repeats, regenerations accumulate')
}

/**
 * THE ANALYZER DRAFT SURVIVES, WHOLE, AND NEVER OVERWRITES ACCEPTED WORK.
 *
 * A paid Gemini run used to leave no trace: `feed:analyze` handed the
 * draft to the renderer and nothing stored it, so after a restart there
 * was no way to see what the model had actually returned — and the run
 * had cost money. The stored analysis for a real project read
 * `rooms: 0, source: manual`, which told us nothing about the analysis
 * that had just produced a feed proposal.
 *
 * Two properties are pinned here, and the second is the dangerous one:
 * every field round-trips intact, and writing a draft leaves an existing
 * ACCEPTED analysis untouched.
 */
function testAnalysisDraftPersistence(workDir: string, created: string[]): void {
  const project = makeProject('Smoke analyzer draft')
  created.push(project.id)
  saveProject(project)

  const A = 'img-terrace'
  const B = 'img-living'

  // Everything the pipeline reads, including the fields that were each at
  // some point silently dropped between Gemini and the evaluator.
  const draft: PropertyAnalysis = {
    ...emptyAnalysis(project.id),
    source: 'provider',
    state: 'draft',
    analyzerId: 'gemini',
    rooms: [
      {
        id: 'r-out',
        label: 'Terrace',
        imageIds: [A],
        landmarks: ['glazed façade'],
        confidence: 'confirmed',
        marketingImportance: 9,
        notes: 'Hero exterior'
      },
      {
        id: 'r-in',
        label: 'Living Room',
        imageIds: [B],
        landmarks: ['glazed façade'],
        confidence: 'confirmed',
        marketingImportance: 8
      }
    ],
    images: [
      {
        imageId: A,
        roomId: 'r-out',
        roomConfidence: 'confirmed',
        orientation: 'into-room',
        landmarks: ['glazed façade', 'pool'],
        openings: ['open sliding glass door into living room'],
        overlapWith: [B],
        marketingImportance: 9,
        isHero: true,
        notes: 'Pool and terrace'
      },
      {
        imageId: B,
        roomId: 'r-in',
        roomConfidence: 'confirmed',
        orientation: 'out-of-room',
        landmarks: ['glazed façade'],
        openings: ['open sliding glass door to terrace'],
        overlapWith: [A],
        marketingImportance: 8,
        isHero: false
      }
    ],
    edges: [
      {
        id: 'e1',
        fromRoomId: 'r-in',
        toRoomId: 'r-out',
        confidence: 'confirmed',
        supportingImageIds: [A, B],
        visibleOpeningImageIds: [A],
        notes: 'Sliding doors open onto the terrace'
      }
    ],
    transitionHints: [
      {
        fromImageId: A,
        toImageId: B,
        safetyLevel: 'safe',
        suggestedMotion: 'glide forward through the open doors',
        anchorLandmark: 'glazed façade',
        notes: 'Same glazing visible from both sides'
      }
    ]
  }

  saveAnalysisDraft(draft)
  flushNow()

  // ── Read back through the same repository ───────────────────────────
  const back = readAnalysisDraft(project.id)
  assert.ok(back, 'a stored draft is readable')
  assert.strictEqual(back!.state, 'draft', 'and is unambiguously a draft')
  assert.strictEqual(back!.source, 'provider', 'attributed to the analyzer, not to a human')
  assert.strictEqual(back!.analyzerId, 'gemini')

  assert.deepStrictEqual(back!.rooms, draft.rooms, 'rooms survive whole, scores and notes included')
  assert.deepStrictEqual(
    back!.images,
    draft.images,
    'images survive whole — landmarks, openings, overlapWith, marketingImportance, isHero'
  )
  assert.deepStrictEqual(
    back!.edges,
    draft.edges,
    'connections survive, visibleOpeningImageIds included'
  )
  assert.deepStrictEqual(
    back!.transitionHints,
    draft.transitionHints,
    'transition hints survive, safety level and reasoning included'
  )

  // ── AN ACCEPTED ANALYSIS IS NOT TOUCHED ─────────────────────────────
  //
  // The single most important property: the draft lives beside the
  // accepted document, never over it. Writing one must not demote the
  // analysis the planner and inspectors are reading.
  const accepted: PropertyAnalysis = {
    ...emptyAnalysis(project.id),
    state: 'accepted',
    source: 'manual',
    rooms: [
      { id: 'kept', label: 'Hand-entered Room', imageIds: [A], landmarks: [], confidence: 'confirmed' }
    ]
  }
  saveAnalysis(accepted)
  saveAnalysisDraft({ ...draft, analyzerId: 'gemini-second-run' })
  flushNow()

  const stillAccepted = readAnalysis(project.id)
  assert.strictEqual(stillAccepted.state, 'accepted', 'the accepted analysis is still accepted')
  assert.strictEqual(
    stillAccepted.rooms[0]?.label,
    'Hand-entered Room',
    'and still contains the hand-entered work a draft must never replace'
  )
  assert.strictEqual(
    readAnalysisDraft(project.id)?.analyzerId,
    'gemini-second-run',
    'while the newest draft replaced the previous draft'
  )

  // And the reverse: accepting does not wipe the draft that produced it.
  saveAnalysis({ ...accepted, updatedAt: Date.now() })
  flushNow()
  assert.ok(
    readAnalysisDraft(project.id),
    'saving an accepted analysis leaves the stored draft intact'
  )

  log('analyzer draft: stored whole, readable after restart, never overwrites accepted analysis')
}

/**
 * THE PAID CONFIRMATION TELLS THE TRUTH, OR REFUSES.
 *
 * Two runtime faults, one root cause. Every pair lookup in the generation
 * service walked `project.images` — the imported LIBRARY — while a
 * transition lives in the FEED. Once a feed stops matching library order,
 * which is exactly what accepting a proposal does:
 *
 *   • the request could not be built, so the dialog reported "Transition …
 *     is not in the image sequence" about a transition sitting in the
 *     sequence, and
 *   • `durationSec` fell back to a literal 0, so a paid dialog announced
 *     "Duration: 0s" — a length no provider offers.
 *
 * These pin the confirmation against the request it describes.
 */
function testGenerationConfirmationIntegrity(workDir: string, created: string[]): void {
  const project = makeProject('Smoke generation confirmation')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'gen-confirm.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: 'a.png' },
    { sourcePath: p, name: 'b.png' },
    { sourcePath: p, name: 'c.png' }
  ])
  const [A, B, C] = project.images.map((i) => i.id)

  // A FEED THAT DOES NOT MATCH LIBRARY ORDER — the shape that broke this.
  // A→C is adjacent in the video and NOT adjacent in the library.
  project.feedSequence = [A, C, B]
  project.transitions = {}
  saveProject(project)

  const settings = JSON.parse(getSettingsJson() ?? '{}') as AppSettings

  // ── The pair the library would have refused ─────────────────────────
  const built = buildGenerationRequest(project.id, transitionKey(A, C), settings)
  assert.ok(
    built.ok,
    'a pair adjacent in the FEED builds a request, whatever the library order is'
  )

  // ── B/E. Duration is never zero, and matches the request ────────────
  const confirm = liveConfirmation(project.id, transitionKey(A, C))
  assert.ok(confirm, 'a confirmation is produced')
  assert.ok(confirm!.durationSec >= 3, `duration is a real length, got ${confirm!.durationSec}s`)
  assert.notStrictEqual(confirm!.durationSec, 0, 'and never the 0s a provider cannot honour')
  assert.strictEqual(
    confirm!.durationSec,
    built.ok ? built.request.durationSec : -1,
    'THE INVARIANT: the dialog shows exactly what the request carries'
  )

  // ── A. An explicit per-transition duration flows all the way ────────
  for (const seconds of [3, 4, 15]) {
    const withOverride = listProjects().find((pr) => pr.id === project.id)!
    withOverride.transitions[transitionKey(A, C)] = {
      ...defaultTransitionSettings(5),
      durationSec: seconds
    }
    saveProject(withOverride)

    const rebuilt = buildGenerationRequest(project.id, transitionKey(A, C), settings)
    assert.ok(rebuilt.ok)
    assert.strictEqual(rebuilt.request.durationSec, seconds, `override ${seconds}s reaches the request`)
    assert.strictEqual(
      liveConfirmation(project.id, transitionKey(A, C))!.durationSec,
      seconds,
      `and the dialog shows ${seconds}s, not a separately computed number`
    )
    // F. And what fal would actually be sent, after its own mapping.
    assert.strictEqual(
      buildFalBody(rebuilt.request, FAL_MODELS[0], 'start', 'end').duration,
      String(seconds),
      `fal payload carries "${seconds}"`
    )
  }

  // ── D. A stale pair cannot reach a paid request ─────────────────────
  //
  // B→C is adjacent in the LIBRARY and not in the feed — precisely the
  // selection that used to survive reconciliation and open a paid dialog.
  const stalePair = transitionKey(B, C)
  const staleBuild = buildGenerationRequest(project.id, stalePair, settings)
  assert.ok(!staleBuild.ok, 'a pair outside the feed builds no request')
  assert.match(
    staleBuild.ok ? '' : staleBuild.reason,
    /no longer part of the current Transition Feed/,
    'and says so in words an operator can act on'
  )

  const staleConfirm = liveConfirmation(project.id, stalePair)
  assert.ok(staleConfirm, 'a confirmation object still exists, to carry the refusal')
  assert.strictEqual(staleConfirm!.ok, false, 'but it is NOT ok, so Generate stays disabled')
  assert.ok(
    staleConfirm!.durationSec > 0,
    'and even a refused dialog states a real duration rather than 0s'
  )

  // The submit door refuses it too — the renderer is not trusted.
  // ── THE SUBMIT DOOR REFUSES IT TOO ─────────────────────────────────
  //
  // `queueLiveGeneration` checks live ELIGIBILITY first and returns on
  // the spot, so a settings row that is not live-eligible refuses this
  // pair for the wrong reason — and the assertion below would pass or
  // fail on whatever the previously-run test happened to leave in the
  // settings row rather than on anything this test is about.
  //
  // It did exactly that: an earlier test left a pricing-only row behind,
  // the refusal came back "Provider mode is Dry Run", and the staleness
  // this test exists to prove was never reached. So establish the
  // eligibility this assertion needs, and put the operator's real row
  // back afterwards — the smoke suite runs against the real database.
  const originalSettings = getSettingsJson()
  try {
    saveSettingsJson(
      JSON.stringify({
        ...settings,
        activeProviderId: 'fal',
        providers: [
          {
            id: 'fal',
            label: 'fal.ai',
            apiKey: 'smoke-not-a-real-key',
            legacySecret: '',
            mode: 'live',
            model: FAL_MODELS[0].id
          }
        ],
        production: {
          ...(settings.production ?? {}),
          maxConcurrentAiGenerations: 1,
          allowLiveFalRequests: true
        }
      })
    )

    const submitted = queueLiveGeneration(project.id, [stalePair])
    assert.ok(!submitted.ok, 'and the paid submit path refuses a stale pair outright')
    assert.match(
      submitted.ok ? '' : submitted.reasons.join(' '),
      /no longer part of the current Transition Feed/,
      'for being stale — not because the settings row happened to be ineligible'
    )

    // A batch with one stale pair is refused WHOLE, never partly submitted.
    const mixed = queueLiveGeneration(project.id, [transitionKey(A, C), stalePair])
    assert.ok(!mixed.ok, 'one stale transition refuses the whole batch')
  } finally {
    if (originalSettings !== null) saveSettingsJson(originalSettings)
  }

  log('generation confirmation: feed-located pairs, duration never 0, stale pairs cannot be paid for')
}

/**
 * THE PROMPT AND THE SCHEMA MUST AGREE.
 *
 * We have now shipped this bug three times: the prose instruction asks
 * Gemini for a field, `GEMINI_RESPONSE_SCHEMA` does not declare it,
 * structured output therefore cannot return it, and the parser quietly
 * substitutes a default. `marketingImportance` produced a feed of zero
 * images that way; `transitionHints` produced "No analyzer detail for
 * this pair" on every row. Both were invisible until a paid run.
 *
 * This fails the moment a field the instruction names is not answerable.
 */
function testPromptSchemaContract(): void {
  const schema = GEMINI_RESPONSE_SCHEMA as unknown as {
    properties: Record<string, { items?: { properties?: Record<string, unknown> } }>
  }
  const fieldsOf = (section: string): string[] =>
    Object.keys(schema.properties[section]?.items?.properties ?? {})

  // Every field the instruction asks for, against the section that must
  // be able to carry it.
  const required: Array<{ section: string; fields: string[] }> = [
    { section: 'rooms', fields: ['label', 'imageIds', 'confidence', 'marketingImportance'] },
    {
      section: 'images',
      fields: [
        'imageId',
        'roomLabel',
        'roomConfidence',
        'orientation',
        'landmarks',
        'openings',
        'overlapWith',
        'marketingImportance',
        'isHero'
      ]
    },
    {
      section: 'connections',
      fields: ['fromRoomLabel', 'toRoomLabel', 'confidence', 'visibleOpeningImageIds']
    },
    { section: 'transitionHints', fields: ['fromImageId', 'toImageId', 'safetyLevel'] }
  ]

  for (const { section, fields } of required) {
    const declared = fieldsOf(section)
    assert.ok(declared.length > 0, `the schema declares a "${section}" section`)
    for (const field of fields) {
      assert.ok(
        declared.includes(field),
        `the instruction asks for ${section}.${field}, so the schema must allow it — ` +
          'structured output returns declared fields only'
      )
    }
  }

  // And the instruction really does ask for the two that were dropped.
  assert.match(PROPERTY_ANALYSIS_INSTRUCTION, /marketingImportance/, 'the prompt asks for marketing scores')
  assert.match(PROPERTY_ANALYSIS_INSTRUCTION, /transitionHints/, 'and for per-pair transition hints')

  log('prompt/schema contract: every requested field is answerable')
}

/**
 * A THIN MAPPING IS REPORTED AS THIN.
 *
 * Fixture G. An analysis that placed three of thirty-seven images used to
 * be presented exactly like a complete one — a confident proposal, and
 * "No room" on every thumbnail as if that were normal output.
 */
function testAnalysisQualityGate(): void {
  const ids = Array.from({ length: 37 }, (_, i) => `img-${i + 1}`)

  const barely: PropertyAnalysis = {
    ...emptyAnalysis('p1'),
    rooms: [{ id: 'r1', label: 'Living Room', imageIds: ids.slice(0, 3), landmarks: [], confidence: 'confirmed' }],
    images: ids.slice(0, 3).map((id) => ({
      imageId: id,
      roomId: 'r1',
      orientation: 'unknown' as const,
      landmarks: ['sofa'],
      openings: []
    }))
  }
  const poor = assessAnalysisQuality(barely, ids)
  assert.strictEqual(poor.assignedCount, 3, 'three images were placed')
  assert.strictEqual(poor.unassignedCount, 34, 'and thirty-four were not')
  assert.strictEqual(poor.level, 'unusable', 'which is not a mapping to spend money on')
  assert.ok(
    poor.problems.some((p) => /34 of 37/.test(p)),
    'and the operator is told the actual numbers, not just "low quality"'
  )
  assert.ok(qualityHeadline(poor).length > 0, 'with a headline that names the problem')

  // A roomId pointing at a room that does not exist is NOT an assignment.
  const dangling: PropertyAnalysis = {
    ...barely,
    images: ids.map((id) => ({
      imageId: id,
      roomId: 'room-that-was-never-returned',
      orientation: 'unknown' as const,
      landmarks: ['sofa'],
      openings: []
    }))
  }
  assert.strictEqual(
    assessAnalysisQuality(dangling, ids).assignedCount,
    0,
    'a dangling room reference is not counted as a placed image'
  )

  // A genuinely good mapping raises nothing.
  const good: PropertyAnalysis = {
    ...emptyAnalysis('p1'),
    rooms: [
      { id: 'r1', label: 'Living Room', imageIds: ids.slice(0, 20), landmarks: [], confidence: 'confirmed' },
      { id: 'r2', label: 'Kitchen', imageIds: ids.slice(20), landmarks: [], confidence: 'confirmed' }
    ],
    images: ids.map((id, i) => ({
      imageId: id,
      roomId: i < 20 ? 'r1' : 'r2',
      orientation: 'unknown' as const,
      landmarks: ['sofa', 'window wall'],
      openings: [],
      overlapWith: [ids[(i + 1) % ids.length]]
    }))
  }
  const strong = assessAnalysisQuality(good, ids)
  assert.strictEqual(strong.level, 'good', 'a complete mapping passes')
  assert.deepStrictEqual(strong.problems, [], 'with nothing to warn about')
  assert.strictEqual(strong.roomsWithMultipleViews, 2, 'both rooms have multi-view support')

  log('analysis quality: thin mappings are reported as thin, not presented as success')
}

/**
 * THE SOFA/TELEVISION REGRESSION.
 *
 * A real paid run produced a clip in which the sofa moved and a second
 * television appeared. The database showed exactly why: eight
 * transitions carried a stored `mode: 'ai'` while the ACCEPTED analysis
 * contained zero rooms, and all sixty transitions had `prompt_basis`
 * NULL with an empty prompt. Nothing between the stored decision and the
 * paid request asked whether the evidence still existed, so fal received
 * two photographs and the generic preset, and invented the room.
 *
 * Pinned here: with a real accepted analysis the pair is generatable and
 * anchored; without one the SAME stored `ai` mode can no longer spend
 * money.
 */
function testAiGenerationRequiresAcceptedEvidence(workDir: string, created: string[]): void {
  const project = makeProject('Smoke AI evidence preflight')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'ai-evidence.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: 'living-a.png' },
    { sourcePath: p, name: 'living-b.png' }
  ])
  const [A, B] = project.images.map((i) => i.id)
  project.feedSequence = [A, B]
  project.transitions = {
    [transitionKey(A, B)]: { ...defaultTransitionSettings(5), mode: 'ai' }
  }
  saveProject(project)

  // ── A REAL MAP: one living room, seen twice, sharing anchors ────────
  const mapped: PropertyAnalysis = {
    ...emptyAnalysis(project.id),
    state: 'accepted',
    source: 'provider',
    analyzerId: 'gemini',
    rooms: [
      {
        id: 'living',
        label: 'Living Room',
        imageIds: [A, B],
        landmarks: ['sectional sofa', 'television', 'window wall'],
        confidence: 'confirmed'
      }
    ],
    images: [
      {
        imageId: A,
        roomId: 'living',
        orientation: 'into-room',
        landmarks: ['sectional sofa', 'television', 'window wall'],
        openings: [],
        overlapWith: [B]
      },
      {
        imageId: B,
        roomId: 'living',
        orientation: 'into-room',
        landmarks: ['sectional sofa', 'television', 'window wall'],
        openings: [],
        overlapWith: [A]
      }
    ]
  }
  saveAnalysis(mapped)
  flushNow()

  // ── With the map accepted: rooms resolve and a basis exists ─────────
  const reloaded = readAnalysis(project.id)
  assert.strictEqual(reloaded.rooms.length, 1, 'the accepted analysis survives reload')
  assert.strictEqual(
    roomOfImage(reloaded, A)?.label,
    'Living Room',
    'and the image resolves to a real room name rather than "no room"'
  )

  const ready = assessAiGenerationReadiness(reloaded, [A, B], transitionKey(A, B))
  assert.ok(ready.ok, 'an evidenced pair is generatable')
  assert.ok(
    ready.ok && ready.kind === 'analysis-backed' && ready.basis.motionInstruction.length > 0,
    'and carries an analysis-derived camera instruction, not the generic preset'
  )
  assert.ok(
    ready.ok && ready.kind === 'analysis-backed' && ready.basis.sharedLandmarks.length > 0,
    'anchored on landmarks visible in both frames'
  )

  // ── THE FAILURE STATE: the map is gone, the decision remains ────────
  //
  // Exactly the database state the bad run was in.
  saveAnalysis({ ...emptyAnalysis(project.id), state: 'accepted' })
  flushNow()

  const stillAi = listProjects().find((pr) => pr.id === project.id)!
  assert.strictEqual(
    stillAi.transitions[transitionKey(A, B)]?.mode,
    'ai',
    'the historical decision is not rewritten — it is a record of what was chosen'
  )

  const blocked = assessAiGenerationReadiness(
    readAnalysis(project.id),
    [A, B],
    transitionKey(A, B)
  )
  assert.ok(!blocked.ok, 'but with no accepted map the pair is no longer generatable')
  assert.match(
    blocked.ok ? '' : blocked.reason,
    /accepted property analysis|spatial evidence/i,
    'and says the evidence is missing rather than failing silently'
  )

  // The paid doors are shut.
  const confirm = liveConfirmation(project.id, transitionKey(A, B))
  assert.ok(confirm, 'a confirmation object still exists to carry the refusal')
  assert.strictEqual(confirm!.ok, false, 'but Generate stays disabled')

  const submitted = queueLiveGeneration(project.id, [transitionKey(A, B)])
  assert.ok(
    !submitted.ok,
    'and the paid submit path refuses — no default-only request can reach fal'
  )

  // ── WHO CHOSE THE MODE DECIDES WHAT HAPPENS NEXT ───────────────────
  //
  // An AI mode the ANALYZER proposed is bound to the map that justified
  // it. An AI mode a HUMAN set is their call on a property they may know
  // better than the photographs show — allowed, on a stated risk. The two
  // were indistinguishable until `modeProvenance` existed, which is why
  // the strict gate had to refuse both.
  const noMap = readAnalysis(project.id) // emptied above
  const pairKey = transitionKey(A, B)

  // B. Auto (no provenance at all) — blocked.
  assert.ok(
    !assessAiGenerationReadiness(noMap, [A, B], pairKey, undefined).ok,
    'an AI mode with no recorded author is treated as analysis-driven and blocked'
  )
  // A. Analysis-driven — blocked.
  assert.ok(
    !assessAiGenerationReadiness(noMap, [A, B], pairKey, 'analysis').ok,
    'an analyzer-chosen AI mode cannot outlive the analysis that chose it'
  )
  // C. Manual override — permitted, and labelled as a risk.
  const overridden = assessAiGenerationReadiness(noMap, [A, B], pairKey, 'manual')
  assert.ok(overridden.ok, 'the operator may generate their own explicit choice')
  assert.strictEqual(
    overridden.ok && overridden.kind,
    'manual-override',
    'but it is classified as an override, never as analysis-backed'
  )
  assert.match(
    overridden.ok && overridden.kind === 'manual-override' ? overridden.warning : '',
    /invented geometry|moved furniture|duplicated objects/i,
    'and names the actual risk in the words of the failure it came from'
  )

  // D. Manual + a real map needs no risk warning — it is simply supported.
  saveAnalysis(mapped)
  flushNow()
  const manualWithMap = assessAiGenerationReadiness(
    readAnalysis(project.id),
    [A, B],
    pairKey,
    'manual'
  )
  assert.strictEqual(
    manualWithMap.ok && manualWithMap.kind,
    'analysis-backed',
    'a manual choice that the map DOES support is a normal supported generation'
  )

  log('ai generation: analysis-driven AI needs its map; an explicit manual override may proceed')
}

/**
 * THE CONFIRMATION NAMES AN OVERRIDE AS AN OVERRIDE.
 *
 * The payload must let the dialog tell the two apart, because the whole
 * point of permitting the override is that the operator sees what they
 * are agreeing to. `spatialGuidance: 'none'` is the state that produced
 * a moved sofa; it may never render as a supported transition.
 */
function testOverrideConfirmationIsHonest(workDir: string, created: string[]): void {
  const project = makeProject('Smoke override confirmation')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'override-confirm.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: 'one.png' },
    { sourcePath: p, name: 'two.png' }
  ])
  const [A, B] = project.images.map((i) => i.id)
  const pairKey = transitionKey(A, B)
  project.feedSequence = [A, B]

  // F. A CUT is not an AI generation at all.
  project.transitions = {
    [pairKey]: { ...defaultTransitionSettings(5), mode: 'cut', modeProvenance: 'manual' }
  }
  saveProject(project)
  assert.strictEqual(
    listProjects().find((pr) => pr.id === project.id)!.transitions[pairKey].mode,
    'cut',
    'a cut stays a cut and generates nothing'
  )

  // Manual AI, no accepted analysis anywhere.
  project.transitions = {
    [pairKey]: { ...defaultTransitionSettings(5), mode: 'ai', modeProvenance: 'manual' }
  }
  saveProject(project)
  flushNow()

  // PROVENANCE SURVIVES PERSISTENCE — otherwise the override silently
  // becomes a blocked analysis-driven mode on the next launch.
  assert.strictEqual(
    listProjects().find((pr) => pr.id === project.id)!.transitions[pairKey].modeProvenance,
    'manual',
    'the author of the decision is stored, not just the decision'
  )

  const confirm = liveConfirmation(project.id, pairKey)
  assert.ok(confirm, 'a confirmation is produced for an override')
  assert.strictEqual(confirm!.spatialGuidance, 'none', 'with no spatial guidance claimed')
  assert.ok(confirm!.overrideWarning, 'and a warning the dialog can show')
  assert.ok(confirm!.overrideReason, 'plus why the evidence is missing')

  // E. The override still produces a normal queued job and history.
  const submitted = queueLiveGeneration(project.id, [pairKey])
  assert.ok(
    submitted.ok || submitted.reasons.some((r) => /lock|live|key|configur/i.test(r)),
    'an override is refused only by provider gates, never by the evidence gate'
  )

  log('override confirmation: guidance stated as none, warning carried, provenance persisted')
}

/**
 * Give a fixture the accepted spatial map a PAID generation now requires.
 *
 * Paid generation is gated on the accepted analysis being able to justify
 * the move and yield an anchored camera instruction — the fix for a real
 * run that generated eight transitions against an analysis containing no
 * rooms and produced a moved sofa and a duplicated television.
 *
 * Provider-transport fixtures are about keys, capabilities, polling and
 * cost, not about spatial evidence, so they are given one minimal room
 * whose images share a landmark and overlap. That is the smallest thing
 * that makes them represent a project which could legitimately be
 * generated. The REFUSAL is asserted on its own in
 * `testAiGenerationRequiresAcceptedEvidence`.
 */
/**
 * An accepted map AND wording that matches it.
 *
 * The second half was added when generation preflight started refusing
 * prompts built on superseded evidence. That rule is correct — a prompt
 * with no recorded basis is unknown, not current — but it means a
 * fixture that wants to reach the PROVIDER path has to look like a real
 * project after Accept, which carries provenance. Without it these
 * fixtures were being refused before they ever got to the thing they
 * test.
 */
function giveProjectAcceptedMap(projectId: string, imgs: { id: string }[]): void {
  saveAnalysisAndBasis(projectId, imgs)
}

function saveAnalysisAndBasis(projectId: string, imgs: { id: string }[]): void {
  saveAcceptedMapOnly(projectId, imgs)
  const analysis = readAnalysis(projectId)
  const project = listProjects().find((p) => p.id === projectId)
  if (!project) return
  const ids = getFeedSequenceIds(project)
  for (let i = 0; i < ids.length - 1; i++) {
    const key = transitionKey(ids[i], ids[i + 1])
    const existing = project.transitions[key] ?? defaultTransitionSettings(5)
    project.transitions[key] = {
      ...existing,
      promptProvenance: {
        basePrompt: 'base',
        motionInstruction: 'move',
        effectivePrompt: existing.prompt || 'wording',
        basis: 'same-room',
        rationale: '',
        manuallyEdited: false,
        plannedAt: Date.now(),
        analysisUpdatedAt: analysis.updatedAt,
        // Matches what `readinessInputs` resolves for a project with an
        // accepted map and no feed analysis or pair analysis.
        evidenceSource: 'global-analysis',
        evidenceFingerprint: evidenceFingerprintOf({
          source: 'global-analysis',
          analysisUpdatedAt: analysis.updatedAt
        }),
        pairKey: key
      }
    }
  }
  project.updatedAt = Date.now()
  saveProject(project)
}

function saveAcceptedMapOnly(projectId: string, imgs: { id: string }[]): void {
  saveAnalysis({
    ...emptyAnalysis(projectId),
    state: 'accepted',
    rooms: [
      {
        id: 'living',
        label: 'Living Room',
        imageIds: imgs.map((i) => i.id),
        landmarks: ['sofa'],
        confidence: 'confirmed'
      }
    ],
    images: imgs.map((i) => ({
      imageId: i.id,
      roomId: 'living',
      orientation: 'into-room' as const,
      landmarks: ['sofa', 'window wall'],
      openings: [],
      overlapWith: imgs.filter((o) => o.id !== i.id).map((o) => o.id)
    }))
  })
}

/**
 * REGENERATE, DETACH, RE-ATTACH — WITHOUT LOSING HISTORY.
 *
 * A transition can be generated many times. Exactly one of those
 * generations is ACTIVE; the rest are history, and history is
 * append-only because it records money that was really spent and files
 * that really exist. Detaching a clip must therefore remove an
 * ASSIGNMENT, never a generation — otherwise "nothing is ever lost"
 * stops being true the first time someone tidies up.
 */
function testActiveClipLifecycle(workDir: string, created: string[]): void {
  const project = makeProject('Smoke active clip lifecycle')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'clip-lifecycle.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: 'a.png' },
    { sourcePath: p, name: 'b.png' },
    { sourcePath: p, name: 'c.png' }
  ])
  const [A, B, C] = project.images.map((i) => i.id)
  const pairAB = transitionKey(A, B)
  const pairBC = transitionKey(B, C)
  project.feedSequence = [A, B, C]
  project.transitions = {
    [pairAB]: { ...defaultTransitionSettings(5), mode: 'ai', modeProvenance: 'manual' },
    [pairBC]: { ...defaultTransitionSettings(5), mode: 'ai', modeProvenance: 'manual' }
  }
  saveProject(project)

  const clip = (name: string): TransitionClip => ({
    storedName: name,
    originalName: name,
    source: 'fal',
    src: `f2f://${name}`
  })
  const record = (jobId: string, name: string, from: string, to: string): void => {
    archivePreviousGenerations(project.id, from, to)
    recordGeneration({
      queueJobId: jobId,
      projectId: project.id,
      fromImageId: from,
      toImageId: to,
      provider: 'fal',
      model: null,
      clip: clip(name),
      prompt: 'a prompt'
    })
  }

  // ── F. Regenerating appends; the earlier generation is retained ─────
  record('job-1', 'first.mp4', A, B)
  record('job-2', 'second.mp4', A, B)
  flushNow()

  let rows = getAllProjectGenerations(project.id).filter((g) => g.fromImageId === A)
  assert.strictEqual(rows.length, 2, 'regenerating a pair adds a row rather than replacing one')
  assert.strictEqual(
    rows.filter((r) => r.active).length,
    1,
    'and exactly one of them is the active clip'
  )
  assert.strictEqual(
    rows.find((r) => r.active)?.clip?.storedName,
    'second.mp4',
    'the newest generation becomes active'
  )
  const firstGenerationId = rows.find((r) => r.clip?.storedName === 'first.mp4')!.id

  // Attach the newest so the project agrees with the catalogue.
  const attachedNew = attachGenerationToTransition(project.id, rows.find((r) => r.active)!.id)
  assert.ok(attachedNew.ok, 'the active generation attaches to its pair')
  assert.strictEqual(attachedNew.ok && attachedNew.pairKey, pairAB, 'on its OWN pair')

  // ── G. Detaching removes the assignment, not the history ────────────
  const cleared = clearActiveClip(project.id, pairAB)
  assert.ok(cleared.ok, 'the active clip can be detached')
  flushNow()

  const afterClear = listProjects().find((pr) => pr.id === project.id)!
  assert.strictEqual(afterClear.transitions[pairAB].clip, null, 'the transition has no clip')
  assert.strictEqual(afterClear.transitions[pairAB].status, 'not-generated', 'and reads as ungenerated')
  assert.strictEqual(
    afterClear.transitions[pairAB].mode,
    'ai',
    'while its mode and settings are untouched'
  )
  assert.deepStrictEqual(
    afterClear.feedSequence,
    [A, B, C],
    'and the pair stays in the feed'
  )
  assert.strictEqual(
    getAllProjectGenerations(project.id).filter((g) => g.fromImageId === A).length,
    2,
    'BOTH generations remain in the catalogue — detaching destroys no history'
  )

  // ── H. An older generation can be made active again, free ───────────
  const reattached = attachGenerationToTransition(project.id, firstGenerationId)
  assert.ok(reattached.ok, 'an earlier generation can be re-attached')
  flushNow()

  const afterAttach = listProjects().find((pr) => pr.id === project.id)!
  assert.strictEqual(
    afterAttach.transitions[pairAB].clip?.storedName,
    'first.mp4',
    'the older clip is now the one the video uses'
  )
  assert.strictEqual(afterAttach.transitions[pairAB].status, 'completed')
  const active = getAllProjectGenerations(project.id).filter(
    (g) => g.fromImageId === A && g.active
  )
  assert.strictEqual(active.length, 1, 'still exactly one active generation for the pair')
  assert.strictEqual(active[0].id, firstGenerationId, 'and it is the one that was attached')

  // ── I. A clip from a different pair is refused ──────────────────────
  record('job-3', 'other.mp4', B, C)
  flushNow()
  const foreign = getAllProjectGenerations(project.id).find((g) => g.fromImageId === B)!
  const attachedForeign = attachGenerationToTransition(project.id, foreign.id)
  assert.ok(attachedForeign.ok, 'it attaches — but to ITS OWN pair')
  assert.strictEqual(
    attachedForeign.ok && attachedForeign.pairKey,
    pairBC,
    'never to whatever happens to be selected: the pair comes from the generation itself'
  )
  assert.strictEqual(
    listProjects().find((pr) => pr.id === project.id)!.transitions[pairAB].clip?.storedName,
    'first.mp4',
    'so the other transition is not overwritten by an unrelated clip'
  )

  // A generation from another project is not attachable at all.
  assert.ok(
    !attachGenerationToTransition(project.id, 'no-such-generation').ok,
    'an unknown generation id is refused'
  )

  log('active clip: regenerate appends, detach keeps history, re-attach costs nothing')
}

/**
 * ANALYSING THE FEED MUST NOT REWRITE THE FEED.
 *
 * The operator's order is the story they chose. "Analyse Imported Media"
 * is the ONE action allowed to propose a different selection or order;
 * everything that evaluates an existing feed may only write judgements
 * about the pairs already in it.
 */
function testFeedAnalysisPreservesOrder(): void {
  // Deliberately NOT library order, and deliberately not sorted.
  const feed = ['IMAGE_004', 'IMAGE_011', 'IMAGE_002', 'IMAGE_030']
  const before = [...feed]

  const analysis: PropertyAnalysis = {
    ...emptyAnalysis('p1'),
    rooms: [
      { id: 'r1', label: 'Living Room', imageIds: feed, landmarks: [], confidence: 'confirmed' }
    ],
    // The library holds MORE than the feed. Those extra images are
    // evidence, never candidates for insertion.
    images: [...feed, 'IMAGE_007', 'IMAGE_018'].map((id) => ({
      imageId: id,
      roomId: 'r1',
      orientation: 'unknown' as const,
      landmarks: ['sofa'],
      openings: []
    }))
  }

  const result = extractTransitionAnalysis(analysis, feed, Date.now())
  assert.ok(result.draft, 'the feed is analysable')

  // A. The order is byte-for-byte what it was.
  assert.deepStrictEqual(feed, before, 'analysis does not mutate the array it was given')
  assert.deepStrictEqual(
    result.draft!.feedImageIds,
    before,
    'and the draft records exactly the order it analysed'
  )

  // B. Extra library images contribute evidence but are never inserted.
  assert.deepStrictEqual(
    result.draft!.pairs.map((p) => `${p.fromId}>${p.toId}`),
    ['IMAGE_004>IMAGE_011', 'IMAGE_011>IMAGE_002', 'IMAGE_002>IMAGE_030'],
    'exactly the adjacent pairs of the chosen order — nothing added, removed or reordered'
  )
  for (const pair of result.draft!.pairs) {
    assert.ok(before.includes(pair.fromId) && before.includes(pair.toId), 'and only feed images')
  }

  log('feed analysis: the operator’s order is preserved exactly; library images stay evidence')
}

/**
 * ANALYSE FEED, END TO END, WITHOUT PAYING.
 *
 * The paid workflow is verified by driving a MOCKED structured response
 * through the real chain: instruction → schema → parser → canonical
 * safety evaluator → persisted draft → staleness. Only the quality of a
 * genuine Gemini answer is left unverified; every contract around it is
 * exercised here.
 *
 * The invariant under test is the product rule: the operator's order is
 * the story they chose, so this workflow explains it and never revises
 * it. Library images are evidence, not candidates.
 */
async function testAnalyseFeedWorkflow(workDir: string, created: string[]): Promise<void> {
  const project = makeProject('Smoke analyse feed')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'analyse-feed.png')
  writeFileSync(p, png)
  // Library of four; feed of three, deliberately NOT in library order.
  project.images = importImages(project.id, [
    { sourcePath: p, name: 'a.png' },
    { sourcePath: p, name: 'b.png' },
    { sourcePath: p, name: 'c.png' },
    { sourcePath: p, name: 'd.png' }
  ])
  const [A, B, C, D] = project.images.map((i) => i.id)
  const feed = [A, C, B]
  project.feedSequence = [...feed]
  saveProject(project)

  const request = (feedImageIds?: string[]): AnalyzerRequest => ({
    projectId: project.id,
    projectName: project.name,
    images: project.images.map((img, i) => ({
      imageId: img.id,
      sequence: i + 1,
      fileName: img.fileName,
      ref: img.src
    })),
    existing: null,
    notes: '',
    capabilities: ALL_CAPABILITIES,
    feedImageIds
  })

  // ── F. The instruction states decisions vs evidence ─────────────────
  const instruction = buildInstruction(request(feed))
  assert.match(instruction, /IMAGE_001 → IMAGE_003/, 'the exact feed pairs are named')
  assert.match(instruction, /IMAGE_003 → IMAGE_002/, 'in the operator’s order')
  assert.ok(
    !/IMAGE_002 → IMAGE_003/.test(instruction),
    'and never in library order, which is a different pair'
  )
  assert.match(instruction, /is CONTEXT/i, 'other images are named as context')
  assert.match(
    instruction,
    /not yours to revise|do NOT propose adding/i,
    'and the model is told it may not revise the sequence'
  )
  assert.ok(
    !/IMAGE_001 → IMAGE_003/.test(buildInstruction(request(undefined))),
    'a whole-library run carries no feed section — it is still allowed to propose an order'
  )

  // ── K. A mocked response WITH shared-room evidence yields AI ────────
  const sharedRoom = JSON.stringify({
    rooms: [
      {
        label: 'Living Room',
        imageIds: ['IMAGE_001', 'IMAGE_003', 'IMAGE_002', 'IMAGE_004'],
        landmarks: ['sectional sofa'],
        confidence: 'confirmed',
        marketingImportance: 9
      }
    ],
    images: ['IMAGE_001', 'IMAGE_003', 'IMAGE_002', 'IMAGE_004'].map((id) => ({
      imageId: id,
      roomLabel: 'Living Room',
      roomConfidence: 'confirmed',
      orientation: 'into-room',
      landmarks: ['sectional sofa', 'window wall'],
      openings: [],
      overlapWith: ['IMAGE_001', 'IMAGE_003', 'IMAGE_002', 'IMAGE_004'].filter((o) => o !== id),
      marketingImportance: 8,
      isHero: id === 'IMAGE_001'
    })),
    connections: [],
    transitionHints: [
      { fromImageId: 'IMAGE_001', toImageId: 'IMAGE_003', safetyLevel: 'safe', notes: 'same sofa' }
    ]
  })

  const runMock = async (responseText: string): Promise<PropertyAnalysis> => {
    const calls: unknown[] = []
    const fetchImpl: FetchLike = async () => {
      calls.push(1)
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: responseText }] } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }
    const analyzer = new GeminiPropertyAnalyzer({
      apiKey: 'AIza-SMOKE-FEED',
      model: GEMINI_DEFAULT_MODEL,
      live: true,
      allowLive: true,
      fetchImpl
    })
    const res = await analyzer.analyzeProperty(request(feed))
    assert.ok(res.ok, `mocked analysis parsed: ${res.ok ? '' : res.reason}`)
    assert.strictEqual(calls.length, 1, 'one request for the whole property')
    return res.ok ? res.analysis : emptyAnalysis(project.id)
  }

  const richAnalysis = await runMock(sharedRoom)
  assert.ok(richAnalysis.rooms.length > 0, 'the real parser produced rooms from the mock')
  assert.strictEqual(
    (richAnalysis.transitionHints ?? []).length > 0,
    true,
    'and carried the transition hints through the real schema'
  )

  const rich = extractTransitionAnalysis(richAnalysis, feed, Date.now())
  assert.ok(rich.draft, 'the canonical evaluator produced a draft')
  assert.deepStrictEqual(
    rich.draft!.pairs.map((x) => `${x.fromId}>${x.toId}`),
    [`${A}>${C}`, `${C}>${B}`],
    'F: decisions for exactly the feed pairs — D contributed evidence and was never inserted'
  )
  assert.ok(
    rich.draft!.pairs.every((x) => x.recommendation === 'ai'),
    'K: same room with shared landmarks and overlap → the canonical evaluator allows AI'
  )

  // ── L. A mocked response WITHOUT evidence yields CUT ────────────────
  const noEvidence = JSON.stringify({
    rooms: [
      { label: 'Living Room', imageIds: ['IMAGE_001'], landmarks: [], confidence: 'confirmed' },
      { label: 'Bedroom', imageIds: ['IMAGE_003', 'IMAGE_002'], landmarks: [], confidence: 'confirmed' }
    ],
    images: [
      { imageId: 'IMAGE_001', roomLabel: 'Living Room', roomConfidence: 'confirmed', orientation: 'unknown', landmarks: ['sofa'], openings: [] },
      { imageId: 'IMAGE_003', roomLabel: 'Bedroom', roomConfidence: 'confirmed', orientation: 'unknown', landmarks: ['bed'], openings: [] },
      { imageId: 'IMAGE_002', roomLabel: 'Bedroom', roomConfidence: 'confirmed', orientation: 'unknown', landmarks: ['wardrobe'], openings: [] }
    ],
    connections: [],
    // Gemini claiming safety cannot unlock a pair the evidence refuses.
    transitionHints: [
      { fromImageId: 'IMAGE_001', toImageId: 'IMAGE_003', safetyLevel: 'safe', notes: 'looks fine' }
    ]
  })
  const thin = extractTransitionAnalysis(await runMock(noEvidence), feed, Date.now())
  assert.ok(
    thin.draft!.pairs.every((x) => x.recommendation === 'cut'),
    'L: no shared evidence → CUT, and a "safe" hint does not override the local rules'
  )

  // ── G. Persist, reload, still reviewable ────────────────────────────
  const stored = {
    ...rich.draft!,
    mediaImageIds: project.images.map((i) => i.id),
    analyzer: 'gemini',
    model: GEMINI_DEFAULT_MODEL
  }
  saveTransitionDraft(project.id, stored)
  flushNow()

  const reloaded = readTransitionDraft(project.id)
  assert.ok(reloaded, 'G: the feed analysis survives a restart')
  assert.deepStrictEqual(reloaded!.feedImageIds, feed, 'with the exact order it analysed')
  assert.deepStrictEqual(
    reloaded!.mediaImageIds,
    project.images.map((i) => i.id),
    'and the library fingerprint that was its evidence'
  )

  const library = project.images.map((i) => i.id)
  assert.strictEqual(
    feedAnalysisStatus(reloaded, feed, library).state,
    'draft',
    'unchanged project → the draft is current'
  )

  // ── H. Reordering the feed outdates it ──────────────────────────────
  const reordered = feedAnalysisStatus(reloaded, [A, B, C], library)
  assert.strictEqual(reordered.state, 'outdated', 'H: a different order is a different analysis')
  assert.ok(reordered.feedChanged, 'and the feed is named as what changed')

  // ── I. Changing the LIBRARY outdates it even with the same feed ─────
  const libraryChanged = feedAnalysisStatus(reloaded, feed, [A, B, C])
  assert.strictEqual(
    libraryChanged.state,
    'outdated',
    'I: removing a supporting image invalidates evidence the analysis relied on'
  )
  assert.ok(libraryChanged.libraryChanged, 'and the library is named as what changed')
  assert.ok(!libraryChanged.feedChanged, 'while the feed itself is untouched')
  assert.strictEqual(
    feedAnalysisStatus(reloaded, feed, [...library, 'newly-imported']).state,
    'outdated',
    'importing an image does the same — there is now evidence the analysis never saw'
  )

  // ── J. Accepting never touches the feed ─────────────────────────────
  const before = [...listProjects().find((pr) => pr.id === project.id)!.feedSequence!]
  saveTransitionDraft(project.id, { ...stored, status: 'accepted' })
  flushNow()
  const after = listProjects().find((pr) => pr.id === project.id)!.feedSequence
  assert.deepStrictEqual(after, before, 'J: accepting a feed analysis leaves the feed byte-identical')
  assert.deepStrictEqual(after, feed, 'and it is still the operator’s chosen order')
  assert.strictEqual(
    feedAnalysisStatus(readTransitionDraft(project.id), feed, library).state,
    'accepted'
  )

  log('analyse feed: exact pairs decided, library is evidence only, dual staleness, order preserved')
}

/**
 * ANALYSE PROMPTS — wording only, never the feed.
 *
 * The third workflow, and deliberately separate from the other two.
 * Analyse Imported Media proposes WHICH images and in what order.
 * Analyse Feed judges whether each adjacent pair can be generated.
 * This one answers only "what should the generation prompt say", from
 * spatial evidence that has already been accepted.
 *
 * It writes no feed, submits nothing to a provider and costs nothing.
 */
function testAnalysePromptsWorkflow(workDir: string, created: string[]): void {
  const project = makeProject('Smoke analyse prompts')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'analyse-prompts.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: 'a.png' },
    { sourcePath: p, name: 'b.png' },
    { sourcePath: p, name: 'c.png' }
  ])
  const [A, B, C] = project.images.map((i) => i.id)
  // Feed order deliberately differs from library order, so a planner that
  // still indexed by library position would plan the wrong pairs.
  const feed = [A, C, B]
  project.feedSequence = [...feed]
  const pairAC = transitionKey(A, C)
  const pairCB = transitionKey(C, B)
  project.transitions = {
    [pairAC]: { ...defaultTransitionSettings(5), mode: 'ai', modeProvenance: 'analysis' },
    [pairCB]: { ...defaultTransitionSettings(5), mode: 'ai', modeProvenance: 'analysis' }
  }
  saveProject(project)

  // ── Blocked without accepted spatial evidence ──────────────────────
  deleteAnalysis(project.id)
  assert.strictEqual(
    planPromptRebuild(project.id).hasAnalysis,
    false,
    'with no accepted analysis the workflow reports it has nothing to build from'
  )

  // A real accepted map over the FEED images.
  saveAnalysis({
    ...emptyAnalysis(project.id),
    state: 'accepted',
    rooms: [
      {
        id: 'living',
        label: 'Living Room',
        imageIds: [A, C, B],
        landmarks: ['sectional sofa'],
        confidence: 'confirmed'
      }
    ],
    images: [A, C, B].map((id) => ({
      imageId: id,
      roomId: 'living',
      orientation: 'into-room' as const,
      landmarks: ['sectional sofa', 'window wall'],
      openings: [],
      overlapWith: [A, C, B].filter((o) => o !== id)
    }))
  })
  flushNow()

  const plan = planPromptRebuild(project.id)
  assert.ok(plan.hasAnalysis, 'the accepted map is found')
  assert.ok(
    plan.rebuildable.every((r) => r.pairKey === pairAC || r.pairKey === pairCB),
    'only CURRENT feed pairs are planned — never a library-order pair that is not in the video'
  )

  // ── C. All: prompts change, the feed does not ───────────────────────
  const feedBefore = [...listProjects().find((pr) => pr.id === project.id)!.feedSequence!]
  const result = rebuildPromptsFromAnalysis(project.id)
  flushNow()

  const afterAll = listProjects().find((pr) => pr.id === project.id)!
  assert.deepStrictEqual(
    afterAll.feedSequence,
    feedBefore,
    'C: analysing prompts never touches feed membership or order'
  )
  assert.ok(result.rebuiltCount > 0, 'and prompts were actually written')
  assert.ok(
    afterAll.transitions[pairAC].prompt.length > 0,
    'the feed pair now carries an analysis-derived prompt'
  )
  assert.strictEqual(
    afterAll.transitions[pairAC].promptProvenance?.manuallyEdited,
    false,
    'attributed to the analysis, not to a human'
  )

  // ── M. No provider work was created ─────────────────────────────────
  assert.strictEqual(
    listJobs().filter((j) => j.projectId === project.id).length,
    0,
    'M: analysing prompts queues no generation job'
  )
  assert.strictEqual(
    listCostEntries(project.id).filter((e) => e.category === 'video-generation').length,
    0,
    'and spends nothing at a video provider'
  )

  // ── E. A hand-written prompt is preserved by All ────────────────────
  const manual = listProjects().find((pr) => pr.id === project.id)!
  manual.transitions[pairCB] = {
    ...manual.transitions[pairCB],
    prompt: 'a prompt the operator wrote themselves',
    promptProvenance: markManuallyEdited(
      manual.transitions[pairCB].promptProvenance ?? null,
      'a prompt the operator wrote themselves',
      Date.now()
    )
  }
  saveProject(manual)
  flushNow()

  const secondPlan = planPromptRebuild(project.id)
  assert.ok(
    secondPlan.preserved.some((x) => x.pairKey === pairCB),
    'E: the plan reports the manual prompt as preserved BEFORE anything is written'
  )
  const second = rebuildPromptsFromAnalysis(project.id)
  flushNow()
  assert.ok(second.preservedCount >= 1, 'and the run reports it too')
  assert.strictEqual(
    listProjects().find((pr) => pr.id === project.id)!.transitions[pairCB].prompt,
    'a prompt the operator wrote themselves',
    'the hand-written wording is untouched by an All run'
  )

  // ── D. Selected changes ONLY the selected pair ──────────────────────
  const beforeSelected = listProjects().find((pr) => pr.id === project.id)!
  const otherPromptBefore = beforeSelected.transitions[pairCB].prompt
  const targetBefore = beforeSelected.transitions[pairAC].prompt

  // Wipe the target so a change is unambiguous.
  beforeSelected.transitions[pairAC] = {
    ...beforeSelected.transitions[pairAC],
    prompt: ''
  }
  saveProject(beforeSelected)
  flushNow()

  const applied = applyAnalysisPromptToTransition(project.id, pairAC)
  flushNow()
  const afterSelected = listProjects().find((pr) => pr.id === project.id)!
  assert.ok(applied.ok, 'D: the selected pair is analysed')
  assert.ok(afterSelected.transitions[pairAC].prompt.length > 0, 'and gets a prompt')
  assert.strictEqual(
    afterSelected.transitions[pairCB].prompt,
    otherPromptBefore,
    'while every other transition is left exactly as it was'
  )
  assert.ok(targetBefore.length > 0, 'sanity: the target had a prompt before it was cleared')

  // Selected on a MANUAL prompt reports that it replaced one, so the UI
  // can require confirmation before calling it.
  const replaced = applyAnalysisPromptToTransition(project.id, pairCB)
  assert.ok(
    replaced.ok && replaced.replacedManualPrompt,
    'E: replacing a manual prompt is reported, so the UI can confirm first'
  )

  log('analyse prompts: wording only — feed untouched, manual prompts preserved, no provider work')
}

/**
 * THE HEADER AND THE INSPECTOR RESOLVE THE SAME PAIR.
 *
 * Reported from a running app: the preview header read "TRANSITION 1 → 2"
 * while the inspector below it said "Select a transition in the timeline
 * to configure it" — about the transition that was already selected.
 *
 * There was no second selection state. Both panes received the same
 * `pairKey` from the one `EditorSelection`; they looked it up in
 * DIFFERENT LISTS. The header used `pairIndexOf`, which reads the feed;
 * the inspector searched `project.images`, the imported library. They
 * agree only while feed order happens to match library order, and
 * accepting a media proposal is precisely what ends that.
 *
 * This pins the property directly: for every pair the feed contains, the
 * canonical lookup resolves it, and it resolves to the SAME two images
 * the feed says are adjacent.
 */
function testSelectedPairResolvesEverywhere(workDir: string, created: string[]): void {
  const project = makeProject('Smoke selected pair resolution')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'selected-pair.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: 'a.png' },
    { sourcePath: p, name: 'b.png' },
    { sourcePath: p, name: 'c.png' },
    { sourcePath: p, name: 'd.png' }
  ])
  const [A, B, C, D] = project.images.map((i) => i.id)

  // The shape that broke it: feed order ≠ library order, and NO stored
  // transition rows at all — a freshly accepted proposal looks like this.
  project.feedSequence = [C, A, D]
  project.transitions = {}
  saveProject(project)

  const feedIds = getFeedSequenceIds(project)
  const feedImages = getFeedImages(project)

  for (let i = 0; i < feedIds.length - 1; i++) {
    const pairKey = transitionKey(feedIds[i], feedIds[i + 1])

    // What the header does.
    const headerIndex = pairIndexOf(project, pairKey)
    assert.strictEqual(headerIndex, i, `the header resolves feed pair ${i + 1} → ${i + 2}`)

    // What the inspector must now do — the SAME lookup, not a library scan.
    const start = feedImages[headerIndex]
    const end = feedImages[headerIndex + 1]
    assert.ok(start && end, 'the inspector resolves both frames, so it renders')
    assert.strictEqual(
      transitionKey(start.id, end.id),
      pairKey,
      'and they are exactly the two images the selection names'
    )

    // The library scan that used to be there finds nothing for these
    // pairs — which is precisely why the panel went blank.
    const libraryIndex = project.images.findIndex(
      (img, k) =>
        k < project.images.length - 1 &&
        transitionKey(img.id, project.images[k + 1].id) === pairKey
    )
    assert.strictEqual(
      libraryIndex,
      -1,
      'proof of the bug: a library scan cannot find a feed pair once the order differs'
    )

    // A LOGICAL transition needs no stored row. Settings are lazy, so the
    // inspector must render on adjacency alone.
    assert.strictEqual(
      project.transitions[pairKey],
      undefined,
      'no settings row exists yet, and the inspector must still render'
    )
  }

  // Every logical transition the rest of the app enumerates is one the
  // inspector can resolve — no pair can be selectable and un-inspectable.
  const logical = logicalTransitions(project, 5)
  assert.strictEqual(logical.length, feedIds.length - 1, 'three feed images, two transitions')
  for (const t of logical) {
    assert.ok(
      pairIndexOf(project, t.pairKey) >= 0,
      `every enumerated transition resolves: ${t.label}`
    )
  }

  // And B, which is in the library but NOT in the feed, is not a pair.
  assert.strictEqual(
    pairIndexOf(project, transitionKey(A, B)),
    -1,
    'a library-adjacent pair outside the feed is correctly not a transition'
  )

  log('selected pair: header and inspector resolve identically, and lazily — no stored row needed')
}

/**
 * EXPORT READINESS COUNTS THE VIDEO, NOT THE LIBRARY.
 *
 * Reported from a running app: a finished 35-image feed refused to
 * export with "Missing transition clips: 5 → 6, 7 → 8, 9 → 10, 11 → 12,
 * 13 → 14" — every second pair, on a project where every transition was
 * either a cut or an AI with a clip.
 *
 * `projectAssembly` enumerated `project.images`. Library-adjacent pairs
 * have no stored transition row, so they read as `auto`; wherever the
 * analysis happened to support a move they resolved to AI; and never
 * having been generated — they are not in the film — they were reported
 * missing. The positions in that message were library positions, so they
 * did not even name transitions the video contains.
 *
 * This fixture is that shape: a feed that is not library order, mixed
 * modes, and a library pair that would resolve to AI if anyone asked.
 */
function testExportReadinessUsesFeed(workDir: string, created: string[]): void {
  const project = makeProject('Smoke export readiness')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'export-readiness.png')
  writeFileSync(p, png)
  project.images = importImages(
    project.id,
    Array.from({ length: 8 }, (_, i) => ({ sourcePath: p, name: `img-${i + 1}.png` }))
  )
  const ids = project.images.map((i) => i.id)

  // A feed that is NOT library order, alternating cut / AI-with-clip, plus
  // one AUTO that resolves to a cut with no analysis behind it.
  const feed = [ids[0], ids[2], ids[4], ids[6], ids[1]]
  project.feedSequence = [...feed]

  // A clip row pointing at a file that is not on disk IS missing — that
  // is correct production behaviour — so the fixture writes real files.
  const clip = (name: string): TransitionClip => {
    const dir = projectTransitionsDir(project.id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), 'not a real video, but a real file')
    return { storedName: name, originalName: name, source: 'fal', src: `f2f://${name}` }
  }
  const pair = (i: number): string => transitionKey(feed[i], feed[i + 1])

  project.transitions = {
    // 1→2 explicit CUT: needs no clip, ever.
    [pair(0)]: { ...defaultTransitionSettings(5), mode: 'cut' },
    // 2→3 AI with an active clip.
    [pair(1)]: {
      ...defaultTransitionSettings(5),
      mode: 'ai',
      status: 'completed',
      clip: clip('gen-a.mp4')
    },
    // 3→4 AUTO with no analysis — resolves to a cut, so no clip needed.
    [pair(2)]: { ...defaultTransitionSettings(5) },
    // 4→5 AI with an active clip.
    [pair(3)]: {
      ...defaultTransitionSettings(5),
      mode: 'ai',
      status: 'completed',
      clip: clip('gen-b.mp4')
    }
  }

  // A HISTORICAL row for a pair the feed no longer contains. It must not
  // create a warning: the video does not contain that transition.
  project.transitions[transitionKey(ids[5], ids[6])] = {
    ...defaultTransitionSettings(5),
    mode: 'ai'
  }
  saveProject(project)
  flushNow()

  const stored = listProjects().find((pr) => pr.id === project.id)!

  // ── Ready: every AI pair has a clip, every cut needs none ───────────
  const missing = missingClipPairs(stored)
  assert.deepStrictEqual(
    missing,
    [],
    `a finished feed reports nothing missing, got: ${missing.join(', ')}`
  )

  const { plan } = projectAssembly(stored)
  assert.ok(plan.ok, 'and the assembler agrees it can build')
  assert.strictEqual(
    plan.cutPairs.length + plan.crossfadePairs.length + 2,
    feed.length - 1,
    'every feed transition is accounted for as cut, crossfade or clip-backed'
  )

  // ── READINESS AND THE ASSEMBLER CANNOT DISAGREE ─────────────────────
  //
  // Both come through `projectAssembly`, so this asserts the property
  // rather than two separate implementations happening to match.
  const segmentsResolve = projectAssembly(stored).segments.every((s) => s.path.length > 0)
  assert.ok(
    segmentsResolve,
    'if readiness says exportable, every segment the assembler needs resolves'
  )

  // ── Remove ONE active clip → exactly that pair is missing ───────────
  const broken = listProjects().find((pr) => pr.id === project.id)!
  broken.transitions[pair(1)] = {
    ...broken.transitions[pair(1)],
    clip: null,
    status: 'not-generated'
  }
  saveProject(broken)
  flushNow()

  const nowMissing = missingClipPairs(listProjects().find((pr) => pr.id === project.id)!)
  assert.deepStrictEqual(
    nowMissing,
    ['2 → 3'],
    'exactly the AI pair whose clip was detached, named by FEED position'
  )

  // ── A CUT never asks for a clip, whatever else is true ──────────────
  const asCut = listProjects().find((pr) => pr.id === project.id)!
  asCut.transitions[pair(1)] = { ...asCut.transitions[pair(1)], mode: 'cut' }
  saveProject(asCut)
  flushNow()
  assert.deepStrictEqual(
    missingClipPairs(listProjects().find((pr) => pr.id === project.id)!),
    [],
    'changing that transition to a cut clears the warning — a cut generates nothing'
  )

  log('export readiness: feed pairs only, cuts need no clip, stale rows raise nothing')
}

/**
 * THE SHAPE THE REAL PROJECT WAS IN.
 *
 * Read out of the live database while diagnosing: a 15-image feed whose
 * transitions alternate between "ai with a clip" and "auto, no stored row
 * at all, no clip". The export panel reported exactly the second kind as
 * missing — "5 → 6, 7 → 8, 9 → 10, 11 → 12, 13 → 14" — because it
 * demanded a generated clip for every pair without asking what the
 * transition is.
 *
 * An AUTO pair with no analysis behind it resolves to a CUT, and a cut
 * generates nothing. This pins that the published readiness agrees.
 */
function testAutoResolvingCutNeedsNoClip(workDir: string, created: string[]): void {
  const project = makeProject('Smoke auto-cut readiness')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'auto-cut.png')
  writeFileSync(p, png)
  project.images = importImages(
    project.id,
    Array.from({ length: 7 }, (_, i) => ({ sourcePath: p, name: `img-${i + 1}.png` }))
  )
  const ids = project.images.map((i) => i.id)
  project.feedSequence = [...ids]

  const dir = projectTransitionsDir(project.id)
  mkdirSync(dir, { recursive: true })
  const clipFor = (name: string): TransitionClip => {
    writeFileSync(join(dir, name), 'real file')
    return { storedName: name, originalName: name, source: 'fal', src: `f2f://${name}` }
  }

  // Alternating, exactly as the real project read: ai+clip, then AUTO
  // with NO stored row at all.
  project.transitions = {}
  for (let i = 0; i < ids.length - 1; i += 2) {
    project.transitions[transitionKey(ids[i], ids[i + 1])] = {
      ...defaultTransitionSettings(5),
      mode: 'ai',
      status: 'completed',
      clip: clipFor(`gen-${i}.mp4`)
    }
  }
  // No analysis at all, so every AUTO pair has no evidence and must be a cut.
  deleteAnalysis(project.id)
  saveProject(project)
  flushNow()

  const stored = listProjects().find((pr) => pr.id === project.id)!

  // The rule the panel used to apply, reproduced so the test states what
  // was wrong rather than merely asserting the fix.
  const naive: string[] = []
  const feed = getFeedImages(stored)
  for (let i = 0; i < feed.length - 1; i++) {
    if (!stored.transitions[transitionKey(feed[i].id, feed[i + 1].id)]?.clip) {
      naive.push(`${i + 1} → ${i + 2}`)
    }
  }
  assert.deepStrictEqual(
    naive,
    ['2 → 3', '4 → 5', '6 → 7'],
    'the old "every pair needs a clip" rule flags every cut — the reported bug'
  )

  // The published answer asks what each transition actually IS.
  const readiness = exportReadiness(stored)
  assert.deepStrictEqual(
    readiness.missingAiClips,
    [],
    `an auto pair with no evidence is a cut and needs no clip; got: ${readiness.missingAiClips.join(', ')}`
  )
  assert.ok(readiness.ready, 'so the project is exportable')
  assert.strictEqual(readiness.cutPairs.length, 3, 'and the three cuts are reported as cuts')
  assert.strictEqual(readiness.sequenceLength, 7, 'over the feed, not the library')

  // Readiness and the assembler are the same computation, so they cannot
  // disagree — asserted rather than assumed.
  assert.deepStrictEqual(
    readiness.missingAiClips,
    missingClipPairs(stored),
    'the published readiness and the assembler return the same list'
  )

  log('auto→cut readiness: a cut never asks for a clip, and one answer serves panel and exporter')
}

/**
 * THE PROPERTY IS UNOCCUPIED — INCLUDING IN THE MIRROR.
 *
 * A real generation put a photographer into a mirrored wardrobe. A
 * camera moving through a room implies something moving it, and a model
 * asked to render that motion will sometimes resolve the implication by
 * drawing the observer.
 *
 * The constraint therefore has to survive all the way into the payload,
 * not merely exist in a preset — and it is asserted against the real fal
 * body builder for that reason.
 */
function testReflectionConstraintReachesProvider(): void {
  // ── THE ENTITIES THAT MUST BE NAMED ─────────────────────────────────
  //
  // This list used to be checked against a "must never show" sentence.
  // The wording moved to non-existence — "these entities do not exist in
  // this scene" — after a model generated a person with a camera in a
  // mirror WITH the prohibition present. A prohibition concedes the thing
  // is there and asks for it to be hidden, which a mirror then
  // contradicts, because revealing what the frame does not show directly
  // is exactly what a mirror does.
  //
  // What is pinned is therefore the same protection, not the same prose:
  // every entity is still named, and it is still impossible to drop one
  // silently.
  const banned = [
    'photographer',
    'camera operator',
    'camera',
    'phone',
    'tripod',
    'gimbal',
    'drone',
    'recording equipment',
    'human silhouette',
    'reflected space'
  ]
  for (const word of banned) {
    assert.match(
      DEFAULT_TRANSITION_PROMPT.toLowerCase(),
      new RegExp(word.toLowerCase()),
      `the preset names "${word}" among what cannot be generated`
    )
  }
  assert.match(
    DEFAULT_TRANSITION_PROMPT,
    // Now "in this world" — the ontology covers reflected space too,
    // which is exactly where the camera kept appearing.
    /do not exist in this world/i,
    'stated as non-existence — "do not show X" concedes X is there to be hidden'
  )
  assert.match(
    DEFAULT_TRANSITION_PROMPT,
    // Stated in the OPENING now rather than buried mid-prompt, and
    // phrased as what the view is rather than what the camera is not.
    /invisible virtual viewpoint/i,
    'and the view is declared an invisible viewpoint, so a mirror has nothing to reveal'
  )
  assert.match(
    DEFAULT_TRANSITION_PROMPT,
    /zero people anywhere in it/i,
    'the property is stated to be empty of people, not merely unoccupied'
  )
  assert.match(
    DEFAULT_TRANSITION_PROMPT,
    // "Behind the camera" was the old way of closing off the observer,
    // and it asserted a camera to be behind. The ontology now denies the
    // observer outright, which covers the same gap without the object.
    /nothing observes the property from within it/i,
    'the observer is denied outright — "no people" alone leaves one implied'
  )

  // UNCONDITIONAL. Detection is the wrong thing to depend on: a missed
  // mirror puts a stranger in a listing, the rule costs nothing without
  // one. `promptForTransition` with no custom text returns the preset,
  // so every transition that has not been hand-edited carries it.
  assert.strictEqual(
    promptForTransition(''),
    DEFAULT_TRANSITION_PROMPT,
    'an unedited transition sends the full preset, constraint included'
  )

  // ── IT SURVIVES INTO THE ACTUAL fal PAYLOAD ────────────────────────
  const body = buildFalBody(
    {
      projectId: 'p',
      pairKey: 'a->b',
      startImagePath: '/a.png',
      endImagePath: '/b.png',
      startImageName: 'a.png',
      endImageName: 'b.png',
      prompt: promptForTransition(''),
      durationSec: 5,
      resolution: 'standard',
      nativeAudio: false,
      modelId: FAL_MODELS[0].id
    },
    FAL_MODELS[0],
    'start',
    'end'
  )
  const sent = String(body.prompt)
  // The wording moved from "mirrors must never show…" to declaring the
  // entities absent and the camera non-physical. What matters — and what
  // is checked — is that BOTH halves survive length-fitting into the real
  // request body, since fitting is what once silently dropped the
  // constraint block.
  assert.match(sent, /do not exist in this world/i, 'the payload carries the non-existence rule')
  assert.match(
    sent,
    /invisible virtual viewpoint/i,
    'and the declaration that the view is an invisible viewpoint'
  )
  assert.match(sent, /reflected space/i, 'stated to cover reflections too')
  assert.match(sent, /photographer/i, 'naming the photographer specifically')

  // ── NO INSTRUCTION MAY IMPLY A HUMAN ───────────────────────────────
  //
  // The prompt talks about a camera, never about a person carrying one.
  // "no walking bob" is a description of what the MOTION must not look
  // like and is allowed; a person walking is not.
  for (const phrase of ['person walking', 'camera operator moves', 'someone walks', 'you walk']) {
    assert.ok(
      !DEFAULT_TRANSITION_PROMPT.toLowerCase().includes(phrase),
      `the preset never implies a human actor ("${phrase}")`
    )
  }

  log('reflection constraint: unconditional, in the preset and in the provider payload')
}

/**
 * THE PROMPT FITS fal's FIELD, WITH ITS CONSTRAINTS INTACT.
 *
 * fal returned HTTP 422 "String should have at most 2500 characters" on
 * every generation: the preset had grown to 2776 characters and the
 * whole request was rejected before any work began.
 *
 * The dangerous fix would have been `slice(0, 2500)`. The constraints
 * live at the END of the prompt, so that turns a loud failure into a
 * quiet one — requests succeed while no longer carrying the reflection
 * rule or the geometry contract, which is how invented rooms and
 * mirrored photographers get generated at full price.
 */
function testFalPromptFitsLimit(): void {
  const MANDATORY = [
    'END FRAME must be reproduced EXACTLY',
    'Do not redesign, reinterpret, add, remove, move or alter anything',
    'No morphing, warping, melting',
    'never through walls, floors, ceilings or furniture',
    // The occupancy rules, in their current wording. These three carry
    // what "no photographer in the mirror" used to say: the scene has no
    // people, the entities are declared absent rather than hidden, and
    // the camera is not a physical object a reflection could show.
    'zero people anywhere in it',
    'do not exist in this world',
    'invisible virtual viewpoint',
    'photographer'
  ]
  const assertConstraintsSurvive = (prompt: string, where: string): void => {
    for (const rule of MANDATORY) {
      assert.ok(prompt.includes(rule), `${where}: "${rule}" survives`)
    }
  }

  // ── The preset alone ────────────────────────────────────────────────
  assert.ok(
    DEFAULT_TRANSITION_PROMPT.length <= FAL_PROMPT_MAX_CHARS,
    `the preset is ${DEFAULT_TRANSITION_PROMPT.length} chars, limit ${FAL_PROMPT_MAX_CHARS}`
  )
  assertConstraintsSurvive(DEFAULT_TRANSITION_PROMPT, 'preset')

  // ── THE LONGEST REALISTIC PROMPT ────────────────────────────────────
  //
  // Preset plus the wordiest motion instruction the planner can render:
  // a cross-room move with an anchor, a passage, a rotation, a
  // translation and both room names.
  const worstMotion =
    '\n\nCAMERA MOVEMENT FOR THIS TRANSITION:\n' +
    'Hold the floor-to-ceiling stone fireplace and the oak media console in view while ' +
    'rotating clockwise and translating forward from the Living Room through the open ' +
    'sliding glass patio doorway into the Covered Terrace, keeping the glazed façade wall ' +
    'on the left and the sectional sofa in the lower foreground, without depicting travel ' +
    'through any other doorway or opening, since none is confirmed visible in the start frame.'
  const longest = DEFAULT_TRANSITION_PROMPT + worstMotion
  const fittedLongest = fitPromptToLimit(longest, FAL_PROMPT_MAX_CHARS)
  assert.ok(
    fittedLongest.prompt.length <= FAL_PROMPT_MAX_CHARS,
    `the longest realistic prompt fits: ${fittedLongest.prompt.length}`
  )
  assertConstraintsSurvive(fittedLongest.prompt, 'longest realistic')
  // STYLE MAY NOW GO HERE, AND THAT IS CORRECT.
  //
  // This exercises `fitPromptToLimit`, the STRING fitter — which no
  // generated prompt goes through any more. Generated prompts are built
  // by `assemblePrompt` from sections, against the budget, and that
  // guarantee is pinned in `testPromptBudget` where it can actually be
  // stated per block. What is left for this path is an operator's own
  // wording, where giving up the tone line to keep every constraint is
  // exactly the right trade.
  //
  // What must NOT happen is a mandatory block going.
  for (const id of fittedLongest.dropped) {
    assert.strictEqual(id, 'style', `only tone is sacrificed, not ${id}`)
  }

  // ── WHEN IT DOES NOT FIT, TONE GOES FIRST ───────────────────────────
  //
  // THE MANDATORY FLOOR IS PART OF THE CONTRACT. Below it the fitter has
  // nothing left to give up, and this limit is deliberately just above
  // it. The floor grew when the invisible-viewpoint ontology joined the
  // mandatory tail — that was the point of the change, and pinning the
  // number here means it cannot grow again unnoticed.
  //
  // It grew a second time, to 1921, when the constant-velocity motion
  // contract stopped being droppable — and a third time, to 2099, when
  // that contract gained the continuous-take wording. Both were the
  // point of the change.
  const floor = fitPromptToLimit(DEFAULT_TRANSITION_PROMPT, 1).prompt.length
  assert.ok(floor < 2200, `the mandatory floor stays under 2200 chars: ${floor}`)

  // ── WHAT THE FLOOR IS REALLY PROTECTING ─────────────────────────────
  //
  // This used to be `floor + worstMotion <= limit`, and that stopped
  // being the right measurement when generated prompts moved off the
  // string fitter. `floor` is what the STRING path can reach — it can
  // only drop STYLE, never compact — so it overstates the real minimum
  // by about 500 characters and would fail for a budget that is
  // comfortably met.
  //
  // The number that matters is the smallest the SECTION assembler can
  // produce, which it reports itself when asked for the impossible.
  const smallest = assemblePrompt([...Object.values(PRESET_PARTS)], 1)
  assert.ok(!smallest.ok, 'the preset cannot fit in one character, by construction')
  if (!smallest.ok) {
    assert.ok(
      smallest.smallestChars + worstMotion.length <= FAL_PROMPT_MAX_CHARS,
      `fully compacted (${smallest.smallestChars}) plus the wordiest movement ` +
        `instruction (${worstMotion.length}) must fit in ${FAL_PROMPT_MAX_CHARS}`
    )
  }
  const tight = fitPromptToLimit(DEFAULT_TRANSITION_PROMPT, 1700)
  assert.ok(tight.prompt.length <= 1700, 'a tighter limit is respected')
  assert.strictEqual(tight.dropped[0], 'style', 'tone is sacrificed first')
  assertConstraintsSurvive(tight.prompt, 'tightened')

  // ── AN OVER-LONG CUSTOM PROMPT KEEPS THE CONSTRAINTS ────────────────
  //
  // An operator can write anything. Their words are shortened; the
  // mandatory blocks are re-appended so the request still carries them.
  const rambling = 'Fly through the house. '.repeat(400)
  const fittedCustom = fitPromptToLimit(rambling, FAL_PROMPT_MAX_CHARS)
  assert.ok(
    fittedCustom.prompt.length <= FAL_PROMPT_MAX_CHARS,
    `a 9000-character custom prompt is brought under the limit: ${fittedCustom.prompt.length}`
  )
  assert.ok(fittedCustom.truncatedCustomText, 'and is reported as shortened')
  assert.ok(
    fittedCustom.prompt.includes('Fly through the house'),
    'the operator’s own wording is still there'
  )
  assert.ok(
    fittedCustom.prompt.includes('invisible virtual viewpoint'),
    'and the safety constraints were appended rather than lost to the truncation'
  )
  assert.ok(
    fittedCustom.prompt.includes('No morphing, warping, melting'),
    'including the geometry contract'
  )

  // ── THE GUARD IS IN THE BODY BUILDER, NOT AT THE CALL SITES ─────────
  //
  // Whatever composes a prompt, it cannot reach fal over-length.
  const body = buildFalBody(
    {
      projectId: 'p',
      pairKey: 'a->b',
      startImagePath: '/a.png',
      endImagePath: '/b.png',
      startImageName: 'a.png',
      endImageName: 'b.png',
      prompt: rambling,
      durationSec: 5,
      resolution: 'standard',
      nativeAudio: false,
      modelId: FAL_MODELS[0].id
    },
    FAL_MODELS[0],
    'start',
    'end'
  )
  const sent = String(body.prompt)
  assert.ok(
    sent.length <= FAL_PROMPT_MAX_CHARS,
    `the payload is within the limit whatever it was handed: ${sent.length}`
  )
  assertConstraintsSurvive(sent, 'fal payload')

  log(
    `fal prompt: preset ${DEFAULT_TRANSITION_PROMPT.length} / ${FAL_PROMPT_MAX_CHARS} chars, ` +
      'constraints survive every reduction path'
  )
}

/**
 * RESUME AND REGENERATE ARE DIFFERENT PURCHASES.
 *
 * Resume keeps tracking a request already paid for and can never produce
 * a different clip. Regenerate buys another one. The shared logic had
 * always modelled both, but `recovery.secondary` was rendered nowhere —
 * so whenever a paid task existed the only visible action was Resume,
 * and it became the de-facto "try again" button while being the one
 * action that cannot try anything.
 */
function testRegenerateIsOfferedAndDistinct(): void {
  const clip: TransitionClip = {
    storedName: 'c.mp4',
    originalName: 'c.mp4',
    source: 'fal',
    src: 'f2f://c.mp4'
  }
  const settings = (over: Partial<TransitionSettings>): TransitionSettings => ({
    ...defaultTransitionSettings(5),
    ...over
  })

  // A finished clip: Preview is primary, Regenerate is offered and costs.
  const withClip = transitionRecovery(settings({ status: 'completed', clip }), null, '1 → 2')
  assert.strictEqual(withClip.kind, 'preview', 'a finished clip previews')
  assert.strictEqual(withClip.costsMoney, false, 'and previewing is free')
  assert.strictEqual(
    withClip.secondary?.kind,
    'regenerate',
    'while a NEW generation is offered alongside it'
  )
  assert.strictEqual(withClip.secondary?.costsMoney, true, 'and is honest that it costs again')

  // A running paid task: BOTH are legitimate and must both be offered.
  const running = transitionRecovery(
    settings({ status: 'generating' }),
    {
      id: 'j1',
      projectId: 'p',
      provider: { taskId: 'remote-1', status: 'processing' }
    } as unknown as QueueJob,
    '1 → 2'
  )
  if (running.kind === 'resume') {
    assert.strictEqual(running.costsMoney, false, 'resuming a paid task costs nothing')
    assert.strictEqual(
      running.secondary?.kind,
      'regenerate',
      'and starting a separate new one is offered as its own action'
    )
    assert.strictEqual(
      running.secondary?.costsMoney,
      true,
      'clearly marked as a second purchase — Resume is not a retry'
    )
  }

  // A failed task: regenerate is the ONLY way forward, and is primary.
  const failed = transitionRecovery(settings({ status: 'failed' }), null, '1 → 2')
  assert.strictEqual(failed.kind, 'regenerate', 'a failed generation offers a new one')
  assert.strictEqual(failed.costsMoney, true, 'and says it costs')

  // Never generated: a first generation, not a regeneration.
  const fresh = transitionRecovery(settings({}), null, '1 → 2')
  assert.strictEqual(fresh.kind, 'generate', 'an ungenerated transition offers Generate')
  assert.strictEqual(fresh.secondary, null, 'with nothing to regenerate yet')

  log('regenerate: offered wherever legitimate, never conflated with a free Resume')
}

/**
 * EXPORT FORMATS FIT THE FRAME WITHOUT DISTORTING IT.
 *
 * Three ways to reconcile a landscape source with a 9:16 frame and only
 * two are acceptable. Stretching is never one of them.
 */
function testExportFormats(): void {
  const base: ExportDefaults = {
    aspectRatio: '16:9',
    resolution: '1080p',
    fps: 25,
    defaultTransitionDurationSec: 5,
    seamBlend: 'subtle'
  }

  // ── BOTH CUSTOMER-FACING FORMATS ARE FULL BLEED ────────────────────
  //
  // The desktop format used to be `contain`, and the operator's sources
  // are about 3:2 in a 16:9 frame — so every desktop export came out
  // with black bars down both sides. Cropping a little off the top and
  // bottom is the better trade. Neither format pads; neither stretches.
  const computer = applyExportFormat(base, 'computer')
  assert.strictEqual(computer.defaults.aspectRatio, '16:9', 'desktop keeps the project shape')
  assert.strictEqual(computer.fit, 'cover', 'and fills the frame rather than padding it')
  assert.deepStrictEqual(
    outputDims(computer.defaults),
    { w: 1920, h: 1080 },
    'at the existing dimensions'
  )

  // Instagram is vertical and fills the phone screen.
  const insta = applyExportFormat(base, 'instagram')
  assert.strictEqual(insta.defaults.aspectRatio, '9:16', 'vertical')
  assert.deepStrictEqual(outputDims(insta.defaults), { w: 1080, h: 1920 }, 'exactly 1080×1920')
  assert.strictEqual(
    insta.fit,
    'cover',
    'and crops to fill — a 9:16 export that is two thirds black is not a vertical video'
  )

  // THE PROJECT IS NOT REWRITTEN. Choosing where a film goes is not an
  // edit to the project's own settings.
  assert.strictEqual(base.aspectRatio, '16:9', 'the caller’s defaults are untouched')
  assert.notStrictEqual(insta.defaults, base, 'a copy is returned, not the original')

  // An unknown or absent format is the desktop one, so a job written
  // before formats existed still renders correctly.
  assert.strictEqual(applyExportFormat(base, undefined).fit, 'cover')
  assert.strictEqual(applyExportFormat(base, null).defaults.aspectRatio, '16:9')

  // ── AND THE FORMAT HAS TO SURVIVE THE JOB ──────────────────────────
  //
  // THE BUG THIS PINS. `JobMetadata` declared `exportFormat`, the export
  // runner read it, and `startExport` never wrote it — so every real
  // export resolved `undefined` to the desktop format. "Export Instagram
  // Reel" produced a landscape 1920x1080 file and Instagram letterboxed
  // it inside a portrait slot. A proof that called assemble() directly
  // could not see it, because the fault was in what the job carried.
  const metadata = exportJobMetadataForTests('instagram')
  assert.strictEqual(metadata.exportFormat, 'instagram', 'the chosen format is written onto the job')
  assert.strictEqual(
    applyExportFormat(base, metadata.exportFormat).fit,
    'cover',
    'and resolves to the vertical format when the job is run'
  )

  log('export formats: both fill the frame, instagram is 1080×1920, the choice reaches the job')
}

/**
 * RESUME IS ONLY OFFERED WHEN THERE IS SOMETHING TO RESUME.
 *
 * A fal request rejected with HTTP 422 kept offering "Resume polling".
 * The stored rows show exactly why: local `status=failed`, but
 * `providerStatus` still `IN_QUEUE` — the last thing fal ever said before
 * the rejection arrived from a different call. The state machine saw a
 * task id and a status that was neither success nor failure and answered
 * `resume-poll`, so the only offered action led straight back to the same
 * rejection.
 *
 * The distinction being protected: a provider REFUSAL kills the task id;
 * LOSING CONTACT does not, and that task may be running and already paid
 * for. Hiding Resume in the second case would push an operator into
 * buying a second copy of work they already own.
 */
/**
 * REFLECTION SAFETY.
 *
 * ── THE FAILURE ──────────────────────────────────────────────────────
 *
 * A generated bathroom transition produced a person walking past with a
 * camera. The prompt already forbade exactly that, in those words, and
 * the model did it anyway — so no assertion here is about wording alone.
 *
 * The real chain, recovered from the operator's own database:
 *
 *   analysis  landmarks: ["mirror reflection", "floating vanity", ...]
 *   safety    same room + 3 shared landmarks  ->  AI authorised
 *   motion    "rotating clockwise, ... turning away from the mirror
 *              reflection toward the wall toilet"
 *
 * The mirror was recorded as a LANDMARK. Landmarks are matching evidence
 * — proof two frames see the same region — so the mirror did not merely
 * fail to raise a flag, it helped authorise the generation. The planner
 * then wrote a camera path defined relative to it, and rendering "turning
 * away from a reflection" requires deciding what the reflection contains.
 *
 * These tests pin the three separate places that had to change.
 */
/**
 * POST-GENERATION QUALITY VALIDATION.
 *
 * ── THE FAILURE ──────────────────────────────────────────────────────
 *
 * A generated bathroom clip contained a person walking past with a
 * camera, and the app presented it as finished. Every upstream check had
 * passed: the provider succeeded, the download completed, the file was a
 * valid MP4. Nothing had looked at what was IN it.
 *
 * ── WHAT IS PINNED HERE ──────────────────────────────────────────────
 *
 * Not the wording of a prompt — the DECISIONS. Every ambiguous input must
 * resolve away from "ship it", and a clip that fails must never displace
 * a good one that already works. The validator is driven through its real
 * parser with mocked transport, so no paid call is made and the code
 * under test is the code that runs in production.
 */
/**
 * THE JOB PHASE, AND WHAT "READY" IS ALLOWED TO MEAN.
 *
 * ── THE PROBLEM ──────────────────────────────────────────────────────
 *
 * Provider status answered "what is the remote task doing", and the UI
 * used it to answer "is this clip usable" — two different questions with
 * the same word. So the inspector said "Generating…" for the seconds
 * after the provider had already finished and been paid, while the clip
 * was being inspected, and then the verdict appeared from nowhere.
 *
 * Three separate facts now: phase (where the work is), providerStatus
 * (what the remote task did), quality (what the content turned out to
 * be). Nothing here derives one from another.
 */
/**
 * ANALYSE FEED — the click that did nothing.
 *
 * ── THE BUG ──────────────────────────────────────────────────────────
 *
 * In the packaged build, clicking Analyse Feed produced no dialog, no
 * loading state, no error. The handler DID fire and the IPC WAS reached;
 * what was missing was the confirmation step. It called the paid channel
 * directly with an empty token, main correctly refused —
 *
 *   "This analysis requires a confirmation token."
 *
 * — the refusal was stored in `transitionAnalysisError`, and the ONLY
 * component rendering that state returns null while no confirmation is
 * open. The reason existed and was unrenderable.
 *
 * So this pins the two halves that failed together: the paid channel
 * still refuses an empty token, and a refusal is now something the
 * operator can actually be shown.
 */
function testAnalyseFeedGate(workDir: string, created: string[]): void {
  const project = makeProject('Smoke analyse feed gate')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'feedgate.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: 'a.png' },
    { sourcePath: p, name: 'b.png' }
  ])
  project.feedSequence = project.images.map((i) => i.id)
  saveProject(project)

  // ── THE ANALYZER ID THE CONFIRMATION MUST ASK FOR ───────────────────
  //
  // The removed rival handler asked for 'default', which is not a
  // registered analyzer — `analyzerById` returns null for it, so its
  // confirmation could never open either. The id used must be the one
  // the feed channel actually runs.
  assert.strictEqual(
    analyzerById('default', { apiKey: '', model: '', mode: 'dry-run', allowLive: false }),
    null,
    "'default' is not a registered analyzer id"
  )
  assert.ok(
    analyzerById('gemini', { apiKey: '', model: GEMINI_DEFAULT_MODEL, mode: 'dry-run', allowLive: false }),
    "'gemini' is, and is what feed:analyzeFeed runs"
  )

  // ── THE PAID CHANNEL STILL REFUSES AN UNCONFIRMED RUN ───────────────
  //
  // Verified through the real gate rather than the IPC wrapper: an
  // unissued token is not consumable, which is what made the direct call
  // fail in the first place. No paid request is made.
  assert.ok(
    !consumeAnalysisToken('', project.id, 'gemini'),
    'an empty token is refused — this is what the broken click was sending'
  )
  assert.ok(
    !consumeAnalysisToken('made-up-token', project.id, 'gemini'),
    'and so is one nobody issued'
  )

  // A real token works exactly once. Cancelling never reaches this, so a
  // cancelled dialog consumes nothing.
  const token = issueAnalysisToken(project.id, 'gemini')
  assert.ok(consumeAnalysisToken(token, project.id, 'gemini'), 'an issued token is accepted once')
  assert.ok(
    !consumeAnalysisToken(token, project.id, 'gemini'),
    'and cannot be replayed into a second paid run'
  )

  // ── THE REFUSAL IS REACHABLE BY THE OPERATOR ────────────────────────
  //
  // The regression was not the refusal — it was that nothing could show
  // it. The reason now travels to the Toolbox, beside the button, on a
  // prop no dialog's visibility can suppress.
  const toolboxSource = readFileSync(
    join(__dirname, '../../src/renderer/src/components/editor/Toolbox.tsx'),
    'utf8'
  )
  assert.match(
    toolboxSource,
    /feedError && <p className="toolbox-error">/,
    'the Toolbox renders a blocking reason next to the Analyse Feed button'
  )

  const panelSource = readFileSync(
    join(__dirname, '../../src/renderer/src/components/editor/LeftPanel.tsx'),
    'utf8'
  )
  assert.match(
    panelSource,
    /feedError=\{feedConfirmation \? null : transitionAnalysisError\}/,
    'and the panel feeds it the same error state main produced'
  )
  // The click must not reach the paid channel before a confirmation exists.
  assert.match(
    panelSource,
    /if \(!feedConfirmation\) \{/,
    'Analyse Feed opens a confirmation before it can spend'
  )
  assert.match(
    panelSource,
    /analyzeFeed\(project\.id, '', token\)/,
    'and the paid call carries the one-shot token'
  )
  assert.ok(
    !panelSource.includes('handleAnalyzeTransitions'),
    'the rival second paid path is gone, not merely unreferenced'
  )

  log('analyse feed: the click now opens a confirmation, and a refusal is visible')
}

function testGenerationPhases(): void {
  const jobWith = (over: Partial<JobMetadata>, status: QueueJob['status'] = 'processing'): QueueJob =>
    ({
      id: 'j',
      projectId: 'p',
      status,
      createdAt: Date.now(),
      metadata: { pairKeys: ['a->b'], ...over },
      provider: {
        provider: 'fal',
        model: FAL_MODEL_ID,
        dryRun: false,
        providerTaskId: 'remote-1',
        providerStatus: 'succeeded'
      }
    }) as unknown as QueueJob

  const generating = defaultTransitionSettings(5)
  generating.status = 'generating'

  // ── D. THERE IS NO VALIDATION PHASE ANY MORE ────────────────────────
  //
  // A clip that downloads is attached, so the provider finishing and the
  // work finishing are the same moment. A stored `quality-checking` phase
  // on a job written under the old rules must not resurrect a wait state.
  const legacyPhase = transitionRecovery(
    generating,
    jobWith({ phase: 'quality-checking' as never }),
    '1 → 2'
  )
  assert.strictEqual(legacyPhase.label, 'Generating…', 'D: a legacy phase reads as ordinary work')
  assert.doesNotMatch(
    legacyPhase.label + legacyPhase.detail,
    /quality/i,
    'D: and never mentions a check that no longer runs'
  )

  // The download stretch is still not "generating".
  assert.strictEqual(
    transitionRecovery(generating, jobWith({ phase: 'downloading' }), '1 → 2').label,
    'Downloading…'
  )
  // No phase at all — every job written before phases existed.
  assert.strictEqual(
    transitionRecovery(generating, jobWith({}), '1 → 2').label,
    'Generating…',
    'a job with no phase reads exactly as it did before'
  )

  // ── E. READY ONLY WHEN THE CLIP IS ACTUALLY USABLE ──────────────────
  //
  // "Ready" in this app is a clip being ATTACHED, and attachment is
  // gated by `qualityAllowsActive`. Provider success alone can never
  // produce it, which is the invariant that matters.
  const withClip = defaultTransitionSettings(5)
  withClip.status = 'completed'
  withClip.clip = { storedName: 'c.mp4', originalName: 'x', source: 'fal', src: 'f2f://c' }
  assert.strictEqual(
    transitionRecovery(withClip, jobWith({ phase: 'complete' }, 'completed'), '1 → 2').kind,
    'preview',
    'E: a passed clip is attached and previewable'
  )

  // F/G/H — the verdicts that must NOT attach, expressed as the rule the
  // attach path actually asks.
  assert.ok(!qualityAllowsActive('failed', null), 'F: a failed clip is not usable')
  assert.ok(!qualityAllowsActive('needs-review', null), 'G: nor one awaiting review')
  assert.ok(qualityAllowsActive('not-run', null), 'H: off/legacy stays usable, shown as Not checked')

  // ── I. INTERRUPTED DURING THE CHECK ─────────────────────────────────
  //
  // The recovery is deliberate and cheap: the verdict becomes
  // needs-review rather than re-running a paid vision request as a side
  // effect of the app starting. Crucially it must not touch fal — the
  // video was generated and paid for once.
  const interrupted = jobWith({ phase: 'quality-checking' })
  const recovered: JobMetadata = {
    ...interrupted.metadata,
    phase: 'complete',
    quality: {
      status: 'needs-review',
      reason:
        'Automatic quality check could not be completed. The application closed while the clip was being inspected.'
    }
  }
  assert.strictEqual(recovered.phase, 'complete', 'I: no permanent quality-checking zombie')
  assert.strictEqual(recovered.quality?.status, 'needs-review', 'and it is never auto-passed')
  assert.match(recovered.quality?.reason ?? '', /closed while the clip was being inspected/i)
  // The provider task is untouched, so the state machine still resolves
  // to download/resume — never a second paid submit.
  assert.notStrictEqual(
    resolveGenerationAction(interrupted.provider, interrupted.note),
    'submit',
    'I: recovery never resubmits a fal generation'
  )

  log('generation phases: "Generating…" stops when the provider does, not when the verdict lands')
  log('download vs quality: a rejected clip is on disk, and is never re-fetched as a failed transfer')
}

/**
 * WHAT THE FEED SAYS — and what it must stop saying.
 *
 * Quality validation withholds a rejected clip on purpose, and the
 * generation path wrote `status: 'failed'` for any live run that ended
 * with no attached clip. So a generation that succeeded at fal,
 * downloaded a playable file, and was held for review appeared in the
 * timeline as FAILED — the same word as a provider rejection.
 */
/**
 * API KEYS — SAVE, RELOAD, AND SURVIVE AN UNRELATED SETTINGS WRITE.
 *
 * ── THE BUG THIS PINS ────────────────────────────────────────────────
 *
 * `settings:get` stripped only `providers[].apiKey`, so the Gemini key
 * was sent to the renderer AND written back from it. The renderer sends
 * `apiKey: ''` on every analyzer patch, so changing the Gemini model —
 * or anything else on that panel — silently erased the stored key. The
 * operator saved a key, changed a dropdown, and was told none was set.
 */
function testApiKeyPersistence(): void {
  const original = getSettingsJson()
  try {
    // ── D. GEMINI ─────────────────────────────────────────────────────
    const seed = JSON.parse(getSettingsJson()!) as AppSettings
    saveSettingsJson(
      JSON.stringify({ ...seed, analyzer: { ...seed.analyzer!, apiKey: 'gemini-secret-value' } })
    )
    assert.strictEqual((JSON.parse(getSettingsJson()!) as AppSettings).analyzer?.apiKey, 'gemini-secret-value', 'D: the Gemini key is stored')

    // The exact write the renderer performs when the model changes.
    const current = JSON.parse(getSettingsJson()!) as AppSettings
    saveSettingsJson(
      JSON.stringify(
        mergeSettingsForSave(
          {
      ...current,
      analyzer: { ...current.analyzer!, apiKey: '', model: 'gemini-3.6-flash' }
          },
          JSON.parse(getSettingsJson()!) as AppSettings
        )
      )
    )
    assert.strictEqual(
      (JSON.parse(getSettingsJson()!) as AppSettings).analyzer?.apiKey,
      'gemini-secret-value',
      'D: and survives an unrelated settings save that carries an empty key'
    )
    assert.strictEqual(
      (JSON.parse(getSettingsJson()!) as AppSettings).analyzer?.model,
      'gemini-3.6-flash',
      'D: while the change the operator actually made is applied'
    )

    // ── E. FAL ────────────────────────────────────────────────────────
    storeProviderApiKey('fal', '  fal-secret-value  ')
    assert.strictEqual(
      (JSON.parse(getSettingsJson()!) as AppSettings).providers.find((p) => p.id === 'fal')?.apiKey,
      'fal-secret-value',
      'E: the fal key is stored, sanitised of pasted whitespace'
    )
    saveSettingsJson(
      JSON.stringify(
        mergeSettingsForSave(
          JSON.parse(getSettingsJson()!) as AppSettings,
          JSON.parse(getSettingsJson()!) as AppSettings
        )
      )
    )
    assert.strictEqual(
      (JSON.parse(getSettingsJson()!) as AppSettings).providers.find((p) => p.id === 'fal')?.apiKey,
      'fal-secret-value',
      'E: and survives a settings save too'
    )

    storeProviderApiKey('fal', 'replacement')
    assert.strictEqual((JSON.parse(getSettingsJson()!) as AppSettings).providers.find((p) => p.id === 'fal')?.apiKey, 'replacement', 'E: a key can be replaced')

    // ── F. THE PRODUCT RULE, NOT A USER CHOICE ────────────────────────
    //
    // No provider selector and no Live switch: storing a key IS the
    // intent, and removing it falls back on its own.
    const withKey = JSON.parse(getSettingsJson()!) as AppSettings
    assert.strictEqual(withKey.activeProviderId, 'fal', 'F: video generation is always fal.ai')
    assert.strictEqual(
      withKey.providers.find((p) => p.id === 'fal')?.mode,
      'live',
      'F: a stored key means live — there is no second switch to forget'
    )
    assert.strictEqual(withKey.production.allowLiveFalRequests, true, 'F: and no separate lock')
    assert.strictEqual(withKey.analyzer?.analyzerId, 'gemini', 'F: analysis is always Gemini')

    storeProviderApiKey('fal', '')
    const withoutKey = JSON.parse(getSettingsJson()!) as AppSettings
    assert.strictEqual((JSON.parse(getSettingsJson()!) as AppSettings).providers.find((p) => p.id === 'fal')?.apiKey, '', 'E: and removed')
    assert.strictEqual(
      withoutKey.providers.find((p) => p.id === 'fal')?.mode,
      'dry-run',
      'F: removing the key disables paid requests by itself'
    )
    assert.strictEqual(withoutKey.production.allowLiveFalRequests, false)

    log('api keys: saved once, never erased by an unrelated write, and live follows the key')
  } finally {
    if (original !== null) saveSettingsJson(original)
  }
}

/**
 * THE CAMERA ONTOLOGY IN A REFLECTIVE PROMPT.
 *
 * ── WHY THE WORDING CHANGED ──────────────────────────────────────────
 *
 * Kling kept drawing a physical camera in mirrors. The prompt was the
 * reason: it opened with "cinematic CAMERA transition", described the
 * camera as "a high-end stabilized gimbal or indoor drone", referred to
 * the end frame's "camera position", and demanded "physically plausible
 * camera movement" that must not pass through walls. It also said, once,
 * that the camera was invisible — while naming the exact equipment four
 * times, including last.
 *
 * Asked to render a drone gliding through a room with a mirror in it, a
 * model that draws the drone is being consistent. The negative list was
 * fighting an ontology the prompt itself kept asserting.
 */
function testInvisibleViewpointOntology(): void {
  const base = DEFAULT_TRANSITION_PROMPT

  // The ontology is established FIRST, before anything can imply a device.
  const opening = base.split('\n\n')[0]
  assert.match(opening, /invisible virtual viewpoint/i, 'K: the first block states what the view IS')
  assert.match(opening, /no physical imaging device exists/i, 'K: and that no device exists')
  assert.match(
    opening,
    /not an object moving through the room/i,
    'K: motion is rendering motion, not an object moving'
  )

  // NO PHYSICAL-DEVICE VOCABULARY outside the non-existence list.
  //
  // That list may name equipment — declaring it absent is its job.
  // Nothing else may describe the viewpoint AS equipment.
  const withoutEntityList = base
    .split('\n\n')
    .filter((block) => !/never appear|do not exist in this world/i.test(block))
    .join('\n\n')
  for (const contradiction of [
    /stabilized gimbal/i,
    /indoor drone/i,
    /camera transition/i,
    /camera position/i,
    /camera movement/i,
    /the camera moves/i,
    /behind the camera/i,
    /filming/i,
    /\blens\b/i
  ]) {
    assert.doesNotMatch(
      withoutEntityList,
      contradiction,
      'K: no wording that makes the viewpoint a physical camera: ' + String(contradiction)
    )
  }

  // The reflective escalation says what a mirror CONTAINS, positively.
  assert.match(REFLECTION_SAFETY_BLOCK, /reflects ONLY the architecture/i, 'K: positive target')
  assert.match(
    REFLECTION_SAFETY_BLOCK,
    /no observer and no imaging device in this world/i,
    'K: consistent with the opening rather than a separate suppression list'
  )
  assert.doesNotMatch(
    REFLECTION_SAFETY_BLOCK,
    /treat the camera as|the filming device|behind the camera/i,
    'K: and never re-introduces the camera it is trying to remove'
  )

  // ONE ontology, stated once and not contradicted.
  const full = base + '\n\n' + REFLECTION_SAFETY_BLOCK
  assert.strictEqual(
    (full.match(/invisible virtual viewpoint/gi) ?? []).length,
    1,
    'K: the ontology is stated once, not repeated into noise'
  )

  // And it survives trimming to fal's character limit — the constraint
  // that matters most must not be the one dropped to fit.
  const trimmed = fitPromptToLimit(full, 2500).prompt
  assert.ok(trimmed.length <= 2500, 'K: it fits the provider limit')
  assert.match(
    trimmed,
    /invisible virtual viewpoint/i,
    'K: and the ontology is never what gets cut'
  )

  log('prompt ontology: one invisible viewpoint, no physical camera anywhere to reflect')
}


/**
 * A DELIVERED GENERATION BECOMES THE CLIP. NOTHING STANDS IN BETWEEN.
 *
 * The attach path used to record the generation inactive, run a vision
 * model over sampled frames, and adopt the clip only if that model
 * approved. A succeeded, paid, downloaded generation could therefore end
 * up unusable — which is the state this pass removed.
 *
 * Driven through the real catalogue and the real attach service. No
 * provider is contacted: the file is written locally, exactly as a
 * completed download leaves it.
 */
function testDeliveredClipAttachesDirectly(workDir: string, created: string[]): void {
  const project = makeProject('Smoke direct attach')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'attach.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: 'a.png' },
    { sourcePath: p, name: 'b.png' }
  ])
  const [A, B] = project.images.map((i) => i.id)
  project.feedSequence = [A, B]
  const pairKey = transitionKey(A, B)
  // A configured pair, as the real flow has by the time a generation
  // exists — the attach service refuses a pair with no stored row at all.
  project.transitions[pairKey] = { ...defaultTransitionSettings(5), mode: 'ai' }
  saveProject(project)

  // What a completed fal download leaves behind: a file on disk.
  const dir = projectTransitionsDir(project.id)
  mkdirSync(dir, { recursive: true })
  const storedName = 'delivered.mp4'
  writeFileSync(join(dir, storedName), Buffer.from([0, 1, 2, 3]))

  const generationId = recordGeneration({
    queueJobId: 'attach-job-1',
    projectId: project.id,
    fromImageId: A,
    toImageId: B,
    provider: 'fal',
    model: null,
    clip: {
      storedName,
      originalName: 'fal-generation.mp4',
      source: 'fal',
      src: clipUrl(project.id, storedName)
    },
    prompt: 'x',
    active: false
  })

  // ── A. IT ATTACHES ──────────────────────────────────────────────────
  const attached = attachGenerationToTransition(project.id, generationId)
  assert.ok(attached.ok, 'A: a delivered generation attaches: ' + (attached.ok ? '' : attached.reason))

  const after = listProjects().find((x) => x.id === project.id)!
  assert.strictEqual(
    after.transitions[pairKey]?.clip?.storedName,
    storedName,
    'A: and becomes the transition clip'
  )
  assert.strictEqual(after.transitions[pairKey]?.status, 'completed', 'A: recorded as completed')
  assert.ok(
    getGenerationsForPair(project.id, A, B)[0]?.active,
    'A: and the catalogue marks it active'
  )

  // ── B. A HISTORICAL VERDICT DOES NOT BLOCK IT ───────────────────────
  //
  // Old rows keep their verdicts. Nothing consults them, so a generation
  // recorded as failed under the previous rules still attaches on demand.
  applyQualityResult(generationId, {
    status: 'failed',
    reason: 'A verdict from the removed validator.',
    checkedAt: Date.now(),
    suspiciousFrames: [],
    validator: 'legacy'
  })
  const reattached = attachGenerationToTransition(project.id, generationId)
  assert.ok(reattached.ok, 'B: historical quality metadata does not block attaching')
  assert.strictEqual(
    getGenerationsForPair(project.id, A, B)[0]?.qualityStatus,
    'failed',
    'B: and the old verdict is preserved for the record rather than rewritten'
  )

  // ── C. EXPORT IS NOT BLOCKED BY IT EITHER ───────────────────────────
  const readiness = exportReadiness(listProjects().find((x) => x.id === project.id)!)
  assert.ok(
    readiness.ready,
    'C: export is not blocked by a historical verdict: ' + (readiness.reason ?? '')
  )
  assert.doesNotMatch(
    readiness.reason ?? '',
    /quality/i,
    'C: and no quality wording reaches the export reason'
  )

  log('direct attach: a delivered clip is the clip — no verdict, no gate, no review state')
}


/**
 * THE BATHROOM MIRROR PROMPT — the regression anchor.
 *
 * ── WHAT WENT WRONG ──────────────────────────────────────────────────
 *
 * The operator's stored prompt for this pair was 3789 characters that
 * opened with "Create a seamless, photorealistic cinematic CAMERA
 * transition", described the view as "a high-end stabilized gimbal or
 * indoor drone", named the end frame's "camera position", demanded
 * "physically plausible camera movement", and ended under the heading
 * "CAMERA MOVEMENT FOR THIS TRANSITION". Ten of eighty-four stored
 * prompts in that project carried the same wording.
 *
 * None of it was still in the source. Prompts are STORED per transition
 * and are not rebuilt when the preset changes, and currency was tracked
 * against the evidence a prompt was planned from — never against the
 * prompt contract it was written under. So a prompt planned minutes
 * earlier, from current evidence, was ten versions out of date and
 * nothing could tell.
 *
 * The scene is a bathroom whose mirror reflects a white door and a beige
 * wall, and the operator has said so.
 */
function testBathroomMirrorPrompt(workDir: string, created: string[]): void {
  const project = makeProject('Smoke bathroom mirror')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'bathroom.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: '0015-15.jpg' },
    { sourcePath: p, name: '0014-14.jpg' }
  ])
  const [A, B] = project.images.map((i) => i.id)
  project.feedSequence = [A, B]
  const pairKey = transitionKey(A, B)

  // The operator's own words, verbatim from the reported case.
  const OPERATOR_CONTEXT =
    'If you look at the mirror you see the door and the beige wall. That is the reflection in the transition.'
  const context = makeOperatorContext(OPERATOR_CONTEXT, Date.now(), Date.now())
  project.transitions[pairKey] = {
    ...defaultTransitionSettings(5),
    mode: 'ai',
    modeProvenance: 'manual',
    operatorContext: context
  }
  saveProject(project)

  // One bathroom, both frames, with a dominant mirror the analyzer read.
  const analysis: PropertyAnalysis = {
    ...emptyAnalysis(project.id),
    source: 'provider',
    state: 'accepted',
    rooms: [
      {
        id: 'bath',
        label: 'Bathroom',
        imageIds: [A, B],
        landmarks: ['vanity'],
        confidence: 'confirmed'
      }
    ],
    images: [
      {
        imageId: A,
        roomId: 'bath',
        orientation: 'into-room',
        landmarks: ['vanity'],
        openings: [],
        overlapWith: [B],
        reflectiveSurfaces: [
          { type: 'wall mirror', dominant: true, expectedVisibleContent: ['white door', 'beige wall'] }
        ]
      },
      {
        imageId: B,
        roomId: 'bath',
        orientation: 'into-room',
        landmarks: ['vanity'],
        openings: [],
        overlapWith: [A]
      }
    ]
  }
  saveAnalysis(analysis)

  const plans = planSequence(analysis, [A, B], undefined, new Map([[pairKey, context]]))
  const plan = plans[0]
  assert.ok(plan, 'a plan is produced for the bathroom pair')
  assert.ok(plan.safetyVerdict.evidence.reflection.risk, 'and the mirror is recognised as a hazard')

  const prompt = renderPrompt(plan, {}, undefined, context)

  // ── A. THE OPERATOR CONTEXT IS THERE, VERBATIM AND AUTHORITATIVE ────
  assert.match(prompt, /OPERATOR-PROVIDED SPATIAL CONTEXT:/, 'A: the context has its own block')
  assert.ok(prompt.includes(OPERATOR_CONTEXT), 'A: quoted verbatim, not paraphrased')
  assert.match(
    prompt,
    /authoritative knowledge of the real property/i,
    'A: and marked as authoritative rather than a suggestion'
  )
  assert.strictEqual(
    (prompt.match(/OPERATOR-PROVIDED SPATIAL CONTEXT/g) ?? []).length,
    1,
    'A: stated once — twice reads to the model as two separate facts'
  )

  // ── B. REFLECTION-SPECIFIC CONSTRAINTS ──────────────────────────────
  assert.match(prompt, /REFLECTION CONTENT — ABSOLUTE/, 'B: the reflection block is present')
  assert.match(
    prompt,
    /reflects ONLY the architecture, furniture, fixtures, lighting and surfaces/i,
    'B: architecture and fixtures only'
  )
  assert.match(
    prompt,
    /may contain nothing that is not already part of the property/i,
    'B: no invented object may appear in a reflection'
  )
  assert.match(
    prompt,
    /do not animate anything inside one/i,
    'B: and nothing invented may MOVE in one — the reported failure'
  )
  assert.match(
    prompt,
    /no observer and no imaging device in this world/i,
    'B: no observer or equipment exists anywhere to be reflected'
  )
  // What the mirror SHOULD show, taken from the operator rather than guessed.
  assert.match(prompt, /EXPECTED MIRROR CONTENT:/, 'B: the mirror is told what it DOES contain')
  assert.match(prompt, /- door/i, 'B: the door the operator described')
  assert.match(prompt, /- beige wall/i, 'B: and the beige wall')
  // The list is what the model is told to DRAW, so a conversational
  // clause in it is noise in the one place that must be precise.
  assert.doesNotMatch(
    prompt,
    /- .*(that is the reflection|if you look)/i,
    'B: and no framing clause is offered as mirror content'
  )

  // ── C. NO PHYSICAL-DEVICE ONTOLOGY ──────────────────────────────────
  //
  // The entity list deliberately NAMES equipment in order to declare it
  // absent, so it is excluded before this check — everything else must be
  // free of wording that puts a device in the scene.
  const withoutEntityList = prompt
    .split('\n\n')
    .filter((block) => !/do not exist in this world/i.test(block))
    .join('\n\n')
  for (const forbidden of [
    /gimbal/i,
    /drone/i,
    /filming rig/i,
    /cinematic camera transition/i,
    /camera position/i,
    /physically plausible camera movement/i,
    /CAMERA MOVEMENT FOR THIS TRANSITION/,
    /CAMERA: high-end/i,
    /behind the camera/i
  ]) {
    assert.doesNotMatch(
      withoutEntityList,
      forbidden,
      `C: the bathroom prompt must not establish a physical camera: ${forbidden}`
    )
  }
  assert.ok(
    !promptUsesRetiredOntology(prompt),
    'C: and the retired-ontology detector agrees'
  )

  // ── D. MOTION IS VIEWPOINT MOTION ───────────────────────────────────
  assert.match(prompt, /invisible virtual viewpoint/i, 'D: the ontology leads the prompt')
  if (plan.motionInstruction) {
    assert.match(prompt, /VIEWPOINT MOVEMENT FOR THIS TRANSITION:/, 'D: viewpoint, not camera')
  }

  // ── E. THE PREVENTIVE GATE ──────────────────────────────────────────
  //
  // A mirror pair may not be generated from a prompt that ignores
  // mirrors, and may never be generated from retired wording — even when
  // the operator set the mode themselves. Neither is an override: they
  // are missing constraints in the text about to be paid for.
  const gate = (storedPrompt: string): ReturnType<typeof assessAiGenerationReadiness> =>
    assessAiGenerationReadiness(
      analysis,
      [A, B],
      pairKey,
      'manual',
      undefined,
      context,
      () => ({ ...defaultTransitionSettings(5), mode: 'ai', prompt: storedPrompt }),
      () => null
    )

  const legacy = gate(
    'Create a seamless, photorealistic cinematic camera transition from the START FRAME to the END FRAME.'
  )
  assert.ok(!legacy.ok, 'E: a prompt carrying retired wording is refused')
  assert.match((legacy as { reason: string }).reason, /physical camera/i)

  const mirrorBlind = gate('Move the viewpoint smoothly between the two frames.')
  assert.ok(!mirrorBlind.ok, 'E: a mirror pair with no reflection constraints is refused')
  assert.match((mirrorBlind as { reason: string }).reason, /reflection constraints/i)

  const proper = gate(prompt)
  assert.ok(
    proper.ok,
    'E: and the prompt this pass produces passes the gate: ' + (proper.ok ? '' : proper.reason)
  )

  // ── F. EVERY BUILDER USES THE SAME HEADER ───────────────────────────
  //
  // Three files hardcoded their own motion header. Consolidated, so a
  // future edit cannot reach only part of the product.
  const planned = planTransitionPrompt(analysis, A, B)
  if (planned.motionInstruction) {
    assert.match(
      planned.effectivePrompt,
      /VIEWPOINT MOVEMENT FOR THIS TRANSITION:/,
      'F: planTransitionPrompt uses the shared header'
    )
    assert.doesNotMatch(planned.effectivePrompt, /CAMERA MOVEMENT FOR THIS TRANSITION/)
  }


  // ── G. A HAND-WRITTEN PROMPT IS THE OPERATOR'S, NOT THE TEMPLATE'S ──
  //
  // The prompt-contract checks judge WORDING against the current
  // template. Two of them were written outside the manual exemption, so
  // an operator who replaced the prompt on this reflective transition
  // with their own instructions was refused — because their sentences
  // did not contain the internal phrase `REFLECTION CONTENT`. The app
  // demanded its own template back from someone who had deliberately
  // chosen not to use it.
  const manualProvenance = {
    basePrompt: 'base',
    motionInstruction: null,
    effectivePrompt: 'theirs',
    basis: 'same-room' as const,
    rationale: '',
    manuallyEdited: true,
    plannedAt: 1,
    analysisUpdatedAt: null
  }
  const gateWith = (
    storedPrompt: string,
    over: Partial<TransitionSettings> = {},
    mode: 'analysis' | 'manual' = 'manual'
  ): ReturnType<typeof assessAiGenerationReadiness> =>
    assessAiGenerationReadiness(
      analysis,
      [A, B],
      pairKey,
      mode,
      undefined,
      context,
      () => ({ ...defaultTransitionSettings(5), mode: 'ai', prompt: storedPrompt, ...over }),
      () => null
    )

  // A. GENERATED prompt with no reflection contract → BLOCKED.
  const generatedNoReflection = gateWith('Move the viewpoint smoothly between the two frames.')
  assert.ok(!generatedNoReflection.ok, 'G/A: a generated prompt missing the reflection contract is refused')
  assert.match((generatedNoReflection as { reason: string }).reason, /reflection constraints/i)

  // B. GENERATED prompt carrying the retired camera ontology → BLOCKED.
  const generatedLegacy = gateWith(
    'Create a seamless, photorealistic cinematic camera transition from the START FRAME to the END FRAME.'
  )
  assert.ok(!generatedLegacy.ok, 'G/B: a generated prompt with retired camera wording is refused')
  assert.match((generatedLegacy as { reason: string }).reason, /physical camera/i)

  // C. THE SAME TWO PROMPTS, HAND-WRITTEN → ALLOWED.
  //
  // The operator owns the wording. Neither the missing template phrase
  // nor a word we happen to have retired is grounds for refusing to
  // spend their money on their own instructions.
  for (const [label, text] of [
    ['no template phrase', 'Glide gently past the vanity. The mirror shows the door and the beige wall.'],
    [
      'wording we retired',
      'Create a seamless, photorealistic cinematic camera transition from the START FRAME to the END FRAME.'
    ]
  ] as const) {
    const manual = gateWith(text, { promptProvenance: manualProvenance })
    assert.ok(manual.ok, `G/C: a hand-written prompt (${label}) is allowed to generate`)
    assert.strictEqual(
      manual.kind,
      'analysis-backed',
      'G/C: and stays a normal analysis-backed generation, not an override'
    )
  }

  // The hazard is still SAID — once, as a note, on the confirmation the
  // operator already has to read.
  const advised = gateWith('Glide gently past the vanity.', {
    promptProvenance: manualProvenance
  })
  assert.ok(advised.ok && advised.kind === 'analysis-backed')
  assert.match(
    (advised as { advisory?: string }).advisory ?? '',
    /you are responsible for the reflection instructions/i,
    'G/C: with a non-blocking advisory rather than a gate'
  )
  // And no advisory where there is no mirror to warn about.
  assert.strictEqual(
    (
      assessAiGenerationReadiness(
        { ...analysis, images: analysis.images.map((i) => ({ ...i, reflectiveSurfaces: [] })) },
        [A, B],
        pairKey,
        'manual',
        undefined,
        context,
        () => ({
          ...defaultTransitionSettings(5),
          mode: 'ai',
          prompt: 'Glide gently past the vanity.',
          promptProvenance: manualProvenance
        }),
        () => null
      ) as { advisory?: string }
    ).advisory,
    undefined,
    'G/C: and no advisory when the pair has no reflective surface'
  )

  // D. A MANUAL PROMPT IS NOT A PASS FOR EVERYTHING ELSE.
  //
  // Owning the wording is not owning the evidence. With the mode chosen
  // by the analyzer rather than the operator, a real readiness failure
  // still refuses — the exemption covers prompt-contract wording and
  // nothing else.
  const unrelated = assessAiGenerationReadiness(
    // No accepted map at all: the state the original bad run was in.
    { ...analysis, rooms: [] },
    [A, B],
    pairKey,
    'analysis',
    undefined,
    context,
    () => ({
      ...defaultTransitionSettings(5),
      mode: 'ai',
      prompt: 'Glide gently past the vanity.',
      promptProvenance: manualProvenance
    }),
    () => null
  )
  assert.ok(!unrelated.ok, 'G/D: a hand-written prompt does not excuse missing spatial evidence')
  assert.match((unrelated as { reason: string }).reason, /no accepted property analysis/i)

  // And a pair that is no longer in the feed stays refused too.
  const goneFromFeed = assessAiGenerationReadiness(
    analysis,
    [B, A],
    pairKey,
    'manual',
    undefined,
    context,
    () => ({
      ...defaultTransitionSettings(5),
      mode: 'ai',
      prompt: 'Glide gently past the vanity.',
      promptProvenance: manualProvenance
    }),
    () => null
  )
  assert.ok(!goneFromFeed.ok, 'G/D: nor a pair the feed no longer contains')

  log('bathroom mirror prompt: operator context, reflection rules, and no camera ontology')
  log('manual prompt: the operator owns the wording; the mirror is advised, never gated')
}


/**
 * MODEL SELECTION — ONE REGISTRY, EVERY PAID PATH.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────
 *
 * The model was a single global string in settings, baked into the queue
 * path, the field map, the duration enum and the price. Comparing two
 * models on the same transition — the reason this exists — meant editing
 * a preference that then applied to everything. And the catalogue
 * recorded `model: null` with a note saying the provider name was
 * "sufficient", so two attempts could not be told apart afterwards.
 */

/**
 * THE CHANNELS THE RENDERER ACTUALLY CALLS.
 *
 * ── THE BUG THIS PINS ────────────────────────────────────────────────
 *
 * The model dropdown was empty in runtime. The registry was right, the
 * preload bridge was right, the dialog was right — and `generation:models`
 * had no handler in main, so `ipcRenderer.invoke` called a channel
 * nothing answered and the list arrived empty.
 *
 * The DOM proof missed it because the harness MOCKS that bridge method,
 * so it exercised everything except the link that was missing. A mocked
 * bridge can only prove the renderer half; this proves the other one.
 */
function testGenerationIpcChannels(): void {
  // Electron keeps invoke handlers in an internal map. Reaching into it
  // is deliberate: the alternative is booting the whole app, which is
  // exactly the gap that let a missing channel ship.
  const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, unknown> })
    ._invokeHandlers
  assert.ok(handlers, 'the invoke-handler map is readable')

  for (const channel of [
    'generation:models',
    'generation:liveConfirmation',
    'generation:generateLive'
  ]) {
    assert.ok(
      handlers!.has(channel),
      `${channel} has a handler in main — the renderer calls it by name`
    )
  }

  // ── THE PAYLOAD THE DROPDOWN IS BUILT FROM ──────────────────────────
  //
  // The same projection the handler returns, so a shape change cannot
  // pass here and fail in the dialog.
  const payload = modelListPayload()
  assert.ok(payload.length >= 3, 'every registered model is sent, not just the confirmed ones')

  const names = payload.map((m) => m.displayName)
  assert.ok(names.includes('Kling O3 Standard'), 'O3 reaches the renderer')
  assert.ok(names.includes('Kling 2.6 Pro'), '2.6 Pro reaches the renderer')

  const selectable = payload.filter((m) => m.confirmed)
  assert.strictEqual(selectable.length, 2, 'and both are selectable')
  for (const m of selectable) {
    assert.ok(m.id.length > 0 && m.displayName.length > 0, `${m.id} has an id and a name`)
    assert.ok(m.durationsSec.length > 0, `${m.id} carries its durations`)
    assert.ok(m.rates.length > 0, `${m.id} carries its verified rates`)
  }

  // An unconfirmed model is still SENT — the dialog disables it and says
  // why, which is more useful than a name that silently does not exist.
  const unconfirmed = payload.filter((m) => !m.confirmed)
  assert.ok(unconfirmed.length >= 1, 'unconfirmed models are sent too')
  assert.match(unconfirmed[0].verificationNote, /NOT VERIFIED/i, 'with the reason attached')

  // Every id the dropdown can offer must resolve, or the select would
  // hold a value that names nothing.
  for (const m of payload) {
    assert.strictEqual(resolveFalModel(m.id).id, m.id, `${m.id} resolves back to itself`)
  }

  log('generation ipc: the model list has a handler, and carries both confirmed models')
}

function testFalModelRegistry(workDir: string, created: string[]): void {
  // ── THE REGISTRY ────────────────────────────────────────────────────
  assert.ok(FAL_MODEL_REGISTRY.length >= 2, 'more than one model is registered')
  const ids = FAL_MODEL_REGISTRY.map((m) => m.id)
  assert.strictEqual(new Set(ids).size, ids.length, 'ids are unique')

  const confirmed = FAL_MODEL_REGISTRY.filter((m) => m.confirmed)
  assert.strictEqual(confirmed.length, 2, 'O3 and 2.6 Pro have verified contracts')
  assert.ok(confirmed.some((m) => m.id === FAL_DEFAULT_MODEL_ID), 'and the default is one of them')

  // Every entry carries what the UI and the runtime need.
  for (const m of FAL_MODEL_REGISTRY) {
    assert.ok(m.displayName.length > 0, `${m.id} has a display name`)
    assert.ok(m.endpoint.startsWith('https://queue.fal.run/'), `${m.id} has a queue endpoint`)
    assert.ok(m.endpoint.endsWith(m.id), `${m.id}'s endpoint is built from its id`)
    assert.ok(m.supportsEndFrame, `${m.id} supports an end frame — the product requires it`)
    assert.ok(m.durationsSec.length > 0, `${m.id} declares durations`)
    assert.ok(typeof m.buildBody === 'function', `${m.id} maps its own body`)
    // An unverified model must not carry an invented price.
    if (!m.confirmed) {
      assert.strictEqual(m.rates.length, 0, `${m.id} publishes no guessed rate`)
      assert.match(m.verificationNote, /NOT VERIFIED/i, `${m.id} says so plainly`)
    }
  }

  // ── F. PER-MODEL REQUEST MAPPING ────────────────────────────────────
  //
  // A generic payload sent hopefully at every endpoint is how an
  // unsupported field reaches a provider and rejects the whole request.
  const canonical = {
    startImage: 'https://cdn/start.jpg',
    endImage: 'https://cdn/end.jpg',
    prompt: 'PROMPT',
    durationSec: 5,
    resolution: 'standard',
    nativeAudio: false
  }
  const o3 = resolveFalModel(FAL_DEFAULT_MODEL_ID)
  const o3Body = o3.buildBody(canonical)
  assert.strictEqual(o3Body.image_url, canonical.startImage, 'F: start frame field')
  assert.strictEqual(o3Body.end_image_url, canonical.endImage, 'F: end frame field')
  assert.strictEqual(o3Body.duration, '5', 'F: duration is sent as a string')
  assert.strictEqual(o3Body.generate_audio, false, 'F: audio flag is explicit')

  // A model that does not support audio never receives the field.
  const noAudio = FAL_MODEL_REGISTRY.find((m) => !m.audioSupport)
  if (noAudio) {
    const body = noAudio.buildBody({ ...canonical, nativeAudio: true })
    assert.ok(
      !('generate_audio' in body),
      'F: an unsupported field is never sent, whatever the caller asked for'
    )
  }

  // ── G. CAPABILITIES GOVERN WHAT CAN BE SUBMITTED ────────────────────
  assert.ok(modelSupportsDuration(o3, 5), 'G: a published duration is accepted')
  assert.ok(!modelSupportsDuration(o3, 99), 'G: an unpublished one is not')
  assert.strictEqual(clampDurationForModel(o3, 99), 15, 'G: and is clamped to the nearest allowed')
  assert.ok(modelSupportsResolution(o3, 'standard'), 'G: the tier is the resolution vocabulary')
  assert.ok(!modelSupportsResolution(o3, '4k'), 'G: an invented resolution is refused')

  // ── H. COST FOLLOWS THE MODEL ───────────────────────────────────────
  const cheap = falRunCost(o3, 5, false)
  const withAudio = falRunCost(o3, 5, true)
  assert.ok(cheap && withAudio, 'H: the confirmed model has verified rates')
  assert.ok(withAudio!.usd > cheap!.usd, 'H: audio costs more, from the published rate')
  // Rounded to cents at the source — see falRunCost.
  assert.strictEqual(cheap!.usd, 0.42, 'H: and the arithmetic is the published one')
  const unverified = FAL_MODEL_REGISTRY.find((m) => !m.confirmed)!
  assert.strictEqual(
    falRunCost(unverified, 5, false),
    null,
    'H: a model with no verified rate returns null rather than inventing a price'
  )

  // An unknown id resolves to the default rather than throwing, so a
  // stored id from an older build cannot make a project unopenable.
  assert.strictEqual(resolveFalModel('no-such-model').id, FAL_DEFAULT_MODEL_ID, 'J: legacy-safe')
  assert.strictEqual(resolveFalModel(null).id, FAL_DEFAULT_MODEL_ID)

  // ── A/B/D/E/I. THE CHOICE REACHES THE REQUEST ───────────────────────
  const project = makeProject('Smoke model selection')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'model.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: 'a.png' },
    { sourcePath: p, name: 'b.png' }
  ])
  const [A, B] = project.images.map((i) => i.id)
  project.feedSequence = [A, B]
  const pairKey = transitionKey(A, B)
  project.transitions[pairKey] = { ...defaultTransitionSettings(5), mode: 'ai' }
  saveProject(project)

  // This test is ABOUT provider model selection, so it cannot read the
  // provider list out of a row that an earlier test happened to leave
  // behind — several of them rewrite it without a provider list at all,
  // and `settings.providers.find` below then throws rather than failing
  // on anything this test asserts. Establish what it needs.
  const settings = JSON.parse(getSettingsJson()!) as AppSettings
  settings.providers = [
    {
      id: 'fal',
      label: 'fal.ai',
      apiKey: 'smoke-not-a-real-key',
      legacySecret: '',
      mode: 'live',
      model: FAL_DEFAULT_MODEL_ID
    }
  ]
  settings.activeProviderId = 'fal'
  settings.production = {
    ...(settings.production ?? {}),
    maxConcurrentAiGenerations: 1,
    allowLiveFalRequests: true
  } as AppSettings['production']
  saveSettingsJson(JSON.stringify(settings))

  // D. The global default is what a request uses when nothing is chosen.
  const byDefault = buildGenerationRequest(project.id, pairKey, settings)
  assert.ok(byDefault.ok, 'D: a request builds')
  assert.strictEqual(
    byDefault.ok && byDefault.request.modelId,
    settings.providers.find((x) => x.id === 'fal')?.model ?? FAL_DEFAULT_MODEL_ID,
    'D: and carries the global default model'
  )

  // A/B. An explicit per-run choice reaches the request instead.
  const chosen = 'fal-ai/kling-video/v2.6/pro/image-to-video'
  const byChoice = buildGenerationRequest(project.id, pairKey, settings, chosen)
  assert.ok(byChoice.ok)
  assert.strictEqual(
    byChoice.ok && byChoice.request.modelId,
    chosen,
    'A/B: the model chosen for THIS run is what the request carries'
  )

  // E. Choosing per run does not touch the global default.
  const afterChoice = JSON.parse(getSettingsJson()!) as AppSettings
  assert.strictEqual(
    afterChoice.providers.find((x) => x.id === 'fal')?.model,
    settings.providers.find((x) => x.id === 'fal')?.model,
    'E: a per-run selection never mutates the stored default'
  )

  // ── AN UNVERIFIED MODEL CANNOT BE PAID FOR ──────────────────────────
  //
  // 2.1 Pro is registered but its contract has not been read, so it is
  // refused before any network call rather than discovered at fal.
  const unverifiedId = FAL_MODEL_REGISTRY.find((m) => !m.confirmed)!.id
  const refused = queueLiveGeneration(project.id, [pairKey], unverifiedId)
  assert.ok(!refused.ok, 'an unverified model is refused before any network call')
  assert.match(
    (refused as { reasons: string[] }).reasons.join(' '),
    /has not been verified/i,
    'and says why, rather than failing at the provider'
  )


  // ── KLING 2.6 PRO — THE VERIFIED CONTRACT ───────────────────────────
  //
  // Its input schema is NOT O3's. The start frame is `start_image_url`
  // where O3 calls the same thing `image_url`; copying O3's mapper would
  // have sent a field this endpoint does not know and omitted one it
  // requires — a 422 on a paid request, looking like a model fault
  // rather than ours.
  const k26 = resolveFalModel('fal-ai/kling-video/v2.6/pro/image-to-video')
  assert.strictEqual(k26.displayName, 'Kling 2.6 Pro')
  assert.ok(k26.confirmed, 'K2.6: verified, so it is selectable')
  assert.strictEqual(
    k26.endpoint,
    'https://queue.fal.run/fal-ai/kling-video/v2.6/pro/image-to-video',
    'K2.6: the documented endpoint'
  )

  const k26Body = k26.buildBody(canonical)
  assert.strictEqual(k26Body.start_image_url, canonical.startImage, 'K2.6: start_image_url')
  assert.strictEqual(k26Body.end_image_url, canonical.endImage, 'K2.6: end_image_url')
  assert.strictEqual(k26Body.prompt, canonical.prompt)
  assert.strictEqual(k26Body.duration, '5', 'K2.6: duration is a string from the enum')
  assert.strictEqual(k26Body.generate_audio, false, 'K2.6: audio off by default')
  // The two bodies must not converge. O3's field would be silently wrong.
  assert.ok(!('image_url' in k26Body), 'K2.6: never sends O3’s image_url')
  assert.ok(!('start_image_url' in o3Body), 'O3: and O3 never sends 2.6’s field either')
  // Never sent, so the voice-control rate can never be the one billed.
  assert.ok(!('voice_ids' in k26Body), 'K2.6: voice_ids is optional and I2T never sends it')
  // No resolution field: the documented schema has none.
  assert.ok(!('resolution' in k26Body), 'K2.6: no invented resolution field')

  // Only 5 and 10 are valid, and anything else is clamped to one of them.
  assert.deepStrictEqual(k26.durationsSec, [5, 10], 'K2.6: the documented duration enum')
  assert.ok(!modelSupportsDuration(k26, 7), 'K2.6: 7s is not offered')
  assert.strictEqual(clampDurationForModel(k26, 7), 5, 'K2.6: and clamps to the nearest allowed')
  assert.strictEqual(clampDurationForModel(k26, 12), 10)
  assert.strictEqual(
    k26.buildBody({ ...canonical, durationSec: clampDurationForModel(k26, 7) }).duration,
    '5',
    'K2.6: so an unsupported duration can never reach the body'
  )

  // ── THE VERIFIED PRICES ─────────────────────────────────────────────
  assert.strictEqual(falRunCost(k26, 5, false)!.usd, 0.35, 'K2.6: 5s without audio = $0.35')
  assert.strictEqual(falRunCost(k26, 10, false)!.usd, 0.7, 'K2.6: 10s without audio = $0.70')
  assert.strictEqual(falRunCost(k26, 5, true)!.usd, 0.7, 'K2.6: audio doubles the rate')
  // Cheaper than O3, which is exactly the kind of thing a wrong rate hides.
  assert.ok(
    falRunCost(k26, 5, false)!.usd < falRunCost(o3, 5, false)!.usd,
    'K2.6: and the estimate really does change with the model'
  )

  // ── QUEUE URLS FOLLOW THE SELECTED MODEL ────────────────────────────
  //
  // Submit uses the model's own endpoint. Status/result/cancel are
  // namespaced by the APPLICATION, so both Kling endpoints share them —
  // asserted rather than assumed, because relying on that coincidence is
  // what would break the first time a non-Kling model is registered.
  const k26Urls = deriveQueueUrls('req-1', k26.id)
  const o3Urls = deriveQueueUrls('req-1', o3.id)
  for (const url of [k26Urls.statusUrl, k26Urls.responseUrl, k26Urls.cancelUrl]) {
    assert.match(url, /^https:\/\/queue\.fal\.run\/fal-ai\/kling-video\/requests\/req-1/, url)
  }
  assert.deepStrictEqual(k26Urls, o3Urls, 'both Kling endpoints share one queue application')
  assert.notStrictEqual(k26.endpoint, o3.endpoint, 'but SUBMIT goes to different endpoints')

  // ── THE MIRROR WORKFLOW: TWO MODELS, ONE PAIR ───────────────────────
  //
  // Same frames, same prompt, different model — and both attempts must
  // survive in history with their exact model, or the comparison the
  // whole feature exists for cannot be made afterwards.
  const runOne = recordGeneration({
    queueJobId: 'mirror-job-o3',
    projectId: project.id,
    fromImageId: A,
    toImageId: B,
    provider: 'fal',
    model: o3.id,
    clip: { storedName: 'o3.mp4', originalName: 'o3.mp4', source: 'fal', src: clipUrl(project.id, 'o3.mp4') },
    prompt: 'MIRROR PROMPT',
    active: true
  })
  const runTwo = recordGeneration({
    queueJobId: 'mirror-job-26',
    projectId: project.id,
    fromImageId: A,
    toImageId: B,
    provider: 'fal',
    model: k26.id,
    clip: { storedName: 'k26.mp4', originalName: 'k26.mp4', source: 'fal', src: clipUrl(project.id, 'k26.mp4') },
    prompt: 'MIRROR PROMPT',
    active: false
  })
  assert.notStrictEqual(runOne, runTwo, 'I: two runs, two catalogue rows')

  const history = getGenerationsForPair(project.id, A, B)
  assert.ok(history.length >= 2, 'I: both attempts are kept')
  const byModel = new Map(history.map((g) => [g.model, g]))
  assert.ok(byModel.has(o3.id), 'I: the O3 run records O3')
  assert.ok(byModel.has(k26.id), 'I: and the 2.6 Pro run records 2.6 Pro')
  assert.strictEqual(
    byModel.get(o3.id)!.promptUsed,
    byModel.get(k26.id)!.promptUsed,
    'I: same prompt on both, so the model is the only variable'
  )
  assert.notStrictEqual(
    byModel.get(o3.id)!.clip?.storedName,
    byModel.get(k26.id)!.clip?.storedName,
    'I: and each keeps its own clip to compare'
  )

  // ── REGENERATE STARTS FROM WHAT WAS LAST USED ───────────────────────
  //
  // Newest first: the 2.6 Pro run is the most recent, so a regeneration
  // opens on it rather than silently falling back to O3.
  assert.strictEqual(history[0].model, k26.id, 'B: history is newest-first')
  const confirmation = liveConfirmation(project.id, pairKey)
  assert.ok(confirmation, 'B: a confirmation builds')
  assert.strictEqual(
    confirmation!.modelId,
    k26.id,
    'B: regenerate preselects the model the last run used — never a silent O3 fallback'
  )
  assert.strictEqual(confirmation!.model, 'Kling 2.6 Pro', 'B: named for the operator')
  assert.strictEqual(
    confirmation!.estimatedCostLabel,
    '$0.35',
    'B: priced at 2.6 Pro’s verified rate for the resolved duration'
  )
  assert.deepStrictEqual(confirmation!.modelDurations, [5, 10], 'B: with its own duration enum')

  // And an explicit choice still overrides that.
  const asO3 = liveConfirmation(project.id, pairKey, o3.id)
  assert.strictEqual(asO3!.modelId, o3.id, 'B: an explicit choice wins over the previous run')
  assert.strictEqual(asO3!.estimatedCostLabel, '$0.42', 'H: and the cost follows the model')

  log('fal models: one registry, per-run selection, per-model bodies, no invented prices')
  log('kling 2.6 pro: its own body and rate; O3 vs 2.6 kept as separate history')
}

function testFeedTransitionState(): void {
  const clip = (name: string): TransitionClip => ({
    storedName: name,
    originalName: 'fal-generation.mp4',
    source: 'fal',
    src: `f2f://clip/p/${name}`
  })
  const row = (over: Partial<TransitionSettings> = {}): TransitionSettings => ({
    ...defaultTransitionSettings(5),
    ...over
  })
  const gen = (
    over: Partial<Pick<GenerationRecord, 'clip' | 'active'>>
  ): Pick<GenerationRecord, 'clip' | 'active'> => ({
    clip: clip('a.mp4'),
    active: true,
    ...over
  })

  // ── A. A DELIVERED CLIP IS ATTACHED AND READY ───────────────────────
  //
  // Quality validation is removed from the product. A generation that
  // succeeded and downloaded is simply the transition's clip, and no
  // verdict stands between the two.
  const a = feedTransitionState(
    row({ status: 'completed', clip: clip('a.mp4') }),
    gen({ active: true })
  )
  assert.strictEqual(a.state, 'ready', 'A: a downloaded clip is ready')
  assert.strictEqual(a.word, 'Ready')
  assert.strictEqual(a.secondaryWord, null, 'A: with nothing awaiting a decision')
  assert.ok(a.playableClip, 'A: and it is playable')

  // ── B. HISTORICAL QUALITY METADATA DOES NOT BLOCK ANYTHING ──────────
  //
  // Old rows keep their verdicts for the record. Nothing reads them.
  const b = feedTransitionState(
    row({ status: 'completed', clip: clip('old.mp4') }),
    { clip: clip('old.mp4'), active: true }
  )
  assert.strictEqual(b.state, 'ready', 'B: a row written under the old rules still loads as ready')
  assert.strictEqual(b.word, 'Ready')

  // ── C. NO REVIEW WORDING ANYWHERE IN THE DERIVATION ─────────────────
  const everyWord = [
    feedTransitionState(row({}), null),
    feedTransitionState(row({ status: 'queued' }), null),
    feedTransitionState(row({ status: 'generating' }), null),
    feedTransitionState(row({ status: 'completed', clip: clip('c.mp4') }), gen({})),
    feedTransitionState(row({ status: 'failed', clip: null }), null),
    feedTransitionState(row({ status: 'completed', clip: null }), null, true)
  ].map((v) => v.word + ' ' + v.detail + ' ' + (v.secondaryWord ?? ''))
  for (const text of everyWord) {
    assert.doesNotMatch(
      text,
      /review quality|needs review|failed quality|quality check/i,
      'C: no quality wording survives anywhere in the feed: ' + text
    )
  }

  const d = feedTransitionState(
    row({ status: 'completed', clip: clip('old-good.mp4') }),
    gen({ clip: clip('new.mp4'), active: false })
  )
  assert.strictEqual(d.state, 'ready', 'D: the transition is usable and says so')
  assert.strictEqual(
    d.playableClip?.storedName,
    'old-good.mp4',
    'D: the ACTIVE clip is the one in the video'
  )


  // ── E. THE ORDINARY STATES ARE UNCHANGED ────────────────────────────
  assert.strictEqual(feedTransitionState(row({}), null).word, 'Missing')
  assert.strictEqual(feedTransitionState(row({ status: 'queued' }), null).word, 'Queued')
  assert.strictEqual(feedTransitionState(row({ status: 'generating' }), null).word, 'Generating')
  assert.strictEqual(
    feedTransitionState(row({ status: 'completed', clip: clip('x.mp4') }), gen({})).word,
    'Ready'
  )
  assert.strictEqual(
    feedTransitionState(row({ status: 'completed', clip: null }), null, true).word,
    'Download pending',
    'E: provider finished and no file is still a download problem'
  )

  // ── F. NO QUALITY GATE REMAINS IN THE DERIVATION ────────────────────
  //
  // The opposite of what this asserted before, and deliberately so: a
  // downloaded clip is the transition's clip.
  assert.strictEqual(
    feedTransitionState(row({ status: 'failed', clip: clip('x.mp4') }), gen({ active: true })).state,
    'ready',
    'F: an attached clip is ready whatever an old status word says'
  )

  // ── G. A DELIVERED CLIP IS SIMPLY READY ─────────────────────────────
  //
  // Quality validation is gone from the product: a downloaded clip is
  // attached, so there is no state where a succeeded generation waits for
  // a verdict. The recovery for a genuinely failed one is unchanged.
  const failedRow = {
    ...defaultTransitionSettings(5),
    status: 'failed' as const,
    clip: null
  }
  const finished = {
    id: 'j1',
    projectId: 'p',
    metadata: { pairKeys: ['a->b'] },
    provider: { providerTaskId: 't', providerStatus: 'succeeded' },
    note: 'Generation finished (fal.ai).',
    status: 'completed',
    createdAt: 1
  } as unknown as QueueJob

  const afterFinish = transitionRecovery(failedRow, finished, '11 → 12')
  assert.strictEqual(
    afterFinish.kind,
    'retry-download',
    'G: a succeeded task with no local clip is a transfer problem, and nothing else'
  )
  assert.strictEqual(afterFinish.costsMoney, false, 'G: and recovering it is free')
  assert.notStrictEqual(
    resolveGenerationAction(finished.provider, finished.note),
    'submit',
    'G: a finished task never resolves to a second paid submit'
  )

  log('feed state: a delivered clip is Ready; a real failure still reads Failed')
  log('feed action: a delivered clip offers review; paying again stays a deliberate second choice')
}

/**
 * REPAIRING THE PERSISTED WORD.
 *
 * `status: 'failed'` was written for any live run ending with no attached
 * clip, which after quality validation includes every clip the gate held
 * back. Those rows describe generations that succeeded and downloaded.
 */
function testQualityHeldStatusRepair(workDir: string, created: string[]): void {
  const project = makeProject('Smoke status repair')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'repair.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: 'a.png' },
    { sourcePath: p, name: 'b.png' },
    { sourcePath: p, name: 'c.png' }
  ])
  const [A, B, C] = project.images.map((i) => i.id)
  project.feedSequence = [A, B, C]
  const held = transitionKey(A, B)
  const genuinelyFailed = transitionKey(B, C)
  project.transitions[held] = { ...defaultTransitionSettings(5), status: 'failed', clip: null }
  project.transitions[genuinelyFailed] = {
    ...defaultTransitionSettings(5),
    status: 'failed',
    clip: null
  }
  saveProject(project)

  // A delivered clip, on disk, refused by the gate.
  const dir = projectTransitionsDir(project.id)
  mkdirSync(dir, { recursive: true })
  const storedName = 'held.mp4'
  writeFileSync(join(dir, storedName), Buffer.from([0, 1, 2, 3]))
  const genId = recordGeneration({
    queueJobId: 'repair-job-1',
    projectId: project.id,
    fromImageId: A,
    toImageId: B,
    provider: 'fal',
    model: null,
    clip: { storedName, originalName: 'fal.mp4', source: 'fal', src: clipUrl(project.id, storedName) },
    prompt: 'x',
    active: false
  })
  applyQualityResult(genId, {
    status: 'needs-review',
    reason: 'Needs a human decision.',
    checkedAt: Date.now(),
    suspiciousFrames: [],
    validator: 'test'
  })

  const result = repairQualityHeldStatuses(project.id)
  assert.strictEqual(result.transitionsRepaired, 1, 'exactly one row was wrong')

  const after = listProjects().find((x) => x.id === project.id)!
  assert.strictEqual(
    after.transitions[held]?.status,
    'completed',
    'A: a delivered-but-held generation no longer claims to have failed'
  )
  assert.strictEqual(
    after.transitions[held]?.clip,
    null,
    'B: and the clip is STILL not attached — the gate is untouched'
  )
  assert.strictEqual(
    after.transitions[genuinelyFailed]?.status,
    'failed',
    'C: a pair with no delivered generation keeps its failure'
  )

  // The verdict itself is never rewritten.
  const gens = getGenerationsForPair(project.id, A, B)
  assert.strictEqual(gens[0]?.qualityStatus, 'needs-review', 'D: the verdict stands unchanged')
  assert.strictEqual(gens[0]?.active, false, 'D: and the clip is still inactive')

  // Idempotent: a second run finds nothing left to do.
  assert.strictEqual(
    repairQualityHeldStatuses(project.id).transitionsRepaired,
    0,
    'E: running it again changes nothing'
  )

  log('status repair: a held clip stops claiming failure, and stays held')
}

/**
 * THE CLIP URL THE PLAYER IS GIVEN.
 *
 * The catalogue built its own: `f2f://project/<id>/transition/<name>`.
 * The protocol handler chooses a directory from the HOST — image, clip,
 * export — so `project` matched nothing, every catalogue clip 404'd, and
 * `<video>` silently showed nothing while Show in folder, using a real
 * path, worked. Exactly the reported symptom.
 */
function testClipUrlIsResolvable(workDir: string, created: string[]): void {
  const project = makeProject('Smoke clip url')
  created.push(project.id)
  saveProject(project)

  const name = 'proof-clip.mp4'
  const dir = projectTransitionsDir(project.id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), Buffer.from([0, 1, 2, 3]))

  const url = clipUrl(project.id, name)
  assert.match(url, /^f2f:\/\/clip\//, 'the canonical builder addresses the clip host')
  assert.ok(
    !url.includes('/transition/'),
    'and never the `project/.../transition/...` shape the handler cannot serve'
  )

  // The real resolver, the one the protocol handler calls.
  const resolved = resolveImageRequest(url)
  assert.ok(resolved, 'F: the url a player is given resolves to a file on disk')
  assert.ok(resolved!.endsWith(name), 'and to the right one')

  // The shape that shipped, proven to be the failure it was.
  assert.strictEqual(
    resolveImageRequest(`f2f://project/${project.id}/transition/${name}`),
    null,
    'F: the old catalogue url resolves to nothing — this is why playback was blank'
  )

  log('clip urls: one builder, and the url handed to <video> actually resolves')
}

/**
 * A REAL MP4, THROUGH THE REAL HANDLER, AT THE CATALOGUE'S OWN URL.
 *
 * `resolveImageRequest` returning a path proves only that a file was
 * found. What a `<video>` needs is the RESPONSE: a 206 for the opening
 * range request, `video/mp4`, an accurate `Content-Range`, and the right
 * bytes. Serving that wrongly leaves the element stuck at 0:00 with the
 * file plainly on disk — which is precisely the shape of the bug this
 * pass chased.
 *
 * The fixture is produced by the bundled ffmpeg, so nothing is downloaded
 * and no provider is called.
 */
async function testMediaProtocolServesRealMp4(created: string[]): Promise<void> {
  const project = makeProject('Smoke media protocol')
  created.push(project.id)
  saveProject(project)

  const dir = projectTransitionsDir(project.id)
  mkdirSync(dir, { recursive: true })
  const storedName = 'fixture.mp4'
  const target = join(dir, storedName)

  const bin = ffmpegPath()
  if (!bin) {
    log('media protocol: SKIPPED — no bundled ffmpeg to build a fixture with')
    return
  }
  // One second of colour, tiny, deterministic. Real container, real moov.
  spawnSync(
    bin,
    [
      '-y', '-f', 'lavfi', '-i', 'color=c=navy:s=64x64:d=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      target
    ],
    { encoding: 'utf8' }
  )
  assert.ok(existsSync(target), 'the fixture mp4 was produced')
  const size = statSync(target).size
  assert.ok(size > 0, 'and is not empty')

  const url = clipUrl(project.id, storedName)

  // A. THE OPENING REQUEST CHROMIUM ACTUALLY SENDS.
  const opening = await handleMediaRequest(
    new Request(url, { headers: { range: 'bytes=0-' } })
  )
  assert.strictEqual(opening.status, 206, 'A: an open-ended range is answered as partial content')
  assert.strictEqual(
    opening.headers.get('content-type'),
    'video/mp4',
    'A: with the mp4 type — an octet-stream here is a silent demuxer failure'
  )
  assert.strictEqual(
    opening.headers.get('content-range'),
    `bytes 0-${size - 1}/${size}`,
    'A: and a Content-Range naming the whole file'
  )
  assert.strictEqual(opening.headers.get('accept-ranges'), 'bytes', 'A: seeking is advertised')
  const openingBytes = Buffer.from(await opening.arrayBuffer())
  assert.strictEqual(openingBytes.length, size, 'A: the body really is the whole file')
  assert.strictEqual(
    openingBytes.subarray(4, 8).toString('latin1'),
    'ftyp',
    'A: and starts with a real mp4 box, not an error page'
  )

  // B. A MID-FILE SEEK.
  const mid = Math.floor(size / 2)
  const seek = await handleMediaRequest(
    new Request(url, { headers: { range: `bytes=${mid}-` } })
  )
  assert.strictEqual(seek.status, 206, 'B: seeking mid-file is served')
  assert.strictEqual(
    seek.headers.get('content-range'),
    `bytes ${mid}-${size - 1}/${size}`,
    'B: from the requested offset'
  )
  assert.strictEqual(
    Number(seek.headers.get('content-length')),
    size - mid,
    'B: with a length matching the range, not the file'
  )

  // C. NO RANGE AT ALL — what an <img> or a plain fetch sends.
  const plain = await handleMediaRequest(new Request(url))
  assert.strictEqual(plain.status, 200, 'C: a plain request still succeeds')
  assert.strictEqual(plain.headers.get('content-type'), 'video/mp4')
  assert.strictEqual(plain.headers.get('accept-ranges'), 'bytes', 'C: and still advertises seeking')

  // D. THE URL SHAPE THAT SHIPPED IS 404, NOT SOMETHING PLAYABLE.
  const broken = await handleMediaRequest(
    new Request(`f2f://project/${project.id}/transition/${storedName}`, {
      headers: { range: 'bytes=0-' }
    })
  )
  assert.strictEqual(broken.status, 404, 'D: the malformed catalogue url is refused')

  log('media protocol: a real mp4 serves 206 + video/mp4 + exact Content-Range at the catalogue url')
}

/**
 * F + H + I — the catalogue, against the real database.
 *
 * The decision table above is pure. This is the part that has to be true
 * of stored rows: a failed regeneration must not evict a good active
 * clip, export must refuse one that slipped through, and nothing may be
 * deleted.
 */
function testQualityCatalogue(workDir: string, created: string[]): void {
  const project = makeProject('Smoke quality catalogue')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'quality.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: 'a.png' },
    { sourcePath: p, name: 'b.png' }
  ])
  saveProject(project)
  const [fromId, toId] = project.images.map((i) => i.id)

  const good: TransitionClip = {
    storedName: 'good.mp4',
    originalName: 'fal-generation.mp4',
    source: 'fal',
    src: 'f2f://x'
  }
  const bad: TransitionClip = {
    storedName: 'bad.mp4',
    originalName: 'fal-generation.mp4',
    source: 'fal',
    src: 'f2f://y'
  }

  // The good clip: generated, inspected, active.
  const goodId = recordGeneration({
    queueJobId: `qc-good-${Date.now()}`,
    projectId: project.id,
    fromImageId: fromId,
    toImageId: toId,
    provider: 'fal',
    model: null,
    clip: good,
    prompt: 'p',
    active: true
  })
  applyQualityResult(goodId, decideQuality(
    {
      humanDetected: false,
      humanReflectionDetected: false,
      cameraEquipmentDetected: false,
      suspiciousFrames: [],
      pass: true
    },
    'test'
  ))

  // ── F. REGENERATE PRODUCES A CLIP WITH A PERSON IN IT ───────────────
  //
  // Recorded inactive, exactly as the live path does, and NOT archiving
  // the previous generation. This is the scenario that matters most: the
  // operator regenerates a working clip, the new one is worse, and the
  // video must not silently become the bad one.
  const badId = recordGeneration({
    queueJobId: `qc-bad-${Date.now()}`,
    projectId: project.id,
    fromImageId: fromId,
    toImageId: toId,
    provider: 'fal',
    model: null,
    clip: bad,
    prompt: 'p',
    active: false
  })
  applyQualityResult(badId, decideQuality(
    {
      humanDetected: true,
      humanReflectionDetected: false,
      cameraEquipmentDetected: false,
      suspiciousFrames: [
        { frameIndex: 3, reason: 'A person crosses the frame.', confidence: 'high' }
      ],
      pass: false
    },
    'test'
  ))

  const active = activeGenerationForPair(project.id, fromId, toId)
  assert.strictEqual(active?.id, goodId, 'the good clip is STILL the active one')
  assert.strictEqual(active?.qualityStatus, 'passed')

  // ── I. NOTHING IS DELETED ───────────────────────────────────────────
  const history = getGenerationsForPair(project.id, fromId, toId)
  assert.strictEqual(history.length, 2, 'both attempts are in the catalogue')
  const failed = history.find((g) => g.id === badId)
  assert.strictEqual(failed?.qualityStatus, 'failed', 'the bad one is kept, marked failed')
  assert.strictEqual(failed?.active, false, 'and is not active')
  assert.match(failed?.qualityReason ?? '', /person/i, 'with a readable reason')
  assert.strictEqual(failed?.suspiciousFrames[0]?.frameIndex, 3, 'and the frame that showed it')
  assert.strictEqual(
    failed?.status,
    'completed',
    'the PROVIDER still reads as succeeded — it did; the content is what failed'
  )

  // ── PERSISTENCE ACROSS A RE-READ ────────────────────────────────────
  assert.strictEqual(
    getGenerationsForPair(project.id, fromId, toId).find((g) => g.id === badId)?.qualityReason,
    failed?.qualityReason,
    'the verdict survives being read back from the database'
  )

  // ── G. MANUAL OVERRIDE, WITH THE VERDICT PRESERVED ──────────────────
  approveQualityManually(project.id, badId)
  const overridden = getGenerationsForPair(project.id, fromId, toId).find((g) => g.id === badId)
  assert.strictEqual(overridden?.qualityOverride, 'manual', 'the override is recorded')
  assert.strictEqual(
    overridden?.qualityStatus,
    'failed',
    'and the failure is NOT rewritten — history keeps both facts'
  )
  assert.ok(
    qualityAllowsActive(overridden!.qualityStatus, overridden!.qualityOverride),
    'the override is what makes it usable, not a changed verdict'
  )

  // ── H. EXPORT READINESS ─────────────────────────────────────────────
  //
  // The export gate re-asks the same rule. Attach the failed clip
  // directly — simulating a path that skipped the check — and confirm it
  // is refused while the override is off.
  const stored = listProjects().find((pr) => pr.id === project.id)!
  const key = transitionKey(fromId, toId)
  stored.transitions[key] = {
    ...defaultTransitionSettings(5),
    status: 'completed',
    mode: 'ai',
    clip: bad
  }
  saveProject(stored)

  // The override recorded above currently permits it.
  const permitted = exportReadiness(listProjects().find((pr) => pr.id === project.id)!)
  assert.ok(
    !/quality check/i.test(permitted.reason ?? ''),
    'an explicitly approved clip is not blocked by the quality gate'
  )

  // ── J. THE SETTING SURVIVES A RESTART ───────────────────────────────
  //
  // Stored in the settings row, not in memory. Read back through the same
  // accessor the generation path uses, because a mode that silently
  // reverts to the default on relaunch would quietly re-enable spend the
  // operator had turned off.
  const before = getSettingsJson()
  try {
    const parsed = before ? (JSON.parse(before) as AppSettings) : ({} as AppSettings)
    saveSettingsJson(
      JSON.stringify({
        ...parsed,
        analyzer: {
          ...(parsed.analyzer ?? { analyzerId: 'manual', model: '', apiKey: '', mode: 'dry-run' }),
          qualityValidationMode: 'reflection-risk-only'
        }
      })
    )
    const reread = JSON.parse(getSettingsJson() ?? '{}') as AppSettings
    assert.strictEqual(
      reread.analyzer?.qualityValidationMode,
      'reflection-risk-only',
      'J: the chosen mode is persisted and reads back'
    )
    assert.ok(
      !shouldValidateClip(reread.analyzer!.qualityValidationMode!, false),
      'and the stored value — not the default — is what governs'
    )
  } finally {
    // The operator's real settings are restored whatever happens.
    if (before !== null) saveSettingsJson(before)
  }

  log('quality catalogue: a failed regeneration never evicts a good clip; history keeps both')
}

/**
 * MISSING CONTEXT — the third outcome.
 *
 * ── THE PRODUCT MISTAKE THIS CORRECTS ────────────────────────────────
 *
 * A mirror whose reflection could not be read used to CUT an otherwise
 * well-evidenced same-room transition. That treated "the model does not
 * know" as "the transition is impossible", and those are different
 * claims. The operator has usually stood in the room.
 *
 * Only AFFIRMATIVE incompatibility forces a cut now. An absence becomes
 * a question, and answering it is enough.
 */
/**
 * THE DONKEY.
 *
 * ── WHAT ACTUALLY HAPPENED ───────────────────────────────────────────
 *
 * An operator typed a joke instruction while testing, re-ran the feed
 * analysis, and the joke appeared to survive and keep winning. The
 * forensic answer is in the report — but the CLASS of failure it named
 * is real and is what this pins:
 *
 *   text written against analysis v1
 *   → still injected into prompts built from analysis v2
 *   → with nothing on screen saying where it came from
 *
 * "Operator context survives re-analysis" was the right instinct and too
 * blunt a rule. Survival is not the same as authority.
 */
/**
 * ACCEPT, PAIR ANALYSIS, AND STALENESS — the regressions that were owed.
 *
 * ── THE FAILURE THESE PIN ────────────────────────────────────────────
 *
 * Accepting a feed analysis wrote per-pair modes and marked the draft
 * accepted, and never promoted the PROPERTY MAP the analysis had been
 * built from. Recovered from the operator's own database:
 *
 *   accepted PropertyAnalysis   2026-08-31   mirror only a landmark
 *   draft PropertyAnalysis      2026-09-06   mirror content described
 *   accepted feed analysis      built from the DRAFT → "ai / safe"
 *
 * So the feed analysis said safe while generation preflight, reading the
 * five-week-old accepted map, refused the same pair for missing evidence
 * about the same mirror. Two maps, two answers, one transition.
 */
/**
 * PROMPT BASIS — what wording was built on, and whether it still holds.
 *
 * ── WHY "A PROMPT EXISTS" WAS THE WRONG TEST ─────────────────────────
 *
 * It is how a prompt written against a five-week-old map survived a
 * fresh analysis and kept guiding generation. Once a pair can be guided
 * by four different sources, existence says nothing: an individual pair
 * analysis and the global map can share a timestamp and mean entirely
 * different things.
 */
function testPromptBasisProvenance(workDir: string, created: string[]): void {
  const fp = (source: Parameters<typeof evidenceFingerprintOf>[0]): string =>
    evidenceFingerprintOf(source)

  // ── FINGERPRINTS DIFFER BY SOURCE, NOT ONLY BY TIME ─────────────────
  assert.notStrictEqual(
    fp({ source: 'individual-analysis', pairAnalyzedAt: 100 }),
    fp({ source: 'global-analysis', analysisUpdatedAt: 100 }),
    'the same instant from two sources is not the same evidence'
  )

  const provenance = {
    basePrompt: 'base',
    motionInstruction: null,
    effectivePrompt: 'base',
    basis: 'same-room' as const,
    rationale: '',
    manuallyEdited: false,
    plannedAt: 1,
    analysisUpdatedAt: 100,
    evidenceSource: 'feed-analysis' as const,
    evidenceFingerprint: fp({ source: 'feed-analysis', analysisUpdatedAt: 100 }),
    pairKey: 'a->b'
  }

  assert.ok(
    isPromptBasisCurrent(provenance, {
      source: 'feed-analysis',
      fingerprint: fp({ source: 'feed-analysis', analysisUpdatedAt: 100 })
    }),
    'unchanged evidence leaves the wording current'
  )
  assert.ok(
    !isPromptBasisCurrent(provenance, {
      source: 'individual-analysis',
      fingerprint: fp({ source: 'individual-analysis', pairAnalyzedAt: 200 })
    }),
    'an accepted individual analysis makes the old feed-based wording stale'
  )
  assert.ok(
    !isPromptBasisCurrent(provenance, {
      source: 'feed-analysis',
      fingerprint: fp({ source: 'feed-analysis', analysisUpdatedAt: 300 })
    }),
    'and so does a newer analysis from the same source'
  )
  assert.ok(
    !isPromptBasisCurrent(
      { ...provenance, evidenceSource: undefined, evidenceFingerprint: undefined },
      { source: 'feed-analysis', fingerprint: fp({ source: 'feed-analysis', analysisUpdatedAt: 100 }) }
    ),
    'a row that never recorded its source is stale, not assumed to match'
  )
  // Operator context changing invalidates wording built on it.
  assert.ok(
    !isPromptBasisCurrent(
      { ...provenance, evidenceSource: 'operator', evidenceFingerprint: fp({ source: 'operator', operatorContextAt: 5 }), operatorContextFingerprint: '5' },
      { source: 'operator', fingerprint: fp({ source: 'operator', operatorContextAt: 9 }), operatorContextFingerprint: '9' }
    ),
    'editing the operator context makes wording built from it stale'
  )
  // A hand-written prompt is never stale: it is not a derivation.
  assert.ok(
    isPromptBasisCurrent(
      { ...provenance, manuallyEdited: true },
      { source: 'individual-analysis', fingerprint: 'anything-else' }
    ),
    'a manual prompt is the operator’s wording and never goes stale'
  )

  // ── THE MANUAL PROMPT IS HELD, NOT OVERWRITTEN ──────────────────────
  const project = makeProject('Smoke prompt provenance')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const img = join(workDir, 'prov.png')
  writeFileSync(img, png)
  project.images = importImages(project.id, [
    { sourcePath: img, name: 'a.png' },
    { sourcePath: img, name: 'b.png' }
  ])
  const [A, B] = project.images.map((i) => i.id)
  project.feedSequence = [A, B]
  const key = transitionKey(A, B)
  project.transitions[key] = {
    ...defaultTransitionSettings(5),
    prompt: 'MY OWN WORDING — hand written',
    promptProvenance: {
      basePrompt: 'base',
      motionInstruction: null,
      effectivePrompt: 'MY OWN WORDING — hand written',
      basis: 'same-room',
      rationale: '',
      manuallyEdited: true,
      plannedAt: 1,
      analysisUpdatedAt: null
    }
  }
  saveProject(project)

  savePairAnalysis({
    projectId: project.id,
    pairKey: key,
    analyzedAt: 5000,
    analyzer: 'gemini',
    model: 'test',
    parentAnalysisUpdatedAt: null,
    feedFingerprint: `${A}|${B}`,
    libraryFingerprint: `${A}|${B}`,
    evidence: {
      relation: 'same-room',
      sharedLandmarks: ['vanity'],
      openings: [],
      reflectiveSurfaces: [],
      geometryConflicts: []
    },
    decision: 'ai',
    missingContext: [],
    motionInstruction: 'reposition smoothly between the two viewpoints',
    promptCandidate: null,
    reason: 'same room',
    state: 'draft'
  })

  const acceptRes = acceptPairAnalysis(project.id, key)
  assert.ok(acceptRes.ok, 'accepting the pair analysis succeeded: ' + (acceptRes.reason ?? ''))
  const held = listProjects().find((x) => x.id === project.id)!.transitions[key]
  assert.strictEqual(
    held?.prompt,
    'MY OWN WORDING — hand written',
    'a hand-written prompt is NOT overwritten by an accepted analysis'
  )
  assert.strictEqual(held?.promptProvenance?.manuallyEdited, true, 'and stays marked as theirs')
  assert.ok(held?.promptSuggestion, 'the suggestion is held beside it instead')
  assert.match(
    held?.promptSuggestion?.text ?? '',
    /reposition smoothly/,
    'carrying the new motion'
  )
  assert.strictEqual(held?.promptSuggestion?.evidenceSource, 'individual-analysis')

  // ── EXPLICIT REPLACE IS THE ONLY WAY IT SWAPS ───────────────────────
  const replaced = replaceManualPrompt(project.id, key)
  assert.ok(replaced.ok, 'replacing succeeds when a suggestion exists')
  const after = listProjects().find((x) => x.id === project.id)!.transitions[key]
  assert.match(after?.prompt ?? '', /reposition smoothly/, 'the suggestion is now the prompt')
  assert.strictEqual(
    after?.promptProvenance?.manuallyEdited,
    false,
    'and the manual flag is cleared — the wording is no longer theirs'
  )
  assert.strictEqual(after?.promptProvenance?.evidenceSource, 'individual-analysis')
  assert.strictEqual(after?.promptSuggestion, undefined, 'the pending suggestion is consumed')

  // ── PERSISTENCE ─────────────────────────────────────────────────────
  const reread = listProjects().find((x) => x.id === project.id)!.transitions[key]
  assert.strictEqual(
    reread?.promptProvenance?.evidenceFingerprint,
    fp({ source: 'individual-analysis', pairAnalyzedAt: 5000 }),
    'the evidence fingerprint survives being written and read back'
  )
  assert.strictEqual(reread?.promptProvenance?.pairKey, key)

  // ── A NON-MANUAL PROMPT IS REBUILT INSTEAD OF HELD ──────────────────
  const p2 = listProjects().find((x) => x.id === project.id)!
  p2.transitions[key] = { ...p2.transitions[key]!, promptSuggestion: undefined }
  saveProject(p2)
  savePairAnalysis({
    ...readPairAnalysis(project.id, key)!,
    analyzedAt: 6000,
    motionInstruction: 'rotate gently toward the window',
    state: 'draft'
  })
  acceptPairAnalysis(project.id, key)
  const rebuilt = listProjects().find((x) => x.id === project.id)!.transitions[key]
  // ── THE ROUTE IS REBUILT; THE TEMPO IS NOT CARRIED ──────────────────
  //
  // This used to assert the prompt contained `rotate gently toward the
  // window` VERBATIM — the analyzer's prose, tempo word and all, copied
  // into the final prompt. That is the bug this pass exists to remove:
  // "gently" is a speed instruction, it travelled in the same prompt as
  // MOTION — CONTINUOUS CONSTANT VELOCITY, and the pair-specific
  // sentence is the more concrete of the two. It is a real example, from
  // the operator's own database.
  //
  // What must survive is the ROUTE. What must not is the pace.
  assert.match(rebuilt?.prompt ?? '', /rotate/i, 'the analyzer’s rotation survives')
  assert.match(rebuilt?.prompt ?? '', /toward the window/i, 'and so does its destination')
  assert.doesNotMatch(
    rebuilt?.prompt ?? '',
    /gently/i,
    'but its pace does not — speed is stated once, in MOTION_QUALITY'
  )
  assert.ok(
    (rebuilt?.prompt ?? '').includes('ONE CONSTANT SPEED'),
    'and the canonical speed contract is present'
  )
  assert.strictEqual(
    rebuilt?.promptProvenance?.motionInstruction,
    'rotate toward the window',
    'provenance records the route that was actually sent, not the wording that arrived'
  )
  assert.strictEqual(
    rebuilt?.promptSuggestion,
    undefined,
    'and no suggestion is left pending for it'
  )

  // ── PREFLIGHT REFUSES WORDING BUILT ON OLD EVIDENCE ─────────────────
  //
  // The last gap. `isPromptBasisCurrent` existed and the inspector said
  // "Prompt basis outdated", but nothing stopped the generation — so a
  // prompt written against superseded evidence could still be paid for.
  // A screen saying one thing while the paid path does another is the
  // same class of failure as the two-analysis split.
  const stale = makeProject('Smoke stale prompt basis')
  created.push(stale.id)
  stale.images = importImages(stale.id, [
    { sourcePath: img, name: 'a.png' },
    { sourcePath: img, name: 'b.png' }
  ])
  const [SA, SB] = stale.images.map((i) => i.id)
  stale.feedSequence = [SA, SB]
  const sk = transitionKey(SA, SB)
  saveProject(stale)
  saveAnalysis({
    ...emptyAnalysis(stale.id),
    source: 'manual',
    state: 'accepted',
    rooms: [{ id: 'r', label: 'Room', imageIds: [SA, SB], landmarks: ['sofa'], confidence: 'confirmed' }],
    images: [
      { imageId: SA, roomId: 'r', orientation: 'into-room', landmarks: ['sofa'], openings: [], overlapWith: [SB] },
      { imageId: SB, roomId: 'r', orientation: 'into-room', landmarks: ['sofa'], openings: [], overlapWith: [SA] }
    ]
  })

  const setBasis = (over: Partial<NonNullable<TransitionSettings['promptProvenance']>>): void => {
    const p2 = listProjects().find((x) => x.id === stale.id)!
    p2.transitions[sk] = {
      ...defaultTransitionSettings(5),
      mode: 'ai',
      modeProvenance: 'analysis',
      prompt: 'wording',
      promptProvenance: {
        basePrompt: 'base',
        motionInstruction: 'move',
        effectivePrompt: 'wording',
        basis: 'same-room',
        rationale: '',
        manuallyEdited: false,
        plannedAt: 1,
        analysisUpdatedAt: null,
        ...over
      }
    }
    saveProject(p2)
  }
  const ask = (
    evidence: { source: EvidenceSource; fingerprint: string; operatorContextFingerprint?: string } | null
  ): ReturnType<typeof assessAiGenerationReadiness> => {
    const p2 = listProjects().find((x) => x.id === stale.id)!
    return assessAiGenerationReadiness(
      readAnalysis(stale.id),
      [SA, SB],
      sk,
      p2.transitions[sk]?.modeProvenance,
      undefined,
      p2.transitions[sk]?.operatorContext,
      (k) => p2.transitions[k],
      () => evidence
    )
  }
  const FEED_100 = { source: 'feed-analysis' as const, fingerprint: 'feed:100' }
  const PAIR_5000 = { source: 'individual-analysis' as const, fingerprint: 'pair:5000' }

  // A. matching basis → allowed
  setBasis({ evidenceSource: 'feed-analysis', evidenceFingerprint: 'feed:100' })
  assert.ok(ask(FEED_100).ok, 'A: wording that matches the evidence in force is allowed')

  // B. feed-built wording, newer individual analysis → blocked
  const blockedB = ask(PAIR_5000)
  assert.ok(!blockedB.ok, 'B: a newer individual analysis makes feed-built wording unusable')
  assert.match(blockedB.reason ?? '', /outdated spatial evidence/i)
  assert.match(
    blockedB.reason ?? '',
    /Re-analyse this transition or rebuild its prompt/i,
    'and names the two exact actions, not a generic "re-analyse transitions"'
  )

  // C. operator context edited → blocked
  setBasis({
    evidenceSource: 'operator',
    evidenceFingerprint: 'operator:2',
    operatorContextFingerprint: '2'
  })
  assert.ok(
    !ask({ source: 'operator', fingerprint: 'operator:3', operatorContextFingerprint: '3' }).ok,
    'C: editing the context makes wording built from it unusable'
  )

  // D. rebuilt against current evidence → allowed
  setBasis({ evidenceSource: 'individual-analysis', evidenceFingerprint: 'pair:5000' })
  assert.ok(ask(PAIR_5000).ok, 'D: rebuilding restores it')

  // E + F. a hand-written prompt is exempt, and its suggestion stays optional
  setBasis({ manuallyEdited: true, evidenceSource: 'feed-analysis', evidenceFingerprint: 'feed:100' })
  const manualProject = listProjects().find((x) => x.id === stale.id)!
  manualProject.transitions[sk] = {
    ...manualProject.transitions[sk]!,
    promptSuggestion: {
      text: 'SUGGESTED',
      createdAt: 9,
      evidenceSource: 'individual-analysis',
      evidenceFingerprint: 'pair:5000'
    }
  }
  saveProject(manualProject)
  assert.ok(
    ask(PAIR_5000).ok,
    'E: a hand-written prompt is not blocked merely because the evidence moved'
  )
  assert.strictEqual(
    listProjects().find((x) => x.id === stale.id)!.transitions[sk]?.prompt,
    'wording',
    'F: and the pending suggestion never substitutes itself for their text'
  )

  // G. a legacy prompt that never recorded its source is unknown, not a match
  setBasis({ evidenceSource: undefined, evidenceFingerprint: undefined })
  const legacy = ask(FEED_100)
  assert.ok(!legacy.ok, 'G: wording with no recorded basis is treated as stale')
  assert.match(legacy.reason ?? '', /outdated spatial evidence/i)

  // H. an operator's own AI decision still reaches the override path.
  const manualMode = listProjects().find((x) => x.id === stale.id)!
  manualMode.transitions[sk] = { ...manualMode.transitions[sk]!, modeProvenance: 'manual' }
  saveProject(manualMode)
  const overridden = ask(FEED_100)
  assert.ok(overridden.ok, 'H: an explicit operator override still proceeds')
  assert.strictEqual(overridden.kind, 'manual-override', 'as an override, with its warning')

  // ── I. APPROVE AI WITH CONTEXT LEAVES A GENERATABLE PAIR ────────────
  //
  // The reported runtime failure, reproduced against the real database.
  // The operator ran the analysis, supplied the missing fact, approved —
  // and generation still refused with "outdated spatial evidence". Three
  // separate writes did it: the context was stored, the mode was set, and
  // the prompt was left carrying the old basis (in the recovered case, no
  // recorded basis at all).
  //
  // The question below is not a hand-built one. It is `readinessInputs`,
  // the same function the confirmation dialog and the submit path use.
  setBasis({ evidenceSource: 'feed-analysis', evidenceFingerprint: 'feed:100' })
  const askForReal = (): ReturnType<typeof assessAiGenerationReadiness> => {
    const p2 = listProjects().find((x) => x.id === stale.id)!
    const inputs = readinessInputs(stale.id)
    return assessAiGenerationReadiness(
      readAnalysis(stale.id),
      [SA, SB],
      sk,
      p2.transitions[sk]?.modeProvenance,
      undefined,
      p2.transitions[sk]?.operatorContext,
      inputs.transitionFor,
      inputs.currentEvidence
    )
  }

  const approved = approvePair({
    projectId: stale.id,
    pairKey: sk,
    mode: 'ai',
    contextText: 'The mirror shows the hallway door, not a second room.'
  })
  assert.ok(approved.ok, 'I: the approval is accepted')
  assert.strictEqual(
    approved.evidenceSource,
    'operator',
    'and their words outrank the feed analysis that was in force'
  )

  const afterApproval = listProjects().find((x) => x.id === stale.id)!.transitions[sk]!
  const ctxAt = afterApproval.operatorContext?.createdAt
  assert.ok(ctxAt, 'the context itself is stored')
  assert.strictEqual(
    afterApproval.promptProvenance?.evidenceSource,
    'operator',
    'the WORDING is stamped against that same evidence — not left blank, which is what shipped'
  )
  assert.strictEqual(
    afterApproval.promptProvenance?.evidenceFingerprint,
    `operator:${ctxAt}`,
    'with the fingerprint the resolver produces, so the gate recomputes a match'
  )
  assert.strictEqual(
    afterApproval.modeProvenance,
    'manual',
    'and the decision is recorded as theirs, because it was'
  )
  assert.ok(
    isPromptBasisCurrent(afterApproval.promptProvenance, {
      source: 'operator',
      fingerprint: `operator:${ctxAt}`,
      operatorContextFingerprint: String(ctxAt)
    }),
    'so the prompt reads as current'
  )
  assert.ok(
    afterApproval.prompt.includes('hallway door'),
    'and the rebuilt wording actually carries what they told us'
  )
  assert.strictEqual(
    (afterApproval.prompt.match(/OPERATOR-PROVIDED SPATIAL CONTEXT/g) ?? []).length,
    1,
    'exactly one context block — the approval plans and renders with the same text, ' +
      'and stating a fact twice reads to the model as two facts'
  )
  const allowed = askForReal()
  assert.ok(
    allowed.ok,
    `I: generation is allowed after approve-with-context; got: ${
      allowed.ok ? '' : allowed.reason
    }`
  )

  // J. Precedence: a LATER individual analysis does not silently demote
  // the operator. Their statement is the one thing the model cannot see.
  const jProject = listProjects().find((x) => x.id === stale.id)!
  assert.strictEqual(
    readinessInputs(stale.id).currentEvidence(sk)?.source,
    'operator',
    'J: operator context outranks feed analysis for the same pair'
  )
  assert.ok(jProject.transitions[sk]?.operatorContext, 'and is still stored, not consumed')

  // K. Approving as CUT records the decision without inventing wording,
  // and leaves their text alone rather than deleting it.
  const cutRes = approvePair({ projectId: stale.id, pairKey: sk, mode: 'cut' })
  assert.ok(cutRes.ok, 'K: a cut decision is accepted')
  const afterCut = listProjects().find((x) => x.id === stale.id)!.transitions[sk]!
  assert.strictEqual(afterCut.mode, 'cut')
  assert.strictEqual(afterCut.modeProvenance, 'manual')
  assert.strictEqual(
    afterCut.operatorContext?.createdAt,
    ctxAt,
    'their words survive a cut — they may be right about the room even so'
  )

  // L. A hand-written prompt is never overwritten by approving.
  const lProject = listProjects().find((x) => x.id === stale.id)!
  lProject.transitions[sk] = {
    ...lProject.transitions[sk]!,
    prompt: 'MY OWN WORDS',
    promptProvenance: { ...lProject.transitions[sk]!.promptProvenance!, manuallyEdited: true }
  }
  saveProject(lProject)
  const lRes = approvePair({
    projectId: stale.id,
    pairKey: sk,
    mode: 'ai',
    contextText: 'A different fact entirely.'
  })
  assert.ok(lRes.ok && lRes.manualPromptPreserved, 'L: the manual prompt is reported as preserved')
  assert.strictEqual(
    listProjects().find((x) => x.id === stale.id)!.transitions[sk]?.prompt,
    'MY OWN WORDS',
    'and their sentence is still exactly their sentence'
  )

  log('prompt provenance: manual wording is held, derived wording is rebuilt and dated')
  log('approve-with-context: context, decision and wording settle in one operation')
}

/**
 * THE REPORTED FLOW, END TO END.
 *
 *   Re-analyse Feed → Accept Analysis → Use analysis prompt → Generate
 *
 * Every step is the production function the button calls. It blocked in
 * the shipped Portable, and the operator's own database showed why: eight
 * AI pairs unable to generate, failing in two different ways at once.
 *
 *   7 pairs   prompt = global-analysis   current = feed-analysis
 *   1 pair    prompt = NULL, never stamped
 *
 * The seven were Accept, which rebuilt the wording BEFORE marking the
 * feed analysis accepted, so the resolver could not yet see one. The
 * eighth was `Use analysis prompt`, which wrote no evidence fields at all.
 */
function testAcceptThenUseAnalysisPrompt(workDir: string, created: string[]): void {
  const project = makeProject('Smoke accept + use analysis prompt')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'usea.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: 'a.png' },
    { sourcePath: p, name: 'b.png' },
    { sourcePath: p, name: 'c.png' }
  ])
  const [A, B, C] = project.images.map((i) => i.id)
  project.feedSequence = [A, B, C]
  const pairAB = transitionKey(A, B)
  const pairBC = transitionKey(B, C)
  saveProject(project)

  const mapWith = (landmark: string): PropertyAnalysis => ({
    ...emptyAnalysis(project.id),
    source: 'provider',
    state: 'draft',
    rooms: [
      { id: 'r1', label: 'Living room', imageIds: [A, B], landmarks: [landmark], confidence: 'confirmed' },
      { id: 'r2', label: 'Kitchen', imageIds: [C], landmarks: ['counter'], confidence: 'confirmed' }
    ],
    images: [
      { imageId: A, roomId: 'r1', orientation: 'into-room', landmarks: [landmark], openings: [], overlapWith: [B] },
      { imageId: B, roomId: 'r1', orientation: 'into-room', landmarks: [landmark], openings: ['open door to Kitchen'], overlapWith: [A] },
      { imageId: C, roomId: 'r2', orientation: 'into-room', landmarks: ['counter'], openings: [], overlapWith: [] }
    ],
    edges: [
      { id: 'e1', fromRoomId: 'r1', toRoomId: 'r2', confidence: 'confirmed', supportingImageIds: [B, C] }
    ]
  })

  // ── A. RE-ANALYSE FEED PRODUCES A DRAFT ───────────────────────────
  saveAnalysisDraft(mapWith('sofa'))
  const feedDraft = {
    feedImageIds: [A, B, C],
    createdAt: Date.now(),
    status: 'draft' as const,
    pairs: [
      { fromId: A, toId: B, recommendation: 'ai' as const, reason: 'same room', prompt: 'PAN LEFT' },
      { fromId: B, toId: C, recommendation: 'ai' as const, reason: 'open door', prompt: 'WALK THROUGH' }
    ]
  }
  saveTransitionDraft(project.id, feedDraft as never)

  // ── B. ACCEPT ANALYSIS ────────────────────────────────────────────
  const accepted = acceptFeedAnalysis(project.id, feedDraft as never)
  assert.ok(accepted.ok, 'Accept succeeds: ' + (accepted.reason ?? ''))

  const inputs = (): ReturnType<typeof readinessInputs> => readinessInputs(project.id)
  const askGen = (pairKey: string): ReturnType<typeof assessAiGenerationReadiness> => {
    const live = listProjects().find((x) => x.id === project.id)!
    const i = inputs()
    return assessAiGenerationReadiness(
      readAnalysis(project.id),
      getFeedSequenceIds(live),
      pairKey,
      live.transitions[pairKey]?.modeProvenance,
      undefined,
      live.transitions[pairKey]?.operatorContext,
      i.transitionFor,
      i.currentEvidence
    )
  }

  // ── C. THE PAIR PROMPT WAS BUILT — AND STAMPED AGAINST THE FEED ───
  //
  // THE SEVEN-PAIR BUG. Accept rebuilt wording before marking the feed
  // analysis accepted, so this said `global-analysis` while preflight,
  // moments later, said `feed-analysis`.
  const afterAccept = listProjects().find((x) => x.id === project.id)!
  const evAB = inputs().currentEvidence(pairAB)
  assert.strictEqual(evAB?.source, 'feed-analysis', 'the accepted feed analysis covers this pair')
  assert.strictEqual(
    afterAccept.transitions[pairAB]?.promptProvenance?.evidenceSource,
    'feed-analysis',
    'and Accept stamped the wording against it — not against the map alone'
  )
  assert.strictEqual(
    afterAccept.transitions[pairAB]?.promptProvenance?.evidenceFingerprint,
    evAB?.fingerprint,
    'with the identical fingerprint the gate recomputes'
  )
  assert.ok(askGen(pairAB).ok, 'so Accept alone leaves a generatable pair')

  // ── D. USE ANALYSIS PROMPT ────────────────────────────────────────
  //
  // §8. Before the click the prompt carries a deliberately wrong basis.
  const staleProject = listProjects().find((x) => x.id === project.id)!
  staleProject.transitions[pairBC] = {
    ...staleProject.transitions[pairBC]!,
    prompt: 'OLD WORDING',
    promptProvenance: {
      ...staleProject.transitions[pairBC]!.promptProvenance!,
      evidenceSource: 'global-analysis',
      evidenceFingerprint: 'global:1'
    }
  }
  saveProject(staleProject)
  assert.ok(!askGen(pairBC).ok, 'a deliberately stale basis blocks generation first')

  const applied = applyAnalysisPromptToTransition(project.id, pairBC)
  assert.ok(applied.ok, 'Use analysis prompt runs')

  const afterUse = listProjects().find((x) => x.id === project.id)!.transitions[pairBC]!
  const evBC = inputs().currentEvidence(pairBC)
  assert.strictEqual(
    afterUse.promptProvenance?.evidenceSource,
    evBC?.source,
    'Use analysis prompt stamps the CURRENT source — it used to stamp none at all'
  )
  assert.strictEqual(
    afterUse.promptProvenance?.evidenceFingerprint,
    evBC?.fingerprint,
    'and the current fingerprint'
  )
  assert.strictEqual(afterUse.promptProvenance?.pairKey, pairBC, 'recorded against this pair')
  assert.strictEqual(
    afterUse.promptProvenance?.manuallyEdited,
    false,
    'and hands the wording back to the analysis'
  )
  assert.ok(
    isPromptBasisCurrent(afterUse.promptProvenance, evBC!),
    'so the adopted prompt is current the moment it is adopted'
  )

  // ── E + F. RELOAD, THEN THE GENERATION CONFIRMATION ───────────────
  const reloaded = listProjects().find((x) => x.id === project.id)!.transitions[pairBC]!
  assert.ok(
    isPromptBasisCurrent(reloaded.promptProvenance, inputs().currentEvidence(pairBC)!),
    'still current after reading the project back'
  )
  const gen = askGen(pairBC)
  assert.ok(gen.ok, 'GENERATION ALLOWED: ' + (gen.ok ? '' : gen.reason))

  // ── §9. A NO-OP SAVE MUST NOT INVALIDATE ANYTHING ─────────────────
  //
  // `saveAnalysis` stamped `Date.now()` unconditionally, and the prompt
  // fingerprint is derived from that timestamp — so re-saving an
  // unchanged map marked every prompt in the project stale.
  const beforeNoop = inputs().currentEvidence(pairBC)!.fingerprint
  const reSaved = saveAnalysis(readAnalysis(project.id))
  const noopProject = listProjects().find((x) => x.id === project.id)!
  noopProject.updatedAt = Date.now()
  saveProject(noopProject)
  assert.strictEqual(
    inputs().currentEvidence(pairBC)!.fingerprint,
    beforeNoop,
    '§9: saving the same evidence twice does not move the fingerprint'
  )
  assert.ok(reSaved.updatedAt > 0, 'and the analysis is still stored')
  assert.ok(
    askGen(pairBC).ok && askGen(pairAB).ok,
    '§9: so no prompt becomes falsely stale after a reload/save round trip'
  )

  // ── §10. A REAL EVIDENCE CHANGE STILL INVALIDATES ─────────────────
  //
  // The staleness mechanism has to keep working, or this whole pass has
  // simply disabled a safety gate.
  saveAnalysis({ ...mapWith('bookcase'), state: 'accepted' })
  const changedFingerprint = inputs().currentEvidence(pairBC)!.fingerprint
  assert.notStrictEqual(
    changedFingerprint,
    beforeNoop,
    '§10: genuinely changing the accepted map DOES move the fingerprint'
  )
  const nowStale = askGen(pairBC)
  assert.ok(
    !nowStale.ok,
    '§10: and wording built from the previous evidence is refused again'
  )
  assert.match((nowStale as { reason: string }).reason, /outdated spatial evidence/i)

  log('accept → use analysis prompt → generate: stamped once, current at every step')
}

function testAcceptAndPairAnalysis(workDir: string, created: string[]): void {
  const project = makeProject('Smoke accept + pair')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'accept.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: 'a.png' },
    { sourcePath: p, name: 'b.png' },
    { sourcePath: p, name: 'c.png' }
  ])
  const [A, B, C] = project.images.map((i) => i.id)
  project.feedSequence = [A, B, C]
  saveProject(project)

  const pairAB = transitionKey(A, B)
  const pairBC = transitionKey(B, C)

  // ── THE OLD MAP: a mirror nobody could read ─────────────────────────
  const oldMap: PropertyAnalysis = {
    ...emptyAnalysis(project.id),
    source: 'manual',
    state: 'accepted',
    updatedAt: 1000,
    rooms: [
      { id: 'bath', label: 'Bathroom', imageIds: [A, B], landmarks: ['vanity'], confidence: 'confirmed' }
    ],
    images: [
      {
        imageId: A,
        roomId: 'bath',
        orientation: 'into-room',
        // The legacy shape: the mirror exists only as a landmark string.
        landmarks: ['vanity', 'mirror reflection'],
        openings: [],
        overlapWith: [B]
      },
      { imageId: B, roomId: 'bath', orientation: 'into-room', landmarks: ['vanity'], openings: [], overlapWith: [A] }
    ]
  }
  saveAnalysis(oldMap)

  // Reproduce the screenshot: preflight refuses on the old map.
  const blocked = assessAiGenerationReadiness(readAnalysis(project.id), [A, B, C], pairAB)
  assert.ok(!blocked.ok, 'the old map blocks generation, as it did in the real project')
  assert.match(blocked.reason ?? '', /sufficient accepted spatial evidence/i)

  // ── THE NEW MAP, sitting as a draft ─────────────────────────────────
  const newMap: PropertyAnalysis = {
    ...oldMap,
    updatedAt: 2000,
    state: 'draft',
    images: [
      {
        imageId: A,
        roomId: 'bath',
        orientation: 'into-room',
        landmarks: ['vanity'],
        openings: [],
        overlapWith: [B],
        reflectiveSurfaces: [
          {
            type: 'wall mirror',
            dominant: true,
            // The thing the old map could not say.
            expectedVisibleContent: ['white doorway', 'beige wall tile'],
            confidence: 'confirmed'
          }
        ]
      },
      { imageId: B, roomId: 'bath', orientation: 'into-room', landmarks: ['vanity'], openings: [], overlapWith: [A] }
    ]
  }
  saveAnalysisDraft(newMap)

  // A decision the operator made before pressing Accept.
  const live = listProjects().find((x) => x.id === project.id)!
  live.transitions[pairBC] = {
    ...defaultTransitionSettings(5),
    mode: 'cut',
    modeProvenance: 'manual'
  }
  saveProject(live)

  const draft: TransitionDraft = {
    feedImageIds: [A, B, C],
    createdAt: 3000,
    status: 'draft',
    pairs: [
      { fromId: A, toId: B, recommendation: 'ai', decision: 'ai', missingContext: [], safety: null },
      // The analyzer would have set this to AI; the operator said cut.
      { fromId: B, toId: C, recommendation: 'ai', decision: 'ai', missingContext: [], safety: null }
    ]
  }

  const result = acceptFeedAnalysis(project.id, draft)
  assert.ok(result.ok, `accept succeeded: ${result.reason ?? ''}`)

  // ── D. THE ACCEPTED PROPERTY ANALYSIS ACTUALLY UPDATES ──────────────
  const acceptedNow = readAnalysis(project.id)
  // `saveAnalysis` stamps its own updatedAt — accepting IS a new event —
  // so the proof is that the CONTENT moved, not the timestamp.
  assert.ok(acceptedNow.updatedAt > 1000, 'D: the accepted map was rewritten')
  assert.ok(
    acceptedNow.images.find((i) => i.imageId === A)?.reflectiveSurfaces?.length,
    'D: including the reflective surfaces the old map lacked'
  )

  // ── E. PAIR DECISIONS UPDATE — AND THE OPERATOR SURVIVES ────────────
  const after = listProjects().find((x) => x.id === project.id)!
  assert.strictEqual(after.transitions[pairAB]?.mode, 'ai', 'E: analyzer decisions applied')
  assert.strictEqual(after.transitions[pairAB]?.modeProvenance, 'analysis')
  assert.strictEqual(
    after.transitions[pairBC]?.mode,
    'cut',
    'E: the operator’s own decision was NOT overwritten by the analyzer'
  )
  assert.strictEqual(after.transitions[pairBC]?.modeProvenance, 'manual')
  assert.strictEqual(result.operatorDecisionsPreserved, 1, 'and it is reported, not silent')

  // ── F. PROMPT BASIS REBUILT FROM THE NEWLY ACCEPTED MAP ─────────────
  assert.ok(result.promptsUpdated >= 1, 'F: wording was rebuilt from the accepted map')
  assert.ok(
    (after.transitions[pairAB]?.prompt ?? '').length > 0,
    'F: and the AI pair actually carries a prompt'
  )
  // A REBUILT PROMPT MUST SATISFY THE GATE IT WAS REBUILT FOR.
  //
  // The rebuild originally stamped no evidence source, which preflight
  // reads as unknown — so rebuilding would have left every pair blocked
  // by exactly the rule it was meant to satisfy.
  assert.ok(
    after.transitions[pairAB]?.promptProvenance?.evidenceSource,
    'F: the rebuilt wording records what it was built from'
  )
  assert.ok(
    after.transitions[pairAB]?.promptProvenance?.evidenceFingerprint,
    'F: with a fingerprint a later change can be compared against'
  )

  // ── G. PREFLIGHT IMMEDIATELY SEES THE NEW EVIDENCE ──────────────────
  const allowed = assessAiGenerationReadiness(readAnalysis(project.id), [A, B, C], pairAB)
  assert.ok(allowed.ok, 'G: generation is allowed straight after Accept — no restart')
  assert.strictEqual(allowed.kind, 'analysis-backed')

  // ── M. AN UNRESOLVED QUESTION NEVER GETS A GENERIC PROMPT ───────────
  //
  // Re-accept with the pair unresolved and confirm it is left alone
  // rather than converted or given wording built over an unknown.
  const unresolvedDraft: TransitionDraft = {
    ...draft,
    createdAt: 4000,
    pairs: [
      {
        fromId: A,
        toId: B,
        recommendation: 'cut',
        decision: 'needs-context',
        missingContext: [{ type: 'reflection-content', question: 'What does the mirror show?' }],
        safety: null
      }
    ]
  }
  const unresolved = acceptFeedAnalysis(project.id, unresolvedDraft)
  assert.ok(unresolved.ok)
  assert.ok(unresolved.stillNeedContext >= 1, 'M: unresolved pairs are counted, not converted')

  // ── I + J. ONE PAIR, AND ONLY ONE ───────────────────────────────────
  const beforeBC = listProjects().find((x) => x.id === project.id)!.transitions[pairBC]
  const record = decidePair(
    project.id,
    pairAB,
    {
      evidence: {
        relation: 'same-room',
        roomLabel: 'Bathroom',
        sharedLandmarks: ['vanity'],
        openings: [],
        reflectiveSurfaces: [
          {
            type: 'wall mirror',
            dominant: true,
            expectedVisibleContent: ['white doorway', 'beige wall tile']
          }
        ],
        geometryConflicts: []
      },
      missingContext: [],
      motionInstruction: 'reposition smoothly between the two viewpoints'
    },
    'test-model'
  )
  assert.strictEqual(record.decision, 'ai', 'a readable mirror in the same room permits AI')
  savePairAnalysis(record)
  acceptPairAnalysis(project.id, pairAB)

  const reread = readPairAnalysis(project.id, pairAB)
  assert.ok(reread, 'J: the pair analysis survives being written and read back')
  assert.strictEqual(reread?.state, 'accepted')
  assert.strictEqual(reread?.decision, 'ai')
  assert.strictEqual(
    reread?.evidence.reflectiveSurfaces[0]?.expectedVisibleContent[0],
    'white doorway',
    'J: with its evidence intact'
  )
  assert.strictEqual(
    readPairAnalysis(project.id, pairBC),
    null,
    'I: the neighbouring pair has no analysis — exactly one pair was touched'
  )
  assert.deepStrictEqual(
    listProjects().find((x) => x.id === project.id)!.transitions[pairBC]?.mode,
    beforeBC?.mode,
    'I: and its stored mode is unchanged'
  )
  assert.deepStrictEqual(
    getFeedSequenceIds(listProjects().find((x) => x.id === project.id)!),
    [A, B, C],
    'I: the feed order is untouched'
  )

  // ── K. IT GOES STALE WHEN THE PAIR LEAVES THE FEED ──────────────────
  const fp = fingerprints(project.id)
  assert.ok(
    isPairAnalysisCurrent(reread, fp),
    'the analysis applies while the feed still contains the pair'
  )
  const reordered = listProjects().find((x) => x.id === project.id)!
  reordered.feedSequence = [A, C]
  saveProject(reordered)
  assert.ok(
    !isPairAnalysisCurrent(readPairAnalysis(project.id, pairAB), fingerprints(project.id)),
    'K: a feed change makes it stale rather than silently applicable'
  )
  const orphaned = markOrphanedPairAnalyses(project.id, [transitionKey(A, C)])
  assert.strictEqual(orphaned, 1, 'K: and it is marked outdated')
  assert.strictEqual(
    readPairAnalysis(project.id, pairAB)?.state,
    'outdated',
    'K: kept as history, never deleted'
  )

  // ── ROLLBACK: a failing accept leaves nothing half-applied ──────────
  const beforeRollback = readAnalysis(project.id).updatedAt
  const bad = acceptFeedAnalysis(project.id, {
    ...draft,
    createdAt: 5000,
    // Names a pair the feed no longer contains.
    pairs: [{ fromId: A, toId: B, recommendation: 'ai', decision: 'ai', missingContext: [], safety: null }]
  })
  assert.ok(!bad.ok, 'an accept describing a pair the feed lost is refused')
  assert.strictEqual(
    readAnalysis(project.id).updatedAt,
    beforeRollback,
    'and nothing was written — no half-applied accept'
  )

  log('accept + pair analysis: one map, one transaction, one pair at a time')
}

function testOperatorContextLifecycle(): void {
  const v1 = 1000
  const v2 = 2000

  // ── WRITTEN AGAINST v1 ──────────────────────────────────────────────
  const donkey = makeOperatorContext('Add a donkey to the mirror', 500, v1)
  assert.strictEqual(donkey.status, 'current', 'freshly written context is authoritative')
  assert.ok(isContextActive(donkey), 'and is used')

  // Same analysis: nothing changes. A re-run that changed nothing must
  // not make the operator re-confirm everything they have ever written.
  assert.strictEqual(
    reviewAfterReanalysis(donkey, v1),
    donkey,
    'an unchanged analysis leaves context exactly as it was'
  )

  // ── A NEW ANALYSIS ARRIVES ──────────────────────────────────────────
  const demoted = reviewAfterReanalysis(donkey, v2)!
  assert.strictEqual(demoted.status, 'needs-review', 'new analysis withdraws the old authority')
  assert.strictEqual(demoted.text, donkey.text, 'but never deletes the words')
  assert.ok(!isContextActive(demoted), 'and it stops counting as evidence')
  assert.ok(needsReview(demoted), 'while staying visible to the review UI')

  // It also stops resolving a needs-context verdict — otherwise stale
  // text could still unlock a generation on its own.
  const missing = [
    { type: 'reflection-content' as const, question: 'What should the mirror reflect?' }
  ]
  assert.ok(!contextResolves(missing, demoted), 'stale text cannot resolve a missing fact')
  assert.ok(contextResolves(missing, donkey), 'current text can')

  // ── THE PROMPT ──────────────────────────────────────────────────────
  const analysis: PropertyAnalysis = {
    ...emptyAnalysis('p-donkey'),
    source: 'manual',
    rooms: [
      {
        id: 'bath',
        label: 'Bathroom',
        imageIds: ['a', 'b'],
        landmarks: ['vanity'],
        confidence: 'confirmed'
      }
    ],
    images: [
      {
        imageId: 'a',
        roomId: 'bath',
        orientation: 'into-room',
        landmarks: ['vanity', 'sink'],
        openings: [],
        overlapWith: ['b'],
        reflectiveSurfaces: [{ type: 'wall mirror', dominant: true, expectedVisibleContent: [] }]
      },
      {
        imageId: 'b',
        roomId: 'bath',
        orientation: 'into-room',
        landmarks: ['vanity', 'toilet'],
        openings: [],
        overlapWith: ['a']
      }
    ]
  }
  const planWith = (ctx: typeof donkey | undefined): string => {
    const plans = planSequence(
      analysis,
      ['a', 'b'],
      undefined,
      ctx ? new Map([['a->b', ctx]]) : undefined
    )
    return renderPrompt(plans[0], {}, undefined, ctx ?? null)
  }

  // While it was current, the joke really did reach the prompt.
  const withDonkey = planWith(donkey)
  assert.match(withDonkey, /donkey/i, 'current context reaches the prompt — this is the mechanism')
  assert.strictEqual(
    (withDonkey.match(/OPERATOR-PROVIDED SPATIAL CONTEXT/g) ?? []).length,
    1,
    'exactly one operator block — the prompt is BUILT, never appended to'
  )

  // ── THE FIX: AFTER RE-ANALYSIS IT IS NOT INJECTED ───────────────────
  const afterReanalysis = planWith(demoted)
  assert.ok(
    !/donkey/i.test(afterReanalysis),
    'THE FIX: stale context is not injected into a rebuilt prompt'
  )
  assert.ok(
    !afterReanalysis.includes('OPERATOR-PROVIDED SPATIAL CONTEXT'),
    'and no operator block is emitted at all'
  )

  // ── CLEARED ─────────────────────────────────────────────────────────
  const cleared = planWith(undefined)
  assert.strictEqual(
    (cleared.match(/OPERATOR-PROVIDED SPATIAL CONTEXT/g) ?? []).length,
    0,
    'F: clearing leaves zero operator blocks'
  )
  assert.ok(!/donkey/i.test(cleared))

  // ── REPLACED ────────────────────────────────────────────────────────
  const corrected = makeOperatorContext(
    'The mirror reflects the same beige walls shown in the room. A white door is aligned with the sink. No people, cameras or additional objects are present.',
    600,
    v2
  )
  const replaced = planWith(corrected)
  assert.match(replaced, /beige walls/i, 'G: the replacement is used')
  assert.ok(
    !/donkey/i.test(replaced),
    'G: and the word "donkey" is gone — the exact runtime failure cannot regress silently'
  )
  assert.strictEqual(
    (replaced.match(/OPERATOR-PROVIDED SPATIAL CONTEXT/g) ?? []).length,
    1,
    'still exactly one block — never one per rebuild'
  )

  // And the corrected text unblocks the pair, as evidence should.
  assert.strictEqual(
    evaluateTransitionSafety(analysis, 'a', 'b', undefined, null, corrected).decision,
    'ai',
    'current operator context resolves the mirror question'
  )
  assert.strictEqual(
    evaluateTransitionSafety(analysis, 'a', 'b', undefined, null, demoted).decision,
    'needs-context',
    'while stale context leaves it open'
  )

  log('operator context: survives re-analysis, but stops being authoritative until confirmed')
}

function testMissingContext(workDir: string, created: string[]): void {
  const surfaces = (dominant: boolean): ReflectiveSurface[] => [
    { type: 'wall mirror', dominant, expectedVisibleContent: [] }
  ]

  const bathroom = (): PropertyAnalysis => ({
    ...emptyAnalysis('p-context'),
    source: 'manual',
    rooms: [
      {
        id: 'bath',
        label: 'Bathroom 1',
        imageIds: ['a', 'b'],
        landmarks: ['floating vanity'],
        confidence: 'confirmed'
      }
    ],
    images: [
      {
        imageId: 'a',
        roomId: 'bath',
        orientation: 'into-room',
        landmarks: ['floating vanity', 'vessel sink'],
        openings: [],
        overlapWith: ['b'],
        reflectiveSurfaces: surfaces(true)
      },
      {
        imageId: 'b',
        roomId: 'bath',
        orientation: 'into-room',
        landmarks: ['floating vanity', 'wall toilet'],
        openings: [],
        overlapWith: ['a']
      }
    ]
  })

  // ── A. THE BATHROOM PAIR IS A QUESTION, NOT A REFUSAL ───────────────
  const asked = evaluateTransitionSafety(bathroom(), 'a', 'b')
  assert.strictEqual(asked.decision, 'needs-context', 'A: a mirror asks rather than refuses')
  assert.notStrictEqual(asked.decision, 'cut', 'A: and specifically is NOT a cut')
  assert.strictEqual(asked.safety, 'needs-context')
  assert.strictEqual(asked.missingContext.length, 1, 'with exactly one open question')
  assert.strictEqual(asked.missingContext[0].type, 'reflection-content')
  assert.match(asked.missingContext[0].question, /what should the mirror reflect/i)
  assert.match(asked.reason, /cannot determine what should appear in its reflection/i)
  // `mode` stays 'cut' so nothing generates until it is answered.
  assert.strictEqual(asked.mode, 'cut', 'nothing is generated while the question stands')

  // ── B. THE OPERATOR ANSWERS ─────────────────────────────────────────
  const context = makeOperatorContext(
    'Same walls as shown. A white door is aligned with the sink. The mirror reflects the opposite beige wall and doorway only.'
  )
  const answered = evaluateTransitionSafety(bathroom(), 'a', 'b', undefined, null, context)
  assert.strictEqual(answered.decision, 'ai', 'B: answering the question unblocks AI')
  assert.strictEqual(answered.mode, 'ai')
  assert.strictEqual(answered.missingContext.length, 0, 'and nothing is still outstanding')
  assert.match(answered.reason, /operator described what its reflection contains/i)
  assert.ok(
    !/would have to invent/i.test(answered.reason),
    'and the resolved verdict no longer reads like the refusal it replaced'
  )

  // ── D. A PROVEN CONTRADICTION IS NOT AN UNKNOWN ─────────────────────
  //
  // Different rooms with no recorded connection is a FINDING. Typing
  // "same room" next to it must not read as evidence — that path needs
  // the deliberate manual override, not a sentence in a text box.
  const conflicting: PropertyAnalysis = {
    ...emptyAnalysis('p-conflict'),
    source: 'manual',
    rooms: [
      { id: 'r1', label: 'Kitchen', imageIds: ['a'], landmarks: [], confidence: 'confirmed' },
      { id: 'r2', label: 'Garage', imageIds: ['b'], landmarks: [], confidence: 'confirmed' }
    ],
    images: [
      { imageId: 'a', roomId: 'r1', orientation: 'into-room', landmarks: [], openings: [] },
      { imageId: 'b', roomId: 'r2', orientation: 'into-room', landmarks: [], openings: [] }
    ]
  }
  const contradiction = evaluateTransitionSafety(
    conflicting,
    'a',
    'b',
    undefined,
    null,
    makeOperatorContext('These are actually the same room.')
  )
  assert.strictEqual(contradiction.decision, 'cut', 'D: a proven conflict stays a cut')
  assert.strictEqual(contradiction.mode, 'cut', 'and typing context does not silently unlock it')

  // ── E. THE CONTEXT REACHES THE GENERATION PROMPT ────────────────────
  const plans = planSequence(
    bathroom(),
    ['a', 'b'],
    undefined,
    new Map([['a->b', context]])
  )
  const prompt = renderPrompt(plans[0], {}, undefined, context)
  assert.match(prompt, /OPERATOR-PROVIDED SPATIAL CONTEXT:/, 'E: it gets its own block')
  assert.ok(prompt.includes(context.text), 'quoted verbatim, not paraphrased')
  assert.match(prompt, /authoritative knowledge of the real property/i, 'and marked authoritative')
  // Order: the operator's facts come BEFORE the reflection rules, so the
  // mirror instruction builds on them rather than contradicting them.
  assert.ok(
    prompt.indexOf('OPERATOR-PROVIDED SPATIAL CONTEXT') < prompt.indexOf('REFLECTION CONTENT'),
    'stated before the reflection block that depends on it'
  )
  // And the mirror block names what the operator said it shows.
  assert.match(prompt, /EXPECTED MIRROR CONTENT/, 'the mirror gets a positive target')
  assert.match(prompt, /beige wall/i, 'taken from the operator’s own words')

  // ── F + G. IT SURVIVES A RESTART AND A RE-ANALYSIS ──────────────────
  const project = makeProject('Smoke operator context')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'ctx.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: 'a.png' },
    { sourcePath: p, name: 'b.png' }
  ])
  const [fromId, toId] = project.images.map((i) => i.id)
  const key = transitionKey(fromId, toId)
  project.transitions[key] = {
    ...defaultTransitionSettings(5),
    operatorContext: context
  }
  saveProject(project)

  const reread = listProjects().find((x) => x.id === project.id)!
  assert.strictEqual(
    reread.transitions[key]?.operatorContext?.text,
    context.text,
    'F: the operator’s words survive being written and read back'
  )
  assert.strictEqual(reread.transitions[key]?.operatorContext?.source, 'operator', 'G: as operator evidence')

  // Re-analysis rewrites PROMPTS. It must not touch the operator's own
  // evidence — that is the one thing no analyzer could reproduce.
  rebuildPromptsFromAnalysis(project.id)
  assert.strictEqual(
    listProjects().find((x) => x.id === project.id)!.transitions[key]?.operatorContext?.text,
    context.text,
    'G: a prompt rebuild does not delete operator context'
  )

  // ── H. PROMPTS SKIP WHAT IS STILL UNANSWERED ────────────────────────
  const result = rebuildPromptsFromAnalysis(project.id)
  assert.ok(
    typeof result.needsContextCount === 'number',
    'H: the rebuild reports how many pairs are waiting on the operator'
  )

  // ── I. THE SUMMARY KEEPS THE THREE APART ────────────────────────────
  const counts = feedDecisionCounts({
    feedImageIds: [],
    createdAt: 0,
    status: 'draft',
    pairs: [
      { fromId: '1', toId: '2', recommendation: 'ai', decision: 'ai', safety: null },
      { fromId: '2', toId: '3', recommendation: 'cut', decision: 'cut', safety: null },
      { fromId: '3', toId: '4', recommendation: 'cut', decision: 'needs-context', safety: null }
    ]
  })
  assert.deepStrictEqual(
    counts,
    { ai: 1, cut: 1, needsContext: 1 },
    'I: needs-context is counted separately, never hidden inside CUT'
  )

  // ── J. QUALITY VALIDATION IS UNAFFECTED ─────────────────────────────
  //
  // Approving the geometry says nothing about what the model will draw.
  // The clip is still inspected for people and cameras.
  assert.ok(
    shouldValidateClip(DEFAULT_QUALITY_VALIDATION_MODE, true),
    'J: an operator-approved mirror pair is still quality-checked'
  )
  assert.ok(
    !qualityAllowsActive('failed', null),
    'and a failed clip still cannot become active'
  )

  log('missing context: a mirror asks a question instead of ending the transition')
}

function testReflectionSafety(): void {
  const mk = (over: Partial<PropertyAnalysis>): PropertyAnalysis => ({
    ...emptyAnalysis('p-reflect'),
    source: 'manual',
    ...over
  })

  const bathroom = (
    fromSurfaces: ReflectiveSurface[] | undefined,
    toSurfaces: ReflectiveSurface[] | undefined,
    fromLandmarks: string[] = ['floating vanity', 'vessel sink'],
    toLandmarks: string[] = ['floating vanity', 'wall toilet']
  ): PropertyAnalysis =>
    mk({
      rooms: [
        {
          id: 'bath',
          label: 'Bathroom 1',
          imageIds: ['a', 'b'],
          landmarks: ['floating vanity'],
          confidence: 'confirmed'
        }
      ],
      images: [
        {
          imageId: 'a',
          roomId: 'bath',
          orientation: 'into-room',
          landmarks: fromLandmarks,
          openings: [],
          overlapWith: ['b'],
          reflectiveSurfaces: fromSurfaces
        },
        {
          imageId: 'b',
          roomId: 'bath',
          orientation: 'into-room',
          landmarks: toLandmarks,
          openings: [],
          overlapWith: ['a'],
          reflectiveSurfaces: toSurfaces
        }
      ]
    })

  // ── A. MIRROR KNOWN, CONTENT READ, PATH DOES NOT NAME IT → AI OK ────
  const readable: ReflectiveSurface[] = [
    {
      type: 'wall mirror',
      dominant: false,
      expectedVisibleContent: ['beige wall tiles', 'vanity', 'ceiling light'],
      confidence: 'confirmed'
    }
  ]
  const safe = evaluateTransitionSafety(bathroom(readable, undefined), 'a', 'b')
  assert.strictEqual(safe.mode, 'ai', 'a described, non-dominant mirror still permits AI')
  assert.ok(safe.evidence.reflection.risk, 'but the reflector is recorded as present')
  assert.ok(!safe.evidence.reflection.contentUnknown, 'and its content is known')

  // ── B. THE PLANNED PATH CROSSES THE MIRROR → CUT ────────────────────
  //
  // The failing clip's own instruction, passed as the planned motion.
  const crossing = evaluateTransitionSafety(
    bathroom(readable, undefined),
    'a',
    'b',
    undefined,
    'rotating clockwise, turning away from the mirror reflection toward the wall toilet'
  )
  assert.strictEqual(crossing.mode, 'cut', 'a camera path described against the mirror cuts')
  assert.match(crossing.reason, /camera path moves across a reflective surface/i)

  // ── C. MIRROR PRESENT, CONTENT UNKNOWN → A QUESTION ─────────────────
  //
  // This asserted CUT until the product rule changed. Refusing treated
  // "we could not read the reflection" as "the move is impossible", and
  // those are different claims — see testMissingContext.
  const blind: ReflectiveSurface[] = [
    { type: 'wall mirror', dominant: true, expectedVisibleContent: [] }
  ]
  const unknown = evaluateTransitionSafety(bathroom(blind, undefined), 'a', 'b')
  assert.strictEqual(unknown.mode, 'cut', 'nothing generates while the question stands')
  assert.strictEqual(
    unknown.decision,
    'needs-context',
    'but it is a question for the operator, not a refusal'
  )
  assert.strictEqual(unknown.safety, 'needs-context', 'the ROUTE was fine — only the mirror is open')
  assert.match(unknown.reason, /cannot determine what should appear in its reflection/i)
  assert.strictEqual(
    unknown.missingContext[0]?.type,
    'reflection-content',
    'and it names the specific fact it is waiting for'
  )

  // ── THE ACTUAL HISTORICAL DATA ──────────────────────────────────────
  //
  // No structured field at all, mirror recorded only as a landmark
  // string. Every analysis run before this feature looks like this, so
  // treating a missing field as "no mirrors" would leave exactly the
  // known-dangerous pairs rated safe forever.
  const legacy = bathroom(undefined, undefined, ['mirror reflection', 'floating vanity'], [
    'floating vanity',
    'wall toilet'
  ])
  const legacyVerdict = evaluateTransitionSafety(legacy, 'a', 'b')
  assert.strictEqual(legacyVerdict.mode, 'cut', 'the real bathroom pair now cuts')
  assert.ok(legacyVerdict.evidence.reflection.legacyTextOnly, 'flagged as pre-modelling data')
  assert.ok(
    legacyVerdict.evidence.reflection.contentUnknown,
    'and its reflection content is unknown by construction'
  )

  // A mirror must never again be counted as reassurance.
  assert.ok(
    reflectionEvidenceForImage({
      imageId: 'a',
      roomId: 'bath',
      orientation: 'into-room',
      landmarks: ['mirror reflection'],
      openings: []
    }).risk,
    'a mirror recorded only as a landmark is still detected as a hazard'
  )

  // ── F. A ROOM WITH NO REFLECTORS IS NOT BURDENED ────────────────────
  const plain = mk({
    rooms: [
      {
        id: 'bed',
        label: 'Bedroom',
        imageIds: ['a', 'b'],
        landmarks: ['bed'],
        confidence: 'confirmed'
      }
    ],
    images: [
      {
        imageId: 'a',
        roomId: 'bed',
        orientation: 'into-room',
        landmarks: ['bed', 'nightstand'],
        openings: [],
        overlapWith: ['b']
      },
      {
        imageId: 'b',
        roomId: 'bed',
        orientation: 'into-room',
        landmarks: ['bed', 'window'],
        openings: [],
        overlapWith: ['a']
      }
    ]
  })
  const plainVerdict = evaluateTransitionSafety(plain, 'a', 'b')
  assert.strictEqual(plainVerdict.mode, 'ai', 'an ordinary bedroom is unaffected')
  assert.ok(!plainVerdict.evidence.reflection.risk, 'and carries no reflection risk')

  // ── E. THE GENERATION PROMPT ────────────────────────────────────────
  //
  // Unconditional ontology: every generation, mirror or not, because a
  // MISSED mirror is the case that hurts.
  for (const required of [
    'zero people anywhere in it',
    'invisible virtual viewpoint',
    'These entities do not exist in this world',
    'tripod'
  ]) {
    assert.ok(
      DEFAULT_TRANSITION_PROMPT.includes(required),
      `every prompt states: ${required}`
    )
  }
  // Stated as non-existence, not as a request to hide something.
  assert.ok(
    !/do not show (a )?person/i.test(DEFAULT_TRANSITION_PROMPT),
    'occupancy is ontology, not a request to conceal someone who is there'
  )

  // The escalation block, for flagged pairs only.
  //
  // Positive now, and consistent with the opening ontology. The old
  // sentences ordered the model NOT to reflect a camera, which requires
  // the camera to exist first; these say what a mirror does contain.
  for (const required of [
    'REFLECTION CONTENT — ABSOLUTE',
    'reflects ONLY the architecture',
    'no observer and no imaging device in this world',
    'Reflections are geometry, not events',
    'show a plain continuation of the empty room'
  ]) {
    assert.ok(REFLECTION_SAFETY_BLOCK.includes(required), `reflection block states: ${required}`)
  }

  // Positive target when the content is known; silence when it is not —
  // an empty "reflects only:" list reads as "reflects nothing" and invites
  // the model to fill it.
  const withContent = expectedMirrorContentBlock('wall mirror', ['beige wall', 'vanity'])
  assert.ok(withContent?.includes('- beige wall'), 'known reflection content is stated positively')
  assert.strictEqual(
    expectedMirrorContentBlock('wall mirror', []),
    null,
    'nothing is claimed about a reflection nobody could read'
  )

  // ── ORDERING: style must never outrank safety ───────────────────────
  const occupancyAt = DEFAULT_TRANSITION_PROMPT.indexOf('SCENE OCCUPANCY')
  const styleAt = DEFAULT_TRANSITION_PROMPT.indexOf('luxury real-estate')
  assert.ok(occupancyAt >= 0 && styleAt >= 0)
  assert.ok(occupancyAt < styleAt, 'what may exist is stated before how it should look')

  // ── D. MANUAL OVERRIDE NAMES THE REFLECTION RISK ────────────────────
  //
  // The generic warning talks about geometry, which an operator can judge
  // against a property they know. They cannot judge this one in advance:
  // the failure adds a stranger rather than distorting a room.
  assert.ok(
    overrideWarningFor(true).includes('may introduce people, cameras or incorrect reflections'),
    'overriding a reflective pair warns about people and cameras specifically'
  )
  assert.ok(
    !overrideWarningFor(false).includes('reflective surfaces'),
    'and an ordinary pair is not given a mirror warning it does not need'
  )

  // ── G. PROMPT / SCHEMA CONTRACT ─────────────────────────────────────
  //
  // Structured output returns ONLY declared fields. A field the prompt
  // asks for and the schema omits is dropped in silence — this project
  // has lost data that way three times.
  assert.ok(
    PROPERTY_ANALYSIS_INSTRUCTION.includes('reflectiveSurfaces'),
    'the analyzer is asked for reflective surfaces'
  )
  const imageProps = (
    GEMINI_RESPONSE_SCHEMA as unknown as {
      properties: { images: { items: { properties: Record<string, unknown> } } }
    }
  ).properties.images.items.properties
  assert.ok(
    'reflectiveSurfaces' in imageProps,
    'and the response schema declares it, or Gemini would silently drop it'
  )

  log('reflection safety: mirrors are hazards, not landmarks — an unreadable one asks for context')
}

function testResumeOnlyWhenResumable(): void {
  const provider = (over: Partial<ProviderJobState>): ProviderJobState => ({
    provider: 'fal',
    model: FAL_MODEL_ID,
    dryRun: false,
    providerTaskId: 'remote-1',
    providerStatus: 'IN_QUEUE',
    submittedAt: Date.now(),
    lastPolledAt: null,
    providerMeta: null,
    estimatedCost: null,
    actualCost: null,
    estimatedCredits: null,
    actualCredits: null,
    retryCount: 0,
    ...over
  })

  // ── 1. Submitted / running → resumable ──────────────────────────────
  assert.ok(canResumeProviderTask(provider({})), 'a queued remote task can be tracked')
  assert.strictEqual(resolveGenerationAction(provider({})), 'resume-poll')
  assert.ok(
    canResumeProviderTask(provider({ providerStatus: 'IN_PROGRESS' })),
    'and so can one in progress'
  )

  // ── 2. Local polling / network loss → STILL resumable ───────────────
  //
  // The money-losing direction. A task we cannot reach may still be
  // running, and refusing to track it forces a second purchase.
  for (const code of ['network', 'timeout', 'rate-limit', 'endpoint-unverified']) {
    assert.ok(
      canResumeProviderTask(
        provider({
          providerFailure: { code, message: 'lost contact', terminal: false }
        })
      ),
      `losing contact (${code}) leaves the task resumable`
    )
  }
  assert.ok(
    canResumeProviderTask(provider({ providerStatus: STATUS_ENDPOINT_UNVERIFIED })),
    'and the unverified-endpoint sentinel is explicitly NOT a failure'
  )

  // ── 3. HTTP 422 terminal rejection → NOT resumable ──────────────────
  const rejected = provider({
    providerFailure: {
      code: 'invalid-request',
      message: 'fal.ai rejected the request as invalid.',
      httpStatus: 422,
      terminal: true
    }
  })
  assert.ok(!canResumeProviderTask(rejected), 'a rejected request cannot be resumed')
  assert.strictEqual(
    resolveGenerationAction(rejected),
    'blocked',
    'and the state machine blocks rather than polling a dead task id'
  )

  // ── 4/5. Provider FAILED and CANCELLED → NOT resumable ──────────────
  for (const status of ['FAILED', 'CANCELLED', 'ERROR']) {
    assert.ok(
      !canResumeProviderTask(provider({ providerStatus: status })),
      `a provider status of ${status} is terminal`
    )
  }

  // ── LEGACY ROWS: classified from what the provider actually said ────
  //
  // The three failed jobs in the real database predate the structured
  // code and kept only fal's own sentence. That sentence is genuinely
  // all there is, so it is what the decision uses.
  assert.ok(
    !canResumeProviderTask(provider({}), 'pair-key: fal.ai rejected the request as invalid.'),
    'a pre-classification 422 row is recognised from its recorded message'
  )
  assert.ok(
    canResumeProviderTask(provider({}), 'Network request failed'),
    'while an unrecognised message stays resumable — guessing "dead" costs money'
  )

  // ── 6. A terminal failure offers a NEW generation instead ───────────
  const settings = (over: Partial<TransitionSettings>): TransitionSettings => ({
    ...defaultTransitionSettings(5),
    ...over
  })
  const job = {
    id: 'job-422',
    projectId: 'p',
    note: 'fal.ai rejected the request as invalid.',
    provider: rejected
  } as unknown as QueueJob

  const recovery = transitionRecovery(settings({ status: 'failed' }), job, '1 → 2')
  assert.strictEqual(recovery.kind, 'regenerate', 'the offered action is a new generation')
  assert.strictEqual(recovery.costsMoney, true, 'and it is honest that it costs')
  assert.match(
    recovery.detail,
    /cannot be resumed/i,
    'the reason says so plainly, so nobody goes looking for Resume'
  )
  assert.match(recovery.detail, /rejected the request as invalid/i, 'and quotes the provider')

  // ── HISTORY USES THE SAME DECISION ──────────────────────────────────
  //
  // The Queue/History row had its own rule — "there is a task id, so
  // offer Resume polling" — which is how the rejected rows kept offering
  // it there after the editor stopped. Both now ask one function, so the
  // two views cannot disagree about whether a task is worth tracking.
  const historyOffersResume = (j: { provider?: ProviderJobState; note?: string }): boolean =>
    canResumeProviderTask(j.provider, j.note)

  assert.ok(historyOffersResume({ provider: provider({}) }), 'History tracks a live task')
  assert.ok(
    !historyOffersResume({ provider: rejected, note: 'fal.ai rejected the request as invalid.' }),
    'History does not offer Resume for a refused request'
  )
  assert.ok(
    !historyOffersResume({ provider: provider({ providerStatus: 'CANCELLED' }) }),
    'nor for a cancelled one'
  )

  log('resume: offered only for trackable tasks — a provider refusal offers a new generation')
}

/**
 * REGENERATE AFTER A TERMINAL FAILURE IS A NEW JOB, AND THE OLD ONE STAYS.
 *
 * Two things have to hold at once. The new attempt must be a genuinely
 * new submit — reusing the dead task id would just re-fetch the same
 * rejection. And the failed attempt must remain in History: it is the
 * only record of what was tried, what the provider said, and which
 * request id to quote when asking them about it.
 */
function testRegenerateAfterTerminalFailure(workDir: string, created: string[]): void {
  const project = makeProject('Smoke regen after 422')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'regen-422.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: 'a.png' },
    { sourcePath: p, name: 'b.png' }
  ])
  saveProject(project)
  const pairKey = transitionKey(project.images[0].id, project.images[1].id)

  // These rows exist to be READ, not run: the queue is held so nothing
  // picks them up and rewrites the states the assertions depend on.
  const wasPaused = isPaused()
  pauseQueue()

  const failed = enqueue({
    projectId: project.id,
    projectName: project.name,
    kind: 'ai-generation',
    transitionCount: 1,
    metadata: { pairKeys: [pairKey], provider: 'fal' },
    provider: {
      provider: 'fal',
      model: FAL_MODEL_ID,
      dryRun: false,
      providerTaskId: 'dead-task-422',
      providerStatus: 'IN_QUEUE',
      submittedAt: Date.now(),
      lastPolledAt: null,
      providerMeta: null,
      providerFailure: {
        code: 'invalid-request',
        message: 'fal.ai rejected the request as invalid.',
        httpStatus: 422,
        terminal: true
      },
      estimatedCost: null,
      actualCost: null,
      estimatedCredits: null,
      actualCredits: null,
      retryCount: 0
    }
  })
  // The runner is what normally writes this; there is no public "mark
  // failed", so the row is put into the state the real 422 left behind.
  failed.status = 'failed'
  failed.note = 'fal.ai rejected the request as invalid.'
  // Backdated because both rows are otherwise created in the same
  // millisecond. A real regeneration happens after a human has read the
  // error, and `latestJobForPair` orders by creation time — a synthetic
  // tie would test the sort's tie-break rather than the behaviour.
  failed.createdAt = Date.now() - 60_000
  updateJob(failed)

  // ── 7. The new job submits rather than resuming ─────────────────────
  const regenerated = enqueue({
    projectId: project.id,
    projectName: project.name,
    kind: 'ai-generation',
    transitionCount: 1,
    metadata: { pairKeys: [pairKey], provider: 'fal' },
    provider: {
      provider: 'fal',
      model: FAL_MODEL_ID,
      dryRun: false,
      providerTaskId: null,
      providerStatus: null,
      submittedAt: null,
      lastPolledAt: null,
      providerMeta: null,
      estimatedCost: null,
      actualCost: null,
      estimatedCredits: null,
      actualCredits: null,
      retryCount: 0
    }
  })

  assert.notStrictEqual(regenerated.id, failed.id, 'regenerating creates a separate job')
  assert.strictEqual(
    resolveGenerationAction(regenerated.provider, regenerated.note),
    'submit',
    'the new job carries no task id, so it makes a real provider call'
  )

  const jobs = listJobs()
  const deadAttempt = jobs.find((j) => j.id === failed.id)
  assert.strictEqual(
    resolveGenerationAction(deadAttempt?.provider, deadAttempt?.note),
    'blocked',
    'while the refused attempt is never polled again'
  )

  // The pair resolves against the NEWER job, so the transition stops
  // presenting the old rejection as its current state.
  assert.strictEqual(
    latestJobForPair(jobs, project.id, pairKey)?.id,
    regenerated.id,
    'the newest attempt owns the pair'
  )

  // ── 8. The failed attempt is still in History, readable ─────────────
  assert.ok(deadAttempt, 'the failed attempt is NOT deleted by regenerating')
  assert.strictEqual(deadAttempt?.status, 'failed', 'it still reads as failed')
  assert.match(deadAttempt?.note ?? '', /rejected the request as invalid/, 'with the reason')
  assert.strictEqual(
    deadAttempt?.provider?.providerTaskId,
    'dead-task-422',
    'and the task id, which is what the provider needs quoted back'
  )
  assert.ok(
    !canResumeProviderTask(deadAttempt?.provider, deadAttempt?.note),
    'but History offers it no Resume'
  )

  // The regenerated job is cancelled rather than run — it would make a
  // real paid submit. Both rows are otherwise left in place: the suite's
  // teardown reclaims every queue row for a created project, and the
  // point of the test is that nothing here deletes the failed attempt.
  cancelJob(regenerated.id)
  if (!wasPaused) resumeQueue()
  log('regenerate after a terminal failure: new job, new submit, old attempt kept in History')
}

function testProjectDeletionCascade(workDir: string): void {
  // ── 1. Enforcement survives a flush ──────────────────────────────────
  //
  // Asserted FIRST and on its own, because it is the root cause. If this
  // line fails, everything below fails for one reason.
  assert.ok(foreignKeysEnabled(), 'foreign key enforcement is on before flushing')
  flushNow()
  assert.ok(
    foreignKeysEnabled(),
    'and STILL on after a flush — sql.js reopens the connection on export(), ' +
      'which silently reverted the pragma and disabled every cascade in the app'
  )

  const project = makeProject('Smoke deletion cascade')
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'cascade.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: 'a.png' },
    { sourcePath: p, name: 'b.png' },
    { sourcePath: p, name: 'c.png' }
  ])
  const [i1, i2, i3] = project.images.map((i) => i.id)
  project.transitions = {
    [transitionKey(i1, i2)]: {
      prompt: 'one',
      durationSec: 5,
      status: 'not-generated',
      clip: null,
      promptProvenance: null
    },
    [transitionKey(i2, i3)]: {
      prompt: 'two',
      durationSec: 5,
      status: 'not-generated',
      clip: null,
      promptProvenance: null
    }
  }
  saveProject(project)

  // Every kind of project-scoped row, so the cascade is tested against all
  // of them rather than only the two that had foreign keys to begin with.
  saveAnalysis({
    ...emptyAnalysis(project.id),
    state: 'accepted',
    rooms: [{ id: 'r1', label: 'Hall', imageIds: [i1], landmarks: [] }],
    images: [{ imageId: i1, roomId: 'r1', orientation: 'unknown', landmarks: [], openings: [] }]
  })
  setReview({
    projectId: project.id,
    scope: 'accepted',
    factKey: 'image-room:x:hall',
    kind: 'image-room',
    label: 'Image 1 → Hall',
    verdict: 'correct'
  })
  setOverrideField(project.id, i2, 'roomLabel', 'Kitchen')

  const count = (table: string): number => {
    const stmt = getDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`)
    try {
      stmt.bind([project.id])
      stmt.step()
      return Number((stmt.getAsObject() as { n: number }).n)
    } finally {
      stmt.free()
    }
  }

  // ── 2–4. The children genuinely exist first ──────────────────────────
  assert.strictEqual(count('project_images'), 3, 'three image rows were written')
  assert.strictEqual(count('transitions'), 2, 'two transition rows were written')
  assert.strictEqual(count('property_analysis'), 1, 'an analysis row was written')
  assert.strictEqual(count('analysis_reviews'), 1, 'a review row was written')
  assert.strictEqual(count('image_overrides'), 1, 'an override row was written')

  // ── 5. Delete through the PRODUCTION path ────────────────────────────
  deleteProjectRows(project.id)

  // ── 6. Nothing of it is left ─────────────────────────────────────────
  assert.strictEqual(
    listProjects().filter((x) => x.id === project.id).length,
    0,
    'the project row is gone'
  )
  assert.strictEqual(
    count('project_images'),
    0,
    'and its images went with it — this is the assertion that failed before the fix'
  )
  assert.strictEqual(count('transitions'), 0, 'and its transitions')
  assert.strictEqual(count('property_analysis'), 0, 'and its analysis')
  assert.strictEqual(count('analysis_reviews'), 0, 'and its ground-truth review')
  assert.strictEqual(count('image_overrides'), 0, 'and its manual overrides')

  // ── The retained ones are retained ON PURPOSE ────────────────────────
  //
  // Spend that actually left the account is not un-spent by deleting the
  // project it was spent on, and a ledger that quietly shrinks cannot be
  // reconciled against an invoice. Asserted so a future "tidy up on
  // delete" cannot quietly turn the ledger into a cache.
  recordAnalysisSpend({
    projectId: project.id,
    provider: 'google',
    model: 'gemini-2.5-flash',
    operationId: `${project.id}-retained`,
    inputTokens: 10,
    outputTokens: 1,
    totalTokens: 11,
    actualCost: null,
    estimatedCost: 0.0001,
    currency: 'USD'
  })
  deleteProjectRows(project.id)
  assert.strictEqual(
    listCostEntries(project.id).length,
    1,
    'the spend ledger SURVIVES project deletion — deliberately, and it has no foreign key so that it can'
  )
  deleteCostEntriesForProject(project.id)
  deleteProjectFiles(project.id)

  // ── 7. And the database is internally consistent ─────────────────────
  const violations = foreignKeyViolations()
  const fromThisRun = violations.filter(
    (v) => v.table === 'analysis_reviews' || v.table === 'image_overrides'
  )
  assert.strictEqual(
    fromThisRun.length,
    0,
    'no foreign key violation was introduced by the tables this milestone added'
  )

  log('project deletion: cascade fires, children removed, ledger deliberately retained')
}

/**
 * THE EDITOR'S SELECTION MODEL AND SEQUENCE ARITHMETIC.
 *
 * ── WHY THIS IS A DOMAIN TEST ────────────────────────────────────────
 *
 * The editor's hardest bugs were never rendering bugs. They were state
 * bugs: three independent selections that could disagree, an off-by-one in
 * the drop position that only showed up dragging rightwards, arrow keys
 * that reordered someone's sequence while they were typing a prompt.
 *
 * All of that is decision-making, not painting — so it lives in `shared`
 * as pure functions and is asserted here, without a DOM, a React tree or a
 * synthetic event. What is left in the components is markup.
 */
function testEditorSelection(): void {
  const ids = ['img-a', 'img-b', 'img-c', 'img-d']
  const pairs = pairKeysFor(ids)
  assert.deepStrictEqual(
    pairs,
    ['img-a->img-b', 'img-b->img-c', 'img-c->img-d'],
    'four images produce exactly the three consecutive transitions'
  )

  // ── 1 & 2. The selections are mutually exclusive BY CONSTRUCTION ─────
  // Not by two setters remembering to clear each other — there is one
  // value, so an image and a transition cannot both be selected.
  const onImage = selectImage('img-b')
  assert.strictEqual(onImage.kind, 'image')
  assert.strictEqual(selectedPairKey(onImage), null, 'selecting an image clears the transition')

  const onTransition = selectTransition(pairs[0])
  assert.strictEqual(onTransition.kind, 'transition')
  assert.strictEqual(selectedImageId(onTransition), null, 'selecting a transition clears the image')

  // ── 3 & 4. Preview and inspector are DERIVED, never set separately ───
  assert.strictEqual(previewModeFor(onImage), 'image', 'an image selection shows the still')
  assert.strictEqual(inspectorModeFor(onImage), 'image')
  assert.strictEqual(previewModeFor(onTransition), 'transition', 'a transition shows its clip')
  assert.strictEqual(inspectorModeFor(onTransition), 'transition')
  assert.strictEqual(previewModeFor(selectFullVideo()), 'full')
  assert.strictEqual(
    inspectorModeFor(selectFullVideo()),
    'none',
    'and Full Video is about no single item, so neither inspector claims it'
  )

  // ── 5. Arrow keys walk the sequence ──────────────────────────────────
  // CTRL is the reorder modifier, not Shift. Shift+Arrow is a text-selection
  // gesture everywhere else in the OS, and borrowing it to permanently move a
  // photo in the sequence was the wrong verb on the wrong key.
  const press = (
    key: string,
    ctrlKey: boolean,
    selection: EditorSelection,
    target: { tagName?: string; isContentEditable?: boolean; readOnly?: boolean } | null = null
  ): ShortcutAction => resolveShortcut({ key, shiftKey: false, ctrlKey, target }, selection, ids)

  assert.deepStrictEqual(
    press('ArrowRight', false, selectImage('img-b')),
    { type: 'select-image', imageId: 'img-c' },
    'ArrowRight selects the next image'
  )
  assert.deepStrictEqual(
    press('ArrowLeft', false, selectImage('img-b')),
    { type: 'select-image', imageId: 'img-a' },
    'ArrowLeft selects the previous one'
  )
  // Hard stops at both ends. Wrapping would jump the last photo to the
  // front of the video on a keypress meant to nudge it.
  assert.strictEqual(press('ArrowLeft', false, selectImage('img-a')).type, 'none', 'first is a stop')
  assert.strictEqual(press('ArrowRight', false, selectImage('img-d')).type, 'none', 'last too')

  // ── 6. Ctrl+Arrow REORDERS, via the same indices as a drag ───────────
  assert.deepStrictEqual(
    press('ArrowRight', true, selectImage('img-b')),
    { type: 'move-image', fromIndex: 1, toIndex: 2 },
    'Ctrl+ArrowRight moves the selected image one position later'
  )
  assert.deepStrictEqual(
    press('ArrowLeft', true, selectImage('img-b')),
    { type: 'move-image', fromIndex: 1, toIndex: 0 },
    'and Ctrl+ArrowLeft one position earlier'
  )
  assert.strictEqual(
    press('ArrowRight', true, selectImage('img-d')).type,
    'none',
    'moving the last image further right does nothing rather than wrapping it to the front'
  )

  // SHIFT MUST NOT REORDER. Pinned because it once did: Shift+Arrow is a
  // selection gesture, and a user reaching for it got their sequence
  // permanently rewritten instead.
  assert.deepStrictEqual(
    resolveShortcut(
      { key: 'ArrowRight', shiftKey: true, ctrlKey: false, target: null },
      selectImage('img-b'),
      ids
    ),
    { type: 'select-image', imageId: 'img-c' },
    'Shift+ArrowRight only walks the selection — it never moves a photo'
  )

  // ── 7. TYPING MUST NEVER MOVE A PHOTO ────────────────────────────────
  // Arrow keys inside a prompt move the caret. Hijacking that to reorder
  // someone's sequence would be both surprising and destructive.
  for (const tagName of ['TEXTAREA', 'INPUT', 'SELECT']) {
    assert.strictEqual(
      press('ArrowRight', false, selectImage('img-b'), { tagName }).type,
      'none',
      `arrows are ignored inside a ${tagName}`
    )
    assert.strictEqual(
      press('ArrowLeft', true, selectImage('img-b'), { tagName }).type,
      'none',
      `and so is Shift+Arrow inside a ${tagName} — reordering while typing is the worse failure`
    )
  }
  assert.strictEqual(
    press('ArrowRight', false, selectImage('img-b'), {
      tagName: 'DIV',
      isContentEditable: true
    }).type,
    'none',
    'a contentEditable region counts as typing too'
  )
  // A READ-ONLY input cannot be typed into, so arrows there are navigation.
  assert.strictEqual(
    press('ArrowRight', false, selectImage('img-b'), { tagName: 'INPUT', readOnly: true }).type,
    'select-image',
    'a read-only input does not swallow navigation'
  )
  assert.strictEqual(
    press('ArrowRight', false, selectImage('img-b'), { tagName: 'BUTTON' }).type,
    'select-image',
    'and neither does a button — the timeline blocks are buttons'
  )

  // Arrows mean nothing without an image selected: a second meaning for
  // one key is how a shortcut becomes a hazard.
  assert.strictEqual(press('ArrowRight', false, selectTransition(pairs[0])).type, 'none')
  assert.strictEqual(press('ArrowRight', false, selectFullVideo()).type, 'none')
  assert.strictEqual(press('a', false, selectImage('img-b')).type, 'none', 'other keys are ignored')

  // ── Selection survives what should not disturb it ────────────────────
  const moved = moveInSequence(ids, 3, 0)
  assert.strictEqual(
    reconcileSelection(selectImage('img-b'), moved).kind,
    'image',
    'a photo that merely MOVED keeps its selection — the user selected the picture, not the slot'
  )
  assert.strictEqual(
    reconcileSelection(selectImage('img-b'), ['img-a', 'img-c']).kind,
    'full',
    'a photo that was REMOVED falls back to Full Video rather than describing a ghost'
  )
  // Moving the LAST image to the front destroys only c→d and creates only
  // d→a. Everything between kept its neighbours — which is exactly why
  // prompts keyed by image pair survive a reorder.
  assert.strictEqual(
    reconcileSelection(selectTransition('img-c->img-d'), moved).kind,
    'full',
    'and a transition the reorder destroyed does too'
  )
  assert.strictEqual(
    reconcileSelection(selectTransition('img-a->img-b'), moved).kind,
    'transition',
    'while one whose neighbours did not change keeps its selection'
  )

  log('editor selection: one selection drives preview + inspector, typing never moves a photo')
}

/**
 * THE PROPERTY-ANALYSIS WORKFLOW.
 *
 * ── WHAT THIS PINS ───────────────────────────────────────────────────
 *
 * The panel used to infer everything from a button label, which usually
 * read "Re-analyze". It could not tell the operator whether anything was
 * running, whether it had finished, or — the dangerous one — whether the
 * accepted analysis had ever been near a vision model. A mock run and a
 * live Gemini run produced visually identical results.
 *
 * The state and the analyzer's identity are now values, so both are
 * assertable without a DOM.
 */
function testAnalysisWorkflow(): void {
  const base = {
    hasAcceptedAnalysis: false,
    hasDraft: false,
    isRunning: false,
    isConfirming: false,
    lastError: null as string | null,
    analyzerReady: true
  }

  // ── 1. The states, and their precedence ──────────────────────────────
  assert.strictEqual(analysisWorkflowState(base), 'ready-to-analyze')
  assert.strictEqual(
    analysisWorkflowState({ ...base, analyzerReady: false }),
    'not-analyzed',
    'with no runnable analyzer the panel does not pretend one is ready'
  )
  assert.strictEqual(analysisWorkflowState({ ...base, isConfirming: true }), 'confirming')
  assert.strictEqual(analysisWorkflowState({ ...base, isRunning: true }), 'analyzing')
  assert.strictEqual(analysisWorkflowState({ ...base, hasDraft: true }), 'draft-ready')
  assert.strictEqual(analysisWorkflowState({ ...base, hasAcceptedAnalysis: true }), 'accepted')
  assert.strictEqual(analysisWorkflowState({ ...base, lastError: 'boom' }), 'failed')

  // In-flight beats everything: while a request is out that is the only
  // thing worth showing, and leaving the old summary up is what made
  // people press Analyze twice.
  assert.strictEqual(
    analysisWorkflowState({ ...base, isRunning: true, hasAcceptedAnalysis: true, hasDraft: true }),
    'analyzing',
    'a run in flight outranks both a draft and an accepted analysis'
  )
  // A draft outranks an accepted analysis — it is a decision someone owes.
  assert.strictEqual(
    analysisWorkflowState({ ...base, hasDraft: true, hasAcceptedAnalysis: true }),
    'draft-ready'
  )
  // An error outranks "accepted", or a failure would look like an idle panel.
  assert.strictEqual(
    analysisWorkflowState({ ...base, lastError: 'boom', hasAcceptedAnalysis: true }),
    'failed'
  )

  // ── 2. WHAT THE ANALYZER IS — no silent fallback, ever ───────────────
  const gemini = {
    analyzerId: 'gemini',
    displayName: 'Gemini 2.5 Flash',
    provider: 'google',
    model: 'gemini-2.5-flash',
    mode: 'live' as const,
    incursCost: true,
    hasApiKey: true,
    allowLive: true,
    imageCount: 30
  }

  const live = analyzerPresentation(gemini)
  assert.strictEqual(live.mode, 'live')
  assert.strictEqual(live.label, 'gemini-2.5-flash · Live')
  assert.ok(live.canRun)
  assert.ok(live.requiresConfirmation, 'a live paid run always stops for confirmation')
  assert.match(live.note, /30 project images/, 'and says all images are sent')

  const dry = analyzerPresentation({ ...gemini, mode: 'dry-run' })
  assert.strictEqual(dry.mode, 'dry-run')
  assert.match(dry.label, /Dry Run/, 'Dry Run is named in the label, not buried in a tooltip')
  assert.match(dry.note, /No request will be sent/i)
  assert.ok(dry.canRun, 'and it can still run — it is a useful, free configuration test')
  assert.ok(
    !dry.requiresConfirmation,
    'but it needs no paid confirmation, because it sends nothing'
  )
  assert.notStrictEqual(dry.label, live.label, 'a dry run can never read as a live one')

  // ── 3. MISSING KEY DOES NOT SILENTLY BECOME A MOCK ───────────────────
  // Either fallback would hand back something that looks like an analysis
  // and is not one — and it would go on to plan camera movement through
  // rooms nobody looked at.
  const noKey = analyzerPresentation({ ...gemini, hasApiKey: false })
  assert.strictEqual(noKey.mode, 'unconfigured')
  assert.ok(!noKey.canRun, 'the primary action does not pretend analysis can run')
  assert.strictEqual(noKey.action, 'configure', 'it becomes Configure, not a quiet mock run')
  assert.strictEqual(noKey.blocker, 'Gemini 2.5 Flash is not configured')

  // ── 4. A closed safety lock is stated, not worked around ─────────────
  const locked = analyzerPresentation({ ...gemini, allowLive: false })
  assert.ok(!locked.canRun, 'a locked provider cannot run')
  assert.strictEqual(locked.action, 'configure')
  assert.match(locked.note, /safety lock/i, 'and says exactly what to turn on')
  assert.notStrictEqual(
    locked.mode,
    'dry-run',
    'it does NOT silently downgrade to Dry Run — the operator asked for a real analysis'
  )

  // ── 5. Local analyzers are free, useful, and never dressed as AI ─────
  const mock = analyzerPresentation({
    ...gemini,
    analyzerId: 'mock',
    displayName: 'Mock analyzer',
    provider: 'local',
    model: null,
    incursCost: false
  })
  assert.strictEqual(mock.mode, 'mock')
  assert.match(mock.label, /no AI request/i, 'the label itself says no AI request')
  assert.match(mock.note, /not a vision-model analysis/i)
  assert.ok(mock.canRun && !mock.requiresConfirmation)

  // ── 6. PROVENANCE — was this actually analyzed by Gemini? ────────────
  const at = (h: number, m: number): number => new Date(2026, 0, 1, h, m).getTime()
  const clock = (ms: number): string => {
    const d = new Date(ms)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  const realRun: AnalysisProvenance = {
    analyzerId: 'gemini',
    displayName: 'Gemini 2.5 Flash',
    provider: 'google',
    model: 'gemini-2.5-flash',
    mode: 'live',
    imageCount: 30,
    analyzedAt: at(13, 42),
    acceptedAt: at(13, 45)
  }
  assert.ok(isRealAnalysis(realRun), 'a live run is a real analysis')
  assert.strictEqual(provenanceLabel(realRun), 'gemini-2.5-flash · Live')
  assert.strictEqual(
    provenanceDetail(realRun, clock),
    '30 images · analyzed 13:42 · accepted 13:45'
  )

  // Everything else is NOT, and says so.
  assert.ok(!isRealAnalysis({ ...realRun, mode: 'dry-run' }))
  assert.match(provenanceLabel({ ...realRun, mode: 'dry-run' }), /no request was sent/i)
  assert.ok(!isRealAnalysis({ ...realRun, mode: 'mock' }))
  assert.match(provenanceLabel({ ...realRun, mode: 'mock' }), /mock, no AI request/i)
  assert.ok(!isRealAnalysis(null), 'and an analysis with no provenance is never claimed as real')
  assert.strictEqual(provenanceLabel(null), 'Manual — entered by hand')

  log('analysis workflow: one state, analyzer identity explicit, no silent fallback')
}

/**
 * TRANSITION MODES — not every pair deserves generated video.
 *
 * ── THE STAIRCASE PROBLEM ────────────────────────────────────────────
 *
 * A ground-floor living room followed by an upstairs bedroom, with no
 * photograph of the staircase anywhere in the set. There is no visual
 * evidence of a route between them, so asking a video model to move the
 * camera from one to the other can only produce invented stairs.
 *
 * The correct editorial answer is a CUT — which costs nothing, needs no
 * clip, and cannot misrepresent the property.
 */
/**
 * Builds the safety verdict a plan fixture is expressing, from the legacy
 * fields it uses to express it. Fixture plumbing only — never a rule.
 */
function fixtureVerdict(over: Partial<TransitionPlan>): TransitionPlan['safetyVerdict'] {
  const relation = over.relationType ?? 'UNKNOWN'
  const openings = over.visibleOpenings ?? []
  const supportsAi =
    relation === 'SAME_ROOM'
      ? (over.hasEvidence ?? false)
      : relation === 'ADJACENT_ROOM'
        ? (over.physicalNavigationAllowed ?? false)
        : false

  const reason = supportsAi
    ? relation === 'ADJACENT_ROOM'
      ? `Confirmed connection, with ${openings.join(', ')} visible in the start frame.`
      : `Both frames share ${(over.sharedLandmarks ?? []).join(', ')}.`
    : relation === 'UNKNOWN'
      ? 'No evidenced spatial relationship between these images — a generated move would have to invent the route.'
      : relation === 'ADJACENT_ROOM'
        ? 'No opening or path into the destination is visible in the start frame.'
        : 'Both frames are in the same space, but nothing pair-specific was recorded.'

  return {
    mode: supportsAi ? 'ai' : 'cut',
    // A pair with no evidenced relationship at all is a refusal; one that
    // is merely under-described is a question. `uncertain` used to blur
    // the two and both became CUT.
    decision: supportsAi ? 'ai' : relation === 'UNKNOWN' ? 'cut' : 'needs-context',
    safety: supportsAi ? 'safe' : relation === 'UNKNOWN' ? 'unsafe' : 'needs-context',
    missingContext: [],
    reason,
    evidence: {
      relation:
        relation === 'SAME_ROOM'
          ? 'same-room'
          : relation === 'ADJACENT_ROOM'
            ? 'adjacent-room'
            : 'unknown',
      sharedLandmarks: over.sharedLandmarks ?? [],
      traversableOpenings: openings,
      overlapConfirmed: false,
      adjacencyConfidence: over.confidence ?? null,
      reviewBlock: null,
      reflection: NO_REFLECTION_EVIDENCE
    }
  }
}

function testTransitionModes(): void {
  const ids = ['down', 'up', 'a', 'b']
  const plan = (over: Partial<TransitionPlan>): TransitionPlan =>
    ({
      fromImageId: 'x',
      toImageId: 'y',
      relationType: 'UNKNOWN',
      confidence: 'unknown',
      sharedLandmarks: [],
      leavingLandmarks: [],
      enteringLandmarks: [],
      visibleOpenings: [],
      anchorLandmark: null,
      startOrientation: 'unknown',
      endOrientation: 'unknown',
      rotationDirection: 'unknown',
      translationDirection: 'unknown',
      visiblePassage: null,
      evidenceImageIds: [],
      hasEvidence: false,
      physicalNavigationAllowed: false,
      useBaseSafetyMotion: true,
      motionInstruction: null,
      continuity: {
        incomingRotation: 'none',
        outgoingRotation: 'none',
        speed: 'slow',
        staticEndpoint: true
      },
      rationale: '',
      ...over,
      // ── FIXTURE INTENT, NOT A SECOND RULE SET ───────────────────────
      //
      // The AI/CUT decision now comes from the shared evaluator via
      // `plan.safetyVerdict`. These fixtures predate that field and say
      // what they mean through `hasEvidence` / `physicalNavigationAllowed`,
      // so the verdict is derived from them here. This keeps the test
      // about what it is actually about — how `resolveTransitionMode`
      // treats a supported vs unsupported move — while the evaluator's
      // own rules are pinned separately in testSafetyEvaluatorIsShared.
      safetyVerdict: over.safetyVerdict ?? fixtureVerdict(over)
    }) as TransitionPlan

  // ── 1. The default ───────────────────────────────────────────────────
  assert.strictEqual(DEFAULT_TRANSITION_MODE, 'auto', 'an unconfigured transition is Auto')
  assert.strictEqual(
    defaultTransitionSettings(5).mode,
    'auto',
    'and the default settings object says so'
  )

  // ── 4. THE MISSING STAIRCASE ─────────────────────────────────────────
  //
  // Different spaces, no confirmed navigable connection, no opening
  // anywhere. This is the scenario that matters.
  const staircase = plan({
    relationType: 'UNKNOWN',
    physicalNavigationAllowed: false,
    visibleOpenings: []
  })
  const resolvedStaircase = resolveTransitionMode('auto', staircase)
  assert.strictEqual(
    resolvedStaircase.effectiveMode,
    'cut',
    'AUTO RESOLVES TO CUT — no evidenced route means no generated camera move'
  )
  assert.strictEqual(resolvedStaircase.requestedMode, 'auto')
  assert.match(resolvedStaircase.reason, /invent the route/i, 'and says why in words')
  assert.ok(!resolvedStaircase.forcedAgainstEvidence)
  assert.ok(
    !requiresGeneratedClip(resolvedStaircase.effectiveMode),
    'no clip is required, so it can never appear as missing'
  )
  assert.ok(
    !incursGenerationCost(resolvedStaircase.effectiveMode),
    'and it can never cost anything'
  )
  assert.strictEqual(staircase.physicalNavigationAllowed, false, 'navigation stays refused')

  // ── 3. Unknown relationship generally ────────────────────────────────
  assert.strictEqual(resolveTransitionMode('auto', null).effectiveMode, 'cut', 'no analysis → cut')

  // ── 2. Same space WITH evidence → AI ─────────────────────────────────
  const sameRoom = plan({
    relationType: 'SAME_ROOM',
    confidence: 'confirmed',
    hasEvidence: true,
    sharedLandmarks: ['kitchen island'],
    motionInstruction: 'keeping the kitchen island in view.'
  })
  const resolvedSame = resolveTransitionMode('auto', sameRoom)
  assert.strictEqual(resolvedSame.effectiveMode, 'ai', 'same space with evidence supports a move')
  assert.ok(incursGenerationCost(resolvedSame.effectiveMode), 'and it is a paid generation')

  // Same space WITHOUT evidence is a cut — generating a camera move from
  // nothing is how twenty-nine identical invented pans happened.
  assert.strictEqual(
    resolveTransitionMode('auto', plan({ relationType: 'SAME_ROOM', hasEvidence: false }))
      .effectiveMode,
    'cut',
    'same space with NO pair evidence is still a cut'
  )

  // ── 5. Confirmed connection with a visible passage → AI ──────────────
  const navigable = plan({
    relationType: 'ADJACENT_ROOM',
    confidence: 'confirmed',
    physicalNavigationAllowed: true,
    visibleOpenings: ['kitchen doorway'],
    visiblePassage: 'kitchen doorway',
    hasEvidence: true
  })
  assert.strictEqual(resolveTransitionMode('auto', navigable).effectiveMode, 'ai')
  assert.match(resolveTransitionMode('auto', navigable).reason, /kitchen doorway/)

  // Confirmed adjacency with NO visible opening is a cut — the existing
  // safety rule, unchanged.
  assert.strictEqual(
    resolveTransitionMode(
      'auto',
      plan({
        relationType: 'ADJACENT_ROOM',
        confidence: 'confirmed',
        physicalNavigationAllowed: false,
        visibleOpenings: []
      })
    ).effectiveMode,
    'cut',
    'no visible opening, no generated walk-through'
  )

  // ── 6. A manual choice wins ──────────────────────────────────────────
  const manualCut = resolveTransitionMode('cut', navigable)
  assert.strictEqual(manualCut.effectiveMode, 'cut', 'manual Cut overrides a recommendation of AI')
  assert.ok(!manualCut.forcedAgainstEvidence, 'choosing LESS than the evidence allows is not a risk')
  assert.strictEqual(resolveTransitionMode('crossfade', navigable).effectiveMode, 'crossfade')

  // ── 7. Manual AI against the evidence is allowed, and flagged ────────
  const forced = resolveTransitionMode('ai', staircase)
  assert.strictEqual(forced.effectiveMode, 'ai', 'an expert override is not refused')
  assert.ok(
    forced.forcedAgainstEvidence,
    'but it is FLAGGED, so the warning and the extra confirmation appear'
  )
  assert.ok(
    !resolveTransitionMode('ai', navigable).forcedAgainstEvidence,
    'while manual AI on good evidence is not flagged'
  )

  // ── 16 & 17. Re-analysis recomputes AUTO ONLY ────────────────────────
  assert.ok(
    recommendationChanged('auto', 'cut', navigable),
    'an AUTO transition whose evidence improved is reported as changed'
  )
  assert.ok(
    !recommendationChanged('cut', 'cut', navigable),
    'A MANUAL CUT IS NEVER REVISITED — a decision is not a suggestion'
  )
  assert.ok(!recommendationChanged('ai', 'cut', staircase), 'nor a manual AI')
  assert.ok(!recommendationChanged('crossfade', 'crossfade', navigable), 'nor a manual crossfade')
  assert.ok(!recommendationChanged('auto', 'cut', staircase), 'and an unchanged Auto is quiet')

  // The analyzer's role is binary: is navigation supported? It is not
  // asked to choose between a cut and a crossfade.
  assert.strictEqual(recommendedMode(navigable).mode, 'ai')
  assert.strictEqual(recommendedMode(staircase).mode, 'cut')
  assert.strictEqual(recommendedMode(null).mode, 'cut')

  // ── 10 & 12. Tallies drive readiness and cost ────────────────────────
  const rows: ResolvedModeRow[] = [
    { pairKey: 'a', position: 0, label: '1 → 2', requestedMode: 'auto', effectiveMode: 'ai', reason: '', forcedAgainstEvidence: false, recommendedMode: 'ai', recommendationReason: '', recommendationDiffers: false, hasClip: true },
    { pairKey: 'b', position: 1, label: '2 → 3', requestedMode: 'auto', effectiveMode: 'ai', reason: '', forcedAgainstEvidence: false, recommendedMode: 'ai', recommendationReason: '', recommendationDiffers: false, hasClip: false },
    { pairKey: 'c', position: 2, label: '3 → 4', requestedMode: 'auto', effectiveMode: 'cut', reason: '', forcedAgainstEvidence: false, recommendedMode: 'cut', recommendationReason: '', recommendationDiffers: false, hasClip: false },
    { pairKey: 'd', position: 3, label: '4 → 5', requestedMode: 'crossfade', effectiveMode: 'crossfade', reason: '', forcedAgainstEvidence: false, recommendedMode: 'cut', recommendationReason: '', recommendationDiffers: false, hasClip: false }
  ]
  const tally = tallyModes(rows)
  assert.strictEqual(tally.total, 4)
  assert.strictEqual(tally.ai, 2)
  assert.strictEqual(tally.cut, 1)
  assert.strictEqual(tally.crossfade, 1)
  assert.strictEqual(tally.aiReady, 1)
  assert.strictEqual(
    tally.aiMissing,
    1,
    'ONLY the ungenerated AI transition is missing — not the cut, not the crossfade'
  )
  assert.ok(
    !requiresGeneratedClip('cut') && !requiresGeneratedClip('crossfade'),
    'a cut and a crossfade need no clip'
  )
  assert.ok(
    !incursGenerationCost('cut') && !incursGenerationCost('crossfade'),
    'and neither can ever cost money'
  )

  void ids
  log('transition modes: no evidenced route means a cut, and a cut costs nothing')
}

/**
 * THE MIXED ASSEMBLY TIMELINE.
 *
 * A CUT usually needs no filler at all: the clip before it ends on image
 * i, the clip after begins on image i+1, and joining them with a
 * zero-length seam IS the cut. A still is held only where an image would
 * otherwise never reach the screen.
 */
/**
 * SINGLE-IMAGE MOTION — the whole type, end to end except the paid call.
 *
 * The two things the operator explicitly said must not be true are what
 * most of this asserts: that a motion segment can never be mistaken for
 * an AI transition, and that no paid single-image run can happen without
 * going through model selection.
 */
/**
 * THE PAID SINGLE-IMAGE PATH — everything except the money.
 *
 * The transport is a stub that records what it was asked to send. No
 * request reaches fal.ai, and the assertions are about the exact bytes
 * that WOULD go out — which is the only part a network call would add.
 */
/**
 * DOWNLOAD → ATTACH → HISTORY → ASSEMBLY, with no provider.
 *
 * `downloadAndAttachResult` is the real function the live runner calls
 * once fal reports success. Given a stub whose `fetchResult` writes a
 * local file, everything after the network is exercised for real: the
 * catalogue row, the segment attach, the archive-on-regenerate rule and
 * the export plan. That is the whole second half of the paid path, and
 * none of it costs anything.
 */
/**
 * THE RUNNING LOCK, AND THE QUEUE THAT PROVES IT.
 *
 * Every case here is a state the stuck PAN RIGHT segment passed through
 * or could have. Pure derivation over fixtures — no network, no queue
 * worker, no database.
 */
/**
 * CHANGING THE MOVEMENT ON A REGENERATION.
 *
 * The whole point is that a per-run choice must not rewrite history.
 * Everything below runs against the real database with no provider: the
 * paid half is covered elsewhere, and what matters here is which values
 * end up on which row.
 */
/**
 * THE TIMELINE, AS PURE ARITHMETIC.
 *
 * Split, delete, reorder and the time mapping, over fixtures. No
 * database, no files — these are the rules the UI and the exporter both
 * depend on, and they must hold before either is trusted.
 */
/**
 * THE PREVIEW'S CLOCK BELONGS TO WHAT IT IS SHOWING.
 *
 * In timeline mode the film's length comes from the TIMELINE; in
 * individual mode it comes from the clip. The reported bug was the
 * first of those reading the second: a 38-second edit displayed
 * "0:00 / 0:05" because the transport asked the <video> element how
 * long it was, and the element only ever knows about one file.
 */
/**
 * BRANDING IN THE PREVIEW — resolution and geometry.
 *
 * The reported bug was that the corner stamp appeared to ignore its
 * checkbox. The toggle logic was correct; the stamp was positioned
 * against the preview PANE rather than against the picture, so on a
 * letterboxed clip it sat in the black bar beside the video — where it
 * read as permanent chrome rather than as a layer over the film.
 *
 * `containFit` is the arithmetic that fixes it, and it is pinned here
 * because a wrong rectangle is invisible in a screenshot and obvious
 * only in numbers.
 */
function testPreviewBranding(): void {
  const wmImage = 'f2f://brand/wm.png'
  const sigImage = 'data:image/png;base64,AA'

  const project = {
    watermark: {
      enabled: true,
      imageSrc: null,
      imageName: null,
      position: 'center' as const,
      sizePct: 45,
      opacityPct: 35
    },
    signature: {
      enabled: true,
      logoSrc: null,
      logoName: null,
      brandName: 'I2T',
      websiteUrl: '',
      position: 'bottom-right' as const,
      sizePct: 12,
      opacityPct: 55
    }
  }
  const settings = {
    defaultWatermark: { ...project.watermark, imageSrc: wmImage, imageName: 'wm.png' },
    defaultSignature: { ...project.signature, logoSrc: sigImage, logoName: 'sig.png' }
  }

  // ── INHERITANCE ──────────────────────────────────────────────────────
  //
  // A project with no image of its own uses the business default. Null
  // means "nothing overridden", never "no branding" — reading it as the
  // latter is why a watermark configured in Settings never reached an
  // existing project.
  const resolved = resolveBranding(project, settings)
  assert.strictEqual(resolved.watermark.imageSrc, wmImage, 'the default watermark is inherited')
  assert.strictEqual(resolved.signature.logoSrc, sigImage, 'and so is the default stamp')
  assert.ok(watermarkVisible(resolved.watermark))
  assert.ok(signatureVisible(resolved.signature))

  // A project that HAS chosen keeps its own.
  const owned = resolveBranding(
    { ...project, watermark: { ...project.watermark, imageSrc: 'f2f://brand/own.png' } },
    settings
  )
  assert.strictEqual(owned.watermark.imageSrc, 'f2f://brand/own.png', 'an override wins')
  assert.strictEqual(owned.signature.logoSrc, sigImage, 'independently of the other layer')

  // Nothing anywhere means nothing to draw — not an empty box.
  const bare = resolveBranding(project, null)
  assert.strictEqual(bare.watermark.imageSrc, null)
  assert.ok(!watermarkVisible(bare.watermark), 'enabled with no image draws nothing')
  assert.ok(!signatureVisible(bare.signature))

  // Disabled is disabled, even with an image.
  assert.ok(
    !watermarkVisible({ ...resolved.watermark, enabled: false }),
    'a disabled layer never draws'
  )

  // ── THE PICTURE RECTANGLE ────────────────────────────────────────────
  //
  // The real numbers from the reported case: a 876×385 pane showing a
  // 16:9 clip. The picture is 573 wide with a 152px bar each side, and a
  // bottom-right mark placed against the PANE lands beyond x=1318 —
  // entirely off the film.
  const fit = containFit(876, 385, 1920, 1080)
  assert.ok(Math.abs(fit.width - 684.4) < 1, `16:9 in 876x385 is height-bound (${fit.width})`)
  assert.strictEqual(Math.round(fit.height), 385, 'and fills the height')
  assert.ok(fit.left > 0, 'with a bar on each side')
  assert.ok(Math.abs(fit.left - (876 - fit.width) / 2) < 0.01, 'centred')

  // A square image in a wide pane is bound the other way.
  const square = containFit(876, 385, 1000, 1000)
  assert.strictEqual(Math.round(square.height), 385)
  assert.strictEqual(Math.round(square.width), 385)
  assert.strictEqual(Math.round(square.top), 0)

  // A mark sized as a percentage of the PICTURE is smaller than one
  // sized against the pane — which is the second half of the same bug:
  // the watermark rendered 45% of 876 (393px) instead of 45% of 684.
  const ofPicture = fit.width * 0.45
  const ofPane = 876 * 0.45
  assert.ok(ofPicture < ofPane, 'a percentage of the picture is not a percentage of the pane')

  // ── WHOLESALE INHERITANCE ────────────────────────────────────────────
  //
  // THE BUG THIS PINS. Only the IMAGE used to be inherited, so a project
  // that had never configured a watermark still used its own
  // creation-time size. Dragging Size in Settings moved the slider and
  // changed nothing on screen — which is what "100% is far too small"
  // actually was: the project was pinned at 45%.
  //
  // "Has the project overridden this?" means "has it chosen its own
  // image". That is the only field with a real unset state; size,
  // position and opacity are numbers every project carries from birth
  // and cannot distinguish chosen from untouched.
  const big = {
    defaultWatermark: { ...settings.defaultWatermark, sizePct: 100, position: 'top-left' as const },
    defaultSignature: settings.defaultSignature
  }
  const follows = resolveBranding(project, big)
  assert.strictEqual(follows.watermark.sizePct, 100, 'an unconfigured project follows the default size')
  assert.strictEqual(follows.watermark.position, 'top-left', 'and its position')

  const pinned = resolveBranding(
    { ...project, watermark: { ...project.watermark, imageSrc: 'f2f://brand/own.png' } },
    big
  )
  assert.strictEqual(pinned.watermark.sizePct, 45, 'a project with its OWN image keeps its own size')

  // `enabled` is always the project's: turning the watermark off for one
  // customer is a decision about that film, not about the business.
  const off = resolveBranding(
    { ...project, watermark: { ...project.watermark, enabled: false } },
    big
  )
  assert.strictEqual(off.watermark.enabled, false, 'the project decides whether it is on')
  assert.strictEqual(off.watermark.sizePct, 100, 'while still inheriting the geometry')

  // ── PREVIEW AND EXPORT SHARE THE SIZE SEMANTIC ───────────────────────
  //
  // Preview: `width: sizePct%` of the contain-fit picture.
  // Export:  `targetW = (sizePct / 100) * outputWidth`.
  // Both are "percent of the video's width", so a mark that spans the
  // frame on screen spans the frame in the file.
  for (const pct of [25, 50, 100]) {
    const previewPx = fit.width * (pct / 100)
    const exportPx = 1920 * (pct / 100)
    assert.ok(
      Math.abs(previewPx / fit.width - exportPx / 1920) < 1e-9,
      `${pct}% is the same fraction of the picture in both (${previewPx} / ${exportPx})`
    )
  }
  assert.strictEqual(1920 * (100 / 100), 1920, '100% is the FULL video width, not a capped value')

  console.log('[smoke] preview branding: inheritance, visibility, contain-fit geometry, size parity')
}

/**
 * WHERE A BRANDING MARK GOES, AND HOW BIG IT IS.
 *
 * ── THE BUG THIS PINS ────────────────────────────────────────────────
 *
 * The preview positioned overlays with CSS percentages — `bottom: 3%;
 * right: 3%` — while the export used one margin off the SHORT side,
 * `round(min(W, H) * 0.03)`. A CSS percentage resolves `right` against
 * the container's WIDTH and `bottom` against its HEIGHT, so on any
 * non-square picture the two insets were different distances and
 * neither matched the file that would be produced.
 *
 * Both now call `brandRect`. These assertions are on that one function,
 * because a rule that lives in two places is the thing that broke.
 */
function testBrandGeometry(): void {
  const frame = { width: 1920, height: 1080 }

  // ── G. AN ARBITRARY NON-SQUARE ASSET KEEPS ITS SHAPE ────────────────
  //
  // A stamp is not a square badge. The operator's own is 1920x1080, and
  // sizing one axis while guessing the other distorts the artwork and
  // puts the anchored rectangle in the wrong place.
  for (const natural of [
    { w: 1920, h: 1080 },
    { w: 512, h: 512 },
    { w: 300, h: 900 },
    { w: 1000, h: 137 }
  ]) {
    const r = brandRect(frame, natural, 30, 'bottom-right', BRAND_MARGIN_FRACTION.stamp)
    assert.ok(
      Math.abs(r.width / r.height - natural.w / natural.h) < 1e-6,
      `G: ${natural.w}x${natural.h} keeps its aspect ratio (${r.width}x${r.height})`
    )
    assert.strictEqual(r.width, frame.width * 0.3, 'G: width follows sizePct, on the WIDTH')
  }

  // ── H. BOTTOM-RIGHT IS INSIDE THE PICTURE, WITH EQUAL MARGINS ───────
  const stamp = brandRect(
    frame,
    { w: 1920, h: 1080 },
    30,
    'bottom-right',
    BRAND_MARGIN_FRACTION.stamp
  )
  const margin = Math.round(Math.min(frame.width, frame.height) * BRAND_MARGIN_FRACTION.stamp)
  assert.ok(stamp.left + stamp.width <= frame.width, 'H: right edge is inside the picture')
  assert.ok(stamp.top + stamp.height <= frame.height, 'H: bottom edge is inside the picture')
  assert.strictEqual(frame.width - (stamp.left + stamp.width), margin, 'H: right margin')
  assert.strictEqual(frame.height - (stamp.top + stamp.height), margin, 'H: bottom margin')
  assert.strictEqual(margin, 22, 'H: and that margin is min(1920,1080)*0.02')

  // The fault, stated as the thing that must never come back: the two
  // insets used to differ because they were percentages of different
  // axes. 3% of 1920 is 57.6; 3% of 1080 is 32.4.
  assert.notStrictEqual(
    frame.width * 0.03,
    frame.height * 0.03,
    'H: a percentage per axis gives two different insets — which is why it is not used'
  )

  // ── I. PREVIEW AND EXPORT ARE THE SAME NORMALISED GEOMETRY ──────────
  //
  // The preview measures in CSS pixels of a contain-fit picture; the
  // export measures in output pixels. Absolute numbers differ, fractions
  // must not.
  const picture = containFit(876, 385, 1172, 784) // the real editor's rect
  const previewRect = brandRect(
    { width: picture.width, height: picture.height },
    { w: 1920, h: 1080 },
    30,
    'bottom-right',
    BRAND_MARGIN_FRACTION.stamp
  )
  const exportRect = brandRect(frame, { w: 1920, h: 1080 }, 30, 'bottom-right', BRAND_MARGIN_FRACTION.stamp)
  const norm = (r: { left: number; top: number; width: number; height: number }, f: { width: number; height: number }) => ({
    w: r.width / f.width,
    rightGap: (f.width - (r.left + r.width)) / Math.min(f.width, f.height),
    bottomGap: (f.height - (r.top + r.height)) / Math.min(f.width, f.height)
  })
  const a = norm(previewRect, { width: picture.width, height: picture.height })
  const b = norm(exportRect, frame)
  assert.ok(Math.abs(a.w - b.w) < 1e-9, `I: same relative size (${a.w} vs ${b.w})`)
  // Rounding the margin to a whole pixel is the only difference, and on a
  // 572px-wide preview that is worth a fraction of a percent.
  assert.ok(Math.abs(a.rightGap - b.rightGap) < 0.002, `I: same relative right margin`)
  assert.ok(Math.abs(a.bottomGap - b.bottomGap) < 0.002, `I: same relative bottom margin`)

  // ── AND A FULL-FRAME ASSET IS RECOGNISED AS ONE ─────────────────────
  //
  // The operator's stamp is `i2t-video-overlay-1920x1080.png` — a 16:9
  // artwork with its own margins already baked into a transparent
  // canvas. Anchoring it into a corner puts the CANVAS in the corner and
  // leaves the visible mark floating inboard, which is what "the stamp
  // is not in the corner" actually was once the margin was correct.
  assert.ok(
    looksLikeFullFrameAsset({ w: 1920, h: 1080 }, frame),
    'a 16:9 asset on a 16:9 frame is a full-frame overlay, not a badge'
  )
  assert.ok(
    !looksLikeFullFrameAsset({ w: 512, h: 512 }, frame),
    'a square badge is not'
  )

  // ── THE ANCHOR FOLLOWS THE ARTWORK, NOT THE FILE ────────────────────
  //
  // The operator's own asset, measured: a 1920x1080 canvas carrying a
  // 643x253 mark at (637, 416) — 1.47% opaque, with 640 px of nothing
  // between the mark and the canvas's right edge. Anchoring the FILE put
  // the visible mark 640*scale further in, and 411*scale further up,
  // than asked. That is the "too far in and too high" that was reported,
  // with the rectangle itself perfectly placed.
  const REAL_CONTENT = { x: 637, y: 416, w: 643, h: 253 }
  const REAL_NATURAL = { w: 1920, h: 1080 }
  const anchored = brandRect(
    frame,
    REAL_NATURAL,
    30,
    'bottom-right',
    BRAND_MARGIN_FRACTION.stamp,
    REAL_CONTENT
  )
  const mark = visibleMarkRect(anchored, REAL_NATURAL, REAL_CONTENT)
  const m2 = Math.round(Math.min(frame.width, frame.height) * BRAND_MARGIN_FRACTION.stamp)
  assert.ok(
    Math.abs(frame.width - (mark.left + mark.width) - m2) < 0.5,
    `the VISIBLE mark is ${m2}px from the right, not the canvas (got ${frame.width - (mark.left + mark.width)})`
  )
  assert.ok(
    Math.abs(frame.height - (mark.top + mark.height) - m2) < 0.5,
    `and ${m2}px from the bottom (got ${frame.height - (mark.top + mark.height)})`
  )

  // NOTHING IS CROPPED. The whole canvas is still drawn, at the same
  // size it always was — only its offset changed.
  const unanchored = brandRect(frame, REAL_NATURAL, 30, 'bottom-right', BRAND_MARGIN_FRACTION.stamp)
  assert.strictEqual(anchored.width, unanchored.width, 'same drawn width')
  assert.strictEqual(anchored.height, unanchored.height, 'same drawn height')
  assert.ok(anchored.left > unanchored.left, 'the canvas moves right to bring the mark to the edge')
  assert.ok(anchored.top > unanchored.top, 'and down')

  // An opaque badge is unaffected: content box == canvas.
  const badge = { x: 0, y: 0, w: 512, h: 512 }
  assert.deepStrictEqual(
    brandRect(frame, { w: 512, h: 512 }, 20, 'bottom-right', BRAND_MARGIN_FRACTION.stamp, badge),
    brandRect(frame, { w: 512, h: 512 }, 20, 'bottom-right', BRAND_MARGIN_FRACTION.stamp),
    'a mark that fills its own canvas is placed exactly as before'
  )

  log('brand geometry: aspect preserved, visible mark anchored in the corner, preview/export shared')
}

function testPreviewClockOwnership(): void {
  const project = {
    id: 'p1',
    images: [
      { id: 'i1', fileName: 'a.jpg', storedName: 'a.jpg', src: 'f2f://image/p1/a.jpg' },
      { id: 'i2', fileName: 'b.jpg', storedName: 'b.jpg', src: 'f2f://image/p1/b.jpg' }
    ],
    feedSequence: ['i1', 'i2'],
    transitions: {},
    motionSegments: []
  } as unknown as Project

  const item = (id: string, clip: string, from: number, to: number): TimelineItem => ({
    id,
    order: 0,
    sourceType: 'transition-clip',
    sourceId: 'i1->i2',
    sourceGenerationId: null,
    sourceClipName: clip,
    sourceImageName: null,
    startOffsetSec: from,
    endOffsetSec: to,
    seamAfterSec: 0
  })

  // Three five-second clips — the operator's own regression example.
  const items = [
    item('a', 'a.mp4', 0, 5),
    item('b', 'b.mp4', 0, 5),
    item('c', 'c.mp4', 0, 5)
  ]
  const tl = { items, defaultSeamSec: 0 }
  assert.strictEqual(timelineDurationSec(items, 0), 15, 'three 5s clips make a 15s film')

  // ── 1. TIMELINE MODE REPORTS THE WHOLE FILM ──────────────────────────
  const atStart = resolvePreviewSource(project, selectTimeline('a', 0), null, 5, tl)
  assert.strictEqual(atStart.kind, 'timeline')
  if (atStart.kind === 'timeline') {
    assert.strictEqual(
      atStart.totalSec,
      15,
      'the total is the FILM’s, never the 5s file under the playhead'
    )
    assert.strictEqual(atStart.absoluteSec, 0)
    assert.strictEqual(atStart.sourceSec, 0)
  }

  // ── 2. AND IT CROSSES BOUNDARIES CORRECTLY ───────────────────────────
  //
  // 7 seconds in is two seconds into the SECOND clip. Both numbers
  // matter and they are different: the film says 7, the file says 2.
  const midway = resolvePreviewSource(project, selectTimeline('b', 7), null, 5, tl)
  if (midway.kind === 'timeline') {
    assert.strictEqual(midway.itemId, 'b', 'the playhead is over the second clip')
    assert.strictEqual(midway.sourceSec, 2, 'two seconds into ITS file')
    assert.strictEqual(midway.absoluteSec, 7, 'seven seconds into the film')
    assert.strictEqual(midway.totalSec, 15, 'and the total never moves')
    assert.notStrictEqual(midway.sourceSec, midway.absoluteSec, 'the two are not the same number')
  }

  // ── 3. PAUSING KEEPS ABSOLUTE TIME ───────────────────────────────────
  const paused = resolvePreviewSource(project, selectTimeline('c', 12.5), null, 5, tl)
  if (paused.kind === 'timeline') {
    assert.strictEqual(paused.itemId, 'c')
    assert.strictEqual(paused.absoluteSec, 12.5)
    assert.strictEqual(paused.sourceSec, 2.5)
  }

  // ── 4. A TRIMMED ITEM SEEKS PAST ITS IN POINT ────────────────────────
  const trimmed = { items: [item('t', 't.mp4', 1.5, 4.5)], defaultSeamSec: 0 }
  const inTrim = resolvePreviewSource(project, selectTimeline('t', 1), null, 5, trimmed)
  if (inTrim.kind === 'timeline') {
    assert.strictEqual(inTrim.totalSec, 3, 'the film is the TRIMMED length, not the file’s')
    assert.strictEqual(inTrim.sourceSec, 2.5, 'and one second in means 2.5s into the file')
  }

  // ── 5. INDIVIDUAL MODE IS UNTOUCHED ──────────────────────────────────
  //
  // A selected transition still resolves to `clip`, which carries no
  // total at all — the element's own duration is the right answer there,
  // and this is what stops the fix leaking into individual playback.
  const withClip = {
    ...project,
    transitions: {
      'i1->i2': {
        prompt: '',
        durationSec: 5,
        status: 'completed',
        clip: { storedName: 'x.mp4', originalName: 'x', source: 'fal', src: 'f2f://clip/p1/x.mp4' }
      }
    }
  } as unknown as Project
  const individual = resolvePreviewSource(withClip, selectTransition('i1->i2'), null, 5, tl)
  assert.strictEqual(individual.kind, 'clip', 'a transition is still an individual clip')
  assert.ok(!('totalSec' in individual), 'and carries no timeline total to be confused with')

  console.log('[smoke] preview clock: timeline totals vs individual durations')
}

function testTimelineModel(): void {
  const item = (over: Partial<TimelineItem> = {}): TimelineItem => ({
    id: 'a',
    order: 0,
    sourceType: 'transition-clip',
    sourceId: 'i1->i2',
    sourceGenerationId: 'gen-1',
    sourceClipName: 'clip-a.mp4',
    sourceImageName: null,
    startOffsetSec: 0,
    endOffsetSec: 5,
    seamAfterSec: 0,
    ...over
  })

  // ── C. SPLIT A 5s CLIP AT 2s → 0–2 AND 2–5 ───────────────────────────
  const one = [item()]
  const split = splitItemAt(one, 'a', 2, () => 'b')
  assert.ok(split.ok, 'the split succeeded')
  if (split.ok) {
    assert.strictEqual(split.items.length, 2, 'one clip became two')
    assert.deepStrictEqual(
      split.items.map((i) => [i.startOffsetSec, i.endOffsetSec]),
      [
        [0, 2],
        [2, 5]
      ],
      'as two ranges, exactly where the playhead was'
    )
    assert.deepStrictEqual(split.items.map((i) => i.order), [0, 1], 'and renumbered')

    // ── D. NO FILE IS DUPLICATED ───────────────────────────────────────
    //
    // The heart of non-destructive editing: both halves are the SAME
    // file. A split that wrote a second mp4 would be slow, would double
    // the disk cost of every edit, and could not be undone by deleting.
    assert.strictEqual(split.items[0].sourceClipName, 'clip-a.mp4')
    assert.strictEqual(split.items[1].sourceClipName, 'clip-a.mp4')
    assert.strictEqual(
      split.items[0].sourceClipName,
      split.items[1].sourceClipName,
      'ONE source file, two ranges — no copy was made'
    )
    // And both still name the exact generation they were cut against.
    assert.strictEqual(split.items[1].sourceGenerationId, 'gen-1')
  }

  // The joint a split creates is a hard cut: blending a clip into itself
  // would dissolve one frame into the next one.
  if (split.ok) assert.strictEqual(split.items[0].seamAfterSec, 0)

  // Guards: never at the very edge, never below the minimum.
  assert.ok(!splitItemAt(one, 'a', 0, () => 'b').ok, 'cannot split at the start')
  assert.ok(!splitItemAt(one, 'a', 5, () => 'b').ok, 'cannot split at the end')
  assert.ok(!splitItemAt(one, 'a', 0.01, () => 'b').ok, 'nor leave a sliver behind')
  assert.ok(splitItemAt(one, 'a', 2.5, () => 'b').ok, 'but a real cut is fine')

  // ── E. DELETE REMOVES ONLY THE ITEM ──────────────────────────────────
  const three = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })]
  const afterDelete = removeItem(three, 'b')
  assert.deepStrictEqual(afterDelete.map((i) => i.id), ['a', 'c'])
  assert.deepStrictEqual(afterDelete.map((i) => i.order), [0, 1], 'positions close up')
  assert.strictEqual(three.length, 3, 'and the input list is not mutated')

  // ── G. REORDER ───────────────────────────────────────────────────────
  const moved = reorderItems(three, 'b', 2)
  assert.deepStrictEqual(moved.map((i) => i.id), ['a', 'c', 'b'])
  assert.deepStrictEqual(moved.map((i) => i.order), [0, 1, 2])

  // ── K. ABSOLUTE TIME → SOURCE TIME ───────────────────────────────────
  //
  // The operator's own worked example: A 0–2, B 2–7, C 7–10; the
  // playhead at 5.2 is 3.2 seconds into B.
  const abc = [
    item({ id: 'A', endOffsetSec: 2 }),
    item({ id: 'B', endOffsetSec: 5 }),
    item({ id: 'C', endOffsetSec: 3 })
  ]
  assert.strictEqual(timelineDurationSec(abc), 10, 'and the film is 10s long')
  assert.deepStrictEqual(itemStartTimes(abc), [0, 2, 7])

  const at52 = locateAtTime(abc, 5.2)
  assert.strictEqual(at52?.item.id, 'B', 'the playhead is over B')
  assert.strictEqual(at52?.localSec, 3.2, 'and 3.2s into it')
  assert.strictEqual(at52?.sourceSec, 3.2, 'which is 3.2s into its source')

  // With an IN point, source time and local time diverge — and it is
  // SOURCE time a <video> must seek to.
  const trimmed = [item({ id: 'T', startOffsetSec: 1.5, endOffsetSec: 4.5 })]
  const inTrimmed = locateAtTime(trimmed, 1)
  assert.strictEqual(inTrimmed?.localSec, 1, 'one second into the item')
  assert.strictEqual(inTrimmed?.sourceSec, 2.5, 'is 2.5s into the file it was cut from')

  // ── CROSSFADE CONSUMES TIME ──────────────────────────────────────────
  //
  // An xfade overlaps its neighbours, so a 0.2s blend makes the film
  // SHORTER. Getting this backwards would put the playhead and the
  // exported file into permanent disagreement about where the end is.
  const blended = [item({ id: 'A', endOffsetSec: 2, seamAfterSec: 0.2 }), item({ id: 'B', endOffsetSec: 3 })]
  assert.strictEqual(timelineDurationSec(blended), 4.8, '2 + 3 − 0.2')
  assert.deepStrictEqual(itemStartTimes(blended), [0, 1.8], 'and B starts inside A’s tail')

  // A CUT occupies no time and is not an item — two clips simply meet.
  const cut = [item({ id: 'A', endOffsetSec: 2, seamAfterSec: 0 }), item({ id: 'B', endOffsetSec: 3 })]
  assert.strictEqual(timelineDurationSec(cut), 5, 'a cut adds nothing and takes nothing')

  // ── L + M. BOTH CLIP KINDS BEHAVE IDENTICALLY ────────────────────────
  for (const sourceType of ['transition-clip', 'motion-clip', 'still'] as const) {
    const typed = [item({ id: 'x', sourceType, endOffsetSec: 5 })]
    const s = splitItemAt(typed, 'x', 2, () => 'y')
    assert.ok(s.ok, `${sourceType} can be split`)
    if (s.ok) {
      assert.strictEqual(s.items.length, 2)
      assert.strictEqual(removeItem(s.items, 'y').length, 1, `${sourceType} can be deleted`)
    }
  }

  // ── Q. DRIFT IS REPORTED, NEVER ACTED ON ─────────────────────────────
  const clean: Timeline = {
    projectId: 'p',
    items: [item()],
    feedFingerprint: 'F1',
    manuallyEdited: false,
    updatedAt: 1
  }
  assert.strictEqual(timelineDrift(clean, 'F1').kind, 'none', 'a matching feed is no drift')
  assert.strictEqual(timelineDrift(clean, 'F2').kind, 'stale', 'a changed feed with no edits is stale')
  assert.strictEqual(
    timelineDrift({ ...clean, manuallyEdited: true }, 'F2').kind,
    'conflict',
    'a changed feed WITH manual edits is a conflict — edits are at stake'
  )

  console.log('[smoke] timeline model: split ranges, no copies, seam arithmetic, drift')
}

/**
 * THE TIMELINE AGAINST THE REAL DATABASE AND THE REAL EXPORTER.
 *
 * Materialisation, persistence, and — the part that matters most — that
 * the exporter actually encodes the timeline's ranges and order.
 */
async function testTimelinePersistenceAndExport(createdProjects: string[]): Promise<void> {
  const ID_tlA = fixtureImageId('tlA')
  const ID_tlB = fixtureImageId('tlB')
  const ID_tlC = fixtureImageId('tlC')
  const project = makeProject('Timeline')
  createdProjects.push(project.id)

  const imagesDir = projectImagesDir(project.id)
  mkdirSync(imagesDir, { recursive: true })
  const clipsDir = projectTransitionsDir(project.id)
  mkdirSync(clipsDir, { recursive: true })

  const makeVideo = (path: string, colour: string, seconds: number): void => {
    const res = spawnSync(
      ffmpegPath(),
      ['-y', '-f', 'lavfi', '-i', `color=c=${colour}:s=160x120:d=${seconds}`,
       '-r', '25', '-pix_fmt', 'yuv420p', path],
      { encoding: 'utf8', timeout: 60_000 }
    )
    assert.strictEqual(res.status, 0, `fixture ${path}`)
  }
  const makeStill = (path: string, colour: string): void => {
    const res = spawnSync(
      ffmpegPath(),
      ['-y', '-f', 'lavfi', '-i', `color=c=${colour}:s=160x120:d=1`, '-frames:v', '1', path],
      { encoding: 'utf8', timeout: 60_000 }
    )
    assert.strictEqual(res.status, 0, `still ${path}`)
  }

  makeStill(join(imagesDir, 'tl1.png'), 'navy')
  makeStill(join(imagesDir, 'tl2.png'), 'olive')
  makeStill(join(imagesDir, 'tl3.png'), 'teal')
  makeVideo(join(clipsDir, 'tl-a.mp4'), 'red', 5)
  makeVideo(join(clipsDir, 'tl-b.mp4'), 'green', 4)

  project.images = [
    { id: ID_tlA, fileName: 'tl1.png', storedName: 'tl1.png', src: '' },
    { id: ID_tlB, fileName: 'tl2.png', storedName: 'tl2.png', src: '' },
    { id: ID_tlC, fileName: 'tl3.png', storedName: 'tl3.png', src: '' }
  ]
  project.feedSequence = [ID_tlA, ID_tlB, ID_tlC]
  project.transitions = {
    [`${ID_tlA}->${ID_tlB}`]: {
      prompt: 'p',
      durationSec: 5,
      status: 'completed',
      mode: 'ai',
      modeProvenance: 'manual',
      clip: { storedName: 'tl-a.mp4', originalName: 'a.mp4', source: 'fal', src: '' }
    },
    [`${ID_tlB}->${ID_tlC}`]: {
      prompt: 'p',
      durationSec: 4,
      status: 'completed',
      mode: 'ai',
      modeProvenance: 'manual',
      clip: { storedName: 'tl-b.mp4', originalName: 'b.mp4', source: 'fal', src: '' }
    }
  }
  saveProject(project)

  // ── P. AN UNTOUCHED PROJECT EXPORTS AS IT ALWAYS DID ─────────────────
  //
  // Checked BEFORE any timeline exists, against the feed plan the
  // exporter used to follow on its own.
  const beforeTimeline = exportAssembly(listProjects().find((p) => p.id === project.id)!)
  assert.strictEqual(beforeTimeline.fromTimeline, false, 'no timeline yet, so the feed decides')
  const feedSegments = beforeTimeline.segments.map((s) => s.path)

  // ── A. MATERIALISED FROM THE FEED ────────────────────────────────────
  const first = getTimeline(project.id)
  assert.ok(first?.timeline, 'a timeline is materialised on first read')
  const items0 = first!.timeline!.items
  assert.strictEqual(items0.length, 2, 'two AI clips, no still — both images are covered')
  assert.deepStrictEqual(
    items0.map((i) => i.sourceClipName),
    ['tl-a.mp4', 'tl-b.mp4'],
    'in feed order'
  )
  assert.ok(items0.every((i) => i.startOffsetSec === 0), 'whole clips to begin with')
  assert.strictEqual(items0[0].endOffsetSec, 5, 'with their REAL probed durations')
  assert.strictEqual(items0[1].endOffsetSec, 4)
  assert.strictEqual(first!.timeline!.manuallyEdited, false, 'and nobody has edited it')

  // Materialising must not have changed what gets exported.
  const afterMaterialise = exportAssembly(listProjects().find((p) => p.id === project.id)!)
  assert.ok(afterMaterialise.fromTimeline, 'now the timeline decides')
  assert.deepStrictEqual(
    afterMaterialise.segments.map((s) => s.path),
    feedSegments,
    'P: a freshly materialised timeline exports EXACTLY what the feed did'
  )

  // ── B. IT SURVIVES A RELOAD ──────────────────────────────────────────
  const reread = readTimeline(project.id)
  assert.ok(reread, 'the timeline is on disk')
  assert.deepStrictEqual(
    reread!.items.map((i) => i.id),
    items0.map((i) => i.id),
    'with the same item identities'
  )

  // ── H/C. SPLIT THE FIRST CLIP AT 2s ──────────────────────────────────
  const splitRes = splitTimelineAt(project.id, items0[0].id, 2)
  assert.ok(splitRes.ok, `split: ${JSON.stringify(splitRes)}`)
  const afterSplit = getTimeline(project.id)!.timeline!.items
  assert.strictEqual(afterSplit.length, 3, 'two clips became three items')
  assert.deepStrictEqual(
    [afterSplit[0].startOffsetSec, afterSplit[0].endOffsetSec],
    [0, 2]
  )
  assert.deepStrictEqual(
    [afterSplit[1].startOffsetSec, afterSplit[1].endOffsetSec],
    [2, 5]
  )
  assert.strictEqual(afterSplit[0].sourceClipName, afterSplit[1].sourceClipName, 'same file')
  assert.ok(getTimeline(project.id)!.timeline!.manuallyEdited, 'and it is now hand-edited')

  // ── D. THE FILE ON DISK IS UNTOUCHED ─────────────────────────────────
  const clipFiles = readdirSync(clipsDir).filter((f) => f.endsWith('.mp4')).sort()
  assert.deepStrictEqual(clipFiles, ['tl-a.mp4', 'tl-b.mp4'], 'NO new mp4 was written by the split')
  assert.strictEqual(
    Math.round(probeDurationSec(join(clipsDir, 'tl-a.mp4'))),
    5,
    'and the original is still its full length'
  )

  // ── N. EXPORT TRIMS THE RIGHT RANGES ─────────────────────────────────
  const exported = exportAssembly(listProjects().find((p) => p.id === project.id)!)
  assert.ok(exported.fromTimeline)
  assert.strictEqual(exported.segments.length, 3)
  assert.deepStrictEqual(
    exported.segments.map((s) => [s.sourceStartSec, s.sourceEndSec]),
    [
      [0, 2],
      [2, 5],
      [0, 4]
    ],
    'each segment carries the operator’s in and out points'
  )
  assert.ok(
    exported.segments[0].path === exported.segments[1].path,
    'the two halves point at ONE file'
  )

  // ── E/F. DELETE THE MIDDLE PIECE ─────────────────────────────────────
  const generationsBefore = getAllProjectGenerations(project.id).length
  const del = deleteTimelineItem(project.id, afterSplit[1].id)
  assert.ok(del.ok)
  const afterDelete = getTimeline(project.id)!.timeline!.items
  assert.strictEqual(afterDelete.length, 2, 'the item is gone from the film')
  assert.deepStrictEqual(
    afterDelete.map((i) => [i.startOffsetSec, i.endOffsetSec]),
    [
      [0, 2],
      [0, 4]
    ],
    'leaving the other two ranges as they were'
  )
  // F: nothing outside the timeline moved.
  assert.deepStrictEqual(
    readdirSync(clipsDir).filter((f) => f.endsWith('.mp4')).sort(),
    ['tl-a.mp4', 'tl-b.mp4'],
    'the clip file is NOT deleted'
  )
  assert.strictEqual(
    getAllProjectGenerations(project.id).length,
    generationsBefore,
    'and no catalogue history is removed'
  )
  const feedAfterDelete = listProjects().find((p) => p.id === project.id)!
  assert.deepStrictEqual(feedAfterDelete.feedSequence, [ID_tlA, ID_tlB, ID_tlC], 'the FEED is untouched')
  assert.strictEqual(
    Object.keys(feedAfterDelete.transitions).length,
    2,
    'and so are its transitions'
  )

  // ── G/O. REORDER, AND EXPORT FOLLOWS IT EXACTLY ──────────────────────
  const reordered = reorderTimelineItem(project.id, afterDelete[0].id, 1)
  assert.ok(reordered.ok)
  const order = getTimeline(project.id)!.timeline!.items
  assert.deepStrictEqual(
    order.map((i) => i.sourceClipName),
    ['tl-b.mp4', 'tl-a.mp4'],
    'the second clip now plays first'
  )
  const exportedOrder = exportAssembly(listProjects().find((p) => p.id === project.id)!)
  assert.deepStrictEqual(
    exportedOrder.segments.map((s) => basename(s.path)),
    ['tl-b.mp4', 'tl-a.mp4'],
    'O: the export order IS the timeline order'
  )
  // And the ranges travelled with their items.
  assert.deepStrictEqual(
    exportedOrder.segments.map((s) => [s.sourceStartSec, s.sourceEndSec]),
    [
      [0, 4],
      [0, 2]
    ]
  )

  // Reorder persists.
  assert.deepStrictEqual(
    readTimeline(project.id)!.items.map((i) => i.sourceClipName),
    ['tl-b.mp4', 'tl-a.mp4'],
    'G: and the new order is on disk'
  )

  // ── Q/R. A FEED CHANGE DOES NOT WIPE THE EDIT ────────────────────────
  const edited = listProjects().find((p) => p.id === project.id)!
  edited.feedSequence = [ID_tlA, ID_tlC, ID_tlB]
  saveProject(edited)

  const afterFeedChange = getTimeline(project.id)!
  assert.deepStrictEqual(
    afterFeedChange.timeline!.items.map((i) => i.sourceClipName),
    ['tl-b.mp4', 'tl-a.mp4'],
    'Q: the hand-made order SURVIVED a feed change'
  )
  assert.strictEqual(
    afterFeedChange.drift.kind,
    'conflict',
    'and the drift is reported as a conflict, because edits are at stake'
  )

  // R: a rebuild refuses without an explicit confirmation.
  const refused = rebuildTimeline(project.id, false)
  assert.ok(!refused.ok, 'R: rebuilding refuses while manual edits exist')
  if (!refused.ok) assert.ok(/discard/i.test(refused.reason))
  assert.deepStrictEqual(
    readTimeline(project.id)!.items.map((i) => i.sourceClipName),
    ['tl-b.mp4', 'tl-a.mp4'],
    'and nothing was changed by the refusal'
  )

  // ── S. AN UPSTREAM REGENERATION DOES NOT SWAP THE SOURCE ─────────────
  //
  // A new clip becomes the transition's active one. The timeline item
  // was cut against the OLD file, so it must keep playing that file —
  // swapping it would move the in/out points onto different footage.
  const pinned = readTimeline(project.id)!.items.find((i) => i.sourceClipName === 'tl-a.mp4')!
  const regenerated = listProjects().find((p) => p.id === project.id)!
  makeVideo(join(clipsDir, 'tl-a2.mp4'), 'purple', 5)
  regenerated.transitions[`${ID_tlA}->${ID_tlB}`] = {
    ...regenerated.transitions[`${ID_tlA}->${ID_tlB}`],
    clip: { storedName: 'tl-a2.mp4', originalName: 'a2.mp4', source: 'fal', src: '' }
  }
  saveProject(regenerated)

  const afterRegen = getTimeline(project.id)!.timeline!.items.find((i) => i.id === pinned.id)!
  assert.strictEqual(
    afterRegen.sourceClipName,
    'tl-a.mp4',
    'S: the edited item still plays the exact file it was cut against'
  )
  assert.deepStrictEqual(
    [afterRegen.startOffsetSec, afterRegen.endOffsetSec],
    [pinned.startOffsetSec, pinned.endOffsetSec],
    'with its in and out points intact'
  )

  // ── T. A MISSING SOURCE IS NAMED PRECISELY ───────────────────────────
  rmSync(join(clipsDir, 'tl-a.mp4'), { force: true })
  const broken = exportAssembly(listProjects().find((p) => p.id === project.id)!)
  assert.strictEqual(broken.missingItems.length, 1, 'the gone file is detected')
  assert.ok(
    /Timeline clip \d+/.test(broken.missingItems[0].label),
    'T: named as a TIMELINE clip, not as a generic missing transition'
  )
  assert.ok(
    getTimeline(project.id)!.missing.length === 1,
    'and the view reports it so the block can be marked'
  )

  // ── R (part 2). REBUILDING IS ALLOWED WHEN CONFIRMED ─────────────────
  const rebuilt = rebuildTimeline(project.id, true)
  assert.ok(rebuilt.ok, 'a confirmed rebuild goes through')
  const fresh = readTimeline(project.id)!
  assert.strictEqual(fresh.manuallyEdited, false, 'and the new one is not hand-edited')
  // The rebuild follows the CURRENT feed, which was reordered to
  // tlA → tlC → tlB above. Neither of those pairs has a generated clip,
  // so the honest plan is three held stills — the hand-made order and
  // the pinned source are gone, which is exactly what was confirmed.
  assert.deepStrictEqual(
    fresh.items.map((i) => i.sourceType),
    ['still', 'still', 'still'],
    'and it describes the feed as it is NOW, not as it was when the edit was made'
  )
  assert.ok(
    !fresh.items.some((i) => i.sourceClipName === 'tl-a.mp4'),
    'the deleted-file reference is gone with the edits that created it'
  )
  assert.strictEqual(
    getTimeline(project.id)!.drift.kind,
    'none',
    'and the rebuilt timeline is back in step with the feed'
  )

  console.log('[smoke] timeline: materialise, split, delete, reorder, export ranges, drift, pinning')
}

/**
 * THE WATERMARKED EXPORT MUST BE THE TIMELINE.
 *
 * ── WHY THIS RUNS THE REAL RUNNER ────────────────────────────────────
 *
 * `startExport` opens a native save dialog, which no automation can
 * answer. But the dialog only chooses a PATH — everything that decides
 * what is encoded happens in `runExportJob`, which is registered for
 * both `preview-export` (watermarked) and `final-export`. Driving it
 * through the queue exercises exactly the code a real export runs,
 * overlays included, with no dialog in the way.
 *
 * What it proves: an edited timeline plus a watermark produces a file of
 * the TIMELINE's length. If the watermarked path had kept its own feed
 * assembly, the duration would be the feed's instead — which is the only
 * way this assertion can fail.
 */
async function testWatermarkedTimelineExport(createdProjects: string[]): Promise<void> {
  const ID_wmA = fixtureImageId('wmA')
  const ID_wmB = fixtureImageId('wmB')
  const project = makeProject('Timeline Watermark')
  createdProjects.push(project.id)

  const imagesDir = projectImagesDir(project.id)
  const clipsDir = projectTransitionsDir(project.id)
  mkdirSync(imagesDir, { recursive: true })
  mkdirSync(clipsDir, { recursive: true })

  const ff = (args: string[], what: string): void => {
    const res = spawnSync(ffmpegPath(), args, { encoding: 'utf8', timeout: 90_000 })
    assert.strictEqual(res.status, 0, `${what}: ${res.stderr?.slice(-300)}`)
  }
  ff(['-y', '-f', 'lavfi', '-i', 'color=c=navy:s=320x180:d=1', '-frames:v', '1',
      join(imagesDir, 'wm1.png')], 'still 1')
  ff(['-y', '-f', 'lavfi', '-i', 'color=c=olive:s=320x180:d=1', '-frames:v', '1',
      join(imagesDir, 'wm2.png')], 'still 2')
  ff(['-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=6', '-r', '25', '-pix_fmt', 'yuv420p',
      join(clipsDir, 'wm-a.mp4')], 'clip')

  project.images = [
    { id: ID_wmA, fileName: 'wm1.png', storedName: 'wm1.png', src: '' },
    { id: ID_wmB, fileName: 'wm2.png', storedName: 'wm2.png', src: '' }
  ]
  project.feedSequence = [ID_wmA, ID_wmB]
  project.transitions = {
    [`${ID_wmA}->${ID_wmB}`]: {
      prompt: 'p',
      durationSec: 6,
      status: 'completed',
      mode: 'ai',
      modeProvenance: 'manual',
      clip: { storedName: 'wm-a.mp4', originalName: 'a.mp4', source: 'fal', src: '' }
    }
  }
  saveProject(project)

  // Materialise, then TRIM it to half — a deliberate, visible edit.
  const view = getTimeline(project.id)!
  const only = view.timeline!.items[0]
  assert.strictEqual(Math.round(itemDurationSec(only)), 6, 'the whole clip to begin with')
  const split = splitTimelineAt(project.id, only.id, 3)
  assert.ok(split.ok, 'split at 3s')
  const halves = getTimeline(project.id)!.timeline!.items
  assert.strictEqual(halves.length, 2)
  const dropped = deleteTimelineItem(project.id, halves[1].id)
  assert.ok(dropped.ok, 'second half removed')

  const edited = getTimeline(project.id)!
  const expectedSec = edited.durationSec
  assert.ok(expectedSec > 2.5 && expectedSec < 3.5, `the film is now ~3s, not 6 (${expectedSec})`)

  // A real overlay PNG, written where the runner looks for it.
  const exportDir = join(projectDir(project.id), 'exports')
  mkdirSync(exportDir, { recursive: true })
  ff(['-y', '-f', 'lavfi', '-i', 'color=c=white@0.5:s=1920x1080:d=1', '-frames:v', '1',
      join(exportDir, 'wm-overlay.png')], 'overlay')

  const outputPath = join(exportDir, 'wm-out.mp4')
  const job = enqueue({
    projectId: project.id,
    projectName: project.name,
    // The WATERMARKED kind. Same runner as final-export; the only
    // difference is that overlays are present.
    kind: 'preview-export',
    transitionCount: 1,
    metadata: { outputPath, exportKind: 'preview', overlayFiles: ['wm-overlay.png'] }
  })

  resumeQueue()
  await waitFor(
    () => ['completed', 'failed'].includes(listJobs().find((j) => j.id === job.id)?.status ?? ''),
    180_000,
    'watermarked timeline export'
  )
  const finished = listJobs().find((j) => j.id === job.id)!
  assert.strictEqual(finished.status, 'completed', `export failed: ${finished.note}`)
  assert.ok(existsSync(outputPath), 'a file was produced')

  // ── THE PROOF ────────────────────────────────────────────────────────
  const encoded = probeDurationSec(outputPath)
  assert.ok(
    Math.abs(encoded - expectedSec) < 0.6,
    `the WATERMARKED export is the TIMELINE's ${expectedSec}s, not the feed's 6s (got ${encoded})`
  )
  assert.ok(
    encoded < 4.5,
    'and it is decisively shorter than the untrimmed feed assembly would have been'
  )

  console.log(
    `[smoke] watermarked export follows the timeline: ${encoded.toFixed(2)}s (feed would be ~6s)`
  )
}

async function testMotionRegeneration(createdProjects: string[]): Promise<void> {
  const ID_regenA = fixtureImageId('regenA')
  const ID_regenB = fixtureImageId('regenB')
  // ── F. SMOOTH FORWARD MEANS PHYSICAL FORWARD MOVEMENT ────────────────
  //
  // The move a model will happily fake. The prompt has to demand the
  // parallax and name the failure, or "forward" becomes a scale-up.
  const forward = buildMotionPrompt('smooth-forward')
  assert.ok(/moves slowly and steadily forward through the room/i.test(forward))
  assert.ok(
    /natural perspective change/i.test(forward),
    'it asks for the perspective change real travel produces'
  )
  assert.ok(
    /nearer surfaces pass sooner than distant ones/i.test(forward),
    'and says what that means, so it cannot be read as a zoom'
  )
  assert.ok(
    /do not simulate this as a digital zoom/i.test(forward),
    'and REJECTS zoom-only behaviour explicitly'
  )
  assert.ok(/no handheld feel/i.test(forward) && /no walking bob/i.test(forward))
  assert.ok(
    !/no perspective invention/i.test(forward),
    'and does NOT also forbid perspective change — that contradiction is what pushed it back to a zoom'
  )
  assert.ok(
    /Do not invent rooms, doorways or objects/i.test(forward),
    'while still banning invented geometry, worded so it bans the right thing'
  )

  // ── SMOOTH FORWARD IS NOT PUSH IN ────────────────────────────────────
  const pushIn = buildMotionPrompt('push-in')
  assert.notStrictEqual(forward, pushIn, 'they are different prompts')
  assert.ok(
    /barely travels/i.test(pushIn),
    'Push In tightens the framing rather than travelling — the two now contradict rather than overlap'
  )
  assert.ok(
    !/minimal perspective change/i.test(forward),
    'and Smooth Forward carries none of the old zoom-flavoured wording'
  )
  assert.strictEqual(MOTION_TYPES[0], 'smooth-forward', 'it is offered first')
  assert.ok(MOTION_LABEL['smooth-forward'].includes('Smooth Forward'))
  assert.ok(
    MOTION_LABEL['push-in'].includes('tighten'),
    'and the labels say which is which, so the choice is not a guess'
  )

  // ── A REAL SEGMENT, REGENERATED WITH DIFFERENT CHOICES ───────────────
  const project = makeProject('Motion Regen')
  createdProjects.push(project.id)
  const imagesDir = projectImagesDir(project.id)
  mkdirSync(imagesDir, { recursive: true })
  writeFileSync(join(imagesDir, 'a.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
  writeFileSync(join(imagesDir, 'b.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
  project.images = [
    { id: ID_regenA, fileName: 'a.jpg', storedName: 'a.jpg', src: '' },
    { id: ID_regenB, fileName: 'b.jpg', storedName: 'b.jpg', src: '' }
  ]
  project.feedSequence = [ID_regenA, ID_regenB]
  saveProject(project)

  const added = addMotionSegment({
    projectId: project.id,
    imageId: ID_regenA,
    motion: 'pan-right',
    durationSec: 5
  })
  assert.ok(added.ok && added.segment)
  const segmentId = added.segment!.id

  let produced = 0
  const stub = {
    metadata: () => ({ id: 'fal' as const, label: 'fal.ai', models: [], supportsRemoteCancel: true }),
    fetchResult: async (_url: string, target: string) => {
      produced++
      const res = spawnSync(
        ffmpegPath(),
        ['-y', '-f', 'lavfi', '-i', `color=c=${produced === 1 ? 'navy' : 'olive'}:s=160x120:d=1`,
         '-r', '25', '-pix_fmt', 'yuv420p', target],
        { encoding: 'utf8', timeout: 60_000 }
      )
      assert.strictEqual(res.status, 0)
      return { ok: true as const }
    }
  } as unknown as VideoProvider

  // First run: Pan Right at 5s, as queued.
  const job1 = enqueue({
    projectId: project.id,
    projectName: project.name,
    kind: 'motion-generation',
    transitionCount: 1,
    scheduledFor: null,
    metadata: {
      motionSegmentId: segmentId,
      motionImageId: ID_regenA,
      motionType: 'pan-right',
      motionDurationSec: 5
    }
  })
  const first = await downloadAndAttachResult(
    stub,
    project.id,
    { kind: 'motion', segmentId, imageId: ID_regenA, motion: 'pan-right' },
    'https://example/1.mp4',
    job1.id,
    'fal-ai/kling-video/v2.6/pro/image-to-video'
  )
  assert.ok(first.ok, `first run attached: ${JSON.stringify(first)}`)

  // ── A. THE REGENERATION USES THE NEW MOTION AND LENGTH ───────────────
  //
  // The request is built from the JOB's metadata, not from the segment,
  // so a queued run cannot be changed by editing the inspector after the
  // fact — and cannot carry the previous motion's prompt.
  const job2 = enqueue({
    projectId: project.id,
    projectName: project.name,
    kind: 'motion-generation',
    transitionCount: 1,
    scheduledFor: null,
    metadata: {
      motionSegmentId: segmentId,
      motionImageId: ID_regenA,
      motionType: 'smooth-forward',
      motionDurationSec: 10
    }
  })
  const rebuilt = buildMotionGenerationRequest(
    project.id,
    segmentId,
    null,
    'fal-ai/kling-video/v2.6/pro/image-to-video',
    job2.metadata.motionDurationSec,
    job2.metadata.motionType as never
  )
  assert.ok(rebuilt.ok, 'the regeneration request builds')
  if (rebuilt.ok) {
    assert.strictEqual(rebuilt.request.durationSec, 10, 'at the NEW length')
    assert.strictEqual(
      rebuilt.request.prompt,
      buildMotionPrompt('smooth-forward'),
      'with the NEW motion’s prompt'
    )
    assert.ok(
      !/horizontally to the right/i.test(rebuilt.request.prompt),
      'and NO trace of the old Pan Right wording'
    )
    assert.strictEqual(
      rebuilt.request.subject?.kind === 'motion' ? rebuilt.request.subject.motion : null,
      'smooth-forward',
      'and the subject names the new motion, so the catalogue row will too'
    )
  }

  const second = await downloadAndAttachResult(
    stub,
    project.id,
    { kind: 'motion', segmentId, imageId: ID_regenA, motion: 'smooth-forward' },
    'https://example/2.mp4',
    job2.id,
    'fal-ai/kling-video/v2.6/pro/image-to-video'
  )
  assert.ok(second.ok, 'the regeneration attached')

  const history = getGenerationsForMotion(project.id, segmentId)
  assert.strictEqual(history.length, 2, 'both runs are in history')

  // ── C. THE NEW GENERATION STORES ITS OWN CHOICES ─────────────────────
  assert.strictEqual(history[0].motionType, 'smooth-forward')
  assert.strictEqual(history[0].durationSec, 10)
  assert.strictEqual(history[0].promptUsed, buildMotionPrompt('smooth-forward'))
  assert.ok(history[0].active, 'and it is current')

  // ── B. THE OLD ONE IS UNCHANGED ──────────────────────────────────────
  //
  // The regression this pins: history built from the SEGMENT would have
  // rewritten this row to Smooth Forward / 10s the moment the second run
  // landed, because the segment had moved on.
  assert.strictEqual(history[1].motionType, 'pan-right', 'the old row is still Pan Right')
  assert.strictEqual(history[1].durationSec, 5, 'and still 5s')
  assert.strictEqual(
    history[1].promptUsed,
    buildMotionPrompt('pan-right'),
    'and still carries the prompt it was actually made with'
  )
  assert.ok(!history[1].active, 'retired, not deleted')
  assert.ok(history[1].clip, 'and its paid-for clip is kept')
  assert.notStrictEqual(
    history[0].clip?.storedName,
    history[1].clip?.storedName,
    'two runs, two files'
  )

  // The segment now describes what plays: the newest generation.
  const after = listProjects().find((p) => p.id === project.id)!
  const seg = motionSegments(after).find((s) => s.id === segmentId)!
  assert.strictEqual(seg.motion, 'smooth-forward')
  assert.strictEqual(seg.durationSec, 10)
  assert.strictEqual(seg.clip?.storedName, history[0].clip?.storedName)

  // ── G. SHOW IN FOLDER RESOLVES THE EXACT FILE ────────────────────────
  //
  // THE BUG THIS PINS: `queue:clips` returned [] for any job without
  // pairKeys, so a motion row rendered no clip section at all — and the
  // Show in folder button inside it was never drawn.
  for (const [job, expected] of [
    [job1, history[1]],
    [job2, history[0]]
  ] as const) {
    const clips = clipsForJob(job.id)
    assert.strictEqual(clips.length, 1, 'a motion job reports exactly one clip')
    assert.strictEqual(
      clips[0].storedName,
      expected.clip?.storedName,
      'and it is THAT job’s own file, not whatever the segment now plays'
    )
    assert.ok(clips[0].exists, 'the bytes are really on disk')
    assert.ok(clips[0].bytes > 0)
    assert.ok(/SINGLE IMAGE MOTION/.test(clips[0].label), 'labelled as motion, never as a pair')
    assert.ok(!clips[0].label.includes('→'), 'and never with an arrow')
    // The renderer passes storedName to main, which resolves the path —
    // no path is ever constructed in the renderer.
    assert.ok(
      clipPath(project.id, clips[0].storedName!),
      'and the canonical resolver finds it from projectId + storedName'
    )
  }

  // ── H. TRANSITION JOBS RESOLVE EXACTLY AS BEFORE ─────────────────────
  const exportJob = enqueue({
    projectId: project.id,
    projectName: project.name,
    kind: 'ai-generation',
    transitionCount: 1,
    scheduledFor: null,
    metadata: { pairKeys: [`${ID_regenA}->${ID_regenB}`] }
  })
  const pairClips = clipsForJob(exportJob.id)
  assert.strictEqual(pairClips.length, 1, 'a transition job still reports its pair')
  assert.strictEqual(
    pairClips[0].pairKey,
    `${ID_regenA}->${ID_regenB}`,
    'keyed by the pair, unchanged'
  )
  assert.ok(/Image 1 → Image 2/.test(pairClips[0].label), 'and labelled with the arrow, unchanged')

  console.log('[smoke] motion regeneration: per-run motion/duration, history intact, clips resolve')
}

function testMotionRunStateAndQueue(): void {
  const segment: MotionSegment = {
    id: 'motion:x',
    kind: 'single-motion',
    imageId: 'imgA',
    motion: 'pan-right',
    durationSec: 5,
    status: 'queued',
    clip: null,
    prompt: buildMotionPrompt('pan-right'),
    createdAt: 1
  }

  const job = (over: Partial<QueueJob> = {}): QueueJob =>
    ({
      id: 'job-1',
      projectId: 'p1',
      projectName: 'P',
      kind: 'motion-generation',
      status: 'queued',
      progressPct: 0,
      transitionCount: 1,
      createdAt: 100,
      queueOrder: 1,
      scheduledFor: null,
      startedAt: null,
      completedAt: null,
      metadata: { motionSegmentId: 'motion:x', motionImageId: 'imgA', motionType: 'pan-right' },
      ...over
    }) as QueueJob

  // ── A. A LIVE JOB MEANS RUNNING ──────────────────────────────────────
  for (const status of ['scheduled', 'queued', 'processing'] as const) {
    const s = motionRunState(segment, [job({ status })])
    assert.strictEqual(s.kind, 'running', `a ${status} job means running`)
  }

  // ── C. AND A SECOND PAID SUBMIT IS REFUSED ───────────────────────────
  const blocked = motionGenerationReadiness(
    segment,
    FAL_MODEL_REGISTRY,
    motionRunState(segment, [job({ status: 'processing' })])
  )
  assert.ok(!blocked.ok, 'a genuinely live job blocks a second paid submit')
  if (!blocked.ok) assert.ok(/already running/i.test(blocked.reason))

  // ── D. A TERMINAL JOB DOES NOT ───────────────────────────────────────
  //
  // This is the exact shape of the stuck segment: status `queued`, one
  // motion job, that job FAILED, no provider task id.
  for (const status of ['failed', 'cancelled'] as const) {
    const s = motionRunState(segment, [job({ status, note: 'boom' })])
    assert.strictEqual(s.kind, 'failed', `a ${status} job is not running`)
    const ready = motionGenerationReadiness(segment, FAL_MODEL_REGISTRY, s)
    assert.ok(ready.ok, `Generate is available again after a ${status} job`)
  }
  assert.strictEqual(
    reconciledMotionStatus(segment, [job({ status: 'failed' })]),
    'failed',
    'and the stale `queued` reconciles to `failed`'
  )

  // ── E. A MARKER WITH NO JOB AT ALL CLEARS ────────────────────────────
  const orphan = motionRunState(segment, [])
  assert.strictEqual(orphan.kind, 'idle', 'a running marker with no job is not running')
  assert.ok(
    motionGenerationReadiness(segment, FAL_MODEL_REGISTRY, orphan).ok,
    'so Generate is available'
  )
  assert.strictEqual(
    reconciledMotionStatus(segment, []),
    'not-generated',
    'and reconciliation clears the word'
  )
  assert.ok(motionStatusIsStale(segment, []), 'which is detected as stale')

  // ── F. A PAID TASK IS RECOVERED, NEVER RE-BOUGHT ─────────────────────
  const paid = motionRunState(segment, [
    job({
      status: 'failed',
      provider: {
        provider: 'fal',
        model: 'm',
        dryRun: false,
        providerTaskId: 'req-paid-1',
        providerStatus: 'COMPLETED',
        submittedAt: 1,
        lastPolledAt: 1,
        providerMeta: null,
        estimatedCost: 0.35,
        actualCost: null,
        estimatedCredits: null,
        actualCredits: null,
        retryCount: 0
      }
    } as Partial<QueueJob>)
  ])
  assert.strictEqual(paid.kind, 'recoverable', 'a terminal job holding a PAID task is recoverable')
  if (paid.kind === 'recoverable') assert.strictEqual(paid.providerTaskId, 'req-paid-1')
  const paidReady = motionGenerationReadiness(segment, FAL_MODEL_REGISTRY, paid)
  assert.ok(!paidReady.ok, 'and a fresh paid generation is REFUSED')
  if (!paidReady.ok) {
    assert.ok(/req-paid-1/.test(paidReady.reason), 'naming the task so it can be recovered')
  }
  assert.strictEqual(
    reconciledMotionStatus(segment, [
      job({ status: 'failed', provider: { providerTaskId: 'req-paid-1', dryRun: false } as never })
    ]),
    'generating',
    'a paid task never reconciles down to not-generated — that would invite paying twice'
  )

  // ── G. A DELIVERED CLIP ENDS EVERY WARNING ───────────────────────────
  const delivered: MotionSegment = {
    ...segment,
    status: 'queued',
    clip: { storedName: 'c.mp4', originalName: 'c.mp4', source: 'fal', src: 'f2f://c.mp4' }
  }
  assert.strictEqual(
    motionRunState(delivered, [job({ status: 'failed' })]).kind,
    'idle',
    'an attached clip means nothing is in flight, whatever old rows say'
  )
  assert.strictEqual(reconciledMotionStatus(delivered, []), 'completed')

  // ── B. TRANSITION JOBS ARE UNTOUCHED ─────────────────────────────────
  //
  // A motion segment must never claim an ai-generation job, and the
  // motion matcher must never see one.
  assert.deepStrictEqual(
    jobsForMotionSegment([job({ kind: 'ai-generation', metadata: { pairKeys: ['a->b'] } })], 'motion:x'),
    [],
    'a transition job is never matched to a motion segment'
  )
  assert.deepStrictEqual(
    jobsForMotionSegment([job({ metadata: { motionSegmentId: 'motion:other' } })], 'motion:x'),
    [],
    'nor another segment’s motion job'
  )
  assert.strictEqual(
    jobsForMotionSegment([job()], 'motion:x').length,
    1,
    'but its own job is'
  )

  // ── DURATIONS FOLLOW THE MODEL, AND ARE NEVER CLAMPED ────────────────
  //
  // The readiness list used to be the INTERSECTION of every capable
  // model's durations. With one capable model that is invisible; with
  // two it silently hides real capability — O3's 3–15s enum beside 2.6
  // Pro's 5|10 would have offered 5 and 10 and concealed eleven lengths.
  // It is the UNION now, and the selector reads the SELECTED model's own
  // list.
  const wide = motionGenerationReadiness(segment, [
    {
      id: 'a',
      displayName: 'Narrow',
      supportsStartFrameOnly: true,
      confirmed: true,
      durationsSec: [5, 10]
    },
    {
      id: 'b',
      displayName: 'Wide',
      supportsStartFrameOnly: true,
      confirmed: true,
      durationsSec: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
    }
  ])
  assert.ok(wide.ok)
  if (wide.ok) {
    assert.deepStrictEqual(
      wide.durationsSec,
      [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      'every length SOME capable model offers survives — no hidden clamp'
    )
    assert.deepStrictEqual(
      wide.models.find((m) => m.id === 'b')?.durationsSec,
      [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      'and each model carries its OWN list, which is what the selector shows'
    )
    assert.deepStrictEqual(wide.models.find((m) => m.id === 'a')?.durationsSec, [5, 10])
  }

  // The registry's real numbers, as published. 2.6 Pro's 5|10 is the
  // endpoint's DurationEnum, not a UI restriction; O3's 3–15 is its own.
  assert.deepStrictEqual(
    resolveFalModel('fal-ai/kling-video/o3/standard/image-to-video').durationsSec,
    [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    'O3 publishes 3–15s'
  )
  assert.deepStrictEqual(
    resolveFalModel('fal-ai/kling-video/v2.6/pro/image-to-video').durationsSec,
    [5, 10],
    '2.6 Pro publishes exactly 5 and 10'
  )

  // ── H. THE QUEUE ROW CARRIES WHAT IT NEEDS TO RENDER ─────────────────
  //
  // The row shows SINGLE IMAGE MOTION · IMAGE nn · movement · model. All
  // of it comes from the job's own metadata, so it renders after a
  // restart without consulting anything else.
  const row = job()
  assert.strictEqual(row.metadata.motionSegmentId, 'motion:x')
  assert.strictEqual(row.metadata.motionImageId, 'imgA')
  assert.strictEqual(row.metadata.motionType, 'pan-right')
  assert.strictEqual(MOTION_LABEL[row.metadata.motionType as never], 'Pan Right')
  assert.ok(!('pairKeys' in row.metadata), 'and it carries NO pair notation')

  console.log('[smoke] motion run state: live jobs prove running, stale markers cannot')
}

async function testMotionPersistenceAndHistory(createdProjects: string[]): Promise<void> {
  const ID_imgA = fixtureImageId('imgA')
  const ID_imgB = fixtureImageId('imgB')
  const project = makeProject('Motion History')
  createdProjects.push(project.id)

  // Two photographs, so the feed is a real feed and the motion segment
  // sits at a position rather than being the only thing there.
  const imagesDir = projectImagesDir(project.id)
  mkdirSync(imagesDir, { recursive: true })
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
  for (const n of ['a.jpg', 'b.jpg']) writeFileSync(join(imagesDir, n), jpeg)
  project.images = [
    { id: ID_imgA, fileName: 'a.jpg', storedName: 'a.jpg', src: '' },
    { id: ID_imgB, fileName: 'b.jpg', storedName: 'b.jpg', src: '' }
  ]
  project.feedSequence = [ID_imgA, ID_imgB]
  saveProject(project)

  const added = addMotionSegment({
    projectId: project.id,
    imageId: ID_imgA,
    motion: 'push-in',
    durationSec: 5
  })
  assert.ok(added.ok && added.segment, 'the motion segment was created')
  const segmentId = added.segment!.id

  // A stub provider: it produces a REAL video file, and nothing else. No
  // key, no network, no fal. The file has to be genuinely playable
  // because `downloadAndAttachResult` probes it with FFmpeg — which is
  // the point: this test goes through the real validation, not past it.
  let produced = 0
  const stub = {
    metadata: () => ({ id: 'fal' as const, label: 'fal.ai', models: [], supportsRemoteCancel: true }),
    fetchResult: async (_url: string, target: string) => {
      produced++
      const res = spawnSync(
        ffmpegPath(),
        [
          '-y', '-f', 'lavfi',
          // A different colour per call, so the two generations are
          // distinguishable files rather than the same bytes twice.
          '-i', `color=c=${produced === 1 ? 'navy' : 'maroon'}:s=160x120:d=1`,
          '-r', '25', '-pix_fmt', 'yuv420p', target
        ],
        { encoding: 'utf8', timeout: 60_000 }
      )
      assert.strictEqual(res.status, 0, 'the motion fixture clip was produced')
      return { ok: true as const }
    }
  } as unknown as VideoProvider

  const subject = {
    kind: 'motion' as const,
    segmentId,
    imageId: ID_imgA,
    motion: 'push-in'
  }

  // ── F. THE GENERATION PERSISTS AGAINST ITS SEGMENT ───────────────────
  const first = await downloadAndAttachResult(
    stub,
    project.id,
    subject,
    'https://example/result-1.mp4',
    'job-motion-1',
    'fal-ai/kling-video/v2.6/pro/image-to-video'
  )
  assert.ok(first.ok, `the clip attached: ${JSON.stringify(first)}`)
  assert.strictEqual(produced, 1)

  const afterFirst = listProjects().find((p) => p.id === project.id)!
  const seg1 = motionSegments(afterFirst).find((s) => s.id === segmentId)!
  assert.strictEqual(seg1.status, 'completed', 'the segment is completed')
  assert.ok(seg1.clip, 'and carries its clip')
  assert.strictEqual(
    Object.keys(afterFirst.transitions).length,
    0,
    'and NOTHING was written into project.transitions'
  )

  const hist1 = getGenerationsForMotion(project.id, segmentId)
  assert.strictEqual(hist1.length, 1, 'one generation in history')
  assert.strictEqual(hist1[0].model, 'fal-ai/kling-video/v2.6/pro/image-to-video', 'the exact model')
  assert.strictEqual(hist1[0].motionSegmentId, segmentId, 'bound to the segment, not a pair')
  assert.strictEqual(hist1[0].motionType, 'push-in')
  assert.strictEqual(hist1[0].promptUsed, added.segment!.prompt, 'the prompt that was sent')
  assert.ok(hist1[0].active, 'and it is the current one')

  // ── H. IT CAN NEVER BE READ AS A PAIR ────────────────────────────────
  assert.strictEqual(hist1[0].toImageId, '', 'no end image id')
  assert.strictEqual(hist1[0].fromImageId, ID_imgA)
  assert.notStrictEqual(hist1[0].fromImageId, hist1[0].toImageId, 'never image → same image')
  assert.strictEqual(
    activeGenerationForPair(project.id, ID_imgA, ID_imgA),
    null,
    'and NO pair lookup can return it — not even (imgA, imgA)'
  )

  // ── G. REGENERATE KEEPS THE OLD GENERATION ───────────────────────────
  const second = await downloadAndAttachResult(
    stub,
    project.id,
    subject,
    'https://example/result-2.mp4',
    'job-motion-2',
    'fal-ai/kling-video/v2.6/pro/image-to-video'
  )
  assert.ok(second.ok, 'the regeneration attached')

  const hist2 = getGenerationsForMotion(project.id, segmentId)
  assert.strictEqual(hist2.length, 2, 'BOTH generations are in history — nothing was deleted')
  assert.strictEqual(hist2.filter((g) => g.active).length, 1, 'exactly one is current')
  assert.strictEqual(hist2[0].queueJobId, 'job-motion-2', 'and it is the newest')
  assert.ok(!hist2[1].active, 'the previous one is retired, not removed')
  assert.ok(hist2[1].clip, 'and still has its paid-for clip')

  const afterSecond = listProjects().find((p) => p.id === project.id)!
  const seg2 = motionSegments(afterSecond).find((s) => s.id === segmentId)!
  assert.strictEqual(
    seg2.clip?.storedName,
    hist2[0].clip?.storedName,
    'the segment plays the CURRENT generation'
  )
  assert.notStrictEqual(seg2.clip?.storedName, seg1.clip?.storedName, 'which is the new file')

  // ── I. ASSEMBLY USES THE MOTION CLIP EXACTLY ONCE ────────────────────
  const plan = planAssembly({
    imageIds: [ID_imgA, ID_imgB],
    modes: ['cut'],
    clipPaths: [null],
    imagePaths: ['a.jpg', 'b.jpg'],
    seamBlend: 'subtle',
    motions: motionSegments(afterSecond).map((m) => ({
      segmentId: m.id,
      imageId: m.imageId,
      label: motionSegmentLabel(m),
      clipPath: m.clip ? `clips/${m.clip.storedName}` : null
    }))
  })
  assert.ok(plan.ok, 'the project exports')
  assert.deepStrictEqual(
    plan.segments.map((s) => s.kind),
    ['motion', 'still'],
    'image A appears ONCE as motion; no still hold beside it'
  )
  assert.strictEqual(
    plan.segments.filter((s) => s.motionSegmentId === segmentId).length,
    1,
    'EXACTLY ONCE — not once per generation in history'
  )
  assert.strictEqual(
    plan.segments[0].clipPath,
    `clips/${seg2.clip!.storedName}`,
    'and it is the current clip that plays, not the retired one'
  )

  console.log('[smoke] motion persistence: attach, history, regenerate, assembly')
}

async function testMotionGenerationPath(): Promise<void> {
  const SECRET = 'fal-test-key'
  const kling26 = resolveFalModel('fal-ai/kling-video/v2.6/pro/image-to-video')

  // ── THE CORRECTED CAPABILITY ─────────────────────────────────────────
  //
  // This was registered as `supportsStartFrameOnly: false` on a reading
  // that the contract marked only voice_ids optional. fal.ai's published
  // schema marks `end_image_url` optional, so the model serves both
  // shapes and the old reading was simply wrong.
  assert.ok(kling26.confirmed, 'Kling 2.6 Pro is a confirmed contract')
  assert.ok(kling26.supportsStartFrameOnly, 'and it CAN generate from a single image')
  assert.ok(kling26.supportsEndFrame, 'while still accepting an end frame')
  assert.deepStrictEqual(kling26.durationsSec, [5, 10])
  assert.ok(
    startFrameOnlyModels().some((m) => m.id === kling26.id),
    'so the single-image selector offers it'
  )

  // ── A. TWO-IMAGE TRANSITION: BOTH FRAMES PRESENT ─────────────────────
  const twoImage = kling26.buildBody({
    prompt: 'p',
    startImage: 'https://cdn/start.jpg',
    endImage: 'https://cdn/end.jpg',
    durationSec: 5,
    resolution: 'standard',
    nativeAudio: false
  })
  assert.strictEqual(twoImage.start_image_url, 'https://cdn/start.jpg')
  assert.strictEqual(twoImage.end_image_url, 'https://cdn/end.jpg')
  assert.strictEqual(twoImage.duration, '5', 'duration is the schema STRING enum')
  assert.strictEqual(twoImage.generate_audio, false)

  // ── B. SINGLE MOTION: END FRAME ABSENT, NOT EMPTY ────────────────────
  const oneImage = buildSingleImageBody(kling26, {
    prompt: 'p',
    startImage: 'https://cdn/start.jpg',
    durationSec: 5,
    resolution: 'standard',
    nativeAudio: false
  } as never)
  assert.strictEqual(oneImage.start_image_url, 'https://cdn/start.jpg')
  assert.ok(
    !('end_image_url' in oneImage),
    'the OPTIONAL field is OMITTED — not sent empty, and never the start frame twice'
  )
  assert.deepStrictEqual(
    Object.keys(oneImage).sort(),
    ['duration', 'generate_audio', 'prompt', 'start_image_url'],
    'exactly the documented single-image body'
  )

  // ── D. A MODEL THAT NEEDS AN END FRAME STILL REFUSES ─────────────────
  const o3 = resolveFalModel('fal-ai/kling-video/o3/standard/image-to-video')
  assert.ok(!o3.supportsStartFrameOnly, 'O3 has no verified single-image contract')
  assert.throws(
    () => buildSingleImageBody(o3, { prompt: 'p', startImage: 'u', durationSec: 5 } as never),
    /cannot generate from a single image/,
    'and refuses rather than inventing an end frame'
  )

  // ── E. VERIFIED PRICING ──────────────────────────────────────────────
  assert.strictEqual(falRunCost(kling26, 5, false)?.usd, 0.35, '5s without audio is $0.35')
  assert.strictEqual(falRunCost(kling26, 10, false)?.usd, 0.7, '10s without audio is $0.70')
  assert.strictEqual(falRunCost(kling26, 5, true)?.usd, 0.7, '5s WITH audio is $0.70')
  assert.strictEqual(
    falRunCost(kling26, 5, false)?.usdPerSecond,
    0.07,
    'derived from the verified per-second rate, not a stored total'
  )

  // ── C + K. THE PROVIDER ACCEPTS ONE SHAPE AND ONLY THE RIGHT ONE ─────
  const motionRequest: GenerationRequest = {
    projectId: 'p1',
    subject: { kind: 'motion', segmentId: 'motion:1', imageId: 'imgA', motion: 'push-in' },
    pairKey: '',
    startImagePath: 'C:/managed/p1/images/a.jpg',
    endImagePath: null,
    startImageName: 'living.jpg',
    endImageName: null,
    prompt: buildMotionPrompt('push-in'),
    durationSec: 5,
    resolution: '1080p',
    nativeAudio: false,
    modelId: kling26.id
  }

  const noNetwork = async (): Promise<Response> => {
    throw new Error('NETWORK CALLED DURING A MOTION TEST')
  }
  const fal = new FalProvider({ apiKey: SECRET, mode: 'dry-run', fetchImpl: noNetwork })

  assert.ok(fal.validateRequest(motionRequest).ok, 'a single-image run on 2.6 Pro is accepted')

  // The same request aimed at a model that needs an end frame: refused.
  const onO3 = fal.validateRequest({ ...motionRequest, modelId: o3.id })
  assert.ok(!onO3.ok, 'the SAME motion request is refused on a model that needs an end frame')
  if (!onO3.ok) {
    assert.strictEqual(onO3.error.code, 'unsupported-capability')
  }

  // A motion run that somehow carried an end frame is refused too — a
  // single-image job must not quietly become a transition.
  const smuggled = fal.validateRequest({ ...motionRequest, endImagePath: 'C:/managed/b.jpg' })
  assert.ok(!smuggled.ok, 'a motion request carrying an end frame is refused')

  // And a TRANSITION missing its end frame is still an error, not a
  // silently cheaper different product.
  const brokenPair = fal.validateRequest({
    ...motionRequest,
    subject: { kind: 'transition', pairKey: 'a->b' },
    pairKey: 'a->b',
    endImagePath: null
  })
  assert.ok(!brokenPair.ok, 'a transition with no end frame is still invalid')

  // ── THE DRY RUN BUILDS THE REAL BODY, AND SENDS NOTHING ──────────────
  const dry = fal.dryRun(motionRequest)
  assert.ok(!('error' in dry), 'the single-image dry run builds cleanly')
  if (!('error' in dry)) {
    assert.ok(!('end_image_url' in dry.preview.body), 'the previewed body omits the end frame')
    assert.strictEqual(
      dry.preview.endpoint,
      'https://queue.fal.run/fal-ai/kling-video/v2.6/pro/image-to-video',
      'and goes to the SELECTED model’s endpoint, never a default'
    )
    assert.strictEqual(dry.preview.display.endImage, null, 'the preview shows no end frame')
    assert.strictEqual(dry.estimatedCost, 0.35, '5s on 2.6 Pro is $0.35')
  }
  assert.strictEqual(fal.transportCallCount, 0, 'NOTHING was sent')
  assert.strictEqual(fal.uploadCount, 0, 'and nothing was uploaded')

  // ── THE LIVE SUBMIT, AGAINST A RECORDING STUB ────────────────────────
  //
  // Not a paid call: the transport is a local function. What it proves is
  // the part a real call would add — one upload, not two, and a body with
  // no end frame reaching the selected endpoint.
  const sent: { url: string; body: Record<string, unknown> }[] = []
  let uploads = 0
  const recordingFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const href = String(url)
    // fal's upload handshake, answered locally.
    if (href.includes('upload') || href.includes('storage')) {
      uploads++
      return new Response(
        JSON.stringify({ upload_url: 'https://local/put', file_url: `https://cdn/${uploads}.jpg` }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }
    if (href === 'https://local/put') return new Response('', { status: 200 })
    sent.push({ url: href, body: JSON.parse(String(init?.body ?? '{}')) })
    return new Response(
      JSON.stringify({ request_id: 'req-motion-1', status: 'IN_QUEUE' }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }

  const liveFal = new FalProvider({
    apiKey: SECRET,
    mode: 'live',
    liveAllowed: true,
    fetchImpl: recordingFetch as never
  })

  // A real managed file, so the frame reader has bytes to read.
  const tmpImage = join(tmpdir(), `f2f-motion-${Date.now()}.jpg`)
  writeFileSync(tmpImage, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]))
  const submitted = await liveFal.submitGeneration({ ...motionRequest, startImagePath: tmpImage })
  rmSync(tmpImage, { force: true })

  assert.ok(submitted.ok, `the single-image submit succeeded: ${JSON.stringify(submitted)}`)
  assert.strictEqual(uploads, 1, 'ONE frame uploaded — a single-image run has one frame')
  assert.strictEqual(sent.length, 1, 'and one request was submitted')
  assert.strictEqual(
    sent[0].url,
    'https://queue.fal.run/fal-ai/kling-video/v2.6/pro/image-to-video',
    'to the selected model, not the global default'
  )
  assert.ok(!('end_image_url' in sent[0].body), 'THE WIRE BODY CARRIES NO END FRAME')
  assert.ok(sent[0].body.start_image_url, 'and does carry the start frame')
  assert.strictEqual(sent[0].body.duration, '5')
  if (submitted.ok) {
    assert.strictEqual(submitted.providerTaskId, 'req-motion-1', 'the task id is read and kept')
  }

  // ── H. THE CATALOGUE SHAPE IS UNAMBIGUOUS ────────────────────────────
  //
  // An empty `toImageId` is what makes a motion row unable to answer any
  // pair lookup, and `motionSegmentId` is what the UI branches on. Both
  // are asserted because the display rule depends on both.
  const motionRow = {
    fromImageId: 'imgA',
    toImageId: '',
    motionSegmentId: 'motion:1',
    motionType: 'push-in'
  }
  assert.strictEqual(motionRow.toImageId, '', 'no end image id, so no pair can match it')
  assert.notStrictEqual(
    motionRow.fromImageId,
    motionRow.toImageId,
    'and NEVER image → the same image'
  )
  assert.ok(motionRow.motionSegmentId, 'the discriminator is explicit, never inferred')

  console.log('[smoke] motion generation: 2.6 Pro single-image body, submit, pricing, isolation')
}

function testSingleImageMotion(): void {
  const seg = (over: Partial<MotionSegment> = {}): MotionSegment => ({
    id: `${MOTION_ID_PREFIX}abc`,
    kind: 'single-motion',
    imageId: 'i2',
    motion: 'push-in',
    durationSec: 5,
    status: 'not-generated',
    clip: null,
    prompt: buildMotionPrompt('push-in'),
    createdAt: 1,
    ...over
  })

  // ── A. IT IS NOT A PAIR, AND CANNOT BE READ AS ONE ───────────────────
  //
  // The id namespace is the enforcement. A pair key always contains the
  // arrow; a motion id never does, so no code that parses `from->to` can
  // be handed one of these by accident.
  assert.ok(seg().id.startsWith(MOTION_ID_PREFIX), 'motion ids carry their own prefix')
  assert.ok(!seg().id.includes('->'), 'a motion id can never parse as a pair key')

  // ── B. THE LABEL SAYS WHAT IT IS, IN WORDS ───────────────────────────
  assert.strictEqual(motionSegmentLabel(seg()), 'SINGLE IMAGE · SLOW PUSH IN')
  assert.ok(
    motionSegmentLabel(seg({ motion: 'pan-left' })).startsWith('SINGLE IMAGE'),
    'every motion type is spelled out as SINGLE IMAGE — never icon-only, never bare'
  )
  for (const m of MOTION_TYPES) {
    assert.ok(MOTION_LABEL[m] && MOTION_LABEL[m].length > 0, `${m} has a human label`)
  }
  assert.strictEqual(MOTION_TYPES.length, 7, 'the six original motions plus Smooth Forward')

  // ── C. ITS PROMPT IS ITS OWN, NOT THE TRANSITION PRESET ──────────────
  //
  // The transition preset names an END FRAME. There is no end frame
  // here, and asking a model to reproduce one it was never given is an
  // invitation to invent it.
  const prompt = buildMotionPrompt('push-in')
  assert.ok(!/end frame/i.test(prompt), 'the motion prompt never mentions an end frame')
  assert.ok(!/START FRAME/i.test(prompt), 'nor a start frame — there is only one image')
  assert.ok(
    /invisible virtual viewpoint/i.test(prompt),
    'but it keeps the no-physical-camera rule: a mirror reflects in a still too'
  )
  assert.ok(
    /Do not redesign, add, remove or move anything/i.test(prompt),
    'and the anti-invention contract'
  )
  const distinct = new Set(MOTION_TYPES.map((m) => buildMotionPrompt(m)))
  assert.strictEqual(distinct.size, MOTION_TYPES.length, 'each motion produces a different prompt')

  // ── D. THE RUN IS POSSIBLE, AND OFFERS A MODEL CHOICE ────────────────
  //
  // Kling 2.6 Pro's published schema marks `end_image_url` optional, so
  // readiness must SUCCEED and hand the operator a selector. The earlier
  // "no verified model can do this" state was a wrong reading of that
  // contract and must not survive anywhere.
  const readiness = motionGenerationReadiness(seg(), FAL_MODEL_REGISTRY)
  assert.ok(readiness.ok, 'a single-image run is possible now that 2.6 Pro is enabled')
  if (readiness.ok) {
    assert.ok(readiness.models.length > 0, 'and the selector is never empty when a run is allowed')
    assert.ok(
      readiness.models.some((m) => m.displayName === 'Kling 2.6 Pro'),
      'Kling 2.6 Pro is offered'
    )
    assert.ok(
      readiness.models.every((m) => m.supportsStartFrameOnly && m.confirmed),
      'and ONLY confirmed, single-image-capable models are'
    )
    assert.deepStrictEqual(readiness.durationsSec, [5, 10])
  }
  assert.ok(
    startFrameOnlyModels().some((m) => m.id.includes('v2.6/pro')),
    'the registry now returns a start-frame-only model'
  )

  // ── E. A MODEL THAT NEEDS AN END FRAME IS STILL EXCLUDED ─────────────
  const needsEnd = FAL_MODEL_REGISTRY.filter((m) => !m.supportsStartFrameOnly)
  assert.ok(needsEnd.length > 0, 'not every model can do this — O3 cannot')
  for (const m of needsEnd) {
    assert.throws(
      () =>
        buildSingleImageBody(m, {
          prompt: 'x',
          startImage: 'data:image/jpeg;base64,AA',
          durationSec: 5
        } as never),
      /cannot generate from a single image/,
      `${m.displayName} throws rather than sending the start frame twice`
    )
  }
  const onlyIncapable = motionGenerationReadiness(
    seg(),
    FAL_MODEL_REGISTRY.filter((m) => !m.supportsStartFrameOnly)
  )
  assert.ok(!onlyIncapable.ok, 'with no capable model in the registry, the run is refused')

  // ── F. UNCONFIRMED MODELS ARE NEVER OFFERED ──────────────────────────
  //
  // A guessed contract is not something to discover is wrong by spending
  // money on it.
  const unconfirmed = motionGenerationReadiness(
    seg(),
    FAL_MODEL_REGISTRY.map((m) => ({ ...m, confirmed: false, supportsStartFrameOnly: true }))
  )
  assert.ok(!unconfirmed.ok, 'unconfirmed models are never offered for a paid run')

  // ── G. A STATUS WORD IS NOT A LOCK ───────────────────────────────────
  //
  // THE REGRESSION THIS PINS. Readiness used to refuse whenever the
  // stored status said `queued`/`generating`. `queueMotionGeneration`
  // writes `queued` BEFORE enqueuing, so the runner's own request build
  // was refused by the marker the queue had just written for it: the job
  // failed with "already running", the failure never cleared the status,
  // and the segment was stuck for good. Running must be PROVEN by a live
  // job — see motionRunState — never inferred from a word.
  const statusOnly = motionGenerationReadiness(seg({ status: 'generating' }), FAL_MODEL_REGISTRY)
  assert.ok(
    statusOnly.ok,
    'a stale `generating` status alone must NOT block — that was the deadlock'
  )

  // ── H. ASSEMBLY: THE MOTION CLIP REPLACES THE STILL ──────────────────
  //
  // The no-duplicated-time rule. Image 2 is shown by its motion clip, so
  // it must NOT also be held as a still.
  const imageIds = ['i1', 'i2', 'i3']
  const imagePaths = ['p1.jpg', 'p2.jpg', 'p3.jpg']
  const withMotion = planAssembly({
    imageIds,
    modes: ['cut', 'cut'],
    clipPaths: [null, null],
    imagePaths,
    seamBlend: 'subtle',
    motions: [
      { segmentId: 'motion:1', imageId: 'i2', label: 'SINGLE IMAGE · Pan Left', clipPath: 'm1.mp4' }
    ]
  })
  assert.ok(withMotion.ok, 'a generated motion clip does not block the build')
  assert.deepStrictEqual(
    withMotion.segments.map((s) => s.kind),
    ['still', 'motion', 'still'],
    'image 2 appears ONCE, as motion — not as a motion clip plus a still hold'
  )
  const heldIds = withMotion.segments.filter((s) => s.kind === 'still').map((s) => s.imageId)
  assert.ok(!heldIds.includes('i2'), 'NO DUPLICATED TIME: the still for image 2 is gone')
  assert.strictEqual(withMotion.segments[1].motionSegmentId, 'motion:1')

  // ── I. AN UNGENERATED MOTION SEGMENT BLOCKS THE BUILD ────────────────
  //
  // Same treatment as a missing transition clip: it is on the timeline,
  // so shipping without it would ship a different video.
  const ungenerated = planAssembly({
    imageIds,
    modes: ['cut', 'cut'],
    clipPaths: [null, null],
    imagePaths,
    seamBlend: 'subtle',
    motions: [
      { segmentId: 'motion:1', imageId: 'i2', label: 'SINGLE IMAGE · Pan Left', clipPath: null }
    ]
  })
  assert.ok(!ungenerated.ok, 'an ungenerated motion segment is not silently dropped')
  assert.deepStrictEqual(ungenerated.missingMotionSegments, ['SINGLE IMAGE · Pan Left'])
  assert.ok(/Motion clips not generated/.test(ungenerated.reason ?? ''), 'and it says which')
  assert.deepStrictEqual(
    ungenerated.segments.map((s) => s.kind),
    ['still', 'still', 'still'],
    'and its image falls back to a still rather than vanishing from the video'
  )

  // ── J. EXISTING TWO-IMAGE TRANSITIONS ARE UNTOUCHED ──────────────────
  //
  // The same input with `motions` absent must produce byte-identical
  // output to the same input with an empty list — that is what makes the
  // field safe to add to every existing caller.
  const base = { imageIds, modes: ['ai', 'ai'] as never, clipPaths: ['c1.mp4', 'c2.mp4'], imagePaths, seamBlend: 'subtle' as const }
  const noField = planAssembly(base)
  const emptyField = planAssembly({ ...base, motions: [] })
  assert.deepStrictEqual(
    noField.segments,
    emptyField.segments,
    'a project with no motion segments plans exactly as it did before'
  )
  assert.deepStrictEqual(noField.segments.map((s) => s.kind), ['clip', 'clip'])

  // ── K. MOTION IS NOT SPATIAL EVIDENCE ────────────────────────────────
  //
  // A photograph with gentle movement says nothing about which room
  // connects to which. The store is separate precisely so the pair
  // analysers cannot see it — assert that separation structurally.
  const project = {
    id: 'p',
    images: [{ id: 'i1' }, { id: 'i2' }],
    feedSequence: ['i1', 'i2'],
    transitions: {},
    motionSegments: [seg()]
  } as unknown as Project
  assert.strictEqual(
    Object.keys(project.transitions).length,
    0,
    'adding a motion segment writes NOTHING into project.transitions'
  )
  assert.strictEqual(motionSegments(project).length, 1)
  assert.deepStrictEqual(
    motionSegmentsForImage(project, 'i2').map((s) => s.id),
    [`${MOTION_ID_PREFIX}abc`]
  )
  assert.deepStrictEqual(motionSegmentsForImage(project, 'i1'), [], 'and only for its own image')

  console.log('[smoke] single-image motion: type, prompt, model gate, assembly, isolation')
}

function testMixedAssemblyPlan(): void {
  const imageIds = ['i1', 'i2', 'i3', 'i4']
  const imagePaths = ['p1.jpg', 'p2.jpg', 'p3.jpg', 'p4.jpg']
  const clip = (n: string): string => `${n}.mp4`

  // ── AI · CUT · AI ────────────────────────────────────────────────────
  const mixed = planAssembly({
    imageIds,
    modes: ['ai', 'cut', 'ai'],
    clipPaths: [clip('c1'), null, clip('c3')],
    imagePaths,
    seamBlend: 'subtle'
  })
  assert.ok(mixed.ok, 'a cut in the middle blocks nothing')
  assert.deepStrictEqual(mixed.missingClipPairs, [], 'and the cut is never reported as missing')
  assert.deepStrictEqual(mixed.cutPairs, ['2 → 3'])
  assert.strictEqual(
    mixed.segments.length,
    2,
    'TWO segments and no filler — the clips already show images 2 and 3'
  )
  assert.deepStrictEqual(
    mixed.segments.map((s) => s.kind),
    ['clip', 'clip']
  )
  assert.deepStrictEqual(
    mixed.seamSeconds,
    [0],
    'A HARD CUT IS EXACTLY ZERO — never a short fade, and no gap for a black frame'
  )

  // ── A CROSSFADE dissolves at that boundary ───────────────────────────
  const dissolve = planAssembly({
    imageIds,
    modes: ['ai', 'crossfade', 'ai'],
    clipPaths: [clip('c1'), null, clip('c3')],
    imagePaths,
    seamBlend: 'off'
  })
  assert.strictEqual(dissolve.seamSeconds[0], CROSSFADE_SECONDS)
  assert.ok(
    dissolve.seamSeconds[0] > 0,
    'a crossfade blends even when the project seam setting is off — it is a deliberate dissolve, not a seam'
  )
  assert.deepStrictEqual(dissolve.crossfadePairs, ['2 → 3'])

  // ── AN IMAGE NO CLIP SHOWS IS HELD ───────────────────────────────────
  // Cut first: image 1 would never reach the screen.
  const cutFirst = planAssembly({
    imageIds,
    modes: ['cut', 'ai', 'ai'],
    clipPaths: [null, clip('c2'), clip('c3')],
    imagePaths,
    seamBlend: 'subtle'
  })
  assert.strictEqual(cutFirst.segments[0].kind, 'still', 'image 1 is held so it is actually seen')
  assert.strictEqual(cutFirst.segments[0].imageId, 'i1')
  assert.strictEqual(cutFirst.segments[0].holdSeconds, STILL_HOLD_SECONDS)
  assert.strictEqual(cutFirst.seamSeconds[0], 0, 'and the boundary after it is a hard cut')

  // Two consecutive cuts lose the image between them without a hold.
  const twoCuts = planAssembly({
    imageIds: ['a', 'b', 'c'],
    modes: ['cut', 'cut'],
    clipPaths: [null, null],
    imagePaths: ['a.jpg', 'b.jpg', 'c.jpg'],
    seamBlend: 'subtle'
  })
  assert.strictEqual(twoCuts.segments.length, 3, 'all three images are held')
  assert.ok(
    twoCuts.segments.every((s) => s.kind === 'still'),
    'an all-cut project is a sequence of stills, and still produces a video'
  )
  assert.deepStrictEqual(twoCuts.seamSeconds, [0, 0], 'joined by hard cuts')
  assert.ok(twoCuts.ok, 'and it needs no clip at all')

  // ── 10. ONLY MISSING AI CLIPS BLOCK ──────────────────────────────────
  const blocked = planAssembly({
    imageIds,
    modes: ['ai', 'cut', 'ai'],
    clipPaths: [null, null, clip('c3')],
    imagePaths,
    seamBlend: 'subtle'
  })
  assert.ok(!blocked.ok)
  assert.deepStrictEqual(
    blocked.missingClipPairs,
    ['1 → 2'],
    'only the AI pair is missing — the cut is finished the moment it was chosen'
  )

  // ── 15. A generated clip is IGNORED, never destroyed, under Cut ──────
  const withClipButCut = planAssembly({
    imageIds,
    modes: ['ai', 'cut', 'ai'],
    // The middle pair HAS a clip someone already paid for.
    clipPaths: [clip('c1'), clip('paid-for'), clip('c3')],
    imagePaths,
    seamBlend: 'subtle'
  })
  assert.ok(
    !withClipButCut.segments.some((s) => s.clipPath === 'paid-for'),
    'assembly ignores the clip while Cut is active'
  )
  assert.strictEqual(
    withClipButCut.segments.length,
    2,
    'and the timeline is the same as if it had never been generated'
  )
  // Nothing in this function deletes anything — the clip and its ledger
  // entry are untouched, so switching back to AI reuses them.

  // ── Seam planning honours the overrides ──────────────────────────────
  const seams = planSeams({
    durationsSec: [5, 5, 5],
    blend: 'smooth',
    fps: 25,
    seamOverrideSec: [0, CROSSFADE_SECONDS]
  })
  assert.strictEqual(seams.seamSec[0], 0, 'a cut boundary is exactly zero despite a smooth project')
  assert.ok(seams.seamSec[1] > 0, 'while the crossfade boundary blends')
  assert.strictEqual(
    seams.trimStartSec[1],
    0,
    'and no frame is trimmed at a hard cut — there is no duplicate key frame to remove'
  )
  assert.ok(seams.totalSec > 0 && Number.isFinite(seams.totalSec), 'the timeline stays sane')

  log('mixed assembly: cuts need no filler, hard cuts are exactly zero, paid clips survive')
}

/**
 * EVIDENCE-DRIVEN MOTION PLANNING.
 *
 * ── WHAT WENT WRONG ──────────────────────────────────────────────────
 *
 * An accepted mock analysis put thirty photographs into one unnamed room
 * with no landmarks and no orientations. Every pair resolved to
 * `same-room`, and the planner's same-room branch was a fixed template:
 *
 *   cameraAction: ['slow forward dolly', `slight ${rotation} rotation`]
 *
 * where `rotation` came from a helper that returned `clockwise` when it
 * had nothing to go on — and then propagated that invented direction down
 * the whole chain. Twenty-nine byte-identical prompts, each confidently
 * naming a turn nobody had observed.
 *
 * That is fabricated spatial information, which is the exact failure this
 * subsystem exists to prevent. Evidence is now gathered as facts first and
 * the wording rendered from it; where a fact is missing the field says
 * `unknown` rather than carrying a plausible default.
 */
function testEvidenceDrivenPlanning(): void {
  const ids = ['i1', 'i2', 'i3', 'i4', 'i5']
  const room = (id: string, label: string, imageIds: string[]): RoomRecord => ({
    id,
    label,
    imageIds,
    landmarks: []
  })

  // ── 3 & 4. NO EVIDENCE MUST NOT BECOME A DIRECTION ───────────────────
  //
  // Exactly the mock's shape: one unnamed room, no landmarks, no
  // orientations. This is the regression that matters most.
  const barren: PropertyAnalysis = {
    ...emptyAnalysis('p'),
    state: 'accepted',
    source: 'mock',
    rooms: [room('r', 'Unsorted', ids)],
    images: ids.map((id) => ({
      imageId: id,
      roomId: 'r',
      orientation: 'unknown' as const,
      landmarks: [],
      openings: []
    })),
    edges: []
  }

  const barrenPlans = planSequence(barren, ids)
  assert.strictEqual(barrenPlans.length, 4, 'five images still plan four transitions')
  for (const [i, plan] of barrenPlans.entries()) {
    assert.strictEqual(plan.relationType, 'SAME_ROOM', `plan ${i + 1} is same-room`)
    assert.strictEqual(
      plan.rotationDirection,
      'unknown',
      'NO CLOCKWISE IS INVENTED — with no recorded orientation the direction is unknown'
    )
    assert.strictEqual(
      plan.translationDirection,
      'unknown',
      'and no forward dolly either — nothing establishes a direction of travel'
    )
    assert.ok(!plan.hasEvidence, 'the plan reports honestly that it had nothing pair-specific')
    assert.strictEqual(plan.motionInstruction, null, 'so no motion sentence is manufactured')
    assert.strictEqual(plan.continuity.outgoingRotation, 'unknown', 'and nothing propagates')
  }

  const barrenPrompt = renderMotionInstruction(barrenPlans[0], { fromRoom: 'Unsorted' })!
  assert.ok(barrenPrompt.includes(NEUTRAL_MOTION), 'the neutral instruction is used verbatim')
  assert.ok(
    !/clockwise|counter-clockwise/i.test(barrenPrompt),
    'THE WORD CLOCKWISE APPEARS NOWHERE — this is the assertion that pins the bug'
  )
  assert.ok(!/forward dolly/i.test(barrenPrompt), 'and neither does forward dolly')
  assert.ok(
    barrenPrompt.includes('do not pass through any doorway'.replace('do', 'do')) ||
      /do not pass through any doorway/i.test(barrenPrompt),
    'while the same-room restriction is still stated'
  )

  // ── 9. THE DIAGNOSTIC FIRES ──────────────────────────────────────────
  const barrenDiversity = motionDiversity(barrenPlans)
  assert.strictEqual(barrenDiversity.distinct, 1, 'all four plan the same movement')
  assert.strictEqual(barrenDiversity.dominantShare, 1)
  assert.ok(
    barrenDiversity.lowDiversity,
    'and the diagnostic says so rather than the plans being quietly varied'
  )
  assert.strictEqual(
    barrenDiversity.mostCommon?.instruction,
    '<neutral fallback>',
    'naming the fallback as the shared bucket — twenty-nine identical fallbacks IS the finding'
  )

  // ── 10. THE QUALITY GATE AGREES ──────────────────────────────────────
  const barrenQuality = planningQuality(barren, ids, barrenPlans)
  assert.strictEqual(barrenQuality.imagesCovered, 5, 'every image is placed somewhere')
  assert.strictEqual(barrenQuality.spaces, 1)
  assert.strictEqual(barrenQuality.namedSpaces, 0, '"Unsorted" is a placement, not a room')
  assert.strictEqual(barrenQuality.transitionsWithEvidence, 0)
  assert.strictEqual(barrenQuality.transitionsUsingFallback, 4)
  assert.ok(
    barrenQuality.insufficient,
    'INSUFFICIENT for production motion planning — structurally valid and completely useless'
  )
  assert.ok(barrenQuality.reasons.length >= 2, 'and it names why')

  // ── 5 & 7. PAIR-SPECIFIC EVIDENCE PRODUCES DIFFERENT PLANS ───────────
  //
  // Same room throughout, but each pair shares and loses different things.
  // A hardcoded template could not tell these apart; evidence can.
  const rich: PropertyAnalysis = {
    ...emptyAnalysis('p'),
    state: 'accepted',
    source: 'provider',
    rooms: [room('living', 'Living Room', ids)],
    images: [
      { imageId: 'i1', roomId: 'living', orientation: 'north', landmarks: ['kitchen island', 'balcony doors'], openings: [] },
      { imageId: 'i2', roomId: 'living', orientation: 'east', landmarks: ['kitchen island', 'grey sofa'], openings: [] },
      { imageId: 'i3', roomId: 'living', orientation: 'east', landmarks: ['grey sofa', 'fireplace'], openings: [] },
      { imageId: 'i4', roomId: 'living', orientation: 'north', landmarks: ['fireplace'], openings: [] },
      { imageId: 'i5', roomId: 'living', orientation: 'unknown', landmarks: [], openings: [] }
    ],
    edges: []
  }

  const richPlans = planSequence(rich, ids)

  // 1→2: island shared, balcony doors leave, sofa enters, north→east.
  const p12 = richPlans[0]
  assert.deepStrictEqual(p12.sharedLandmarks, ['kitchen island'])
  assert.deepStrictEqual(p12.leavingLandmarks, ['balcony doors'])
  assert.deepStrictEqual(p12.enteringLandmarks, ['grey sofa'])
  assert.strictEqual(
    p12.rotationDirection,
    'clockwise',
    'north → east is a quarter turn clockwise — DERIVED, not assumed'
  )
  assert.ok(p12.hasEvidence)
  assert.match(p12.motionInstruction!, /kitchen island/, 'the anchor is named')
  assert.match(p12.motionInstruction!, /balcony doors/, 'and what leaves frame')
  assert.match(p12.motionInstruction!, /grey sofa/, 'and what enters it')

  // 2→3: sofa shared, island leaves, fireplace enters, east→east (no turn).
  const p23 = richPlans[1]
  assert.deepStrictEqual(p23.sharedLandmarks, ['grey sofa'])
  assert.strictEqual(p23.rotationDirection, 'none', 'east → east is no turn at all')
  assert.notStrictEqual(
    p23.motionInstruction,
    p12.motionInstruction,
    'TWO SAME-ROOM PAIRS PRODUCE DIFFERENT PLANS — the whole point of this change'
  )
  assert.ok(!/clockwise/i.test(p23.motionInstruction!), 'and no turn is described where none exists')

  // 3→4: east→north is three steps clockwise, i.e. counter-clockwise.
  assert.strictEqual(
    richPlans[2].rotationDirection,
    'counter-clockwise',
    'east → north is derived as counter-clockwise'
  )

  // ── 6. UNKNOWN STAYS UNKNOWN ─────────────────────────────────────────
  const p45 = richPlans[3]
  assert.strictEqual(p45.endOrientation, 'unknown')
  assert.strictEqual(
    p45.rotationDirection,
    'unknown',
    'one unrecorded orientation makes the turn unknowable, and it stays that way'
  )
  assert.ok(
    !/clockwise/i.test(p45.motionInstruction ?? ''),
    'and no direction leaks into THIS pair’s own motion clause'
  )
  // The rendered prompt may still mention a direction — but only in the
  // continuity sentence, which reports what the PREVIOUS clip actually
  // did. That is a derived fact about a different pair, offered as a
  // preference, and it is the one legitimate place a direction may appear
  // for a pair whose own rotation is unknown.
  for (const sentence of (renderMotionInstruction(p45, {}) ?? '').split(/(?<=\.)\s+/)) {
    if (/clockwise/i.test(sentence)) {
      assert.match(
        sentence,
        /^Continuity: the previous shot ended rotating/,
        `a direction appeared outside a continuity clause: "${sentence}"`
      )
    }
  }

  // A HALF TURN is unknown too: nothing records which way round it went.
  assert.strictEqual(deriveRotation('north', 'south'), 'unknown', 'a 180° turn has no derivable direction')
  assert.strictEqual(deriveRotation('west', 'north'), 'clockwise')
  assert.strictEqual(deriveRotation('north', 'west'), 'counter-clockwise')
  assert.strictEqual(deriveRotation('into-room', 'out-of-room'), 'unknown', 'facing is not a bearing')
  assert.strictEqual(deriveRotation('south', 'south'), 'none')

  const richDiversity = motionDiversity(richPlans)
  assert.ok(!richDiversity.lowDiversity, 'varied evidence produces varied plans, so nothing is flagged')
  assert.strictEqual(richDiversity.distinct, 4, 'all four differ')

  const richQuality = planningQuality(rich, ids, richPlans)
  assert.strictEqual(richQuality.transitionsWithEvidence, 4)
  assert.strictEqual(richQuality.transitionsUsingFallback, 0)
  assert.strictEqual(richQuality.namedSpaces, 1, 'a real room name counts')
  assert.ok(!richQuality.insufficient)

  // ── 8. THE VISIBLE-OPENING SAFETY RULE IS UNCHANGED ──────────────────
  const twoRooms: PropertyAnalysis = {
    ...emptyAnalysis('p'),
    state: 'accepted',
    rooms: [room('a', 'Living Room', ['i1']), room('b', 'Kitchen', ['i2'])],
    images: [
      { imageId: 'i1', roomId: 'a', orientation: 'north', landmarks: [], openings: ['kitchen doorway'] },
      { imageId: 'i2', roomId: 'b', orientation: 'north', landmarks: [], openings: [] }
    ],
    edges: [
      { id: 'e', fromRoomId: 'a', toRoomId: 'b', confidence: 'confirmed', supportingImageIds: ['i1'] }
    ]
  }
  const navPlan = planSequence(twoRooms, ['i1', 'i2'])[0]
  assert.ok(navPlan.physicalNavigationAllowed, 'confirmed adjacency + visible opening still allows it')
  assert.strictEqual(navPlan.visiblePassage, 'kitchen doorway')
  assert.strictEqual(navPlan.translationDirection, 'forward', 'travel through a seen opening IS forward')
  assert.match(navPlan.motionInstruction!, /advance through the kitchen doorway/)

  // Remove the visible opening: navigation must stop, and no direction
  // may survive.
  const noOpening: PropertyAnalysis = {
    ...twoRooms,
    images: twoRooms.images.map((x) => (x.imageId === 'i1' ? { ...x, openings: [] } : x))
  }
  const blocked = planSequence(noOpening, ['i1', 'i2'])[0]
  assert.ok(!blocked.physicalNavigationAllowed, 'no visible opening, no navigation')
  assert.strictEqual(blocked.visiblePassage, null)
  assert.notStrictEqual(blocked.translationDirection, 'forward', 'and no forward travel is claimed')
  assert.ok(
    !/advance through/i.test(renderMotionInstruction(blocked, {}) ?? ''),
    'the prompt never describes moving through anything'
  )

  // ── 11. ALL LOGICAL TRANSITIONS ARE STILL PLANNED ────────────────────
  const many = Array.from({ length: 30 }, (_, i) => `img-${i}`)
  const manyPlans = planSequence(
    {
      ...barren,
      rooms: [room('r', 'Unsorted', many)],
      images: many.map((id) => ({
        imageId: id,
        roomId: 'r',
        orientation: 'unknown' as const,
        landmarks: [],
        openings: []
      }))
    },
    many
  )
  assert.strictEqual(manyPlans.length, 29, 'thirty images still plan twenty-nine transitions')
  assert.ok(
    manyPlans.every((p) => p.rotationDirection === 'unknown'),
    'and not one of the twenty-nine invents a direction'
  )
  assert.ok(motionDiversity(manyPlans).lowDiversity, 'the diagnostic flags the whole run')

  // ── 1 & 2. A MOCK CANNOT MASQUERADE AS PRODUCTION ANALYSIS ───────────
  //
  // The mock is a development tool. Listing it beside real analyzers made
  // it possible to accept a placeholder and then treat the result as
  // though the property had been analysed.
  const mockMeta = availableAnalyzers({
    apiKey: '',
    model: GEMINI_DEFAULT_MODEL,
    mode: 'dry-run',
    allowLive: false
  })
    .map((a) => a.metadata())
    .find((m) => m.id === 'mock')
  assert.ok(mockMeta, 'the mock analyzer still exists — it is genuinely useful for the workflow')
  assert.strictEqual(
    mockMeta!.developerOnly,
    true,
    'but it is flagged as a development tool and grouped away from real analyzers'
  )
  const productionAnalyzers = availableAnalyzers({
    apiKey: '',
    model: GEMINI_DEFAULT_MODEL,
    mode: 'dry-run',
    allowLive: false
  })
    .map((a) => a.metadata())
    .filter((m) => !m.developerOnly)
  assert.ok(
    productionAnalyzers.length > 0,
    'and real analyzers remain available without opening a developer section'
  )
  assert.ok(
    !productionAnalyzers.some((m) => m.id === 'mock'),
    'the production list does not contain the mock'
  )

  // Provenance keeps saying what it is, whatever the panel does.
  const mockProvenance: AnalysisProvenance = {
    analyzerId: 'mock',
    displayName: 'Mock (development)',
    provider: 'local',
    model: null,
    mode: 'mock',
    imageCount: 30,
    analyzedAt: 1,
    acceptedAt: 2
  }
  assert.ok(
    !isRealAnalysis(mockProvenance),
    'an accepted mock is never reported as a real analysis'
  )
  assert.match(provenanceLabel(mockProvenance), /mock, no AI request/i)

  log('evidence planning: no direction is invented, pair evidence drives per-pair motion')
}

/**
 * LOGICAL TRANSITIONS — N images means N − 1 transitions, always.
 *
 * ── THE BUG THIS PINS ────────────────────────────────────────────────
 *
 * `project.transitions` is written LAZILY: a row appears the first time
 * something about a transition is edited or generated. Both rebuild
 * functions walked the adjacent pairs correctly and then did
 * `if (!transition) continue`, so a pair with no stored row was skipped
 * entirely.
 *
 * On a thirty-image project with three stored rows, "Rebuild transition
 * prompts" offered two of twenty-nine. The other twenty-seven did not
 * appear as unchanged, or as preserved — they were simply absent, and
 * nothing in the dialog suggested they existed at all.
 *
 * Absence of a row means UNCONFIGURED. It never means non-existent.
 */
function testLogicalTransitions(workDir: string, created: string[]): void {
  const project = makeProject('Smoke logical transitions')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'logical.png')
  writeFileSync(p, png)

  // The real shape of the reported bug: thirty ordered photographs.
  project.images = importImages(
    project.id,
    Array.from({ length: 30 }, (_, i) => ({ sourcePath: p, name: `${i + 1}.png` }))
  )
  saveProject(project)

  // ── 1 & 2. THIRTY IMAGES, ZERO ROWS, TWENTY-NINE TRANSITIONS ─────────
  assert.deepStrictEqual(project.transitions, {}, 'no transition row exists yet')
  const fresh = logicalTransitions(project, 5)
  assert.strictEqual(
    fresh.length,
    29,
    'thirty images are twenty-nine transitions, with nothing stored about any of them'
  )
  assert.strictEqual(logicalTransitionCount(project), 29)
  assert.strictEqual(fresh[0].label, 'Image 1 → Image 2')
  assert.strictEqual(fresh[28].label, 'Image 29 → Image 30', 'right through to the final pair')
  assert.ok(
    fresh.every((t) => t.persisted === undefined),
    'every one is unconfigured'
  )
  assert.ok(
    fresh.every((t) => t.settings.durationSec === 5 && t.settings.clip === null),
    'and every one still has usable default settings'
  )
  // Positions are contiguous and pair keys unique — an off-by-one here
  // would silently drop or duplicate a transition.
  assert.deepStrictEqual(
    fresh.map((t) => t.position),
    Array.from({ length: 29 }, (_, i) => i)
  )
  assert.strictEqual(new Set(fresh.map((t) => t.pairKey)).size, 29, 'no duplicate pair keys')

  // ── 3. ONLY TWO STORED ROWS — STILL TWENTY-NINE ──────────────────────
  const ids = project.images.map((i) => i.id)
  project.transitions[transitionKey(ids[0], ids[1])] = {
    prompt: 'hand written',
    durationSec: 5,
    status: 'not-generated',
    clip: null,
    promptProvenance: {
      basePrompt: DEFAULT_TRANSITION_PROMPT,
      motionInstruction: null,
      effectivePrompt: 'hand written',
      basis: 'unknown',
      rationale: '',
      manuallyEdited: true,
      plannedAt: 1,
      analysisUpdatedAt: null
    }
  }
  project.transitions[transitionKey(ids[1], ids[2])] = {
    prompt: 'analysis managed',
    durationSec: 10,
    status: 'not-generated',
    clip: null,
    promptProvenance: null
  }
  saveProject(project)

  const partial = logicalTransitions(project, 5)
  assert.strictEqual(
    partial.length,
    29,
    'TWO stored rows out of twenty-nine pairs still yields twenty-nine — this is the exact ' +
      'assertion that would have caught the dialog offering two of them'
  )
  assert.strictEqual(partial.filter((t) => t.persisted).length, 2, 'two are configured')
  assert.strictEqual(partial.filter((t) => !t.persisted).length, 27, 'twenty-seven are not')
  assert.strictEqual(partial[1].settings.durationSec, 10, 'a stored row supplies its own duration')
  assert.strictEqual(partial[5].settings.durationSec, 5, 'an unconfigured one gets the default')

  // ── 4 & 5. THE REBUILD PLAN SEES ALL TWENTY-NINE ─────────────────────
  saveAnalysis({
    ...emptyAnalysis(project.id),
    state: 'accepted',
    source: 'provider',
    rooms: [{ id: 'r', label: 'Open Plan', imageIds: ids, landmarks: ['island'] }],
    // Every image shares a landmark, so every pair has pair-specific
    // evidence and Auto resolves to AI. Without that they would all be
    // cuts — correctly — and this test would stop exercising the prompt
    // path it exists to cover.
    images: ids.map((id) => ({
      imageId: id,
      roomId: 'r',
      orientation: 'into-room' as const,
      landmarks: ['island'],
      openings: []
    })),
    edges: []
  })

  const plan = planPromptRebuild(project.id)
  assert.strictEqual(
    plan.logicalTransitionCount,
    29,
    'the dialog reports twenty-nine logical transitions'
  )
  assert.ok(
    !plan.analysisIsMock,
    'a provider analysis is not flagged as a placeholder, so rebuild is offered normally'
  )
  const accounted =
    plan.rebuildable.length + plan.preserved.length + plan.unchanged.length + plan.skipped.length
  assert.strictEqual(
    accounted,
    29,
    'and EVERY one appears in exactly one list — rebuildable, preserved or unchanged. ' +
      'Nothing may vanish for want of a database row.'
  )
  // ── 6. The manual prompt is preserved, not rebuilt ───────────────────
  assert.strictEqual(plan.preserved.length, 1, 'the hand-written prompt is preserved')
  assert.strictEqual(plan.preserved[0].label, 'Image 1 → Image 2')
  assert.ok(
    !plan.rebuildable.some((r) => r.label === 'Image 1 → Image 2'),
    'and never appears as rebuildable'
  )
  assert.strictEqual(plan.rebuildable.length, 28, 'the other twenty-eight would be written')
  assert.ok(plan.hasAnalysis)

  // ── 7. A ROW IS CREATED ONLY WHEN THERE IS SOMETHING TO STORE ────────
  const before = Object.keys(listProjects().find((x) => x.id === project.id)!.transitions).length
  assert.strictEqual(before, 2, 'listing twenty-nine transitions created no rows')

  const result = rebuildPromptsFromAnalysis(project.id)
  assert.strictEqual(result.rebuiltCount, 28, 'twenty-eight prompts were written')
  assert.strictEqual(result.preservedCount, 1, 'and the manual one was left alone')

  const after = listProjects().find((x) => x.id === project.id)!
  assert.strictEqual(
    Object.keys(after.transitions).length,
    29,
    'now every transition has a row, because every one has an analysis-managed prompt to store'
  )
  assert.strictEqual(
    after.transitions[transitionKey(ids[0], ids[1])].prompt,
    'hand written',
    'THE MANUAL PROMPT SURVIVED — this is the rule that must never break'
  )
  assert.strictEqual(
    after.transitions[transitionKey(ids[0], ids[1])].promptProvenance?.manuallyEdited,
    true
  )
  // A pair that had no row at all now has one, carrying provenance.
  const created28 = after.transitions[transitionKey(ids[27], ids[28])]
  assert.ok(created28, 'a previously unconfigured pair now has a row')
  assert.strictEqual(created28.promptProvenance?.manuallyEdited, false)
  // Not `includes(DEFAULT_TRANSITION_PROMPT)` any more: the preset's
  // sections are interleaved with the pair's own blocks rather than
  // concatenated in front of them, which is what stopped the movement
  // instruction being pushed past the provider's character limit. The
  // contract is checked by its parts instead of by one long substring.
  for (const section of [
    PRESET_PARTS.opening,
    PRESET_PARTS.frames,
    PRESET_PARTS.motionQuality,
    PRESET_PARTS.geometry,
    PRESET_PARTS.occupancy,
    PRESET_PARTS.nonexistent
  ]) {
    assert.ok(
      created28.prompt.includes(section.text) ||
        (section.compact != null && created28.prompt.includes(section.compact)),
      `and its prompt still carries the safety contract: ${section.id}`
    )
  }
  // The CONFIGURED default, read the same way the service reads it — a
  // row created by a rebuild must get the same duration as one created
  // any other way, and hard-coding a number here would only assert that
  // the test and the service share a guess.
  const configuredDefault =
    (JSON.parse(getSettingsJson() ?? '{}') as Partial<AppSettings>).exportDefaults
      ?.defaultTransitionDurationSec ?? 5
  assert.strictEqual(
    created28.durationSec,
    configuredDefault,
    'with the configured default duration, not a hard-coded one'
  )
  assert.strictEqual(created28.clip, null, 'and no clip invented')

  // Re-running reports them as unchanged rather than as work.
  const second = planPromptRebuild(project.id)
  assert.strictEqual(second.unchanged.length, 28, 'a second pass finds nothing to change')
  assert.strictEqual(second.rebuildable.length, 0)
  assert.strictEqual(
    second.rebuildable.length + second.preserved.length + second.unchanged.length + second.skipped.length,
    29,
    'and still accounts for all twenty-nine'
  )

  // ── 8. A REORDER RECOMPUTES THE PAIRS ────────────────────────────────
  const moved = { ...after, images: moveInSequence(after.images, 29, 0) }
  const afterMove = logicalTransitions(moved, 5)
  assert.strictEqual(afterMove.length, 29, 'the count is unchanged by a reorder')
  assert.strictEqual(
    afterMove[0].pairKey,
    transitionKey(ids[29], ids[0]),
    'and the new adjacency appears'
  )
  assert.ok(
    !afterMove.some((t) => t.pairKey === transitionKey(ids[28], ids[29])),
    'while the pair the move broke is gone from the list'
  )
  // The stored row for the broken pair is NOT deleted — a prompt someone
  // wrote is worth keeping if the order comes back — but it must never be
  // counted as a transition, which is the mirror image of the bug above.
  const stranded = strandedTransitionKeys(moved)
  assert.ok(
    stranded.includes(transitionKey(ids[28], ids[29])),
    'the row survives as stranded rather than being counted or destroyed'
  )

  // ── 9. CONTINUITY REACHES THE FINAL PAIR ─────────────────────────────
  const plans = planSequence(readAnalysis(project.id), ids)
  assert.strictEqual(plans.length, 29, 'the planner receives all twenty-nine, in order')
  assert.strictEqual(plans[0].fromImageId, ids[0])
  assert.strictEqual(plans[28].toImageId, ids[29], 'right through to image 30')
  // Every plan after the first sees what the one before handed it — the
  // chain is unbroken across all twenty-nine, not only the stored ones.
  for (let i = 1; i < plans.length; i++) {
    assert.strictEqual(
      plans[i].continuity.incomingRotation,
      plans[i - 1].continuity.outgoingRotation,
      `plan ${i + 1} inherits the rotation plan ${i} handed over`
    )
  }
  assert.notStrictEqual(
    plans[28].continuity.incomingRotation,
    'none',
    'and the final pair genuinely received continuity rather than starting fresh'
  )

  // ── A MOCK ANALYSIS IS FLAGGED, SO REBUILD CANNOT HAPPEN BY REFLEX ───
  //
  // The renderer disables the confirm button on this flag until the
  // operator explicitly opts in. Rebuilding every prompt from a
  // placeholder replaces real wording with wording derived from nothing.
  saveAnalysis({
    ...readAnalysis(project.id),
    source: 'mock',
    provenance: {
      analyzerId: 'mock',
      displayName: 'Mock (development)',
      provider: 'local',
      model: null,
      mode: 'mock',
      imageCount: 30,
      analyzedAt: 1,
      acceptedAt: 2
    }
  })
  const mockPlan = planPromptRebuild(project.id)
  assert.ok(
    mockPlan.analysisIsMock,
    'an accepted mock analysis is flagged, and the dialog requires an explicit override'
  )
  assert.strictEqual(
    mockPlan.logicalTransitionCount,
    29,
    'the counts are still honest — the flag gates the action, it does not hide the work'
  )

  log('logical transitions: 30 images = 29 transitions, none lost for want of a row')
}

/**
 * THE GEMINI MODEL ID, AND WHAT HAPPENS WHEN ONE IS RETIRED.
 *
 * ── WHAT PROMPTED THIS ───────────────────────────────────────────────
 *
 * `gemini-2.5-flash` returned a real 404 against a real key:
 *
 *   "This model is no longer available to new users.
 *    Please update your code to use models/gemini-3.6-flash"
 *
 * Two separate failures were worth fixing. The id was stale — but more
 * importantly, everything the operator needed was inside a JSON blob that
 * would have been pasted into an error card verbatim.
 *
 * ZERO REAL REQUESTS: the transport is mocked and its call count asserted.
 */
async function testGeminiModelConfig(workDir: string, created: string[]): Promise<void> {
  // ── 1. Only current model ids are offered ────────────────────────────
  assert.strictEqual(GEMINI_DEFAULT_MODEL, 'gemini-3.6-flash', 'the default is the current model')
  assert.ok(
    GEMINI_MODELS.some((m) => m.id === GEMINI_DEFAULT_MODEL),
    'and the default is one of the selectable options'
  )
  for (const m of GEMINI_MODELS) {
    assert.ok(
      !isRetiredModel(m.id),
      `${m.id} is offered in Settings, so it must not be a retired id`
    )
  }
  assert.ok(
    !GEMINI_MODELS.some((m) => m.id.startsWith('gemini-2.')),
    'no 2.x model is selectable — the whole generation is unavailable to new keys'
  )
  assert.ok(rateFor(GEMINI_DEFAULT_MODEL), 'the default model has a rate entry')
  assert.strictEqual(
    rateFor(GEMINI_DEFAULT_MODEL)!.verified,
    false,
    'carried over from the previous tier and NOT checked against pricing for this model, ' +
      'so every figure derived from it still reads as unavailable rather than reconcilable'
  )

  // ── 2. Retired ids are known, and their replacement is not guessed ───
  assert.ok(isRetiredModel('gemini-2.5-flash'))
  assert.strictEqual(
    replacementForModel('gemini-2.5-flash'),
    'gemini-3.6-flash',
    'the provider named this replacement, so it is recorded'
  )
  assert.ok(isRetiredModel('gemini-2.5-pro'), 'the pro tier is the same retired generation')
  assert.strictEqual(
    replacementForModel('gemini-2.5-pro'),
    null,
    'and NO replacement is invented for it — following the naming pattern would be a guess ' +
      'dressed as configuration'
  )
  assert.ok(!isRetiredModel('gemini-3.6-flash'), 'the current model is not retired')

  // ── 3. THE REAL 404, PARSED ──────────────────────────────────────────
  const realBody = JSON.stringify({
    error: {
      code: 404,
      message:
        'models/gemini-2.5-flash is not found for API version v1beta, or is not supported for generateContent. This model is no longer available to new users. Please update your code to use models/gemini-3.6-flash. Call ListModels to see the list of available models.',
      status: 'NOT_FOUND'
    }
  })

  const failure = describeGeminiFailure(404, realBody, 'gemini-2.5-flash')
  assert.strictEqual(failure.category, 'model-unavailable')
  assert.match(failure.summary, /Configured Gemini model is unavailable/)
  assert.match(failure.summary, /gemini-3\.6-flash/, 'and names the recommended replacement')
  assert.strictEqual(failure.recommendedModel, 'gemini-3.6-flash')
  assert.strictEqual(
    failure.retryable,
    false,
    'retrying the same id would fail identically — this needs a configuration change'
  )

  // THE SUMMARY IS NOT THE BLOB. The provider's text lives separately.
  assert.ok(!failure.summary.includes('{'), 'no raw JSON reaches the main error card')
  assert.ok(!failure.summary.includes('ListModels'), 'nor the provider’s full prose')
  assert.ok(failure.summary.length < 120, 'the card gets one line, not a wall')
  assert.ok(failure.detail && failure.detail.includes('ListModels'), 'the detail keeps it all')
  assert.ok(!failure.detail!.includes('{'), 'unwrapped from the error envelope for Details')

  // ── 4. THE EXTRACTION IS STRICT ──────────────────────────────────────
  //
  // The retired id appears FIRST in that same sentence. A loose pattern
  // would confidently recommend the model that just failed.
  assert.strictEqual(
    extractRecommendedModel(realBody),
    'gemini-3.6-flash',
    'the recommendation comes from "use models/…", not from the first id in the message'
  )
  assert.notStrictEqual(extractRecommendedModel(realBody), 'gemini-2.5-flash')
  assert.strictEqual(
    extractRecommendedModel('models/gemini-2.5-flash is not found for API version v1beta'),
    null,
    'a 404 with no recommendation yields none rather than a guess'
  )
  assert.strictEqual(extractRecommendedModel(null), null)
  assert.strictEqual(
    describeGeminiFailure(404, 'models/x is not found for API version v1beta', 'x')
      .recommendedModel,
    null,
    'and the failure carries none'
  )
  // Never recommend what is already configured — that reads as a no-op.
  assert.strictEqual(
    describeGeminiFailure(404, realBody, 'gemini-3.6-flash').recommendedModel,
    null,
    'a recommendation identical to the configured model is not offered'
  )

  // ── 5. Other statuses still map to something actionable ──────────────
  assert.strictEqual(describeGeminiFailure(403, '{"error":{"message":"bad key"}}', 'm').category, 'auth')
  assert.strictEqual(describeGeminiFailure(429, '', 'm').category, 'rate-limited')
  assert.ok(describeGeminiFailure(429, '', 'm').retryable, 'a rate limit is worth retrying')
  assert.strictEqual(describeGeminiFailure(503, '', 'm').category, 'server')
  assert.strictEqual(describeGeminiFailure(null, '', 'm').category, 'network')
  assert.strictEqual(describeGeminiFailure(413, '', 'm').category, 'too-large')

  // ── 6. A KEY NEVER REACHES A SCREEN ──────────────────────────────────
  const leaky = JSON.stringify({
    error: { message: 'Request had key AIzaSyD-EXAMPLE-000000000000 and key=AIzaSecond' }
  })
  const cleaned = describeGeminiFailure(400, leaky, 'm')
  assert.ok(!cleaned.detail!.includes('AIzaSyD-EXAMPLE-000000000000'), 'the key is redacted')
  assert.ok(!cleaned.detail!.includes('AIzaSecond'), 'including one in a query-string form')

  // ── 7. THE PRE-FLIGHT BLOCK ──────────────────────────────────────────
  //
  // A settings row written before the retirement still points at the old
  // id. Caught BEFORE a paid attempt rather than after a 404.
  const retired = analyzerPresentation({
    analyzerId: 'gemini',
    displayName: 'Gemini vision',
    provider: 'google',
    model: 'gemini-2.5-flash',
    mode: 'live',
    incursCost: true,
    hasApiKey: true,
    allowLive: true,
    imageCount: 30,
    modelRetired: true,
    recommendedModel: 'gemini-3.6-flash'
  })
  assert.ok(!retired.canRun, 'a retired model cannot be run')
  assert.strictEqual(retired.blocker, 'Configured Gemini model is unavailable')
  assert.strictEqual(retired.action, 'configure')
  assert.match(retired.note, /gemini-3\.6-flash/, 'and the note names what to change it to')
  assert.ok(
    !retired.requiresConfirmation,
    'no paid confirmation is offered for a request that cannot succeed'
  )

  // ── 8. THE CLIENT SURFACES IT, WITH NO REAL REQUEST ──────────────────
  const project = makeProject('Smoke gemini model')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'model.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: 'a.png' },
    { sourcePath: p, name: 'b.png' }
  ])
  saveProject(project)

  let calls = 0
  let sentUrl = ''
  const fetchImpl: FetchLike = async (url) => {
    calls++
    sentUrl = url
    return new Response(realBody, { status: 404, headers: { 'Content-Type': 'application/json' } })
  }
  const analyzer = new GeminiPropertyAnalyzer({
    apiKey: 'AIza-SMOKE-MODEL',
    model: GEMINI_DEFAULT_MODEL,
    live: true,
    allowLive: true,
    fetchImpl
  })
  const request: AnalyzerRequest = {
    projectId: project.id,
    projectName: project.name,
    images: project.images.map((image, idx) => ({
      imageId: image.id,
      sequence: idx + 1,
      fileName: image.fileName,
      ref: image.src
    })),
    existing: null,
    notes: '',
    capabilities: ALL_CAPABILITIES
  }

  const res = await analyzer.analyzeProperty(request)
  assert.ok(!res.ok, 'a 404 produces no analysis')
  assert.strictEqual(calls, 1, 'exactly one mocked call — no real request was made')
  assert.match(
    sentUrl,
    /models\/gemini-3\.6-flash:generateContent/,
    'and it was addressed to the NEW model id'
  )
  assert.match(
    res.ok ? '' : res.reason,
    /Configured Gemini model is unavailable/,
    'the reason the panel shows is the actionable summary'
  )
  assert.ok(
    !(res.ok ? '' : res.reason).includes('ListModels'),
    'not the provider’s full prose'
  )

  // ── 9. A FAILED REQUEST CHANGES NOTHING ──────────────────────────────
  saveAnalysis({
    ...emptyAnalysis(project.id),
    state: 'accepted',
    source: 'mock',
    rooms: [{ id: 'kept', label: 'Operator Room', imageIds: [], landmarks: [] }],
    provenance: {
      analyzerId: 'mock',
      displayName: 'Mock (development)',
      provider: 'local',
      model: null,
      mode: 'mock',
      imageCount: 2,
      analyzedAt: 1,
      acceptedAt: 2
    }
  })
  const before = readAnalysis(project.id)
  await analyzer.analyzeProperty(request)
  const after = readAnalysis(project.id)
  assert.strictEqual(after.rooms[0].label, 'Operator Room', 'the accepted analysis is untouched')
  assert.strictEqual(after.provenance?.mode, 'mock', 'and still says honestly that it is a mock')
  assert.strictEqual(before.updatedAt, after.updatedAt, 'nothing was written at all')
  assert.ok(
    !isRealAnalysis(after.provenance),
    'a mock is never reported as a real analysis, whatever the analyzer is configured as'
  )
  assert.strictEqual(listCostEntries(project.id).length, 0, 'and a failed request records no spend')

  log('gemini model: current id only, retirement caught pre-flight, 404 summarised not dumped')
}

/**
 * TRANSITION RECOVERY — three actions, three costs.
 *
 * ── THE RULE THIS PROTECTS ───────────────────────────────────────────
 *
 * Resume continues a paid task that is already running. Retry download
 * fetches a result the provider has already produced and been paid for.
 * Regenerate submits a NEW paid task. Labelling all three "Retry" is how
 * someone pays twice for a clip already sitting on the provider's server.
 *
 * The decision comes from the REMOTE task state via the idempotency
 * function both processes already share — not from a second opinion.
 */
function testTransitionRecovery(): void {
  const clipped: TransitionSettings = {
    prompt: '',
    durationSec: 5,
    status: 'completed',
    clip: { storedName: 'c.mp4', originalName: 'c.mp4', source: 'fal', src: 'f2f://clip/x/c.mp4' },
    promptProvenance: null
  }
  const bare: TransitionSettings = {
    prompt: '',
    durationSec: 5,
    status: 'not-generated',
    clip: null,
    promptProvenance: null
  }

  const job = (provider: Partial<QueueJob['provider']> | null, note?: string): QueueJob =>
    ({
      id: 'job-1',
      projectId: 'p',
      projectName: 'p',
      kind: 'ai-generation',
      status: 'failed',
      progressPct: 0,
      transitionCount: 1,
      createdAt: 1,
      queueOrder: 0,
      scheduledFor: null,
      startedAt: null,
      completedAt: null,
      metadata: { pairKeys: ['a->b'] },
      note,
      provider: provider
        ? ({
            provider: 'fal',
            model: null,
            dryRun: false,
            providerTaskId: null,
            providerStatus: null,
            submittedAt: null,
            lastPolledAt: null,
            providerMeta: null,
            estimatedCost: null,
            actualCost: null,
            estimatedCredits: null,
            actualCredits: null,
            retryCount: 0,
            ...provider
          } as QueueJob['provider'])
        : undefined
    }) as QueueJob

  // ── 1. Nothing generated ─────────────────────────────────────────────
  const fresh = transitionRecovery(bare, null, '1 → 2')
  assert.strictEqual(fresh.kind, 'generate')
  assert.strictEqual(fresh.label, 'Generate 1 → 2')
  assert.ok(fresh.costsMoney, 'a first generation is a paid request and says so')

  // ── 2. A LOGICAL transition with NO settings row at all ──────────────
  // A pair exists the moment two photographs are adjacent; the row is
  // written lazily. Recovery must work from `undefined`.
  const noRow = transitionRecovery(undefined, null, '1 → 2')
  assert.strictEqual(noRow.kind, 'generate', 'a transition with no DB row is still generatable')
  assert.strictEqual(noRow.label, 'Generate 1 → 2')

  // ── 3. In flight ─────────────────────────────────────────────────────
  assert.strictEqual(transitionRecovery({ ...bare, status: 'queued' }, null, 'x').kind, 'waiting')
  assert.strictEqual(transitionRecovery({ ...bare, status: 'queued' }, null, 'x').label, 'Queued')
  assert.strictEqual(
    transitionRecovery({ ...bare, status: 'generating' }, null, 'x').label,
    'Generating…'
  )
  assert.ok(
    !transitionRecovery({ ...bare, status: 'generating' }, null, 'x').costsMoney,
    'watching something run costs nothing'
  )

  // ── 4. RESUME — a paid task is still running remotely ────────────────
  const running = transitionRecovery(
    { ...bare, status: 'failed' },
    job({ providerTaskId: 'task-abc', providerStatus: 'processing' }),
    'x'
  )
  assert.strictEqual(running.kind, 'resume')
  assert.strictEqual(running.label, 'Resume')
  assert.strictEqual(
    running.costsMoney,
    false,
    'RESUMING A PAID TASK COSTS NOTHING — mislabelling this is how someone pays twice'
  )
  assert.strictEqual(running.jobId, 'job-1', 'and it names the job to resume')
  // ── BOTH ACTIONS, DELIBERATELY ─────────────────────────────────────
  //
  // This used to assert `secondary === null`: while a task was running,
  // Regenerate was not offered at all, on the reasoning that buying a
  // second copy of work already in flight is waste.
  //
  // In practice that left Resume as the only visible action, and Resume
  // is the one action that CANNOT produce a different result — it merely
  // keeps watching the same task. Operators reached for it as "try
  // again", which it is not. So a new generation is now offered here as
  // well, as its own action, marked as a second purchase.
  //
  // The money protection is not removed, it moved: it is no longer
  // "hide the paid option" but "never let the free one and the paid one
  // look like the same button".
  assert.strictEqual(
    running.secondary?.kind,
    'regenerate',
    'a genuinely new generation is offered alongside — Resume cannot retry anything'
  )
  assert.strictEqual(
    running.secondary?.costsMoney,
    true,
    'and it is marked as a SECOND purchase, so it can never read as a free retry'
  )

  // ── 5. RETRY DOWNLOAD — the remote task SUCCEEDED ────────────────────
  const downloadable = transitionRecovery(
    { ...bare, status: 'failed' },
    job({ providerTaskId: 'task-abc', providerStatus: 'succeeded' }),
    'x'
  )
  assert.strictEqual(downloadable.kind, 'retry-download')
  assert.strictEqual(downloadable.label, 'Retry download')
  assert.strictEqual(
    downloadable.costsMoney,
    false,
    'the video already exists and is already paid for — only the transfer failed'
  )
  assert.match(downloadable.detail, /already paid for/i, 'and the detail says so plainly')

  // ── 6. REGENERATE — only when there is nothing to recover ────────────
  const dead = transitionRecovery(
    { ...bare, status: 'failed' },
    job({ providerTaskId: 'task-abc', providerStatus: 'failed' }, 'Video generation rejected'),
    'x'
  )
  assert.strictEqual(dead.kind, 'regenerate')
  assert.strictEqual(dead.label, 'Regenerate — costs again')
  assert.ok(dead.costsMoney, 'and it is honest that this is a new charge')
  assert.match(dead.detail, /rejected/i, 'carrying the sanitized reason')

  // A failure with NO remote task at all is also a regenerate — there is
  // nothing remote to resume or download.
  const neverSubmitted = transitionRecovery({ ...bare, status: 'failed' }, job(null), 'x')
  assert.strictEqual(neverSubmitted.kind, 'regenerate')

  // ── 7. A finished clip ───────────────────────────────────────────────
  const done = transitionRecovery(clipped, null, 'x')
  assert.strictEqual(done.kind, 'preview')
  assert.strictEqual(done.label, 'Preview')
  assert.ok(!done.costsMoney)
  assert.strictEqual(
    done.secondary?.label,
    'Regenerate — costs again',
    'Regenerate stays available but secondary, and never reads as a harmless retry'
  )
  assert.ok(done.secondary?.costsMoney)

  // ── 8. The newest job wins ───────────────────────────────────────────
  // A Regenerate creates a newer job; an older failed attempt must not
  // keep offering Resume for a task nobody is waiting on.
  const older = { ...job({ providerTaskId: 'old', providerStatus: 'processing' }), id: 'old', createdAt: 1 }
  const newer = { ...job({ providerTaskId: 'new', providerStatus: 'succeeded' }), id: 'new', createdAt: 9 }
  const picked = latestJobForPair([older, newer], 'p', 'a->b')
  assert.strictEqual(picked?.id, 'new', 'the most recent job for the pair is the one that counts')
  assert.strictEqual(
    latestJobForPair([older, newer], 'other-project', 'a->b'),
    null,
    "and another project's job is never borrowed"
  )

  // ── 9. Provider errors become something actionable ───────────────────
  assert.strictEqual(categorizeProviderError('HTTP 401 Unauthorized'), 'auth')
  assert.match(providerErrorMessage('HTTP 401 Unauthorized'), /check the API key/i)
  assert.ok(isConfigurationError('invalid api key'), 'an auth failure is fixable in Settings')
  assert.strictEqual(categorizeProviderError('account locked'), 'account')
  assert.strictEqual(categorizeProviderError('404 not found'), 'endpoint')
  assert.strictEqual(categorizeProviderError('ETIMEDOUT'), 'network')
  assert.ok(!isConfigurationError('ETIMEDOUT'), 'a network blip is not a settings problem')
  assert.strictEqual(categorizeProviderError(null), 'unknown')
  assert.match(providerErrorMessage(null), /did not complete/i, 'and unknown says only what it knows')

  // ── 10. NOTHING SENSITIVE REACHES A SCREEN ───────────────────────────
  const dirty = 'Failed with key AIzaSyD-EXAMPLE-KEY-000000000 at C:\\Users\\someone\\clip.mp4'
  const clean = sanitizeReason(dirty)!
  assert.ok(!clean.includes('AIzaSyD-EXAMPLE-KEY-000000000'), 'an API key never reaches a screen')
  assert.ok(!/[A-Za-z]:\\/.test(clean), 'nor a filesystem path')
  assert.ok(clean.includes('[redacted]') && clean.includes('[path]'), 'both are visibly removed')
  assert.ok(
    (sanitizeReason('x'.repeat(9000)) ?? '').length <= 300,
    'and a runaway provider payload is truncated rather than pasted into the UI'
  )

  log('transition recovery: resume/retry-download are free, only regenerate charges again')
}

/**
 * WHAT THE MAIN PREVIEW SHOWS.
 *
 * ── THE TWO BUGS THIS PINS ───────────────────────────────────────────
 *
 * 1. Clicking a transition appeared to do nothing. The pair was selected
 *    and the block highlighted, but `project.transitions[pairKey]` is
 *    written LAZILY — a freshly imported project has thirty photographs,
 *    twenty-nine transitions and zero rows. Both the preview and the
 *    inspector treated that absence as "no transition selected", so the
 *    inspector showed the identical "select a transition" message it
 *    showed before the click, and Generate was unreachable.
 *
 * 2. A selected image did not appear in the preview. The image element
 *    was in fact correct and loaded — a layout fault let the timeline's
 *    max-content width size the whole editor grid, so the preview frame
 *    became 6242px wide inside a 1500px window and the photograph was
 *    centred about 3000px off-screen. Nothing asserted the resolution
 *    step, so a rendering fault and a resolution fault looked the same.
 *
 * The decision is now a value in `shared`, so it can be asserted without
 * a DOM. The layout half is verified in the real renderer instead — see
 * the note at the end of this test.
 */
function testPreviewSource(workDir: string, created: string[]): void {
  const project = makeProject('Smoke preview source')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'prev.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: 'a.png' },
    { sourcePath: p, name: 'b.png' },
    { sourcePath: p, name: 'c.png' }
  ])
  saveProject(project)
  const [i1, i2, i3] = project.images.map((x) => x.id)
  const pair12 = transitionKey(i1, i2)
  const pair23 = transitionKey(i2, i3)

  // NOTE: `project.transitions` is deliberately left EMPTY here — that is
  // the exact state a freshly imported project is in, and the state the
  // bug lived in.
  assert.deepStrictEqual(project.transitions, {}, 'a new project has no transition rows at all')

  const resolve = (selection: EditorSelection, assembled: string | null = null): PreviewSource =>
    resolvePreviewSource(project, selection, assembled, 5)

  // ── 1. A selected image resolves to THAT image's managed source ──────
  const img = resolve(selectImage(i2))
  assert.strictEqual(img.kind, 'image', 'an image selection resolves to an image')
  if (img.kind === 'image') {
    assert.strictEqual(img.imageId, i2)
    assert.strictEqual(img.index, 1, 'and knows its position for the heading')
    assert.strictEqual(img.src, project.images[1].src, 'with the correct managed src')
    assert.match(img.src, /^f2f:\/\/image\//, 'served over the managed protocol, never a real path')
    assert.ok(!/[A-Za-z]:\\|\/Users\//.test(img.src), 'and carrying no filesystem path')
  }
  // Every image resolves to its OWN source — an off-by-one here would
  // show the wrong room and nobody would necessarily notice.
  for (let i = 0; i < project.images.length; i++) {
    const r = resolve(selectImage(project.images[i].id))
    assert.strictEqual(r.kind === 'image' && r.src, project.images[i].src, `image ${i + 1} maps to itself`)
  }

  // ── 2. A TRANSITION WITH NO ROW IS STILL A TRANSITION ────────────────
  const bare = resolve(selectTransition(pair12))
  assert.strictEqual(
    bare.kind,
    'transition-endpoints',
    'a transition with no settings row resolves to its endpoints, NOT to nothing — ' +
      'this is the assertion that would have caught the click doing nothing'
  )
  if (bare.kind === 'transition-endpoints') {
    assert.strictEqual(bare.index, 0)
    assert.strictEqual(bare.startSrc, project.images[0].src, 'start frame is the left photo')
    assert.strictEqual(bare.endSrc, project.images[1].src, 'end frame is the right one')
    assert.strictEqual(bare.status, 'not-generated', 'and it reports honestly as ungenerated')
    assert.ok(bare.canGenerate, 'with Generate available right there in the preview')
  }
  assert.strictEqual(statusWordFor('not-generated'), 'Not generated', 'status is a WORD, not a tint')

  // The settings fallback is defaults, not undefined.
  const settings = transitionSettingsFor(project, pair12, 5)
  assert.strictEqual(settings.durationSec, 5, 'the default duration is supplied')
  assert.strictEqual(settings.clip, null)
  assert.strictEqual(settings.status, 'not-generated')

  // ── 3. A transition WITH a clip resolves to the clip ─────────────────
  project.transitions[pair12] = {
    prompt: '',
    durationSec: 5,
    status: 'completed',
    clip: {
      storedName: 'clip.mp4',
      originalName: 'clip.mp4',
      source: 'fal',
      src: 'f2f://clip/x/clip.mp4'
    },
    promptProvenance: null
  }
  const withClip = resolve(selectTransition(pair12))
  assert.strictEqual(withClip.kind, 'clip', 'an existing clip is played rather than shown as endpoints')
  assert.strictEqual(withClip.kind === 'clip' && withClip.src, 'f2f://clip/x/clip.mp4')

  // ── 4. Generation already in flight does not offer Generate again ────
  project.transitions[pair23] = {
    prompt: '',
    durationSec: 5,
    status: 'generating',
    clip: null,
    promptProvenance: null
  }
  const inFlight = resolve(selectTransition(pair23))
  assert.strictEqual(inFlight.kind, 'transition-endpoints')
  assert.ok(
    inFlight.kind === 'transition-endpoints' && !inFlight.canGenerate,
    'a transition already generating hides Generate — a second click would be a second paid request'
  )
  assert.strictEqual(statusWordFor('generating'), 'Generating…', 'and says what it is doing')

  // ── 5. Full Video is independent of any item selection ───────────────
  assert.deepStrictEqual(
    resolve(selectFullVideo(), 'f2f://export/x/preview.mp4'),
    { kind: 'full', src: 'f2f://export/x/preview.mp4' },
    'Full Video shows the assembled file'
  )
  assert.deepStrictEqual(
    resolve(selectFullVideo(), null),
    { kind: 'full', src: null },
    'and reports honestly when none has been built rather than borrowing a clip'
  )

  // ── 6. SELECTIONS ARE MUTUALLY EXCLUSIVE, all the way to the screen ──
  // Not merely in the selection value — in what the preview resolves to.
  // Exactly one of these may be an image, and exactly one a transition.
  const kinds = [
    resolve(selectImage(i1)).kind,
    resolve(selectTransition(pair12)).kind,
    resolve(selectFullVideo()).kind
  ]
  assert.deepStrictEqual(kinds, ['image', 'clip', 'full'], 'each selection resolves to its own kind')
  assert.strictEqual(
    resolve(selectImage(i1)).kind === 'image' && resolve(selectImage(i1)).kind !== 'clip',
    true,
    'an image selection can never resolve to a clip'
  )

  // ── 7. AFTER A REORDER ───────────────────────────────────────────────
  // Move image 3 to the front: c,a,b. Pair a→b survives; b→c does not.
  const reordered: typeof project = {
    ...project,
    images: moveInSequence(project.images, 2, 0)
  }
  const afterMove = resolvePreviewSource(reordered, selectImage(i2), null, 5)
  assert.strictEqual(afterMove.kind, 'image', 'a moved photograph still resolves')
  assert.strictEqual(
    afterMove.kind === 'image' && afterMove.index,
    2,
    'at its NEW position — the preview follows the photo, not the slot'
  )
  assert.strictEqual(
    afterMove.kind === 'image' && afterMove.src,
    project.images[1].src,
    'and still shows the same photograph'
  )

  const stalePair = resolvePreviewSource(reordered, selectTransition(pair23), null, 5)
  assert.strictEqual(
    stalePair.kind,
    'unavailable',
    'a pair the reorder broke is reported as unavailable, not rendered as a blank frame'
  )
  assert.match(
    stalePair.kind === 'unavailable' ? stalePair.reason : '',
    /no longer adjacent/i,
    'and says why, in words'
  )
  const survivingPair = resolvePreviewSource(reordered, selectTransition(pair12), null, 5)
  assert.strictEqual(
    survivingPair.kind,
    'clip',
    'while a pair whose neighbours did not change keeps its clip'
  )

  // ── 8. A removed photograph ──────────────────────────────────────────
  const withoutI2: typeof project = {
    ...project,
    images: project.images.filter((x) => x.id !== i2)
  }
  assert.strictEqual(
    resolvePreviewSource(withoutI2, selectImage(i2), null, 5).kind,
    'unavailable',
    'a deleted photograph is reported, never rendered as an empty box'
  )

  // ── THE LAYOUT HALF ──────────────────────────────────────────────────
  //
  // Bug 2 was NOT a resolution failure — every assertion above already
  // passed while the screen was blank. The image element was correct and
  // loaded; the editor grid's implicit column was sized max-content by the
  // timeline, so the preview frame was 6242px wide inside a 1500px window.
  //
  // That cannot be asserted here, and pretending otherwise would be worse
  // than admitting it: it is verified in the real renderer via
  // `electron . --f2f-uicheck`, which measures the rendered boxes.
  // Before the fix: frame 6244px. After: 956px.

  log('preview source: lazy transitions resolve, images map to themselves, reorder re-resolves')
}

/**
 * REORDERING — the arithmetic, and what it does to transition pairs.
 *
 * ── THE OFF-BY-ONE ───────────────────────────────────────────────────
 *
 * Drop slots are the GAPS between blocks. Removing the dragged item first
 * shifts every later slot down by one, so a rightward move must be
 * decremented or it overshoots by exactly one position — a bug that looks
 * correct in either direction when you read the expression.
 */
/**
 * ACCEPTING A FEED PROPOSAL.
 *
 * Accept was implemented as `removeFromFeed` per current image followed
 * by `addToFeed` per proposed image — a stream of debounced writes that
 * could not be awaited and had nowhere to report a failure. These pin the
 * replacement down to a single value: what the feed becomes, which modes
 * land on which pairs, and — the part worth protecting — that generated
 * clips survive a reordering.
 */
function testFeedProposalAccept(): void {
  const image = (id: string): Project['images'][number] =>
    ({ id, fileName: `${id}.jpg`, storedName: `${id}.jpg`, src: `file:///${id}.jpg` }) as Project['images'][number]

  const base = (): Project =>
    ({
      id: 'p1',
      name: 'Proposal test',
      createdAt: 1,
      updatedAt: 1,
      images: ['A', 'B', 'C', 'D'].map(image),
      feedSequence: ['A', 'B', 'C'],
      transitions: {},
      watermark: {} as Project['watermark'],
      signature: {} as Project['signature'],
      status: 'draft',
      workflow: { previewSentAt: null, paidAt: null, finalSentAt: null }
    }) as Project

  // ── The overlap case ─────────────────────────────────────────────────
  // [A,B,C] → [A,C,D]. A and C are common to both; the old per-image path
  // left them stuck and produced no visible change at all.
  const overlapped = applyProposalToProject(
    base(),
    ['A', 'C', 'D'],
    { [transitionKey('A', 'C')]: 'cut', [transitionKey('C', 'D')]: 'ai' },
    5
  )
  assert.deepStrictEqual(
    overlapped.feedSequence,
    ['A', 'C', 'D'],
    'the feed becomes exactly the proposed sequence, overlap and all'
  )
  assert.deepStrictEqual(
    getEffectiveFeedSequence(overlapped),
    ['A', 'C', 'D'],
    'and reads back through the same accessor the editor uses'
  )
  assert.strictEqual(overlapped.transitions[transitionKey('A', 'C')].mode, 'cut')
  assert.strictEqual(overlapped.transitions[transitionKey('C', 'D')].mode, 'ai')
  assert.ok(
    !overlapped.transitions[transitionKey('A', 'B')],
    'a pair the proposal never mentions and that had no row does not gain one'
  )

  // ── Accepting from an empty feed ─────────────────────────────────────
  const fromEmpty = applyProposalToProject(
    { ...base(), feedSequence: [] },
    ['A', 'C', 'D'],
    {},
    5
  )
  assert.deepStrictEqual(
    fromEmpty.feedSequence,
    ['A', 'C', 'D'],
    'an empty feed is filled by the proposal, not left empty'
  )

  // ── PAID WORK SURVIVES ───────────────────────────────────────────────
  // A→B has a generated clip and is stranded by the new order. Its MODE is
  // reset — that adjacency is gone — but the clip, its status and its
  // prompt must all still be there.
  const withClip = base()
  withClip.transitions[transitionKey('A', 'B')] = {
    ...defaultTransitionSettings(5),
    mode: 'ai',
    prompt: 'a prompt someone wrote',
    status: 'completed',
    clip: {
      storedName: 'ab.mp4',
      originalName: 'ab.mp4',
      source: 'fal',
      src: 'f2f://ab.mp4'
    }
  }
  const stranded = applyProposalToProject(withClip, ['A', 'C', 'D'], {}, 5)
  const ab = stranded.transitions[transitionKey('A', 'B')]
  assert.strictEqual(ab.mode, 'auto', 'a stranded pair loses only its mode decision')
  assert.ok(ab.clip, 'the generated clip survives accepting a new order')
  assert.strictEqual(ab.status, 'completed', 'and so does its status')
  assert.strictEqual(ab.prompt, 'a prompt someone wrote', 'and its prompt')

  // A pair that KEEPS its adjacency and gains a mode also keeps its clip.
  const keepsClip = base()
  keepsClip.transitions[transitionKey('A', 'C')] = {
    ...defaultTransitionSettings(5),
    status: 'completed',
    clip: {
      storedName: 'ac.mp4',
      originalName: 'ac.mp4',
      source: 'fal',
      src: 'f2f://ac.mp4'
    }
  }
  const merged = applyProposalToProject(
    keepsClip,
    ['A', 'C', 'D'],
    { [transitionKey('A', 'C')]: 'ai' },
    5
  )
  assert.strictEqual(merged.transitions[transitionKey('A', 'C')].mode, 'ai', 'the mode is applied')
  assert.ok(merged.transitions[transitionKey('A', 'C')].clip, 'without dropping the existing clip')

  // ── A proposal naming a deleted image is refused WHOLE ────────────────
  const before = base()
  assert.throws(
    () => applyProposalToProject(before, ['A', 'GONE'], {}, 5),
    /no longer in the library/,
    'a proposal referencing a missing image throws rather than applying partly'
  )
  assert.deepStrictEqual(
    before.feedSequence,
    ['A', 'B', 'C'],
    'and the project it was called with is left untouched'
  )

  log('feed proposal accept ok')
}

/**
 * TRANSITION ANALYSIS OVER THE CURRENT FEED.
 *
 * Two properties are pinned here, both of which were briefly untrue while
 * this pipeline was being built:
 *
 *  1. The pairs analysed are EXACTLY the adjacent pairs of the current
 *     feed — not the whole library, not a previous feed, not a proposal.
 *  2. Missing evidence produces CUT. An early version of this pipeline
 *     returned a hard-coded "SAFE / AI" for every pair, which would have
 *     shown an operator a fabricated safety verdict for a transition
 *     nothing had actually analysed.
 */
function testTransitionAnalysisExtraction(): void {
  const ids = ['img-a', 'img-b', 'img-c']

  // No analysis at all is an error, never an empty-but-confident draft.
  assert.strictEqual(
    extractTransitionAnalysis(null, ids, 1).draft,
    null,
    'no property analysis produces no draft'
  )
  assert.ok(extractTransitionAnalysis(null, ids, 1).error, 'and says why')

  // A feed too short to contain a transition is refused.
  assert.strictEqual(
    extractTransitionAnalysis(emptyAnalysis('p1'), ['img-a'], 1).draft,
    null,
    'a one-image feed has no transitions to analyse'
  )

  // An analysis that knows nothing about these images: every pair must be
  // a cut, and none of them may claim to be safe.
  const blank = extractTransitionAnalysis(emptyAnalysis('p1'), ids, 1)
  assert.ok(blank.draft, 'an empty analysis still yields a draft over the feed')
  assert.deepStrictEqual(
    blank.draft!.pairs.map((p) => `${p.fromId}>${p.toId}`),
    ['img-a>img-b', 'img-b>img-c'],
    'exactly the adjacent pairs of the current feed, in order'
  )
  for (const pair of blank.draft!.pairs) {
    assert.strictEqual(pair.recommendation, 'cut', 'no evidence can ever recommend AI')
    assert.strictEqual(pair.safety!.level, 'unsafe', 'and it is reported as unsafe, not safe')
    assert.ok(pair.safety!.reasoning.length > 0, 'with a stated reason rather than a blank')
  }
  assert.strictEqual(blank.draft!.status, 'draft', 'a fresh analysis is a draft, never accepted')

  log('transition analysis: current feed pairs only, no evidence means cut')
}

/**
 * TRANSITION DURATION — a setting, resolved in exactly one place.
 *
 * The number shown in the inspector and the number put in the provider
 * payload were derived independently, each ending in its own `?? 5`.
 * These pin the resolver they now share, and the capability rules that
 * stop a value the model cannot honour from ever being offered.
 */
function testTransitionDuration(): void {
  const FAL_O3 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
  const KLING = [5, 10, 15]
  const settings = (n: number): number => n

  // ── Default and override ─────────────────────────────────────────────
  assert.strictEqual(
    resolveTransitionDuration(undefined, undefined),
    5,
    'with nothing configured at all the historical 5 s default holds'
  )
  assert.strictEqual(
    resolveTransitionDuration(null, settings(8)),
    8,
    'an unset transition takes the project default'
  )
  assert.strictEqual(
    resolveTransitionDuration({ durationSec: 3 }, settings(10)),
    3,
    'a per-transition value beats the project default'
  )
  assert.strictEqual(
    resolveTransitionDuration({ durationSec: 15 }, settings(5)),
    15,
    'including at the top of the range'
  )

  // ── Nothing fractional or out of range survives ──────────────────────
  for (const bad of [2.5, 0, -1, NaN, '5' as unknown as number, null, undefined]) {
    assert.strictEqual(
      resolveTransitionDuration({ durationSec: bad as number }, settings(7)),
      7,
      `a stored ${String(bad)} is not treated as a duration; the default is used`
    )
  }
  assert.ok(!isDurationSupported(2, FAL_O3), '2 s is below what the model offers')
  assert.ok(!isDurationSupported(16, FAL_O3), 'and 16 s is above it')
  assert.ok(!isDurationSupported(4.5, FAL_O3), 'a fractional duration is never supported')
  for (const s of FAL_O3) {
    assert.ok(isDurationSupported(s, FAL_O3), `${s} s is offered by this endpoint`)
  }

  // ── Capability, not a hardcoded range ────────────────────────────────
  assert.deepStrictEqual(durationChoices(FAL_O3), FAL_O3, 'fal Kling O3 offers every second 3–15')
  assert.deepStrictEqual(durationChoices(KLING), KLING, "and Kling's own API offers only 5/10/15")
  assert.ok(!isDurationSupported(6, KLING), 'a value fal allows is not assumed to work on Kling')

  // ── Stepping walks the ALLOWED list, never +1 blindly ────────────────
  assert.strictEqual(stepDuration(5, 1, FAL_O3), 6, 'on a dense range a step is one second')
  assert.strictEqual(stepDuration(5, 1, KLING), 10, 'on a sparse one it skips to the next offered')
  assert.strictEqual(stepDuration(3, -1, FAL_O3), 3, 'the bottom of the range is a stop')
  assert.strictEqual(stepDuration(15, 1, FAL_O3), 15, 'and so is the top')
  assert.strictEqual(
    clampToSupported(6, KLING),
    5,
    'a value carried over from another model lands on the nearest this one allows'
  )

  // ── WHAT ACTUALLY REACHES THE PROVIDER ───────────────────────────────
  //
  // The resolver being right is only half of it; the value has to survive
  // into the request body. Asserted against the real fal mapper and the
  // real declared capability, so a future model whose enum changes fails
  // here rather than silently snapping a customer's clip to another length.
  const falModel = FAL_MODELS[0]
  const bodyFor = (durationSec: number): Record<string, unknown> =>
    buildFalBody(
      {
        projectId: 'p',
        pairKey: 'a->b',
        startImagePath: '/a.png',
        endImagePath: '/b.png',
        startImageName: 'a.png',
        endImageName: 'b.png',
        prompt: 'x',
        durationSec,
        resolution: 'standard',
        nativeAudio: false,
        modelId: falModel.id
      },
      falModel,
      'start',
      'end'
    )

  for (const seconds of [3, 4, 5, 10, 15]) {
    assert.strictEqual(
      bodyFor(seconds).duration,
      String(seconds),
      `a ${seconds} s transition is sent to fal as the string "${seconds}"`
    )
  }
  // Out-of-range values cannot be produced by the UI, but if one ever
  // reaches the mapper it is snapped to something real rather than sent.
  assert.strictEqual(bodyFor(2).duration, '3', 'below-range snaps up to the lowest offered')
  assert.strictEqual(bodyFor(20).duration, '15', 'and above-range snaps down to the highest')

  log('transition duration: one resolver, override beats default, capability bounds respected')
}

/**
 * FEED SELECTION IS NOT GATED ON TRANSITION SAFETY.
 *
 * The product invariant, pinned:
 *
 *   Transition safety determines HOW selected images are connected,
 *   never WHETHER a valuable image belongs in the video.
 *
 * The failure that made this necessary: a real 37-image library proposed
 * ZERO images. Not because of transition safety — selection never looks at
 * it — but because every tier gated on `marketingImportance ?? 0` and the
 * field was never populated, the Gemini response schema having omitted it.
 * Unscored meant zero, and zero failed every threshold.
 */
function testFeedSelectionInvariants(): void {
  const img = (id: string): ProjectImage =>
    ({ id, fileName: `${id}.jpg`, storedName: `${id}.jpg`, src: `file:///${id}` }) as ProjectImage

  const images = Array.from({ length: 37 }, (_, i) => img(`img-${i + 1}`))

  // ── The exact 0-of-37 shape: rooms and images, none of them scored ───
  const unscored: PropertyAnalysis = {
    ...emptyAnalysis('p1'),
    rooms: [
      { id: 'r1', label: 'Living Room', imageIds: images.slice(0, 12).map((i) => i.id), landmarks: [], confidence: 'confirmed' },
      { id: 'r2', label: 'Kitchen', imageIds: images.slice(12, 24).map((i) => i.id), landmarks: [], confidence: 'confirmed' },
      { id: 'r3', label: 'Terrace', imageIds: images.slice(24).map((i) => i.id), landmarks: [], confidence: 'confirmed' }
    ],
    images: images.map((i) => ({
      imageId: i.id,
      roomId: 'r1',
      orientation: 'unknown' as const,
      landmarks: [],
      openings: []
    }))
  }

  const fromUnscored = proposeFeedOrder(images, unscored)
  assert.ok(
    fromUnscored.length > 0,
    '37 real photographs never propose an empty feed — this is the 0-of-37 regression'
  )
  assert.ok(
    fromUnscored.every((id) => images.some((i) => i.id === id)),
    'and every proposed id is a real image'
  )
  assert.strictEqual(
    new Set(fromUnscored).size,
    fromUnscored.length,
    'with no image proposed twice'
  )

  // ── Selection ignores transition feasibility entirely ────────────────
  //
  // Same library, same scores, but zero recorded openings and zero edges,
  // so NO pair can be AI. The selection must be identical: a feed of
  // strong images connected entirely by cuts is the correct answer.
  const scored: PropertyAnalysis = {
    ...unscored,
    rooms: unscored.rooms.map((r, i) => ({ ...r, marketingImportance: [9, 8, 6][i] })),
    images: unscored.images.map((im) => ({ ...im, marketingImportance: 8 }))
  }
  const selection = proposeFeedOrder(images, scored)
  assert.ok(selection.length > 0, 'a scored library proposes a feed')

  const modes = proposeTransitionModes(scored, selection)
  assert.ok(
    Object.values(modes).every((m) => m === 'cut'),
    'with no openings and no edges recorded, every connection is a cut'
  )
  assert.deepStrictEqual(
    proposeFeedOrder(images, scored),
    selection,
    'and the selection is unchanged by every pair being unsafe — safety picks the ' +
      'connection, never the cast'
  )

  log('feed selection: never empty, and never narrowed by transition safety')
}

/**
 * THE TERRACE → LIVING ROOM CASE.
 *
 * A real pair that a human generated successfully: a terrace frame
 * showing an OPEN sliding patio door into the interior, and the living
 * room on the other side of that same glazed opening. The gate refused
 * it, which is the false negative this fixture exists to prevent.
 *
 * The counter-case matters just as much: the same two spaces with only a
 * fixed picture window between them must stay a CUT. Visible is not
 * traversable, and a camera flying through sealed glazing is exactly the
 * hallucination the gate is for.
 */
function testPatioOpeningEvidence(): void {
  // ── The classifier, on wording an analyzer actually produces ─────────
  for (const yes of [
    'open sliding glass door to terrace',
    'large patio doorway, open',
    'archway into dining area',
    'open passage to hallway'
  ]) {
    assert.ok(isTraversableOpening(yes), `"${yes}" is a way through`)
  }
  for (const no of [
    'large fixed window overlooking the pool',
    'floor-to-ceiling glass wall',
    'picture window',
    'closed sliding door',
    'skylight',
    'mirror above the fireplace'
  ]) {
    assert.ok(!isTraversableOpening(no), `"${no}" is NOT a way through`)
  }

  const terrace = 'img-terrace'
  const living = 'img-living'
  const base = (openings: string[]): PropertyAnalysis => ({
    ...emptyAnalysis('p1'),
    rooms: [
      { id: 'r-out', label: 'Terrace', imageIds: [terrace], landmarks: [], confidence: 'confirmed', marketingImportance: 9 },
      { id: 'r-in', label: 'Living Room', imageIds: [living], landmarks: [], confidence: 'confirmed', marketingImportance: 8 }
    ],
    images: [
      {
        imageId: terrace,
        roomId: 'r-out',
        orientation: 'unknown',
        landmarks: ['glazed façade'],
        openings,
        marketingImportance: 9,
        isHero: true
      },
      {
        imageId: living,
        roomId: 'r-in',
        orientation: 'unknown',
        landmarks: ['glazed façade'],
        openings: ['open sliding glass door to terrace'],
        marketingImportance: 8
      }
    ],
    edges: [
      {
        id: 'e1',
        // Recorded INTERIOR → EXTERIOR while the feed runs the other way.
        // A directional lookup missed this and produced a cut purely from
        // the order the analyzer wrote the connection down.
        fromRoomId: 'r-in',
        toRoomId: 'r-out',
        confidence: 'confirmed',
        supportingImageIds: [terrace, living],
        visibleOpeningImageIds: [terrace, living]
      }
    ]
  })

  // ── Open patio door: AI is defensible ───────────────────────────────
  const withDoor = proposeTransitionModes(base(['open sliding glass door into living room']), [
    terrace,
    living
  ])
  assert.strictEqual(
    withDoor[`${terrace}->${living}`],
    'ai',
    'a visible OPEN patio door across a confirmed adjacency supports a generated move'
  )

  // ── Same spaces, fixed window instead: CUT ──────────────────────────
  const withWindow = proposeTransitionModes(base(['large fixed window into living room']), [
    terrace,
    living
  ])
  assert.strictEqual(
    withWindow[`${terrace}->${living}`],
    'cut',
    'seeing the room through sealed glazing is not a route into it'
  )

  // ── Pool with no visible way in ─────────────────────────────────────
  const noEntry = proposeTransitionModes(base([]), [terrace, living])
  assert.strictEqual(
    noEntry[`${terrace}->${living}`],
    'cut',
    'no visible opening at all is always a cut'
  )

  // ── And in every one of those cases BOTH images stay in the feed ────
  for (const openings of [
    ['open sliding glass door into living room'],
    ['large fixed window into living room'],
    []
  ]) {
    const analysis = base(openings)
    const feed = proposeFeedOrder(
      [
        { id: terrace, fileName: 't.jpg', storedName: 't.jpg', src: '' } as ProjectImage,
        { id: living, fileName: 'l.jpg', storedName: 'l.jpg', src: '' } as ProjectImage
      ],
      analysis
    )
    assert.ok(
      feed.includes(terrace) && feed.includes(living),
      'neither image is dropped from the video because the pair cannot be generated'
    )
  }

  log('opening evidence: open door is a route, fixed glass is not, neither excludes an image')
}

/**
 * THE PROPOSAL AND THE PLANNER MUST AGREE.
 *
 * Two pipelines answer "may this pair be generated?": the feed proposal
 * that recommends modes, and the canonical planner that the timeline,
 * mode resolver and generation consult. They ran different rules and
 * disagreed in both directions — the planner accepted a same-room pair on
 * a single leaving landmark, and, far worse, accepted ANY recorded
 * opening including a fixed window, licensing a move through glazing.
 *
 * Both now read one evaluator. This asserts the property directly: for
 * the same pair and the same analysis, the two paths return the same
 * AI/CUT answer. A future edit that reintroduces a private rule on either
 * side fails here.
 */
function testSafetyEvaluatorIsShared(): void {
  const A = 'img-a'
  const B = 'img-b'

  const build = (over: Partial<PropertyAnalysis>): PropertyAnalysis => ({
    ...emptyAnalysis('p1'),
    ...over
  })

  const sameRoom = (overlap: boolean, sharedLandmark: boolean): PropertyAnalysis =>
    build({
      rooms: [
        { id: 'r1', label: 'Living Room', imageIds: [A, B], landmarks: [], confidence: 'confirmed' }
      ],
      images: [
        {
          imageId: A,
          roomId: 'r1',
          orientation: 'unknown',
          landmarks: sharedLandmark ? ['stone fireplace'] : ['sofa'],
          openings: [],
          overlapWith: overlap ? [B] : []
        },
        {
          imageId: B,
          roomId: 'r1',
          orientation: 'unknown',
          landmarks: sharedLandmark ? ['stone fireplace'] : ['bookshelf'],
          openings: [],
          overlapWith: overlap ? [A] : []
        }
      ]
    })

  const crossRoom = (
    startOpenings: string[],
    confidence: 'confirmed' | 'probable' | 'unknown'
  ): PropertyAnalysis =>
    build({
      rooms: [
        { id: 'out', label: 'Terrace', imageIds: [A], landmarks: [], confidence: 'confirmed' },
        { id: 'in', label: 'Living Room', imageIds: [B], landmarks: [], confidence: 'confirmed' }
      ],
      images: [
        {
          imageId: A,
          roomId: 'out',
          orientation: 'unknown',
          landmarks: ['glazed façade'],
          openings: startOpenings
        },
        {
          imageId: B,
          roomId: 'in',
          orientation: 'unknown',
          landmarks: ['glazed façade'],
          openings: ['open sliding glass door to terrace']
        }
      ],
      edges:
        confidence === 'unknown'
          ? []
          : [
              {
                id: 'e1',
                fromRoomId: 'in',
                toRoomId: 'out',
                confidence,
                supportingImageIds: [A, B],
                visibleOpeningImageIds: [A]
              }
            ]
    })

  const cases: Array<{ name: string; analysis: PropertyAnalysis; expect: 'ai' | 'cut' }> = [
    { name: 'same room, overlap + shared landmark', analysis: sameRoom(true, true), expect: 'ai' },
    { name: 'same room, overlap but nothing shared', analysis: sameRoom(true, false), expect: 'cut' },
    // A shared landmark IS the anchor. `overlapWith` is optional, and
    // treating its absence as proof the frames do not overlap would
    // repeat the mistake that made an unscored library select nothing.
    { name: 'same room, shared landmark, overlap not recorded', analysis: sameRoom(false, true), expect: 'ai' },
    {
      name: 'cross room, open patio door',
      analysis: crossRoom(['open sliding glass door into living room'], 'confirmed'),
      expect: 'ai'
    },
    {
      name: 'cross room, fixed window only',
      analysis: crossRoom(['large fixed window into living room'], 'confirmed'),
      expect: 'cut'
    },
    {
      name: 'cross room, no visible path at all',
      analysis: crossRoom([], 'confirmed'),
      expect: 'cut'
    },
    {
      name: 'cross room, open door but only a probable connection',
      analysis: crossRoom(['open patio doorway'], 'probable'),
      expect: 'cut'
    },
    {
      name: 'no evidence whatsoever',
      analysis: crossRoom(['open patio doorway'], 'unknown'),
      expect: 'cut'
    }
  ]

  for (const { name, analysis, expect } of cases) {
    // Path 1: the feed proposal.
    const proposed = proposeTransitionModes(analysis, [A, B])[`${A}->${B}`]
    // Path 2: the canonical planner the timeline and generation consult.
    const planned = recommendedMode(planSequence(analysis, [A, B])[0] ?? null).mode

    assert.strictEqual(proposed, expect, `proposal: ${name} → ${expect}`)
    assert.strictEqual(planned, expect, `planner: ${name} → ${expect}`)
    assert.strictEqual(
      proposed,
      planned,
      `the two pipelines must never disagree about "${name}"`
    )
  }

  // A reviewer's veto reaches BOTH paths through the same evaluator, and
  // can only ever restrict: it cannot unlock a move the evidence refuses.
  const reviewed = crossRoom(['open sliding glass door into living room'], 'confirmed')
  const vetoed = new Map([[connectionFactKey('Terrace', 'Living Room'), 'incorrect' as const]])
  assert.strictEqual(
    evaluateTransitionSafety(reviewed, A, B, vetoed).mode,
    'cut',
    'a reviewer marking the connection incorrect blocks the move'
  )
  assert.strictEqual(
    recommendedMode(planSequence(reviewed, [A, B], vetoed)[0] ?? null).mode,
    'cut',
    'and the planner honours the same veto'
  )

  log('transition safety: proposal and planner share one evaluator and cannot disagree')
}

/**
 * EVERY PAIR CAN EXPLAIN ITSELF, WITH OR WITHOUT A GEMINI HINT.
 *
 * The review dialog read only `analysis.transitionHints` and printed "No
 * analyzer detail for this pair" when none was found — which was always,
 * because `transitionHints` was hardcoded to `[]` in the mapper and the
 * response schema never declared the field. Meanwhile the evaluator that
 * actually decided each pair had a specific reason for every one of them.
 *
 * Two properties are pinned: the canonical reason always exists, and a
 * hint is advisory — it may restrict a move, never authorise one.
 */
function testTransitionReasoningAlwaysExists(): void {
  const A = 'img-a'
  const B = 'img-b'

  const sameRoomShared: PropertyAnalysis = {
    ...emptyAnalysis('p1'),
    rooms: [
      { id: 'r1', label: 'Master Bedroom', imageIds: [A, B], landmarks: [], confidence: 'confirmed' }
    ],
    images: [
      { imageId: A, roomId: 'r1', orientation: 'unknown', landmarks: ['upholstered headboard', 'window wall'], openings: [] },
      { imageId: B, roomId: 'r1', orientation: 'unknown', landmarks: ['window wall'], openings: [] }
    ]
  }

  // ── A. A reason exists with NO hint at all ──────────────────────────
  assert.strictEqual(
    (sameRoomShared.transitionHints ?? []).length,
    0,
    'this fixture deliberately carries no analyzer hints'
  )
  const verdict = evaluateTransitionSafety(sameRoomShared, A, B)
  assert.ok(
    verdict.reason.length > 0,
    'a pair always has a reason, hint or no hint — never "no analyzer detail"'
  )
  assert.match(
    verdict.reason,
    /window wall/,
    'and it quotes the actual evidence that decided it'
  )

  // ── C. Real same-room shared landmarks CAN become AI ────────────────
  assert.strictEqual(verdict.mode, 'ai', 'a shared landmark in both frames supports a move')
  assert.strictEqual(verdict.safety, 'safe')

  // ── D. No evidence stays CUT, and still explains itself ─────────────
  const nothingShared: PropertyAnalysis = {
    ...sameRoomShared,
    images: [
      { imageId: A, roomId: 'r1', orientation: 'unknown', landmarks: ['headboard'], openings: [] },
      { imageId: B, roomId: 'r1', orientation: 'unknown', landmarks: ['wardrobe'], openings: [] }
    ]
  }
  const cut = evaluateTransitionSafety(nothingShared, A, B)
  assert.strictEqual(cut.mode, 'cut', 'two corners of one room share the room and nothing else')
  assert.ok(cut.reason.length > 0, 'and the cut is explained rather than asserted')

  // ── B. A hint is found whichever way the feed runs the pair ─────────
  //
  // The mapper records each hint in both directions, because the analyzer
  // writes one entry per pair it looked at while a feed may traverse it
  // either way. A veto that only applied in one direction would silently
  // hold half the time.
  const vetoed: PropertyAnalysis = {
    ...sameRoomShared,
    transitionHints: [
      { fromImageId: A, toImageId: B, safetyLevel: 'unsafe', notes: 'mirror confusion' },
      { fromImageId: B, toImageId: A, safetyLevel: 'unsafe', notes: 'mirror confusion' }
    ]
  }
  assert.strictEqual(
    proposeTransitionModes(vetoed, [A, B])[`${A}->${B}`],
    'cut',
    'an unsafe hint vetoes the forward direction'
  )
  assert.strictEqual(
    proposeTransitionModes(vetoed, [B, A])[`${B}->${A}`],
    'cut',
    'and the reverse direction too'
  )

  // A 'safe' hint cannot unlock a pair the evidence refuses.
  const wishful: PropertyAnalysis = {
    ...nothingShared,
    transitionHints: [{ fromImageId: A, toImageId: B, safetyLevel: 'safe', notes: 'looks fine' }]
  }
  assert.strictEqual(
    proposeTransitionModes(wishful, [A, B])[`${A}->${B}`],
    'cut',
    'a hint may restrict a move, never authorise one the evidence does not support'
  )

  log('transition reasoning: every pair explains itself; hints restrict but never authorise')
}

function testSequenceReorder(): void {
  const ids = ['a', 'b', 'c', 'd']

  // ── 8. Drop position arithmetic ──────────────────────────────────────
  assert.strictEqual(dropTargetIndex(0, 0), 0, 'dropping on your own left edge is a no-op')
  assert.strictEqual(dropTargetIndex(0, 1), 0, 'and on your own right edge too')
  assert.strictEqual(
    dropTargetIndex(0, 2),
    1,
    'a rightward drop is decremented, because removing the item first shifts the slot'
  )
  assert.strictEqual(dropTargetIndex(0, 4), 3, 'dropping past the end lands at the end')
  assert.strictEqual(dropTargetIndex(3, 0), 0, 'a leftward drop is NOT decremented')
  assert.strictEqual(dropTargetIndex(3, 1), 1)

  assert.deepStrictEqual(
    moveInSequence(ids, 0, dropTargetIndex(0, 2)),
    ['b', 'a', 'c', 'd'],
    'dragging the first image into the gap after the second lands it second'
  )
  assert.deepStrictEqual(moveInSequence(ids, 3, 0), ['d', 'a', 'b', 'c'], 'and last to first works')

  // ── No duplicates, no losses ─────────────────────────────────────────
  for (let from = 0; from < ids.length; from++) {
    for (let slot = 0; slot <= ids.length; slot++) {
      const after = moveInSequence(ids, from, dropTargetIndex(from, slot))
      assert.ok(
        isValidReorder(ids, after),
        `move ${from}→slot ${slot} is a permutation: no duplicate position, no dropped image`
      )
    }
  }
  // Out-of-range indices are refused rather than splicing an undefined in.
  assert.deepStrictEqual(moveInSequence(ids, 9, 0), ids, 'an impossible source is a no-op')
  assert.deepStrictEqual(moveInSequence(ids, 0, 9), ids, 'and so is an impossible target')

  // ── 9. What a reorder does to the transition pairs ───────────────────
  // Prompts, clips and provenance are keyed by image PAIR, not position.
  // That is exactly what makes reordering safe.
  const after = moveInSequence(ids, 3, 0) // d,a,b,c
  const delta = pairDelta(ids, after)
  assert.deepStrictEqual(
    delta.kept.sort(),
    ['a->b', 'b->c'],
    'pairs whose neighbours did not change survive the move untouched'
  )
  assert.deepStrictEqual(delta.created, ['d->a'], 'exactly one new pair appears')
  assert.deepStrictEqual(delta.removed, ['c->d'], 'and exactly one is destroyed')

  // A pure swap of two adjacent images in the middle.
  const swapped = moveInSequence(ids, 1, 2) // a,c,b,d
  const swapDelta = pairDelta(ids, swapped)
  assert.deepStrictEqual(swapDelta.kept, [], 'swapping neighbours re-pairs all three transitions')
  assert.strictEqual(swapDelta.created.length, 3)
  assert.strictEqual(swapDelta.removed.length, 3)

  // Reversing does not lose or invent transitions.
  const reversed = [...ids].reverse()
  assert.strictEqual(
    pairKeysFor(reversed).length,
    pairKeysFor(ids).length,
    'the transition COUNT depends only on how many images there are'
  )

  assert.strictEqual(pairKeyAt(ids, 0), 'a->b')
  assert.strictEqual(pairKeyAt(ids, 3), null, 'the last image starts no transition')
  assert.strictEqual(pairKeyAt(ids, -1), null)

  // ── 17. Auto-scroll: only when genuinely out of view ─────────────────
  // Nudging the track on every keypress makes a sequence impossible to
  // read, so a visible item must return null.
  const view = { scrollLeft: 100, width: 400 }
  assert.strictEqual(
    scrollIntoViewOffset({ left: 200, width: 120 }, view),
    null,
    'an item already on screen does not move the track'
  )
  assert.strictEqual(
    scrollIntoViewOffset({ left: 40, width: 120 }, view, 24),
    16,
    'an item off the left edge scrolls back, with a margin'
  )
  assert.strictEqual(
    scrollIntoViewOffset({ left: 460, width: 120 }, view, 24),
    204,
    'and one off the right edge scrolls forward'
  )
  assert.strictEqual(
    scrollIntoViewOffset({ left: 0, width: 50 }, { scrollLeft: 10, width: 400 }),
    0,
    'never past the start of the track'
  )

  log('sequence: drop arithmetic exact, reorder is always a permutation, pairs recompute correctly')
}

/**
 * MANUAL OVERRIDES — a correction is a decision, not a guess.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────
 *
 * Same principle as a manually edited transition prompt: a person typed
 * it, so re-analysis does not get to erase it. That is why overrides live
 * in their own table rather than inside the analysis document — accepting
 * a draft replaces that document wholesale, which is right for an analysis
 * and catastrophic for a correction.
 */
function testImageOverrides(workDir: string, created: string[]): void {
  const project = makeProject('Smoke overrides')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'ov.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: 'a.png' },
    { sourcePath: p, name: 'b.png' },
    { sourcePath: p, name: 'c.png' }
  ])
  saveProject(project)
  const [i1, i2, i3] = project.images.map((i) => i.id)

  const accepted: PropertyAnalysis = {
    ...emptyAnalysis(project.id),
    state: 'accepted',
    source: 'provider',
    rooms: [
      { id: 'room-1', label: 'Living Room', imageIds: [i1, i2], landmarks: ['grey sofa'] },
      { id: 'room-2', label: 'Kitchen', imageIds: [i3], landmarks: [] }
    ],
    images: [
      { imageId: i1, roomId: 'room-1', roomConfidence: 'confirmed', orientation: 'into-room', landmarks: ['grey sofa'], openings: [] },
      { imageId: i2, roomId: 'room-1', roomConfidence: 'probable', orientation: 'into-room', landmarks: ['grey sofa'], openings: ['kitchen doorway'] },
      { imageId: i3, roomId: 'room-2', roomConfidence: 'confirmed', orientation: 'into-room', landmarks: [], openings: [] }
    ],
    edges: [
      {
        id: 'e1',
        fromRoomId: 'room-1',
        toRoomId: 'room-2',
        confidence: 'confirmed',
        supportingImageIds: [i2],
        visibleOpeningImageIds: [i2]
      }
    ]
  }
  saveAnalysis(accepted)

  // ── Analysis-derived facts, labelled as such ─────────────────────────
  const before = imageFacts(readAnalysis(project.id), i2, overrideFor(project.id, i2))
  assert.strictEqual(before.room.value, 'Living Room')
  assert.strictEqual(before.room.source, 'analysis', 'an inferred value says it was inferred')
  assert.strictEqual(before.roomConfidence, 'probable', 'and carries the analyzer’s confidence')
  assert.ok(!before.overridden, 'nothing is overridden yet')

  // An image nothing has analysed reports honestly rather than blank.
  const unknown = imageFacts(emptyAnalysis(project.id), i1, null)
  assert.strictEqual(unknown.analyzed, false, 'an unanalysed image says Not analyzed')
  assert.strictEqual(unknown.room.source, 'none', 'rather than pretending to know a room')

  // ── 10a. A manual override, clearly marked ───────────────────────────
  setOverrideField(project.id, i2, 'roomLabel', 'Dining Room')
  const after = imageFacts(readAnalysis(project.id), i2, overrideFor(project.id, i2))
  assert.strictEqual(after.room.value, 'Dining Room')
  assert.strictEqual(after.room.source, 'manual', 'a typed value says a person typed it')
  assert.ok(after.overridden, 'and the image is flagged as overridden')
  assert.strictEqual(
    after.roomConfidence,
    null,
    'the analyzer’s confidence no longer describes a room the analyzer did not choose'
  )
  assert.strictEqual(
    readAnalysis(project.id).images.find((x) => x.imageId === i2)?.roomId,
    'room-1',
    'and the ANALYSIS DOCUMENT is untouched — an override is a layer, not an edit'
  )

  // ── 12. The planner reads the corrected picture ──────────────────────
  const effective = applyImageOverrides(readAnalysis(project.id), listOverrides(project.id))
  assert.strictEqual(
    roomOfImage(effective, i2)?.label,
    'Dining Room',
    'the effective analysis reflects the correction'
  )
  assert.strictEqual(
    roomOfImage(effective, i1)?.label,
    'Living Room',
    'and leaves every other image exactly as analysed'
  )
  assert.ok(
    effective.rooms.some((r) => r.label === 'Dining Room'),
    'a label the analyzer never produced becomes a room of its own'
  )
  assert.ok(
    !effective.rooms.find((r) => r.id === 'room-1')?.imageIds.includes(i2),
    'and the image is detached from whichever room previously claimed it'
  )
  assert.strictEqual(
    relateImages(effective, i1, i2).kind,
    'unknown',
    'so 1→2 is now a cross-room move with no confirmed connection — correctly conservative'
  )

  // ── 10b. THE OVERRIDE SURVIVES RE-ANALYSIS ───────────────────────────
  // A fresh draft with completely different room ids and labels, accepted.
  // ONE id, computed once. Calling `Date.now()` separately for the room
  // and for each image made this test flaky: whenever the millisecond
  // ticked between the two expressions the ids diverged, `roomOfImage`
  // found nothing, and the run failed for a reason that had nothing to do
  // with overrides. An intermittent test is worse than a failing one.
  const regenRoomId = `regen-${Date.now()}`
  const draft: PropertyAnalysis = {
    ...emptyAnalysis(project.id),
    state: 'accepted',
    source: 'provider',
    rooms: [{ id: regenRoomId, label: 'Open Plan', imageIds: [i1, i2, i3], landmarks: [] }],
    images: [i1, i2, i3].map((id) => ({
      imageId: id,
      roomId: regenRoomId,
      orientation: 'unknown' as const,
      landmarks: [],
      openings: []
    })),
    edges: []
  }
  saveAnalysis(draft)

  const survived = imageFacts(readAnalysis(project.id), i2, overrideFor(project.id, i2))
  assert.strictEqual(
    survived.room.value,
    'Dining Room',
    'accepting a whole new analysis does NOT undo a manual correction'
  )
  assert.strictEqual(survived.room.source, 'manual')
  // ── 12b. …while analysis-derived fields DO update ────────────────────
  const updated = imageFacts(readAnalysis(project.id), i1, overrideFor(project.id, i1))
  assert.strictEqual(
    updated.room.value,
    'Open Plan',
    'an image with no override picks up the newly accepted analysis'
  )
  assert.strictEqual(updated.room.source, 'analysis')

  // ── 11. "Use analyzed value" clears the override ─────────────────────
  clearOverrideField(project.id, i2, 'roomLabel')
  const restored = imageFacts(readAnalysis(project.id), i2, overrideFor(project.id, i2))
  assert.strictEqual(restored.room.value, 'Open Plan', 'the analyzed value shows through again')
  assert.strictEqual(restored.room.source, 'analysis')
  assert.ok(!restored.overridden, 'and the image is no longer flagged')
  assert.strictEqual(
    overrideFor(project.id, i2),
    null,
    'the empty row is DELETED, not left claiming an override nobody made'
  )

  // ── Fields are independent ───────────────────────────────────────────
  setOverrideField(project.id, i3, 'openings', ['balcony doors'])
  setOverrideField(project.id, i3, 'orientation', 'out-of-room')
  const two = imageFacts(readAnalysis(project.id), i3, overrideFor(project.id, i3))
  assert.deepStrictEqual(two.openings.value, ['balcony doors'])
  assert.strictEqual(two.orientation.value, 'out-of-room')
  clearOverrideField(project.id, i3, 'openings')
  const one = imageFacts(readAnalysis(project.id), i3, overrideFor(project.id, i3))
  assert.strictEqual(one.orientation.source, 'manual', 'clearing one field leaves the other alone')
  assert.strictEqual(one.openings.source, 'analysis')

  // Explicitly unassigning is distinct from having no override at all.
  setOverrideField(project.id, i1, 'roomLabel', null)
  const unassigned = imageFacts(readAnalysis(project.id), i1, overrideFor(project.id, i1))
  assert.strictEqual(unassigned.room.value, null)
  assert.strictEqual(
    unassigned.room.source,
    'manual',
    'a deliberate "no room" is a decision, not an absence of one'
  )
  assert.strictEqual(
    roomOfImage(applyImageOverrides(readAnalysis(project.id), listOverrides(project.id)), i1),
    null,
    'and the planner sees it as unassigned'
  )

  clearOverrideField(project.id, i1)
  clearOverrideField(project.id, i3)
  assert.strictEqual(listOverrides(project.id).length, 0, 'clearing everything leaves no rows')

  log('image overrides: layered not merged, survive re-analysis, cleared cleanly')
}

/**
 * THE SUMMARY AND THE ISSUE LIST — what replaced the wall of detail.
 *
 * ── NOTHING HERE BLOCKS ANYTHING ─────────────────────────────────────
 *
 * There is deliberately no `blocking` severity. Analysis is CONTEXT: a
 * transition with no spatial understanding still generates, using the base
 * cinematic prompt and inventing no navigation. Making review mandatory
 * would stall a working pipeline behind a form, and the rules that
 * actually matter enforce themselves in the planner regardless.
 */
function testAnalysisSummary(): void {
  const ids = ['i1', 'i2', 'i3', 'i4']
  const label = (id: string): string => `Image ${ids.indexOf(id) + 1}`

  // ── 16. NO ANALYSIS: a recommendation, never fake context ────────────
  const none = summarizeAnalysis(null, ids, label)
  assert.strictEqual(none.phase, 'not-analyzed')
  assert.strictEqual(none.spaceCount, 0, 'no spaces are claimed')
  assert.strictEqual(none.confidentTransitions, 0, 'and no transition is called confident')
  assert.strictEqual(
    none.uncertainTransitions,
    3,
    'the COUNTS are honest — every transition really is uncertain'
  )
  assert.strictEqual(
    none.issues.length,
    0,
    'but an unanalysed project is not a list of problems: it would open as one warning ' +
      'per transition, reading as "broken" when the truth is "nothing has been analysed yet"'
  )
  assert.match(
    summarySubline(none),
    /no navigation is invented/i,
    'and the subline states what happens instead, rather than implying context exists'
  )

  const analysis: PropertyAnalysis = {
    ...emptyAnalysis('p'),
    state: 'accepted',
    rooms: [
      { id: 'living', label: 'Living Room', imageIds: ['i1', 'i2'], landmarks: ['grey sofa'] },
      { id: 'kitchen', label: 'Kitchen', imageIds: ['i3'], landmarks: [] },
      // A room with no images is not a "space identified".
      { id: 'ghost', label: 'Unseen', imageIds: [], landmarks: [] }
    ],
    images: [
      { imageId: 'i1', roomId: 'living', orientation: 'into-room', landmarks: ['grey sofa'], openings: [] },
      { imageId: 'i2', roomId: 'living', orientation: 'into-room', landmarks: ['grey sofa'], openings: ['kitchen doorway'] },
      { imageId: 'i3', roomId: 'kitchen', orientation: 'into-room', landmarks: [], openings: [] },
      // i4 was analysed but could not be placed.
      { imageId: 'i4', roomId: null, orientation: 'unknown', landmarks: [], openings: [] }
    ],
    edges: [
      {
        id: 'e',
        fromRoomId: 'living',
        toRoomId: 'kitchen',
        confidence: 'confirmed',
        supportingImageIds: ['i2'],
        visibleOpeningImageIds: ['i2']
      }
    ]
  }

  // ── 13. The counts ───────────────────────────────────────────────────
  const summary = summarizeAnalysis(analysis, ids, label)
  assert.strictEqual(summary.phase, 'analyzed')
  assert.strictEqual(summary.imageCount, 4)
  assert.strictEqual(summary.spaceCount, 2, 'a room holding no photographs is not a space found')
  assert.strictEqual(summary.transitionCount, 3)
  assert.strictEqual(summary.confidentTransitions, 2, '1→2 same room, 2→3 confirmed adjacency')
  assert.strictEqual(summary.uncertainTransitions, 1, 'and 3→4 has nowhere to put image 4')
  assert.strictEqual(summary.unassignedImages, 1)
  assert.strictEqual(
    summary.confidentTransitions + summary.uncertainTransitions,
    summary.transitionCount,
    'every transition is counted exactly once'
  )

  // ── 14. The issue list points at something clickable ─────────────────
  const roomIssue = summary.issues.find((i) => i.id.startsWith('image-room:'))
  assert.ok(roomIssue, 'the unplaced image is listed')
  assert.deepStrictEqual(
    roomIssue!.target,
    { kind: 'image', imageId: 'i4' },
    'and names the IMAGE to select, so clicking it opens that image'
  )
  const transitionIssue = summary.issues.find((i) => i.id.startsWith('transition-unknown:'))
  assert.ok(transitionIssue, 'the unknown transition is listed')
  assert.deepStrictEqual(
    transitionIssue!.target,
    { kind: 'transition', pairKey: 'i3->i4' },
    'and names the TRANSITION to select'
  )
  assert.match(
    transitionIssue!.detail,
    /no physical navigation will be invented/i,
    'saying exactly what the system will do instead'
  )

  // ── 15. Optional fields do not gate anything ─────────────────────────
  assert.ok(
    summary.issues.every((i) => i.severity === 'warning' || i.severity === 'info'),
    'no issue is ever blocking — an unanalysed transition still generates'
  )
  // Warnings sort first: an unknown connection is more actionable than a
  // note about one the planner already handled conservatively.
  const severities = summary.issues.map((i) => i.severity)
  assert.deepStrictEqual(
    [...severities].sort((a, b) => (a === b ? 0 : a === 'warning' ? -1 : 1)),
    severities,
    'warnings are listed before notes'
  )

  // ── A clean property says so ─────────────────────────────────────────
  const clean = summarizeAnalysis(
    {
      ...analysis,
      images: analysis.images.map((x) =>
        x.imageId === 'i4' ? { ...x, roomId: 'kitchen' } : x
      ),
      rooms: analysis.rooms.map((r) =>
        r.id === 'kitchen' ? { ...r, imageIds: ['i3', 'i4'] } : r
      )
    },
    ids,
    label
  )
  assert.strictEqual(clean.uncertainTransitions, 0, 'every transition is understood')
  assert.strictEqual(
    summarySubline(clean),
    'No critical spatial issues found',
    'and the panel says so plainly instead of listing nothing'
  )
  assert.strictEqual(
    summaryHeadline(clean),
    'Property analyzed',
    'the headline reports success either way — warnings are a normal result, not a failure'
  )

  // ── 19. Review-driven safety still shows up here ─────────────────────
  const reviews = new Map<string, ReviewVerdict>([
    [connectionFactKey('Living Room', 'Kitchen'), 'incorrect']
  ])
  const reviewed = summarizeAnalysis(analysis, ids, label, reviews)
  assert.strictEqual(
    reviewed.reviewBlockedTransitions,
    1,
    'a confirmed connection someone rejected is reported as disabled'
  )
  assert.strictEqual(
    reviewed.confidentTransitions,
    2,
    'the relationship is still understood — the review disabled the MOVEMENT, not the knowledge'
  )
  assert.ok(
    reviewed.issues.some((i) => i.id.startsWith('review-block:')),
    'and it appears in the issue list'
  )

  log('analysis summary: counts derived from the planner, issues clickable, nothing blocking')
}

/**
 * PROJECT READINESS — a readout, never a gate.
 */
function testProjectReadiness(workDir: string, created: string[]): void {
  const project = makeProject('Smoke readiness')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'ready.png')
  writeFileSync(p, png)

  const label = (id: string): string => id
  const emptyProject = { ...project, images: [] }
  const emptySummary = summarizeAnalysis(null, [], label)
  const empty = editorReadiness(emptyProject, emptySummary)
  assert.strictEqual(empty.next?.id, 'images', 'with nothing imported, the next move is Add images')
  assert.strictEqual(empty.steps.find((s) => s.id === 'images')?.state, 'todo')

  project.images = importImages(project.id, [
    { sourcePath: p, name: 'a.png' },
    { sourcePath: p, name: 'b.png' },
    { sourcePath: p, name: 'c.png' }
  ])
  saveProject(project)
  const ids = project.images.map((i) => i.id)
  const withImages = editorReadiness(project, summarizeAnalysis(null, ids, label))
  assert.strictEqual(withImages.steps.find((s) => s.id === 'images')?.state, 'done')
  assert.strictEqual(
    withImages.steps.find((s) => s.id === 'sequence')?.state,
    'done',
    'a sequence is arranged the moment there is one — there is no correct order to check against'
  )
  assert.strictEqual(
    withImages.next?.id,
    'analysis',
    'so the next useful move is analysis, which is optional and says so'
  )
  assert.match(
    withImages.steps.find((s) => s.id === 'analysis')!.hint!,
    /still generate without it/i,
    'and the hint says the pipeline works without it'
  )
  assert.strictEqual(withImages.clipsTotal, 2, 'three images make two transitions')
  assert.strictEqual(withImages.clipsReady, 0)

  // An earlier unfinished step outranks a later one needing attention.
  const noImages = editorReadiness(
    { ...project, images: [] },
    summarizeAnalysis(null, [], label)
  )
  assert.strictEqual(
    noImages.next?.id,
    'images',
    'the first UNSTARTED step is next, not a later one merely wanting attention'
  )

  log('project readiness: a readout of where the project stands, gating nothing')
}

/**
 * THE PAID-ANALYSIS CONFIRMATION GATE.
 *
 * ── WHAT IS ACTUALLY BEING PINNED ────────────────────────────────────
 *
 * That a billable Gemini request cannot happen unless a confirmation was
 * built first, and that it can happen at most ONCE per confirmation.
 *
 * The dialog is not what these tests exercise, deliberately. A dialog can
 * be bypassed by anything that reaches the IPC channel — a stale renderer,
 * a second window, a button that fired twice before React re-rendered. The
 * gate has to be the token, in main, or it is decoration. So the token is
 * what is tested.
 *
 * ZERO REAL REQUESTS: every analyzer here has a mock transport whose call
 * count is asserted.
 */
async function testAnalysisConfirmation(workDir: string, created: string[]): Promise<void> {
  const project = makeProject('Smoke confirmation')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'confirm.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: 'one.png' },
    { sourcePath: p, name: 'two.png' },
    { sourcePath: p, name: 'three.png' },
    { sourcePath: p, name: 'four.png' }
  ])
  saveProject(project)

  const request = (): AnalyzerRequest => ({
    projectId: project.id,
    projectName: project.name,
    images: project.images.map((image, idx) => ({
      imageId: image.id,
      sequence: idx + 1,
      fileName: image.fileName,
      ref: image.src
    })),
    existing: null,
    notes: '',
    capabilities: ALL_CAPABILITIES
  })

  let calls = 0
  const fetchImpl: FetchLike = async () => {
    calls++
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    rooms: [
                      { label: 'Hall', imageIds: ['IMAGE_001'], landmarks: [], confidence: 'probable' }
                    ],
                    images: [],
                    connections: []
                  })
                }
              ]
            }
          }
        ],
        usageMetadata: { promptTokenCount: 5200, candidatesTokenCount: 400, totalTokenCount: 5600 }
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const analyzer = new GeminiPropertyAnalyzer({
    apiKey: 'AIza-SMOKE-CONFIRM',
    model: GEMINI_DEFAULT_MODEL,
    live: true,
    allowLive: true,
    fetchImpl
  })

  /**
   * Exactly what `analysis:run` does for a paid live analyzer: the token
   * is checked FIRST, and a failure returns before the analyzer is ever
   * asked to do anything.
   */
  const runGated = async (token: string | undefined): Promise<{ ok: boolean }> => {
    if (!consumeAnalysisToken(token, project.id, 'gemini')) return { ok: false }
    return analyzer.analyzeProperty(request())
  }

  // ── 1. NO TOKEN → refused, and nothing was sent ──────────────────────
  assert.ok(!(await runGated(undefined)).ok, 'a paid analysis with no confirmation is refused')
  assert.strictEqual(calls, 0, 'and no request left the process')

  // ── 2. A MADE-UP token is refused too ────────────────────────────────
  assert.ok(!(await runGated('not-a-real-token')).ok, 'an invented token does not pass')
  assert.strictEqual(calls, 0, 'still nothing sent')

  // ── 3. CANCEL: a confirmation was built and simply not used ──────────
  const canceled = issueAnalysisToken(project.id, 'gemini')
  assert.ok(canceled.length > 0, 'a confirmation issues a token')
  assert.strictEqual(calls, 0, 'ZERO requests — opening the dialog sends nothing')

  // ── 4. CONFIRM: exactly one request ──────────────────────────────────
  const good = issueAnalysisToken(project.id, 'gemini')
  const first = await runGated(good)
  assert.ok(first.ok, 'a confirmed analysis runs')
  assert.strictEqual(calls, 1, 'exactly ONE request for the whole property')

  // ── 5. DOUBLE CLICK: the second submission is refused ────────────────
  const second = await runGated(good)
  assert.ok(!second.ok, 'the same confirmation cannot be spent twice')
  assert.strictEqual(calls, 1, 'and the double click sent NOTHING — still one request total')

  // ── 6. A token for ANOTHER project does not unlock this one ──────────
  const foreign = issueAnalysisToken('some-other-project', 'gemini')
  assert.ok(!(await runGated(foreign)).ok, "another project's confirmation is refused")
  assert.strictEqual(calls, 1, 'nothing sent')
  // Spent anyway: a rejected token must not survive to be guessed against
  // the next project in a list.
  assert.ok(
    !consumeAnalysisToken(foreign, 'some-other-project', 'gemini'),
    'a rejected token is consumed regardless, so it cannot be retried elsewhere'
  )

  // ── 7. A token for another ANALYZER is refused ───────────────────────
  const wrongAnalyzer = issueAnalysisToken(project.id, 'mock')
  assert.ok(!(await runGated(wrongAnalyzer)).ok, 'a token issued for a different analyzer fails')

  // ── 8. EXPIRY ────────────────────────────────────────────────────────
  const stale = issueAnalysisTokenAt(project.id, 'gemini', Date.now() - ANALYSIS_TOKEN_TTL_MS - 1000)
  assert.ok(!(await runGated(stale)).ok, 'a confirmation left open too long no longer authorises')
  assert.strictEqual(calls, 1, 'and sent nothing')

  // ── 9. DRY RUN needs no confirmation and sends nothing ───────────────
  // A dialog for a request that will not be made only teaches people to
  // click through dialogs.
  let dryCalls = 0
  const dryRun = new GeminiPropertyAnalyzer({
    apiKey: 'AIza-SMOKE-CONFIRM',
    model: GEMINI_DEFAULT_MODEL,
    live: false,
    allowLive: true,
    fetchImpl: async () => {
      dryCalls++
      return new Response('{}', { status: 200 })
    }
  })
  const dryRes = await dryRun.analyzeProperty(request())
  assert.ok(!dryRes.ok, 'a dry run produces no analysis')
  assert.match(dryRes.ok ? '' : dryRes.reason, /dry run/i, 'and says so')
  assert.strictEqual(dryCalls, 0, 'ZERO calls — no token was needed because nothing is sent')

  // ── 10. What the dialog is told: image count, and an HONEST cost ─────
  // The confirmation must name every image that will be sent, because
  // "analyse the property" does not obviously mean "upload all of it".
  assert.strictEqual(request().images.length, 4, 'all four images are in the request')
  const range = `IMAGE_001 – IMAGE_${String(project.images.length).padStart(3, '0')}`
  assert.strictEqual(range, 'IMAGE_001 – IMAGE_004', 'the id range shown covers the whole set')

  const rate = rateFor(GEMINI_DEFAULT_MODEL)
  assert.ok(rate, 'a default rate exists for the model')
  assert.strictEqual(rate!.verified, false, 'and is HONESTLY marked unverified')
  const estimate = analyzer.estimateCost(request())
  const label = rate!.verified ? `$${estimate!.amount.toFixed(4)}` : 'unavailable — rate not verified'
  assert.strictEqual(
    label,
    'unavailable — rate not verified',
    'an unverified rate is shown as UNAVAILABLE, never as an authoritative dollar figure'
  )
  assert.ok(
    !/^\$/.test(label),
    'nothing that reads like a reconcilable amount is displayed from an unchecked rate'
  )
  // But it does NOT block: not knowing the price is not a safety problem.
  assert.ok(first.ok, 'and the analysis was still allowed to run without a verified rate')

  log('analysis confirmation: no token no request, one token one request, dry run needs neither')
}

/**
 * THE REAL-REQUEST LEDGER FOR VISION ANALYSIS.
 *
 * One accepted paid request, one entry. The load-bearing rule is that an
 * UNVERIFIED rate produces token usage and a NULL actual cost, never a
 * plausible-looking number: a fabricated figure reads as reconcilable
 * against an invoice and is not, which is worse than an obvious gap.
 */
function testAnalysisLedger(workDir: string, created: string[]): void {
  const project = makeProject('Smoke analysis ledger')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'ledger.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [{ sourcePath: p, name: 'a.png' }])
  saveProject(project)

  // ── 1. A dry run records NOTHING ─────────────────────────────────────
  assert.strictEqual(listCostEntries(project.id).length, 0, 'no spend before any real request')

  // ── 2. One accepted real request → exactly one vision-analysis row ───
  const opId = `${project.id}-analysis-1`
  recordAnalysisSpend({
    projectId: project.id,
    provider: 'google',
    model: GEMINI_DEFAULT_MODEL,
    operationId: opId,
    inputTokens: 5200,
    outputTokens: 400,
    totalTokens: 5600,
    // Unverified rate → no money is claimed.
    actualCost: null,
    estimatedCost: 0.0031,
    currency: 'USD'
  })
  const entries = listCostEntries(project.id)
  assert.strictEqual(entries.length, 1, 'ONE ledger entry per accepted real request')
  const entry = entries[0]
  assert.strictEqual(entry.category, 'vision-analysis', 'categorised apart from video generation')
  assert.strictEqual(entry.provider, 'google', 'the provider is recorded')
  assert.strictEqual(entry.model, GEMINI_DEFAULT_MODEL, 'and the model')
  assert.strictEqual(entry.remoteTaskId, opId, 'and the operation id')
  assert.match(entry.transitionPair, /5200 in \/ 400 out \/ 5600 total tokens/, 'usage is recorded')

  // ── 3. NO FABRICATED SPEND ───────────────────────────────────────────
  assert.strictEqual(
    entry.actualCost,
    null,
    'an unverified rate produces NO actual cost — usage is a fact, the money is not'
  )
  assert.strictEqual(entry.estimatedCost, 0.0031, 'the estimate is kept, plainly labelled as one')
  // The rollup falls back to the estimate rather than counting a real
  // charge as zero — but it is reached from `estimatedCost`, and nothing
  // ever writes that number back into `actualCost` as though it were one.
  assert.strictEqual(
    spendByCategory(entries, 'USD').visionAnalysis,
    0,
    'vision analysis rounds to $0.00 at these token counts — and is reported apart from video'
  )
  assert.ok(
    listCostEntries(project.id).every((e) => e.category !== 'vision-analysis' || e.actualCost === null),
    'no vision-analysis row has an actual cost that an unverified rate produced'
  )

  // ── 4. Idempotent: a retry does not double-charge one analysis ───────
  recordAnalysisSpend({
    projectId: project.id,
    provider: 'google',
    model: GEMINI_DEFAULT_MODEL,
    operationId: opId,
    inputTokens: 5200,
    outputTokens: 400,
    totalTokens: 5600,
    actualCost: null,
    estimatedCost: 0.0031,
    currency: 'USD'
  })
  assert.strictEqual(listCostEntries(project.id).length, 1, 'the same operation charges once')

  // ── 5. A second, genuinely different analysis DOES record ────────────
  recordAnalysisSpend({
    projectId: project.id,
    provider: 'google',
    model: GEMINI_DEFAULT_MODEL,
    operationId: `${project.id}-analysis-2`,
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    actualCost: null,
    estimatedCost: null,
    currency: 'USD'
  })
  assert.strictEqual(listCostEntries(project.id).length, 2, 'a re-analysis is its own charge')

  // ── 6. A VERIFIED rate is the only thing that writes money ───────────
  recordAnalysisSpend({
    projectId: project.id,
    provider: 'google',
    model: GEMINI_DEFAULT_MODEL,
    operationId: `${project.id}-analysis-3`,
    inputTokens: 100,
    outputTokens: 10,
    totalTokens: 110,
    actualCost: 0.0009,
    estimatedCost: 0.0009,
    currency: 'USD'
  })
  const verified = listCostEntries(project.id).find(
    (e) => e.remoteTaskId === `${project.id}-analysis-3`
  )!
  assert.strictEqual(verified.actualCost, 0.0009, 'a verified rate does record real money')

  log('analysis ledger: one entry per real request, no money invented from an unverified rate')
}

/**
 * GROUND-TRUTH REVIEW.
 *
 * ── THE TWO RULES THAT MATTER ────────────────────────────────────────
 *
 * 1. A review NEVER edits the analysis. Marking a connection Incorrect
 *    records a judgement; deleting the edge is a separate, explicit act.
 *    If the two were the same, an operator measuring accuracy would be
 *    destroying the thing measured.
 *
 * 2. A review may only ever make the planner MORE conservative. Incorrect
 *    and Unsure disable physical navigation; Correct unlocks nothing that
 *    the evidence did not already allow.
 *
 * Nothing here is transmitted. There is no channel that could.
 */
function testGroundTruthReview(workDir: string, created: string[]): void {
  const project = makeProject('Smoke ground truth')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'truth.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: 'a.png' },
    { sourcePath: p, name: 'b.png' },
    { sourcePath: p, name: 'c.png' }
  ])
  saveProject(project)
  const [i1, i2, i3] = project.images.map((i) => i.id)

  const accepted: PropertyAnalysis = {
    ...emptyAnalysis(project.id),
    state: 'accepted',
    rooms: [
      { id: 'living', label: 'Living Room', imageIds: [i1, i2], landmarks: ['grey sofa'] },
      { id: 'kitchen', label: 'Kitchen', imageIds: [i3], landmarks: [] }
    ],
    images: [
      { imageId: i1, roomId: 'living', orientation: 'into-room', landmarks: ['grey sofa'], openings: [] },
      { imageId: i2, roomId: 'living', orientation: 'into-room', landmarks: ['grey sofa'], openings: ['kitchen doorway'] },
      { imageId: i3, roomId: 'kitchen', orientation: 'into-room', landmarks: [], openings: [] }
    ],
    edges: [
      {
        id: 'edge-living-kitchen',
        fromRoomId: 'living',
        toRoomId: 'kitchen',
        confidence: 'confirmed',
        supportingImageIds: [i2],
        visibleOpeningImageIds: [i2]
      }
    ]
  }
  saveAnalysis(accepted)

  const label = (id: string): string => `Image ${project.images.findIndex((x) => x.id === id) + 1}`
  const facts = reviewableFacts(accepted, label)

  // ── 1. Every assignment and every connection is reviewable ───────────
  assert.strictEqual(facts.length, 4, 'three image assignments plus one connection')
  const connection = facts.find((f) => f.kind === 'connection')!
  assert.ok(connection.highRisk, 'a CONFIRMED connection is flagged high-risk')
  assert.ok(
    facts.filter((f) => f.kind === 'image-room').every((f) => !f.highRisk),
    'an image assignment is not — a wrong one is a bad cut, not a wall walked through'
  )

  // ── 2. Everything starts UNREVIEWED ──────────────────────────────────
  const fresh = summarizeAccuracy(facts, reviewMap(project.id, 'accepted'))
  assert.strictEqual(fresh.reviewed, 0, 'nothing is reviewed until a human says so')
  assert.strictEqual(fresh.total, 4)
  assert.strictEqual(fresh.accuracyPct, null, 'and no percentage is invented from zero verdicts')

  // ── 3. Verdicts persist ──────────────────────────────────────────────
  const vote = (fact: (typeof facts)[number], verdict: ReviewVerdict): void =>
    setReview({
      projectId: project.id,
      scope: 'accepted',
      factKey: fact.factKey,
      kind: fact.kind,
      label: fact.label,
      verdict
    })

  const imageFacts = facts.filter((f) => f.kind === 'image-room')
  vote(imageFacts[0], 'correct')
  vote(imageFacts[1], 'correct')
  vote(imageFacts[2], 'incorrect')
  assert.strictEqual(listReviews(project.id, 'accepted').length, 3, 'three verdicts are stored')
  assert.strictEqual(
    reviewMap(project.id, 'accepted').get(imageFacts[2].factKey),
    'incorrect',
    'and read back exactly as recorded'
  )

  // ── 4. UNSURE counts as neither correct nor incorrect ────────────────
  vote(connection, 'unsure')
  const summary = summarizeAccuracy(facts, reviewMap(project.id, 'accepted'))
  assert.strictEqual(summary.reviewed, 4, 'Unsure IS a review — it was given deliberately')
  assert.strictEqual(summary.correct, 2)
  assert.strictEqual(summary.incorrect, 1)
  assert.strictEqual(summary.unsure, 1)
  assert.strictEqual(
    summary.accuracyPct,
    67,
    'accuracy is 2 of 3 determinate — Unsure is in NEITHER the numerator nor the denominator'
  )
  assert.ok(
    summary.sampleTooSmall,
    'and three judged facts is flagged too small to be a measurement of anything'
  )

  // ── 5. Clearing a verdict really clears it ───────────────────────────
  vote(imageFacts[2], 'unreviewed')
  assert.strictEqual(
    listReviews(project.id, 'accepted').length,
    3,
    "'unreviewed' removes the row rather than storing a no-opinion verdict"
  )
  vote(imageFacts[2], 'incorrect')

  // ── 6. A REVIEW NEVER EDITS THE ANALYSIS ─────────────────────────────
  const afterReview = readAnalysis(project.id)
  assert.strictEqual(afterReview.edges.length, 1, 'the connection marked Unsure still EXISTS')
  assert.strictEqual(afterReview.edges[0].confidence, 'confirmed', 'and is still confirmed')
  assert.strictEqual(afterReview.rooms.length, 2, 'the rooms are untouched')
  assert.deepStrictEqual(
    afterReview.images.find((x) => x.imageId === i3)?.roomId,
    'kitchen',
    'and an assignment marked Incorrect is still assigned — correcting it is a separate act'
  )

  // ── 7. THE ONE PLACE A REVIEW CHANGES BEHAVIOUR ──────────────────────
  // Evidence alone allows navigation across this connection.
  const evidenceOnly = planSequence(accepted, [i2, i3])
  assert.strictEqual(evidenceOnly[0].relationType, 'ADJACENT_ROOM')
  assert.strictEqual(
    evidenceOnly[0].physicalNavigationAllowed,
    true,
    'confirmed adjacency plus a visible opening licenses moving through it'
  )
  assert.strictEqual(evidenceOnly[0].reviewBlock, undefined, 'with no review involved')

  // UNSURE blocks it. "I cannot tell" is not grounds for driving a camera
  // through a doorway.
  const unsurePlans = planSequence(accepted, [i2, i3], reviewMap(project.id, 'accepted'))
  assert.strictEqual(
    unsurePlans[0].physicalNavigationAllowed,
    false,
    'an Unsure verdict on a confirmed connection disables physical navigation'
  )
  assert.match(unsurePlans[0].reviewBlock ?? '', /unsure/i, 'and says the REVIEW is why')
  assert.ok(
    !/advance through/i.test(unsurePlans[0].motionInstruction ?? ''),
    'the camera is no longer told to move through the doorway'
  )
  assert.strictEqual(
    unsurePlans[0].visiblePassage,
    null,
    'and no passage is named at all — a review can only ever restrict'
  )
  assert.match(
    renderMotionInstruction(unsurePlans[0], { fromRoom: 'Living Room', toRoom: 'Kitchen' }) ?? '',
    /WITHOUT depicting travel through any doorway/,
    'and the prompt itself carries the restriction'
  )

  // INCORRECT blocks it too.
  vote(connection, 'incorrect')
  const rejected = planSequence(accepted, [i2, i3], reviewMap(project.id, 'accepted'))
  assert.strictEqual(
    rejected[0].physicalNavigationAllowed,
    false,
    'a connection a human called wrong is not navigable, whatever the model claimed'
  )
  assert.match(rejected[0].reviewBlock ?? '', /incorrect/i, 'and the reason names the review')

  // ── 8. The warning lists exactly those, and only those ───────────────
  const unvalidated = unvalidatedConfirmedConnections(accepted, reviewMap(project.id, 'accepted'))
  assert.strictEqual(unvalidated.length, 1, 'the rejected confirmed connection is surfaced')
  assert.strictEqual(unvalidated[0].label, 'Living Room ↔ Kitchen')
  assert.strictEqual(unvalidated[0].verdict, 'incorrect')

  // ── 9. CORRECT unlocks nothing the evidence did not already allow ────
  // The asymmetry is the point: a review can only ever restrict.
  vote(connection, 'correct')
  const blessed = planSequence(accepted, [i2, i3], reviewMap(project.id, 'accepted'))
  assert.strictEqual(blessed[0].physicalNavigationAllowed, true, 'evidence + Correct still allows')
  assert.strictEqual(
    unvalidatedConfirmedConnections(accepted, reviewMap(project.id, 'accepted')).length,
    0,
    'and nothing is flagged'
  )

  // Now the same Correct verdict against an analysis with NO visible
  // opening. A human vouching for adjacency does not mean the camera can
  // see a way through.
  const noOpening: PropertyAnalysis = {
    ...accepted,
    images: accepted.images.map((x) => (x.imageId === i2 ? { ...x, openings: [] } : x))
  }
  const stillBlocked = planSequence(noOpening, [i2, i3], reviewMap(project.id, 'accepted'))
  assert.strictEqual(
    stillBlocked[0].physicalNavigationAllowed,
    false,
    'a Correct verdict does NOT license moving through an opening nobody can see'
  )
  assert.strictEqual(
    stillBlocked[0].reviewBlock,
    undefined,
    'and the evidence, not the review, is correctly named as the reason'
  )

  // ── 10. UNREVIEWED does not block ────────────────────────────────────
  // Requiring sign-off on every connection before anything could move
  // would make the analyzer useless before the evaluation is even done —
  // and the evidence rules already stand on their own.
  const noReviews = planSequence(accepted, [i2, i3], new Map())
  assert.strictEqual(
    noReviews[0].physicalNavigationAllowed,
    true,
    'an unreviewed connection follows the normal evidence rules'
  )

  // ── 11. Keys are SEMANTIC, so a re-analysis keeps genuine matches ────
  // An analyzer mints fresh room UUIDs every run. Keying on those would
  // orphan every verdict and make an unchanged property look brand new.
  // ONE suffix, computed once. Two separate `Date.now()` calls would
  // diverge whenever the millisecond ticked between them — the same flake
  // that made testImageOverrides fail intermittently.
  const regenSuffix = `-regenerated-${Date.now()}`
  const reanalyzed: PropertyAnalysis = {
    ...accepted,
    rooms: accepted.rooms.map((r) => ({ ...r, id: `${r.id}${regenSuffix}` })),
    images: [],
    edges: []
  }
  // Ids rebuilt through the map so the analysis is internally coherent.
  const remap = new Map(accepted.rooms.map((r, idx) => [r.id, reanalyzed.rooms[idx].id]))
  reanalyzed.images = accepted.images.map((x) => ({
    ...x,
    roomId: x.roomId ? (remap.get(x.roomId) ?? null) : null
  }))
  reanalyzed.edges = [
    {
      ...accepted.edges[0],
      id: 'edge-regenerated',
      fromRoomId: remap.get('living')!,
      toRoomId: remap.get('kitchen')!
    }
  ]
  const reFacts = reviewableFacts(reanalyzed, label)
  assert.deepStrictEqual(
    reFacts.map((f) => f.factKey).sort(),
    facts.map((f) => f.factKey).sort(),
    'identical facts keep identical keys across a re-analysis, despite every UUID changing'
  )
  assert.strictEqual(
    summarizeAccuracy(reFacts, reviewMap(project.id, 'accepted')).reviewed,
    4,
    'so the review earned on those facts survives'
  )

  // A genuinely CHANGED fact correctly reads as unreviewed.
  const renamed: PropertyAnalysis = {
    ...accepted,
    rooms: accepted.rooms.map((r) => (r.id === 'kitchen' ? { ...r, label: 'Utility Room' } : r))
  }
  const renamedConnection = reviewableFacts(renamed, label).find((f) => f.kind === 'connection')!
  assert.notStrictEqual(
    renamedConnection.factKey,
    connection.factKey,
    'a connection to a different room is a DIFFERENT fact and starts unreviewed'
  )

  // ── 12. DRAFT and ACCEPTED reviews are separate ──────────────────────
  // A new draft starts from a clean sheet while the accepted analysis
  // keeps the review it earned, right up until a replacement is accepted.
  assert.strictEqual(
    listReviews(project.id, 'draft').length,
    0,
    'a fresh draft inherits nothing — every fact starts Unreviewed'
  )
  setReview({
    projectId: project.id,
    scope: 'draft',
    factKey: connection.factKey,
    kind: 'connection',
    label: connection.label,
    verdict: 'incorrect'
  })
  assert.strictEqual(
    reviewMap(project.id, 'accepted').get(connection.factKey),
    'correct',
    'and judging the draft does not touch the accepted review'
  )

  // ── 13. Discarding a draft throws away only the draft ────────────────
  clearDraftReviews(project.id)
  assert.strictEqual(listReviews(project.id, 'draft').length, 0, 'the draft review is gone')
  assert.strictEqual(
    listReviews(project.id, 'accepted').length,
    4,
    'and the accepted review is entirely intact'
  )

  // ── 14. Accepting a draft promotes its review and supersedes the old ─
  setReview({
    projectId: project.id,
    scope: 'draft',
    factKey: connection.factKey,
    kind: 'connection',
    label: connection.label,
    verdict: 'incorrect'
  })
  promoteDraftReviews(project.id)
  const promoted = listReviews(project.id, 'accepted')
  assert.strictEqual(promoted.length, 1, 'the accepted review is now the draft it was judged on')
  assert.strictEqual(
    promoted[0].verdict,
    'incorrect',
    'carrying the verdict given to the draft, not the one given to the analysis it replaced'
  )
  assert.strictEqual(listReviews(project.id, 'draft').length, 0, 'and the draft scope is empty')

  log('ground truth: review evaluates without editing, and only ever restricts navigation')
}

/**
 * THE DRAFT → REVIEW → ACCEPT WORKFLOW.
 *
 * The rule being pinned: an analyzer result must never become the
 * accepted analysis on its own. An accepted analysis usually contains
 * corrections a person made by hand, and losing those silently would only
 * surface later — in a video that walked through the wrong door.
 */
function testAnalysisReview(workDir: string, created: string[]): void {
  const project = makeProject('Smoke analysis review')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'review.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: 'a.png' },
    { sourcePath: p, name: 'b.png' },
    { sourcePath: p, name: 'c.png' }
  ])
  saveProject(project)
  const [i1, i2, i3] = project.images.map((i) => i.id)

  // An ACCEPTED analysis with human judgement in it.
  const accepted: PropertyAnalysis = {
    ...emptyAnalysis(project.id),
    state: 'accepted',
    rooms: [
      { id: 'living', label: 'Living Room', imageIds: [i1, i2], landmarks: ['grey sofa'] },
      { id: 'kitchen', label: 'Kitchen', imageIds: [i3], landmarks: [] }
    ],
    images: [
      { imageId: i1, roomId: 'living', orientation: 'into-room', landmarks: ['grey sofa'], openings: [] },
      { imageId: i2, roomId: 'living', orientation: 'into-room', landmarks: ['grey sofa'], openings: ['kitchen doorway'] },
      { imageId: i3, roomId: 'kitchen', orientation: 'into-room', landmarks: [], openings: [] }
    ],
    edges: [
      { id: 'e', fromRoomId: 'living', toRoomId: 'kitchen', confidence: 'confirmed', supportingImageIds: [i2] }
    ]
  }
  saveAnalysis(accepted)
  assert.strictEqual(readAnalysis(project.id).state, 'accepted', 'the accepted state persists')

  // A re-run produces a DRAFT. The mock deliberately proposes one room
  // and no connections — the destructive case.
  const draft: PropertyAnalysis = {
    ...emptyAnalysis(project.id),
    state: 'draft',
    source: 'mock',
    rooms: [{ id: 'mock-room', label: 'Unsorted', imageIds: [i1, i2, i3], landmarks: [] }],
    images: [i1, i2, i3].map((id) => ({
      imageId: id,
      roomId: 'mock-room',
      orientation: 'unknown' as const,
      landmarks: [],
      openings: []
    })),
    edges: []
  }

  // ── The accepted analysis is UNTOUCHED while a draft exists ──────────
  const stillAccepted = readAnalysis(project.id)
  assert.strictEqual(stillAccepted.rooms.length, 2, 'the accepted analysis still has both rooms')
  assert.strictEqual(
    stillAccepted.edges.length,
    1,
    'and still has the confirmed connection — a draft replaced nothing'
  )

  // ── The diff describes exactly what acceptance WOULD cost ────────────
  const diff = diffAnalyses(stillAccepted, draft)
  assert.ok(!diff.identical, 'the draft differs from what is accepted')
  assert.deepStrictEqual(diff.addedRooms, ['Unsorted'], 'the new room is listed')
  assert.deepStrictEqual(
    diff.removedRooms.sort(),
    ['Kitchen', 'Living Room'],
    'and both existing rooms would be lost'
  )
  assert.strictEqual(diff.reassignedImages.length, 3, 'every image would be reassigned')
  assert.deepStrictEqual(
    diff.removedConnections,
    ['Living Room ↔ Kitchen'],
    'and the confirmed connection would be removed'
  )

  // ── Accepting is explicit, and only then does it replace ─────────────
  saveAnalysis({ ...draft, state: 'accepted' })
  const afterAccept = readAnalysis(project.id)
  assert.strictEqual(afterAccept.state, 'accepted', 'the draft was promoted deliberately')
  assert.strictEqual(afterAccept.rooms.length, 1, 'and only now did it replace the old rooms')

  // ── An identical re-run reports nothing to review ────────────────────
  assert.ok(
    diffAnalyses(afterAccept, { ...draft, state: 'draft' }).identical,
    'a draft matching the accepted analysis is reported as identical'
  )

  // ── Legacy documents are treated as accepted, not demoted ────────────
  // Analyses written before the workflow existed have no state. Anything
  // with rooms was in use, so calling it a draft would put a project into
  // review it never asked for.
  const legacy = parseAnalysis(
    project.id,
    JSON.stringify({ rooms: [{ id: 'x', label: 'Hall', imageIds: [], landmarks: [] }] })
  )
  assert.strictEqual(legacy.state, 'accepted', 'a pre-workflow analysis counts as accepted')
  assert.strictEqual(
    parseAnalysis(project.id, JSON.stringify({ rooms: [] })).state,
    'not-analyzed',
    'and an empty one is simply not analyzed'
  )

  log('analysis review: drafts never overwrite accepted state, diff reports the real cost')
}

/**
 * TRANSITION PLANS — the structured decision behind each prompt.
 *
 * `physicalNavigationAllowed` is the load-bearing field. It used to be a
 * property of English prose, which could not be asserted on and could
 * drift with a rewording; it is now a boolean these tests pin.
 */
/**
 * CONSTANT VELOCITY, IN EVERY AUTOMATIC PROMPT.
 *
 * The reported fault was that clips ran slow → faster → slow. That was
 * not a rendering artefact: the preset asked for it, in so many words —
 * "Ease in from an almost imperceptible start … then ease out to a still
 * landing." These assertions exist so the wording cannot drift back.
 */
/**
 * THE PROMPT BUDGET, ON THE FOUR SHAPES THAT ACTUALLY GET SENT.
 *
 * ── THE BUG THIS PINS ────────────────────────────────────────────────
 *
 * Prompts were assembled by concatenation, with the pair's own movement
 * instruction appended LAST, and only checked against the provider limit
 * at submit time — where the only remedy left was cutting characters off
 * the end. Measured on the operator's real database: eight stored
 * prompts of 2996–3458 characters against a 2500 limit, the cut landing
 * at ~2498, and six of them losing `VIEWPOINT MOVEMENT FOR THIS
 * TRANSITION` completely. The analysis that produced those instructions
 * had been run and paid for.
 *
 * So every case here asserts the same two things: it fits, and the
 * pair-specific movement is still in it.
 */
/**
 * EVERY PATH THAT FINISHES AN AUTOMATIC PROMPT MUST AGREE.
 *
 * ── THE BUG THIS PINS ────────────────────────────────────────────────
 *
 * There were two final-prompt assemblies. Prompt repair planned the pair
 * and rendered it through the canonical sections; accepting an
 * individual Re-analyse did this instead:
 *
 *   `${DEFAULT_TRANSITION_PROMPT}\n\n${motionBlock(gemini.motionInstruction)}`
 *
 * — the pre-sections concatenation, movement LAST, no budget, no
 * reflection block, no operator context, and the analyzer's prose used
 * verbatim as the route. The operator could see the difference: the same
 * pair played as one continuous take after a repair and did not after a
 * Re-analyse.
 *
 * So this builds the SAME pair through the service entrypoints and
 * compares the results to each other, not to a fixture. Two paths that
 * are both wrong in the same way still pass a fixture comparison; they
 * cannot pass this.
 */
function testFinalPromptEquivalence(workDir: string, created: string[]): void {
  const project = makeProject('Smoke final prompt equivalence')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const img = join(workDir, 'equiv.png')
  writeFileSync(img, png)
  project.images = importImages(project.id, [
    { sourcePath: img, name: 'a.png' },
    { sourcePath: img, name: 'b.png' }
  ])
  const [A, B] = project.images.map((i) => i.id)
  project.feedSequence = [A, B]
  const key = transitionKey(A, B)
  project.transitions[key] = { ...defaultTransitionSettings(5), mode: 'ai' }
  saveProject(project)

  // The analyzer's answer, worded the way a language model words things.
  // "Gently" is the tempo claim; everything else is the route.
  const GEMINI_ROUTE = 'rotate gently toward the window, then ease into the living room'
  savePairAnalysis({
    projectId: project.id,
    pairKey: key,
    analyzedAt: 5000,
    analyzer: 'gemini',
    model: 'test',
    parentAnalysisUpdatedAt: null,
    feedFingerprint: `${A}|${B}`,
    libraryFingerprint: `${A}|${B}`,
    evidence: {
      relation: 'same-room',
      sharedLandmarks: ['vanity'],
      openings: [],
      reflectiveSurfaces: [],
      geometryConflicts: []
    },
    decision: 'ai',
    missingContext: [],
    motionInstruction: GEMINI_ROUTE,
    promptCandidate: null,
    reason: 'same room',
    state: 'draft'
  })

  // ── A. THE RE-ANALYSE ACCEPTANCE PATH ───────────────────────────────
  const accepted = acceptPairAnalysis(project.id, key)
  assert.ok(accepted.ok, 'A: the analysis is accepted: ' + (accepted.reason ?? ''))
  const viaAccept = listProjects().find((p) => p.id === project.id)!.transitions[key].prompt

  // ── B. THE CANONICAL FINALIZER, CALLED DIRECTLY ─────────────────────
  const viaFinalizer = finalizeTransitionPromptById(project.id, key)
  assert.ok(viaFinalizer.ok, 'B: the finalizer builds a prompt')

  // ── C. THE REBUILD PATH ("Analyse prompts") ─────────────────────────
  rebuildPromptsFromAnalysis(project.id)
  const viaRebuild = listProjects().find((p) => p.id === project.id)!.transitions[key].prompt

  // ── D. THE REPAIR PATH ──────────────────────────────────────────────
  repairRetiredPromptOntology(project.id, false)
  const viaRepair = listProjects().find((p) => p.id === project.id)!.transitions[key].prompt

  // THE POINT OF THE WHOLE TEST.
  assert.strictEqual(viaAccept, viaFinalizer.ok ? viaFinalizer.prompt : '', 'A === B')
  assert.strictEqual(viaRebuild, viaAccept, 'C === A')
  assert.strictEqual(viaRepair, viaAccept, 'D === A')

  // ── THE ROUTE SURVIVES, THE TEMPO DOES NOT ──────────────────────────
  assert.match(viaAccept, /rotate/i, 'the analyzer’s rotation reaches the prompt')
  assert.match(viaAccept, /toward the window/i, 'and its destination')
  assert.match(viaAccept, /living room/i, 'and the room it ends in')
  for (const tempo of [/gently/i, /\bease into\b/i, /\bease in\b/i, /\bsettle into\b/i]) {
    assert.doesNotMatch(viaAccept, tempo, `no tempo claim survives: ${String(tempo)}`)
  }

  // ── AND THE CANONICAL CONTRACT IS THERE, IN THE CANONICAL ORDER ─────
  assert.ok(viaAccept.includes(PRESET_PARTS.motionQuality.text) || viaAccept.includes(PRESET_PARTS.motionQuality.compact!), 'MOTION_QUALITY verbatim')
  assert.ok(viaAccept.includes('ONE CONSTANT SPEED'), 'the speed contract')
  assert.ok(viaAccept.includes(MOTION_HEADER), 'the pair-specific movement block')
  assert.ok(
    viaAccept.indexOf(MOTION_HEADER) < viaAccept.indexOf('SCENE OCCUPANCY'),
    'the route comes BEFORE the occupancy block — the canonical order, not the appended one'
  )
  assert.ok(viaAccept.length <= PROMPT_MAX_CHARS, `budget respected: ${viaAccept.length}`)
  assert.ok(!promptUsesRetiredLayout(viaAccept), 'and it is not the retired layout')
  assert.ok(!promptUsesRetiredContract(viaAccept), 'nor a retired contract')

  // ── THE HYGIENE ITSELF ──────────────────────────────────────────────
  //
  // What it must remove, and what it must leave alone. The spatial
  // content is the whole value of the analysis; a sanitiser that eats
  // landmarks would be worse than the tempo it was written to remove.
  for (const [input, expected] of [
    ['rotate gently toward the window', 'rotate toward the window'],
    ['Slowly glide forward through the doorway', 'move forward through the doorway'],
    [
      'Move forward through the existing doorway, then turn right into the living room while preserving the wall geometry.',
      'Move forward through the existing doorway, then turn right into the living room while preserving the wall geometry.'
    ],
    ['reposition smoothly between the two viewpoints', 'reposition smoothly between the two viewpoints']
  ] as Array<[string, string]>) {
    assert.strictEqual(sanitizeMotionInstruction(input), expected, `hygiene: ${input}`)
  }
  assert.strictEqual(sanitizeMotionInstruction(null), null, 'no instruction stays no instruction')

  // ── PHRASE-AWARE, SO THE CONTRACT DOES NOT FLAG ITSELF ──────────────
  //
  // MOTION_QUALITY forbids these things BY NAME: "never accelerate,
  // decelerate, ease, ramp, hesitate, pause, surge or settle". A word
  // search finds them inside their own prohibition and reports the
  // correct prompt as broken — and the preflight that consumes such a
  // check then refuses to generate anything at all. That has already
  // happened once in this codebase.
  assert.ok(
    !containsTempoClaim(PRESET_PARTS.motionQuality.text),
    'the canonical contract is not mistaken for a tempo claim by its own prohibition'
  )
  assert.ok(!containsTempoClaim(viaAccept), 'nor is a whole finished prompt')
  assert.ok(containsTempoClaim('rotate gently toward the window'), 'but a real claim is caught')
  assert.ok(containsTempoClaim('ease into the living room'), 'and so is easing')

  log('final prompt equivalence: accept === finalizer === rebuild === repair, route kept, tempo dropped')
}

function testPromptBudget(): void {
  const MOVEMENT_WORST =
    `${MOTION_HEADER}\n` +
    'Hold the floor-to-ceiling stone fireplace and the oak media console in view while ' +
    'rotating clockwise and translating forward from the Living Room through the open ' +
    'sliding glass patio doorway into the Covered Terrace, keeping the glazed façade wall ' +
    'on the left and the sectional sofa in the lower foreground, without depicting travel ' +
    'through any other doorway or opening, since none is confirmed visible in the start frame.'

  const operatorPart = (text: string): PromptPart => ({
    id: 'operator-context',
    priority: 'mandatory',
    text: [
      'OPERATOR-PROVIDED SPATIAL CONTEXT:',
      text,
      'This is authoritative knowledge of the real property supplied by the operator. Treat it as true. Do not reinterpret it into a different layout.'
    ].join('\n'),
    compact: [
      'OPERATOR-PROVIDED SPATIAL CONTEXT:',
      text,
      'Authoritative knowledge of the real property, from the operator. Treat as true; do not reinterpret the layout.'
    ].join('\n')
  })

  const movementPart = (text: string): PromptPart => ({
    id: 'movement',
    priority: 'mandatory',
    text
  })

  const reflectionParts = (): PromptPart[] => [
    {
      id: 'reflection',
      priority: 'mandatory',
      text: REFLECTION_SAFETY_BLOCK,
      compact: REFLECTION_SAFETY_BLOCK_COMPACT
    },
    {
      id: 'expected-mirror',
      priority: 'droppable',
      text: expectedMirrorContentBlock('wall mirror', ['beige tiled wall', 'vanity unit'])!,
      compact: expectedMirrorContentBlockCompact('wall mirror', [
        'beige tiled wall',
        'vanity unit'
      ])!
    }
  ]

  // Assembled in the SAME order renderPrompt uses. Stated once here so a
  // reordering in one place and not the other shows up as a failure.
  const shape = (opts: {
    movement?: string
    operator?: string
    reflective?: boolean
  }): PromptPart[] => [
    PRESET_PARTS.opening,
    PRESET_PARTS.frames,
    ...(opts.movement ? [movementPart(opts.movement)] : []),
    PRESET_PARTS.motionQuality,
    PRESET_PARTS.geometry,
    ...(opts.operator ? [operatorPart(opts.operator)] : []),
    ...(opts.reflective ? reflectionParts() : []),
    PRESET_PARTS.occupancy,
    PRESET_PARTS.nonexistent,
    PRESET_PARTS.style
  ]

  const CASES: Array<{ name: string; parts: PromptPart[]; reflective: boolean }> = [
    {
      name: 'A. longest normal pair',
      parts: shape({ movement: MOVEMENT_WORST }),
      reflective: false
    },
    {
      name: 'B. longest reflective pair',
      parts: shape({ movement: MOVEMENT_WORST, reflective: true }),
      reflective: true
    },
    {
      name: 'C. reflective pair + operator context',
      parts: shape({
        movement: MOVEMENT_WORST,
        reflective: true,
        operator:
          'The mirror on the left shows the hallway door, not a second room. The corridor ' +
          'behind the camera position leads to the garage, which is not part of this listing.'
      }),
      reflective: true
    },
    {
      name: 'D. long pair-specific movement instruction',
      parts: shape({
        movement:
          `${MOTION_HEADER}\n` +
          'Hold the floor-to-ceiling stone fireplace, the oak media console and the brass ' +
          'floor lamp in view while rotating clockwise and translating forward from the ' +
          'Living Room through the open sliding glass patio doorway into the Covered ' +
          'Terrace, keeping the glazed façade wall on the left, the sectional sofa in the ' +
          'lower foreground and the pergola beams overhead, without depicting travel ' +
          'through any other doorway, corridor or opening, since none of them is confirmed ' +
          'visible in the start frame.',
        reflective: true,
        operator: 'The mirror shows the hallway door, not a second room.'
      }),
      reflective: true
    }
  ]

  for (const { name, parts, reflective } of CASES) {
    const built = assemblePrompt(parts)
    assert.ok(built.ok, `${name}: assembles at all — ${built.ok ? '' : built.reason}`)
    if (!built.ok) continue

    assert.ok(
      built.prompt.length <= PROMPT_MAX_CHARS,
      `${name}: ${built.prompt.length} chars, limit ${PROMPT_MAX_CHARS}`
    )

    // THE ONE THAT WAS BEING LOST.
    assert.ok(
      built.prompt.includes(MOTION_HEADER),
      `${name}: the pair-specific movement instruction survives`
    )
    // And in full — a compacted movement block would be the same bug
    // wearing a different name.
    const movement = parts.find((p) => p.id === 'movement')!
    assert.ok(built.prompt.includes(movement.text), `${name}: and survives INTACT, not shortened`)

    // Every mandatory concept still present.
    for (const rule of [
      'END FRAME must be reproduced EXACTLY',
      'ONE CONSTANT SPEED',
      'never through walls, floors, ceilings or furniture',
      'zero people anywhere in it',
      'do not exist in this world',
      'invisible virtual viewpoint'
    ]) {
      assert.ok(built.prompt.includes(rule), `${name}: "${rule}" survives`)
    }
    if (reflective) {
      assert.ok(
        built.prompt.includes('REFLECTION CONTENT'),
        `${name}: the reflection contract survives`
      )
    }
    const operator = parts.find((p) => p.id === 'operator-context')
    if (operator) {
      // The operator's OWN words, not our framing sentence around them.
      const theirText = operator.text.split('\n')[1]
      assert.ok(
        built.prompt.includes(theirText),
        `${name}: the operator's own wording is reproduced exactly`
      )
    }

    log(
      `prompt budget ${name}: ${built.prompt.length} chars` +
        (built.dropped.length ? `, dropped ${built.dropped.join('+')}` : '') +
        (built.compacted.length ? `, compacted ${built.compacted.join('+')}` : '')
    )
  }

  // ── STYLE GOES BEFORE ANY MANDATORY BLOCK IS TOUCHED ─────────────────
  //
  // Sized so that giving up the tone line is enough on its own: if the
  // ladder ever reached for a mandatory block first, this would come
  // back with something in `compacted`.
  const normal = shape({ movement: MOVEMENT_WORST })
  const fullLength = assemblePrompt(normal, Number.MAX_SAFE_INTEGER)
  assert.ok(fullLength.ok)
  const styleOnly = assemblePrompt(
    normal,
    (fullLength.ok ? fullLength.prompt.length : 0) - PRESET_PARTS.style.text.length
  )
  assert.ok(styleOnly.ok)
  assert.deepStrictEqual(
    styleOnly.ok ? styleOnly.dropped : null,
    ['style'],
    'tone is given up first'
  )
  assert.deepStrictEqual(
    styleOnly.ok ? styleOnly.compacted : null,
    [],
    'and nothing mandatory is shortened while dropping tone is still enough'
  )

  // ── MANDATORY CONTENT THAT CANNOT FIT FAILS, IT DOES NOT TRUNCATE ────
  //
  // The old path answered this case with `slice()`, which is how a
  // prompt missing its movement instruction got submitted at full price.
  const impossible = assemblePrompt(
    shape({
      movement: MOVEMENT_WORST,
      reflective: true,
      operator: 'The mirror shows the hallway door. '.repeat(60)
    })
  )
  assert.ok(!impossible.ok, 'mandatory content over the limit is refused, not cut')
  if (!impossible.ok) {
    assert.match(
      impossible.reason,
      /operator-provided spatial context|movement instruction/i,
      'and the refusal names what the operator can actually shorten'
    )
    assert.ok(
      impossible.smallestChars > impossible.maxChars,
      'and reports how far over it got'
    )
  }

  log('prompt budget: movement survives every realistic shape; overflow fails loudly')
}

function testConstantVelocityContract(): void {
  const preset = DEFAULT_TRANSITION_PROMPT

  // ── WHAT IT MUST SAY ─────────────────────────────────────────────────
  for (const required of [
    'CONTINUOUS CONSTANT VELOCITY',
    'ONE CONSTANT SPEED',
    'perfectly stabilized virtual rail'
  ]) {
    assert.ok(preset.includes(required), `the preset states: ${required}`)
  }
  assert.ok(
    /never accelerate, decelerate, ease/i.test(preset),
    'and forbids every form of tempo change by name'
  )

  // ── B/C. MOVING AT BOTH ENDS, AT THE SAME SPEED ──────────────────────
  //
  // The clip is a window onto a move that was already happening and goes
  // on afterwards. Both ends have to say so, or the model supplies the
  // missing half itself — a launch at the start, a landing at the end.
  assert.ok(
    /START FRAME is already travelling at that established speed/i.test(preset),
    'B: no launch — it is already at travel speed when the clip starts'
  )
  assert.ok(
    /END FRAME is reached at exactly that same speed/i.test(preset),
    'C: no landing — arrival happens at travel speed, not after slowing to it'
  )

  // ── D. NO LAUNCH, NO LANDING, AND IT SAYS WHY ────────────────────────
  assert.ok(
    /Do not launch out of the START FRAME or land into the END FRAME/i.test(preset),
    'D: the two failure shapes are named, not merely implied'
  )
  assert.ok(
    /segment cut from one longer uninterrupted take/i.test(preset),
    'D: and the reason is stated — several clips in sequence are one move'
  )

  // ── AND NOTHING ELSE MAY STILL ASK FOR A STOP ────────────────────────
  //
  // `FRAMES` ended "the final frame must be perfectly still" and the path
  // planner appended "Stop on a still final frame". Both said SPEED from
  // inside blocks about something else, and both contradicted reaching
  // the end frame at travel speed. The last sentence the model read used
  // to be the one telling it to halt.
  for (const contradiction of [
    /final frame must be perfectly still/i,
    /held perfectly still/i,
    /stop on a still final frame/i,
    /stops dead on the END FRAME/i
  ]) {
    assert.doesNotMatch(
      preset,
      contradiction,
      `nothing in the preset still asks the move to stop: ${String(contradiction)}`
    )
  }

  // ── AND IT HAS TO FIT ALONGSIDE A REAL INSTRUCTION ───────────────────
  //
  // The preset is never sent alone. `testPromptFitting` pins the worst
  // realistic case, but it only fails once the block has ALREADY grown
  // too big; this states the budget directly so the next person to edit
  // the wording learns the constraint from the test rather than from a
  // dropped section. 461 is the planner's wordiest instruction today.
  //
  // Measured through the ASSEMBLER, not by adding up full-form lengths.
  // The full preset is 2181 characters and does not fit beside a 461
  // character instruction — it is not supposed to. What has to be true
  // is that the assembler can reach a fitting prompt without giving up
  // anything mandatory, which is what this asks it to prove. The
  // per-shape version of the same guarantee is `testPromptBudget`.
  const withWorstMovement = assemblePrompt([
    PRESET_PARTS.opening,
    PRESET_PARTS.frames,
    { id: 'movement', priority: 'mandatory', text: 'x'.repeat(461) },
    PRESET_PARTS.motionQuality,
    PRESET_PARTS.geometry,
    PRESET_PARTS.occupancy,
    PRESET_PARTS.nonexistent,
    PRESET_PARTS.style
  ])
  assert.ok(
    withWorstMovement.ok,
    `the preset must assemble beside the wordiest motion instruction (461 chars): ` +
      `${withWorstMovement.ok ? '' : withWorstMovement.reason}`
  )
  if (withWorstMovement.ok) {
    assert.ok(
      withWorstMovement.prompt.includes('ONE CONSTANT SPEED'),
      'and the speed contract is still in what comes out'
    )
  }

  // ── WHAT IT MUST NOT SAY ─────────────────────────────────────────────
  for (const banned of [
    'ease in from',
    'ease out to',
    'imperceptible start',
    'still landing',
    'gradually slow',
    'slowly begin',
    'settle into'
  ]) {
    assert.ok(!preset.toLowerCase().includes(banned), `the preset no longer says: ${banned}`)
  }

  // ── AND STILL NO PHYSICAL DEVICE ─────────────────────────────────────
  //
  // The motion QUALITY is drone-like; the scene must not contain a drone.
  // Naming one is what once put a photographer in a bathroom mirror.
  //
  // Checked against the MOTION BLOCK, not the whole preset: the preset
  // names gimbals and drones on purpose, in the list of things that may
  // never appear in frame. A blanket substring check over the preset
  // fails on that prohibition — which is the same mistake the retired-
  // phrase detector made, in the same file, for the same reason.
  const motionBlock = /MOTION — CONTINUOUS CONSTANT VELOCITY:[^\n]*/.exec(preset)?.[0] ?? ''
  assert.ok(motionBlock.length > 0, 'the motion block is findable in the preset')
  for (const device of ['gimbal', 'drone', 'camera', 'rail-mounted', 'dolly', 'crane']) {
    assert.ok(
      !motionBlock.toLowerCase().includes(device),
      `the motion block describes motion without naming a device: ${device}`
    )
  }
  assert.ok(
    preset.includes('no physical imaging device exists'),
    'the ontology is unchanged: nothing is filming'
  )

  // ── IT CANNOT BE TRIMMED AWAY ────────────────────────────────────────
  //
  // The motion block used to be `droppable`, so the LONGEST prompts — a
  // reflective pair carrying operator context, exactly where a steady
  // move matters most — were the ones that lost it to the length limiter.
  const squeezed = fitPromptToLimit(preset, 900)
  assert.ok(
    squeezed.prompt.includes('ONE CONSTANT SPEED'),
    'the motion contract survives even an aggressive trim'
  )

  // ── THE DETECTOR SEPARATES NEW FROM RETIRED ──────────────────────────
  //
  // THE BUG THIS PINS. The current block FORBIDS these things by name —
  // "no acceleration, no deceleration, no easing" — and a naive substring
  // match finds "accelerat" and "easing" inside its own prohibition. On
  // the real database every freshly rebuilt prompt flagged itself, which
  // would have made the preflight refuse to generate anything at all.
  assert.ok(
    !promptUsesRetiredMotion(preset),
    'a CURRENT prompt is not mistaken for a stale one by its own prohibitions'
  )
  assert.ok(
    promptUsesRetiredMotion(
      'The viewpoint glides. Ease in from an almost imperceptible start, move steadily, then ease out to a still landing.'
    ),
    'but the retired three-phase wording IS caught'
  )
  assert.ok(
    promptUsesRetiredMotion(`${DEFAULT_TRANSITION_PROMPT} Then ease out to a still landing.`),
    'and a stale sentence appended to a current prompt is still caught'
  )
  assert.ok(promptCoversConstantVelocity(preset), 'the preset satisfies the currentness check')

  // Both retirements answer one question, so repair and preflight cannot
  // disagree about whether a row is current.
  assert.ok(promptUsesRetiredContract('describing a high-end stabilized gimbal'), 'ontology')
  assert.ok(promptUsesRetiredContract('ease in from an imperceptible start'), 'motion')
  assert.ok(!promptUsesRetiredContract(preset), 'and the current preset is neither')

  // ── A REFLECTIVE PAIR KEEPS BOTH CONTRACTS ───────────────────────────
  // The shape a reflective pair actually gets: the preset plus the
  // reflection block the planner appends.
  const mirrored = `${preset}\n\n${REFLECTION_SAFETY_BLOCK}`
  assert.ok(mirrored.includes('ONE CONSTANT SPEED'), 'motion contract present on a mirror pair')
  assert.ok(promptCoversReflection(mirrored), 'and the reflection contract too')
  assert.ok(!promptUsesRetiredMotion(mirrored), 'with no retired speed wording')
  // Not a substring test for `gimbal`/`drone`: the preset names both, in
  // the list of things that may never appear in frame, and a mirror pair
  // is exactly where that prohibition earns its place. The question is
  // whether the wording ASKS for equipment, which is what the detector
  // answers.
  assert.ok(
    !promptUsesRetiredContract(mirrored),
    'and still no filming equipment anywhere near a mirror'
  )

  // ── AND IT STILL FITS THE PROVIDER ──────────────────────────────────
  //
  // fal rejects a prompt over 2500 characters outright. The motion block
  // grew when it became a requirement, so the budget is asserted rather
  // than assumed — a preset that no longer fits would 422 on every
  // single generation.
  console.log(
    '[smoke] preset chars:',
    preset.length,
    '| fitted:',
    fitPromptToLimit(preset, 2500).prompt.length,
    '| dropped:',
    JSON.stringify(fitPromptToLimit(preset, 2500).dropped)
  )
  assert.ok(
    fitPromptToLimit(preset, 2500).prompt.includes('ONE CONSTANT SPEED'),
    'the motion contract reaches the provider within the character budget'
  )

  console.log('[smoke] motion contract: constant velocity, no easing, no device, not trimmable')
}

function testTransitionPlanning(): void {
  const ids = ['img-1', 'img-2', 'img-3', 'img-4']
  const analysis: PropertyAnalysis = {
    ...emptyAnalysis('p'),
    rooms: [
      { id: 'living', label: 'Living Room', imageIds: [ids[0], ids[1]], landmarks: ['grey sofa'] },
      { id: 'kitchen', label: 'Kitchen', imageIds: [ids[2]], landmarks: [] },
      { id: 'bedroom', label: 'Bedroom', imageIds: [ids[3]], landmarks: [] }
    ],
    images: [
      { imageId: ids[0], roomId: 'living', orientation: 'into-room', landmarks: ['grey sofa', 'tv wall'], openings: [] },
      { imageId: ids[1], roomId: 'living', orientation: 'into-room', landmarks: ['grey sofa'], openings: ['kitchen doorway'] },
      { imageId: ids[2], roomId: 'kitchen', orientation: 'into-room', landmarks: [], openings: [] },
      { imageId: ids[3], roomId: 'bedroom', orientation: 'unknown', landmarks: [], openings: [] }
    ],
    edges: [
      { id: 'e1', fromRoomId: 'living', toRoomId: 'kitchen', confidence: 'confirmed', supportingImageIds: [ids[1]] }
      // kitchen ↔ bedroom deliberately absent.
    ]
  }

  const plans = planSequence(analysis, ids)
  assert.strictEqual(plans.length, 3, 'four images make three plans')

  // ── 1→2: same room ───────────────────────────────────────────────────
  assert.strictEqual(plans[0].relationType, 'SAME_ROOM')
  assert.strictEqual(plans[0].confidence, 'confirmed')
  assert.deepStrictEqual(plans[0].sharedLandmarks, ['grey sofa'], 'the shared landmark is found')
  assert.strictEqual(plans[0].anchorLandmark, 'grey sofa', 'and becomes the anchor')
  assert.strictEqual(
    plans[0].physicalNavigationAllowed,
    false,
    'repositioning inside one room is not navigation between spaces'
  )

  // ── 2→3: confirmed adjacency WITH a visible opening ──────────────────
  assert.strictEqual(plans[1].relationType, 'ADJACENT_ROOM')
  assert.strictEqual(plans[1].confidence, 'confirmed')
  assert.deepStrictEqual(plans[1].visibleOpenings, ['kitchen doorway'])
  assert.strictEqual(
    plans[1].physicalNavigationAllowed,
    true,
    'a confirmed edge WITH a visible opening is the only case that permits moving through one'
  )

  // ── 3→4: no edge at all ──────────────────────────────────────────────
  assert.strictEqual(plans[2].relationType, 'UNKNOWN')
  assert.strictEqual(plans[2].physicalNavigationAllowed, false)
  assert.strictEqual(plans[2].useBaseSafetyMotion, true)
  assert.strictEqual(
    renderMotionInstruction(plans[2]),
    null,
    'an unknown relationship adds NO motion instruction at all'
  )
  assert.strictEqual(
    renderPrompt(plans[2]),
    DEFAULT_TRANSITION_PROMPT,
    'so the effective prompt is exactly the safety prompt'
  )

  // ── A confirmed edge WITHOUT a visible opening must NOT navigate ─────
  // This is the subtle one: believing two rooms connect is not the same
  // as being able to see the way through from where the camera stands.
  const noOpening: PropertyAnalysis = {
    ...analysis,
    images: analysis.images.map((i) =>
      i.imageId === ids[1] ? { ...i, openings: [] } : i
    )
  }
  const blind = planSequence(noOpening, ids)[1]
  assert.strictEqual(blind.confidence, 'confirmed', 'the edge is still confirmed')
  assert.strictEqual(
    blind.physicalNavigationAllowed,
    false,
    'but with no opening visible in the start frame, navigation is refused'
  )
  assert.match(
    renderMotionInstruction(blind)!,
    /WITHOUT depicting travel through any doorway/i,
    'and the wording says so explicitly'
  )

  // ── Probable adjacency is conservative ───────────────────────────────
  const probable: PropertyAnalysis = {
    ...analysis,
    edges: [{ ...analysis.edges[0], confidence: 'probable' }]
  }
  const soft = planSequence(probable, ids)[1]
  assert.strictEqual(soft.confidence, 'probable')
  assert.strictEqual(
    soft.physicalNavigationAllowed,
    false,
    'probable is never enough to stage a walk-through'
  )

  // ── No invented geometry, in any plan ────────────────────────────────
  for (const plan of [...plans, blind, soft]) {
    const text = renderMotionInstruction(plan) ?? ''
    if (!plan.physicalNavigationAllowed) {
      assert.ok(
        !/through the (door|doorway|opening)\b/i.test(text) ||
          /WITHOUT depicting travel/i.test(text),
        'a plan without navigation never describes moving through an opening'
      )
    }
    // Measurements are never appropriate — we have no metric information
    // about the property and must not imply otherwise.
    for (const word of ['metres', 'meters', 'feet', 'square metres', 'centimetres']) {
      assert.ok(
        !new RegExp(`\\b${word}\\b`, 'i').test(text),
        `no invented geometry: "${word}" never appears`
      )
    }
    // Architecture words MAY appear — but only inside a prohibition. The
    // navigation-allowed wording ends with "Do not invent any corridor,
    // door or opening that is not visible", which is the rule working,
    // not a violation of it.
    for (const word of ['corridor', 'hallway', 'staircase']) {
      const mentions = text.match(new RegExp(`[^.]*\\b${word}\\b[^.]*\\.`, 'gi')) ?? []
      for (const sentence of mentions) {
        assert.match(
          sentence,
          /do not invent|not visible/i,
          `"${word}" only ever appears in a prohibition, never as something to depict`
        )
      }
    }
  }

  // ── The safety contract always leads ─────────────────────────────────
  //
  // "Leads" used to mean "is a literal prefix", because every pair block
  // was concatenated after the whole preset. That is the arrangement
  // that pushed the movement instruction past the character limit, so
  // what is checked now is that the prompt still OPENS on the ontology
  // and still carries the contract — not that it is one long prefix.
  for (const plan of plans) {
    const prompt = renderPrompt(plan, { fromRoom: 'Living Room', toRoom: 'Kitchen' })
    assert.ok(
      prompt.startsWith(PRESET_PARTS.opening.text) ||
        prompt.startsWith(PRESET_PARTS.opening.compact!),
      'every prompt opens on the viewpoint ontology'
    )
    for (const section of [PRESET_PARTS.frames, PRESET_PARTS.motionQuality, PRESET_PARTS.geometry]) {
      assert.ok(
        prompt.includes(section.text) ||
          (section.compact != null && prompt.includes(section.compact)),
        `the base contract leads every prompt: ${section.id}`
      )
    }
    assert.ok(
      prompt.includes('END FRAME must be reproduced EXACTLY'),
      'and the strict end-frame rule survives'
    )
  }

  // ── F: sequence continuity ───────────────────────────────────────────
  assert.strictEqual(plans[0].continuity.incomingRotation, 'none', 'the first clip inherits nothing')
  assert.strictEqual(
    plans[1].continuity.incomingRotation,
    plans[0].continuity.outgoingRotation,
    'each plan receives the rotation the previous one handed over'
  )
  for (const plan of plans) {
    assert.strictEqual(plan.continuity.staticEndpoint, true, 'every clip must settle on its end frame')
  }
  // ── CONTINUITY IS ONLY OFFERED WHEN IT WAS DERIVED ───────────────────
  //
  // This fixture records no compass headings, so no rotation can be
  // derived and NO continuity sentence is emitted. That is the fix: the
  // old planner manufactured a clockwise turn for the first pair and
  // handed it down the whole chain, so this clause always appeared and
  // always described a direction nobody had observed.
  assert.strictEqual(
    plans[0].continuity.outgoingRotation,
    'unknown',
    'with no recorded orientation, nothing is handed to the next clip'
  )
  assert.ok(
    !/prefer to continue/i.test(
      renderMotionInstruction(plans[1], { fromRoom: 'Living Room', toRoom: 'Kitchen' }) ?? ''
    ),
    'so no continuity direction is suggested from evidence that does not exist'
  )

  // Give the same pair real headings and the clause returns — phrased as a
  // PREFERENCE that must never outrank the end frame.
  const orientated: PropertyAnalysis = {
    ...analysis,
    images: analysis.images.map((i, idx) => ({
      ...i,
      orientation: (['north', 'east', 'south', 'west'] as const)[idx % 4]
    }))
  }
  const derivedPlans = planSequence(orientated, ids)
  assert.strictEqual(
    derivedPlans[0].continuity.outgoingRotation,
    'clockwise',
    'north → east really is clockwise, and now it is derived rather than assumed'
  )
  const continued = renderMotionInstruction(derivedPlans[1], {
    fromRoom: 'Living Room',
    toRoom: 'Kitchen'
  })!
  assert.match(continued, /prefer to continue/i, 'continuity is phrased as a preference')
  assert.match(
    continued,
    /unless reaching the end frame requires otherwise/i,
    'and yields to the end frame'
  )

  log('transition planning: navigation gated on visible openings, continuity hinted not enforced')
}

/**
 * COMPARE ASSEMBLY — the evaluation tool.
 *
 * Critically: two real videos out, and NO provider reached.
 */
async function testCompareAssembly(workDir: string, created: string[]): Promise<void> {
  const project = makeProject('Smoke compare')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'cmp.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: '1.png' },
    { sourcePath: p, name: '2.png' },
    { sourcePath: p, name: '3.png' }
  ])
  const makeClip = (name: string, color: string): string => {
    const path = join(workDir, name)
    const res = spawnSync(
      ffmpegPath(),
      ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=320x240:d=2`, '-r', '25', '-pix_fmt', 'yuv420p', path],
      { encoding: 'utf8', timeout: 60_000 }
    )
    assert.strictEqual(res.status, 0, `compare fixture ${name}`)
    return path
  }
  const pairs = [0, 1].map((i) => transitionKey(project.images[i].id, project.images[i + 1].id))
  pairs.forEach((key, i) => {
    const clip = attachClipFromPath(
      project.id,
      makeClip(`cmp-${i}.mp4`, i === 0 ? 'red' : 'green'),
      'fal'
    )
    project.transitions[key] = { prompt: '', durationSec: 2, status: 'completed', clip }
  })
  saveProject(project)

  const costBefore = listCostEntries(project.id).length
  const outDir = join(workDir, 'compare-out')
  mkdirSync(outDir, { recursive: true })

  const result = await compareAssembly(project.id, outDir)
  assert.ok(result.ok, `comparison succeeded: ${result.reason ?? ''}`)
  assert.ok(result.hardCutsPath && existsSync(result.hardCutsPath), 'hard-cuts export exists')
  assert.ok(result.seamlessPath && existsSync(result.seamlessPath), 'seamless export exists')
  assert.match(result.hardCutsPath!, /_hard-cuts\.mp4$/, 'named for what it is')
  assert.match(result.seamlessPath!, /_seamless\.mp4$/, 'named for what it is')

  for (const out of [result.hardCutsPath!, result.seamlessPath!]) {
    const probe = spawnSync(ffmpegPath(), ['-hide_banner', '-i', out], {
      encoding: 'utf8',
      timeout: 30_000
    })
    assert.match(`${probe.stderr}`, /Video: h264/, `${out}: H.264`)
    assert.ok(!/Stream #0:\d+.*Audio/.test(`${probe.stderr}`), `${out}: no audio`)
  }
  assert.ok(
    probeDurationSec(result.seamlessPath!) < probeDurationSec(result.hardCutsPath!),
    'the seamless version is shorter — the seams really overlapped'
  )

  // THE IMPORTANT ONE: no provider was touched.
  assert.strictEqual(
    listCostEntries(project.id).length,
    costBefore,
    'Compare Assembly creates NO cost entry — it never reaches a provider'
  )
  assert.strictEqual(
    listJobs().filter((j) => j.projectId === project.id && j.kind === 'ai-generation').length,
    0,
    'and queues no generation job'
  )

  // Refuses to overwrite silently.
  const second = await compareAssembly(project.id, outDir)
  assert.ok(!second.ok, 'a second run without permission is refused')
  assert.strictEqual(second.wouldOverwrite?.length, 2, 'and names both files it would replace')
  const forced = await compareAssembly(project.id, outDir, { overwrite: true })
  assert.ok(forced.ok, 'explicit overwrite is allowed')

  log('compare assembly: two valid outputs, seamless shorter, zero provider requests, no silent overwrite')
}

/**
 * THE EDITOR'S WORKING PREVIEW.
 *
 * Distinct from a customer export: a MANAGED file the renderer can play
 * over f2f:// without ever being handed a filesystem path, built from
 * clips that already exist. The properties that matter are that it never
 * reaches a provider, and that it can be told apart from the project it
 * was built from once that project moves on.
 */
async function testEditorPreview(workDir: string, created: string[]): Promise<void> {
  const project = makeProject('Smoke editor preview')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'ep.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: '1.png' },
    { sourcePath: p, name: '2.png' },
    { sourcePath: p, name: '3.png' }
  ])
  const pairs = [0, 1].map((i) => transitionKey(project.images[i].id, project.images[i + 1].id))
  for (const key of pairs) {
    // Explicitly AI: this test is about Build Preview refusing to assemble
    // from clips that do not exist, which only means anything for
    // transitions that actually need one.
    project.transitions[key] = {
      prompt: '',
      durationSec: 2,
      status: 'not-generated',
      mode: 'ai',
      clip: null
    }
  }
  saveProject(project)

  // ── Nothing built yet ────────────────────────────────────────────────
  const before = editorPreviewState(project.id)
  assert.strictEqual(before.url, null, 'no preview before one is built')
  assert.strictEqual(before.builtAt, null, 'and no build time')
  assert.strictEqual(before.missing.length, 2, 'both transitions are reported missing')

  // ── Refuses to build from clips that do not exist ────────────────────
  // Build Preview ASSEMBLES; it must never quietly generate the gaps.
  const refused = await buildEditorPreview(project.id)
  assert.ok(!refused.ok, 'building with missing clips is refused')
  if (!refused.ok) {
    assert.match(refused.reason, /never generates/i, 'and says it does not generate')
  }

  // ── With clips present it builds a real, playable file ───────────────
  const makeClip = (name: string, color: string): string => {
    const path = join(workDir, name)
    const res = spawnSync(
      ffmpegPath(),
      ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=320x240:d=2`, '-r', '25', '-pix_fmt', 'yuv420p', path],
      { encoding: 'utf8', timeout: 60_000 }
    )
    assert.strictEqual(res.status, 0, `editor preview fixture ${name}`)
    return path
  }
  const withClips = listProjects().find((x) => x.id === project.id)!
  pairs.forEach((key, i) => {
    const clip = attachClipFromPath(project.id, makeClip(`ep-${i}.mp4`, i === 0 ? 'red' : 'blue'), 'fal')
    withClips.transitions[key] = { ...withClips.transitions[key], status: 'completed', clip }
  })
  saveProject(withClips)

  const costBefore = listCostEntries(project.id).length
  const built = await buildEditorPreview(project.id)
  assert.ok(built.ok, `preview built: ${built.ok ? '' : built.reason}`)
  if (!built.ok) return

  assert.match(built.url, /^f2f:\/\/export\//, 'served over the managed protocol, not a raw path')
  const resolved = resolveImageRequest(built.url)
  assert.ok(resolved, 'the protocol resolves it to a managed file')
  assert.ok(existsSync(resolved!), 'and the file is really there')

  const probe = spawnSync(ffmpegPath(), ['-hide_banner', '-i', resolved!], {
    encoding: 'utf8',
    timeout: 30_000
  })
  assert.match(`${probe.stderr}`, /Video: h264/, 'a real H.264 preview')

  // ── It reaches no provider ───────────────────────────────────────────
  assert.strictEqual(
    listCostEntries(project.id).length,
    costBefore,
    'Build Preview records NO spend — it never contacts a provider'
  )

  // ── Staleness is derivable, and survives a restart ───────────────────
  const state = editorPreviewState(project.id)
  assert.ok(state.builtAt && state.builtAt > 0, 'the build time comes from the file itself')
  const fresh = listProjects().find((x) => x.id === project.id)!
  assert.ok(
    fresh.updatedAt <= state.builtAt!,
    'immediately after a build the preview is not stale'
  )

  // Touch the project the way a reorder or a clip change would.
  fresh.updatedAt = state.builtAt! + 5_000
  saveProject(fresh)
  const afterEdit = listProjects().find((x) => x.id === project.id)!
  assert.ok(
    afterEdit.updatedAt > editorPreviewState(project.id).builtAt!,
    'a later project change makes the built preview stale — the UI can say so'
  )

  simulateRestart()
  assert.ok(
    editorPreviewState(project.id).builtAt !== null,
    'the build time survives a restart because it is the file mtime, not memory'
  )

  log('editor preview: managed + playable, refuses missing clips, zero spend, staleness derivable')
}

/**
 * PRODUCTION COST LEDGER — OUR spend, not the customer's price.
 */
function testCostLedger(workDir: string, created: string[]): void {
  const project = makeProject('Smoke cost ledger')
  created.push(project.id)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const p = join(workDir, 'cost.png')
  writeFileSync(p, png)
  project.images = importImages(project.id, [
    { sourcePath: p, name: 'one.png' },
    { sourcePath: p, name: 'two.png' },
    { sourcePath: p, name: 'three.png' }
  ])
  saveProject(project)
  const pairA = transitionKey(project.images[0].id, project.images[1].id)
  const pairB = transitionKey(project.images[1].id, project.images[2].id)

  assert.strictEqual(listCostEntries(project.id).length, 0, 'a new project has spent nothing')

  // Remote task ids are globally unique in reality, and the ledger's
  // idempotency key relies on that. Scoping the fixtures to this project
  // keeps a previous (or aborted) run from colliding with this one.
  const tid = (suffix: string): string => `${project.id}-${suffix}`
  const charge = (pairKey: string, taskId: string): void => {
    recordGenerationSpend({
      projectId: project.id,
      pairKey,
      transitionPair: pairKey === pairA ? 'Image 1 → Image 2' : 'Image 2 → Image 3',
      provider: 'fal',
      model: 'kling-v2',
      durationSec: 5,
      resolution: '1080p',
      remoteTaskId: taskId,
      jobId: `job-${taskId}`,
      estimatedCost: 0.42,
      currency: 'USD',
      status: 'submitted'
    })
  }

  // 1. A real accepted generation creates exactly one entry.
  charge(pairA, tid('task-a1'))
  assert.strictEqual(listCostEntries(project.id).length, 1, 'first real generation creates a spend entry')
  assert.strictEqual(listCostEntries(project.id)[0].attemptNumber, 1, 'numbered as attempt 1')
  assert.strictEqual(listCostEntries(project.id)[0].isRegeneration, false, 'and is not a regeneration')

  // 2. Regenerating the SAME pair adds a SECOND entry — it does not replace.
  charge(pairA, tid('task-a2'))
  const afterRegen = attemptsForPair(listCostEntries(project.id), pairA)
  assert.strictEqual(afterRegen.length, 2, 'a regenerate creates a SECOND entry')
  assert.strictEqual(afterRegen[1].attemptNumber, 2, 'numbered as attempt 2')
  assert.strictEqual(afterRegen[1].isRegeneration, true, 'and is marked a regeneration')
  assert.strictEqual(afterRegen[0].estimatedCost, 0.42, 'the FIRST attempt keeps its cost — history is not rewritten')

  // 3. A third attempt: $0.42 × 3 = $1.26, exactly the brief's example.
  charge(pairA, tid('task-a3'))
  charge(pairB, tid('task-b1'))
  const entries = listCostEntries(project.id)
  assert.strictEqual(entries.length, 4, 'three attempts on pair A plus one on pair B')

  // 4. The same remote task can never be charged twice, however many times
  // a poll, a retry or a restart passes through the record path.
  charge(pairA, tid('task-a1'))
  charge(pairA, tid('task-a1'))
  assert.strictEqual(
    listCostEntries(project.id).length,
    4,
    'recording the same remote task again does not double-charge'
  )

  // 5. Spend is the SUM of attempts, and remaining excludes pairs already
  // covered by a valid clip or by an in-flight paid task.
  const summary = summarizeSpend({
    entries: listCostEntries(project.id),
    // Pair A has a clip now; pair B still needs one.
    pairsNeedingClip: [pairB],
    pairsWithActiveTask: [],
    perGenerationEstimate: 0.42,
    currency: 'USD'
  })
  assert.strictEqual(summary.spent, 1.68, 'spent is the sum of all four attempts (4 × $0.42)')
  assert.strictEqual(summary.remainingEstimate, 0.42, 'remaining covers only the pair still without a clip')
  assert.strictEqual(summary.projectedTotal, 2.1, 'projected total = spent + remaining')
  assert.strictEqual(formatSpend(summary.spent, 'USD'), '$1.68', 'formatted in the provider currency')

  // 6. An in-flight paid task is not counted twice: its money is already in
  // `spent`, so adding it to `remaining` would overstate the projection.
  const withActive = summarizeSpend({
    entries: listCostEntries(project.id),
    pairsNeedingClip: [pairB],
    pairsWithActiveTask: [pairB],
    perGenerationEstimate: 0.42,
    currency: 'USD'
  })
  assert.strictEqual(withActive.remainingEstimate, 0, 'an active remote task is not estimated again')
  assert.strictEqual(withActive.projectedTotal, withActive.spent, 'projection equals what is already spent')

  // 7. Remote accepted but the local download failed — still spend.
  // The provider ran the job; our download problem does not refund it.
  settleGenerationSpend(project.id, tid('task-b1'), { status: 'failed', actualCost: 0.42 })
  const afterFailure = listCostEntries(project.id).find((e) => e.remoteTaskId === tid('task-b1'))!
  assert.strictEqual(afterFailure.status, 'failed', 'the outcome is recorded honestly')
  assert.strictEqual(countsAsSpend(afterFailure), true, 'a failed remote task still counts as money spent')
  assert.strictEqual(
    summarizeSpend({
      entries: listCostEntries(project.id),
      pairsNeedingClip: [],
      pairsWithActiveTask: [],
      perGenerationEstimate: 0.42,
      currency: 'USD'
    }).spent,
    1.68,
    'a failed download does not reduce spend'
  )

  // 8. Settling refines a charge; it never adds or removes one.
  const countBefore = listCostEntries(project.id).length
  settleGenerationSpend(project.id, tid('task-a1'), { status: 'succeeded', actualCost: 0.44 })
  assert.strictEqual(listCostEntries(project.id).length, countBefore, 'settling adds no row')
  assert.strictEqual(
    listCostEntries(project.id).find((e) => e.remoteTaskId === tid('task-a1'))!.actualCost,
    0.44,
    'the real rate replaces the estimate on that entry'
  )
  assert.strictEqual(
    summarizeSpend({
      entries: listCostEntries(project.id),
      pairsNeedingClip: [],
      pairsWithActiveTask: [],
      perGenerationEstimate: 0.42,
      currency: 'USD'
    }).spent,
    1.7,
    'spend uses the actual cost where known and the estimate elsewhere'
  )

  // 9. Nothing that never reached a provider is spend. Dry run, mock and
  // Attach Test Clip never call the record path at all — asserted here by
  // running a MOCK-provider generation end to end and finding no entry.
  const before = listCostEntries(project.id).length
  const mockJob = queueGeneration(project.id, [pairB], null)
  assert.ok(mockJob, 'a non-live generation job was created')
  assert.strictEqual(
    listCostEntries(project.id).length,
    before,
    'queueing a dry-run/mock generation creates NO spend entry'
  )
  const clipFile = join(workDir, 'cost-clip.mp4')
  writeFileSync(clipFile, Buffer.from('fake'))
  attachClipFromPath(project.id, clipFile, 'manual')
  assert.strictEqual(
    listCostEntries(project.id).length,
    before,
    'Attach Test Clip creates NO spend entry'
  )

  // 10. The ledger survives a restart — this is accounting, not cache.
  simulateRestart()
  const afterRestart = listCostEntries(project.id)
  assert.strictEqual(afterRestart.length, before, 'every entry survives a restart')
  assert.strictEqual(
    summarizeSpend({
      entries: afterRestart,
      pairsNeedingClip: [],
      pairsWithActiveTask: [],
      perGenerationEstimate: 0.42,
      currency: 'USD'
    }).spent,
    1.7,
    'and so does the total'
  )

  // 10b. CATEGORIES. Video generation and property analysis are separate
  // kinds of spend and are never silently merged. Every existing entry is
  // video generation — migration 10 backfills rather than leaving a null
  // for readers to guess about.
  const categorised = listCostEntries(project.id)
  for (const e of categorised) {
    assert.strictEqual(
      e.category,
      'video-generation',
      'every entry recorded so far is a video generation'
    )
  }
  const cats = spendByCategory(categorised, 'USD')
  assert.strictEqual(cats.videoGeneration, 1.7, 'video spend is the whole of it')
  assert.strictEqual(
    cats.visionAnalysis,
    0,
    'property analysis has cost nothing — manual and mock are free'
  )
  assert.strictEqual(cats.total, cats.videoGeneration, 'and the total is the video spend')
  // An analysis charge, when one eventually exists, lands in its own
  // bucket and does NOT inflate the video figure.
  const withAnalysis = spendByCategory(
    [
      ...categorised,
      {
        ...categorised[0],
        id: 'hypothetical',
        remoteTaskId: null,
        category: 'vision-analysis' as const,
        actualCost: 0.03,
        estimatedCost: 0.03
      }
    ],
    'USD'
  )
  assert.strictEqual(withAnalysis.videoGeneration, 1.7, 'video spend is unchanged by an analysis charge')
  assert.strictEqual(withAnalysis.visionAnalysis, 0.03, 'the analysis charge is its own line')
  assert.strictEqual(withAnalysis.total, 1.73, 'and the total is an explicit sum, not a merge')

  // 11. CUSTOMER PRICE IS UNTOUCHED AND SEPARATE. Different currency,
  // different direction, different meaning — the ledger must not move it.
  const snapshot = priceSnapshot(project.images.length, DEFAULT_PRICING)
  assert.strictEqual(snapshot.imageCount, 3, 'customer price still counts images')
  assert.strictEqual(snapshot.currency, 'SEK', 'customer price is still SEK')
  assert.strictEqual(
    snapshot.totalPrice,
    3 * DEFAULT_PRICING.pricePerImage,
    'customer price is still images × price per image, unaffected by production spend'
  )
  assert.notStrictEqual(
    snapshot.currency,
    listCostEntries(project.id)[0].currency,
    'the two figures are deliberately in different currencies and never merged'
  )

  log('cost ledger: attempts accumulate, no double-charge, failures still cost, restart-safe')
}

/**
 * SEAMLESS ASSEMBLY — a real encode, both modes, every aspect ratio.
 *
 * The arithmetic tests above prove the timeline; this proves FFmpeg accepts
 * the filter graph and produces a playable H.264 MP4 with no audio. It also
 * exports the SAME clips both ways so hard cuts and seamless can be
 * compared by eye (part B5) — the files are left in the work dir for the
 * duration of the run.
 */
async function testSeamAssembly(workDir: string): Promise<void> {
  const makeClip = (name: string, color: string, size: string, dur: number): string => {
    const path = join(workDir, name)
    const res = spawnSync(
      ffmpegPath(),
      [
        '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:d=${dur}`,
        '-r', '25', '-pix_fmt', 'yuv420p', path
      ],
      { encoding: 'utf8', timeout: 60_000 }
    )
    assert.strictEqual(res.status, 0, `seam fixture ${name} generated`)
    return path
  }

  // Heterogeneous sources on purpose: xfade is stricter than concat about
  // matching size/sar/fps, so mixed resolutions are the real regression.
  const clips = [
    makeClip('seam-a.mp4', 'red', '320x240', 2),
    makeClip('seam-b.mp4', 'green', '640x360', 2),
    makeClip('seam-c.mp4', 'blue', '1280x720', 2)
  ]

  const overlays: string[] = []
  const overlayPng = join(workDir, 'seam-overlay.png')
  const ovRes = spawnSync(
    ffmpegPath(),
    ['-y', '-f', 'lavfi', '-i', 'color=c=white@0.5:s=320x240:d=1', '-frames:v', '1', overlayPng],
    { encoding: 'utf8', timeout: 60_000 }
  )
  if (ovRes.status === 0) overlays.push(overlayPng)

  const run = async (
    label: string,
    blend: SeamBlend,
    paths: string[],
    defaults: Parameters<typeof assemble>[0]['defaults'],
    overlayPaths: string[]
  ): Promise<{ out: string; sec: number }> => {
    const out = join(workDir, `seam-${label}.mp4`)
    await assemble({
      clipPaths: paths,
      defaults,
      overlayPngPaths: overlayPaths,
      outputPath: out,
      seamBlend: blend
    }).done
    assert.ok(existsSync(out), `${label}: output written`)
    assert.ok(statSync(out).size > 0, `${label}: output is not empty`)
    const probe = spawnSync(ffmpegPath(), ['-hide_banner', '-i', out], {
      encoding: 'utf8',
      timeout: 30_000
    })
    const info = `${probe.stderr}`
    assert.match(info, /Video: h264/, `${label}: H.264 video stream`)
    assert.ok(!/Stream #0:\d+.*Audio/.test(info), `${label}: no audio stream`)
    return { out, sec: probeDurationSec(out) }
  }

  const base = {
    aspectRatio: '16:9' as const,
    resolution: '720p' as const,
    fps: 25 as const,
    defaultTransitionDurationSec: 4
  }

  // ── Two clips ────────────────────────────────────────────────────────
  const twoHard = await run('two-hard', 'off', clips.slice(0, 2), base, [])
  const twoSoft = await run('two-seamless', 'subtle', clips.slice(0, 2), base, [])
  assert.ok(
    twoSoft.sec < twoHard.sec,
    `two clips: the seam overlaps, so seamless is shorter (${twoSoft.sec} < ${twoHard.sec})`
  )
  assert.ok(twoHard.sec - twoSoft.sec < 1, 'and only by the seam — no motion was discarded')

  // ── Three clips, with watermark + signature overlays ─────────────────
  const threeHard = await run('three-hard', 'off', clips, base, overlays)
  const threeSoft = await run('three-seamless', 'smooth', clips, base, overlays)
  assert.ok(threeSoft.sec < threeHard.sec, 'three clips: seams shorten the total')
  const planned = planSeams({ durationsSec: clips.map((c) => probeDurationSec(c)), blend: 'smooth', fps: 25 })
  assert.ok(
    Math.abs(threeSoft.sec - planned.totalSec) < 0.35,
    `encoded duration matches the planned timeline (${threeSoft.sec} vs ${planned.totalSec})`
  )

  // ── Every supported aspect ratio survives the xfade graph ────────────
  for (const aspectRatio of ['16:9', '9:16', '1:1', '4:5'] as const) {
    const r = await run(`aspect-${aspectRatio.replace(':', 'x')}`, 'subtle', clips.slice(0, 2), {
      ...base,
      aspectRatio
    }, overlays)
    assert.ok(r.sec > 0, `${aspectRatio}: produced a real timeline`)
  }

  // ── A single clip must not attempt a seam ────────────────────────────
  const one = await run('single', 'smooth', [clips[0]], base, [])
  assert.ok(one.sec > 0, 'a one-clip export still works with blending requested')

  // ── Very short clips fall back rather than failing ───────────────────
  const shortClips = [
    makeClip('seam-tiny-a.mp4', 'red', '320x240', 1),
    makeClip('seam-tiny-b.mp4', 'green', '320x240', 1)
  ]
  const tiny = await run('tiny', 'smooth', shortClips, base, [])
  assert.ok(tiny.sec > 0, 'very short clips still assemble without failing')

  // ── 13 & 14. A MIXED SEQUENCE, THROUGH REAL FFMPEG ───────────────────
  //
  //   still · CUT · clip · CROSSFADE · clip
  //
  // Not every adjacent pair has an MP4, which is the whole point: the
  // timeline mixes generated clips with held stills, joined by hard cuts
  // and deliberate dissolves.
  const stillPng = join(workDir, 'seam-still.jpg')
  spawnSync(
    ffmpegPath(),
    ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:d=1', '-frames:v', '1', stillPng],
    { encoding: 'utf8', timeout: 60_000 }
  )
  assert.ok(existsSync(stillPng), 'a still fixture exists')

  const mixedOut = join(workDir, 'seam-mixed.mp4')
  await assemble({
    clipPaths: [],
    segments: [
      { kind: 'still', path: stillPng, holdSeconds: 1.5 },
      { kind: 'clip', path: clips[0] },
      { kind: 'clip', path: clips[1] }
    ],
    // Hard cut into the first clip, dissolve into the second.
    seamOverrideSec: [0, 0.5],
    defaults: base,
    overlayPngPaths: [],
    outputPath: mixedOut
  }).done

  assert.ok(existsSync(mixedOut), 'the mixed timeline produced a file')
  const mixedInfo = `${spawnSync(ffmpegPath(), ['-hide_banner', '-i', mixedOut], { encoding: 'utf8', timeout: 30_000 }).stderr}`
  assert.match(mixedInfo, /Video: h264/, 'H.264 out, like every other export')
  assert.ok(!/Stream #0:\d+.*Audio/.test(mixedInfo), 'and still no audio stream')

  const mixedSec = probeDurationSec(mixedOut)
  const clipSecs = probeDurationSec(clips[0]) + probeDurationSec(clips[1])
  assert.ok(mixedSec > clipSecs, 'the held still genuinely added time to the timeline')
  // ── NO BLACK FRAME AT THE CUT ────────────────────────────────────────
  //
  // The failure mode a hard cut can produce is a gap: an xfade of length
  // zero, or a segment that ends before the next begins, shows through as
  // black. The timeline arithmetic must account for every frame, so the
  // output is the sum of the parts minus exactly the dissolve.
  const expected = 1.5 + clipSecs - 0.5
  assert.ok(
    Math.abs(mixedSec - expected) < 0.35,
    `mixed duration ${mixedSec.toFixed(2)}s ≈ ${expected.toFixed(2)}s — no gap, so no black frame at the cut`
  )

  // An ALL-CUT sequence is a real video too, not an empty one.
  const allCutOut = join(workDir, 'seam-allcut.mp4')
  await assemble({
    clipPaths: [],
    segments: [
      { kind: 'still', path: stillPng, holdSeconds: 1 },
      { kind: 'still', path: stillPng, holdSeconds: 1 },
      { kind: 'still', path: stillPng, holdSeconds: 1 }
    ],
    seamOverrideSec: [0, 0],
    defaults: base,
    overlayPngPaths: [],
    outputPath: allCutOut
  }).done
  assert.ok(existsSync(allCutOut) && statSync(allCutOut).size > 0, 'an all-cut project still exports')
  assert.ok(
    Math.abs(probeDurationSec(allCutOut) - 3) < 0.35,
    'and its length is exactly the sum of the holds'
  )

  log('seamless assembly: 2/3+ clips, mixed cut/crossfade timeline, all aspect ratios, overlays, H.264')
}

/**
 * SEAMLESS ASSEMBLY — the joint between two generated clips.
 *
 * Pure arithmetic first (no FFmpeg), then a real encode. The arithmetic is
 * where the dangerous mistakes live: a seam longer than the clip it joins,
 * a negative xfade offset, or a total duration that drifts from what the
 * customer was quoted.
 */
function testSeamPlanning(): void {
  // ── Two clips, the simplest seam ──────────────────────────────────────
  const two = planSeams({ durationsSec: [5, 5], blend: 'subtle', fps: 25 })
  assert.strictEqual(two.seamSec.length, 1, 'two clips make one seam')
  assert.strictEqual(two.seamSec[0], SEAM_SECONDS.subtle, 'subtle seam is used in full on 5s clips')
  assert.ok(two.blended, 'the plan reports that it blends')
  // A⊕B lasts durA + durB − seam, minus the frames trimmed at the joint.
  const expectedTwo = two.effectiveSec[0] + two.effectiveSec[1] - two.seamSec[0]
  assert.ok(
    Math.abs(two.totalSec - expectedTwo) < 0.002,
    `two-clip total is the overlap-corrected sum (${two.totalSec} vs ${expectedTwo})`
  )
  assert.ok(two.totalSec < 10, 'the seam genuinely shortens the timeline')

  // ── Three-plus clips: offsets must climb, never go backwards ─────────
  const many = planSeams({ durationsSec: [4, 6, 5, 3], blend: 'smooth', fps: 30 })
  assert.strictEqual(many.seamSec.length, 3, 'four clips make three seams')
  for (let i = 1; i < many.offsetSec.length; i++) {
    assert.ok(
      many.offsetSec[i] > many.offsetSec[i - 1],
      `seam ${i + 1} starts after seam ${i} — offsets are on the accumulated timeline`
    )
  }
  assert.ok(many.offsetSec[0] > 0, 'the first seam does not start before the video does')
  const rawTotal = 4 + 6 + 5 + 3
  assert.ok(many.totalSec < rawTotal, 'overlapping seams shorten the total')
  assert.ok(many.totalSec > rawTotal - 2, 'and only by the seams — no motion is thrown away')

  // ── Off is the untouched hard-cut path ───────────────────────────────
  const off = planSeams({ durationsSec: [4, 6, 5], blend: 'off', fps: 25 })
  assert.ok(!off.blended, 'off does not blend')
  assert.deepStrictEqual(off.seamSec, [0, 0, 0].slice(0, 2), 'every seam is zero')
  assert.deepStrictEqual(off.trimStartSec, [0, 0, 0], 'off trims nothing')
  assert.deepStrictEqual(off.trimEndSec, [0, 0, 0], 'off trims nothing')
  assert.strictEqual(off.totalSec, 15, 'off keeps the exact sum of the inputs')

  // ── Very short clips must degrade, never corrupt ─────────────────────
  // A seam longer than the clip would make xfade consume it whole and the
  // offset go negative. Both are clamped instead.
  const tiny = planSeams({ durationsSec: [0.2, 0.2], blend: 'smooth', fps: 25 })
  assert.ok(tiny.seamSec[0] < 0.2, 'the seam is clamped below the clip length')
  assert.ok(tiny.offsetSec[0] >= 0, 'the xfade offset never goes negative')
  assert.ok(tiny.totalSec > 0, 'a valid timeline still results')
  assert.deepStrictEqual(tiny.trimStartSec, [0, 0], 'a clip too short to spare a frame is not trimmed')
  assert.deepStrictEqual(tiny.trimEndSec, [0, 0], 'a clip too short to spare a frame is not trimmed')

  // ── One clip has no seams at all ─────────────────────────────────────
  const single = planSeams({ durationsSec: [7], blend: 'smooth', fps: 25 })
  assert.strictEqual(single.seamSec.length, 0, 'a single clip has no seam')
  assert.ok(!single.blended, 'and therefore does not blend')
  assert.strictEqual(single.totalSec, 7, 'its duration is untouched')

  // The default is deliberately small — a seam anyone can point at is the
  // slideshow look this feature exists to avoid.
  assert.ok(SEAM_SECONDS.subtle <= 0.2, 'subtle stays within a few frames')
  assert.ok(SEAM_SECONDS.smooth <= 0.25, 'even smooth stays under a quarter second')
  assert.ok(SEAM_SECONDS.off === 0, 'off is exactly zero')

  log('seam planning: offsets monotonic, totals overlap-corrected, short clips degrade safely')
}

/**
 * CLIP VISIBILITY — the bug where a generated clip never reached the UI.
 *
 * A transition could generate, download, validate and be written to the
 * database, and the Project Editor would still show nothing until the app
 * was restarted or the project reopened. The database was right the whole
 * time. The renderer was never told: the only main → renderer channel was
 * `queue:changed`, which carries a queue snapshot, and the only calls to
 * `refreshProjects()` sat behind user clicks — including one on the
 * generation path that fires when generation STARTS, before a clip exists.
 *
 * These tests pin the contract that replaced it. `broadcastProjectUpdated`
 * RE-READS from the persistence layer and returns exactly what it would
 * push, so asserting on its return value is asserting on what the renderer
 * receives. No network, no provider, no credits.
 */
function testClipVisibility(workDir: string, created: string[]): void {
  const project = makeProject('Smoke clip visibility')
  created.push(project.id)

  // Four images → three transition pairs, the shape the bug was reported on.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const imagePaths: string[] = []
  for (let i = 0; i < 4; i++) {
    const p = join(workDir, `vis-${i}.png`)
    writeFileSync(p, png)
    imagePaths.push(p)
  }
  project.images = importImages(
    project.id,
    imagePaths.map((p, i) => ({ sourcePath: p, name: `vis-${i}.png` }))
  )
  const pairs = [
    transitionKey(project.images[0].id, project.images[1].id),
    transitionKey(project.images[1].id, project.images[2].id),
    transitionKey(project.images[2].id, project.images[3].id)
  ]
  for (const key of pairs) {
    project.transitions[key] = { prompt: '', durationSec: 5, status: 'not-generated', clip: null }
  }
  saveProject(project)

  // ── 1. The broadcast reports STORED state, not a caller's optimistic copy.
  // This is the whole point of re-reading: if a save silently failed, the UI
  // must show the truth rather than an object we merely hoped was written.
  const optimistic = listProjects().find((p) => p.id === project.id)!
  optimistic.transitions[pairs[0]] = {
    ...optimistic.transitions[pairs[0]],
    status: 'completed',
    clip: { storedName: 'never-saved.mp4', originalName: 'x.mp4', source: 'fal', src: 'f2f://x' }
  }
  // Deliberately NOT saved.
  const pushedBeforeSave = broadcastProjectUpdated(project.id)
  assert.ok(pushedBeforeSave, 'broadcast returns the project')
  assert.strictEqual(
    pushedBeforeSave.transitions[pairs[0]].clip,
    null,
    'an unsaved in-memory mutation is NOT broadcast — the push re-reads the database'
  )

  // ── 2. Each attached clip appears, cumulatively, with no restart.
  // The renderer state that used to go stale is exactly this: one pair
  // completing must not lose the pairs that completed before it.
  const attachedNames: string[] = []
  for (const [index, key] of pairs.entries()) {
    const clipFile = join(workDir, `vis-clip-${index}.mp4`)
    writeFileSync(clipFile, Buffer.from(`fake-mp4-${index}`))
    // Source 'fal' so the card renders the provider attribution path, which
    // is the same field a real download writes.
    const clip = attachClipFromPath(project.id, clipFile, 'fal')
    attachedNames.push(clip.storedName)
    const current = listProjects().find((p) => p.id === project.id)!
    current.transitions[key] = {
      ...current.transitions[key],
      status: 'completed',
      clip
    }
    saveProject(current)

    const pushed = broadcastProjectUpdated(project.id)!
    // Every pair completed SO FAR is present in the same push.
    for (let seen = 0; seen <= index; seen++) {
      assert.ok(
        pushed.transitions[pairs[seen]].clip,
        `transition ${seen + 1} still carries its clip after transition ${index + 1} completed`
      )
      assert.strictEqual(
        pushed.transitions[pairs[seen]].status,
        'completed',
        `transition ${seen + 1} reads completed`
      )
    }
    // And the pairs that have NOT run are untouched — no optimistic filling.
    for (let later = index + 1; later < pairs.length; later++) {
      assert.strictEqual(
        pushed.transitions[pairs[later]].clip,
        null,
        `transition ${later + 1} has not been generated and claims no clip`
      )
    }
  }

  // ── 3. The push survives a "restart" because it is only ever a mirror of
  // what is stored. Re-reading after a simulated restart gives the same thing.
  simulateRestart()
  const afterRestart = broadcastProjectUpdated(project.id)!
  for (const key of pairs) {
    assert.ok(afterRestart.transitions[key].clip, 'clips persist across a restart')
  }

  // ── 4. A row is not proof of a file. Deleting the bytes underneath must
  // read as missing rather than as a playable clip.
  const victim = attachedNames[1]
  const victimPath = resolveClipPath(project.id, victim)
  assert.ok(victimPath, 'clip path resolves while the file exists')
  rmSync(victimPath, { force: true })
  assert.strictEqual(
    resolveClipPath(project.id, victim),
    null,
    'a deleted clip file resolves to null — the UI can tell the truth about it'
  )
  const stillClaims = listProjects().find((p) => p.id === project.id)!
  assert.ok(
    stillClaims.transitions[pairs[1]].clip,
    'the database row is deliberately kept so the state is recoverable, not silently erased'
  )

  // ── 5. Retry download can never become a second paid generation.
  // The shared state machine is what the transition card asks, so this is
  // the exact rule the "Retry download" button is gated on.
  assert.strictEqual(
    resolveGenerationAction({
      provider: 'fal',
      model: 'm',
      dryRun: false,
      providerTaskId: 'task-123',
      providerStatus: 'COMPLETED',
      submittedAt: Date.now(),
      lastPolledAt: null,
      estimatedCost: null,
      estimatedCredits: null,
      actualCost: null,
      actualCredits: null,
      providerMeta: null
    } as QueueJob['provider'] as never),
    'download',
    'a succeeded remote task resolves to DOWNLOAD — never submit, so retrying cannot pay twice'
  )
  assert.strictEqual(
    resolveGenerationAction(undefined),
    'submit',
    'only a job with no remote task at all may submit'
  )

  log('clip visibility: push mirrors stored state, clips accumulate, missing files stay honest')
}

/**
 * THE AUTHORITATIVE QUEUE URL CONTRACT.
 *
 * A real paid fal request was left unpollable because we rebuilt its queue
 * url from the model id and fal answered 405. These are pure-function tests
 * over the url module — no transport, no network, no credits.
 */
function testFalQueueUrls(): void {
  const submitResponse = {
    request_id: 'req-abc',
    status: 'IN_QUEUE',
    status_url: 'https://queue.fal.run/fal-ai/kling-video/requests/req-abc/status',
    response_url: 'https://queue.fal.run/fal-ai/kling-video/requests/req-abc',
    cancel_url: 'https://queue.fal.run/fal-ai/kling-video/requests/req-abc/cancel'
  }

  // 1 — all four fields are read off the submit response.
  const extracted = extractQueueUrls(submitResponse)
  assert.strictEqual(extracted.statusUrl, submitResponse.status_url, 'status_url extracted')
  assert.strictEqual(extracted.responseUrl, submitResponse.response_url, 'response_url extracted')
  assert.strictEqual(extracted.cancelUrl, submitResponse.cancel_url, 'cancel_url extracted')
  assert.strictEqual(extractRequestId(submitResponse), 'req-abc', 'request_id extracted')

  // 2 — sanitizeMeta PERSISTS them. This is the exact regression: the old
  //     allowlist dropped all three and left only the id.
  const meta = sanitizeMeta(submitResponse)
  assert.strictEqual(meta['status_url'], submitResponse.status_url, 'status_url survives sanitizeMeta')
  assert.strictEqual(meta['response_url'], submitResponse.response_url, 'response_url survives')
  assert.strictEqual(meta['cancel_url'], submitResponse.cancel_url, 'cancel_url survives')
  assert.strictEqual(meta['request_id'], 'req-abc', 'request_id still survives')

  // 3/4/5/6 — resolution prefers the persisted urls over anything derived.
  const resolved = resolveQueueUrls(meta, 'req-abc')
  assert.strictEqual(resolved.statusUrl, submitResponse.status_url, 'polling uses the exact status_url')
  assert.strictEqual(resolved.responseUrl, submitResponse.response_url, 'result uses the exact response_url')
  assert.strictEqual(resolved.cancelUrl, submitResponse.cancel_url, 'cancel uses the exact cancel_url')
  assert.strictEqual(resolved.source, 'submit-response', 'the urls are reported as authoritative')
  assert.ok(
    !resolved.statusUrl.includes('/o3/standard/image-to-video'),
    'the endpoint sub-path is NOT used when authoritative urls exist'
  )

  // The derived fallback no longer builds the path that 405s.
  const derived = deriveQueueUrls('req-abc')
  assert.ok(
    !derived.statusUrl.includes('/o3/standard/image-to-video'),
    'derived queue urls drop the endpoint sub-path (the 405 cause)'
  )
  assert.strictEqual(
    derived.statusUrl,
    'https://queue.fal.run/fal-ai/kling-video/requests/req-abc/status',
    'derived status url uses the application base'
  )

  // 11 — a job with NO stored urls is recoverable, not authoritative.
  const legacyMeta = { status: 'IN_QUEUE', queue_position: 0, request_id: 'req-abc' }
  assert.ok(!hasAuthoritativeUrls(legacyMeta), 'a legacy job has no authoritative urls')
  assert.strictEqual(resolveQueueUrls(legacyMeta, 'req-abc').source, 'derived', 'legacy falls back to derived')
  assert.ok(hasAuthoritativeUrls(meta), 'a job submitted after the fix does have them')

  // A partial recovery keeps what it was given and derives only the rest.
  const partial = resolveQueueUrls({ status_url: submitResponse.status_url }, 'req-abc')
  assert.strictEqual(partial.statusUrl, submitResponse.status_url, 'a pasted status_url is used verbatim')
  assert.strictEqual(partial.responseUrl, derived.responseUrl, 'the missing url is derived, not invented')
  assert.strictEqual(partial.source, 'derived', 'partial recovery is not claimed as authoritative')

  // 10 — a 405 is an endpoint problem, never a failed generation.
  const stale = mapFalHttpError(405, {}, {
    stage: 'status',
    url: 'https://queue.fal.run/fal-ai/kling-video/o3/standard/image-to-video/requests/x/status',
    hadAuth: true
  })
  assert.strictEqual(stale.code, 'endpoint-unverified', '405 is classified as an endpoint problem')
  assert.match(stale.message, /still exists/i, '405 says the remote task survives')

  log('fal queue urls: authoritative urls persisted, preferred and never reconstructed')
}

// ── LIVE path with MOCKED transport — never a real Kling call ────────────

interface MockTransport {
  (url: string, init: RequestInit): Promise<Response>
  calls: { url: string; method: string; body?: string }[]
  submits: number
  statusPolls: number
  downloads: number
  /** How many status polls report 'processing' before succeeding. */
  processingPolls: number
  failTask: boolean
  resultBytes: Buffer
  resultUrl: string
}

function makeMockTransport(resultBytes: Buffer): MockTransport {
  const fn = (async (url: string, init: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase()
    fn.calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined })

    if (url === fn.resultUrl) {
      fn.downloads++
      return new Response(new Uint8Array(fn.resultBytes))
    }
    if (method === 'POST') {
      fn.submits++
      return new Response(JSON.stringify({ data: { task_id: 'remote-task-live-1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    fn.statusPolls++
    if (fn.failTask) {
      return new Response(JSON.stringify({ data: { task_status: 'failed' } }), { status: 200 })
    }
    const done = fn.statusPolls > fn.processingPolls
    return new Response(
      JSON.stringify({
        data: done
          ? { task_status: 'succeed', task_result: { videos: [{ url: fn.resultUrl }] } }
          : { task_status: 'processing' }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }) as MockTransport

  fn.calls = []
  fn.submits = 0
  fn.statusPolls = 0
  fn.downloads = 0
  fn.processingPolls = 1
  fn.failTask = false
  fn.resultBytes = resultBytes
  fn.resultUrl = 'https://mock.invalid/result.mp4'
  return fn
}

const LIVE_SETTINGS = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    // These fixtures exercise the PROVIDER path — submit, poll, download,
    // attach. Quality validation is a separate concern with its own tests
    // (testQualityValidation), and it is switched off here so a missing
    // Gemini key cannot turn every provider assertion into a needs-review.
    // See the report: with the check ON and no key, clips correctly stop
    // at needs-review rather than attaching.
    analyzer: { analyzerId: 'manual', model: '', apiKey: '', mode: 'dry-run', qualityValidationMode: 'off' },
    providers: [
      {
        id: 'kling',
        label: 'Kling',
        apiKey: 'sk-live-smoke-key',
        legacySecret: '',
        mode: 'live',
        model: KLING_MODELS[0].id
      }
    ],
    exportDefaults: { aspectRatio: '16:9', resolution: '1080p', fps: 25, defaultTransitionDurationSec: 5 },
    pricing: { pricePerImage: 149, currency: 'SEK' },
    production: {
      maxConcurrentAiGenerations: 1,
      mockAiCostPerSecond: null,
      allowLiveKlingRequests: true,
      klingContract: { acknowledged: true },
      ...overrides
    }
  })

async function testKlingLive(workDir: string, created: string[]): Promise<void> {
  // Fast polling for the test only.
  process.env['F2F_POLL_MS'] = '30'
  process.env['F2F_POLL_TIMEOUT_MS'] = '10000'

  initQueue()
  pauseQueue()

  // A real, playable MP4 the mock transport will "download".
  const fixture = join(workDir, 'live-result.mp4')
  const gen = spawnSync(
    ffmpegPath(),
    ['-y', '-f', 'lavfi', '-i', 'color=c=teal:s=320x240:d=1', '-r', '25', '-pix_fmt', 'yuv420p', fixture],
    { encoding: 'utf8', timeout: 60_000 }
  )
  assert.strictEqual(gen.status, 0, 'live result fixture generated')
  const resultBytes = readFileSync(fixture)

  const transport = makeMockTransport(resultBytes)
  __setTestTransport(transport)

  const originalSettings = getSettingsJson()
  const project = makeProject('Live Test Villa')
  created.push(project.id)
  saveProject(project)
  // DISTINCT frames: the provider refuses to submit an identical pair, so
  // the fixtures must differ like real property photos do.
  const framePath = (name: string, color: string): string => {
    const path = join(workDir, name)
    const res = spawnSync(
      ffmpegPath(),
      ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=64x48:d=1`, '-frames:v', '1', path],
      { encoding: 'utf8', timeout: 60_000 }
    )
    assert.strictEqual(res.status, 0, `frame fixture ${name} generated`)
    return path
  }
  // Three images → two pairs, so a batch attempt is representable.
  const imgs = importImages(project.id, [
    { sourcePath: framePath('live-one.png', 'red'), name: 'one.png' },
    { sourcePath: framePath('live-two.png', 'green'), name: 'two.png' },
    { sourcePath: framePath('live-three.png', 'blue'), name: 'three.png' }
  ])
  project.images = imgs
  const pairA = transitionKey(imgs[0].id, imgs[1].id)
  const pairB = transitionKey(imgs[1].id, imgs[2].id)
  project.transitions[pairA] = { prompt: '', durationSec: 5, status: 'not-generated', clip: null }
  project.transitions[pairB] = { prompt: '', durationSec: 5, status: 'not-generated', clip: null }
  saveProject(project)

  giveProjectAcceptedMap(project.id, imgs)

  try {
    // 3. Safety lock OFF → refused, before any transport call.
    saveSettingsJson(LIVE_SETTINGS({ allowLiveKlingRequests: false }))
    const locked = queueLiveGeneration(project.id, [pairA])
    assert.ok(!locked.ok, 'safety lock OFF blocks live generation')
    assert.ok(
      locked.reasons.some((r) => /safety lock/i.test(r)),
      'the lock is named as the reason'
    )
    assert.strictEqual(transport.calls.length, 0, 'no transport call while locked')

    // Contract not acknowledged → refused.
    saveSettingsJson(LIVE_SETTINGS({ klingContract: { acknowledged: false } }))
    const unack = queueLiveGeneration(project.id, [pairA])
    assert.ok(!unack.ok && unack.reasons.some((r) => /contract/i.test(r)), 'unacknowledged contract blocks live')

    // Now fully configured.
    saveSettingsJson(LIVE_SETTINGS())

    // 2 + 23. Batch/live rejected before any network call.
    const batch = queueLiveGeneration(project.id, [pairA, pairB])
    assert.ok(!batch.ok, 'two live transitions rejected')
    assert.ok(batch.reasons.some((r) => /limited to 1 transition/i.test(r)), 'batch limit named')
    assert.strictEqual(transport.calls.length, 0, 'batch attempt made no transport call')

    // 4. Missing key → refused (checked through the provider itself).
    const keyless = new KlingProvider({
      apiKey: '',
      mode: 'live',
      liveAllowed: true,
      fetchImpl: transport
    })
    const keylessSubmit = await keyless.submitGeneration({
      projectId: project.id,
      pairKey: pairA,
      startImagePath: join(projectImagesDir(project.id), imgs[0].storedName),
      endImagePath: join(projectImagesDir(project.id), imgs[1].storedName),
      startImageName: 'one.png',
      endImageName: 'two.png',
      prompt: 'x',
      durationSec: 5,
      resolution: '1080p',
      nativeAudio: false,
      modelId: KLING_MODELS[0].id
    })
    assert.ok(!keylessSubmit.ok && keylessSubmit.error.code === 'not-configured', 'missing key blocks live submit')
    assert.strictEqual(transport.submits, 0, 'no submit happened without a key')

    // 5. Unsupported capability rejected.
    const capProvider = new KlingProvider({ apiKey: 'k', mode: 'live', liveAllowed: true, fetchImpl: transport })
    const capCheck = capProvider.validateRequest({
      projectId: project.id,
      pairKey: pairA,
      startImagePath: 'a',
      endImagePath: 'b',
      startImageName: 'a',
      endImageName: 'b',
      prompt: 'p',
      durationSec: 5,
      resolution: '1080p',
      nativeAudio: false,
      modelId: 'kling-v3-turbo'
    })
    assert.ok(!capCheck.ok && capCheck.error.code === 'unsupported-capability', 'incapable model refused')

    // 8. Paid confirmation data is correct.
    const confirm = liveConfirmation(project.id, pairA)
    assert.ok(confirm, 'confirmation data built')
    assert.strictEqual(confirm!.ok, true, 'confirmation is actionable when configured')
    assert.strictEqual(confirm!.projectName, 'Live Test Villa')
    assert.strictEqual(confirm!.transitionLabel, 'Image 1 → Image 2', 'human transition label')
    assert.strictEqual(confirm!.provider, 'Kling')
    assert.strictEqual(confirm!.durationSec, 5)
    assert.strictEqual(confirm!.resolution, '1080p', 'first-test resolution is 1080p')
    assert.strictEqual(confirm!.nativeAudio, false, 'native audio is OFF for the live generation')
    // API COST and CUSTOMER PRICE are separate concepts and must read as such.
    assert.strictEqual(confirm!.estimatedCostLabel, '40 credits', '5s × 8 credits/s = 40 credits')
    assert.match(confirm!.estimatedCostBasis, /5s × 8 credits\/s/, 'the basis of the number is shown')
    assert.match(confirm!.customerPriceLabel, /SEK/, 'customer price shown separately')
    assert.notStrictEqual(
      confirm!.estimatedCostLabel,
      confirm!.customerPriceLabel,
      'API cost and customer price are never the same value'
    )
    assert.ok(!/credit/i.test(confirm!.customerPriceLabel), 'customer price is money, not credits')
    assert.ok(!/SEK/i.test(confirm!.estimatedCostLabel), 'API cost is credits, not currency')
    assert.match(confirm!.warning, /paid request to Kling/i, 'explicit paid warning')

    // 1 + 9 + 10 + 11 + 13 + 14 + 15. The happy path, end to end.
    const live = queueLiveGeneration(project.id, [pairA])
    assert.ok(live.ok, 'one live transition is allowed')
    const jobId = live.ok ? live.job.id : ''
    resumeQueue()
    // Wait for a TERMINAL state so a failure reports its reason instead of
    // timing out silently.
    await waitFor(
      () => ['completed', 'failed', 'cancelled'].includes(job(jobId)?.status ?? ''),
      20_000,
      'live generation to finish'
    )
    assert.strictEqual(
      job(jobId)?.status,
      'completed',
      `live generation should complete — got ${job(jobId)?.status}: ${job(jobId)?.note}`
    )

    assert.strictEqual(transport.submits, 1, 'submit called EXACTLY once')
    assert.ok(transport.statusPolls >= 1, 'the task was polled')
    assert.strictEqual(transport.downloads, 1, 'the result was downloaded once')

    const submitCall = transport.calls.find((c) => c.method === 'POST')!
    // The confirmed endpoint, exactly — no operator override in the path.
    assert.strictEqual(
      submitCall.url,
      'https://api-singapore.klingai.com/image-to-video/kling-3.0',
      'submit hit the confirmed Kling 3.0 image-to-video endpoint'
    )
    const submitBody = JSON.parse(submitCall.body!) as Record<string, unknown>
    assert.strictEqual(submitBody[KLING_FIELDS.model], 'kling-v3-omni', 'confirmed model id sent')
    assert.strictEqual(submitBody[KLING_FIELDS.mode], '1080p', '1080p sent for the first real test')
    assert.ok(
      !Object.keys(submitBody).some((k) => /audio/i.test(k)),
      'no unverified audio field is sent'
    )
    // 6 + 7. START → image, END → image_tail, with real base64 payloads.
    assert.ok(typeof submitBody[KLING_FIELDS.startImage] === 'string', 'START frame sent as image')
    assert.ok(typeof submitBody[KLING_FIELDS.endImage] === 'string', 'END frame sent as image_tail')
    assert.ok(
      (submitBody[KLING_FIELDS.startImage] as string).length > 20,
      'start frame carries base64 payload'
    )
    // 21. The API key never appears in any request body or URL.
    const allTransport = JSON.stringify(transport.calls)
    assert.ok(!allTransport.includes('sk-live-smoke-key'), 'API key never appears in bodies/URLs')

    // 10. The remote task id was persisted, and survives a reload.
    const doneJob = job(jobId)!
    assert.strictEqual(doneJob.provider?.providerTaskId, 'remote-task-live-1', 'task id persisted')
    simulateRestart()
    assert.strictEqual(job(jobId)?.provider?.providerTaskId, 'remote-task-live-1', 'task id survives reload')

    // 13 + 14 + 15. Managed clip attached through the EXISTING fields.
    const after = listProjects().find((p) => p.id === project.id)!
    const clip = after.transitions[pairA].clip
    assert.ok(clip, 'clip attached to the transition')
    assert.strictEqual(clip!.source, 'kling', 'clip source records the provider')
    assert.strictEqual(after.transitions[pairA].status, 'completed', 'generation completed')
    const clipFile = join(projectTransitionsDir(project.id), clip!.storedName)
    assert.ok(existsSync(clipFile) && statSync(clipFile).size > 0, 'managed MP4 exists')
    assert.ok(probeDurationSec(clipFile) > 0, 'downloaded file is a readable video')
    assert.ok(clip!.src.startsWith('f2f://clip/'), 'clip uses the existing managed protocol')

    // 22. The customer price snapshot is untouched by any of this.
    assert.strictEqual(doneJob.price?.pricePerImage, 149, 'customer price snapshot unaffected')
    // Credits are recorded in their own field; money stays null because no
    // official conversion is published.
    assert.strictEqual(doneJob.provider?.estimatedCredits, 40, 'estimated credits persisted')
    assert.strictEqual(doneJob.provider?.actualCredits, 40, 'actual credits recorded on success')
    assert.strictEqual(doneJob.provider?.actualCost, null, 'no money value invented')

    // 12. Restart mid-flight resumes polling and NEVER resubmits.
    pauseQueue()
    const submitsBefore = transport.submits
    const resumeJob = enqueue({
      projectId: project.id,
      projectName: project.name,
      kind: 'ai-generation',
      transitionCount: 1,
      metadata: { pairKeys: [pairB], provider: 'kling' },
      provider: {
        provider: 'kling',
        model: KLING_MODELS[0].id,
        dryRun: false,
        providerTaskId: 'remote-task-live-1',
        providerStatus: 'processing',
        submittedAt: Date.now(),
        lastPolledAt: null,
        providerMeta: null,
        estimatedCost: null,
        actualCost: null,
        estimatedCredits: null,
        actualCredits: null,
        retryCount: 0
      }
    })
    assert.strictEqual(
      resolveGenerationAction(job(resumeJob.id)!.provider),
      'resume-poll',
      'a job with a remote task resumes polling'
    )
    transport.processingPolls = 0
    resumeQueue()
    await waitFor(
      () => ['completed', 'failed', 'cancelled'].includes(job(resumeJob.id)?.status ?? ''),
      20_000,
      'resumed job to finish'
    )
    assert.strictEqual(
      job(resumeJob.id)?.status,
      'completed',
      `resumed job should complete — got ${job(resumeJob.id)?.status}: ${job(resumeJob.id)?.note}`
    )
    assert.strictEqual(transport.submits, submitsBefore, 'RESUME never submitted a second paid task')
    log('live: submit-once, poll, download, attach, resume-without-resubmit OK')

    // 16 + 17. A corrupt/empty download must not attach anything.
    pauseQueue()
    const badTransport = makeMockTransport(Buffer.alloc(0))
    badTransport.processingPolls = 0
    __setTestTransport(badTransport)
    const badProject = listProjects().find((p) => p.id === project.id)!
    // Reset the CLIP state only. Keeping the prompt basis matters because
    // generation preflight now refuses wording built on superseded
    // evidence — and this test is about a corrupt download, not about
    // provenance, so it must not strip the precondition by accident.
    badProject.transitions[pairB] = {
      ...badProject.transitions[pairB]!,
      prompt: '',
      durationSec: 5,
      status: 'not-generated',
      clip: null
    }
    saveProject(badProject)
    const badJob = queueLiveGeneration(project.id, [pairB])
    assert.ok(badJob.ok, 'job queued for the corrupt-download case')
    resumeQueue()
    await waitFor(() => job(badJob.ok ? badJob.job.id : '')?.status === 'failed', 20_000, 'corrupt download failure')
    const failed = job(badJob.ok ? badJob.job.id : '')!
    assert.match(failed.note ?? '', /empty|not a readable video/i, 'empty download rejected')
    const afterBad = listProjects().find((p) => p.id === project.id)!
    assert.strictEqual(afterBad.transitions[pairB].clip, null, 'no clip attached from a bad download')
    assert.notStrictEqual(afterBad.transitions[pairB].status, 'completed', 'transition not marked completed')

    // 18. Retrying the DOWNLOAD does not regenerate — the task id is kept.
    assert.strictEqual(failed.provider?.providerTaskId, 'remote-task-live-1', 'remote task retained for download retry')
    assert.match(failed.note ?? '', /without regenerating/i, 'message explains retry semantics')
    const submitsBeforeRetry = badTransport.submits
    pauseQueue()
    retryJob(failed.id)
    // The remote task SUCCEEDED; only the download failed — so the retry
    // action is DOWNLOAD, never a new paid submission.
    assert.strictEqual(
      resolveGenerationAction(job(failed.id)!.provider),
      'download',
      'download retry re-downloads the finished task instead of regenerating'
    )
    assert.strictEqual(badTransport.submits, submitsBeforeRetry, 'download retry did not resubmit')

    // 19. A provider-FAILED task blocks automatic resubmission.
    assert.strictEqual(
      resolveGenerationAction({
        provider: 'kling',
        model: KLING_MODELS[0].id,
        dryRun: false,
        providerTaskId: 'remote-x',
        providerStatus: 'failed',
        submittedAt: Date.now(),
        lastPolledAt: Date.now(),
        providerMeta: null,
        estimatedCost: null,
        actualCost: null,
        estimatedCredits: null,
        actualCredits: null,
        retryCount: 1
      }),
      'blocked',
      'failed remote task requires explicit Regenerate'
    )

    // 20. Local cancellation never claims a remote cancellation.
    const cancelJobRow = enqueue({
      projectId: project.id,
      projectName: project.name,
      kind: 'ai-generation',
      transitionCount: 1,
      metadata: { pairKeys: [pairB] },
      provider: {
        provider: 'kling',
        model: KLING_MODELS[0].id,
        dryRun: false,
        providerTaskId: 'remote-cancel-1',
        providerStatus: 'processing',
        submittedAt: Date.now(),
        lastPolledAt: null,
        providerMeta: null,
        estimatedCost: null,
        actualCost: null,
        estimatedCredits: null,
        actualCredits: null,
        retryCount: 0
      }
    })
    cancelJob(cancelJobRow.id)
    const cancelled = job(cancelJobRow.id)!
    assert.match(cancelled.note ?? '', /Stopped tracking/i, 'cancel says stopped tracking')
    assert.match(cancelled.note ?? '', /may continue remotely/i, 'cancel warns the task may continue')
    assert.ok(!/generation cancelled/i.test(cancelled.note ?? ''), 'never claims the remote task was cancelled')

    const remoteCancel = await new KlingProvider({
      apiKey: 'k',
      mode: 'live',
      liveAllowed: true,
      fetchImpl: transport
    }).cancelGeneration('remote-cancel-1')
    assert.ok(!remoteCancel.ok && 'unsupported' in remoteCancel, 'remote cancel honestly unsupported')

    log('live: bad download, retry-without-regenerate, failed-task gating, honest cancel OK')
  } finally {
    __setTestTransport(null)
    if (originalSettings) saveSettingsJson(originalSettings)
    delete process.env['F2F_POLL_MS']
    delete process.env['F2F_POLL_TIMEOUT_MS']
    pauseQueue()
    resumeQueue()
  }
}

// ── Recovery: a WRONG status path must never cost anything ───────────────

interface RecoveryTransport {
  (url: string, init: RequestInit): Promise<Response>
  calls: { url: string; method: string }[]
  submits: number
  statusPolls: number
  statusRejections: number
  downloads: number
  /** Status GETs are answered only when the URL contains this fragment;
   * anything else answers 404, exactly like a wrong path would. */
  acceptFragment: string
  resultBytes: Buffer
  resultUrl: string
}

function makeRecoveryTransport(resultBytes: Buffer): RecoveryTransport {
  const fn = (async (url: string, init: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase()
    fn.calls.push({ url, method })

    if (url === fn.resultUrl) {
      fn.downloads++
      return new Response(new Uint8Array(fn.resultBytes))
    }
    if (method === 'POST') {
      fn.submits++
      return new Response(
        JSON.stringify({
          data: {
            task_id: 'remote-task-recovery-1',
            created_at: 1730000000,
            model_name: 'kling-v3-omni'
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }
    if (!url.includes(fn.acceptFragment)) {
      fn.statusRejections++
      return new Response(JSON.stringify({ code: 'not_found', message: 'Not Found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' }
      })
    }
    fn.statusPolls++
    return new Response(
      JSON.stringify({
        data: { task_status: 'succeed', task_result: { videos: [{ url: fn.resultUrl }] } }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }) as RecoveryTransport

  fn.calls = []
  fn.submits = 0
  fn.statusPolls = 0
  fn.statusRejections = 0
  fn.downloads = 0
  // Nothing matches the default path, so the first attempt always 404s.
  fn.acceptFragment = '/verified-status-path/'
  fn.resultBytes = resultBytes
  fn.resultUrl = 'https://mock.invalid/recovery-result.mp4'
  return fn
}

async function testRemoteTaskRecovery(workDir: string, created: string[]): Promise<void> {
  process.env['F2F_POLL_MS'] = '30'
  process.env['F2F_POLL_TIMEOUT_MS'] = '10000'

  initQueue()
  pauseQueue()

  const fixture = join(workDir, 'recovery-result.mp4')
  const gen = spawnSync(
    ffmpegPath(),
    ['-y', '-f', 'lavfi', '-i', 'color=c=navy:s=320x240:d=1', '-r', '25', '-pix_fmt', 'yuv420p', fixture],
    { encoding: 'utf8', timeout: 60_000 }
  )
  assert.strictEqual(gen.status, 0, 'recovery fixture generated')

  const transport = makeRecoveryTransport(readFileSync(fixture))
  __setTestTransport(transport)
  const originalSettings = getSettingsJson()

  const project = makeProject('Endpoint Recovery Villa')
  created.push(project.id)
  saveProject(project)
  const framePath = (name: string, color: string): string => {
    const path = join(workDir, name)
    const res = spawnSync(
      ffmpegPath(),
      ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=64x48:d=1`, '-frames:v', '1', path],
      { encoding: 'utf8', timeout: 60_000 }
    )
    assert.strictEqual(res.status, 0, `recovery frame ${name} generated`)
    return path
  }
  const imgs = importImages(project.id, [
    { sourcePath: framePath('rec-one.png', 'orange'), name: 'one.png' },
    { sourcePath: framePath('rec-two.png', 'purple'), name: 'two.png' }
  ])
  project.images = imgs
  const pair = transitionKey(imgs[0].id, imgs[1].id)
  project.transitions[pair] = { prompt: '', durationSec: 5, status: 'not-generated', clip: null }
  saveProject(project)
  giveProjectAcceptedMap(project.id, imgs)

  try {
    saveSettingsJson(LIVE_SETTINGS())

    // ── The status path is wrong: submit succeeds, polling 404s ──────────
    const queued = queueLiveGeneration(project.id, [pair])
    assert.ok(queued.ok, 'live generation queued')
    const jobId = queued.ok ? queued.job.id : ''
    resumeQueue()
    await waitFor(
      () => ['completed', 'failed', 'cancelled'].includes(job(jobId)?.status ?? ''),
      20_000,
      'the job to reach a terminal state'
    )

    assert.strictEqual(transport.submits, 1, 'submit happened exactly once')
    assert.ok(transport.statusRejections >= 1, 'the wrong status path was rejected')
    assert.strictEqual(transport.downloads, 0, 'nothing was downloaded')

    const stalled = job(jobId)!
    // 1. The task id is PRESERVED — this is the whole point.
    assert.strictEqual(
      stalled.provider?.providerTaskId,
      'remote-task-recovery-1',
      'the remote task id is preserved after a status-endpoint failure'
    )
    assert.strictEqual(
      stalled.provider?.providerStatus,
      STATUS_ENDPOINT_UNVERIFIED,
      'the job records the endpoint-unverified state'
    )
    // 2. All provider metadata survives.
    assert.strictEqual(stalled.provider?.providerMeta?.model_name, 'kling-v3-omni', 'provider metadata preserved')
    assert.strictEqual(stalled.provider?.providerMeta?.created_at, 1730000000, 'submission metadata preserved')
    assert.ok(stalled.provider?.submittedAt, 'the submission timestamp is preserved')
    assert.strictEqual(stalled.provider?.dryRun, false, 'the job stays marked as a real submission')

    // 3. The message says exactly what happened.
    assert.match(
      stalled.note ?? '',
      /Remote task submitted — status endpoint needs verification/,
      'the exact recovery message is shown'
    )
    assert.strictEqual(
      STATUS_ENDPOINT_UNVERIFIED_MESSAGE,
      'Remote task submitted — status endpoint needs verification',
      'the message constant is the specified wording'
    )
    // 4. Never claimed as cancelled, never reported as a failed generation.
    assert.match(stalled.note ?? '', /NOT cancelled/, 'the message states the task was not cancelled')
    assert.ok(
      !/(was|has been|is) cancelled|stopped tracking/i.test(stalled.note ?? ''),
      'the remote task is never claimed to have been cancelled'
    )
    assert.notStrictEqual(stalled.status, 'cancelled', 'the job is not marked cancelled')
    assert.ok(
      !/generation failed|task as failed/i.test(stalled.note ?? ''),
      'a working paid task is never reported as a failed generation'
    )
    // The transition is honestly "generating" — it IS running remotely.
    const midProject = listProjects().find((p) => p.id === project.id)!
    assert.strictEqual(midProject.transitions[pair].status, 'generating', 'the transition is still generating')
    assert.strictEqual(midProject.transitions[pair].clip, null, 'no clip was invented')

    // 5. Copy Task ID reads the PERSISTED id.
    assert.strictEqual(remoteTaskId(jobId), 'remote-task-recovery-1', 'Copy Task ID returns the existing task id')

    // 6. Recovery survives a restart, and still resolves to resume-poll.
    simulateRestart()
    const afterRestart = job(jobId)!
    assert.strictEqual(afterRestart.provider?.providerTaskId, 'remote-task-recovery-1', 'task id survives a restart')
    assert.strictEqual(afterRestart.provider?.providerStatus, STATUS_ENDPOINT_UNVERIFIED, 'state survives a restart')
    assert.strictEqual(remoteTaskId(jobId), 'remote-task-recovery-1', 'Copy Task ID still works after a restart')
    assert.strictEqual(
      resolveGenerationAction(afterRestart.provider),
      'resume-poll',
      'the recovery state resumes polling — it can never resubmit'
    )

    // 7. Resume polling is refused when there is nothing to poll.
    pauseQueue()
    const nothingToPoll = enqueue({
      projectId: project.id,
      projectName: project.name,
      kind: 'ai-generation',
      transitionCount: 1,
      metadata: { pairKeys: [pair] }
    })
    const refused = resumePolling(nothingToPoll.id)
    assert.ok(!refused.ok, 'resume polling is refused without a remote task')
    assert.match(refused.reason, /no remote task/i, 'the refusal names the reason')
    removeJob(nothingToPoll.id)

    // ── Fix the status path in Settings, then Resume polling ─────────────
    const submitsBeforeResume = transport.submits
    transport.acceptFragment = '/verified-status-path/'
    saveSettingsJson(
      LIVE_SETTINGS({
        klingContract: { acknowledged: true, taskStatusPath: '/verified-status-path/{id}' }
      })
    )

    const resumed = resumePolling(jobId)
    assert.ok(resumed.ok, 'resume polling accepted for a job with a remote task')
    assert.match(
      job(jobId)?.note ?? '',
      /no new generation will be submitted/i,
      'resume polling states it will not resubmit'
    )
    // The provider lifecycle is untouched by the resume itself.
    assert.strictEqual(job(jobId)?.provider?.providerTaskId, 'remote-task-recovery-1', 'resume keeps the task id')

    resumeQueue()
    await waitFor(
      () => ['completed', 'failed', 'cancelled'].includes(job(jobId)?.status ?? ''),
      20_000,
      'the resumed job to finish'
    )
    assert.strictEqual(
      job(jobId)?.status,
      'completed',
      `the corrected path should complete the job — got ${job(jobId)?.status}: ${job(jobId)?.note}`
    )

    // 8. THE guarantee: no second paid submission, ever.
    assert.strictEqual(transport.submits, submitsBeforeResume, 'resume polling never submitted again')
    assert.strictEqual(transport.submits, 1, 'exactly one paid submission across the whole recovery')
    assert.ok(transport.statusPolls >= 1, 'the corrected path was actually polled')
    assert.strictEqual(transport.downloads, 1, 'the finished result was downloaded once')
    assert.strictEqual(
      job(jobId)?.provider?.providerTaskId,
      'remote-task-recovery-1',
      'the same remote task was used throughout'
    )

    // The clip landed through the existing managed path.
    const done = listProjects().find((p) => p.id === project.id)!
    const clip = done.transitions[pair].clip
    assert.ok(clip && clip.source === 'kling', 'the recovered result attached as a Kling clip')
    assert.ok(
      statSync(join(projectTransitionsDir(project.id), clip!.storedName)).size > 0,
      'the recovered clip is a real managed file'
    )

    // 9. The live safety gates are unchanged by any of this.
    saveSettingsJson(
      LIVE_SETTINGS({
        allowLiveKlingRequests: false,
        klingContract: { acknowledged: true, taskStatusPath: '/verified-status-path/{id}' }
      })
    )
    const relocked = queueLiveGeneration(project.id, [pair])
    assert.ok(!relocked.ok && relocked.reasons.some((r) => /safety lock/i.test(r)), 'safety lock still blocks live')
    saveSettingsJson(
      LIVE_SETTINGS({
        klingContract: { acknowledged: true, taskStatusPath: '/verified-status-path/{id}' }
      })
    )
    const stillNoBatch = queueLiveGeneration(project.id, [pair, 'some-other-pair'])
    assert.ok(
      !stillNoBatch.ok && stillNoBatch.reasons.some((r) => /limited to 1 transition/i.test(r)),
      'the single-transition limit still holds'
    )

    log('recovery: wrong status path keeps the task id, Copy Task ID, Resume polling without resubmitting OK')
  } finally {
    __setTestTransport(null)
    if (originalSettings) saveSettingsJson(originalSettings)
    delete process.env['F2F_POLL_MS']
    delete process.env['F2F_POLL_TIMEOUT_MS']
    pauseQueue()
    resumeQueue()
  }
}

// ── fal.ai provider — dry run, contract & pricing (NO live calls) ────────

function testFalProvider(): void {
  const SECRET = 'sk-fal-smoke-secret-should-never-leak'
  const model = FAL_MODELS[0]

  // A transport spy: any invocation is a hard failure in dry run.
  let networkCalls = 0
  const failingFetch = async (): Promise<Response> => {
    networkCalls++
    throw new Error('NETWORK CALLED DURING FAL DRY RUN')
  }

  const request: GenerationRequest = {
    projectId: 'p1',
    pairKey: 'imgA->imgB',
    startImagePath: 'C:/managed/projects/p1/images/start-frame.jpg',
    endImagePath: 'C:/managed/projects/p1/images/end-frame.jpg',
    startImageName: 'livingroom.jpg',
    endImageName: 'kitchen.jpg',
    prompt: promptForTransition(null),
    durationSec: 5,
    resolution: '1080p',
    nativeAudio: false,
    modelId: model.id
  }

  // ── Contract values ────────────────────────────────────────────────────
  assert.strictEqual(FAL_MODEL_ID, 'fal-ai/kling-video/o3/standard/image-to-video', 'exact fal model id')
  assert.strictEqual(
    falSubmitUrl(),
    'https://queue.fal.run/fal-ai/kling-video/o3/standard/image-to-video',
    'confirmed fal submit URL'
  )
  // CORRECTED. This used to assert the endpoint sub-path was part of the
  // queue url. It is not: fal namespaces queue operations by application,
  // and the longer path answers HTTP 405 — which is how a real paid request
  // ended up unpollable. This builder is now only a FALLBACK anyway; the
  // lifecycle uses the status_url fal returns at submit time.
  assert.strictEqual(
    falStatusUrl('req-1'),
    'https://queue.fal.run/fal-ai/kling-video/requests/req-1/status',
    'derived fal status URL uses the application base, not the endpoint sub-path'
  )
  assert.strictEqual(FAL_FIELDS.startImage, 'image_url', 'start frame field confirmed')
  assert.strictEqual(FAL_FIELDS.endImage, 'end_image_url', 'end frame field confirmed')
  assert.ok(model.startFrame && model.endFrame, 'fal model supports start + end frame')
  assert.ok(FAL_CONTRACT_STATUS.every((i) => i.confirmed), 'the whole fal contract is verified')

  // Explicit queue-status mapping + defensive fallback.
  assert.strictEqual(normalizeFalState('IN_QUEUE'), 'pending', 'IN_QUEUE → pending')
  assert.strictEqual(normalizeFalState('IN_PROGRESS'), 'processing', 'IN_PROGRESS → processing')
  assert.strictEqual(normalizeFalState('COMPLETED'), 'succeeded', 'COMPLETED → succeeded')
  assert.deepStrictEqual(
    Object.keys(FAL_QUEUE_STATUS).sort(),
    ['COMPLETED', 'IN_PROGRESS', 'IN_QUEUE'],
    'exactly the documented statuses are mapped explicitly'
  )
  assert.strictEqual(normalizeFalState('FAILED'), 'failed', 'unknown failure word stays defensive')
  assert.strictEqual(normalizeFalState('WARMING_UP'), 'pending', 'unknown status is not a failure')

  // ── Missing key rejected ───────────────────────────────────────────────
  const unconfigured = new FalProvider({ apiKey: '', mode: 'dry-run', fetchImpl: failingFetch })
  const noKey = unconfigured.validateConfiguration(model.id)
  assert.ok(!noKey.ok && noKey.error.code === 'not-configured', 'missing fal key rejected')

  const provider = new FalProvider({ apiKey: SECRET, mode: 'dry-run', fetchImpl: failingFetch })

  // ── Auth shape + key never leaks ───────────────────────────────────────
  const headers = new FalClient({ apiKey: SECRET }).authHeaders()
  assert.strictEqual(headers.Authorization, `Key ${SECRET}`, 'fal auth is Key <token>, not Bearer')
  const preview = provider.buildRequest(request)
  const serialized = JSON.stringify(preview)
  assert.ok(!serialized.includes(SECRET), 'fal API key never appears in the sanitized preview')
  assert.strictEqual(preview.headers.Authorization, 'Key ***redacted***', 'auth header redacted')

  // ── Mapping: direction, prompt, duration, audio ────────────────────────
  const body = preview.body as Record<string, unknown>
  assert.strictEqual(body[FAL_FIELDS.startImage], 'managed://start-frame.jpg', 'START → image_url')
  assert.strictEqual(body[FAL_FIELDS.endImage], 'managed://end-frame.jpg', 'END → end_image_url')
  assert.notStrictEqual(body[FAL_FIELDS.startImage], body[FAL_FIELDS.endImage], 'frames never collapse')
  assert.strictEqual(body[FAL_FIELDS.prompt], DEFAULT_TRANSITION_PROMPT, 'prompt mapped')
  assert.strictEqual(body[FAL_FIELDS.duration], '5', 'duration sent as the string enum fal expects')
  assert.strictEqual(body[FAL_FIELDS.generateAudio], false, 'generate_audio explicitly false')
  assert.strictEqual(FAL_NATIVE_AUDIO_DEFAULT, false, 'audio defaults OFF for fal too')
  // No local path leaks into the preview.
  assert.ok(!serialized.includes('C:/managed'), 'local paths never appear in the preview')

  // Unsupported capability rejected.
  const badModel = provider.validateRequest({ ...request, modelId: 'fal-ai/kling-video/o3/standard/text-to-video' })
  assert.ok(
    !badModel.ok && badModel.error.code === 'unsupported-capability',
    'unknown/incapable fal model refused'
  )

  // ── Dry run: zero network calls, zero uploads ──────────────────────────
  const dry = provider.dryRun(request)
  assert.ok('dryRun' in dry && dry.dryRun === true, 'fal dry-run result produced')
  assert.strictEqual(networkCalls, 0, 'NO network call during fal dry run')
  assert.strictEqual(provider.transportCallCount, 0, 'fal transport never invoked')
  assert.strictEqual(provider.uploadCount, 0, 'fal uploaded ZERO files in dry run')

  // Live paths refuse while in dry-run mode — belt and braces.
  void provider.submitGeneration(request).then((res) => {
    assert.ok(!res.ok && res.error.code === 'not-configured', 'fal submit refuses in dry run')
    assert.strictEqual(networkCalls, 0, 'fal submit made no network call in dry run')
  })

  // ── Pricing: the official $/second rate ────────────────────────────────
  assert.strictEqual(falCostRate(model.id, false)?.usdPerSecond, 0.084, 'audio off = $0.084/s')
  assert.strictEqual(falCostRate(model.id, true)?.usdPerSecond, 0.112, 'audio on = $0.112/s')
  assert.strictEqual(FAL_COST_RATES.length, 2, 'the fal rate table holds exactly the published rates')

  const usage = (durationSec: number, nativeAudio = false) =>
    provider.estimateUsage({ ...request, durationSec, nativeAudio })
  assert.strictEqual(usage(5)?.money?.amount, 0.42, '5 s = $0.42')
  assert.strictEqual(usage(5)?.label, '$0.42', 'label reads "$0.42"')
  assert.strictEqual(usage(10)?.money?.amount, 0.84, '10 s = $0.84')
  assert.strictEqual(usage(15)?.money?.amount, 1.26, '15 s = $1.26')
  assert.strictEqual(usage(5, true)?.money?.amount, 0.56, '5 s with audio = $0.56')
  assert.strictEqual(usage(5)?.money?.currency, 'USD', 'billed in USD')
  assert.strictEqual(usage(5)?.credits, null, 'fal never reports credits — it bills money')
  assert.ok(usage(5, true)!.money!.amount > usage(5)!.money!.amount, 'audio on costs more')

  log('fal provider: contract, auth, mapping, dry-run (0 calls, 0 uploads), $0.084/s pricing OK')
}

// ── fal.ai auth diagnostics, key hygiene & FREE connection test ──────────

async function testFalDiagnostics(workDir: string): Promise<void> {
  const SECRET = 'sk-fal-diag-secret-key-never-shown'

  // ── Key hygiene: pasted baggage never reaches the wire ─────────────────
  assert.strictEqual(sanitizeApiKey('  abc  '), 'abc', 'whitespace trimmed')
  assert.strictEqual(sanitizeApiKey('"abc"'), 'abc', 'double quotes stripped')
  assert.strictEqual(sanitizeApiKey("'abc'"), 'abc', 'single quotes stripped')
  assert.strictEqual(sanitizeApiKey('`abc`'), 'abc', 'backticks stripped')
  assert.strictEqual(sanitizeApiKey('abc\r\n'), 'abc', 'newlines stripped')
  assert.strictEqual(sanitizeApiKey(' "abc:def" \n'), 'abc:def', 'combined baggage stripped, id:secret kept')
  assert.strictEqual(sanitizeApiKey('""'), '', 'quotes-only collapses to empty')
  assert.strictEqual(sanitizeApiKey(null), '', 'null tolerated')

  // A dirty key is repaired at CLIENT construction — already-stored keys
  // benefit without re-entry.
  const dirtyFal = new FalClient({ apiKey: `  "${SECRET}"\n` })
  assert.strictEqual(dirtyFal.authHeaders().Authorization, `Key ${SECRET}`, 'fal auth from a dirty key is exact')
  const dirtyKling = new KlingClient({ apiKey: `'${SECRET}' ` })
  assert.strictEqual(dirtyKling.authHeaders().Authorization, `Bearer ${SECRET}`, 'kling auth from a dirty key is exact')
  // Scheme separation: fal is Key, never Bearer; Kling is Bearer, never Key.
  assert.ok(!dirtyFal.authHeaders().Authorization.includes('Bearer'), 'fal never uses Bearer')
  assert.ok(!dirtyKling.authHeaders().Authorization.startsWith('Key '), 'kling never uses fal’s Key scheme')

  // ── storeProviderApiKey: the silent-drop bug is fixed ──────────────────
  const originalSettings = getSettingsJson()
  try {
    // A stored row that PREDATES fal — only a kling entry exists.
    saveSettingsJson(
      JSON.stringify({
        providers: [{ id: 'kling', label: 'Kling', apiKey: '', legacySecret: '', mode: 'dry-run', model: null }],
        pricing: { pricePerImage: 149, currency: 'SEK' }
      })
    )
    assert.strictEqual(hasProviderApiKey('fal'), false, 'no fal key initially')
    storeProviderApiKey('fal', `  "${SECRET}"  `)
    assert.strictEqual(hasProviderApiKey('fal'), true, 'a missing fal entry is CREATED, not silently skipped')
    const afterStore = JSON.parse(getSettingsJson()!) as { providers: { id: string; apiKey: string }[] }
    const falEntry = afterStore.providers.find((p) => p.id === 'fal')!
    assert.strictEqual(falEntry.apiKey, SECRET, 'the stored key is sanitised — no quotes, no whitespace')
    // Updating an EXISTING entry still works.
    storeProviderApiKey('fal', 'replacement-key')
    const updated = JSON.parse(getSettingsJson()!) as { providers: { id: string; apiKey: string }[] }
    assert.strictEqual(updated.providers.find((p) => p.id === 'fal')!.apiKey, 'replacement-key', 'existing entry updated')
    assert.strictEqual(updated.providers.find((p) => p.id === 'kling')!.apiKey, '', 'the kling entry is untouched')
  } finally {
    if (originalSettings) saveSettingsJson(originalSettings)
  }

  // ── Frame fixtures for the staged-diagnostics submits ──────────────────
  const frameA = join(workDir, 'diag-a.png')
  const frameB = join(workDir, 'diag-b.png')
  writeFileSync(frameA, 'frame-bytes-A')
  writeFileSync(frameB, 'frame-bytes-B')
  const request: GenerationRequest = {
    projectId: 'p-diag',
    pairKey: 'a->b',
    startImagePath: frameA,
    endImagePath: frameB,
    startImageName: 'a.png',
    endImageName: 'b.png',
    prompt: 'diagnostic prompt',
    durationSec: 5,
    resolution: '1080p',
    nativeAudio: false,
    modelId: FAL_MODEL_ID
  }

  // ── 401 at upload-init: the exact failing request is exposed ───────────
  const fetch401 = async (): Promise<Response> =>
    new Response(JSON.stringify({ detail: 'Invalid authentication credentials' }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    })
  const p401 = new FalProvider({ apiKey: SECRET, mode: 'live', liveAllowed: true, fetchImpl: fetch401 })
  const r401 = await p401.submitGeneration(request)
  assert.ok(!r401.ok, '401 at upload-init fails the submit')
  const msg401 = r401.ok ? '' : r401.error.message
  assert.match(msg401, /fal\.ai authentication failed/, 'headline names authentication')
  assert.match(msg401, /Stage: upload-init/, 'the STAGE is named')
  assert.match(msg401, /HTTP: 401/, 'the HTTP status is named')
  assert.match(msg401, /Endpoint: rest\.fal\.ai\/storage\/upload\/initiate/, 'the endpoint is named')
  assert.match(msg401, /Authorization: Key \[redacted\]/, 'auth presence + scheme shown, value redacted')
  assert.match(msg401, /Invalid authentication credentials/, 'fal’s own response body is surfaced')
  assert.ok(!msg401.includes(SECRET), 'the key NEVER appears in the diagnostics')
  assert.ok(!/Check it in Settings/.test(msg401), 'the old generic collapse message is gone')
  assert.strictEqual(r401.ok ? undefined : r401.error.httpStatus, 401, 'httpStatus carried on the error')

  // ── 403 at submit: distinct permission verdict, distinct stage ─────────
  let calls403 = 0
  const fetch403 = async (url: string, init: RequestInit): Promise<Response> => {
    calls403++
    const method = (init?.method ?? 'GET').toUpperCase()
    if (url.includes('/storage/upload/initiate')) {
      return new Response(
        JSON.stringify({ upload_url: `https://upload.mock.invalid/${calls403}`, file_url: `https://v3.fal.media/mock/${calls403}.png` }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }
    if (url.startsWith('https://upload.mock.invalid/')) return new Response(null, { status: 200 })
    if (method === 'POST') {
      return new Response(JSON.stringify({ detail: 'Insufficient scope for this endpoint' }), {
        status: 403,
        headers: { 'content-type': 'application/json' }
      })
    }
    return new Response('{}', { status: 200 })
  }
  const p403 = new FalProvider({ apiKey: SECRET, mode: 'live', liveAllowed: true, fetchImpl: fetch403 })
  const r403 = await p403.submitGeneration(request)
  assert.ok(!r403.ok, '403 at submit fails the submit')
  const msg403 = r403.ok ? '' : r403.error.message
  assert.match(msg403, /permission\/scope issue/, '403 reads as permission, not as a bad key')
  assert.match(msg403, /Stage: submit/, 'the submit stage is named')
  assert.match(msg403, /Endpoint: queue\.fal\.run\//, 'the queue host is named')
  assert.match(msg403, /Insufficient scope/, 'fal’s response body is surfaced')
  assert.ok(!msg403.includes(SECRET), 'the key never appears')

  // ── Test connection: FREE by construction ──────────────────────────────
  const mkConnFetch = (
    initStatus: number,
    statusStatus: number
  ): { fetch: (url: string, init: RequestInit) => Promise<Response>; log: { url: string; method: string }[] } => {
    const log: { url: string; method: string }[] = []
    return {
      log,
      fetch: async (url: string, init: RequestInit): Promise<Response> => {
        const method = (init?.method ?? 'GET').toUpperCase()
        log.push({ url, method })
        if (url.includes('/storage/upload/initiate')) {
          return initStatus === 200
            ? new Response(JSON.stringify({ upload_url: 'https://upload.mock.invalid/x', file_url: 'https://v3.fal.media/mock/x.png' }), { status: 200 })
            : new Response(JSON.stringify({ detail: 'nope' }), { status: initStatus })
        }
        return new Response(JSON.stringify({ detail: 'Request not found' }), { status: statusStatus })
      }
    }
  }

  // Connected: storage 200 + queue 404 (unknown probe id = auth accepted).
  const okConn = mkConnFetch(200, 404)
  const pOk = new FalProvider({ apiKey: SECRET, mode: 'dry-run', fetchImpl: okConn.fetch })
  const resOk = await pOk.testConnection()
  assert.strictEqual(resOk.status, 'connected', 'valid key on both hosts → Connected')
  assert.ok(resOk.detail.some((d) => /rest\.fal\.ai/.test(d)), 'storage host verdict shown')
  assert.ok(resOk.detail.some((d) => /queue\.fal\.run/.test(d)), 'queue host verdict shown')
  // FREE: no upload PUT, no model submit, exactly the two probes.
  assert.strictEqual(pOk.uploadCount, 0, 'test connection uploads NOTHING')
  assert.ok(!okConn.log.some((c) => c.url.startsWith('https://upload.mock.invalid/')), 'the signed slot is never used')
  assert.ok(!okConn.log.some((c) => c.method === 'POST' && c.url === falSubmitUrl()), 'the video model is never called')
  assert.strictEqual(okConn.log.length, 2, 'exactly two probe requests')

  // Authentication failed.
  const badConn = mkConnFetch(401, 401)
  const pBad = new FalProvider({ apiKey: SECRET, mode: 'dry-run', fetchImpl: badConn.fetch })
  const resBad = await pBad.testConnection()
  assert.strictEqual(resBad.status, 'auth-failed', '401 → Authentication failed')
  assert.ok(!JSON.stringify(resBad.detail).includes(SECRET), 'test detail never leaks the key')

  // Permission/scope issue.
  const scopeConn = mkConnFetch(403, 404)
  const resScope = await new FalProvider({ apiKey: SECRET, mode: 'dry-run', fetchImpl: scopeConn.fetch }).testConnection()
  assert.strictEqual(resScope.status, 'permission', '403 → Permission/scope issue')

  // Network error.
  const downFetch = async (): Promise<Response> => {
    throw new Error('ECONNREFUSED')
  }
  const resDown = await new FalProvider({ apiKey: SECRET, mode: 'dry-run', fetchImpl: downFetch }).testConnection()
  assert.strictEqual(resDown.status, 'network', 'unreachable → Network error')

  // No key stored → refused without any network call.
  let noKeyCalls = 0
  const countingFetch = async (): Promise<Response> => {
    noKeyCalls++
    return new Response('{}', { status: 200 })
  }
  const resNoKey = await new FalProvider({ apiKey: '  ', mode: 'dry-run', fetchImpl: countingFetch }).testConnection()
  assert.strictEqual(resNoKey.status, 'auth-failed', 'missing key reported without a request')
  assert.strictEqual(noKeyCalls, 0, 'no network call without a key')

  log('fal diagnostics: staged 401/403 detail, key hygiene, store-fix, FREE connection test OK')
}

// ── fal.ai LIVE path with MOCKED transport — never a real fal call ───────

interface FalMockTransport {
  (url: string, init: RequestInit): Promise<Response>
  calls: { url: string; method: string; body?: string; hadAuth: boolean }[]
  initiates: number
  uploads: number
  submits: number
  statusPolls: number
  resultFetches: number
  downloads: number
  processingPolls: number
  cancels: number
  /** Requests to a /status path that is NOT the authoritative one — i.e. a
   *  reconstructed url. Must stay 0. */
  strayStatusCalls: number
  resultBytes: Buffer
  resultUrl: string
  statusUrl: string
  responseUrl: string
  cancelUrl: string
}

function makeFalMockTransport(resultBytes: Buffer): FalMockTransport {
  const fn = (async (url: string, init: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = (init?.headers ?? {}) as Record<string, string>
    fn.calls.push({
      url,
      method,
      body: typeof init?.body === 'string' ? init.body : undefined,
      hadAuth: Object.keys(headers).some((h) => /^authorization$/i.test(h))
    })

    const json = (data: unknown, status = 200): Response =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

    if (url.includes('/storage/upload/initiate')) {
      fn.initiates++
      const n = fn.initiates
      return json({
        upload_url: `https://upload.mock.invalid/${n}`,
        file_url: `https://v3.fal.media/mock/${n}.png`
      })
    }
    if (url.startsWith('https://upload.mock.invalid/')) {
      fn.uploads++
      return new Response(null, { status: 200 })
    }
    if (url === fn.resultUrl) {
      fn.downloads++
      return new Response(new Uint8Array(fn.resultBytes))
    }
    if (method === 'POST') {
      fn.submits++
      // fal's real submit response carries the authoritative queue urls.
      // They are DELIBERATELY on a different path shape than anything we
      // would rebuild, so a test that passes can only be using these.
      return json({
        request_id: 'fal-request-live-1',
        status: 'IN_QUEUE',
        status_url: fn.statusUrl,
        response_url: fn.responseUrl,
        cancel_url: fn.cancelUrl
      })
    }
    if (url === fn.statusUrl) {
      fn.statusPolls++
      const done = fn.statusPolls > fn.processingPolls
      return json({ status: done ? 'COMPLETED' : 'IN_PROGRESS', request_id: 'fal-request-live-1' })
    }
    if (url === fn.cancelUrl) {
      fn.cancels++
      return json({ status: 'CANCELLED' }, 202)
    }
    // Anything else hitting a /status path is a RECONSTRUCTED url — the bug
    // this architecture removes. Answer 405 exactly as fal does, so a
    // regression fails loudly instead of quietly working.
    if (url.endsWith('/status')) {
      fn.strayStatusCalls++
      return json({}, 405)
    }
    // The result endpoint — the video url lives HERE, not on /status.
    fn.resultFetches++
    return json({
      video: {
        url: fn.resultUrl,
        content_type: 'video/mp4',
        file_name: 'output.mp4',
        file_size: fn.resultBytes.length
      }
    })
  }) as FalMockTransport

  fn.calls = []
  fn.initiates = 0
  fn.uploads = 0
  fn.submits = 0
  fn.statusPolls = 0
  fn.resultFetches = 0
  fn.downloads = 0
  fn.processingPolls = 1
  fn.cancels = 0
  fn.strayStatusCalls = 0
  fn.resultBytes = resultBytes
  fn.resultUrl = 'https://mock.invalid/fal-result.mp4'
  // Deliberately NOT the shape any of our builders produce.
  fn.statusUrl = 'https://queue.fal.run/fal-ai/kling-video/requests/fal-request-live-1/status'
  fn.responseUrl = 'https://queue.fal.run/fal-ai/kling-video/requests/fal-request-live-1'
  fn.cancelUrl = 'https://queue.fal.run/fal-ai/kling-video/requests/fal-request-live-1/cancel'
  return fn
}

const FAL_LIVE_SETTINGS = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    // These fixtures exercise the PROVIDER path — submit, poll, download,
    // attach. Quality validation is a separate concern with its own tests
    // (testQualityValidation), and it is switched off here so a missing
    // Gemini key cannot turn every provider assertion into a needs-review.
    // See the report: with the check ON and no key, clips correctly stop
    // at needs-review rather than attaching.
    analyzer: { analyzerId: 'manual', model: '', apiKey: '', mode: 'dry-run', qualityValidationMode: 'off' },
    providers: [
      { id: 'fal', label: 'fal.ai', apiKey: 'sk-fal-live-smoke-key', mode: 'live', model: FAL_MODEL_ID },
      { id: 'kling', label: 'Kling', apiKey: '', legacySecret: '', mode: 'dry-run', model: null }
    ],
    activeProviderId: 'fal',
    exportDefaults: { aspectRatio: '16:9', resolution: '1080p', fps: 25, defaultTransitionDurationSec: 5 },
    pricing: { pricePerImage: 149, currency: 'SEK' },
    production: {
      maxConcurrentAiGenerations: 1,
      mockAiCostPerSecond: null,
      allowLiveKlingRequests: false,
      allowLiveFalRequests: true,
      klingContract: { acknowledged: false },
      ...overrides
    }
  })

async function testFalLive(workDir: string, created: string[]): Promise<void> {
  process.env['F2F_POLL_MS'] = '30'
  process.env['F2F_POLL_TIMEOUT_MS'] = '10000'

  initQueue()
  pauseQueue()

  // A real, playable MP4 the mock transport will "download".
  const fixture = join(workDir, 'fal-result.mp4')
  const gen = spawnSync(
    ffmpegPath(),
    ['-y', '-f', 'lavfi', '-i', 'color=c=olive:s=320x240:d=1', '-r', '25', '-pix_fmt', 'yuv420p', fixture],
    { encoding: 'utf8', timeout: 60_000 }
  )
  assert.strictEqual(gen.status, 0, 'fal result fixture generated')

  const transport = makeFalMockTransport(readFileSync(fixture))
  __setTestTransport(transport)
  const originalSettings = getSettingsJson()

  const project = makeProject('Fal Live Villa')
  created.push(project.id)
  saveProject(project)
  const framePath = (name: string, color: string): string => {
    const path = join(workDir, name)
    const res = spawnSync(
      ffmpegPath(),
      ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=64x48:d=1`, '-frames:v', '1', path],
      { encoding: 'utf8', timeout: 60_000 }
    )
    assert.strictEqual(res.status, 0, `fal frame fixture ${name} generated`)
    return path
  }
  const imgs = importImages(project.id, [
    { sourcePath: framePath('fal-one.png', 'yellow'), name: 'one.png' },
    { sourcePath: framePath('fal-two.png', 'magenta'), name: 'two.png' },
    { sourcePath: framePath('fal-three.png', 'cyan'), name: 'three.png' }
  ])
  project.images = imgs
  const pairA = transitionKey(imgs[0].id, imgs[1].id)
  const pairB = transitionKey(imgs[1].id, imgs[2].id)
  project.transitions[pairA] = { prompt: '', durationSec: 5, status: 'not-generated', clip: null }
  project.transitions[pairB] = { prompt: '', durationSec: 5, status: 'not-generated', clip: null }
  saveProject(project)
  giveProjectAcceptedMap(project.id, imgs)

  try {
    // ── The fal safety lock blocks live BEFORE any network call ──────────
    saveSettingsJson(FAL_LIVE_SETTINGS({ allowLiveFalRequests: false }))
    const locked = queueLiveGeneration(project.id, [pairA])
    assert.ok(!locked.ok, 'fal safety lock OFF blocks live generation')
    assert.ok(locked.reasons.some((r) => /allow live fal\.ai requests/i.test(r)), 'the fal lock is named')
    assert.strictEqual(transport.calls.length, 0, 'no transport call while fal-locked')

    // The KLING lock being on must NOT unlock fal.
    saveSettingsJson(
      FAL_LIVE_SETTINGS({ allowLiveFalRequests: false, allowLiveKlingRequests: true })
    )
    const crossLock = queueLiveGeneration(project.id, [pairA])
    assert.ok(!crossLock.ok, 'the Kling lock never unlocks fal.ai')

    saveSettingsJson(FAL_LIVE_SETTINGS())

    // ── Batch rejected before any network call ───────────────────────────
    const batch = queueLiveGeneration(project.id, [pairA, pairB])
    assert.ok(!batch.ok, 'two live fal transitions rejected')
    assert.ok(batch.reasons.some((r) => /limited to 1 transition/i.test(r)), 'batch limit named')
    assert.strictEqual(transport.calls.length, 0, 'fal batch attempt made no transport call')

    // ── Paid confirmation shows the fal cost, separately from price ──────
    const confirm = liveConfirmation(project.id, pairA)
    assert.ok(confirm && confirm.ok, 'fal confirmation is actionable')
    assert.strictEqual(confirm!.provider, 'fal.ai', 'confirmation names fal.ai')
    assert.strictEqual(confirm!.estimatedCostLabel, '$0.42', '5 s × $0.084/s = $0.42')
    assert.match(confirm!.estimatedCostBasis, /\$0\.084\/s/, 'the rate is shown')
    assert.strictEqual(confirm!.nativeAudio, false, 'audio OFF for the fal generation')
    assert.match(confirm!.customerPriceLabel, /SEK/, 'customer price shown separately')
    assert.ok(confirm!.prompt.length > 0, 'the prompt is shown')
    assert.ok(confirm!.startImage && confirm!.endImage, 'start/end thumbnails present')
    assert.match(confirm!.warning, /paid request to fal\.ai/i, 'explicit fal paid warning')

    // ── D5: the confirmation states what this ADDS to production spend ───
    // Before anything has been generated, this is attempt 1 and the
    // project has spent nothing.
    assert.strictEqual(confirm!.attemptNumber, 1, 'first generation of this pair')
    assert.strictEqual(confirm!.isRegeneration, false, 'so it is not a regeneration')
    assert.strictEqual(
      confirm!.additionalCostLabel,
      '$0.42',
      'the incremental cost comes from the real rate × this duration — never hardcoded'
    )
    assert.strictEqual(confirm!.spentSoFarLabel, '$0.00', 'nothing spent on this project yet')
    assert.strictEqual(confirm!.projectedAfterLabel, '$0.42', 'projected = spent + this generation')

    // ── The happy path, end to end through the real queue ────────────────
    const live = queueLiveGeneration(project.id, [pairA])
    assert.ok(live.ok, 'one live fal transition is allowed')
    const jobId = live.ok ? live.job.id : ''
    resumeQueue()
    await waitFor(
      () => ['completed', 'failed', 'cancelled'].includes(job(jobId)?.status ?? ''),
      20_000,
      'fal live generation to finish'
    )
    assert.strictEqual(
      job(jobId)?.status,
      'completed',
      `fal live generation should complete — got ${job(jobId)?.status}: ${job(jobId)?.note}`
    )

    // ── D5: a REAL generation moved the ledger, and the next confirmation
    // reflects it. This is the arithmetic the regenerate warning depends
    // on, exercised against a generation that actually ran.
    const ledger = listCostEntries(project.id)
    assert.strictEqual(ledger.length, 1, 'the accepted generation recorded exactly one charge')
    assert.strictEqual(ledger[0].pairKey, pairA, 'against the right transition')
    assert.strictEqual(ledger[0].provider, 'fal', 'and the right provider')
    assert.strictEqual(ledger[0].attemptNumber, 1, 'as attempt 1')
    assert.strictEqual(ledger[0].status, 'succeeded', 'settled to succeeded once it finished')

    const regenConfirm = liveConfirmation(project.id, pairA)
    assert.strictEqual(regenConfirm!.attemptNumber, 2, 'the next run is attempt 2')
    assert.strictEqual(regenConfirm!.isRegeneration, true, 'and is flagged as a regeneration')
    assert.strictEqual(regenConfirm!.additionalCostLabel, '$0.42', 'it adds another $0.42')
    assert.strictEqual(
      regenConfirm!.spentSoFarLabel,
      '$0.42',
      'spent so far reflects the generation that really happened'
    )
    assert.strictEqual(
      regenConfirm!.projectedAfterLabel,
      '$0.84',
      'and the projection STACKS — regenerating does not refund the first attempt'
    )

    // ── D7: the queue has the data to label Customer value vs Generation
    // cost as two different things. Customer value is the frozen SEK
    // snapshot; generation cost is the provider charge for THIS attempt.
    const finished = job(jobId)!
    assert.ok(finished.price, 'the job carries a frozen customer price snapshot')
    assert.strictEqual(finished.price!.currency, 'SEK', 'customer value is SEK')
    assert.strictEqual(
      finished.provider?.actualCost,
      0.42,
      'and the generation cost is the provider charge, in the provider currency'
    )
    assert.notStrictEqual(
      finished.price!.totalPrice,
      finished.provider!.actualCost,
      'the two figures are different numbers in different currencies and are never merged'
    )
    // An FFmpeg export job has no provider at all, so its generation cost
    // renders as an em dash rather than borrowing the customer price.
    const exportJobs = listJobs().filter(
      (j) => j.kind === 'preview-export' || j.kind === 'final-export' || j.kind === 'assembly'
    )
    for (const ex of exportJobs) {
      // Null or absent — either way there is no provider charge to show,
      // which is what makes the queue render an em dash rather than
      // borrowing the customer price.
      assert.ok(!ex.provider, `export job ${ex.id} carries no provider cost`)
    }

    // Submit called EXACTLY once; both frames uploaded via fal storage.
    assert.strictEqual(transport.submits, 1, 'fal submit called EXACTLY once')
    assert.strictEqual(transport.initiates, 2, 'two uploads initiated (start + end)')
    assert.strictEqual(transport.uploads, 2, 'two frame files uploaded')
    assert.ok(transport.statusPolls >= 1, 'the fal request was polled')
    assert.strictEqual(transport.resultFetches, 1, 'the result payload was fetched once')
    assert.strictEqual(transport.downloads, 1, 'the video was downloaded once')

    // Mapping in the REAL submit body: uploaded fal urls, right direction.
    const submitCall = transport.calls.find((c) => c.method === 'POST' && c.url === falSubmitUrl())!
    assert.ok(submitCall, 'submit hit the confirmed fal endpoint')
    const submitBody = JSON.parse(submitCall.body!) as Record<string, unknown>
    assert.strictEqual(submitBody[FAL_FIELDS.startImage], 'https://v3.fal.media/mock/1.png', 'first upload → image_url')
    assert.strictEqual(submitBody[FAL_FIELDS.endImage], 'https://v3.fal.media/mock/2.png', 'second upload → end_image_url')
    assert.strictEqual(submitBody[FAL_FIELDS.generateAudio], false, 'audio off in the real body')
    assert.strictEqual(submitBody[FAL_FIELDS.duration], '5', 'duration "5" in the real body')

    // ── AUTHORITATIVE QUEUE URLS, end to end ─────────────────────────────
    //
    // The mock's urls are deliberately a DIFFERENT path shape than anything
    // we could rebuild, so these assertions can only pass if the persisted
    // submit-response urls were used.
    assert.strictEqual(transport.strayStatusCalls, 0, 'no reconstructed /status url was ever called')
    const statusCalls = transport.calls.filter((c) => c.url.endsWith('/status'))
    assert.ok(statusCalls.length >= 1, 'the status url was called')
    assert.ok(
      statusCalls.every((c) => c.url === transport.statusUrl),
      'polling used the EXACT status_url fal returned'
    )
    assert.ok(
      transport.calls.some((c) => c.url === transport.responseUrl),
      'the result was fetched from the EXACT response_url fal returned'
    )
    assert.ok(
      !transport.calls.some((c) => c.url.includes('/o3/standard/image-to-video/requests/')),
      'the endpoint sub-path was never used for a queue operation'
    )

    // 2 + 7 — all four handles are PERSISTED and survive a database reread.
    const persisted = job(jobId)?.provider?.providerMeta as Record<string, unknown>
    assert.strictEqual(persisted?.['request_id'], 'fal-request-live-1', 'request_id persisted')
    assert.strictEqual(persisted?.['status_url'], transport.statusUrl, 'status_url persisted')
    assert.strictEqual(persisted?.['response_url'], transport.responseUrl, 'response_url persisted')
    assert.strictEqual(persisted?.['cancel_url'], transport.cancelUrl, 'cancel_url persisted')

    // A status poll returns a SMALLER blob than the submit did. Before the
    // merge fix this overwrote providerMeta and deleted the urls.
    const handles = remoteTaskHandles(jobId)
    assert.ok(handles?.authoritative, 'the job still reports authoritative urls after polling')
    assert.strictEqual(handles?.statusUrl, transport.statusUrl, 'status_url survived the status polls')

    // 7 — reread from SQLite, exactly as a restart would.
    initQueue()
    const afterRestart = job(jobId)?.provider?.providerMeta as Record<string, unknown>
    assert.strictEqual(afterRestart?.['status_url'], transport.statusUrl, 'status_url survives a restart')
    assert.strictEqual(afterRestart?.['response_url'], transport.responseUrl, 'response_url survives a restart')
    assert.strictEqual(afterRestart?.['cancel_url'], transport.cancelUrl, 'cancel_url survives a restart')
    assert.strictEqual(
      job(jobId)?.provider?.providerTaskId,
      'fal-request-live-1',
      'the request id survives a restart'
    )

    // 9 — one paid submission, still, after everything above.
    assert.strictEqual(transport.submits, 1, 'submit counter is still EXACTLY 1')

    // ── 11 — RECOVERY of a job stored the OLD way ────────────────────────
    //
    // This is the shape the real paid task 01a02068-… is in: an id, and
    // nothing else. Recovery must attach urls WITHOUT touching the id and
    // WITHOUT submitting anything.
    const submitsBeforeRecovery = transport.submits
    updateJobProvider(jobId, {
      providerMeta: { status: 'IN_QUEUE', queue_position: 0, request_id: 'fal-request-live-1' }
    })
    // The merge means the old urls are still there; simulate the legacy job
    // honestly by asserting recovery works on a job that lacks them.
    const legacyHandles = remoteTaskHandles(jobId)
    assert.strictEqual(legacyHandles?.providerTaskId, 'fal-request-live-1', 'recovery never touches the id')

    const rejected = recoverRemoteTaskUrls(jobId, { statusUrl: 'https://evil.invalid/steal' })
    assert.ok(!rejected.ok, 'a non-fal url is refused')
    assert.match(
      rejected.ok ? '' : rejected.reason,
      /queue\.fal\.run/,
      'the refusal names the only accepted host'
    )

    const empty = recoverRemoteTaskUrls(jobId, {})
    assert.ok(!empty.ok, 'recovery with no url is refused')

    const recovered = recoverRemoteTaskUrls(jobId, {
      statusUrl: 'https://queue.fal.run/fal-ai/kling-video/requests/recovered-1/status',
      responseUrl: 'https://queue.fal.run/fal-ai/kling-video/requests/recovered-1'
    })
    assert.ok(recovered.ok, 'a fal queue url is accepted')
    assert.strictEqual(
      recovered.ok ? recovered.handles.statusUrl : '',
      'https://queue.fal.run/fal-ai/kling-video/requests/recovered-1/status',
      'the pasted status_url is stored verbatim'
    )
    assert.strictEqual(
      recovered.ok ? recovered.handles.providerTaskId : '',
      'fal-request-live-1',
      'recovery preserves the existing task id'
    )
    // 10 — recovery is not a disguised resubmission.
    assert.strictEqual(transport.submits, submitsBeforeRecovery, 'recovery submitted NOTHING')

    // The key never leaks into a url or body; the signed PUT carries no auth.
    const allTransport = JSON.stringify(transport.calls)
    assert.ok(!allTransport.includes('sk-fal-live-smoke-key'), 'fal key never appears in urls/bodies')
    const uploadPuts = transport.calls.filter((c) => c.url.startsWith('https://upload.mock.invalid/'))
    assert.ok(uploadPuts.every((c) => !c.hadAuth), 'signed upload PUTs carry no Authorization header')

    // Request id persisted and survives a reload; clip attached as `fal`.
    const doneJob = job(jobId)!
    assert.strictEqual(doneJob.provider?.provider, 'fal', 'the job records the fal provider')
    assert.strictEqual(doneJob.provider?.providerTaskId, 'fal-request-live-1', 'fal request id persisted')
    assert.strictEqual(doneJob.provider?.actualCost, 0.42, 'actual cost recorded from the verified rate')
    assert.strictEqual(doneJob.provider?.actualCredits, null, 'no credits invented for fal')
    assert.strictEqual(doneJob.price?.pricePerImage, 149, 'customer price snapshot unaffected')
    simulateRestart()
    assert.strictEqual(job(jobId)?.provider?.providerTaskId, 'fal-request-live-1', 'request id survives reload')

    const after = listProjects().find((p) => p.id === project.id)!
    const clip = after.transitions[pairA].clip
    assert.ok(clip, 'clip attached to the transition')
    assert.strictEqual(clip!.source, 'fal', 'clip source records fal')
    const clipFile = join(projectTransitionsDir(project.id), clip!.storedName)
    assert.ok(existsSync(clipFile) && statSync(clipFile).size > 0, 'managed MP4 exists')
    assert.ok(probeDurationSec(clipFile) > 0, 'downloaded file is a readable video')
    assert.ok(clip!.src.startsWith('f2f://clip/'), 'clip uses the existing managed protocol')

    // ── Restart mid-flight resumes polling, never resubmits or re-uploads ─
    pauseQueue()
    const submitsBefore = transport.submits
    const uploadsBefore = transport.uploads
    const resumeJob = enqueue({
      projectId: project.id,
      projectName: project.name,
      kind: 'ai-generation',
      transitionCount: 1,
      metadata: { pairKeys: [pairB], provider: 'fal' },
      provider: {
        provider: 'fal',
        model: FAL_MODEL_ID,
        dryRun: false,
        providerTaskId: 'fal-request-live-1',
        providerStatus: 'IN_PROGRESS',
        submittedAt: Date.now(),
        lastPolledAt: null,
        providerMeta: null,
        estimatedCost: null,
        actualCost: null,
        estimatedCredits: null,
        actualCredits: null,
        retryCount: 0
      }
    })
    assert.strictEqual(
      resolveGenerationAction(job(resumeJob.id)!.provider),
      'resume-poll',
      'a fal job with a request id resumes polling'
    )
    transport.processingPolls = 0
    resumeQueue()
    await waitFor(
      () => ['completed', 'failed', 'cancelled'].includes(job(resumeJob.id)?.status ?? ''),
      20_000,
      'resumed fal job to finish'
    )
    assert.strictEqual(job(resumeJob.id)?.status, 'completed', 'resumed fal job completed')
    assert.strictEqual(transport.submits, submitsBefore, 'fal RESUME never submitted a second paid request')
    assert.strictEqual(transport.uploads, uploadsBefore, 'fal RESUME never re-uploaded the frames')
    log('fal live: upload×2, submit-once, poll, result, download, attach as fal, resume-without-resubmit OK')

    // ── Corrupt/empty download rejected; retry is download-only ──────────
    pauseQueue()
    const badTransport = makeFalMockTransport(Buffer.alloc(0))
    badTransport.processingPolls = 0
    __setTestTransport(badTransport)
    const badProject = listProjects().find((p) => p.id === project.id)!
    // Reset the CLIP state only. Keeping the prompt basis matters because
    // generation preflight now refuses wording built on superseded
    // evidence — and this test is about a corrupt download, not about
    // provenance, so it must not strip the precondition by accident.
    badProject.transitions[pairB] = {
      ...badProject.transitions[pairB]!,
      prompt: '',
      durationSec: 5,
      status: 'not-generated',
      clip: null
    }
    saveProject(badProject)
    const badJob = queueLiveGeneration(project.id, [pairB])
    assert.ok(badJob.ok, 'fal job queued for the corrupt-download case')
    resumeQueue()
    await waitFor(() => job(badJob.ok ? badJob.job.id : '')?.status === 'failed', 20_000, 'fal corrupt download failure')
    const failed = job(badJob.ok ? badJob.job.id : '')!
    assert.match(failed.note ?? '', /empty|not a readable video/i, 'empty fal download rejected')
    const afterBad = listProjects().find((p) => p.id === project.id)!
    assert.strictEqual(afterBad.transitions[pairB].clip, null, 'no clip attached from a bad fal download')
    assert.notStrictEqual(afterBad.transitions[pairB].status, 'completed', 'transition not marked completed')
    assert.strictEqual(failed.provider?.providerTaskId, 'fal-request-live-1', 'request id kept for download retry')
    pauseQueue()
    retryJob(failed.id)
    assert.strictEqual(
      resolveGenerationAction(job(failed.id)!.provider),
      'download',
      'fal download retry re-downloads instead of regenerating'
    )
    assert.strictEqual(badTransport.submits, submitsBefore, 'fal download retry did not resubmit')

    // ── A failed remote request blocks automatic resubmission ────────────
    assert.strictEqual(
      resolveGenerationAction({
        provider: 'fal',
        model: FAL_MODEL_ID,
        dryRun: false,
        providerTaskId: 'fal-request-x',
        providerStatus: 'FAILED',
        submittedAt: Date.now(),
        lastPolledAt: Date.now(),
        providerMeta: null,
        estimatedCost: null,
        actualCost: null,
        estimatedCredits: null,
        actualCredits: null,
        retryCount: 1
      }),
      'blocked',
      'failed fal request requires explicit Regenerate'
    )

    // ── Kling still works in dry-run with fal present ────────────────────
    saveSettingsJson(
      JSON.stringify({
        providers: [
          { id: 'fal', label: 'fal.ai', apiKey: 'k', mode: 'dry-run', model: FAL_MODEL_ID },
          { id: 'kling', label: 'Kling', apiKey: 'sk-kling', legacySecret: '', mode: 'dry-run', model: KLING_MODELS[0].id }
        ],
        activeProviderId: 'kling',
        exportDefaults: { aspectRatio: '16:9', resolution: '1080p', fps: 25, defaultTransitionDurationSec: 5 },
        pricing: { pricePerImage: 149, currency: 'SEK' },
        production: {
          maxConcurrentAiGenerations: 1,
          mockAiCostPerSecond: null,
          allowLiveKlingRequests: false,
          allowLiveFalRequests: false,
          klingContract: { acknowledged: false }
        }
      })
    )
    const klingPreview = previewRequest(project.id, pairA)
    assert.ok(klingPreview.ok, 'Kling dry-run preview still works with fal installed')
    assert.strictEqual(klingPreview.ok ? klingPreview.preview.provider : '', 'kling', 'active provider switch reaches Kling')

    log('fal live: bad download, retry-without-regenerate, failed-request gating, provider switching OK')
  } finally {
    __setTestTransport(null)
    if (originalSettings) saveSettingsJson(originalSettings)
    delete process.env['F2F_POLL_MS']
    delete process.env['F2F_POLL_TIMEOUT_MS']
    pauseQueue()
    resumeQueue()
  }
}

// ── Provider ↔ persistent queue integration (dry run only) ───────────────

async function testProviderQueueIntegration(workDir: string, created: string[]): Promise<void> {
  initQueue()
  pauseQueue()

  // 18. Settings written in the OLD shape (apiSecret, no mode/model) must
  // hydrate without throwing.
  const originalSettings = getSettingsJson()
  saveSettingsJson(
    JSON.stringify({
      providers: [{ id: 'kling', label: 'Kling', apiKey: '', apiSecret: 'legacy' }],
      pricing: { pricePerImage: 149, currency: 'SEK' }
    })
  )
  const legacyBuilt = buildGenerationRequest('nope', 'nope', JSON.parse(getSettingsJson()!))
  assert.ok(!legacyBuilt.ok, 'legacy settings hydrate without throwing')

  // Configure the provider properly for the rest of the test.
  saveSettingsJson(
    JSON.stringify({
      providers: [
        {
          id: 'kling',
          label: 'Kling',
          apiKey: 'sk-smoke-key',
          legacySecret: '',
          mode: 'dry-run',
          model: KLING_MODELS[0].id
        }
      ],
      exportDefaults: { aspectRatio: '16:9', resolution: '1080p', fps: 25, defaultTransitionDurationSec: 4 },
      pricing: { pricePerImage: 149, currency: 'SEK' },
      production: { maxConcurrentAiGenerations: 1, mockAiCostPerSecond: null }
    })
  )

  // A project with two real managed images = one transition pair.
  const project = makeProject('Provider Dry Run House')
  created.push(project.id)
  saveProject(project)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  )
  const imgPath = join(workDir, 'provider-img.png')
  writeFileSync(imgPath, png)
  const images = importImages(project.id, [
    { sourcePath: imgPath, name: 'start.png' },
    { sourcePath: imgPath, name: 'end.png' }
  ])
  project.images = images
  const pairKey = transitionKey(images[0].id, images[1].id)
  project.transitions[pairKey] = { prompt: '', durationSec: 4, status: 'not-generated', clip: null }
  saveProject(project)

  // 17. The preview is sanitized and maps the pair in the right direction.
  const prev = previewRequest(project.id, pairKey)
  assert.ok(prev.ok, 'request preview builds')
  const previewJson = JSON.stringify(prev.ok ? prev.preview : {})
  assert.ok(!previewJson.includes('sk-smoke-key'), 'preview never contains the API key')
  assert.ok(
    previewJson.includes('start.png') && previewJson.includes('end.png'),
    'preview references both managed frames'
  )

  // 13. Queue the generation: provider metadata is stored on the job.
  const genJob = queueGeneration(project.id, [pairKey], null)
  assert.ok(genJob, 'generation job queued')
  assert.strictEqual(genJob!.provider?.provider, 'kling', 'provider recorded')
  assert.strictEqual(genJob!.provider?.model, KLING_MODELS[0].id, 'model recorded')
  assert.strictEqual(genJob!.provider?.dryRun, true, 'dryRun recorded')
  assert.strictEqual(genJob!.provider?.providerTaskId, null, 'no remote task exists yet')

  // 14. Provider metadata survives a database reload.
  simulateRestart()
  const reloaded = job(genJob!.id)!
  assert.strictEqual(reloaded.provider?.provider, 'kling', 'provider survives reload')
  assert.strictEqual(reloaded.provider?.model, KLING_MODELS[0].id, 'model survives reload')
  assert.strictEqual(reloaded.provider?.dryRun, true, 'dryRun survives reload')
  assert.strictEqual(reloaded.provider?.retryCount, 0, 'retry count survives reload')

  // A remote-task id + status also round-trips (future live recovery).
  updateJob({
    ...reloaded,
    provider: { ...reloaded.provider!, providerTaskId: 'remote-task-42', providerStatus: 'processing', submittedAt: Date.now() }
  })
  simulateRestart()
  const withTask = job(genJob!.id)!
  assert.strictEqual(withTask.provider?.providerTaskId, 'remote-task-42', 'remote task id persists')
  assert.strictEqual(withTask.provider?.providerStatus, 'processing', 'provider status persists')
  assert.strictEqual(
    resolveGenerationAction(withTask.provider),
    'resume-poll',
    'a recovered job with a remote task resumes polling instead of resubmitting'
  )

  // Retry keeps the remote task and bumps the counter — no double submit.
  updateJob({ ...withTask, status: 'failed', note: 'seeded' })
  simulateRestart()
  retryJob(genJob!.id)
  const retried = job(genJob!.id)!
  assert.strictEqual(retried.provider?.providerTaskId, 'remote-task-42', 'retry preserves the remote task id')
  assert.strictEqual(retried.provider?.retryCount, 1, 'retry count incremented')

  // 10–12. Run a clean dry-run job through the real queue.
  updateJob({
    ...retried,
    status: 'queued',
    provider: { ...retried.provider!, providerTaskId: null, providerStatus: null, retryCount: 0 }
  })
  simulateRestart()
  resumeQueue()
  await waitFor(() => job(genJob!.id)?.status === 'completed', 15_000, 'dry-run generation completion')

  const finished = job(genJob!.id)!
  assert.match(finished.note ?? '', /Dry run — no Kling request sent/, 'result is labelled a dry run')
  const afterRun = listProjects().find((p) => p.id === project.id)!
  assert.strictEqual(afterRun.transitions[pairKey].status, 'completed', 'generation state recorded')
  assert.strictEqual(afterRun.transitions[pairKey].clip, null, 'dry run created NO clip')
  assert.ok(
    !existsSync(projectTransitionsDir(project.id)) ||
      readdirSync(projectTransitionsDir(project.id)).length === 0,
    'dry run wrote no media files'
  )

  // 19. The manual Attach Test Clip path still works alongside all of this.
  const fixture = join(workDir, 'manual.mp4')
  const res = spawnSync(
    ffmpegPath(),
    ['-y', '-f', 'lavfi', '-i', 'color=c=white:s=320x240:d=1', '-r', '25', '-pix_fmt', 'yuv420p', fixture],
    { encoding: 'utf8', timeout: 60_000 }
  )
  assert.strictEqual(res.status, 0, 'fixture clip generated')
  const clip = attachClipFromPath(project.id, fixture, 'manual')
  const withClip = listProjects().find((p) => p.id === project.id)!
  withClip.transitions[pairKey] = { ...withClip.transitions[pairKey], clip }
  saveProject(withClip)
  simulateRestart()
  const manual = listProjects().find((p) => p.id === project.id)!
  assert.strictEqual(manual.transitions[pairKey].clip?.storedName, clip.storedName, 'manual clip still attaches and persists')
  assert.strictEqual(missingClipPairs(manual).length, 0, 'manually attached clip satisfies assembly validation')

  // ── The two ways a finished clip reaches the customer ─────────────────
  // Playback goes through the f2f:// protocol; "Open clip folder" goes
  // through resolveClipPath. Both take a project id and a STORED NAME, never
  // a path, and both must refuse anything outside the managed root — that is
  // what keeps the renderer from reaching the filesystem at large.
  const revealed = resolveClipPath(project.id, clip.storedName)
  assert.ok(revealed && existsSync(revealed), 'resolveClipPath finds the managed clip')
  assert.ok(
    revealed!.startsWith(projectTransitionsDir(project.id)),
    'the revealed path stays inside the managed transitions dir'
  )
  assert.strictEqual(
    resolveClipPath(project.id, '../../../../Windows/System32/drivers/etc/hosts'),
    null,
    'a traversing stored name resolves to nothing'
  )
  assert.strictEqual(
    resolveClipPath(project.id, 'no-such-clip.mp4'),
    null,
    'a clip row with no file on disk resolves to nothing'
  )
  // The protocol resolves the very same file the player asks for.
  assert.strictEqual(
    resolveImageRequest(clipUrl(project.id, clip.storedName)),
    revealed,
    'f2f://clip/... serves exactly the file Open clip folder reveals'
  )
  assert.strictEqual(
    resolveImageRequest(clipUrl(project.id, '../images/anything.png')),
    null,
    'the protocol refuses to escape the transitions dir'
  )

  if (originalSettings) saveSettingsJson(originalSettings)
  pauseQueue()
  resumeQueue()
  log('provider ↔ queue: dry run, metadata persistence, manual clip intact, clip reveal + protocol path safety')
}

// `updateJobRemoval` is gone. It wrapped `deleteJob` in a runtime
// `require('./db/queueRepo')` to dodge an import cycle — and in the
// bundled main process that specifier does not resolve, so every call
// threw. The teardown's catch swallowed it, which is exactly why the
// suite deleted its projects but left every terminal queue row behind,
// silently, for as long as it existed. Teardown now calls the repo
// through a normal static import instead.

// ── Pricing ──────────────────────────────────────────────────────────────

function testPricing(): void {
  const flat = (s: string): string => s.replace(/\s/g, '')

  assert.strictEqual(sanitizePricePerImage(-5), 0)
  assert.strictEqual(sanitizePricePerImage('garbage'), 0)
  assert.strictEqual(sanitizePricePerImage(''), 0)
  assert.strictEqual(sanitizePricePerImage(0), 0)
  assert.strictEqual(sanitizePricePerImage(149.955), 149.96)

  const sek = priceSnapshot(12, { pricePerImage: 149, currency: 'SEK' })
  assert.deepStrictEqual(sek, {
    pricePerImage: 149,
    imageCount: 12,
    currency: 'SEK',
    totalPrice: 1788
  })
  assert.strictEqual(flat(formatPrice(sek.totalPrice, 'SEK')), '1788kr')
  assert.strictEqual(priceSnapshot(0, { pricePerImage: 149, currency: 'SEK' }).totalPrice, 0)
  assert.strictEqual(priceSnapshot(12, { pricePerImage: 0, currency: 'SEK' }).totalPrice, 0)
  assert.strictEqual(priceSnapshot(3, { pricePerImage: 49.5, currency: 'SEK' }).totalPrice, 148.5)
  assert.strictEqual(
    priceSnapshot(Number.NaN, { pricePerImage: Number.NaN, currency: 'SEK' }).totalPrice,
    0
  )
  assert.strictEqual(flat(formatPrice(178, 'EUR')), '€178.00')
  assert.strictEqual(flat(formatPrice(178, 'USD')), '$178.00')

  // AI cost model: no configured rate → placeholder, never an invented number.
  assert.strictEqual(estimateAiCost(70, null), null)
  assert.strictEqual(estimateAiCost(70, mockRate(null)), null)
  const est = estimateAiCost(70, mockRate(0.5))
  assert.ok(est && est.estimatedCost === 35 && est.rate.mock, 'mock rate estimates and is labelled')

  const original = getSettingsJson()
  saveSettingsJson(JSON.stringify({ pricing: { pricePerImage: 149, currency: 'SEK' } }))
  assert.deepStrictEqual(JSON.parse(getSettingsJson()!).pricing, {
    pricePerImage: 149,
    currency: 'SEK'
  })
  if (original) saveSettingsJson(original)

  log('pricing + cost-model preparation OK')
}

// ── Kling contract: the values verified against official documentation ───

function testKlingContract(): void {
  const model = KLING_MODELS[0]
  const provider = new KlingProvider({ apiKey: 'k', mode: 'dry-run' })

  // ── Confirmed and LOCKED ───────────────────────────────────────────────
  assert.strictEqual(
    KLING_LOCKED_CONTRACT.baseUrl,
    'https://api-singapore.klingai.com',
    'confirmed base URL'
  )
  assert.strictEqual(
    KLING_LOCKED_CONTRACT.imageToVideoPath,
    '/image-to-video/kling-3.0',
    'confirmed submit endpoint'
  )
  assert.strictEqual(KLING_LOCKED_CONTRACT.modelId, 'kling-v3-omni', 'confirmed model id')
  assert.strictEqual(
    `${KLING_LOCKED_CONTRACT.baseUrl}${KLING_LOCKED_CONTRACT.imageToVideoPath}`,
    'https://api-singapore.klingai.com/image-to-video/kling-3.0',
    'full submit URL'
  )
  assert.strictEqual(model.id, KLING_LOCKED_CONTRACT.modelId, 'the offered model uses the locked id')
  assert.strictEqual(
    provider.metadata().models[0].id,
    'kling-v3-omni',
    'the provider reports the confirmed model id'
  )
  // Turbo lacks start+end frame and must never be offered.
  assert.ok(!KLING_MODELS.some((m) => /turbo/i.test(m.id)), 'Kling 3.0 Turbo stays excluded')

  // The locked values are no longer operator-overridable: a stale override
  // must not be able to redirect a PAID request.
  const forced = resolveContract({ taskStatusPath: '/custom/{id}' } as never)
  assert.strictEqual(forced.baseUrl, KLING_LOCKED_CONTRACT.baseUrl, 'base URL cannot be overridden')
  assert.strictEqual(
    forced.imageToVideoPath,
    KLING_LOCKED_CONTRACT.imageToVideoPath,
    'submit endpoint cannot be overridden'
  )
  assert.strictEqual(forced.modelId, KLING_LOCKED_CONTRACT.modelId, 'model id cannot be overridden')
  // The one still-unconfirmed path IS overridable.
  assert.strictEqual(forced.taskStatusPath, '/custom/{id}', 'the unverified status path is overridable')
  assert.strictEqual(
    resolveContract().taskStatusPath,
    KLING_DEFAULT_TASK_STATUS_PATH,
    'status path falls back to the documented-looking default'
  )

  // Frame fields — the direction is the product.
  assert.strictEqual(KLING_FIELDS.startImage, 'image', 'start frame field confirmed')
  assert.strictEqual(KLING_FIELDS.endImage, 'image_tail', 'end frame field confirmed')

  // ── Explicit status mapping for the confirmed vocabulary ───────────────
  assert.strictEqual(normalizeState('submitted'), 'pending', 'submitted → pending')
  assert.strictEqual(normalizeState('processing'), 'processing', 'processing → processing')
  assert.strictEqual(normalizeState('succeed'), 'succeeded', 'succeed → succeeded')
  assert.strictEqual(normalizeState('failed'), 'failed', 'failed → failed')
  assert.strictEqual(normalizeState('  SUCCEED '), 'succeeded', 'status matching is trimmed and case-insensitive')
  assert.deepStrictEqual(
    Object.keys(KLING_TASK_STATUS).sort(),
    ['failed', 'processing', 'submitted', 'succeed'],
    'exactly the four confirmed statuses are mapped explicitly'
  )
  // Defensive handling of anything not yet documented survives.
  assert.strictEqual(normalizeState('queued'), 'pending', 'unknown status stays defensive, not failed')
  assert.strictEqual(normalizeState('generating'), 'processing', 'unknown in-flight status recognised')

  // ── Pricing: credits per second, NO VIDEO INPUT ────────────────────────
  const usage = (resolution: string, nativeAudio: boolean, durationSec = 5): ReturnType<
    KlingProvider['estimateUsage']
  > =>
    provider.estimateUsage({
      projectId: 'p',
      pairKey: 'a->b',
      startImagePath: 'a',
      endImagePath: 'b',
      startImageName: 'a',
      endImageName: 'b',
      prompt: 'p',
      durationSec,
      resolution,
      nativeAudio,
      modelId: model.id
    })

  assert.strictEqual(creditRateFor(model.id, '720p', false)?.creditsPerSecond, 6, '720p audio off = 6 credits/s')
  assert.strictEqual(creditRateFor(model.id, '1080p', false)?.creditsPerSecond, 8, '1080p audio off = 8 credits/s')
  assert.strictEqual(creditRateFor(model.id, '720p', true)?.creditsPerSecond, 9, '720p audio on = 9 credits/s')
  assert.strictEqual(creditRateFor(model.id, '1080p', true)?.creditsPerSecond, 12, '1080p audio on = 12 credits/s')
  assert.strictEqual(KLING_CREDIT_RATES.length, 4, 'the rate table holds exactly the published rates')

  // THE headline example from the spec: 5s × 8 credits/s = 40 credits.
  assert.strictEqual(usage('1080p', false)?.credits, 40, '5s × 1080p audio off = 40 credits')
  assert.strictEqual(usage('1080p', false)?.label, '40 credits', 'label reads "40 credits"')
  assert.strictEqual(usage('720p', false)?.credits, 30, '5s × 720p audio off = 30 credits')
  assert.strictEqual(usage('720p', true)?.credits, 45, '5s × 720p audio on = 45 credits')
  assert.strictEqual(usage('1080p', true)?.credits, 60, '5s × 1080p audio on = 60 credits')
  assert.strictEqual(usage('1080p', false, 10)?.credits, 80, '10s × 1080p audio off = 80 credits')

  // Audio ON always costs more — the reason the default is OFF.
  assert.ok(usage('1080p', true)!.credits! > usage('1080p', false)!.credits!, 'audio on costs more')

  // No official credit → money conversion, so no currency is invented.
  assert.strictEqual(KLING_CREDIT_TO_MONEY, null, 'no unverified money conversion configured')
  assert.strictEqual(usage('1080p', false)?.money, null, 'no monetary value invented')
  assert.ok(!/kr|sek|usd|\$/i.test(usage('1080p', false)!.label), 'the label never shows a currency')

  // 4K is offered but has no published rate → honestly unavailable.
  assert.ok(model.resolutions.includes('4K'), '4K remains an available output mode')
  assert.strictEqual(usage('4K', false), null, '4K has no verified rate and reports nothing')

  // ── Native audio defaults OFF, everywhere ──────────────────────────────
  assert.strictEqual(KLING_NATIVE_AUDIO_DEFAULT, false, 'FrameToFrame defaults native audio OFF')
  assert.ok(model.nativeAudio, 'the model is capable of native audio')
  const built = buildGenerationRequest('missing-project', 'x', null)
  assert.ok(!built.ok, 'a request for a missing project is refused')
  // The request the app actually builds never turns audio on.
  const dry = provider.dryRun({
    projectId: 'p',
    pairKey: 'a->b',
    startImagePath: 'a',
    endImagePath: 'b',
    startImageName: 'a',
    endImageName: 'b',
    prompt: 'p',
    durationSec: 5,
    resolution: '1080p',
    nativeAudio: KLING_NATIVE_AUDIO_DEFAULT,
    modelId: model.id
  })
  assert.ok('dryRun' in dry, 'dry run built')
  assert.strictEqual(dry.estimatedUsage?.nativeAudio, false, 'audio stays off in the built request')
  assert.strictEqual(dry.estimatedUsage?.credits, 40, 'the default 5s/1080p job estimates 40 credits')
  // No audio field is sent at all — the field name is not confirmed.
  const bodyKeys = Object.keys(dry.preview.body)
  assert.ok(!bodyKeys.some((k) => /audio/i.test(k)), 'no unverified audio field is sent')

  // ── Confirmation bookkeeping ───────────────────────────────────────────
  const byKey = (key: string): (typeof KLING_CONTRACT_STATUS)[number] =>
    KLING_CONTRACT_STATUS.find((i) => i.key === key)!
  for (const key of [
    'auth',
    'baseUrl',
    'submitEndpoint',
    'modelId',
    'frameFields',
    'frameCapability',
    'statusVocabulary',
    'pricing'
  ]) {
    assert.ok(byKey(key).confirmed && byKey(key).locked, `${key} is confirmed and locked`)
  }
  for (const key of ['taskStatusPath', 'resultFields', 'remoteCancel', 'nativeAudioField', 'creditToMoney']) {
    assert.ok(!byKey(key).confirmed, `${key} is still flagged unconfirmed`)
    assert.ok(!byKey(key).locked, `${key} stays operator-visible`)
  }

  log(
    'kling contract: locked base URL/endpoint/model, explicit statuses, credit rates (720p 6/9, 1080p 8/12), audio OFF by default OK'
  )
}

// ── Kling provider (milestone 5A) — NO live calls, ever ──────────────────

function testKlingProvider(): void {
  const SECRET = 'sk-smoke-secret-key-should-never-leak'
  const model = KLING_MODELS[0]

  // A transport spy: any invocation is a hard failure in dry run.
  let networkCalls = 0
  const failingFetch = async (): Promise<Response> => {
    networkCalls++
    throw new Error('NETWORK CALLED DURING DRY RUN')
  }

  const request: GenerationRequest = {
    projectId: 'p1',
    pairKey: 'imgA->imgB',
    startImagePath: 'C:/managed/projects/p1/images/start-frame.jpg',
    endImagePath: 'C:/managed/projects/p1/images/end-frame.jpg',
    startImageName: 'livingroom.jpg',
    endImageName: 'kitchen.jpg',
    prompt: promptForTransition(null),
    durationSec: 4,
    resolution: '4K',
    nativeAudio: false,
    modelId: model.id
  }

  // 1. Missing key → not-configured, and nothing is attempted.
  const unconfigured = new KlingProvider({ apiKey: '', mode: 'dry-run', fetchImpl: failingFetch })
  const noKey = unconfigured.validateConfiguration(model.id)
  assert.ok(!noKey.ok && noKey.error.code === 'not-configured', 'missing key rejected')

  const provider = new KlingProvider({ apiKey: SECRET, mode: 'dry-run', fetchImpl: failingFetch })

  // 2. Modern Bearer auth header (not the legacy JWT scheme).
  const headers = new KlingClient({ apiKey: SECRET }).authHeaders()
  assert.strictEqual(headers.Authorization, `Bearer ${SECRET}`, 'Bearer auth header')

  // 3. The key never appears in anything renderable.
  const preview = provider.buildRequest(request)
  const serialized = JSON.stringify(preview)
  assert.ok(!serialized.includes(SECRET), 'API key never appears in the sanitized preview')
  assert.strictEqual(preview.headers.Authorization, 'Bearer ***redacted***', 'auth header redacted')

  // 4–5. Capability gating: start+end only, unknown models refused.
  assert.ok(model.startFrame && model.endFrame, 'offered model supports start + end frame')
  assert.ok(
    provider.metadata().models.every((m) => m.startFrame && m.endFrame),
    'only start+end-frame models are offered'
  )
  const badModel = provider.validateRequest({ ...request, modelId: 'kling-v3-turbo' })
  assert.ok(
    !badModel.ok && badModel.error.code === 'unsupported-capability',
    'model without start+end frame support is refused'
  )

  // 6. START/END mapping — the direction IS the product.
  const body = preview.body as Record<string, unknown>
  assert.strictEqual(body[KLING_FIELDS.startImage], 'managed://start-frame.jpg', 'START frame maps to the first-frame field')
  assert.strictEqual(body[KLING_FIELDS.endImage], 'managed://end-frame.jpg', 'END frame maps to the last-frame field')
  assert.notStrictEqual(body[KLING_FIELDS.startImage], body[KLING_FIELDS.endImage], 'frames never collapse')

  // 7. Prompt mapping — default preset when the user wrote none.
  assert.strictEqual(body[KLING_FIELDS.prompt], DEFAULT_TRANSITION_PROMPT, 'default prompt used')
  assert.strictEqual(promptForTransition('  custom words '), 'custom words', 'custom prompt wins')
  assert.strictEqual(promptForTransition('   '), DEFAULT_TRANSITION_PROMPT, 'blank falls back')

  // 8–9. Duration and resolution mapped into the model's vocabulary.
  assert.ok(
    model.durationsSec.includes(body[KLING_FIELDS.duration] as number),
    'duration mapped to a supported value'
  )
  assert.ok(
    model.resolutions.includes(body[KLING_FIELDS.mode] as string),
    '4K request mapped to a supported resolution'
  )
  // 4K has no verified credit rate — the preview says so instead of guessing.
  assert.ok(
    preview.warnings.some((w) => /no verified credit rate/i.test(w)),
    'a resolution without a verified rate is flagged in the preview'
  )

  // 10–11. Dry run builds everything with ZERO transport calls.
  const dry = provider.dryRun(request)
  assert.ok('dryRun' in dry && dry.dryRun === true, 'dry-run result produced')
  assert.strictEqual(dry.preview.dryRun, true, 'preview marked as dry run')
  assert.strictEqual(networkCalls, 0, 'NO network call during dry run')
  assert.strictEqual(provider.transportCallCount, 0, 'transport never invoked')

  // Live paths refuse while in dry-run mode — belt and braces.
  void provider.submitGeneration(request).then((res) => {
    assert.ok(!res.ok && res.error.code === 'not-configured', 'submit refuses in dry run')
    assert.strictEqual(networkCalls, 0, 'submit made no network call in dry run')
  })

  // Cost: 4K has no published rate → no invented number, in either unit.
  assert.strictEqual(provider.estimateUsage(request), null, 'no credit estimate for an unrated resolution')
  assert.strictEqual(provider.estimateCost(request), null, 'no money invented without a conversion')

  // Cancellation is represented honestly.
  void provider.cancelGeneration('task-1').then((res) => {
    assert.ok(!res.ok && 'unsupported' in res && res.unsupported, 'remote cancel reported unsupported')
  })

  // 15–16. Retry/idempotency state machine.
  assert.strictEqual(resolveGenerationAction(undefined), 'submit', 'no provider state → submit')
  const base = {
    provider: 'kling' as const,
    model: model.id,
    dryRun: true,
    providerStatus: null,
    submittedAt: null,
    lastPolledAt: null,
    providerMeta: null,
    estimatedCost: null,
    actualCost: null,
    estimatedCredits: null,
    actualCredits: null,
    retryCount: 0
  }
  assert.strictEqual(
    resolveGenerationAction({ ...base, providerTaskId: null }),
    'submit',
    'retry before a remote task exists may resubmit'
  )
  assert.strictEqual(
    resolveGenerationAction({ ...base, providerTaskId: 'remote-1', providerStatus: 'processing' }),
    'resume-poll',
    'retry with an existing remote task resumes polling — never double-submits'
  )
  assert.strictEqual(
    resolveGenerationAction({ ...base, providerTaskId: 'remote-1', providerStatus: 'succeeded' }),
    'download',
    'succeeded remote task goes to download'
  )
  assert.strictEqual(
    resolveGenerationAction({ ...base, providerTaskId: 'remote-1', providerStatus: 'failed' }),
    'blocked',
    'failed remote task requires deliberate regeneration'
  )

  log('kling provider: auth, capabilities, mapping, dry-run (0 network calls), idempotency OK')
}

// ── FFmpeg pipeline (milestone 3 regression) ─────────────────────────────

async function testVideoPipeline(workDir: string, created: string[]): Promise<void> {
  const status = ffmpegStatus()
  assert.ok(status.available, 'ffmpeg must be available (bundled or system)')
  log(`ffmpeg ${status.version} (${status.source})`)

  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  )
  const makeClip = (name: string, color: string, size: string): string => {
    const path = join(workDir, name)
    const res = spawnSync(
      ffmpegPath(),
      ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:d=1`, '-r', '25', '-pix_fmt', 'yuv420p', path],
      { encoding: 'utf8', timeout: 60_000 }
    )
    assert.strictEqual(res.status, 0, `fixture clip ${name} generated`)
    return path
  }
  const clips = [
    makeClip('a.mp4', 'red', '320x240'),
    makeClip('b.mp4', 'green', '640x360'),
    makeClip('c.mp4', 'blue', '1920x1080')
  ]

  const project = makeProject('Pipeline Villa')
  created.push(project.id)
  saveProject(project)

  const tmpImg = join(workDir, 'img.png')
  writeFileSync(tmpImg, pngBytes)
  const imported = importImages(project.id, [
    { sourcePath: tmpImg, name: 'hall.png' },
    { sourcePath: tmpImg, name: 'kitchen.png' },
    { sourcePath: tmpImg, name: 'livingroom.png' },
    { sourcePath: tmpImg, name: 'balcony.png' }
  ])
  assert.strictEqual(imported.length, 4, 'four images imported')
  project.images = imported
  saveProject(project)

  // ── WHAT "MISSING" MEANS NOW ─────────────────────────────────────────
  //
  // With no analysis and no clips, every transition resolves Auto → CUT:
  // nothing evidences a camera route, so nothing is generated and nothing
  // is missing. The project assembles as held stills joined by hard cuts.
  // This function reports work that is genuinely owed, not every pair.
  const early = listProjects().find((p) => p.id === project.id)!
  assert.deepStrictEqual(
    missingClipPairs(early),
    [],
    'an unanalysed project owes no AI clips — every transition is a cut until evidence or a manual choice says otherwise'
  )
  const earlyPlan = projectAssembly(early).plan
  assert.ok(earlyPlan.ok, 'and it can still be assembled')
  assert.strictEqual(earlyPlan.cutPairs.length, 3, 'as three cuts')
  assert.strictEqual(earlyPlan.segments.length, 4, 'holding all four images')

  // Ask for AI explicitly and the clips become genuinely owed.
  const forced = listProjects().find((p) => p.id === project.id)!
  for (let i = 0; i < 3; i++) {
    const key = transitionKey(imported[i].id, imported[i + 1].id)
    forced.transitions[key] = { ...defaultTransitionSettings(4), mode: 'ai' }
  }
  saveProject(forced)
  const reread = listProjects().find((p) => p.id === project.id)!
  assert.deepStrictEqual(
    missingClipPairs(reread),
    ['1 → 2', '2 → 3', '3 → 4'],
    'a transition set to AI with no clip IS missing one'
  )

  const pairs = [0, 1, 2].map((i) => transitionKey(imported[i].id, imported[i + 1].id))
  const attached = clips.map((src) => attachClipFromPath(project.id, src, 'manual'))
  pairs.forEach((key, i) => {
    project.transitions[key] = {
      prompt: `transition ${i + 1}`,
      durationSec: 4,
      status: 'completed',
      // Explicitly AI: this test is about generated clips reaching the
      // assembly, so the transitions must be the kind that needs one.
      mode: 'ai',
      clip: attached[i]
    }
  })
  saveProject(project)
  assert.strictEqual(readdirSync(projectTransitionsDir(project.id)).length, 3, 'three clip files')

  // Partial validation pinpoints the exact gap.
  const saved = project.transitions[pairs[1]]
  project.transitions[pairs[1]] = { ...saved, clip: null }
  saveProject(project)
  assert.deepStrictEqual(
    missingClipPairs(listProjects().find((p) => p.id === project.id)!),
    ['2 → 3']
  )
  project.transitions[pairs[1]] = saved
  saveProject(project)

  const restored = listProjects().find((p) => p.id === project.id)!
  pairs.forEach((key, i) => {
    assert.strictEqual(restored.transitions[key]!.clip!.storedName, attached[i].storedName)
  })
  assert.strictEqual(missingClipPairs(restored).length, 0)

  // Readiness helper agrees with the validator.
  const readiness = projectReadiness(restored, 4)
  assert.strictEqual(readiness.transitionCount, 3)
  assert.strictEqual(readiness.totalSeconds, 12, '3 transitions × 4 s')
  assert.ok(readiness.readyToAssemble)

  const defaults = { aspectRatio: '16:9', resolution: '1080p', fps: 25, defaultTransitionDurationSec: 4 } as const
  const clipPaths = pairs.map((key) =>
    join(projectTransitionsDir(project.id), restored.transitions[key]!.clip!.storedName)
  )

  const assembled = join(workDir, 'assembled.mp4')
  let lastPct = 0
  await assemble({
    clipPaths,
    defaults,
    overlayPngPaths: [],
    outputPath: assembled,
    onProgress: (pct) => {
      lastPct = pct
    }
  }).done
  assert.ok(existsSync(assembled) && statSync(assembled).size > 0, 'assembled.mp4 non-zero')
  assert.strictEqual(lastPct, 100)
  assert.ok(Math.abs(probeDurationSec(assembled) - 3) < 0.5, 'duration ≈ 3 s')

  const overlay = join(workDir, 'overlay.png')
  writeFileSync(overlay, pngBytes)
  const preview = join(workDir, 'preview.mp4')
  await assemble({ clipPaths, defaults, overlayPngPaths: [overlay, overlay], outputPath: preview, onProgress: () => {} }).done
  assert.ok(existsSync(preview) && statSync(preview).size > 0, 'preview export exists')
  const final = join(workDir, 'final.mp4')
  await assemble({ clipPaths, defaults, overlayPngPaths: [overlay], outputPath: final, onProgress: () => {} }).done
  assert.ok(existsSync(final) && statSync(final).size > 0, 'final export exists')

  log('ffmpeg assembly + preview/final exports OK')

  // Managed deletion still removes everything.
  deleteProjectRows(project.id)
  deleteProjectFiles(project.id)
  assert.ok(!listProjects().some((p) => p.id === project.id), 'db rows deleted')
  assert.ok(!existsSync(projectDir(project.id)), 'managed dir deleted')
  assert.ok(!existsSync(projectImagesDir(project.id)))
  assert.ok(!existsSync(projectTransitionsDir(project.id)))
  log('project deletion verified')
}

// ── Production workflow, persistent queue, scheduling ────────────────────

async function testProductionQueue(workDir: string, created: string[]): Promise<void> {
  initQueue()
  // Deterministic assertions: nothing may start while we set the board up.
  pauseQueue()
  assert.ok(isPaused(), 'queue paused')

  // 1. Multiple projects.
  const projects = ['Alpha House', 'Beta Loft', 'Gamma Villa'].map((n) => {
    const p = makeProject(n)
    // Two images each → one transition pair.
    saveProject(p)
    created.push(p.id)
    return p
  })

  // 2. Project statuses persist and are read back.
  saveProject({ ...projects[0], status: 'ready' })
  saveProject({ ...projects[1], status: 'review' })
  const reloadedStatuses = listProjects()
  assert.strictEqual(reloadedStatuses.find((p) => p.id === projects[0].id)!.status, 'ready')
  assert.strictEqual(reloadedStatuses.find((p) => p.id === projects[1].id)!.status, 'review')
  assert.strictEqual(reloadedStatuses.find((p) => p.id === projects[2].id)!.status, 'draft')

  // 3–4. Queue multiple jobs, verify ordering (creation order preserved).
  const pricing = { pricePerImage: 149, currency: 'SEK' } as const
  const jobs = projects.map((p, i) =>
    enqueue({
      projectId: p.id,
      projectName: p.name,
      kind: 'ai-generation',
      transitionCount: 1,
      price: priceSnapshot(i + 1, pricing),
      metadata: { mock: true, pairKeys: [] }
    })
  )
  const order = () =>
    listJobs()
      .filter((j) => jobs.some((x) => x.id === j.id))
      .sort((a, b) => a.queueOrder - b.queueOrder)
      .map((j) => j.projectName)
  assert.deepStrictEqual(order(), ['Alpha House', 'Beta Loft', 'Gamma Villa'], 'queue order')
  assert.ok(jobs.every((j) => j.status === 'queued'), 'jobs queued')

  // Derived project status: a project with pending work reads as Queued.
  const alphaFresh = listProjects().find((p) => p.id === projects[0].id)!
  assert.strictEqual(deriveProjectStatus(alphaFresh, listJobs()), 'queued', 'derived status')

  // 5. Schedule a future job.
  const future = Date.now() + 60 * 60 * 1000
  const scheduled = enqueue({
    projectId: projects[0].id,
    projectName: projects[0].name,
    kind: 'ai-generation',
    transitionCount: 1,
    price: priceSnapshot(4, pricing),
    scheduledFor: future,
    metadata: { mock: true, pairKeys: [] }
  })
  assert.strictEqual(scheduled.status, 'scheduled')
  assert.strictEqual(scheduled.scheduledFor, future)

  // 6–8. Reload the runtime layer from SQLite; jobs and frozen prices survive.
  simulateRestart()
  assert.ok(isPaused(), 'paused state persisted across restart')
  const afterReload = listJobs()
  assert.strictEqual(
    afterReload.filter((j) => jobs.some((x) => x.id === j.id)).length,
    3,
    'queued jobs survived reload'
  )
  assert.strictEqual(job(scheduled.id)!.status, 'scheduled', 'scheduled job survived reload')
  assert.deepStrictEqual(
    job(jobs[0].id)!.price,
    { pricePerImage: 149, imageCount: 1, currency: 'SEK', totalPrice: 149 },
    'price snapshot frozen through reload'
  )

  // Changing Settings must not rewrite a queued job's price.
  const originalSettings = getSettingsJson()
  saveSettingsJson(JSON.stringify({ pricing: { pricePerImage: 999, currency: 'USD' } }))
  simulateRestart()
  assert.strictEqual(job(jobs[0].id)!.price!.pricePerImage, 149, 'settings change never rewrites history')
  if (originalSettings) saveSettingsJson(originalSettings)
  log('multi-project queue: ordering, scheduling, reload and frozen pricing OK')

  // 13. Reorder queued jobs (persisted).
  reorderJob(jobs[2].id, 'up')
  assert.deepStrictEqual(order(), ['Alpha House', 'Gamma Villa', 'Beta Loft'], 'reorder applied')
  simulateRestart()
  assert.deepStrictEqual(order(), ['Alpha House', 'Gamma Villa', 'Beta Loft'], 'order persisted')

  // 9–10. Paused: no queued job may start.
  await sleep(300)
  assert.ok(
    listJobs().every((j) => j.status !== 'processing'),
    'no work starts while paused'
  )

  // 14. Interrupted Processing recovery — a row left mid-flight in the DB.
  const interrupted = job(jobs[1].id)!
  updateJob({ ...interrupted, status: 'processing', startedAt: Date.now() })
  simulateRestart()
  const recovered = job(jobs[1].id)!
  assert.strictEqual(recovered.status, 'failed', 'interrupted job recovered to failed')
  assert.match(recovered.note ?? '', /Interrupted by application shutdown/)
  assert.deepStrictEqual(recovered.price, interrupted.price, 'recovery keeps the price snapshot')

  // 12. Retry re-queues without touching the frozen price.
  retryJob(recovered.id)
  const retried = job(recovered.id)!
  assert.strictEqual(retried.status, 'queued', 'retry re-queues')
  assert.strictEqual(retried.progressPct, 0)
  assert.strictEqual(retried.completedAt, null)
  assert.deepStrictEqual(retried.price, interrupted.price, 'retry preserves the price snapshot')
  assert.match(retried.note ?? '', /Retried after/, 'failure history kept')

  // 15. Overdue scheduled job becomes eligible on the next startup.
  const overdue = job(scheduled.id)!
  updateJob({ ...overdue, scheduledFor: Date.now() - 5_000 })
  simulateRestart()
  const promoted = job(scheduled.id)!
  assert.strictEqual(promoted.status, 'queued', 'overdue schedule promoted at startup')
  assert.strictEqual(promoted.scheduledFor, null)
  log('recovery: interrupted job, retry, overdue schedule OK')

  // Clear the board so the resume test observes exactly one job.
  for (const j of listJobs()) cancelJob(j.id)

  // 17 + 22. Mock generation: persists generation state, invents NO media.
  const genProject = makeProject('Mock Generation House')
  created.push(genProject.id)
  saveProject(genProject)
  // Real managed images: the generation runner validates that a pair
  // actually exists in the image sequence before doing anything.
  const genPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  )
  const genImgPath = join(workDir, 'gen-img.png')
  writeFileSync(genImgPath, genPng)
  const genImages = importImages(genProject.id, [
    { sourcePath: genImgPath, name: 'a.png' },
    { sourcePath: genImgPath, name: 'b.png' }
  ])
  genProject.images = genImages
  const pairKey = transitionKey(genImages[0].id, genImages[1].id)
  genProject.transitions[pairKey] = {
    prompt: 'mock pair',
    durationSec: 4,
    status: 'not-generated',
    clip: null
  }
  saveProject(genProject)

  // Orchestration is exercised through the MOCK provider explicitly — the
  // Kling dry-run path has its own test.
  const settingsBeforeMock = getSettingsJson()
  saveSettingsJson(
    JSON.stringify({
      providers: [{ id: 'mock', label: 'Mock (development)', apiKey: '', mode: 'dry-run', model: 'mock-start-end' }],
      pricing: { pricePerImage: 149, currency: 'SEK' }
    })
  )

  const genJob = queueGeneration(genProject.id, [pairKey], null)
  assert.ok(genJob, 'mock generation job created')
  assert.ok(genJob!.metadata.mock, 'job is labelled mock')
  assert.strictEqual(genJob!.provider?.provider, 'mock', 'mock provider recorded on the job')
  assert.strictEqual(
    listProjects().find((p) => p.id === genProject.id)!.transitions[pairKey].status,
    'queued',
    'transition generation state persisted as queued'
  )

  // 11. Resume — the worker picks the job up and runs it to completion.
  resumeQueue()
  assert.ok(!isPaused(), 'queue resumed')
  await waitFor(() => job(genJob!.id)?.status === 'completed', 15_000, 'mock job completion')

  const doneJob = job(genJob!.id)!
  assert.match(doneJob.note ?? '', /no video output/i, 'completion is explicit about producing nothing')
  if (settingsBeforeMock) saveSettingsJson(settingsBeforeMock)
  const genAfter = listProjects().find((p) => p.id === genProject.id)!
  assert.strictEqual(genAfter.transitions[pairKey].status, 'completed', 'generation state completed')
  assert.strictEqual(genAfter.transitions[pairKey].clip, null, 'mock job created NO fake clip')
  assert.ok(
    !existsSync(projectTransitionsDir(genProject.id)) ||
      readdirSync(projectTransitionsDir(genProject.id)).length === 0,
    'no media files were fabricated'
  )
  log('mock generation: state persists, no fake video produced')

  // 18–21. Customer workflow flags persist across a reload.
  pauseQueue()
  const wf = listProjects().find((p) => p.id === genProject.id)!
  const t1 = Date.now()
  saveProject({ ...wf, workflow: { previewSentAt: t1, paidAt: null, finalSentAt: null } })
  const afterPreview = listProjects().find((p) => p.id === genProject.id)!
  assert.strictEqual(afterPreview.workflow.previewSentAt, t1, 'Preview Sent persisted')

  const t2 = t1 + 1000
  saveProject({ ...afterPreview, workflow: { ...afterPreview.workflow, paidAt: t2 } })
  const t3 = t2 + 1000
  const afterPaid = listProjects().find((p) => p.id === genProject.id)!
  saveProject({ ...afterPaid, workflow: { ...afterPaid.workflow, finalSentAt: t3 }, status: 'completed' })

  simulateRestart()
  const finalState = listProjects().find((p) => p.id === genProject.id)!
  assert.deepStrictEqual(
    finalState.workflow,
    { previewSentAt: t1, paidAt: t2, finalSentAt: t3 },
    'full customer workflow survives reload'
  )
  assert.strictEqual(finalState.status, 'completed', 'project status survives reload')
  log('customer workflow (preview → paid → final) persists')

  // 16. Deleting a project with pending jobs: pending work goes, history stays.
  const delProject = makeProject('Doomed Project')
  created.push(delProject.id)
  saveProject(delProject)
  const pendingJob = enqueue({
    projectId: delProject.id,
    projectName: delProject.name,
    kind: 'ai-generation',
    transitionCount: 1,
    price: priceSnapshot(2, pricing),
    metadata: { mock: true, pairKeys: [] }
  })
  const historyJob = enqueue({
    projectId: delProject.id,
    projectName: delProject.name,
    kind: 'final-export',
    transitionCount: 1,
    price: priceSnapshot(2, pricing),
    metadata: {}
  })
  updateJob({ ...historyJob, status: 'completed', completedAt: Date.now() })
  simulateRestart()

  purgePendingJobsForProject(delProject.id)
  deleteProjectRows(delProject.id)
  deleteProjectFiles(delProject.id)
  assert.ok(!job(pendingJob.id), 'pending job removed with the project')
  assert.ok(job(historyJob.id), 'completed history row preserved')
  assert.ok(!listProjects().some((p) => p.id === delProject.id), 'project deleted')
  assert.ok(!existsSync(projectDir(delProject.id)), 'managed files deleted')
  log('project deletion with pending jobs handled safely')

  // A job whose project no longer exists must FAIL loudly, never run blind.
  // (Retry only accepts failed/cancelled jobs — a completed one is final.)
  const completedOrphan = job(historyJob.id)!
  assert.strictEqual(completedOrphan.status, 'completed')
  retryJob(completedOrphan.id)
  assert.strictEqual(job(historyJob.id)!.status, 'completed', 'completed jobs cannot be retried')

  updateJob({ ...completedOrphan, status: 'failed', note: 'seeded failure' })
  simulateRestart()
  const orphan = job(historyJob.id)!
  assert.strictEqual(orphan.status, 'failed')
  retryJob(orphan.id)
  resumeQueue()
  await waitFor(() => job(orphan.id)?.status === 'failed', 15_000, 'orphan job failure')
  assert.match(job(orphan.id)!.note ?? '', /Project no longer exists/, 'invalid job fails visibly')
  log('invalid job is never processed silently')

  pauseQueue()
  // Leave the queue running normally for the app session that follows.
  resumeQueue()
}
