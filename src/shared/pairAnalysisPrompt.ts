/**
 * THE SINGLE-PAIR ANALYSIS INSTRUCTION.
 *
 * ── HOW IT DIFFERS FROM THE WHOLE-PROPERTY PROMPT ────────────────────
 *
 * `analysisPrompt.ts` asks a model to read an entire library and propose
 * a feed. That is the wrong job here and an actively dangerous one: a
 * model given thirty-seven photographs and asked about one joint will
 * happily reorganise the film. This asks about ONE transition and says
 * so four times, because a model that starts selecting images will
 * silently produce a different video.
 *
 * The other photographs are still sent — they are what makes a spatial
 * claim checkable — but strictly as context for triangulating the pair.
 *
 * ── EVIDENCE, NOT VERDICTS ───────────────────────────────────────────
 *
 * It returns what it can SEE. The AI/CUT decision is made afterwards by
 * `evaluateTransitionSafety`, the same gate every other path uses. A
 * model's own opinion about whether a move is safe is not a second
 * evaluator we are willing to have.
 */
export const PAIR_ANALYSIS_INSTRUCTION = `You are analysing ONE camera transition between exactly two photographs of a single real property.

PRIMARY TARGET
Only the transition FROM the START image TO the END image, both labelled below.

Analyse ONLY this pair.
Do NOT propose a feed order.
Do NOT select, rank, add or remove images.
Do NOT describe any other transition.

SUPPORTING CONTEXT
Every other photograph of this property is supplied purely so you can triangulate the layout — which room each viewpoint is in, how walls and openings relate, what a mirror is facing. Use them as evidence. Never treat them as part of the transition.

WHAT TO RETURN, for this pair only
- relation: are the two frames in the SAME room, in ADJACENT rooms, or is it UNKNOWN. "unknown" is a correct and useful answer.
- roomLabel: the room the transition happens in or out of, if you can name it.
- sharedLandmarks: specific objects or fixtures visible in BOTH frames. These are what a camera can hold on to. Only list what is genuinely in both.
- openings: doorways, archways and open passages visible in the START frame. Say plainly if an opening is only a VIEW (a fixed window, a closed door) and not a way through — a window described as a door produces a clip that flies through glazing.
- overlapNotes: what region the two frames share, in your own words.
- reflectiveSurfaces: every mirror, mirrored wardrobe, shower glass, glass panel, polished metal or dark screen visible in either frame. For each: type, where it sits, whether it dominates the frame, and expectedVisibleContent — what the reflection ACTUALLY shows, read from the photograph. Leave expectedVisibleContent empty if you cannot read it. An empty list is correct; a guess is not. Never write "no person" there — list only surfaces you can see.
- geometryConflicts: anything that makes this move impossible rather than merely unproven — walls, fixtures or layouts that contradict each other between the frames. Leave empty when there is no conflict. Do NOT put "I am not sure" here; that belongs in missingContext.
- missingContext: specific facts you could not determine but a person standing in the room could answer, each phrased as a question.
- motionInstruction: the ROUTE between these two viewpoints, using only what is visible — which opening it passes through, which direction it turns, which landmark stays in view, what enters or leaves frame. Describe the PATH and nothing else. Do NOT describe speed, pace, easing, acceleration, stopping or settling, and do not use words like slowly, gently or gradually: how the movement is paced is decided elsewhere and a pace written here contradicts it. Never describe movement through architecture you cannot see. Never define the movement relative to a mirror or a reflection.

RULES
- Use ONLY what is visible in the supplied photographs.
- Never invent a door, corridor or connection.
- Keep OBSERVATION separate from INFERENCE.
- If the evidence is weak, say so through missingContext rather than lowering your standard.
- geometryConflicts and missingContext mean different things: a conflict is something you SAW that rules the move out; missing context is something you could not see.`

/** Only fields declared here can come back from structured output. */
export const PAIR_ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    relation: { type: 'string', enum: ['same-room', 'adjacent-room', 'unknown'] },
    roomLabel: { type: 'string' },
    sharedLandmarks: { type: 'array', items: { type: 'string' } },
    openings: { type: 'array', items: { type: 'string' } },
    overlapNotes: { type: 'string' },
    reflectiveSurfaces: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          locationDescription: { type: 'string' },
          dominant: { type: 'boolean' },
          expectedVisibleContent: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'string', enum: ['confirmed', 'probable', 'unknown'] }
        },
        required: ['type', 'dominant']
      }
    },
    geometryConflicts: { type: 'array', items: { type: 'string' } },
    missingContext: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['reflection-content', 'spatial-relationship', 'route-unconfirmed']
          },
          question: { type: 'string' }
        },
        required: ['type', 'question']
      }
    },
    motionInstruction: { type: 'string' }
  },
  required: ['relation', 'sharedLandmarks', 'openings', 'reflectiveSurfaces', 'geometryConflicts']
} as const
