/**
 * The default FrameToFrame transition prompt.
 *
 * This is the wording that has produced our best start-frame → end-frame
 * results, promoted from an ad-hoc string to a real preset. New transitions
 * inherit it; an edited prompt is NEVER overwritten (see
 * `promptForTransition`).
 *
 * Prioritizes:
 * - CONSTANT-VELOCITY MOTION: one speed, start to finish, perfectly stabilized
 * - NO EASING AT EITHER END: at speed from frame one, stopping dead on the last
 * - FIDELITY TO THE REAL PHOTOGRAPHS at both ends
 *
 * ── WHY THE EASING LANGUAGE WAS REMOVED ──────────────────────────────
 *
 * This list used to ask for an "eased-in" start and an "eased-out,
 * perfectly still landing". Asking a generative model to ease at both
 * ends of a five-second clip is asking it to vary speed across the whole
 * shot, and it does: slow, faster, slow. The result reads as drifting
 * rather than controlled. What produces a controlled-looking move is the
 * opposite instruction — one unchanging speed, and a hard stop.
 *
 * "Drone-like" went with it. It named a physical aircraft inside the
 * scene, which is the same implication the reflection rule below exists
 * to suppress.
 *
 * ── TWO THINGS THAT LOOK ALIKE AND ARE NOT ───────────────────────────
 *
 * "Pixel-perfect alignment" is not asked for anywhere here, and must not
 * be: demanding it of a generative model buys freezing and morph
 * artefacts, not accuracy. What IS asked for — and is non-negotiable — is
 * that the END FRAME is REPRODUCED, not reinterpreted. The end frame is a
 * real photograph of a real property; a model that invents its own
 * version of it has hallucinated the room. Continuity is a quality goal,
 * end-frame fidelity is a safety rule, and they are stated separately
 * below for that reason.
 *
 * ── WHY THE REFLECTION RULE IS UNCONDITIONAL ─────────────────────────
 *
 * A camera moving through a room implies something moving it, and a model
 * asked to render that motion will sometimes resolve the implication by
 * putting a person in the mirror. It produced a photographer standing in
 * a mirrored wardrobe in real output.
 *
 * The constraint is therefore stated for EVERY generation rather than
 * only where the analyzer spotted a mirror. Detection is the wrong thing
 * to depend on here: a missed mirror puts a stranger in a listing, while
 * the rule costs nothing in a room that has none. It also says what the
 * camera is NOT — nothing is holding it — because "no people" alone
 * leaves the observer implied.
 *
 * The safety sentences are pinned by the smoke suite
 * (`testPropertyAnalysis`, `testTransitionPlanning`). Rewording this
 * preset is fine; silently dropping one of them is not.
 */
/**
 * The sections the preset is built from, in send order.
 *
 * ── WHY SECTIONS AND NOT ONE STRING ──────────────────────────────────
 *
 * fal's `prompt` field accepts at most 2500 characters, and the preset
 * grew past it — a 422 from the provider, on every generation, with the
 * whole request rejected. Trimming that blind (`slice(0, 2500)`) would
 * have cut from the end, and the end is where the geometry and
 * reflection rules live: the request would have started succeeding while
 * quietly losing the constraints it exists to carry.
 *
 * So each block declares whether it may be dropped. `fitPromptToLimit`
 * removes the droppable ones, cheapest first, and never touches a
 * mandatory one. Style goes before camera feel; neither changes what the
 * model is forbidden to invent.
 */
/**
 * The provider's hard ceiling, stated once for everyone.
 *
 * fal returns 422 "String should have at most 2500 characters" and
 * rejects the whole request. It lives here rather than in the fal config
 * because the prompt is ASSEMBLED here, and a builder that cannot see the
 * budget it is building against will exceed it — which is exactly what
 * happened: prompts were assembled to ~3400 characters and cut down at
 * submit time, far too late for anything but a blind truncation.
 */
export const PROMPT_MAX_CHARS = 2500

interface PromptSection {
  id: string
  /** `mandatory` blocks are never removed to save characters. */
  priority: 'mandatory' | 'droppable'
  text: string
  /**
   * The same requirements with the redundant prose removed.
   *
   * NOT a weaker version. Every constraint the full text carries is
   * carried here too — what goes is restatement, and wording already
   * covered by another block. A section without one is never shortened.
   */
  compact?: string
}

const OPENING: PromptSection = {
  id: 'opening',
  priority: 'mandatory',
  text:
    'Render a seamless, photorealistic cinematic transition from the START FRAME to the END FRAME. The view is an invisible virtual viewpoint: no physical imaging device exists in this world, and the viewpoint is not an object and casts no shadow. Its motion is abstract rendering motion, not an object moving through the room.',
  // The task is obvious from the two frames; the ontology is not. What
  // survives is the half that stops the model inventing something to
  // hold the view.
  compact:
    'The view is an invisible virtual viewpoint: no imaging device exists here, it is not an object and casts no shadow.'
}

