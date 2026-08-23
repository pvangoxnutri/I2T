import type { PropertyAnalysis, RoomEdge } from './propertyAnalysis'

/**
 * GROUND-TRUTH REVIEW — is the analysis actually right?
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────
 *
 * Before we let a vision model's opinion drive camera motion in a video
 * marketing a real home, we need to know how often it is correct on real
 * property sets. That cannot be measured from the model's own confidence;
 * it needs a human saying "yes, those two photographs really are the same
 * living room".
 *
 * Purely local evaluation metadata. Nothing here is ever sent anywhere.
 *
 * ── REVIEW IS NOT EDITING ────────────────────────────────────────────
 *
 * Marking a connection Incorrect records a judgement about the analysis;
 * it does NOT delete the edge. Conflating the two would mean an operator
 * evaluating accuracy silently destroys the thing they were measuring.
 * Removing a bad edge is a separate, explicit action.
 *
 * The one place a review DOES change behaviour is safety — see
 * `navigationBlockedBy`. That is deliberate and narrow.
 */

export type ReviewVerdict = 'correct' | 'incorrect' | 'unsure' | 'unreviewed'

export type ReviewFactKind = 'image-room' | 'connection'

/**
 * Which analysis a review belongs to.
 *
 * Draft reviews are kept apart from accepted ones so a re-analysis starts
 * from a clean sheet — every fact in a new draft is Unreviewed — while
 * the accepted analysis keeps the review history it earned, right up
 * until a replacement is explicitly accepted.
 */
export type ReviewScope = 'accepted' | 'draft'

export interface ReviewEntry {
  projectId: string
  scope: ReviewScope
  factKey: string
  kind: ReviewFactKind
  /** Human label, stored so history reads correctly after rooms change. */
  label: string
  verdict: ReviewVerdict
  updatedAt: number
}

/**
 * ── STABLE, SEMANTIC KEYS ────────────────────────────────────────────
 *
 * Deliberately NOT the generated UUIDs. An analyzer mints fresh room ids
 * on every run, so a UUID-keyed review would be orphaned by the next
 * re-analysis and every fact would look new. Keying on the image id
 * (which is stable, it is the project's own) plus the room LABEL means a
 * genuinely unchanged fact keeps its review and a genuinely changed one
 * correctly reads as unreviewed.
 *
 * Labels are normalised so "Living Room" and "living room " are one fact.
 */
const norm = (s: string): string => s.trim().toLowerCase()

export function imageRoomFactKey(imageId: string, roomLabel: string): string {
  return `image-room:${imageId}:${norm(roomLabel)}`
}

/** Order-independent: A↔B and B↔A are the same connection. */
export function connectionFactKey(roomLabelA: string, roomLabelB: string): string {
  return `connection:${[norm(roomLabelA), norm(roomLabelB)].sort().join('|')}`
}

export function edgeFactKey(analysis: PropertyAnalysis, edge: RoomEdge): string | null {
  const from = analysis.rooms.find((r) => r.id === edge.fromRoomId)?.label
  const to = analysis.rooms.find((r) => r.id === edge.toRoomId)?.label
  if (!from || !to) return null
  return connectionFactKey(from, to)
}

/** Every reviewable fact in an analysis, in the order the UI shows them. */
export interface ReviewableFact {
  factKey: string
  kind: ReviewFactKind
  label: string
  /** True for connections the planner may act on — the high-risk ones. */
  highRisk: boolean
}

export function reviewableFacts(
  analysis: PropertyAnalysis,
  imageLabel: (imageId: string) => string
): ReviewableFact[] {
  const facts: ReviewableFact[] = []

  for (const image of analysis.images) {
    if (!image.roomId) continue
    const room = analysis.rooms.find((r) => r.id === image.roomId)
    if (!room) continue
    facts.push({
      factKey: imageRoomFactKey(image.imageId, room.label),
      kind: 'image-room',
      label: `${imageLabel(image.imageId)} → ${room.label}`,
      highRisk: false
    })
  }

  for (const edge of analysis.edges) {
    const key = edgeFactKey(analysis, edge)
    if (!key) continue
    const from = analysis.rooms.find((r) => r.id === edge.fromRoomId)?.label ?? '?'
    const to = analysis.rooms.find((r) => r.id === edge.toRoomId)?.label ?? '?'
    facts.push({
      factKey: key,
      kind: 'connection',
      label: `${from} ↔ ${to} · ${edge.confidence}`,
      // A confirmed connection is what licenses moving the camera through
      // a doorway. If that one is wrong, the video walks through a wall.
      highRisk: edge.confidence === 'confirmed'
    })
  }

  return facts
}

