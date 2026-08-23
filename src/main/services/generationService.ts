import { join } from 'node:path'
import type {
  AiProviderConfig,
  AppSettings,
  ProviderJobState,
  QueueJob,
  TransitionSettings
} from '../../shared/types'
import { NATIVE_AUDIO_DEFAULT, transitionKey } from '../../shared/types'
import { DEFAULT_PRICING, priceSnapshot } from '../../shared/pricing'
import { promptForTransition } from '../../shared/prompts'
import { getSettingsJson, listProjects, saveProject } from '../db/projectsRepo'
import { broadcastProjectUpdated } from '../events'
import { listCostEntries, recordGenerationSpend, settleGenerationSpend } from '../db/costRepo'
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
import type { GenerationRequest, SanitizedRequestPreview, VideoProvider } from '../providers/types'
import { clipUrl, projectTransitionsDir as transitionsDir } from '../files'
import { ensureDir, safeManagedPath } from '../paths'
import { probeDurationSec } from './ffmpegService'
import { enqueue, isJobCancelled, listJobs, registerRunner, updateJobProvider } from './queueService'

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
function activeProviderConfig(settings: AppSettings | null): AiProviderConfig | undefined {
  const providers = settings?.providers ?? []
  if (settings?.activeProviderId) {
    const chosen = providers.find((p) => p.id === settings.activeProviderId)
    if (chosen) return chosen
  }
  return providers[0]
}

/** Builds the provider-neutral request for one transition pair. */
export function buildGenerationRequest(
  projectId: string,
  pairKey: string,
  settings: AppSettings | null
): { ok: true; request: GenerationRequest } | { ok: false; reason: string } {
  const project = listProjects().find((p) => p.id === projectId)
  if (!project) return { ok: false, reason: 'Project no longer exists' }

  // Locate the pair in image order so START/END can never be swapped.
  let startIndex = -1
  for (let i = 0; i < project.images.length - 1; i++) {
    if (transitionKey(project.images[i].id, project.images[i + 1].id) === pairKey) {
      startIndex = i
      break
    }
  }
  if (startIndex === -1) return { ok: false, reason: `Transition ${pairKey} is not in the image sequence` }

  const startImage = project.images[startIndex]
  const endImage = project.images[startIndex + 1]
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
      // Legacy/partial settings rows may lack whole sections — never assume.
      durationSec: transition?.durationSec ?? settings?.exportDefaults?.defaultTransitionDurationSec ?? 5,
      resolution: settings?.exportDefaults?.resolution ?? '1080p',
      // Audio is never enabled implicitly — see NATIVE_AUDIO_DEFAULT.
      nativeAudio: NATIVE_AUDIO_DEFAULT,
      modelId: config?.model ?? ''
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
  const first = buildGenerationRequest(projectId, pairKeys[0], settings)
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
    model: config?.model ?? null,
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
  /** Spend after this generation, or 'unavailable' with no verified rate. */
  projectedAfterLabel: string
}

