/**
 * THE WHOLE-PROPERTY ANALYSIS INSTRUCTION.
 *
 * ── THIS IS NOT A VIDEO PROMPT ───────────────────────────────────────
 *
 * `prompts.ts` tells a video model how to move a camera between two
 * frames. This tells a VISION model how to read a whole set of photographs
 * and report what it can actually see. They are different jobs with
 * different failure modes, so they are different presets and neither is
 * derived from the other.
 *
 * ── THE FAILURE MODE IT IS WRITTEN AGAINST ───────────────────────────
 *
 * A model asked "how do these rooms connect?" will answer confidently
 * whether or not the photos show it. That confident guess is worse than
 * silence here: it becomes a camera move through a doorway that does not
 * exist, in a video marketing a real home. So almost every rule below
 * exists to make `unknown` an acceptable answer — and to force evidence
 * to be cited when a relationship IS claimed.
 *
 * Stored centrally, like the video preset, so the wording is reviewable
 * in one place rather than embedded in a provider adapter.
 */
export const PROPERTY_ANALYSIS_INSTRUCTION = `You are examining every photograph from ONE real property. Reconstruct the visual relationships between these images conservatively.

WHAT TO DETERMINE
- Which images show the SAME room or scene.
- Recurring FIXED architectural features: windows, doorways, wall angles, floor transitions, ceiling details, built-in fixtures.
- Recurring FURNITURE and OBJECT landmarks: specific sofas, tables, islands, lamps.
- Openings and doorways VISIBLE in each image, and what can be seen through them.
- Visual OVERLAP between images: which pairs share a region of the same space.
- Approximate CAMERA ORIENTATION for each image, expressed relative to shared landmarks rather than compass directions.
- LIKELY ADJACENCY between rooms, and how confident that is.

EVIDENCE RULES — these are not optional
- Use ONLY what is visible in the supplied photographs.
- Never invent a door, corridor, staircase or room connection that is not visible.
- Never infer a connection from how a floor plan "usually" works.
- If two rooms might connect but no photograph shows it, the relationship is "unknown". Unknown is a correct and expected answer.
- Every claimed relationship must cite the image IDs that support it.
- Keep OBSERVATION separate from INFERENCE. "A grey sofa appears in images 1 and 4" is an observation. "Images 1 and 4 show the same living room" is an inference drawn from it.

CONFIDENCE
- "confirmed": strong, direct visual evidence. For an adjacency this means an opening is visible in one image AND the space beyond it is recognisable in the other.
- "probable": reasonable inference from shared landmarks or continuous architecture, but not directly shown.
- "unknown": insufficient evidence. Do not downgrade this to "probable" to be helpful.

DO NOT
- Do not estimate distances, dimensions, areas or metric coordinates.
- Do not produce a floor plan or claim to know where rooms are relative to each other.
- Do not describe anything not present in the photographs.
- Do not speculate about parts of the property that were not photographed.

OUTPUT
Return structured data matching the PropertyAnalysis schema: rooms with their image IDs and landmarks, per-image analysis with orientation, landmarks, openings and overlaps, and connections with confidence and supporting image IDs. Include a short note on each inference explaining what it was based on.`

/**
 * Rendered for display. Contains no credentials, no filesystem paths and
 * no image bytes — safe to show in the UI and to copy into a bug report.
 */
export function analysisInstructionPreview(imageCount: number): string {
  return `${PROPERTY_ANALYSIS_INSTRUCTION}\n\nIMAGES: ${imageCount} photographs from one property, supplied in walk-through order.`
}
