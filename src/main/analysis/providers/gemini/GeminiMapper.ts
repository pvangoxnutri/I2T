import { randomUUID } from 'node:crypto'
import type { AnalyzerRequest } from '../../../../shared/analyzerTypes'
import type {
  AnalysisConfidence,
  CameraOrientation,
  PropertyAnalysis
} from '../../../../shared/propertyAnalysis'

/**
 * Gemini ↔ PropertyAnalysis translation.
 *
 * ── LOGICAL IMAGE IDS ────────────────────────────────────────────────
 *
 * The model never sees a project image id. Those are UUIDs — long,
 * meaningless to a language model, and easy for it to garble or
 * hallucinate. Instead each photo is labelled IMAGE_001, IMAGE_002 … in
 * sequence order, the model is required to refer to exactly those, and we
 * map back here.
 *
 * That mapping is also a VALIDATION boundary: an id the model invented
 * resolves to nothing and is dropped, rather than silently creating a
 * relationship about a photograph that does not exist.
 *
 * ── NOTHING IS PARTIALLY ACCEPTED ────────────────────────────────────
 *
 * A malformed response produces an error, never a half-built analysis.
 * A draft that looked plausible but had one fabricated room would be far
 * more dangerous than an obvious failure.
 */

export function logicalId(index: number): string {
  return `IMAGE_${String(index + 1).padStart(3, '0')}`
}

/** logical id → project image id, built from the request's own ordering. */
export function buildIdMap(request: AnalyzerRequest): Map<string, string> {
  const map = new Map<string, string>()
  request.images.forEach((image, i) => map.set(logicalId(i), image.imageId))
  return map
}

/**
 * The structured-output schema handed to Gemini.
 *
 * Every enum is closed. That is the point: `confidence` can only be one
 * of three values, so the model cannot answer "likely" or "high" and have
 * it flow into a system whose entire safety rule is built on exactly
 * three levels. An unsupported value is a rejected response, not a
 * silently coerced one.
 *
 * No coordinates, no dimensions, no floor plan — the schema simply offers
 * nowhere to put them.
 */
export const GEMINI_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    rooms: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          imageIds: { type: 'array', items: { type: 'string' } },
          landmarks: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'string', enum: ['confirmed', 'probable', 'unknown'] },
          notes: { type: 'string' }
        },
        required: ['label', 'imageIds', 'confidence']
      }
    },
    images: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          imageId: { type: 'string' },
          roomLabel: { type: 'string' },
          roomConfidence: { type: 'string', enum: ['confirmed', 'probable', 'unknown'] },
          orientation: {
            type: 'string',
            enum: ['unknown', 'into-room', 'out-of-room', 'north', 'east', 'south', 'west']
          },
          landmarks: { type: 'array', items: { type: 'string' } },
          openings: { type: 'array', items: { type: 'string' } },
          overlapWith: { type: 'array', items: { type: 'string' } },
          notes: { type: 'string' }
        },
        required: ['imageId', 'roomLabel', 'roomConfidence', 'orientation']
      }
    },
    connections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          fromRoomLabel: { type: 'string' },
          toRoomLabel: { type: 'string' },
          confidence: { type: 'string', enum: ['confirmed', 'probable', 'unknown'] },
          supportingImageIds: { type: 'array', items: { type: 'string' } },
          visibleOpeningImageIds: { type: 'array', items: { type: 'string' } },
          notes: { type: 'string' }
        },
        required: ['fromRoomLabel', 'toRoomLabel', 'confidence', 'supportingImageIds']
      }
    }
  },
  required: ['rooms', 'images', 'connections']
} as const

const CONFIDENCES: AnalysisConfidence[] = ['confirmed', 'probable', 'unknown']
const ORIENTATIONS: CameraOrientation[] = [
  'unknown',
  'into-room',
  'out-of-room',
  'north',
  'east',
  'south',
  'west'
]

export type MapResult =
  | { ok: true; analysis: PropertyAnalysis; warnings: string[] }
  | { ok: false; reason: string }

/**
 * Validate and translate. Strict on purpose — see the note at the top.
 */