/**
 * HOW THE MOVE BEHAVES. A requirement, not a feeling.
 *
 * ── WHAT THIS REPLACES, AND WHY ──────────────────────────────────────
 *
 * The previous wording asked, in so many words, for the fault it
 * produced:
 *
 *   "Ease in from an almost imperceptible start, move steadily, then
 *    ease out to a still landing."
 *
 * That is a request for slow → faster → slow. Every clip generated from
 * it varied in tempo across its length, because that is exactly what it
 * described. The three-phase curve was never a rendering artefact; it
 * was in the prompt.
 *
 * ── SMOOTH PATH IS NOT VARIABLE SPEED ────────────────────────────────
 *
 * The two get conflated, so they are separated here. The PATH may curve
 * — architecture requires it, and a turn through a doorway is a curve.
 * The SPEED may not change while it does. "Slow down for the corner" is
 * the instinct this block exists to refuse.
 *
 * ── ARRIVAL WITHOUT DECELERATION ─────────────────────────────────────
 *
 * End-frame fidelity used to be bought with easing: drift in, settle,
 * land. It does not need to be.
 *
 * The first version of this block replaced that with "stops dead on the
 * END FRAME", which fixed the tempo inside a clip and then created a
 * different fault at the seams: several transitions played back to back
 * read as a series of separate moves, each one arriving and halting.
 * Operator testing confirmed both halves — the tempo was better, the
 * one-take feeling was not there.
 *
 * So arrival is no longer a stop. The END FRAME is REACHED AT TRAVEL
 * SPEED, still moving, exactly as a frame in the middle of a longer take
 * would be. The clip is a segment cut out of a continuous move, not a
 * move with a beginning and an end — which is what makes several of them
 * in sequence read as one camera.
 *
 * ── WHICH IS WHY "PERFECTLY STILL" LEFT `FRAMES` ─────────────────────
 *
 * `FRAMES` used to end "and the final frame must be perfectly still".
 * That is a statement about SPEED sitting in the block about
 * COMPOSITION, and it directly contradicts reaching the end frame at
 * travel speed. Frame fidelity means the end frame is REPRODUCED, not
 * that motion has ceased; those are separate requirements and only one
 * of them belongs here.
 *
 * ── AND NO PHYSICAL DEVICE, STILL ────────────────────────────────────
 *
 * "Perfectly stabilized virtual rail" is the load-bearing phrase: it
 * describes the QUALITY a gimbal or drone would give without putting one
 * in the room. The words gimbal, drone and camera do not appear, because
 * naming them is what once put a photographer in a bathroom mirror.
 *
 * MANDATORY, not droppable. This was `droppable`, so on a long prompt —
 * a reflective pair with operator context, which is when motion quality
 * matters most — the whole motion contract was silently trimmed away.
 */
const MOTION_QUALITY: PromptSection = {
  id: 'motion-quality',
  priority: 'mandatory',
  // ── AND IT HAS TO FIT ──────────────────────────────────────────────
  //
  // This is the one block with no room to spare: it is sent with every
  // transition, beside a pair-specific instruction that can run to 461
  // characters. An early draft ran to 918 and pushed real prompts past
  // the provider limit. The continuity wording below cost about 180 more
  // than the version it replaced, which was paid for by deleting the
  // duplicate stop-language from `FRAMES` and from the path planner —
  // both of which had to go anyway, because they contradicted it.
  //
  // Note what is NOT repeated here: the planner's instruction describes
  // the PATH, this describes the SPEED, and neither restates the other.
  // Three separate places injecting movement language is how the old
  // prompts ended up arguing with themselves.
  text:
    'MOTION — CONTINUOUS CONSTANT VELOCITY: the invisible viewpoint moves on a perfectly stabilized virtual rail at ONE CONSTANT SPEED throughout. The START FRAME is already travelling at that established speed, and the END FRAME is reached at exactly that same speed. Never accelerate, decelerate, ease, ramp, hesitate, pause, surge or settle. Do not launch out of the START FRAME or land into the END FRAME. This clip is a segment cut from one longer uninterrupted take.',
  // Every semantic above survives: still moving at both ends, one speed,
  // no launch, no landing, no settling, one continuous take. What goes
  // is the second half of each near-synonym pair.
  compact:
    'MOTION — CONTINUOUS CONSTANT VELOCITY: the invisible viewpoint moves on a perfectly stabilized virtual rail at ONE CONSTANT SPEED throughout. The START FRAME is already travelling at that speed and the END FRAME is reached at the same speed: never accelerate, decelerate, ease, settle, launch out of the START FRAME or land into the END FRAME. A segment cut from one longer take.'
}

