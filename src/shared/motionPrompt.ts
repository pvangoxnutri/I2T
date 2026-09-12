import { MOTION_LABEL, type MotionType } from './motionSegment'

/**
 * THE PROMPT FOR ONE PHOTOGRAPH IN MOTION.
 *
 * ── WHY NOT THE TRANSITION PRESET ────────────────────────────────────
 *
 * The transition prompt is built around two supplied frames: it names a
 * START FRAME and an END FRAME, demands the end frame be reproduced
 * exactly, and reasons about travelling between rooms. None of that
 * exists here. Sending it anyway would ask the model to reproduce an end
 * frame it was never given, which is an invitation to invent one — the
 * exact hallucination the transition rules exist to prevent.
 *
 * ── WHAT IS KEPT ─────────────────────────────────────────────────────
 *
 * The ontology and the anti-invention contract, in short form. There is
 * still no physical camera: the viewpoint is an invisible virtual one,
 * because a mirror in a still photograph reflects just as readily as one
 * in a transition. And nothing may be added, moved or redesigned — a
 * push-in that redecorates the room is worse than no clip at all.
 */

/**
 * What each motion asks for.
 *
 * ── WHY SMOOTH FORWARD IS LONGER THAN THE REST ───────────────────────
 *
 * Every other entry here is one restrained sentence, because a still
 * with gentle movement needs few constraints and padding dilutes the
 * ones that matter. Smooth Forward is the exception, and deliberately:
 * it is the one move a model will happily fake. Asked to go forward,
 * the cheap answer is to scale the frame up — no parallax, no doorway
 * passed, nothing revealed. So this one has to say what forward MEANS
 * (near things move faster than far things) and name the failure it
 * must not produce. That refusal is the instruction, not decoration.
 */
const MOTION_INSTRUCTION: Record<MotionType, string> = {
  'smooth-forward':
    'The invisible viewpoint moves slowly and steadily forward through the room, travelling into the space with the natural perspective change that real forward movement produces: nearer surfaces pass sooner than distant ones, and more of the far part of the room is gradually revealed. Do not simulate this as a digital zoom or a scaling of the frame. The movement is stabilised: no handheld feel, no walking bob, no shake, no sudden acceleration and no rotation.',
  'push-in':
    'The framing closes in slowly on the scene. The invisible viewpoint barely travels: this tightens the shot rather than moving through the room, so perspective stays close to the original.',
  'pull-out':
    'The framing opens out slowly, revealing slightly more of the room. The invisible viewpoint barely travels: this widens the shot rather than moving backward through the room, so perspective stays close to the original.',
  'pan-left': 'The invisible viewpoint moves slowly and horizontally to the left across the room.',
  'pan-right':
    'The invisible viewpoint moves slowly and horizontally to the right across the room.',
  'turn-left':
    'The invisible viewpoint turns gently to the left, a small smooth arc around the space.',
  'turn-right':
    'The invisible viewpoint turns gently to the right, a small smooth arc around the space.'
}

/**
 * The whole prompt for a single-image motion clip.
 *
 * Short on purpose. A still with gentle motion needs a fraction of the
 * constraints a room-to-room move does, and padding it with rules about
 * doorways it will never pass through only dilutes the ones that matter.
 */
export function buildMotionPrompt(motion: MotionType): string {
  // ── THE CLOSING LINE FOLLOWS THE MOVE ───────────────────────────────
  //
  // It used to end "no perspective invention" for every motion. For a
  // framing adjustment that is right. For SMOOTH FORWARD it directly
  // contradicts the instruction above it: travelling forward through a
  // room MUST change perspective, and forbidding that in the same
  // prompt that demands it is how a model is pushed back towards the
  // digital zoom this move exists to avoid. Nothing is loosened — the
  // ban on inventing unseen geometry stays, worded so it bans the right
  // thing.
  const closing =
    motion === 'smooth-forward'
      ? 'Keep the motion slow, smooth and stable throughout. No morphing, warping or stretching, no cuts, and no sudden movement. Do not invent rooms, doorways or objects that are not visible in the photograph — reveal only what real forward movement would uncover.'
      : 'Keep the motion slow, smooth and stable throughout. No morphing, warping or stretching, no perspective invention, no cuts, and no sudden movement.'

  return [
    'Create a subtle, photorealistic luxury real-estate shot from this single image.',
    'Preserve the architecture, furniture, fixtures, lighting and object placement exactly as photographed. Do not redesign, add, remove or move anything.',
    'The view is an invisible virtual viewpoint: no physical imaging device exists in this world, and nothing observes the property from within it. No people appear anywhere, including in any mirror or reflection.',
    MOTION_INSTRUCTION[motion],
    closing
  ].join('\n\n')
}

/** One line for the inspector, so the operator sees what was asked for. */
export function motionPromptSummary(motion: MotionType): string {
  return `${MOTION_LABEL[motion]} — ${MOTION_INSTRUCTION[motion]}`
}

export { MOTION_INSTRUCTION }
