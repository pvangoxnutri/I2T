import { join } from 'node:path'
import type { AppSettings, QueueJob } from '../../shared/types'
import { NATIVE_AUDIO_DEFAULT } from '../../shared/types'
import { DEFAULT_PRICING, priceSnapshot } from '../../shared/pricing'
import { getSettingsJson, listProjects, saveProject } from '../db/projectsRepo'
import { broadcastProjectUpdated } from '../events'
import { projectImagesDir } from '../paths'
import { createProvider } from '../providers/registry'
import {
  clampDurationForModel,
  falRunCost,
  FAL_MODEL_REGISTRY,
  resolveFalModel
} from '../providers/fal/falModels'
import type { GenerationRequest, GenerationSubject } from '../providers/types'
import { enqueue, listJobs, registerRunner } from './queueService'
import { activeProviderConfig, liveEligibility, runLiveGenerationJob } from './generationService'
import { getGenerationsForMotion } from '../db/generationCatalogueRepo'
import {
  motionSegments,
  motionSegmentLabel,
  MOTION_LABEL,
  MOTION_TYPES,
  type MotionSegment,
  type MotionType
} from '../../shared/motionSegment'
import { buildMotionPrompt, motionPromptSummary } from '../../shared/motionPrompt'
import {
  motionGenerationReadiness,
  type MotionGenerationReadiness
} from '../../shared/motionGenerationReadiness'
import { getFeedImages } from '../../shared/feedSequence'
import { motionRunState, reconciledMotionStatus } from '../../shared/motionRunState'
import type { MotionConfirmation } from '../../shared/motionConfirmation'

/**
 * PAID GENERATION FOR ONE PHOTOGRAPH IN MOTION.
 *
 * ── WHAT IS REUSED, AND WHY ──────────────────────────────────────────
 *
 * Everything that costs money or can lose track of money: the model
 * registry, the fal upload, the submit/poll/download lifecycle, the
 * idempotency state machine, the cost ledger, the queue. Those live in
 * `generationService` and this module CALLS them — it does not
 * reimplement them. A second copy of the submit path would be a second
 * place for a double-charge guard to go missing.
 *
 * ── WHAT IS SEPARATE, AND WHY ────────────────────────────────────────
 *
 * Identity. A motion run names its SEGMENT; a transition names its PAIR.
 * There is no synthesised pairKey anywhere below, so nothing downstream
 * can parse a motion job as `from->to` and conclude that a room connects
 * to itself.
 */

function readSettings(): AppSettings | null {
  const json = getSettingsJson()
  return json ? (JSON.parse(json) as AppSettings) : null
}

// The canonical resolver, imported rather than reimplemented: which
// provider is active must have exactly one answer in this codebase.
const activeConfig = activeProviderConfig

function findSegment(projectId: string, segmentId: string): MotionSegment | null {
  const project = listProjects().find((p) => p.id === projectId)
  if (!project) return null
  return motionSegments(project).find((s) => s.id === segmentId) ?? null
}

/** The model the newest generation of THIS segment used, if any. */
function previousMotionModel(projectId: string, segmentId: string): string | null {
  try {
    return getGenerationsForMotion(projectId, segmentId)[0]?.model ?? null
  } catch {
    return null
  }
}

// The shape lives in shared/motionConfirmation — see the note there.
export type { MotionConfirmation }

/**
 * Everything the confirmation dialog needs. FREE — reading it sends
 * nothing and uploads nothing.
 *
 * Asked again each time the model or the duration changes, so the number
 * on screen is always the number that model will charge for that length.
 */