/** What the two supplied photographs mean. Never dropped. */
const FRAMES: PromptSection = {
  id: 'frames',
  priority: 'mandatory',
  text:
    'FRAMES: begin at the exact position, angle and perspective of the START FRAME. Preserve strong visual continuity with both supplied images, with no snap and no abrupt exposure, colour or perspective change. The END FRAME must be reproduced EXACTLY as provided — its viewpoint, composition, framing, architecture, furniture, lighting, colours and objects.',
  compact:
    'FRAMES: begin at the exact position, angle and perspective of the START FRAME. The END FRAME must be reproduced EXACTLY as provided. No snap, no abrupt exposure change.'
}

/**
 * WHAT THE SCENE IS, not what is forbidden in it.
 *
 * ── WHY THE WORDING CHANGED ──────────────────────────────────────────
 *
 * The previous version said the property "is completely unoccupied" and
 * listed everything that must never appear in a reflection. A model then
 * generated a person walking past with a camera in a bathroom mirror —
 * with that exact sentence in the prompt.
 *
 * A prohibition leaves the thing conceptually present and merely
 * unwanted, and a camera gliding through a room implies something
 * carrying it. The model resolved that implication the only way it knew.
 * So this states ONTOLOGY instead: there is no person to hide, and the
 * viewpoint is not an object that could be reflected. It is placed
 * before geometry and camera movement because it defines what exists
 * before anything describes how to move through it.
 */
const OCCUPANCY: PromptSection = {
  id: 'occupancy',
  priority: 'mandatory',
  text:
    'SCENE OCCUPANCY — HARD CONSTRAINT: this is an entirely empty property. There are zero people anywhere in it. No human exists inside the frame, outside the frame, in another room, behind a doorway, or in any reflected space. Nothing observes the property from within it.',
  compact:
    'SCENE OCCUPANCY: an entirely empty property with zero people anywhere in it — not in frame, out of frame, in another room, behind a doorway or in any reflection.'
}

/**
 * Object permanence, stated as non-existence.
 *
 * "Do not show X" concedes that X is there and asks for it to be hidden —
 * which a mirror then contradicts, because a mirror's job is to reveal
 * what the frame does not show directly. Declaring the entities absent
 * from the scene removes the thing the reflection could disclose.
 */
const NONEXISTENT: PromptSection = {
  id: 'nonexistent-entities',
  priority: 'mandatory',
  text:
    'These entities do not exist in this world and can therefore never appear, in the frame or in any reflection: person, photographer, camera operator, visitor, human silhouette, face, hand, body part, human shadow, camera, phone, tripod, gimbal, drone, filming rig, recording equipment.',
  // The list keeps every category; the near-synonyms within a category go
  // (camera operator is a photographer, recording equipment is a filming
  // rig). "Or in any reflection" survives even here — it is the clause
  // the bathroom failure turned on.
  compact:
    'These do not exist in this world and can never appear, in frame or in any reflection: person, photographer, visitor, silhouette, face, hand, shadow, camera, phone, tripod, gimbal, drone.'
}

/** The anti-hallucination contract. Never dropped. */
const GEOMETRY: PromptSection = {
  id: 'geometry',
  priority: 'mandatory',
  text:
    'GEOMETRY: preserve real room geometry and architectural structure. Do not redesign, reinterpret, add, remove, move or alter anything in the property. No morphing, warping, melting or stretching. The viewpoint moves smoothly along a path that respects the architecture: never through walls, floors, ceilings or furniture. Keep lighting, colours and object placement consistent. No cuts or jumps.',
  compact:
    'GEOMETRY: Do not redesign, reinterpret, add, remove, move or alter anything. No morphing, warping, melting or stretching. The path respects the architecture: never through walls, floors, ceilings or furniture.'
}

/** Tone. The first thing to go when characters run short. */
const STYLE: PromptSection = {
  id: 'style',
  priority: 'droppable',
  text: 'Professional luxury real-estate cinematography. Faithful to the supplied frames.'
}

/**
 * THE ORDER IS PART OF THE SAFETY ARGUMENT.
 *
 * Frame fidelity, then what exists, then what cannot exist, then
 * geometry — and style last. The failing bathroom prompt put the
 * reflection rule fourth, in the middle of prose, and ended with the
 * per-transition camera instruction "turning away from the mirror
 * reflection": the final and most recent thing the model read was the
 * one sentence that made it reason about a mirror.
 *
 * Style is deliberately after every constraint and is the first thing
 * dropped when characters run short. Tone must never outrank what may
 * be generated.
 */
