/**
 * KEEP THE ROUTE, DROP THE TEMPO.
 *
 * ── THE BUG THIS FIXES ────────────────────────────────────────────────
 *
 * A pair's movement instruction can come from Gemini, which is asked
 * "how a camera could move between these two viewpoints". That question
 * invites prose, and prose arrives with a speed in it. Measured in the
 * operator's own database: `rotate gently toward the window`.
 *
 * "Gently" is a tempo instruction. It was reaching the model in the same
 * prompt as MOTION — CONTINUOUS CONSTANT VELOCITY, which says the
 * opposite, and the pair-specific sentence is the more concrete of the
 * two. That is why a transition rebuilt by Re-analyse stopped feeling
 * like one continuous take while the same pair rebuilt by prompt repair
 * did.
 *
 * ── WHY SANITISE RATHER THAN ONLY ASK NICELY ─────────────────────────
 *
 * The analyzer instruction is tightened too — it now asks for the route
 * and forbids describing speed. But an instruction is a request, and a
 * language model is free to decline it. This is the part that cannot
 * decline, so this is where the guarantee lives.
 *
 * ── WHAT IS DELIBERATELY LEFT ALONE ──────────────────────────────────
 *
 * Everything spatial. Landmarks, openings, directions, turns, what
 * enters and leaves frame — the pair-specific findings are the whole
 * value of the analysis and nothing here touches them.
 *
 * "Smoothly" also stays. It describes the PATH being continuous rather
 * than the speed changing, the canonical planner already uses it
 * ("reposition smoothly between the two viewpoints"), and removing it
 * would rewrite wording that was never the problem.
 */

/**
 * Tempo and easing vocabulary, with what each becomes.
 *
 * Ordered: multi-word phrases first, so "ease into" is handled before a
 * bare "ease" can match inside it.
 */
const REWRITES: Array<[RegExp, string]> = [
  // Easing and arrival, which are the same instruction twice.
  [/\b(?:ease|eases|easing)\s+(?:in|out|into|toward|towards)\b/gi, 'move into'],
  [/\b(?:settle|settles|settling)\s+(?:in|into|on|onto)\b/gi, 'arrive in'],
  [/\b(?:drift|drifts|drifting)\s+(?:to a stop|to a halt)\b/gi, 'continue'],
  [/\b(?:come|comes|coming)\s+to\s+a\s+(?:stop|halt|rest)\b/gi, 'continue'],
  [/\b(?:slow|slows|slowing)\s+(?:down|to a stop|to a halt)\b/gi, 'continue'],
  [/\b(?:speed|speeds|speeding)\s+up\b/gi, 'continue'],

  // Verbs that carry a speed or a style of their own.
  [/\b(?:glide|glides|gliding)\b/gi, 'move'],
  [/\b(?:float|floats|floating)\b/gi, 'move'],
  [/\b(?:drift|drifts|drifting)\b/gi, 'move'],
  [/\b(?:creep|creeps|creeping|crawl|crawls|crawling)\b/gi, 'move'],
  [/\b(?:accelerate|accelerates|accelerating|decelerate|decelerates|decelerating)\b/gi, 'move'],
  [/\b(?:ease|eases|easing)\b/gi, 'move'],
  [/\b(?:settle|settles|settling)\b/gi, 'arrive'],

  // Bare tempo adverbs. These modify nothing spatial, so they simply go.
  [
    /\b(?:slowly|gently|softly|gradually|quickly|rapidly|swiftly|briskly|steadily|leisurely|deliberately)\s*/gi,
    ''
  ],

  // A last guard on the ontology this codebase keeps having to remove.
  [/\bthe camera\b/gi, 'the viewpoint'],
  [/\bcamera\s+(?:move|moves|movement|motion)\b/gi, 'viewpoint movement']
]

/** Left after a rewrite: doubled spaces, a space before a comma, etc. */
function tidy(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/,\s*,/g, ',')
    .replace(/\s+$/g, '')
    .replace(/^\s*,\s*/, '')
    .trim()
}

/**
 * A pair-specific instruction with every tempo claim removed.
 *
 * Returns null for null so a caller can keep "there is no instruction"
 * distinct from "the instruction said nothing".
 */
export function sanitizeMotionInstruction(text: string | null | undefined): string | null {
  if (text == null) return null
  let out = text
  for (const [pattern, replacement] of REWRITES) out = out.replace(pattern, replacement)
  const tidied = tidy(out)
  return tidied.length > 0 ? tidied : null
}

/**
 * Whether an instruction still claims something about speed.
 *
 * ── PHRASE-AWARE, NOT WORD-AWARE ─────────────────────────────────────
 *
 * The canonical contract FORBIDS these things by name — "never
 * accelerate, decelerate, ease, ramp, hesitate, pause, surge or settle"
 * — so a naive substring search finds them inside their own prohibition
 * and reports the correct prompt as broken. Every freshly built prompt
 * then flags, and a preflight that consumes this refuses to generate
 * anything at all. That has happened once in this codebase already.
 *
 * Negated spans are therefore removed before matching, and the negation
 * is followed across a comma list — "never accelerate, decelerate,
 * ease" is one prohibition, not one prohibition and two requests.
 */
const TEMPO_CLAIMS = [
  'ease in',
  'ease out',
  'ease into',
  'eases into',
  'easing into',
  'settle into',
  'settles into',
  'settling into',
  'gradually slow',
  'slow start',
  'soft landing',
  'drift to a stop',
  'accelerate',
  'decelerate',
  'slowly',
  'gently',
  'speed up',
  'slow down'
]

export function containsTempoClaim(text: string | null | undefined): boolean {
  if (!text) return false
  const stripped = text
    .toLowerCase()
    // A negation governs everything up to the end of its sentence,
    // including the commas inside a list of what is forbidden.
    .replace(/\b(?:no|not|never|without|avoid)\b[^.;!?]*/g, ' ')
  return TEMPO_CLAIMS.some((phrase) => stripped.includes(phrase))
}