export function motionConfirmation(
  projectId: string,
  segmentId: string,
  modelIdOverride?: string | null,
  durationOverride?: number | null,
  /**
   * The movement THIS run should use.
   *
   * A per-run choice, exactly like the model and the duration. It does
   * not touch the stored segment and it does not touch any previous
   * generation: those keep the motion they were actually made with.
   */
  motionOverride?: MotionType | null
): MotionConfirmation | null {
  const project = listProjects().find((p) => p.id === projectId)
  if (!project) return null
  const segment = motionSegments(project).find((s) => s.id === segmentId)
  if (!segment) return null

  const settings = readSettings()
  // THE SAME EVALUATOR AND THE SAME RUN STATE THE SUBMIT PATH USES. A
  // dialog that opens for a run the submit path will refuse is a dialog
  // nobody can trust — and one that refuses on a stale marker is worse.
  const readiness = motionGenerationReadiness(
    segment,
    FAL_MODEL_REGISTRY,
    motionRunState(segment, listJobs())
  )

  const feed = getFeedImages(project)
  const index = feed.findIndex((i) => i.id === segment.imageId)
  const image = feed[index] ?? null

  const history = (() => {
    try {
      return getGenerationsForMotion(projectId, segmentId)
    } catch {
      return []
    }
  })()

  // ── THE MOVEMENT THIS RUN WILL USE ──────────────────────────────────
  //
  // The operator's choice for this run, else what the segment currently
  // holds. The stored segment is NOT written here: choosing a different
  // movement in the dialog and then cancelling must leave everything
  // exactly as it was.
  const runMotion = motionOverride ?? segment.motion

  // Built from the RUN's movement, not the stored one, so the preview is
  // the text that will actually be sent. This is the whole of "the
  // prompt follows the motion": there is no second place where a prompt
  // for a motion is composed.
  const runPrompt = buildMotionPrompt(runMotion)

  // What the CURRENT clip was actually made with, for the dialog's
  // "previous generation" line. Read from history — never inferred from
  // the segment, which the next successful run will move on.
  const previous = history[0] ?? null

  const base = {
    segmentId,
    label: motionSegmentLabel({ ...segment, motion: runMotion }),
    motion: runMotion,
    motionLabel: MOTION_LABEL[runMotion],
    motionSummary: motionPromptSummary(runMotion),
    motionOptions: MOTION_TYPES.map((m) => ({ id: m, label: MOTION_LABEL[m] })),
    imageLabel: index >= 0 ? `IMAGE ${String(index + 1).padStart(2, '0')}` : 'IMAGE (not in feed)',
    imageName: image?.fileName ?? 'Unknown',
    imageSrc: image?.src ?? null,
    prompt: runPrompt,
    attemptNumber: history.length + 1,
    isRegeneration: history.length > 0,
    previous: previous
      ? {
          motion: (previous.motionType as MotionType | null) ?? null,
          motionLabel: previous.motionType
            ? (MOTION_LABEL[previous.motionType as MotionType] ?? previous.motionType)
            : 'Unknown',
          model: previous.model,
          // The length the previous run actually produced, read off its
          // own row rather than borrowed from the segment.
          durationSec: previous.durationSec ?? null,
          createdAt: previous.createdAt
        }
      : null
  }

  if (!readiness.ok) {
    return {
      ...base,
      ok: false,
      reason: readiness.reason,
      models: [],
      modelId: '',
      modelDurations: [],
      modelAudioSupport: false,
      durationSec: segment.durationSec,
      nativeAudio: NATIVE_AUDIO_DEFAULT,
      estimatedCostLabel: 'unavailable',
      estimatedCost: null,
      priceUnavailableReason: readiness.reason
    }
  }

  // ── WHERE THE DIALOG STARTS ─────────────────────────────────────────
  //
  // An explicit choice, then the model the LAST attempt used, then the
  // global default — but always narrowed to a model that can actually do
  // a single image. A regeneration therefore begins from what was
  // actually tried, and switching is a deliberate act.
  const capable = readiness.models
  const preferred =
    modelIdOverride ?? previousMotionModel(projectId, segmentId) ?? activeConfig(settings)?.model
  const chosen = capable.find((m) => m.id === preferred) ?? capable[0]
  const entry = resolveFalModel(chosen.id)

  // The duration THIS model accepts, nearest to what was asked for — so
  // the price quoted is the price of the run that will happen.
  const runSeconds = clampDurationForModel(entry, durationOverride ?? segment.durationSec)
  const cost = falRunCost(entry, runSeconds, NATIVE_AUDIO_DEFAULT)

  return {
    ...base,
    ok: true,
    models: capable.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      durationsSec: m.durationsSec,
      audioSupport: resolveFalModel(m.id).audioSupport,
      confirmed: m.confirmed
    })),
    modelId: chosen.id,
    modelDurations: entry.durationsSec,
    modelAudioSupport: entry.audioSupport,
    durationSec: runSeconds,
    // Audio is never enabled implicitly — it costs 50 % more per second.
    nativeAudio: NATIVE_AUDIO_DEFAULT,
    // Rounded to cents by `falRunCost` itself, so 0.07 × 5 reads as
    // $0.35 rather than the float that arithmetic actually produces.
    estimatedCostLabel: cost === null ? 'unavailable' : `$${cost.usd.toFixed(2)}`,
    estimatedCost: cost?.usd ?? null,
    priceUnavailableReason:
      cost === null ? 'No verified fal.ai rate for this model and duration.' : null
  }
}

/**
 * The provider-neutral request for one motion clip.
 *
 * No `endImagePath` and no meaningful `pairKey`: the SUBJECT is what
 * identifies this run, and the provider reads that to decide which of
 * its two valid body shapes to build.
 */