/**
 * ── AND WHY THE ORDER CHANGED AGAIN ──────────────────────────────────
 *
 * The pair's own movement instruction used to be appended LAST, after
 * the reflection block and the operator's context. On the operator's
 * real database that put it at character 2849–3034 of a ~3400-character
 * prompt, and the fitter's cut lands at ~2498: six of eight stored
 * transitions were submitting with no movement instruction at all. The
 * analysis that produced it had been run and paid for.
 *
 * So the order is now the order the model should read it in — what the
 * scene is, what the two frames are, WHERE THIS PAIR GOES, at what
 * speed, and then the constraints. Movement is third, not last.
 *
 * Style stays after every constraint and is still the first thing
 * dropped. Tone must never outrank what may be generated.
 */
const PROMPT_SECTIONS: PromptSection[] = [
  OPENING,
  FRAMES,
  MOTION_QUALITY,
  GEOMETRY,
  OCCUPANCY,
  NONEXISTENT,
  STYLE
]

/**
 * Droppable blocks in the order they are sacrificed.
 *
 * TONE IS NOW THE ONLY ONE. Motion quality used to be sacrificed
 * second, which meant the longest prompts — a reflective pair carrying
 * operator context, exactly where a steady move matters most — were the
 * ones that lost the motion contract entirely. Constant velocity is a
 * requirement now, so it is mandatory and cannot be trimmed.
 */
const SACRIFICE_ORDER: PromptSection[] = [STYLE]

export const DEFAULT_TRANSITION_PROMPT = PROMPT_SECTIONS.map((s) => s.text).join('\n\n')

/**
 * The constraints that must reach the provider whatever else is cut.
 *
 * ALL THREE, not just the last two. End-frame fidelity is as much a
 * safety rule as the reflection and geometry blocks — it is what stops
 * the model inventing its own version of a real photographed room — and
 * leaving it out of this tail meant a long custom prompt lost it while
 * appearing to keep "the constraints". The smoke suite caught that.
 *
 * `OPENING` is not included whole: it states the task, and a custom
 * prompt has by definition stated the task itself. Its ONTOLOGY half is,
 * because "the camera moves through the doorway" is exactly the kind of
 * sentence a hand-written prompt contains — and that sentence is what
 * taught the model there was a camera to reflect.
 */
const ONTOLOGY_LINE =
  'The view is an invisible virtual viewpoint: no physical imaging device exists in this world, and the viewpoint is not an object and casts no shadow.'

const MANDATORY_TAIL = [
  ONTOLOGY_LINE,
  FRAMES.text,
  OCCUPANCY.text,
  NONEXISTENT.text,
  GEOMETRY.text
].join('\n\n')

/**
 * THE REFLECTION BLOCK — only for pairs where a reflector was found.
 *
 * ── WHY THIS IS CONDITIONAL WHEN THE REST IS NOT ─────────────────────
 *
 * `OCCUPANCY` and `NONEXISTENT` ship with every generation, because a
 * missed mirror must still be covered. This block is the escalation for
 * pairs the analyzer flagged, and it is long: spending those characters
 * on every transition would crowd out geometry on a provider with a 2500
 * character ceiling, to say something already said.
 *
 * It sits immediately BEFORE the camera movement, so the last constraint
 * the model reads before being told how to move is the one about what a
 * mirror may contain while it moves.
 */
/**
 * ── ITS COMPACT FORM DROPS ONE ILLUSTRATION, NOTHING ELSE ────────────
 *
 * An earlier compact version of this block paraphrased "a reflection may
 * contain nothing that is not already part of the property" and "do not
 * animate anything inside one" — the two sentences that exist because a
 * model put a moving photographer in a bathroom mirror. That was wrong:
 * a compact form carries the same REQUIREMENTS with less prose, and
 * those are requirements, not prose.
 *
 * `REFLECTION_SAFETY_BLOCK_COMPACT` is therefore the full block with
 * exactly one clause removed — "a mirror facing the viewpoint reflects
 * the room behind it", which illustrates the sentence before it rather
 * than adding to it. Every other sentence, and every phrase the smoke
 * suite pins, is byte-identical.
 */
export const REFLECTION_SAFETY_BLOCK = [
  'REFLECTION CONTENT — ABSOLUTE:',
  'Every mirror reflects ONLY the architecture, furniture, fixtures, lighting and surfaces of the empty property itself.',
  'A reflection may contain nothing that is not already part of the property: do not add or invent anything in one, and do not animate anything inside one.',
  'There is no observer and no imaging device in this world; a mirror facing the viewpoint reflects the room behind it.',
  'Reflections are geometry, not events.',
  'If a reflection cannot be reconstructed faithfully, show a plain continuation of the empty room.'
].join('\n')

/** The block above minus its one illustrative clause. See the note above. */
export const REFLECTION_SAFETY_BLOCK_COMPACT = REFLECTION_SAFETY_BLOCK.replace(
  '; a mirror facing the viewpoint reflects the room behind it',
  ''
)

