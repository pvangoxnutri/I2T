import type { AnalysisConfidence, PropertyAnalysis } from './propertyAnalysis'

/**
 * What a new analysis would CHANGE about the accepted one.
 *
 * ── WHY A DIFF AND NOT A REPLACE ─────────────────────────────────────
 *
 * An accepted analysis usually contains human judgement — a room split
 * the model got wrong, an adjacency someone downgraded because they knew
 * the flat. Overwriting that on a re-run would destroy the corrections
 * silently, and the operator would only find out later, in a generated
 * video that walked through the wrong door.
 *
 * So a re-analysis produces a draft, this describes the delta, and
 * nothing is replaced until someone accepts it.
 *
 * Pure: no I/O, so the comparison is testable on its own.
 */
export interface AnalysisDiff {
  addedRooms: string[]
  removedRooms: string[]
  /** Images whose room assignment changed, with both labels. */
  reassignedImages: Array<{ imageId: string; from: string | null; to: string | null }>
  addedConnections: Array<{ label: string; confidence: AnalysisConfidence }>
  removedConnections: string[]
  changedConfidence: Array<{ label: string; from: AnalysisConfidence; to: AnalysisConfidence }>
  /** True when nothing at all would change. */
  identical: boolean
}

const roomLabel = (a: PropertyAnalysis, id: string | null): string | null =>
  id ? (a.rooms.find((r) => r.id === id)?.label ?? id) : null

const edgeKey = (a: string, b: string): string => [a, b].sort().join('|')

export function diffAnalyses(
  accepted: PropertyAnalysis,
  draft: PropertyAnalysis
): AnalysisDiff {
  // Rooms are compared by LABEL, not id: an analyzer generates fresh ids
  // every run, so comparing ids would report every room as both added and
  // removed and tell the operator nothing.
  const acceptedLabels = new Set(accepted.rooms.map((r) => r.label))
  const draftLabels = new Set(draft.rooms.map((r) => r.label))

  const addedRooms = [...draftLabels].filter((l) => !acceptedLabels.has(l))
  const removedRooms = [...acceptedLabels].filter((l) => !draftLabels.has(l))

  const reassignedImages: AnalysisDiff['reassignedImages'] = []
  const imageIds = new Set([
    ...accepted.images.map((i) => i.imageId),
    ...draft.images.map((i) => i.imageId)
  ])
  for (const imageId of imageIds) {
    const from = roomLabel(accepted, accepted.images.find((i) => i.imageId === imageId)?.roomId ?? null)
    const to = roomLabel(draft, draft.images.find((i) => i.imageId === imageId)?.roomId ?? null)
    if (from !== to) reassignedImages.push({ imageId, from, to })
  }

  const acceptedEdges = new Map<string, { label: string; confidence: AnalysisConfidence }>()
  for (const e of accepted.edges) {
    const a = roomLabel(accepted, e.fromRoomId) ?? e.fromRoomId
    const b = roomLabel(accepted, e.toRoomId) ?? e.toRoomId
    acceptedEdges.set(edgeKey(a, b), { label: `${a} ↔ ${b}`, confidence: e.confidence })
  }
  const draftEdges = new Map<string, { label: string; confidence: AnalysisConfidence }>()
  for (const e of draft.edges) {
    const a = roomLabel(draft, e.fromRoomId) ?? e.fromRoomId
    const b = roomLabel(draft, e.toRoomId) ?? e.toRoomId
    draftEdges.set(edgeKey(a, b), { label: `${a} ↔ ${b}`, confidence: e.confidence })
  }

  const addedConnections: AnalysisDiff['addedConnections'] = []
  const changedConfidence: AnalysisDiff['changedConfidence'] = []
  for (const [key, value] of draftEdges) {
    const before = acceptedEdges.get(key)
    if (!before) addedConnections.push(value)
    else if (before.confidence !== value.confidence) {
      changedConfidence.push({ label: value.label, from: before.confidence, to: value.confidence })
    }
  }
  const removedConnections = [...acceptedEdges]
    .filter(([key]) => !draftEdges.has(key))
    .map(([, v]) => v.label)

  return {
    addedRooms,
    removedRooms,
    reassignedImages,
    addedConnections,
    removedConnections,
    changedConfidence,
    identical:
      addedRooms.length === 0 &&
      removedRooms.length === 0 &&
      reassignedImages.length === 0 &&
      addedConnections.length === 0 &&
      removedConnections.length === 0 &&
      changedConfidence.length === 0
  }
}
