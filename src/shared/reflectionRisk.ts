import type { ImageAnalysis, ReflectiveSurface } from './propertyAnalysis'

/**
 * REFLECTION RISK — deciding when a mirror makes a generation indefensible.
 *
 * ── THE FAILURE THIS EXISTS FOR ──────────────────────────────────────
 *
 * A generated bathroom transition produced a person walking past with a
 * camera. The prompt already forbade exactly that, in those words. So the
 * lesson is not "word the rule harder": a single negative sentence lost
 * to a model that had been handed a reason to invent an observer.
 *
 * It had been handed one by us. The planned motion was "rotating
 * clockwise, keeping the floating vanity continuously in view, turning
 * away from the mirror reflection toward the wall toilet" — a camera path
 * defined RELATIVE TO A MIRROR. To render turning away from a reflection,
 * a model must decide what the reflection contains, and the most
 * available answer to "what does a moving camera see in a mirror" is a
 * person holding one.
 *
 * The fix is therefore in this order:
 *   1. notice the mirror                     (this file)
 *   2. refuse camera paths that need it explained  (transitionSafety)
 *   3. and only then, strengthen the wording (prompts)
 *
 * ── UNKNOWN IS A REASON TO REFUSE, NOT TO PROCEED ────────────────────
 *
 * Every default here fails toward CUT. A cut where AI would have been
 * fine costs a slightly less fluid video. The other error puts a stranger
 * with a camera inside a listing for someone's home.
 */

/**
 * Words that mean "this surface returns an image".
 *
 * ── WHY TEXT MATCHING IS HERE AT ALL ─────────────────────────────────
 *
 * It is a FALLBACK, not the mechanism. Structured `reflectiveSurfaces` is
 * the real input, but every analysis written before that field existed
 * has none — including the one behind the failure, which recorded the
 * mirror only as the landmark string "mirror reflection". Treating a
 * missing field as "no mirrors here" would leave precisely the analyses
 * we already know are dangerous rated safe forever, unless every customer
 * pays to re-run analysis.
 *
 * Matching prose is weak evidence. It is used ONLY to raise risk, never
 * to clear it.
 */
const REFLECTIVE_TERMS = [
  'mirror',
  'mirrored',
  'reflection',
  'reflective',
  'glass shower',
  'shower glass',
  'shower screen',
  'shower panel',
  'shower enclosure',
  'shower door',
  'glass wall',
  'glass door',
  'glass panel',
  'polished metal',
  'polished stone',
  'high gloss',
  'high-gloss',
  'glossy',
  'lacquered',
  'tv screen',
  'television screen',
  'flat screen',
  'flatscreen'
]

/** Terms whose presence usually means a LARGE reflector. */
const DOMINANT_TERMS = ['mirror', 'mirrored', 'glass wall', 'shower enclosure', 'wardrobe']

function mentionsReflector(text: string): string | null {
  const s = text.toLowerCase()
  for (const term of REFLECTIVE_TERMS) if (s.includes(term)) return term
  return null
}

export interface ReflectionEvidence {
  /** A reflective surface is present, or may be. */
  risk: boolean
  /** At least one reflector is large enough to dominate the frame. */
  dominant: boolean
  /** The surfaces found, structured where available. */
  surfaces: ReflectiveSurface[]
  /**
   * TRUE when we know a reflector is there but cannot say what it
   * reflects. This is the dangerous state: the model must fill the
   * reflection with something, and nothing tells it what.
   */
  contentUnknown: boolean
  /**
   * TRUE when the risk came from reading prose rather than a structured
   * field — i.e. an analysis produced before mirrors were modelled.
   */
  legacyTextOnly: boolean
  /** Human-readable, specific enough to argue with. */
  reason: string | null
}

export const NO_REFLECTION_EVIDENCE: ReflectionEvidence = {
  risk: false,
  dominant: false,
  surfaces: [],
  contentUnknown: false,
  legacyTextOnly: false,
  reason: null
}