/**
 * What the mirror SHOULD show.
 *
 * A negative instruction gives a model nothing to draw. Naming the real
 * surfaces the analyzer read out of the reflection replaces "not a
 * person" with a positive target, which is the only version of this
 * instruction the model can actually satisfy.
 *
 * Returns null when nothing is known — an empty "reflects only:" list
 * would read as "reflects nothing" and invite the model to fill it.
 * Unknown content is handled upstream by refusing AI, not by bluffing
 * here.
 */
export function expectedMirrorContentBlock(
  surfaceLabel: string,
  contents: string[]
): string | null {
  if (contents.length === 0) return null
  return [
    'EXPECTED MIRROR CONTENT:',
    `The ${surfaceLabel} reflects only:`,
    ...contents.map((c) => `- ${c}`),
    'The mirror must not reveal any unseen observer or equipment.'
  ].join('\n')
}

/**
 * The same list without the closing warning.
 *
 * That sentence restates the reflection block, which is always present
 * when this block is — this is only ever added inside `if
 * (reflection.risk)`. The LIST is the part that does work a negative
 * cannot: it gives the model something to actually draw.
 */
export function expectedMirrorContentBlockCompact(
  surfaceLabel: string,
  contents: string[]
): string | null {
  if (contents.length === 0) return null
  return [
    'EXPECTED MIRROR CONTENT:',
    `The ${surfaceLabel} reflects only:`,
    ...contents.map((c) => `- ${c}`)
  ].join('\n')
}

/**
 * The preset's sections, addressable so a caller can interleave the
 * per-pair blocks between them instead of concatenating onto the end.
 *
 * Appending was the bug: everything pair-specific landed after every
 * fixed block, which put it past the provider's limit and made it the
 * first thing a length cut removed.
 */
export const PRESET_PARTS = {
  opening: OPENING,
  frames: FRAMES,
  motionQuality: MOTION_QUALITY,
  geometry: GEOMETRY,
  occupancy: OCCUPANCY,
  nonexistent: NONEXISTENT,
  style: STYLE
} as const

export interface PromptPart {
  id: string
  priority: 'mandatory' | 'droppable'
  text: string
  compact?: string
}

export type AssembledPrompt =
  | { ok: true; prompt: string; dropped: string[]; compacted: string[] }
  | { ok: false; reason: string; smallestChars: number; maxChars: number }

/**
 * ONE LADDER, IN THE ORDER THINGS ARE GIVEN UP.
 *
 * Two separate lists — drop everything droppable, then compact — got
 * this wrong: the mirror-content list was thrown away whole before the
 * opening paragraph had even been shortened. A single ordered ladder
 * makes the trade explicit at every rung.
 *
 * Tone first. Then redundant prose, block by block, roughly by how much
 * each restates something another block already says. Only at the very
 * bottom, `expected-mirror` goes entirely — and that is NOT the
 * reflection contract. The contract is `REFLECTION_SAFETY_BLOCK`, which
 * is mandatory and has no short form at all. This is its positive
 * companion, the list of what the mirror does contain: useful, but not
 * the thing that stops a model inventing a person in it.
 */
type Concession = { drop: string } | { compact: string }

const CONCESSION_LADDER: Concession[] = [
  { drop: 'style' },
  { compact: 'opening' },
  { compact: 'expected-mirror' },
  { compact: 'nonexistent-entities' },
  { compact: 'occupancy' },
  { compact: 'operator-context' },
  { compact: 'frames' },
  { compact: 'geometry' },
  // SECOND TO LAST, and only because the continuity wording made this
  // block the largest fixed cost in the prompt. Its compact form keeps
  // every semantic — moving at both ends, one speed, no launch, no
  // landing, no settling, one continuous take — and gives up only the
  // second half of each near-synonym pair.
  { compact: 'reflection' },
  { compact: 'motion-quality' },
  { drop: 'expected-mirror' }
]

/**
 * BUILD A PROMPT THAT FITS, BY PRIORITY — never by truncation.
 *
 * ── WHY THIS REPLACED A `slice()` ────────────────────────────────────
 *
 * The old path assembled the whole prompt as a string and handed it to
 * `fitPromptToLimit`, which could only drop STYLE by string replacement
 * and then cut the tail off. Measured on the operator's real database:
 * eight stored prompts of 2996–3458 characters, cut at ~2498, six of
 * them losing `VIEWPOINT MOVEMENT FOR THIS TRANSITION` entirely.
 *
 * Here the parts are still parts when the budget is applied, so what
 * gives way is chosen rather than whatever happened to be last:
 *
 *   1. droppable blocks (tone)
 *   2. compact forms of mandatory blocks — same requirements, less prose
 *   3. nothing. If the mandatory content cannot fit even compacted, this
 *      FAILS. A prompt missing a mandatory block is not a shorter
 *      prompt, it is a different contract, and sending it costs real
 *      money to produce something the constraints no longer cover.
 */
