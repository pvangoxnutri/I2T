/**
 * WHAT THE OPERATOR KNOWS THAT THE PHOTOGRAPHS DO NOT SHOW.
 *
 * ── THE PRODUCT PRINCIPLE THIS ENCODES ───────────────────────────────
 *
 * "The model does not know" is not "the transition is impossible". The
 * analyzer reads a handful of photographs; the operator has usually
 * stood in the room. When the only thing standing between a pair and a
 * generated move is a fact nobody photographed — what a mirror reflects,
 * which wall a door sits on — the right response is to ASK, not to
 * refuse.
 *
 * Refusing was the old behaviour and it was too blunt: a mirror with an
 * unreadable reflection cut an otherwise well-evidenced same-room pair.
 *
 * ── WHAT IT IS NOT ───────────────────────────────────────────────────
 *
 * It is not a way to overrule the analyzer. It resolves UNKNOWNS. A
 * proven contradiction — doorways that cannot both be where they are
 * seen — is affirmative evidence, and typing "same room" next to it must
 * never quietly turn that into a pass. See `contextResolves`.
 */

export type MissingContextType =
  /** A reflective surface is in frame and its content could not be read. */
  | 'reflection-content'
  /** Two views look compatible but a wall or door relationship is open. */
  | 'spatial-relationship'
  /** A route may exist but no opening was visible to confirm it. */
  | 'route-unconfirmed'

export interface MissingContextItem {
  type: MissingContextType
  /** Asked as a question, because the operator is meant to answer it. */
  question: string
}

/**
 * Free text the operator wrote about ONE pair.
 *
 * Stored as its own field rather than appended to the prompt, so it
 * survives prompt rebuilds, can be shown back for editing, and keeps its
 * provenance. Text buried in a generated prompt is indistinguishable
 * from generated wording the moment it is regenerated.
 */
export interface OperatorSpatialContext {
  text: string
  createdAt: number
  /** Always 'operator'. Present so the field can never be mistaken for
   *  analyzer output when read back. */
  source: 'operator'
  /**
   * The analysis this was written against.
   *
   * A sentence about "the door on the opposite wall" is only true of the
   * understanding the operator was looking at. When a new analysis lands,
   * that sentence has not been checked against it.
   */
  analysisFingerprintAtCreation?: number
  /**
   * ── WHY "SURVIVES RE-ANALYSIS" WAS TOO BLUNT ───────────────────────
   *
   * The first rule was: never delete operator knowledge on re-analysis.
   * Right, as far as it went — but it left old text SILENTLY
   * AUTHORITATIVE. A line written against one understanding of the
   * property kept being injected into prompts built from a different
   * one, with nothing on screen to say where it came from.
   *
   * So it is neither deleted nor trusted. `needs-review` keeps the words
   * and withdraws their authority until the operator looks again.
   */
  status?: 'current' | 'needs-review'
}

export function makeOperatorContext(
  text: string,
  now: number = Date.now(),
  analysisFingerprint?: number
): OperatorSpatialContext {
  return {
    text: text.trim(),
    createdAt: now,
    source: 'operator',
    analysisFingerprintAtCreation: analysisFingerprint,
    status: 'current'
  }
}

/** Present at all — regardless of whether it is still trusted. */
export function hasOperatorContext(
  context: OperatorSpatialContext | null | undefined
): context is OperatorSpatialContext {
  return Boolean(context && context.text.trim().length > 0)
}

/**
 * MAY THIS TEXT ACT AS EVIDENCE RIGHT NOW?
 *
 * The single predicate for both jobs it has to do: resolving a
 * needs-context verdict, and being injected into a prompt. Absent status
 * reads as `current` — rows written before the lifecycle existed were
 * genuinely current when written, and demoting them all on upgrade would
 * invalidate real operator knowledge nobody asked to re-check.
 */
export function isContextActive(
  context: OperatorSpatialContext | null | undefined
): context is OperatorSpatialContext {
  return hasOperatorContext(context) && (context.status ?? 'current') === 'current'
}

/** Kept, but no longer trusted — the state the review UI must surface. */
export function needsReview(context: OperatorSpatialContext | null | undefined): boolean {
  return hasOperatorContext(context) && context.status === 'needs-review'
}