export function liveConfirmation(projectId: string, pairKey: string): LiveConfirmation | null {
  const settings = readSettings()
  const project = listProjects().find((p) => p.id === projectId)
  if (!project) return null

  const eligibility = liveEligibility(settings, 1)
  const built = buildGenerationRequest(projectId, pairKey, settings)
  const provider = createProvider(activeProviderConfig(settings), settings)
  const meta = provider.metadata()
  const model = meta.models.find((m) => m.id === (activeProviderConfig(settings)?.model ?? ''))

  // Human "Image X → Image Y" label + the exact frames, from image order.
  let label = pairKey
  let startImage: { name: string; src: string } | null = null
  let endImage: { name: string; src: string } | null = null
  for (let i = 0; i < project.images.length - 1; i++) {
    if (transitionKey(project.images[i].id, project.images[i + 1].id) === pairKey) {
      label = `Image ${i + 1} → Image ${i + 2}`
      startImage = { name: project.images[i].fileName, src: project.images[i].src }
      endImage = { name: project.images[i + 1].fileName, src: project.images[i + 1].src }
      break
    }
  }

  const price = priceSnapshot(project.images.length, settings?.pricing ?? DEFAULT_PRICING)
  // Providers bill in their own unit (fal.ai in dollars, Kling in credits);
  // only ever from a VERIFIED published rate, and never mixed with the
  // customer's project price.
  const usage = built.ok ? provider.estimateUsage(built.request) : null

  return {
    ok: eligibility.allowed && built.ok,
    reasons: built.ok ? eligibility.reasons : [...eligibility.reasons, built.reason],
    projectName: project.name,
    transitionLabel: label,
    provider: meta.label,
    model: model?.label ?? activeProviderConfig(settings)?.model ?? 'unknown',
    // What will actually be sent, after the provider's own mapping.
    durationSec: usage?.seconds ?? (built.ok ? built.request.durationSec : 0),
    resolution: usage?.resolution ?? (built.ok ? built.request.resolution : '—'),
    nativeAudio: built.ok ? built.request.nativeAudio : false,
    prompt: built.ok ? built.request.prompt : '',
    startImage,
    endImage,
    // Never invent a cost: unavailable stays unavailable.
    estimatedCostLabel: usage ? usage.label : 'unavailable',
    estimatedCostBasis: usage
      ? `${usage.seconds}s × ${usage.rateLabel} · ${usage.resolution} · audio ${usage.nativeAudio ? 'on' : 'off'}`
      : 'No verified rate for this combination.',
    customerPriceLabel: `${price.totalPrice} ${price.currency}`,
    warning:
      meta.id === 'fal'
        ? 'This sends one paid request to fal.ai.'
        : 'This action sends a paid request to Kling.',
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
  pairKeys: string[]
): { ok: true; job: QueueJob } | { ok: false; reasons: string[] } {
  const settings = readSettings()
  const eligibility = liveEligibility(settings, pairKeys.length)
  if (!eligibility.allowed) return { ok: false, reasons: eligibility.reasons }

  const job = queueGeneration(projectId, pairKeys, null)
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
  pairKey: string,
  resultUrl: string
): Promise<{ ok: true; storedName: string } | { ok: false; reason: string }> {
  const dir = transitionsDir(projectId)
  ensureDir(dir)
  const storedName = `${randomUUID()}.mp4`
  const target = safeManagedPath(dir, storedName)

  const fetched = await provider.fetchResult(resultUrl, target)
  if (!fetched.ok) {
    rmSync(target, { force: true })
    return { ok: false, reason: fetched.error.message }
  }

  const valid = validateDownloadedClip(target)
  if (!valid.ok) {
    rmSync(target, { force: true })
    return { ok: false, reason: valid.reason }
  }

  const project = listProjects().find((p) => p.id === projectId)
  if (!project) {
    rmSync(target, { force: true })
    return { ok: false, reason: 'Project no longer exists' }
  }
  // The clip source records WHICH provider produced it, but the structure is
  // the SAME one Attach Test Clip uses — one output type, no special cases.
  const providerId = provider.metadata().id
  const source: 'kling' | 'fal' = providerId === 'fal' ? 'fal' : 'kling'
  const current = project.transitions[pairKey]
  project.transitions[pairKey] = {
    ...(current ?? { prompt: '', durationSec: 5, status: 'not-generated', clip: null }),
    status: 'completed',
    clip: {
      storedName,
      originalName: `${source}-generation.mp4`,
      source,
      src: clipUrl(projectId, storedName)
    }
  }
  project.updatedAt = Date.now()
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
  for (let i = 0; i < project.images.length - 1; i++) {
    if (transitionKey(project.images[i].id, project.images[i + 1].id) === pairKey) {
      return `Image ${i + 1} → Image ${i + 2}`
    }
  }
  return pairKey
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
  if (!project || !config || project.images.length < 2) return { amount: 0, currency: 'USD' }
  try {
    const provider = createProvider(config, settings)
    const key = transitionKey(project.images[0].id, project.images[1].id)
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

async function runLiveTransition(
  provider: VideoProvider,
  job: QueueJob,
  pairKey: string,
  request: GenerationRequest,
  ctx: { onProgress: (pct: number) => void }
): Promise<{ ok: true } | { ok: false; endpointUnverified?: true; reason: string }> {
  const action = resolveGenerationAction(job.provider)
  const label = provider.metadata().label
  let taskId = job.provider?.providerTaskId ?? null

  if (action === 'submit') {
    const submitted = await provider.submitGeneration(request)
    if (!submitted.ok) return { ok: false, reason: submitted.error.message }

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
        providerMeta: submitted.meta,
        dryRun: false
      })
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
  const attached = await downloadAndAttachResult(provider, job.projectId, pairKey, resultUrl)
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
  const action = resolveGenerationAction(job.provider)
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
    const outcome = await runLiveTransition(provider, job, pairKey, built.request, ctx)
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