export function assemblePrompt(
  parts: PromptPart[],
  maxChars: number = PROMPT_MAX_CHARS
): AssembledPrompt {
  const compacted = new Set<string>()
  let kept = parts.filter((p) => p.text.trim().length > 0)

  const render = (): string =>
    kept
      .map((p) => (compacted.has(p.id) && p.compact ? p.compact : p.text))
      .join('\n\n')
      .trim()

  const dropped: string[] = []
  let out = render()
  const done = (): AssembledPrompt => ({
    ok: true,
    prompt: out,
    dropped,
    compacted: [...compacted]
  })
  if (out.length <= maxChars) return done()

  for (const step of CONCESSION_LADDER) {
    if ('drop' in step) {
      const i = kept.findIndex((p) => p.id === step.drop && p.priority === 'droppable')
      if (i < 0) continue
      kept = [...kept.slice(0, i), ...kept.slice(i + 1)]
      dropped.push(step.drop)
    } else {
      if (!kept.some((p) => p.id === step.compact && p.compact)) continue
      compacted.add(step.compact)
    }
    out = render()
    if (out.length <= maxChars) return done()
  }

  // Any droppable block the ladder does not name goes before failing —
  // a new one added elsewhere must not be worth more than the contract.
  for (const p of kept.filter((x) => x.priority === 'droppable')) {
    kept = kept.filter((x) => x !== p)
    dropped.push(p.id)
    out = render()
    if (out.length <= maxChars) return done()
  }

  // Fail loudly. Nothing left is safe to cut.
  return {
    ok: false,
    reason:
      `The required blocks for this transition come to ${out.length} characters even ` +
      `after every optional one was removed and the rest shortened, and the provider ` +
      `accepts ${maxChars}. Shorten the operator-provided spatial context for this pair, ` +
      `or the pair's movement instruction, and plan it again.`,
    smallestChars: out.length,
    maxChars
  }
}

export interface FittedPrompt {
  prompt: string
  /** Section ids removed to fit, in the order they were sacrificed. */
  dropped: string[]
  /** True when a custom prompt had to be shortened to make room. */
  truncatedCustomText: boolean
}

/**
 * FIT A PROMPT TO A PROVIDER'S CHARACTER LIMIT WITHOUT LOSING SAFETY.
 *
 * ── WHY NOT `slice(0, max)` ──────────────────────────────────────────
 *
 * The constraints live at the END of the prompt. A blind truncation
 * therefore removes exactly the reflection rule and the geometry
 * contract, turns a 422 into a 200, and starts producing the invented
 * rooms and mirrored photographers those rules exist to prevent. A
 * request that fails loudly is far better than one that succeeds after
 * quietly dropping its constraints.
 *
 * ── THE ORDER THINGS GO ──────────────────────────────────────────────
 *
 *   1. tone
 *   2. how the camera should feel
 *   3. (custom text only) the operator's own wording is shortened, and
 *      the mandatory constraints are re-appended after it
 *
 * Mandatory blocks are never removed. If even they exceed the limit the
 * prompt is returned unchanged and over-length, because silently sending
 * something that is not the safety contract is the one outcome worth
 * failing over.
 */
export function fitPromptToLimit(prompt: string, maxChars: number): FittedPrompt {
  if (prompt.length <= maxChars) {
    return { prompt, dropped: [], truncatedCustomText: false }
  }

  let out = prompt
  const dropped: string[] = []
  for (const section of SACRIFICE_ORDER) {
    if (out.length <= maxChars) break
    if (!out.includes(section.text)) continue
    out = out.replace(section.text, '').replace(/\n{3,}/g, '\n\n').trim()
    dropped.push(section.id)
  }
  if (out.length <= maxChars) return { prompt: out, dropped, truncatedCustomText: false }

  // ── ONLY A CUSTOM PROMPT SHOULD REACH HERE — AND NOW ONLY ONE DOES ─
  //
  // It used to say that and be wrong. Generated prompts arrived here
  // constantly: preset, reflection block, operator context and the
  // pair's movement instruction concatenated to ~3400 characters, with
  // only STYLE (80) available to give up. Measured on eight stored
  // transitions, the cut landed at ~2498 — after the motion contract
  // (offset 1678) and the reflection block (2013), but BEFORE
  // "VIEWPOINT MOVEMENT FOR THIS TRANSITION" (2849–3034). Six of the
  // eight submitted without the instruction the analysis produced.
  //
  // Generated prompts are now assembled by `assemblePrompt`, which
  // builds to the budget out of sections and FAILS rather than cutting.
  // What is left here is the case this code was written for: an
  // operator's own wording, which has no sections to reason about. Their
  // text is shortened, never the constraints, and the mandatory blocks
  // are re-appended after it.
  const tail = `\n\n${MANDATORY_TAIL}`
  const room = maxChars - tail.length
  if (room <= 0) return { prompt: out, dropped, truncatedCustomText: false }

  const head = out.includes(MANDATORY_TAIL) ? out.replace(MANDATORY_TAIL, '').trim() : out
  return {
    prompt: `${head.slice(0, room).trim()}${tail}`,
    dropped,
    truncatedCustomText: true
  }
}