export function buildMotionGenerationRequest(
  projectId: string,
  segmentId: string,
  settings: AppSettings | null,
  modelIdOverride?: string | null,
  durationOverride?: number | null,
  /** The movement this run uses. See `motionConfirmation`. */
  motionOverride?: MotionType | null
): { ok: true; request: GenerationRequest } | { ok: false; reason: string } {
  const project = listProjects().find((p) => p.id === projectId)
  if (!project) return { ok: false, reason: 'Project no longer exists' }
  const segment = motionSegments(project).find((s) => s.id === segmentId)
  if (!segment) return { ok: false, reason: 'That motion clip no longer exists.' }

  const image = project.images.find((i) => i.id === segment.imageId)
  if (!image) {
    return { ok: false, reason: 'The photograph this motion clip was made from is gone.' }
  }

  // NO run state here, deliberately. This is called BY the runner for the
  // job that owns the segment, and passing one would let the lock the
  // queue set for this very job refuse it — the deadlock this whole pass
  // exists to remove. Whether a run is ALLOWED is decided once, in
  // `queueMotionGeneration`, before anything is queued.
  const readiness = motionGenerationReadiness(segment, FAL_MODEL_REGISTRY)
  if (!readiness.ok) return { ok: false, reason: readiness.reason }

  const preferred =
    modelIdOverride ?? previousMotionModel(projectId, segmentId) ?? activeConfig(settings)?.model
  const chosen = readiness.models.find((m) => m.id === preferred) ?? readiness.models[0]
  const entry = resolveFalModel(chosen.id)

  // ── THE MOVEMENT AND ITS PROMPT TRAVEL TOGETHER ─────────────────────
  //
  // The prompt is BUILT from the run's movement rather than read off the
  // segment. Reading the stored prompt would send a Pan Right sentence
  // for a run the operator switched to Smooth Forward — the exact
  // mismatch that makes a paid clip useless — because the segment's
  // prompt is only ever the one for its own stored motion.
  const runMotion = motionOverride ?? segment.motion
  const runPrompt = buildMotionPrompt(runMotion)

  return {
    ok: true,
    request: {
      projectId: project.id,
      // The identity of this run. Not a pair, and not pretending to be.
      // `motion` is the RUN's movement, so the catalogue row this
      // produces records what was actually asked for.
      subject: {
        kind: 'motion',
        segmentId: segment.id,
        imageId: segment.imageId,
        motion: runMotion
      },
      // Present because the field is required by the shared shape, and
      // deliberately EMPTY: nothing may parse it as `from->to`.
      pairKey: '',
      startImagePath: join(projectImagesDir(project.id), image.storedName),
      // No end frame. Not the start frame again, not an empty string
      // standing in for a path — genuinely absent.
      endImagePath: null,
      startImageName: image.fileName,
      endImageName: null,
      prompt: runPrompt,
      durationSec: clampDurationForModel(entry, durationOverride ?? segment.durationSec),
      resolution: settings?.exportDefaults?.resolution ?? '1080p',
      nativeAudio: NATIVE_AUDIO_DEFAULT,
      modelId: chosen.id
    }
  }
}

export type MotionSubmitResult =
  | { ok: true; jobId: string }
  | { ok: false; reason: string }

/**
 * Queue ONE paid single-image motion run.
 *
 * The model is required, not defaulted: this is the choke point the
 * operator's rule names — no paid single-image submission may happen
 * without a model having been selected in the confirmation.
 */