/** Everything the analyzer said about reflectors in ONE image. */
export function reflectionEvidenceForImage(image: ImageAnalysis | null): ReflectionEvidence {
  if (!image) return NO_REFLECTION_EVIDENCE

  // ── STRUCTURED FIRST ────────────────────────────────────────────────
  const declared = image.reflectiveSurfaces ?? []
  if (declared.length > 0) {
    const dominant = declared.some((s) => s.dominant)
    // A surface with no readable content is the whole problem: the model
    // has to put SOMETHING in the mirror.
    const contentUnknown = declared.some(
      (s) => s.dominant && (s.expectedVisibleContent?.length ?? 0) === 0
    )
    return {
      risk: true,
      dominant,
      surfaces: declared,
      contentUnknown,
      legacyTextOnly: false,
      reason: `Reflective ${declared.length === 1 ? 'surface' : 'surfaces'} in frame: ${declared
        .map((s) => s.type)
        .join(', ')}.`
    }
  }

  // ── FALLBACK: THE OLDER ANALYSES ────────────────────────────────────
  //
  // Landmarks and notes are scanned because that is where a mirror was
  // recorded before it had anywhere better to go.
  const haystacks: string[] = [...image.landmarks, ...image.openings, image.notes ?? '']
  const hits = haystacks.map(mentionsReflector).filter((t): t is string => t !== null)
  if (hits.length === 0) return NO_REFLECTION_EVIDENCE

  const dominant = hits.some((t) => DOMINANT_TERMS.some((d) => t.includes(d)))
  return {
    risk: true,
    dominant,
    surfaces: [
      {
        type: hits[0],
        dominant,
        // Nothing structured was recorded, so nothing is known about what
        // it shows. Deliberately empty rather than invented.
        expectedVisibleContent: [],
        confidence: 'unknown'
      }
    ],
    // The analyzer never described the reflection, so its content is
    // unknown by construction.
    contentUnknown: true,
    legacyTextOnly: true,
    reason: `A reflective surface ("${hits[0]}") appears in the analysis text, but this analysis predates reflection modelling, so what it shows is unknown.`
  }
}

/** The combined evidence for a PAIR — the union of both frames' hazards. */
export function reflectionEvidenceForPair(
  from: ImageAnalysis | null,
  to: ImageAnalysis | null
): ReflectionEvidence {
  const a = reflectionEvidenceForImage(from)
  const b = reflectionEvidenceForImage(to)
  if (!a.risk && !b.risk) return NO_REFLECTION_EVIDENCE

  const surfaces = [...a.surfaces, ...b.surfaces]
  return {
    risk: true,
    dominant: a.dominant || b.dominant,
    surfaces,
    // Either end being unreadable is enough: the clip has to render both.
    contentUnknown: a.contentUnknown || b.contentUnknown,
    legacyTextOnly: a.legacyTextOnly || b.legacyTextOnly,
    reason: a.reason ?? b.reason
  }
}

/**
 * Everything a mirror is known to reflect across a pair, de-duplicated.
 * This is what the generation prompt can state positively.
 */
export function expectedReflectionContent(evidence: ReflectionEvidence): string[] {
  const seen = new Set<string>()
  for (const s of evidence.surfaces) {
    for (const c of s.expectedVisibleContent ?? []) {
      const t = c.trim()
      if (t) seen.add(t)
    }
  }
  return [...seen]
}

/**
 * IS AN AI CAMERA MOVE DEFENSIBLE WITH THIS REFLECTOR IN FRAME?
 *
 * Not "is there a mirror" — a small mirror over a basin in a wide shot is
 * not what went wrong. What went wrong was a LARGE mirror whose contents
 * nobody could state, in a move that had to swing past it.
 *
 * Refuses when either half of the argument is missing: we cannot say what
 * the mirror shows, or the planned motion needs the reflection re-drawn
 * from an angle the photographs never captured.
 */
export function reflectionBlocksAi(
  evidence: ReflectionEvidence,
  motionCrossesReflection: boolean
): { blocked: boolean; reason: string | null } {
  if (!evidence.risk) return { blocked: false, reason: null }

  if (evidence.dominant && evidence.contentUnknown) {
    return {
      blocked: true,
      reason:
        'A large reflective surface is in frame and the analysis cannot say what it reflects, so the model would have to invent the reflection.'
    }
  }

  if (motionCrossesReflection) {
    return {
      blocked: true,
      reason:
        'The planned camera path moves across a reflective surface, which cannot be rendered without deciding what the mirror shows of the observer.'
    }
  }

  // A known, non-dominant reflector with described content: the prompt
  // can state what belongs in it, so AI stays available.
  return { blocked: false, reason: null }
}

/**
 * Does the planned motion swing the viewpoint across a reflector?
 *
 * Deliberately crude and deliberately pessimistic. True mirror geometry —
 * surface normal, reflection cone, where the virtual camera falls — is not
 * recoverable from a single photograph, and pretending otherwise would be
 * inventing the exact precision this whole file exists to distrust.
 *
 * So it answers a narrower question that IS answerable: does the motion
 * description talk about the mirror? The failing clip's own instruction —
 * "turning away from the mirror reflection" — is caught by this, and any
 * path described in terms of a reflector is one where the model has been
 * invited to reason about the observer's position in it.
 */
export function motionReferencesReflector(motionText: string | null | undefined): boolean {
  return mentionsReflector(motionText ?? '') !== null
}

/**
 * Is this landmark a reflector, and therefore unusable as a camera anchor?
 *
 * The planner phrases motion around named landmarks — "turning away from
 * the X toward the Y". When X is a mirror, that sentence asks the model
 * to reason about the observer's position relative to a reflecting
 * surface, which is the request that produced a photographer. A mirror
 * may be IN the room; it may never be the thing the camera is described
 * as moving relative to.
 */
export function isReflectiveLandmark(landmark: string): boolean {
  return mentionsReflector(landmark) !== null
}
