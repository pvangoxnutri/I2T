import { emptyAnalysis, type PropertyAnalysis } from '../../shared/propertyAnalysis'
import { analysisInstructionPreview } from '../../shared/analysisPrompt'
import {
  ALL_CAPABILITIES,
  type AnalyzerCostEstimate,
  type AnalyzerDebugPreview,
  type AnalyzerMetadata,
  type AnalyzerRequest,
  type AnalyzerResult,
  type AnalyzerValidation
} from '../../shared/analyzerTypes'
import { GeminiPropertyAnalyzer } from './providers/gemini/GeminiPropertyAnalyzer'
import { GEMINI_DEFAULT_MODEL } from './providers/gemini/geminiConfig'
import type { FetchLike } from './providers/gemini/GeminiClient'

/**
 * Whole-property analyzers.
 *
 * ── THE SEAM ─────────────────────────────────────────────────────────
 *
 * Whichever vision model we eventually pick produces a `PropertyAnalysis`
 * and nothing downstream changes: the scene graph, the prompt planner and
 * the editor all read the domain model, never a provider. Vendor code
 * lives in its own file behind this interface.
 *
 * ── NOTHING HERE CALLS ANYTHING ──────────────────────────────────────
 *
 * No implementation in this folder performs network I/O. `available` is
 * false for anything unimplemented, and the IPC layer refuses to run an
 * analyzer that is unavailable or reports `incursCost` — so a half-written
 * adapter cannot be reached by accident.
 *
 * ── AN ANALYZER PROPOSES ─────────────────────────────────────────────
 *
 * It never owns the analysis. Output arrives as a DRAFT and is compared
 * against the accepted state before anything replaces it, because an
 * accepted analysis usually contains corrections a person made by hand.
 */
export interface PropertyAnalyzer {
  metadata(): AnalyzerMetadata
  /** Refuses work the provider cannot do — image count, size, capability. */
  validateInput(request: AnalyzerRequest): AnalyzerValidation
  /** Null when the provider publishes no verified rate. Never guessed. */
  estimateCost(request: AnalyzerRequest): AnalyzerCostEstimate | null
  /** Credential-free, path-free rendering of what would be sent. */
  sanitizeDebugPreview(request: AnalyzerRequest): AnalyzerDebugPreview
  analyzeProperty(request: AnalyzerRequest): Promise<AnalyzerResult>
}

const LOCAL_CAPABILITIES = {
  roomDetection: false,
  landmarkDetection: false,
  openingDetection: false,
  adjacencyInference: false,
  orientationEstimation: false,
  overlapDetection: false,
  incursCost: false,
  supportsMultipleImages: true,
  maxImages: null,
  maxImageBytes: null
}

/** Shared preview builder — no credentials, no filesystem paths, ever. */
function previewFor(
  meta: AnalyzerMetadata,
  request: AnalyzerRequest,
  warnings: string[]
): AnalyzerDebugPreview {
  return {
    analyzer: meta.id,
    provider: meta.provider,
    model: meta.model,
    imageCount: request.images.length,
    capabilities: request.capabilities,
    instruction: analysisInstructionPreview(request.images.length),
    warnings
  }
}

/**
 * The analyzer that is actually shipped: it proposes NOTHING.
 *
 * It exists so the interface has a real, exercised implementation and so
 * the UI can describe the current state honestly — "analysis is manual"
 * is a supported answer, not a missing feature. Returning the operator's
 * analysis untouched is also the contract every future analyzer must
 * respect: never destroy what a human entered.
 */
export class ManualPropertyAnalyzer implements PropertyAnalyzer {
  metadata(): AnalyzerMetadata {
    return {
      id: 'manual',
      displayName: 'Manual',
      provider: 'local',
      model: null,
      description:
        'Rooms and connections are entered by hand. No AI is called and nothing is charged.',
      capabilities: LOCAL_CAPABILITIES,
      available: true
    }
  }

  validateInput(request: AnalyzerRequest): AnalyzerValidation {
    return request.images.length === 0
      ? { ok: false, reasons: ['The project has no images.'] }
      : { ok: true }
  }

  estimateCost(request: AnalyzerRequest): AnalyzerCostEstimate | null {
    return {
      amount: 0,
      currency: 'USD',
      basis: `Local — ${request.images.length} images, nothing is sent or charged.`
    }
  }

  sanitizeDebugPreview(request: AnalyzerRequest): AnalyzerDebugPreview {
    return previewFor(this.metadata(), request, [
      'Manual analyzer — the instruction below is not sent anywhere.'
    ])
  }

  async analyzeProperty(request: AnalyzerRequest): Promise<AnalyzerResult> {
    const base = request.existing ?? emptyAnalysis(request.projectId)
    return {
      ok: true,
      analysis: { ...base, source: 'manual', analyzerId: 'manual', state: 'draft' },
      notes: ['Manual analyzer — the existing analysis was returned unchanged.']
    }
  }
}

/**
 * A deterministic stand-in for tests and for exercising the review
 * workflow without a provider.
 *
 * Deliberately unambitious: every image into one room, and NO adjacency
 * claimed. A mock that invented plausible-looking connections would let a
 * bug in the "unknown relationship" path pass unnoticed — which is the
 * exact path that protects a customer's video from a fabricated doorway.
 */
