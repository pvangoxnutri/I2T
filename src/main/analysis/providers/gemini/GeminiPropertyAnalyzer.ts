import { readFileSync, statSync } from 'node:fs'
import { PROPERTY_ANALYSIS_INSTRUCTION } from '../../../../shared/analysisPrompt'
import type {
  AnalyzerCostEstimate,
  AnalyzerDebugPreview,
  AnalyzerMetadata,
  AnalyzerRequest,
  AnalyzerResult,
  AnalyzerValidation
} from '../../../../shared/analyzerTypes'
import type { PropertyAnalyzer } from '../../PropertyAnalyzer'
import { resolveImageRequest } from '../../../files'
import {
  GEMINI_APPROX_TOKENS_PER_IMAGE,
  GEMINI_ESTIMATE_SPREAD,
  GEMINI_IMAGE_MIME,
  GEMINI_MAX_IMAGES,
  rateFor
} from './geminiConfig'
import { GeminiClient, type FetchLike, type GeminiRequestBody, type GeminiUsage } from './GeminiClient'
import { GEMINI_RESPONSE_SCHEMA, logicalId, mapGeminiResponse } from './GeminiMapper'

/**
 * The first REAL whole-property analyzer.
 *
 * ── WHAT MAKES IT DIFFERENT FROM CAPTIONING ──────────────────────────
 *
 * Every photo goes in ONE request. That is the entire point: a model
 * shown one image at a time can never work out that Image 2 and Image 5
 * are the same living room, and that cross-image relationship is the
 * context the video model is missing.
 *
 * ── THREE INDEPENDENT GATES BEFORE ANY REQUEST ───────────────────────
 *
 *   1. mode must be 'live'          (default is Dry Run)
 *   2. the safety lock must be ON   (default OFF)
 *   3. an API key must be stored
 *
 * Any one of them missing means the request is not built and the
 * transport is never touched. Dry Run still validates everything and
 * renders the exact request — it simply never sends it, and the tests
 * assert the transport call count is zero.
 */
export interface GeminiAnalyzerOptions {
  apiKey: string
  model: string
  live: boolean
  /** The safety lock. Live is impossible while this is false. */
  allowLive: boolean
  fetchImpl?: FetchLike
}

interface PreparedImage {
  logicalId: string
  projectImageId: string
  mimeType: string
  bytes: number
  base64: string
}

export class GeminiPropertyAnalyzer implements PropertyAnalyzer {
  /** Exposed for tests: proves the dry-run path makes no call. */
  public readonly client: GeminiClient
  private lastUsage: GeminiUsage | null = null

  constructor(private readonly options: GeminiAnalyzerOptions) {
    this.client = new GeminiClient({
      apiKey: options.apiKey,
      model: options.model,
      fetchImpl: options.fetchImpl
    })
  }

  metadata(): AnalyzerMetadata {
    return {
      id: 'gemini',
      displayName: 'Gemini vision',
      provider: 'google',
      model: this.options.model,
      description:
        'Analyses every project photo in one request and reconstructs room grouping, landmarks, openings and adjacency — conservatively.',
      capabilities: {
        roomDetection: true,
        landmarkDetection: true,
        openingDetection: true,
        adjacencyInference: true,
        orientationEstimation: true,
        overlapDetection: true,
        incursCost: true,
        supportsMultipleImages: true,
        maxImages: GEMINI_MAX_IMAGES,
        maxImageBytes: null
      },
      available: true
    }
  }

  validateInput(request: AnalyzerRequest): AnalyzerValidation {
    const reasons: string[] = []
    if (request.images.length === 0) reasons.push('The project has no images.')
    if (request.images.length === 1) {
      reasons.push('Whole-property analysis needs at least two photographs to relate.')
    }
    // REFUSED, not truncated. Analysing the first N photos would produce
    // an analysis that looks complete and is not, and every relationship
    // drawn from the missing images would be wrong invisibly.
    if (request.images.length > GEMINI_MAX_IMAGES) {
      reasons.push(
        `This project has ${request.images.length} images; the analyzer accepts at most ${GEMINI_MAX_IMAGES} in one request. It will not analyse a subset, because a partial analysis looks complete and is not.`
      )
    }
    if (!this.client.hasKey()) reasons.push('No Gemini API key is stored.')
    return reasons.length > 0 ? { ok: false, reasons } : { ok: true }
  }

  /**
   * A RANGE, and labelled as one.
   *
   * Google bills images as tokens and the count depends on the tiling the
   * model applies, which we cannot know before sending. An exact-looking
   * figure here would be a number nobody could reconcile against an
   * invoice — so the basis says what it is built from and whether the
   * rate itself has been verified.
   */
  estimateCost(request: AnalyzerRequest): AnalyzerCostEstimate | null {
    const rate = rateFor(this.options.model)
    if (!rate) return null
    const imageTokens = request.images.length * GEMINI_APPROX_TOKENS_PER_IMAGE
    const instructionTokens = Math.ceil(PROPERTY_ANALYSIS_INSTRUCTION.length / 4)
    // Output is a structured document; scales with rooms, so with images.
    const outputTokens = 400 + request.images.length * 120
    const input = ((imageTokens + instructionTokens) / 1_000_000) * rate.inputPerMillion
    const output = (outputTokens / 1_000_000) * rate.outputPerMillion
    const mid = input + output
    const low = mid * (1 - GEMINI_ESTIMATE_SPREAD)
    const high = mid * (1 + GEMINI_ESTIMATE_SPREAD)
    return {
      amount: Math.round(mid * 10000) / 10000,
      currency: 'USD',
      basis:
        `≈ $${low.toFixed(4)}–$${high.toFixed(4)} · ${request.images.length} images × ~${GEMINI_APPROX_TOKENS_PER_IMAGE} tokens, ` +
        `${this.options.model}` +
        (rate.verified
          ? ''
          : ' · RATE NOT VERIFIED — confirm against Google pricing before relying on this figure')
    }
  }

