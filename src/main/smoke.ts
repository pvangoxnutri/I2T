import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { app } from 'electron'
import assert from 'node:assert'
import {
  transitionKey,
  type AppSettings,
  type Project,
  type QueueJob,
  type TransitionSettings
} from '../shared/types'
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
import { planSeams, SEAM_SECONDS, type SeamBlend } from '../shared/seamBlend'
import {
  emptyAnalysis,
  parseAnalysis,
  relateImages,
  roomOfImage,
  type PropertyAnalysis
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
import { deleteAnalysis, readAnalysis, saveAnalysis } from './db/analysisRepo'
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
import { missingClipPairs } from './services/exportService'
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
  FAL_NATIVE_AUDIO_DEFAULT,
  FAL_QUEUE_STATUS
} from './providers/fal/falConfig'
import { sanitizeApiKey } from './providers/keyHygiene'
import { hasProviderApiKey, storeProviderApiKey } from './services/apiKeyStore'
import { DEFAULT_TRANSITION_PROMPT, promptForTransition } from '../shared/prompts'
import type { GenerationRequest } from './providers/types'

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
    testProjectDeletionCascade(workDir)
    testEditorSelection()
    testAnalysisWorkflow()
    testEvidenceDrivenPlanning()
    testLogicalTransitions(workDir, createdProjects)
    await testGeminiModelConfig(workDir, createdProjects)
    testTransitionRecovery()
    testPreviewSource(workDir, createdProjects)
    testSequenceReorder()
    testAnalysisSummary()
    testProjectReadiness(workDir, createdProjects)
    testImageOverrides(workDir, createdProjects)
    await testGeminiAnalyzer(workDir, createdProjects)
    await testAnalysisConfirmation(workDir, createdProjects)
    testAnalysisLedger(workDir, createdProjects)
    testGroundTruthReview(workDir, createdProjects)
    testAnalysisReview(workDir, createdProjects)
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
      'physically plausible camera movement'
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
  assert.strictEqual(firstPlan.rebuildable.length, 3, 'all three transitions are rebuildable')
  assert.strictEqual(firstPlan.preserved.length, 0, 'nothing to preserve yet')
  assert.ok(firstPlan.hasAnalysis, 'the plan knows an analysis exists')

  const firstRun = rebuildPromptsFromAnalysis(project.id)
  assert.strictEqual(firstRun.rebuiltCount, 3, 'three prompts rebuilt')
  assert.strictEqual(firstRun.preservedCount, 0, 'none preserved')

  const rebuilt = listProjects().find((p) => p.id === project.id)!
  assert.ok(rebuilt.transitions[pairs[0]].prompt.length > 0, 'a prompt was written')
  assert.strictEqual(
    rebuilt.transitions[pairs[0]].promptProvenance?.manuallyEdited,
    false,
    'a planned prompt is NOT marked as hand-written'
  )
  assert.strictEqual(rebuilt.transitions[pairs[0]].promptProvenance?.basis, 'same-room')
  assert.ok(
    rebuilt.transitions[pairs[0]].prompt.startsWith(DEFAULT_TRANSITION_PROMPT),
    'the safety prompt still leads the rebuilt wording'
  )

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
  assert.strictEqual(secondPlan.unchanged.length, 2, 'the other two are already up to date')
  assert.strictEqual(
    secondPlan.rebuildable.length + secondPlan.preserved.length + secondPlan.unchanged.length,
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
  assert.strictEqual(
    afterOverride.unchanged.length,
    3,
    'all three are up to date'
  )
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
  const press = (
    key: string,
    shiftKey: boolean,
    selection: EditorSelection,
    target: { tagName?: string; isContentEditable?: boolean; readOnly?: boolean } | null = null
  ): ShortcutAction => resolveShortcut({ key, shiftKey, target }, selection, ids)

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

  // ── 6. Shift+Arrow REORDERS, via the same indices as a drag ──────────
  assert.deepStrictEqual(
    press('ArrowRight', true, selectImage('img-b')),
    { type: 'move-image', fromIndex: 1, toIndex: 2 },
    'Shift+ArrowRight moves the selected image one position later'
  )
  assert.deepStrictEqual(
    press('ArrowLeft', true, selectImage('img-b')),
    { type: 'move-image', fromIndex: 1, toIndex: 0 },
    'and Shift+ArrowLeft one position earlier'
  )
  assert.strictEqual(
    press('ArrowRight', true, selectImage('img-d')).type,
    'none',
    'moving the last image further right does nothing rather than wrapping it to the front'
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
    rooms: [{ id: 'r', label: 'Open Plan', imageIds: ids, landmarks: [] }],
    images: ids.map((id) => ({
      imageId: id,
      roomId: 'r',
      orientation: 'unknown' as const,
      landmarks: [],
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
  const accounted = plan.rebuildable.length + plan.preserved.length + plan.unchanged.length
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
  assert.ok(
    created28.prompt.includes(DEFAULT_TRANSITION_PROMPT),
    'and its prompt still leads with the unchanged safety contract'
  )
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
    second.rebuildable.length + second.preserved.length + second.unchanged.length,
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
  assert.strictEqual(
    running.secondary,
    null,
    'Regenerate is not even offered alongside — the task is still running'
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
  for (const plan of plans) {
    const prompt = renderPrompt(plan, { fromRoom: 'Living Room', toRoom: 'Kitchen' })
    assert.ok(prompt.startsWith(DEFAULT_TRANSITION_PROMPT), 'the base prompt leads every prompt')
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
    project.transitions[key] = { prompt: '', durationSec: 2, status: 'not-generated', clip: null }
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
  const mockJob = queueGeneration(project.id, [pairB])
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

  log('seamless assembly: 2/3+ clips, mixed resolutions, all aspect ratios, overlays, no audio, H.264')
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
    badProject.transitions[pairB] = { prompt: '', durationSec: 5, status: 'not-generated', clip: null }
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
    badProject.transitions[pairB] = { prompt: '', durationSec: 5, status: 'not-generated', clip: null }
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
  const genJob = queueGeneration(project.id, [pairKey])
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

  const early = listProjects().find((p) => p.id === project.id)!
  assert.strictEqual(missingClipPairs(early).length, 3, 'N-1 = 3 transitions required')
  assert.deepStrictEqual(missingClipPairs(early), ['1 → 2', '2 → 3', '3 → 4'])

  const pairs = [0, 1, 2].map((i) => transitionKey(imported[i].id, imported[i + 1].id))
  const attached = clips.map((src) => attachClipFromPath(project.id, src, 'manual'))
  pairs.forEach((key, i) => {
    project.transitions[key] = {
      prompt: `transition ${i + 1}`,
      durationSec: 4,
      status: 'completed',
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

  const genJob = queueGeneration(genProject.id, [pairKey])
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