export function queueMotionGeneration(input: {
  projectId: string
  segmentId: string
  modelId: string
  durationSec: number
  /** The movement THIS run uses. Absent keeps the segment’s own. */
  motion?: MotionType
}): MotionSubmitResult {
  const project = listProjects().find((p) => p.id === input.projectId)
  if (!project) return { ok: false, reason: 'Project no longer exists' }

  const segment = motionSegments(project).find((s) => s.id === input.segmentId)
  if (!segment) return { ok: false, reason: 'That motion clip no longer exists.' }

  // ── THE DOUBLE-SUBMIT GUARD, KEYED TO A REAL JOB ──────────────────
  //
  // This is the ONE place that decides whether a paid run may start, and
  // it decides from the queue, not from a stored word. A live job blocks;
  // a terminal, missing or cancelled one does not — so a lock can never
  // outlive the work it was protecting.
  const runState = motionRunState(segment, listJobs())
  if (runState.kind === 'running' || runState.kind === 'recoverable') {
    const blocked = motionGenerationReadiness(segment, FAL_MODEL_REGISTRY, runState)
    return { ok: false, reason: blocked.ok ? 'This motion clip is already running.' : blocked.reason }
  }

  // ── MODEL SELECTION IS MANDATORY ──────────────────────────────────
  //
  // Not "fall back to the default": a single-image run on a model that
  // cannot do single images is a rejected request the operator has
  // already been charged the attention for. An unselected or incapable
  // model refuses here, before anything is uploaded.
  const readiness = motionGenerationReadiness(segment, FAL_MODEL_REGISTRY)
  if (!readiness.ok) return { ok: false, reason: readiness.reason }
  const chosen = readiness.models.find((m) => m.id === input.modelId)
  if (!chosen) {
    return {
      ok: false,
      reason:
        'Choose a model that supports single-image generation before generating. ' +
        `Available: ${readiness.models.map((m) => m.displayName).join(', ')}.`
    }
  }

  const settings = readSettings()
  const eligibility = liveEligibility(settings, 1)
  if (!eligibility.allowed) {
    return { ok: false, reason: `Live generation refused: ${eligibility.reasons.join(' ')}` }
  }

  const built = buildMotionGenerationRequest(
    input.projectId,
    input.segmentId,
    settings,
    input.modelId,
    input.durationSec,
    input.motion
  )
  if (!built.ok) return built

  const config = activeConfig(settings)
  const provider = createProvider(config, settings)
  const entry = resolveFalModel(chosen.id)
  const runSeconds = clampDurationForModel(entry, input.durationSec)

  // ── THE SEGMENT ADOPTS THE RUN'S CHOICES ──────────────────────────
  //
  // Motion, length and prompt move to what THIS run will use, so the
  // timeline and the inspector describe the clip being made rather than
  // the one being replaced. Nothing here touches history: previous
  // generations keep their own motion, model, duration and prompt on
  // their own rows, which is what makes a regeneration a new fact
  // instead of a rewrite of an old one.
  const runMotion = input.motion ?? segment.motion
  project.motionSegments = motionSegments(project).map((s) =>
    s.id === input.segmentId
      ? {
          ...s,
          status: 'queued' as const,
          motion: runMotion,
          durationSec: runSeconds,
          prompt: buildMotionPrompt(runMotion)
        }
      : s
  )
  project.updatedAt = Date.now()
  saveProject(project)
  broadcastProjectUpdated(project.id)

  const job: QueueJob = enqueue({
    projectId: project.id,
    projectName: project.name,
    kind: 'motion-generation',
    // One clip. Counted as one so the queue's own arithmetic stays true.
    transitionCount: 1,
    price: priceSnapshot(project.images.length, settings?.pricing ?? DEFAULT_PRICING),
    scheduledFor: null,
    metadata: {
      mock: (config?.id ?? 'mock') === 'mock',
      // Self-describing, so this job still runs after a restart — and so
      // the queue row can say what it is without consulting the project.
      motionSegmentId: segment.id,
      motionImageId: segment.imageId,
      // The RUN's movement, so the queue row and the runner agree with
      // the dialog even if the segment is edited afterwards.
      motionType: runMotion,
      motionDurationSec: runSeconds,
      provider: config?.id ?? 'mock',
      model: chosen.id
    },
    provider: {
      provider: config?.id ?? 'mock',
      model: chosen.id,
      dryRun: config?.mode !== 'live',
      providerTaskId: null,
      providerStatus: null,
      submittedAt: null,
      lastPolledAt: null,
      providerMeta: null,
      estimatedCost: provider.estimateCost(built.request),
      actualCost: null,
      estimatedCredits: provider.estimateUsage(built.request)?.credits ?? null,
      actualCredits: null,
      retryCount: 0
    }
  })

  console.log(
    `[motion] queued ${segment.id} (${segment.motion}) on ${chosen.displayName} ` +
      `${runSeconds}s — job ${job.id}`
  )
  return { ok: true, jobId: job.id }
}

/**
 * THE RUNNER.
 *
 * Deliberately thin: it resolves the segment, builds the request and
 * hands the whole paid lifecycle to `runLiveGenerationJob` — the same
 * function a transition goes through. Everything that could lose a paid
 * task or double-charge one lives there, in one place, for both.
 */
