import { GeminiClient, type FetchLike, type GeminiRequestBody } from './GeminiClient'
import {
  PAIR_ANALYSIS_INSTRUCTION,
  PAIR_ANALYSIS_SCHEMA
} from '../../../../shared/pairAnalysisPrompt'
import type { MissingContextItem } from '../../../../shared/operatorContext'
import type { PairEvidenceRecord } from '../../../../shared/pairAnalysis'
import type { ReflectiveSurface } from '../../../../shared/propertyAnalysis'

/**
 * ONE PAIR, ONE REQUEST.
 *
 * Its own instruction and schema rather than the whole-property
 * analyzer's, because the jobs differ in the one way that matters: this
 * must not be able to propose a feed. See `pairAnalysisPrompt.ts`.
 *
 * `fetchImpl` is the seam every test uses — a mocked response runs
 * through the real parser and the real persistence chain, so no paid
 * request is needed to exercise the flow.
 */

export interface PairImage {
  imageId: string
  label: string
  base64: string
  mimeType: string
}

export interface PairAnalysisResult {
  evidence: PairEvidenceRecord
  missingContext: MissingContextItem[]
  motionInstruction: string | null
}

export function buildPairRequest(
  start: PairImage,
  end: PairImage,
  supporting: PairImage[]
): GeminiRequestBody {
  const parts: GeminiRequestBody['contents'][number]['parts'] = [
    { text: PAIR_ANALYSIS_INSTRUCTION }
  ]
  // The pair first and labelled unmistakably, so the decision target
  // cannot be confused with the context that follows it.
  parts.push({ text: `START IMAGE (${start.label}) — the transition begins here:` })
  parts.push({ inlineData: { mimeType: start.mimeType, data: start.base64 } })
  parts.push({ text: `END IMAGE (${end.label}) — the transition ends here:` })
  parts.push({ inlineData: { mimeType: end.mimeType, data: end.base64 } })

  if (supporting.length > 0) {
    parts.push({
      text: `SUPPORTING CONTEXT — ${supporting.length} other photographs of the same property. Use them ONLY to work out the layout. They are not part of this transition.`
    })
    for (const image of supporting) {
      parts.push({ text: `context: ${image.label}` })
      parts.push({ inlineData: { mimeType: image.mimeType, data: image.base64 } })
    }
  }

  return {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: PAIR_ANALYSIS_SCHEMA,
      // Matches the whole-property analyzer: a reasoning task with a
      // closed schema, where drift is the risk and creativity is not
      // wanted.
      temperature: 0.2
    }
  }
}

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : []

function asSurfaces(v: unknown): ReflectiveSurface[] {
  if (!Array.isArray(v)) return []
  const out: ReflectiveSurface[] = []
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue
    const e = raw as Record<string, unknown>
    const type = typeof e.type === 'string' ? e.type.trim() : ''
    if (!type) continue
    out.push({
      type,
      locationDescription:
        typeof e.locationDescription === 'string' ? e.locationDescription : undefined,
      dominant: e.dominant === true,
      expectedVisibleContent: asStrings(e.expectedVisibleContent),
      confidence:
        typeof e.confidence === 'string' &&
        ['confirmed', 'probable', 'unknown'].includes(e.confidence)
          ? (e.confidence as ReflectiveSurface['confidence'])
          : undefined
    })
  }
  return out
}

/**
 * Parse the pair response.
 *
 * Returns null on anything unreadable rather than a half-populated
 * record: an evidence object with silently empty fields reads downstream
 * as "the analyzer looked and found nothing", which is a much stronger
 * claim than "we could not parse the answer".
 */
export function parsePairResponse(raw: string): PairAnalysisResult | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const o = parsed as Record<string, unknown>
  if (typeof o.relation !== 'string') return null

  const missing: MissingContextItem[] = []
  if (Array.isArray(o.missingContext)) {
    for (const raw of o.missingContext) {
      if (!raw || typeof raw !== 'object') continue
      const m = raw as Record<string, unknown>
      if (typeof m.question !== 'string' || !m.question.trim()) continue
      const type = ['reflection-content', 'spatial-relationship', 'route-unconfirmed'].includes(
        String(m.type)
      )
        ? (m.type as MissingContextItem['type'])
        : 'spatial-relationship'
      missing.push({ type, question: m.question })
    }
  }

  return {
    evidence: {
      relation: o.relation,
      roomLabel: typeof o.roomLabel === 'string' ? o.roomLabel : undefined,
      sharedLandmarks: asStrings(o.sharedLandmarks),
      openings: asStrings(o.openings),
      reflectiveSurfaces: asSurfaces(o.reflectiveSurfaces),
      overlapNotes: typeof o.overlapNotes === 'string' ? o.overlapNotes : undefined,
      geometryConflicts: asStrings(o.geometryConflicts)
    },
    missingContext: missing,
    motionInstruction:
      typeof o.motionInstruction === 'string' && o.motionInstruction.trim().length > 0
        ? o.motionInstruction
        : null
  }
}

export class GeminiPairAnalyzer {
  private readonly client: GeminiClient

  constructor(options: { apiKey: string; model: string; fetchImpl?: FetchLike }) {
    this.client = new GeminiClient({
      apiKey: options.apiKey,
      model: options.model,
      fetchImpl: options.fetchImpl
    })
  }

  get callCount(): number {
    return this.client.callCount
  }

  async analyse(
    start: PairImage,
    end: PairImage,
    supporting: PairImage[]
  ): Promise<{ ok: true; result: PairAnalysisResult } | { ok: false; reason: string }> {
    if (!this.client.hasKey()) return { ok: false, reason: 'No Gemini API key is configured.' }
    let call: Awaited<ReturnType<GeminiClient['generate']>>
    try {
      call = await this.client.generate(buildPairRequest(start, end, supporting))
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'The request failed.' }
    }
    if (!call.ok) return { ok: false, reason: call.message }
    const result = parsePairResponse(call.text)
    if (!result) return { ok: false, reason: 'The analyzer returned an unreadable response.' }
    return { ok: true, result }
  }
}
