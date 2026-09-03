import type { PropertyAnalysis } from '../shared/propertyAnalysis'
import { roomOfImage, imageAnalysis } from '../shared/propertyAnalysis'
import { evaluateTransitionSafety } from '../shared/transitionSafety'
import { traversableOpenings } from '../shared/openingEvidence'
import { assessAiGenerationReadiness } from '../shared/aiGenerationReadiness'

/**
 * WHY EACH PROPOSED PAIR GOT ITS MODE, printed once per analysis run.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────
 *
 * "Almost every pair is a CUT" has two completely different causes and
 * they look identical from the UI: either the photographs genuinely
 * support no route — which is the correct and common answer for a
 * marketing-ordered feed that jumps between unconnected spaces — or a
 * field was dropped between Gemini and the evaluator, as `marketingImportance`
 * and `transitionHints` both silently were.
 *
 * Distinguishing those needs the evidence itself, and a paid draft is not
 * persisted. So the summary is emitted while the analysis is in hand.
 * Counts first, so a systemic gap (`landmarks: 0/37`) is obvious without
 * reading a single pair.
 */
export function logProposalEvidence(
  analysis: PropertyAnalysis,
  sequence: string[],
  modes: Record<string, 'ai' | 'cut'>
): void {
  const label = (id: string): string => {
    const i = analysis.images.findIndex((im) => im.imageId === id)
    return i >= 0 ? `IMAGE_${String(i + 1).padStart(3, '0')}` : id.slice(0, 8)
  }

  const withLandmarks = analysis.images.filter((i) => i.landmarks.length > 0).length
  const withOpenings = analysis.images.filter((i) => i.openings.length > 0).length
  const withTraversable = analysis.images.filter(
    (i) => traversableOpenings(i.openings).length > 0
  ).length
  const withOverlap = analysis.images.filter((i) => (i.overlapWith ?? []).length > 0).length
  const scored = analysis.images.filter((i) => typeof i.marketingImportance === 'number').length

  // Coverage against the ROOMS THAT EXIST: a roomId pointing at nothing
  // is not an assignment, and counting it as one is how a mapping that
  // placed almost nothing looked complete.
  const roomIds = new Set(analysis.rooms.map((r) => r.id))
  const assigned = analysis.images.filter((i) => i.roomId && roomIds.has(i.roomId))
  const heroes = analysis.images.filter((i) => i.isHero === true).length
  const viewsPerRoom = new Map<string, number>()
  for (const i of assigned) viewsPerRoom.set(i.roomId!, (viewsPerRoom.get(i.roomId!) ?? 0) + 1)
  const multiView = [...viewsPerRoom.values()].filter((n) => n > 1).length

  console.log(
    `[analysis] rooms=${analysis.rooms.length} images=${analysis.images.length} ` +
      `edges=${analysis.edges.length} hints=${(analysis.transitionHints ?? []).length}`
  )
  console.log(
    `[analysis] assigned=${assigned.length}/${analysis.images.length} ` +
      `unassigned=${analysis.images.length - assigned.length} ` +
      `roomsWithMultipleViews=${multiView}/${analysis.rooms.length}`
  )
  console.log(
    `[analysis] per-image coverage — landmarks=${withLandmarks} openings=${withOpenings} ` +
      `(traversable=${withTraversable}) overlapWith=${withOverlap} scored=${scored} ` +
      `heroes=${heroes} of ${analysis.images.length}`
  )
  const byConfidence = analysis.edges.reduce<Record<string, number>>((acc, e) => {
    acc[e.confidence] = (acc[e.confidence] ?? 0) + 1
    return acc
  }, {})
  console.log(`[analysis] edges by confidence: ${JSON.stringify(byConfidence)}`)

  let ai = 0
  for (let i = 0; i < sequence.length - 1; i++) {
    const from = sequence[i]
    const to = sequence[i + 1]
    const verdict = evaluateTransitionSafety(analysis, from, to)
    const mode = modes[`${from}->${to}`] ?? verdict.mode
    if (mode === 'ai') ai++

    const fromRoom = roomOfImage(analysis, from)?.label ?? '—'
    const toRoom = roomOfImage(analysis, to)?.label ?? '—'
    const fromImg = imageAnalysis(analysis, from)
    const hint = analysis.transitionHints?.find(
      (h) => h.fromImageId === from && h.toImageId === to
    )

    // For an AI pair, the question that actually decides whether money
    // may be spent: can an anchored prompt be built for it right now?
    const readiness =
      mode === 'ai'
        ? assessAiGenerationReadiness(analysis, sequence, `${from}->${to}`)
        : null
    const basis =
      readiness === null
        ? 'n/a'
        : readiness.ok
          ? readiness.kind === 'analysis-backed'
            ? `YES (${readiness.basis.motionInstruction.slice(0, 60)}…)`
            : 'MANUAL OVERRIDE — no spatial guidance'
          : `NO — ${readiness.reason.slice(0, 70)}`

    console.log(
      `[pair] ${label(from)}→${label(to)} ${mode.toUpperCase()} (${verdict.safety}) ` +
        `| ${fromRoom} → ${toRoom}` +
        ` | shared=[${verdict.evidence.sharedLandmarks.join(', ')}]` +
        ` | overlap=${(fromImg?.overlapWith ?? []).includes(to)}` +
        ` | openings=[${(fromImg?.openings ?? []).join(', ')}]` +
        ` | traversable=[${verdict.evidence.traversableOpenings.join(', ')}]` +
        ` | adjacency=${verdict.evidence.adjacencyConfidence ?? 'none'}` +
        ` | hint=${hint?.safetyLevel ?? 'none'}` +
        ` | promptBasis=${basis}` +
        ` | ${verdict.reason}`
    )
  }
  console.log(
    `[analysis] proposed ${sequence.length} images, ${ai} AI / ` +
      `${Math.max(sequence.length - 1 - ai, 0)} CUT transitions`
  )
}