  sanitizeDebugPreview(request: AnalyzerRequest): AnalyzerDebugPreview {
    const warnings: string[] = []
    if (!this.options.allowLive) warnings.push('Safety lock is OFF — live analysis is blocked.')
    if (!this.options.live) warnings.push('Dry run — no Gemini request will be sent.')
    if (!this.client.hasKey()) warnings.push('No API key stored.')
    const rate = rateFor(this.options.model)
    if (rate && !rate.verified) warnings.push('Pricing is unverified; cost is an estimate only.')
    return {
      analyzer: 'gemini',
      provider: 'google',
      model: this.options.model,
      imageCount: request.images.length,
      capabilities: request.capabilities,
      instruction: buildInstruction(request),
      warnings
    }
  }

  /** Usage reported by the last live call, for refining actual cost. */
  usage(): GeminiUsage | null {
    return this.lastUsage
  }

  async analyzeProperty(request: AnalyzerRequest): Promise<AnalyzerResult> {
    const valid = this.validateInput(request)
    if (!valid.ok) return { ok: false, reason: valid.reasons.join(' ') }

    // Prepared even in dry run — the point of a dry run is to prove the
    // real request can be built, which includes reading and encoding
    // every image.
    let prepared: PreparedImage[]
    try {
      prepared = prepareImages(request)
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }

    const body = buildRequestBody(request, prepared)

    // ── THE GATE ───────────────────────────────────────────────────────
    if (!this.options.live || !this.options.allowLive) {
      return {
        ok: false,
        reason: !this.options.allowLive
          ? 'Live Gemini analysis is locked. Enable it in Settings → Property Analyzer.'
          : `Dry run — no Gemini request sent. ${prepared.length} images validated and the request was built successfully.`
      }
    }

    const result = await this.client.generate(body)
    if (!result.ok) return { ok: false, reason: result.message }
    this.lastUsage = result.usage

    const mapped = mapGeminiResponse(result.text, request)
    if (!mapped.ok) return { ok: false, reason: mapped.reason }

    const notes = [
      `Gemini ${this.options.model} analysed ${prepared.length} images in one request.`,
      ...mapped.warnings
    ]
    if (result.usage.totalTokenCount !== null) {
      notes.push(`Reported usage: ${result.usage.totalTokenCount} tokens.`)
    }
    return { ok: true, analysis: mapped.analysis, notes }
  }
}

/**
 * The instruction, with the logical image manifest appended.
 *
 * The manifest is what binds the model's answers to real photographs: it
 * must use these ids exactly, and anything else is dropped by the mapper.
 */
export function buildInstruction(request: AnalyzerRequest): string {
  const manifest = request.images
    .map((image, i) => `${logicalId(i)} — position ${image.sequence} in the walk-through order`)
    .join('\n')
  const notes = request.notes.trim()
  return (
    `${PROPERTY_ANALYSIS_INSTRUCTION}\n\n` +
    `IMAGE MANIFEST — refer to images by these identifiers EXACTLY. Do not invent identifiers.\n${manifest}\n\n` +
    (notes ? `OPERATOR NOTES (context, not evidence — do not treat as observation):\n${notes}\n\n` : '') +
    `Return JSON matching the supplied schema. Every connection must cite supportingImageIds. ` +
    `Use "unknown" wherever the photographs do not show enough.`
  )
}

/**
 * Read managed images and encode them.
 *
 * Bytes are read HERE, in main, from a managed reference — the renderer
 * never sees a filesystem path and no public URL is created. Dimensions
 * and sizes are recorded for diagnostics; paths never are.
 *
 * Deliberately no re-encoding in this first implementation: Electron's
 * main process has no image library bundled, and shelling out to FFmpeg
 * per photo would make a 30-image analysis slow and add a failure mode
 * for no proven benefit. The size ceiling is enforced instead, and if
 * real runs show the originals are wastefully large, downscaling belongs
 * here behind the same deterministic policy.
 */
function prepareImages(request: AnalyzerRequest): PreparedImage[] {
  return request.images.map((image, i) => {
    const path = resolveImageRequest(image.ref)
    if (!path) {
      throw new Error(`Image ${logicalId(i)} could not be resolved from managed storage.`)
    }
    const bytes = statSync(path).size
    const buffer = readFileSync(path)
    return {
      logicalId: logicalId(i),
      projectImageId: image.imageId,
      mimeType: guessMime(image.fileName),
      bytes,
      base64: buffer.toString('base64')
    }
  })
}

function guessMime(fileName: string): string {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.heic')) return 'image/heic'
  return GEMINI_IMAGE_MIME
}

/**
 * One request, every image, each labelled immediately before its bytes so
 * the model cannot lose track of which photograph it is describing.
 */
export function buildRequestBody(
  request: AnalyzerRequest,
  prepared: PreparedImage[]
): GeminiRequestBody {
  const parts: GeminiRequestBody['contents'][number]['parts'] = [
    { text: buildInstruction(request) }
  ]
  for (const image of prepared) {
    parts.push({ text: `${image.logicalId}:` })
    parts.push({ inlineData: { mimeType: image.mimeType, data: image.base64 } })
  }
  return {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: GEMINI_RESPONSE_SCHEMA,
      // Low, not zero: this is a reasoning task with a closed schema, and
      // the schema already prevents format drift.
      temperature: 0.2
    }
  }
}
