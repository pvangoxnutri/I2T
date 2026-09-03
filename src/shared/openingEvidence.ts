/**
 * IS THIS OPENING SOMETHING A CAMERA CAN TRAVEL THROUGH?
 *
 * ── WHY GLASS NEEDS ITS OWN ANSWER ───────────────────────────────────
 *
 * "There is an opening between these two spaces" and "a camera can fly
 * from one to the other" are different claims, and glass is exactly where
 * they come apart. A fixed picture window makes the next room perfectly
 * VISIBLE while making it completely UNREACHABLE — so treating visibility
 * as traversability produces a generated clip that flies through solid
 * glazing, which is the hallucination this whole gate exists to stop.
 *
 * An open sliding patio door is the opposite case: also glass, genuinely
 * traversable, and the single most common real connection between a
 * terrace and a living room. Refusing it is a false negative that costs
 * the operator a transition they could legitimately have had.
 *
 * So the distinction is drawn on the PORTAL NOUN, not on the material:
 * a door, doorway, archway, passage or entrance is a way through; a
 * window, pane or skylight is not, whatever it is made of. Anything that
 * names neither is not evidence of a route.
 *
 * ── CONSERVATIVE BY CONSTRUCTION ─────────────────────────────────────
 *
 * Unrecognised wording returns false. Wording that says the way through
 * is shut returns false even when it names a door. The default answer to
 * "can the camera go this way?" is no.
 */

/** Words that name a way THROUGH a wall. */
const PORTAL_NOUNS = [
  'doorway',
  'door',
  'archway',
  'arch',
  'passage',
  'passageway',
  'entrance',
  'entryway',
  'opening',
  'gateway',
  'threshold',
  'corridor',
  'hallway'
]

/**
 * Words that name something you can SEE through but not WALK through.
 * Present here so a "window" is never mistaken for a route, and so the
 * common phrase "glass wall" cannot smuggle itself in as an opening.
 */
const NON_PORTAL_NOUNS = ['window', 'pane', 'skylight', 'glass wall', 'glazed wall', 'mirror']

/** Wording that explicitly closes a portal that would otherwise qualify. */
const CLOSED_QUALIFIERS = ['closed', 'shut', 'sealed', 'fixed', 'locked', 'boarded']

/**
 * Whether one recorded opening describes a route a camera could take.
 *
 * Input is the analyzer's free text, e.g. "open sliding glass door to
 * terrace" or "large fixed window overlooking pool".
 */
export function isTraversableOpening(description: string): boolean {
  const text = description.toLowerCase().trim()
  if (text.length === 0) return false

  // "closed door" is not a route, however clearly it is a door.
  if (CLOSED_QUALIFIERS.some((q) => text.includes(q))) return false

  const namesPortal = PORTAL_NOUNS.some((n) => text.includes(n))
  if (!namesPortal) return false

  // A phrase can name both ("window beside the patio door"). The portal
  // only counts if the portal word is not merely qualifying the non-portal
  // one — checked by requiring a portal noun that is not itself part of a
  // non-portal phrase.
  const strippedOfNonPortals = NON_PORTAL_NOUNS.reduce(
    (acc, noun) => acc.split(noun).join(' '),
    text
  )
  return PORTAL_NOUNS.some((n) => strippedOfNonPortals.includes(n))
}

/** The traversable entries among a frame's recorded openings. */
export function traversableOpenings(openings: string[] | undefined | null): string[] {
  if (!openings) return []
  return openings.filter(isTraversableOpening)
}

/**
 * Whether a frame shows a way out of the space it was taken in.
 *
 * This is the ONLY basis for staging a move through a wall: an opening
 * that is not visible from where the camera starts cannot be entered
 * without inventing the geometry in between.
 */
export function hasTraversableExit(openings: string[] | undefined | null): boolean {
  return traversableOpenings(openings).length > 0
}