// ── Accuracy ───────────────────────────────────────────────────────────

export interface AccuracySummary {
  total: number
  reviewed: number
  correct: number
  incorrect: number
  unsure: number
  /**
   * Correct ÷ (correct + incorrect), as a percentage — or null when
   * nothing determinate has been reviewed.
   *
   * `unsure` is excluded from the DENOMINATOR on purpose. Counting it
   * either way would invent a verdict the reviewer explicitly declined to
   * give, and would make the figure move for a reason nobody intended.
   */
  accuracyPct: number | null
  /**
   * True when the sample is too small to mean anything. The UI says so
   * rather than printing a confident-looking percentage of four facts.
   */
  sampleTooSmall: boolean
}

/** Below this, a percentage is noise dressed as a measurement. */
export const MIN_MEANINGFUL_SAMPLE = 10

export function summarizeAccuracy(
  facts: ReviewableFact[],
  verdicts: Map<string, ReviewVerdict>
): AccuracySummary {
  let correct = 0
  let incorrect = 0
  let unsure = 0
  for (const fact of facts) {
    switch (verdicts.get(fact.factKey) ?? 'unreviewed') {
      case 'correct':
        correct++
        break
      case 'incorrect':
        incorrect++
        break
      case 'unsure':
        unsure++
        break
      default:
        break
    }
  }
  const determinate = correct + incorrect
  return {
    total: facts.length,
    reviewed: correct + incorrect + unsure,
    correct,
    incorrect,
    unsure,
    accuracyPct: determinate > 0 ? Math.round((correct / determinate) * 100) : null,
    sampleTooSmall: determinate > 0 && determinate < MIN_MEANINGFUL_SAMPLE
  }
}

// ── The one place a review changes behaviour ────────────────────────────

/**
 * Whether a reviewer's verdict blocks physical navigation across a
 * connection, and why.
 *
 * ── WHY REVIEW OVERRIDES EVIDENCE HERE ───────────────────────────────
 *
 * Everywhere else a review is passive evaluation. This is the exception,
 * and it is asymmetric on purpose: a review can only ever make the system
 * MORE conservative, never less.
 *
 *   incorrect → blocked. A human has said the relationship is wrong; the
 *               model's confidence is not evidence against that.
 *   unsure    → blocked. "I cannot tell" is not grounds for driving a
 *               camera through a doorway.
 *   correct / unreviewed → the normal evidence rules apply unchanged.
 *
 * Note that `unreviewed` does NOT block. Requiring a human sign-off on
 * every connection before any navigation could happen would make the
 * analyzer useless before the evaluation is done — and the evidence rules
 * (confirmed AND a visible opening) already stand on their own.
 */
export function navigationBlockedBy(verdict: ReviewVerdict): string | null {
  if (verdict === 'incorrect') {
    return 'The reviewer marked this connection incorrect, so no physical navigation is planned across it.'
  }
  if (verdict === 'unsure') {
    return 'The reviewer was unsure about this connection, so it is treated as insufficient for physical navigation.'
  }
  return null
}

/** Confirmed connections whose review has not backed them up. */
export function unvalidatedConfirmedConnections(
  analysis: PropertyAnalysis,
  verdicts: Map<string, ReviewVerdict>
): Array<{ factKey: string; label: string; verdict: ReviewVerdict }> {
  const out: Array<{ factKey: string; label: string; verdict: ReviewVerdict }> = []
  for (const edge of analysis.edges) {
    if (edge.confidence !== 'confirmed') continue
    const key = edgeFactKey(analysis, edge)
    if (!key) continue
    const verdict = verdicts.get(key) ?? 'unreviewed'
    if (verdict === 'incorrect' || verdict === 'unsure') {
      const from = analysis.rooms.find((r) => r.id === edge.fromRoomId)?.label ?? '?'
      const to = analysis.rooms.find((r) => r.id === edge.toRoomId)?.label ?? '?'
      out.push({ factKey: key, label: `${from} ↔ ${to}`, verdict })
    }
  }
  return out
}
