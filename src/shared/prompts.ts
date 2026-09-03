/**
 * The default FrameToFrame transition prompt.
 *
 * This is the wording that has produced our best start-frame → end-frame
 * results, promoted from an ad-hoc string to a real preset. New transitions
 * inherit it; an edited prompt is NEVER overwritten (see
 * `promptForTransition`).
 *
 * Prioritizes:
 * - DRONE-LIKE CAMERA MOTION: floating, gliding, ultra-stabilized (not handheld)
 * - SMOOTH START: almost imperceptible initial motion, eased-in, no snap
 * - SMOOTH END: eased-out arrival, perfectly still landing, no sudden stop
 * - FIDELITY TO THE REAL PHOTOGRAPHS at both ends
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
interface PromptSection {
  id: string
  /** `mandatory` blocks are never removed to save characters. */
  priority: 'mandatory' | 'droppable'
  text: string
}

const OPENING: PromptSection = {
  id: 'opening',
  priority: 'mandatory',
  text: 'Create a seamless, photorealistic cinematic camera transition from the START FRAME to the END FRAME.'
}

/** How the move should FEEL. Real quality, but not a safety rule. */
const CAMERA_FEEL: PromptSection = {
  id: 'camera-feel',
  priority: 'droppable',
  text:
    'CAMERA: high-end stabilized gimbal or indoor drone — floating, gliding, continuous. Ease in from an almost imperceptible start, travel steadily, then ease out to a still landing. No handheld feel, no walking bob, no footsteps, no vibration, no micro-jitter, no sudden rotation.'
}

/** What the two supplied photographs mean. Never dropped. */
const FRAMES: PromptSection = {
  id: 'frames',
  priority: 'mandatory',
  text:
    'FRAMES: begin at the exact position, angle and perspective of the START FRAME. Preserve strong visual continuity with both supplied images, with no snap and no abrupt exposure, colour or perspective change. The END FRAME must be reproduced EXACTLY as provided — its camera position, composition, framing, architecture, furniture, lighting, colours and objects — and the final frame must be perfectly still.'
}

/**
 * The rule a real generation broke by putting a photographer in a
 * mirrored wardrobe. Mandatory, and unconditional: detection is the
 * wrong thing to depend on, because a missed mirror puts a stranger in a
 * listing while the rule costs nothing in a room without one.
 */
const REFLECTIONS: PromptSection = {
  id: 'reflections',
  priority: 'mandatory',
  text:
    'PROPERTY UNOCCUPIED: the property is completely unoccupied in every frame and every reflection. Mirrors, mirrored wardrobes, glass and other reflective surfaces must never show people, photographers, camera operators, cameras, phones, tripods, filming equipment, human silhouettes or human reflections. Do not invent an observer behind the camera; reflections show only the property, its furniture and light.'
}

/** The anti-hallucination contract. Never dropped. */
const GEOMETRY: PromptSection = {
  id: 'geometry',
  priority: 'mandatory',
  text:
    'GEOMETRY: preserve real room geometry and architectural structure. Do not redesign, reinterpret, add, remove, move or alter anything in the property. No morphing, warping, melting or stretching. Use smooth, physically plausible camera movement: never pass through walls, floors, ceilings or furniture. Keep lighting, colours and object placement consistent. No cuts or jumps.'
}

/** Tone. The first thing to go when characters run short. */
const STYLE: PromptSection = {
  id: 'style',
  priority: 'droppable',
  text: 'Professional luxury real-estate cinematography. Faithful to the supplied frames.'
}

const PROMPT_SECTIONS: PromptSection[] = [
  OPENING,
  CAMERA_FEEL,
  FRAMES,
  REFLECTIONS,
  GEOMETRY,
  STYLE
]

/**
 * Droppable blocks in the order they are sacrificed — least valuable
 * first. Tone goes before the description of how the camera should move.
 */
const SACRIFICE_ORDER: PromptSection[] = [STYLE, CAMERA_FEEL]

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
 * `OPENING` is deliberately absent: it states the task, and a custom
 * prompt has by definition stated the task itself.
 */
const MANDATORY_TAIL = [FRAMES, REFLECTIONS, GEOMETRY].map((s) => s.text).join('\n\n')

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

  // ── ONLY A CUSTOM PROMPT REACHES HERE ──────────────────────────────
  //
  // The preset with everything droppable removed is far under any
  // provider limit, so an over-length prompt at this point is the
  // operator's own text. Their wording is shortened — never the
  // constraints — and the mandatory blocks are re-appended so the
  // request still carries them.
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
