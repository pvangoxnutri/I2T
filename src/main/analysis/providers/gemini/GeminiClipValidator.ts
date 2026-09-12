/**
 * NO LONGER WIRED INTO THE PRODUCT.
 *
 * Automatic post-generation quality validation was removed by decision:
 * a downloaded clip is attached immediately and the operator judges it by
 * watching it. Nothing in the generation path calls this any more.
 *
 * Kept rather than deleted because the catalogue still stores the columns
 * it wrote, and old rows are still readable. Deleting it is a separate,
 * deliberate step — not a side effect of turning the feature off.
 */
import { GeminiClient, type FetchLike, type GeminiRequestBody } from './GeminiClient'
import type { SampledFrame } from '../../../services/frameSampler'
import {
  decideQuality,
  validationUnavailable,
  type ClipValidationResult,
  type QualityConfidence,
  type QualityOutcome,
  type SuspiciousFrame
} from '../../../../shared/qualityValidation'

/**
 * THE CLIP VALIDATOR — a narrow, separate vision request.
 *
 * ── WHY NOT REUSE THE PROPERTY ANALYZER ──────────────────────────────
 *
 * That prompt asks a model to reason: which photographs are the same
 * room, what connects to what, which moves are defensible. Reasoning is
 * exactly what must NOT happen here. The only question is what is
 * literally visible in six frames, and a model invited to think about
 * property layout starts inferring what is outside the frame — the same
 * habit that put a photographer in a mirror in the first place.
 *
 * So: its own instruction, its own schema, its own temperature, and
 * questions that can be answered by looking.
 */

export const CLIP_VALIDATOR_INSTRUCTION = [
  'You are inspecting still frames sampled from a short AI-generated video of an EMPTY property for sale.',
  '',
  'The property is unoccupied. Any person, body part or filming equipment in these frames is a generation fault that must be reported.',
  '',
  'Report ONLY what is literally visible in the frames you are given:',
  '- a person, a face, a hand or any other body part',
  '- a human silhouette or the shadow of a person',
  '- a photographer or camera operator',
  '- a camera, phone, tripod, gimbal, drone or other filming equipment',
  '',
  'INSPECT REFLECTIONS AS CAREFULLY AS THE FOREGROUND.',
  'Look INTO every mirror, mirrored wardrobe, shower glass, glass door, window pane, polished metal, glossy surface and dark TV screen. A person or a camera appearing only as a reflection is exactly the fault being looked for, and it is easy to miss because it is small, dim or partially cut off.',
  '',
  'RULES',
  '- Judge ONLY these frames. Do not speculate about what may be outside the frame, before it or after it.',
  '- Do not infer a person from an object that merely suggests one — a towel, a coat, a chair, a statue, artwork or a photograph on a wall is not a person. Artwork and portraits hanging in the property are part of the property and are NOT a detection.',
  '- frameIndex must be the number labelling the frame you are describing.',
  '- Use confidence "high" only when you can clearly see it, "medium" when you are fairly sure, "low" when it is ambiguous.',
  '- Set pass to true only when you found none of the above in any frame.'
].join('\n')

/** Only declared fields come back from structured output. */
export const CLIP_VALIDATOR_SCHEMA = {
  type: 'object',
  properties: {
    humanDetected: { type: 'boolean' },
    humanReflectionDetected: { type: 'boolean' },
    cameraEquipmentDetected: { type: 'boolean' },
    suspiciousFrames: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          frameIndex: { type: 'number' },
          reason: { type: 'string' },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] }
        },
        required: ['frameIndex', 'reason', 'confidence']
      }
    },
    pass: { type: 'boolean' }
  },
  required: [
    'humanDetected',
    'humanReflectionDetected',
    'cameraEquipmentDetected',
    'suspiciousFrames',
    'pass'
  ]
} as const

/**
 * The EXTRA paragraph for a pair the analyzer flagged as reflective.
 *
 * Every clip is now inspected, so this is no longer what decides WHETHER
 * to look — it decides how hard to look, and where. A reflected person is
 * small, dim, often cut off by the frame edge, and is the specific fault
 * that reached a customer, so the pairs known to contain a mirror get it
 * named for them rather than relying on the general instruction.
 */
export const REFLECTION_EMPHASIS = [
  '',
  'THIS TRANSITION IS KNOWN TO CONTAIN REFLECTIVE SURFACES.',
  'A mirror, mirrored wardrobe, shower screen, glass panel or polished surface appears in these frames. Examine every one of them closely and at full attention before answering.',
  'A generated clip from a scene like this has previously contained a person walking past holding a camera, visible ONLY in the mirror. Look for exactly that: a figure, a face, a hand, a silhouette, a camera, a phone or a tripod appearing inside a reflection rather than in the room itself.',
  'If a reflection is too small or too dim to read with confidence, say so with low confidence rather than assuming it is empty.'
].join('\n')

