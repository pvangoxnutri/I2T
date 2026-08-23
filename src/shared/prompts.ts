/**
 * The default FrameToFrame transition prompt.
 *
 * This is the wording that has produced our best start-frame → end-frame
 * results, promoted from an ad-hoc string to a real preset. New transitions
 * inherit it; an edited prompt is NEVER overwritten (see
 * `promptForTransition`).
 */
export const DEFAULT_TRANSITION_PROMPT = `Create a seamless, photorealistic cinematic camera transition from the START FRAME to the END FRAME.

Move the camera smoothly and naturally through the space, as if filmed with a professional stabilized gimbal.

CRITICAL:
- The END FRAME must be reproduced EXACTLY as provided.
- Finish on the exact camera position, composition, perspective, framing, architecture, furniture, lighting, colors and objects of the END FRAME.
- Do not redesign, reinterpret, add, remove, move or alter anything in the property.
- Preserve realistic room geometry and architectural structure throughout.
- No morphing, warping, melting, stretching or artificial object transformations.
- No sudden cuts or jumps.
- Use smooth, physically plausible camera movement.
- Gradually converge toward the END FRAME so that the final moment becomes perfectly still and matches it exactly.

Professional luxury real-estate cinematography. Natural motion. Stable geometry. Photorealistic. Subtle cinematic movement.`

/**
 * The prompt actually sent for a transition: the user's own words when they
 * wrote any, otherwise the default preset. Empty/whitespace-only custom
 * prompts fall back rather than sending nothing.
 */
export function promptForTransition(customPrompt: string | null | undefined): string {
  const trimmed = (customPrompt ?? '').trim()
  return trimmed.length > 0 ? trimmed : DEFAULT_TRANSITION_PROMPT
}
