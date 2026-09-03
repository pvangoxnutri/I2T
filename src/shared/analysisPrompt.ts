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
export const PROPERTY_ANALYSIS_INSTRUCTION = `You are examining every photograph from ONE real property. Your job is to identify what is ACTUALLY VISIBLE and testable, not what is plausible or likely.

PRIMARY OBJECTIVE: IDENTIFY MARKETING HIGHLIGHTS
Before analyzing connectivity, identify and rank the strongest selling points:
- Standout features (pool, deck, spectacular view, premium kitchen, unique architecture)
- Primary living spaces (living room, dining room)
- Secondary spaces (bedrooms, bathrooms, bonus rooms)
- Functional spaces (laundry, garage, utility)

Assign each room a marketingImportance score 0-10:
- 9-10: Hero / wow factor (pool, stunning view, exceptional space)
- 8-9: Strong primary selling spaces (living room, premium kitchen)
- 5-8: Secondary spaces (bedrooms, bathrooms)
- 2-4: Functional / utility spaces

WHAT TO DETERMINE
- Which images show the SAME room or scene.
- Recurring FIXED architectural features: windows, doorways, wall angles, floor transitions, ceiling details, built-in fixtures.
- Recurring FURNITURE and OBJECT landmarks: specific sofas, tables, islands, lamps.
- Openings and doorways VISIBLE in each image, and what can be seen through them.
  Say explicitly whether each one is a WAY THROUGH or only a VIEW.
  Write "open sliding glass door", "open patio door", "doorway", "archway" or
  "open passage" when a person could walk through it. Write "fixed window",
  "picture window", "glass wall" or "closed sliding door" when they could not.
  This distinction decides whether a camera may travel through the opening, so
  a window described as a door will produce a clip that flies through glazing.
- Visual OVERLAP between images: which pairs share a region of the same space.
- Approximate CAMERA ORIENTATION for each image, expressed relative to shared landmarks rather than compass directions.
- SAFE transitions: pairs where a camera move can be defended with strong visual evidence.
- UNSAFE transitions: pairs requiring invented/hidden geometry.

CRITICAL: AI VIDEO SAFETY RULES
AI video transitions must NEVER invent geometry. A transition is "safe" ONLY when:
- BOTH images are from the same room AND share clear architectural overlap (same walls, windows, furniture, landmarks)
  OR
- The images are from different rooms AND you can trace a clear, visible PATH:
  - A doorway is visible in the start image
  - The destination is recognizable through/beyond that opening
  - No hidden rooms, corridors, or stairs need to be assumed
  - The spatial logic can be defended to someone reviewing the property

A transition is "UNSAFE" if it requires:
- Assuming what is behind a closed door or wall
- Inventing a corridor or path not visible in the images
- Inferring how a staircase connects floors without seeing it
- Assuming a typical floor plan layout instead of what the photos show
- Relying on "probably connected" or "likely" without direct visual evidence

EVIDENCE RULES — these are not optional
- Use ONLY what is VISIBLE in the supplied photographs.
- Never invent a door, corridor, staircase or room connection that is not visible.
- Never infer a connection from how a floor plan "usually" works.
- If two rooms might connect but no photograph shows it, the relationship is "unknown". Unknown is CORRECT.
- Every claimed relationship must cite the image IDs that support it.
- When uncertain about a transition, it is UNSAFE. Err on the side of caution.
- Keep OBSERVATION separate from INFERENCE. "A grey sofa appears in images 1 and 4" is an observation. "Images 1 and 4 show the same living room" is an inference.

CONFIDENCE (for room membership, not for transitions)
- "confirmed": strong, direct visual evidence (same room, clear overlap).
- "probable": reasonable inference from shared landmarks, but not directly shown.
- "unknown": insufficient evidence. Do not downgrade to "probable" to be helpful.

IMAGE FILTERING
Weak images (redundant, visually poor, creating bad spatial flow) CAN AND SHOULD be excluded from the feed proposal.
Prefer 12 excellent, clear images over 30 confusing, overlapping ones.
An image should be EXCLUDED if:
- It is redundant (duplicate angle of the same room)
- It is visually weak or poorly composed
- It creates poor spatial continuity (requires unsafe transitions)
- It does not contribute meaningful marketing value

DO NOT
- Do not estimate distances, dimensions, areas or metric coordinates.
- Do not produce a floor plan or claim to know where rooms are relative to each other.
- Do not describe anything not present in the photographs.
- Do not speculate about parts of the property that were not photographed.
- Do not downgrade confidence claims to be "helpful" when evidence is weak.
- Do not invent plausible geometry.

OUTPUT
Return structured data matching the PropertyAnalysis schema:
- rooms: with ID, label, image IDs, marketingImportance (0-10), confidence, and notes
- images: with room assignment, marketingImportance, isHero flag, landmarks, openings, overlaps, orientation
- edges: with confidence, supportingImageIds, visibleOpeningImageIds, and notes explaining the evidence
- transitionHints: with pair-specific safety assessment and reasoning

FOR EACH IMAGE PAIR in the proposed feed sequence, include a safety note explaining:
- WHY it is safe (if recommending AI), or
- WHY it requires CUT or removal (if safety is uncertain)`

/**
 * Rendered for display. Contains no credentials, no filesystem paths and
 * no image bytes — safe to show in the UI and to copy into a bug report.
 */
export function analysisInstructionPreview(imageCount: number): string {
  return `${PROPERTY_ANALYSIS_INSTRUCTION}\n\nIMAGES: ${imageCount} photographs from one property, supplied in walk-through order.`
}