export function buildValidatorBody(
  frames: SampledFrame[],
  reflectionRisk = false
): GeminiRequestBody {
  const instruction = reflectionRisk
    ? `${CLIP_VALIDATOR_INSTRUCTION}\n${REFLECTION_EMPHASIS}`
    : CLIP_VALIDATOR_INSTRUCTION
  const parts: GeminiRequestBody['contents'][number]['parts'] = [{ text: instruction }]
  for (const frame of frames) {
    // Labelled immediately before its bytes, so an index in the answer
    // can be traced back to a real position in the clip.
    parts.push({ text: `FRAME ${frame.index} (at ${frame.atSeconds}s):` })
    parts.push({ inlineData: { mimeType: frame.mimeType, data: frame.base64 } })
  }
  return {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: CLIP_VALIDATOR_SCHEMA,
      // Lower than the analyzer's 0.2. This is observation, not
      // reasoning, and there is nothing here worth being creative about.
      temperature: 0
    }
  }
}

const CONFIDENCES: QualityConfidence[] = ['low', 'medium', 'high']

/**
 * Parse the validator's JSON.
 *
 * ── EVERY UNCERTAINTY RESOLVES TOWARD SUSPICION ──────────────────────
 *
 * A malformed response is not a pass. A missing boolean reads as false
 * only because the caller then has no detection to act on — but a frame
 * entry with an unreadable confidence is promoted to "medium" rather than
 * dropped, because discarding a warning we failed to parse is how a
 * person reaches a customer through a typo.
 */
export function parseValidatorResponse(raw: string): ClipValidationResult | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>

  const frames: SuspiciousFrame[] = []
  if (Array.isArray(obj.suspiciousFrames)) {
    for (const entry of obj.suspiciousFrames) {
      if (!entry || typeof entry !== 'object') continue
      const f = entry as Record<string, unknown>
      frames.push({
        frameIndex: typeof f.frameIndex === 'number' ? f.frameIndex : -1,
        reason: typeof f.reason === 'string' ? f.reason : 'No reason given.',
        confidence:
          typeof f.confidence === 'string' && CONFIDENCES.includes(f.confidence as QualityConfidence)
            ? (f.confidence as QualityConfidence)
            : 'medium'
      })
    }
  }

  return {
    humanDetected: obj.humanDetected === true,
    humanReflectionDetected: obj.humanReflectionDetected === true,
    cameraEquipmentDetected: obj.cameraEquipmentDetected === true,
    suspiciousFrames: frames,
    pass: obj.pass === true
  }
}

export interface ClipValidatorOptions {
  apiKey: string
  model: string
  /** Injected in tests so the real parser runs against a mocked response. */
  fetchImpl?: FetchLike
}

export class GeminiClipValidator {
  private readonly client: GeminiClient
  private readonly model: string

  constructor(options: ClipValidatorOptions) {
    this.model = options.model
    this.client = new GeminiClient({
      apiKey: options.apiKey,
      model: options.model,
      fetchImpl: options.fetchImpl
    })
  }

  get callCount(): number {
    return this.client.callCount
  }

  /**
   * Inspect the sampled frames.
   *
   * Every failure path returns `needs-review`, never `passed`. A transport
   * error, a missing key or an unreadable answer all mean the same thing —
   * nobody looked — and that must stay visible instead of being resolved
   * into approval by a default.
   */
  async validate(frames: SampledFrame[], reflectionRisk = false): Promise<QualityOutcome> {
    if (frames.length === 0) {
      return validationUnavailable('No frames could be sampled from the clip.')
    }
    if (!this.client.hasKey()) {
      return validationUnavailable('No Gemini API key is configured.')
    }

    let call: Awaited<ReturnType<GeminiClient['generate']>>
    try {
      call = await this.client.generate(buildValidatorBody(frames, reflectionRisk))
    } catch (err) {
      return validationUnavailable(err instanceof Error ? err.message : 'The request failed.')
    }

    if (!call.ok) {
      return validationUnavailable(call.message)
    }

    const result = parseValidatorResponse(call.text)
    if (!result) {
      return validationUnavailable('The quality validator returned an unreadable response.')
    }

    return decideQuality(result, `gemini:${this.model}`)
  }
}