/**
 * The prompt actually sent for a transition: the user's own words when they
 * wrote any, otherwise the default preset. Empty/whitespace-only custom
 * prompts fall back rather than sending nothing.
 */
export function promptForTransition(customPrompt: string | null | undefined): string {
  const trimmed = (customPrompt ?? '').trim()
  return trimmed.length > 0 ? trimmed : DEFAULT_TRANSITION_PROMPT
}

/**
 * THE MOTION HEADER — ONE DEFINITION, USED BY EVERY BUILDER.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────
 *
 * Three separate places appended the per-transition motion instruction,
 * each with its own hardcoded header:
 *
 *   shared/transitionPlan.ts       renderPrompt
 *   shared/promptPlanner.ts        planTransitionPrompt
 *   main/services/pairAnalysisService.ts   acceptPairAnalysis
 *
 * All three wrote `CAMERA MOVEMENT FOR THIS TRANSITION:` — and appended
 * it LAST, so the final thing the model read, after every constraint
 * saying no camera exists, was a heading announcing camera movement. In
 * a room with a mirror that is an instruction to render the thing the
 * rest of the prompt spent 900 characters denying.
 *
 * Rewriting it in one file would have fixed one of the three. It is one
 * function now, so a future edit cannot reach only part of the product.
 */
export const MOTION_HEADER = 'VIEWPOINT MOVEMENT FOR THIS TRANSITION:'

export function motionBlock(motion: string | null | undefined): string | null {
  const text = (motion ?? '').trim()
  return text.length > 0 ? `${MOTION_HEADER}\n${text}` : null
}

/**
 * WORDING RETIRED BECAUSE IT CAUSED THE FAILURE IT DESCRIBES.
 *
 * A prompt is STORED per transition and is not rebuilt when the preset
 * changes — which is correct, because an operator may have edited it.
 * The consequence is that improving the preset does nothing for work
 * already planned: the bathroom pair kept sending a 3789-character
 * prompt opening with "cinematic camera transition" and describing "a
 * high-end stabilized gimbal or indoor drone", long after none of that
 * existed in the source.
 *
 * These are the phrases that establish a physical filming device inside
 * the scene. The entity list in `NONEXISTENT` deliberately NAMES such
 * equipment in order to declare it absent, so this is matched against
 * ontology-establishing wording only.
 */
const RETIRED_ONTOLOGY = [
  'cinematic camera transition',
  'stabilized gimbal',
  'indoor drone',
  'physically plausible camera movement',
  'camera position',
  'behind the camera',
  'CAMERA MOVEMENT FOR THIS TRANSITION',
  'CAMERA: high-end'
]

/**
 * Wording from the retired VARIABLE-SPEED contract.
 *
 * ── WHY THIS IS ITS OWN LIST ─────────────────────────────────────────
 *
 * A stored prompt survives a preset change — that is the point, because
 * an operator may have edited it. The consequence learned once already
 * is that improving the preset does nothing for work already planned:
 * the old three-phase motion sentence stays in the row and keeps being
 * sent, long after the builder stopped producing it.
 *
 * These phrases all ask for a change of tempo across the clip, which is
 * the fault this contract replaced. They are matched separately from the
 * camera-ontology list because the two retirements happened for
 * different reasons and a prompt can carry either, or both.
 */
/**
 * The wordings the retired easing contract actually used.
 *
 * ── WHY THESE ARE PHRASES AND NOT STEMS ──────────────────────────────
 *
 * This list began as stems — `easing`, `accelerat`, `decelerat` — which
 * is the obvious way to write it and is wrong, because the CURRENT block
 * forbids those things by name: "never easing, accelerating or slowing".
 * A stem match finds the prohibition and reports the prompt that carries
 * it as stale. Every freshly rebuilt prompt then flags, and since the
 * generation preflight refuses a stale prompt, the app refuses to
 * generate anything at all.
 *
 * A negation stripper was tried first and is still applied below, but it
 * cannot carry the whole weight: negation distributes across a comma
 * list ("never easing, accelerating or slowing") while the stripper
 * stops at the first comma, so `accelerat` survived its own prohibition.
 *
 * Phrases specific to the old wording have no such collision. They are
 * what the retired prompts said; nothing we write now says them.
 */