/**
 * Demote context that was written against an older analysis.
 *
 * Returns the SAME object when the fingerprint still matches, so a
 * re-analysis that changed nothing does not churn every pair. Text is
 * never touched — only its authority.
 */
export function reviewAfterReanalysis(
  context: OperatorSpatialContext | null | undefined,
  currentFingerprint: number
): OperatorSpatialContext | undefined {
  if (!hasOperatorContext(context)) return undefined
  if (context.analysisFingerprintAtCreation === currentFingerprint) return context
  if (context.status === 'needs-review') return context
  return { ...context, status: 'needs-review' }
}

/**
 * DOES THE OPERATOR'S TEXT CLOSE THIS GAP?
 *
 * ── ONLY UNKNOWNS ────────────────────────────────────────────────────
 *
 * Every `MissingContextItem` is by definition a thing nobody could
 * determine, so a human who has been in the room can answer it. That is
 * the whole point.
 *
 * A CONTRADICTION is not in this list and never becomes one: it is a
 * positive finding, not an absence. Resolving it needs the deliberate
 * manual-override path with its stated risk, not a sentence in a text
 * box — otherwise "same room" typed under a proven wall conflict would
 * read as evidence.
 */
export function contextResolves(
  missing: MissingContextItem[],
  context: OperatorSpatialContext | null | undefined
): boolean {
  if (missing.length === 0) return true
  // Deliberately isContextActive, not hasOperatorContext: text awaiting
  // review is not evidence, and letting it resolve a question would be
  // the silent authority this lifecycle exists to remove.
  return isContextActive(context)
}

/**
 * Mirror content named by the operator, as a list the prompt can state.
 *
 * ── DELIBERATELY SHALLOW ─────────────────────────────────────────────
 *
 * It splits on the punctuation people actually use and keeps clauses
 * that name a surface. It does NOT try to parse a floor plan out of
 * prose, and it never sends the text to a model — requiring a paid
 * request in order to USE what the operator just typed would defeat the
 * purpose of asking them.
 *
 * The full text is always sent verbatim as its own prompt block, so
 * anything this misses is still in front of the video model. This is an
 * extra, never the carrier.
 */
export function reflectionHintsFrom(context: OperatorSpatialContext | null | undefined): string[] {
  if (!isContextActive(context)) return []
  const sentences = context.text.split(/[.;\n]/)
  const mirrorTalk = sentences.filter((s) => /mirror|reflect/i.test(s))
  const source = mirrorTalk.length > 0 ? mirrorTalk : []
  const hints: string[] = []
  for (const sentence of source) {
    // Strip the framing so the list reads as contents, not as prose.
    //
    // ── WHY THE FRAMING MATTERS ────────────────────────────────────
    //
    // These become bullet points under "The mirror reflects only:", so
    // anything left in is presented to the model as a THING THE MIRROR
    // CONTAINS. Real operator wording is conversational — "If you look
    // at the mirror you see the door and the beige wall. That is the
    // reflection in the transition." — and stripping only "reflects"
    // produced a list containing "If you look at the mirror you see the
    // door" and "That is the reflection in the transition".
    //
    // The second one is the worst kind of noise in a safety instruction:
    // it names no surface at all, in the one place the model is being
    // told what to draw.
    const cleaned = sentence
      .replace(/.*\b(reflects?|reflection of|showing|shows)\b/i, '')
      // Conversational lead-ins, up to and including the verb of seeing.
      .replace(/.*\byou (?:can |will )?see\b/i, '')
      .replace(/^\s*(?:there (?:is|are)|it (?:is|shows))\b/i, '')
      .replace(/\bonly\b/gi, '')
      .trim()
    if (!cleaned) continue
    for (const part of cleaned.split(/,| and /i)) {
      const item = part.trim().replace(/^the\s+/i, '')
      // Two characters is not a surface; a whole clause is not a list item.
      if (item.length <= 2 || item.length >= 60) continue
      // A sentence ABOUT the reflection is not a thing IN it. Without
      // this, "That is the reflection in the transition" was offered to
      // the model as mirror content.
      if (/\b(reflection|transition|mirror)\b/i.test(item)) continue
      hints.push(item)
    }
  }
  return [...new Set(hints)]
}