export function mapGeminiResponse(
  raw: string,
  request: AnalyzerRequest
): MapResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'Gemini returned output that is not valid JSON. No draft was created.' }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'Gemini returned a non-object response. No draft was created.' }
  }

  const body = parsed as {
    rooms?: unknown
    images?: unknown
    connections?: unknown
  }
  if (!Array.isArray(body.rooms) || !Array.isArray(body.images) || !Array.isArray(body.connections)) {
    return {
      ok: false,
      reason: 'Gemini response is missing rooms, images or connections. No draft was created.'
    }
  }

  const idMap = buildIdMap(request)
  const warnings: string[] = []
  const resolve = (logical: unknown): string | null => {
    if (typeof logical !== 'string') return null
    const real = idMap.get(logical.trim().toUpperCase())
    if (!real) {
      warnings.push(`Ignored unknown image reference "${String(logical)}".`)
      return null
    }
    return real
  }
  const confidenceOf = (value: unknown, where: string): AnalysisConfidence | null => {
    if (typeof value !== 'string' || !CONFIDENCES.includes(value as AnalysisConfidence)) {
      warnings.push(`Rejected unsupported confidence "${String(value)}" in ${where}.`)
      return null
    }
    return value as AnalysisConfidence
  }

  // ── Rooms ────────────────────────────────────────────────────────────
  // Ids are OURS, generated here. A model-supplied id would be another
  // string to validate for no benefit.
  const roomIdByLabel = new Map<string, string>()
  const rooms: PropertyAnalysis['rooms'] = []
  for (const entry of body.rooms as Array<Record<string, unknown>>) {
    const label = typeof entry.label === 'string' ? entry.label.trim() : ''
    if (!label) return { ok: false, reason: 'A room in the Gemini response has no label.' }
    const confidence = confidenceOf(entry.confidence, `room "${label}"`)
    if (!confidence) {
      return { ok: false, reason: `Room "${label}" has an unsupported confidence value.` }
    }
    const id = roomIdByLabel.get(label) ?? `room-${randomUUID().slice(0, 8)}`
    roomIdByLabel.set(label, id)
    rooms.push({
      id,
      label,
      imageIds: asStringArray(entry.imageIds).map(resolve).filter((v): v is string => v !== null),
      landmarks: asStringArray(entry.landmarks),
      confidence,
      notes: typeof entry.notes === 'string' ? entry.notes : undefined
    })
  }

  // ── Images ───────────────────────────────────────────────────────────
  const images: PropertyAnalysis['images'] = []
  for (const entry of body.images as Array<Record<string, unknown>>) {
    const imageId = resolve(entry.imageId)
    if (!imageId) continue
    const roomLabel = typeof entry.roomLabel === 'string' ? entry.roomLabel.trim() : ''
    const roomId = roomLabel ? (roomIdByLabel.get(roomLabel) ?? null) : null
    if (roomLabel && !roomId) {
      warnings.push(`Image referenced unknown room "${roomLabel}" — left unassigned.`)
    }
    const roomConfidence = confidenceOf(entry.roomConfidence, `image ${String(entry.imageId)}`)
    if (!roomConfidence) {
      return { ok: false, reason: `An image entry has an unsupported confidence value.` }
    }
    const orientation =
      typeof entry.orientation === 'string' &&
      ORIENTATIONS.includes(entry.orientation as CameraOrientation)
        ? (entry.orientation as CameraOrientation)
        : 'unknown'
    images.push({
      imageId,
      roomId,
      roomConfidence,
      orientation,
      landmarks: asStringArray(entry.landmarks),
      openings: asStringArray(entry.openings),
      overlapWith: asStringArray(entry.overlapWith)
        .map(resolve)
        .filter((v): v is string => v !== null),
      notes: typeof entry.notes === 'string' ? entry.notes : undefined
    })
  }

  // ── Connections ──────────────────────────────────────────────────────
  const edges: PropertyAnalysis['edges'] = []
  for (const entry of body.connections as Array<Record<string, unknown>>) {
    const fromLabel = typeof entry.fromRoomLabel === 'string' ? entry.fromRoomLabel.trim() : ''
    const toLabel = typeof entry.toRoomLabel === 'string' ? entry.toRoomLabel.trim() : ''
    const fromRoomId = roomIdByLabel.get(fromLabel)
    const toRoomId = roomIdByLabel.get(toLabel)
    if (!fromRoomId || !toRoomId) {
      warnings.push(`Ignored a connection referencing an unknown room ("${fromLabel}" ↔ "${toLabel}").`)
      continue
    }
    const confidence = confidenceOf(entry.confidence, `connection ${fromLabel} ↔ ${toLabel}`)
    if (!confidence) {
      return { ok: false, reason: `Connection ${fromLabel} ↔ ${toLabel} has an unsupported confidence value.` }
    }
    // An UNKNOWN connection is stored as no edge at all. Absence of
    // evidence is recorded as absence — the planner reads a missing edge
    // as "unknown", which is exactly the safe answer.
    if (confidence === 'unknown') continue
    edges.push({
      id: `edge-${randomUUID().slice(0, 8)}`,
      fromRoomId,
      toRoomId,
      confidence,
      supportingImageIds: asStringArray(entry.supportingImageIds)
        .map(resolve)
        .filter((v): v is string => v !== null),
      visibleOpeningImageIds: asStringArray(entry.visibleOpeningImageIds)
        .map(resolve)
        .filter((v): v is string => v !== null),
      notes: typeof entry.notes === 'string' ? entry.notes : undefined
    })
  }

  // A confirmed connection with NO supporting image is not confirmed. The
  // instruction requires evidence to be cited; a claim without it is
  // downgraded rather than trusted.
  for (const edge of edges) {
    if (edge.confidence === 'confirmed' && edge.supportingImageIds.length === 0) {
      edge.confidence = 'probable'
      warnings.push('A connection claimed "confirmed" without citing an image — downgraded to probable.')
    }
  }

  return {
    ok: true,
    warnings,
    analysis: {
      projectId: request.projectId,
      version: 1,
      source: 'provider',
      updatedAt: 0,
      // ALWAYS a draft. A provider never writes the accepted analysis.
      state: 'draft',
      analyzerId: 'gemini',
      rooms,
      images,
      edges,
      transitionHints: []
    }
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
}