export class MockPropertyAnalyzer implements PropertyAnalyzer {
  metadata(): AnalyzerMetadata {
    return {
      id: 'mock',
      displayName: 'Mock (development)',
      provider: 'local',
      model: null,
      description:
        'Deterministic fixture analyzer for exercising the review workflow. Calls nothing, costs nothing, and understands nothing about the property.',
      capabilities: { ...LOCAL_CAPABILITIES, roomDetection: true },
      available: true,
      // Kept OUT of the normal analyzer list. It produced an accepted
      // "analysis" of thirty photographs in one unnamed room, which the
      // planner then turned into twenty-nine identical camera moves —
      // useful for exercising the workflow, dangerous as production input.
      developerOnly: true
    }
  }

  validateInput(request: AnalyzerRequest): AnalyzerValidation {
    return request.images.length === 0
      ? { ok: false, reasons: ['The project has no images.'] }
      : { ok: true }
  }

  estimateCost(request: AnalyzerRequest): AnalyzerCostEstimate | null {
    return {
      amount: 0,
      currency: 'USD',
      basis: `Local — ${request.images.length} images, nothing is sent or charged.`
    }
  }

  sanitizeDebugPreview(request: AnalyzerRequest): AnalyzerDebugPreview {
    return previewFor(this.metadata(), request, [
      'Mock analyzer — deterministic output, nothing is sent.'
    ])
  }

  async analyzeProperty(request: AnalyzerRequest): Promise<AnalyzerResult> {
    if (request.images.length === 0) return { ok: false, reason: 'No images to analyse.' }
    const base = request.existing ?? emptyAnalysis(request.projectId)
    return {
      ok: true,
      analysis: {
        ...base,
        source: 'mock',
        analyzerId: 'mock',
        state: 'draft',
        rooms: [
          {
            id: 'mock-room',
            label: 'Unsorted',
            imageIds: request.images.map((i) => i.imageId),
            landmarks: [],
            confidence: 'unknown'
          }
        ],
        images: request.images.map((i) => ({
          imageId: i.imageId,
          roomId: 'mock-room',
          roomConfidence: 'unknown' as const,
          orientation: 'unknown' as const,
          landmarks: [],
          openings: [],
          overlapWith: []
        })),
        // No edges: a fixture must not manufacture adjacency it cannot see.
        edges: [],
        transitionHints: []
      },
      notes: [
        'Mock analyzer — all images placed in one room. No connections were claimed, so every transition will use the base safety prompt.'
      ]
    }
  }
}

/**
 * The analyzer registry — the same shape as the video provider registry.
 *
 * A future OpenAI/Gemini/Claude/local-model analyzer registers here and
 * becomes selectable without a single change to the editor or the domain
 * model. Until one is implemented AND verified, `available: false` keeps
 * it visible but unrunnable.
 */
export function availableAnalyzers(settings?: AnalyzerRuntime): PropertyAnalyzer[] {
  const list: PropertyAnalyzer[] = [new ManualPropertyAnalyzer(), new MockPropertyAnalyzer()]
  // Gemini is constructed from settings, so its key, model, mode and
  // safety lock travel WITH the instance. There is no ambient state a
  // caller could forget to pass, and an analyzer built without a lock
  // simply cannot send.
  list.push(
    new GeminiPropertyAnalyzer({
      apiKey: settings?.apiKey ?? '',
      model: settings?.model ?? GEMINI_DEFAULT_MODEL,
      live: settings?.mode === 'live',
      allowLive: settings?.allowLive ?? false,
      fetchImpl: settings?.fetchImpl
    })
  )
  return list
}

/** What an analyzer instance needs to exist. Supplied by the caller. */
export interface AnalyzerRuntime {
  apiKey?: string
  model?: string
  mode?: 'dry-run' | 'live'
  allowLive?: boolean
  /** Test seam — a mock transport. Never set in production code. */
  fetchImpl?: FetchLike
}

export function analyzerById(id: string, settings?: AnalyzerRuntime): PropertyAnalyzer | null {
  return availableAnalyzers(settings).find((a) => a.metadata().id === id) ?? null
}

/**
 * Providers we intend to support, advertised so Settings can show the
 * roadmap honestly rather than pretending the list is complete.
 * `available: false` — the IPC layer refuses to run them.
 */
export function plannedAnalyzers(): AnalyzerMetadata[] {
  const planned = (id: string, displayName: string, provider: string): AnalyzerMetadata => ({
    id,
    displayName,
    provider,
    model: null,
    description: 'Not implemented in this build. No key is stored and no request can be sent.',
    capabilities: {
      roomDetection: true,
      landmarkDetection: true,
      openingDetection: true,
      adjacencyInference: true,
      orientationEstimation: true,
      overlapDetection: true,
      incursCost: true,
      supportsMultipleImages: true,
      maxImages: null,
      maxImageBytes: null
    },
    available: false
  })
  // Gemini is no longer planned — it is implemented, and appears in
  // `availableAnalyzers`. These remain the roadmap.
  return [
    planned('openai-vision', 'OpenAI vision', 'openai'),
    planned('claude-vision', 'Claude vision', 'anthropic')
  ]
}

export { ALL_CAPABILITIES }