const RETIRED_MOTION = [
  // A SUPERSEDED VERSION OF THIS VERY CONTRACT. The constant-velocity
  // block shipped first as a 918-character draft, and a repair run wrote
  // it into 8 stored prompts — which then measured 3096–4125 characters,
  // every one of them past fal's 2500-character limit. They are not
  // "retired easing"; they say the right thing at a length that cannot be
  // sent. Contract versioning has to catch the contract's own earlier
  // drafts, or a fix ships a new defect under the name of the old one.
  'perfectly stabilized, constant velocity',
  'angular velocity is likewise constant',
  'travels along a perfectly smooth, stabilized path',
  'ease in from',
  'ease out to',
  'eased-in',
  'eased-out',
  'ease into',
  'speed ramp',
  'gradually speed up',
  'gradually slow',
  'slowly begin',
  'settle into a still',
  'still landing',
  'imperceptible start',
  'drift to a stop',
  'float into position'
]

/** True when a stored prompt was built under the retired camera ontology. */
export function promptUsesRetiredOntology(prompt: string | null | undefined): boolean {
  const text = (prompt ?? '').toLowerCase()
  return RETIRED_ONTOLOGY.some((phrase) => text.includes(phrase.toLowerCase()))
}

/**
 * True when a stored prompt still ASKS FOR a change of speed.
 *
 * ── WHY THE NEGATIONS HAVE TO BE STRIPPED FIRST ──────────────────────
 *
 * The current contract FORBIDS these things by name: "No acceleration,
 * no deceleration, no easing, no speed ramping". A naive substring match
 * finds "accelerat" and "easing" in that sentence and concludes the
 * prompt is stale — so every freshly built prompt would be flagged, and
 * the preflight that consumes this would refuse to generate anything at
 * all. Measured on the real database: after a clean rebuild, 9 of 9
 * prompts matched their own prohibition.
 *
 * Negated clauses are therefore removed before matching. What remains is
 * only wording that REQUESTS a tempo change, which is the thing being
 * detected.
 */
export function promptUsesRetiredMotion(prompt: string | null | undefined): boolean {
  const text = (prompt ?? '')
    .toLowerCase()
    // Everything from "no"/"never"/"without" up to the next clause
    // boundary is a prohibition, not a request.
    .replace(/\b(?:no|never|without)\s+[^.,;:—]+/g, ' ')
  return RETIRED_MOTION.some((phrase) => text.includes(phrase))
}

/**
 * Whether a stored prompt was built under ANY superseded contract.
 *
 * The one question the repair and the generation preflight both ask, so
 * a prompt cannot be considered current by one and stale by the other.
 */
export function promptUsesRetiredContract(prompt: string | null | undefined): boolean {
  return promptUsesRetiredOntology(prompt) || promptUsesRetiredMotion(prompt)
}

/**
 * True when a stored prompt was assembled in the RETIRED LAYOUT.
 *
 * ── WHY LENGTH ALONE IS NOT THE TEST ─────────────────────────────────
 *
 * The old assembly appended the pair's movement instruction after every
 * fixed block. That is what pushed real prompts to 2996–3458 characters
 * against a 2500 limit, so most offenders are caught by simply being too
 * long — but not all of them. A short pair-specific instruction, or a
 * non-reflective pair with no operator context, can land under the limit
 * and still be built the wrong way round, with the movement last.
 *
 * Those are not harmless. They are one edit away from overflowing, and
 * the model reads the route after everything rather than near the top.
 * So the LAYOUT is checked directly: in a current prompt the movement
 * header comes before the occupancy block, because that is the order
 * `renderPrompt` now assembles them in.
 */
export function promptUsesRetiredLayout(prompt: string | null | undefined): boolean {
  const text = prompt ?? ''
  const movement = text.indexOf(MOTION_HEADER)
  if (movement < 0) return false
  const occupancy = text.indexOf('SCENE OCCUPANCY')
  if (occupancy < 0) return false
  return movement > occupancy
}

/** Over what the provider will accept, so it cannot be sent as written. */
export function promptExceedsLimit(prompt: string | null | undefined): boolean {
  return (prompt ?? '').length > PROMPT_MAX_CHARS
}

/** True when a prompt carries the constant-velocity requirement. */
export function promptCoversConstantVelocity(prompt: string | null | undefined): boolean {
  const text = (prompt ?? '').toLowerCase()
  return text.includes('constant velocity') || text.includes('one constant speed')
}

/**
 * Whether a prompt carries the reflection constraints a mirror pair needs.
 *
 * Used as a preventive rule rather than a description: a pair the
 * analyzer flagged for reflections must not be generated from a prompt
 * that never mentions what a mirror may contain — which is what the bare
 * preset, or a hand-written prompt, can easily be.
 */
export function promptCoversReflection(prompt: string | null | undefined): boolean {
  return (prompt ?? '').includes('REFLECTION CONTENT')
}