registerRunner('motion-generation', async (job, ctx) => {
  const segmentId = job.metadata.motionSegmentId
  if (!segmentId) throw new Error('This motion job carries no segment id.')

  const settings = readSettings()
  const config = activeConfig(settings)
  const provider = createProvider(config, settings)
  const dryRun = job.provider?.dryRun ?? config?.mode !== 'live'

  const segment = findSegment(job.projectId, segmentId)
  if (!segment) throw new Error('That motion clip was removed before the job ran.')

  // ── THE JOB IS THE RECORD OF WHAT WAS AGREED ──────────────────────
  //
  // Movement and length come from the JOB's own metadata, not from the
  // segment. The segment is live state the operator can edit while a job
  // waits in the queue; reading it here would mean a queued 10s Smooth
  // Forward could quietly run as a 5s Pan Right because someone touched
  // the inspector afterwards. The job carries what was confirmed and
  // paid for, and that is what runs.
  const built = buildMotionGenerationRequest(
    job.projectId,
    segmentId,
    settings,
    job.provider?.model ?? job.metadata.model ?? null,
    job.metadata.motionDurationSec ?? segment.durationSec,
    (job.metadata.motionType as MotionType | undefined) ?? segment.motion
  )
  if (!built.ok) throw new Error(built.reason)

  const configCheck = provider.validateConfiguration(built.request.modelId)
  if (!configCheck.ok) throw new Error(configCheck.error.message)
  const valid = provider.validateRequest(built.request)
  if (!valid.ok) throw new Error(valid.error.message)

  if (dryRun) {
    // Validate and build only. No client method is reachable from here,
    // so no request and no upload can escape.
    const result = provider.dryRun(built.request)
    if ('error' in result) throw new Error(result.error.message)
    ctx.onProgress(100)
    // A dry run produces no media, and says so rather than pretending.
    markStatus(job.projectId, segmentId, 'not-generated')
    return { note: `Dry run — ${motionSegmentLabel(segment)} was built and validated, not sent.` }
  }

  // Re-checked HERE in main; the renderer is never trusted for this.
  const eligibility = liveEligibility(settings, 1)
  if (!eligibility.allowed) {
    throw new Error(`Live generation refused: ${eligibility.reasons.join(' ')}`)
  }

  markStatus(job.projectId, segmentId, 'generating')

  const subject: GenerationSubject = {
    kind: 'motion',
    segmentId,
    imageId: segment.imageId,
    motion: segment.motion
  }
  const outcome = await runLiveGenerationJob(provider, job, subject, built.request, ctx)
  if (!outcome.ok) {
    // Left as failed rather than silently reverted: the operator needs to
    // see that a paid attempt happened and did not deliver.
    markStatus(job.projectId, segmentId, 'failed')
    throw new Error(outcome.reason)
  }

  ctx.onProgress(100)
  return { note: `${motionSegmentLabel(segment)} generated.` }
})

/**
 * RECONCILE EVERY MOTION SEGMENT AGAINST THE QUEUE.
 *
 * Run at startup, before the window opens. A stored status is a cache of
 * `motionRunState`, and a cache written by a process that was killed —
 * or by the deadlock this pass removed — can disagree with the queue
 * indefinitely. This is what makes "already running" unable to survive
 * the thing it was describing.
 *
 * It is careful about money in exactly one way: a segment whose job
 * holds a real provider task id reconciles to `generating`, never to
 * `not-generated`, so a PAID task is never made to look like an
 * un-started run that Generate should pay for a second time.
 */
export function reconcileMotionSegments(): { checked: number; repaired: string[] } {
  const jobs = listJobs()
  const repaired: string[] = []
  let checked = 0

  for (const project of listProjects()) {
    const segments = motionSegments(project)
    if (segments.length === 0) continue

    let changed = false
    const next = segments.map((s) => {
      checked++
      const should = reconciledMotionStatus(s, jobs)
      if (should === s.status) return s
      changed = true
      const owning = jobs.find(
        (j) => j.kind === 'motion-generation' && j.metadata?.motionSegmentId === s.id
      )
      repaired.push(
        `${motionSegmentLabel(s)} ${s.status} → ${should}` +
          (owning ? ` (job ${owning.id} is ${owning.status})` : ' (no job exists)')
      )
      return { ...s, status: should }
    })

    if (changed) {
      project.motionSegments = next
      project.updatedAt = Date.now()
      saveProject(project)
      broadcastProjectUpdated(project.id)
    }
  }

  if (repaired.length > 0) {
    console.log(`[motion] reconciled ${repaired.length} stale segment status:`)
    for (const line of repaired) console.log(`  ${line}`)
  }
  return { checked, repaired }
}

function markStatus(projectId: string, segmentId: string, status: MotionSegment['status']): void {
  const project = listProjects().find((p) => p.id === projectId)
  if (!project) return
  project.motionSegments = motionSegments(project).map((s) =>
    s.id === segmentId ? { ...s, status } : s
  )
  project.updatedAt = Date.now()
  saveProject(project)
  broadcastProjectUpdated(projectId)
}

export type { MotionGenerationReadiness }
