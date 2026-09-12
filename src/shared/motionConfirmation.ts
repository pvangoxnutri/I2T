/**
 * WHAT THE PAID SINGLE-IMAGE DIALOG SHOWS.
 *
 * In `shared` rather than beside the service that builds it, because the
 * preload bridge and the renderer both need the shape. A type imported
 * from `src/main` pulls the entire main tree into the renderer's
 * TypeScript project — which is how a browser bundle ends up type-aware
 * of node:fs.
 */
export interface MotionConfirmationModel {
  id: string
  displayName: string
  durationsSec: number[]
  audioSupport: boolean
  confirmed: boolean
}

export interface MotionConfirmation {
  ok: boolean
  /** Why not, when not. */
  reason?: string
  segmentId: string
  /** `SINGLE IMAGE · SMOOTH FORWARD` — never an arrow, never a pair. */
  label: string
  /**
   * The movement THIS run will use.
   *
   * A per-run choice like the model and the duration: changing it in the
   * dialog changes the prompt and the request, and leaves the stored
   * segment and every previous generation untouched.
   */
  motion: string
  motionLabel: string
  /** One line describing what that movement asks the model for. */
  motionSummary: string
  /** Every movement the operator may pick, in the order they are offered. */
  motionOptions: { id: string; label: string }[]
  /**
   * What the CURRENT clip was actually made with, or null on a first run.
   *
   * Read from the generation row, never from the segment — the segment
   * carries the choice for the NEXT run, and confusing the two is how a
   * regeneration appears to rewrite its own history.
   */
  previous: {
    motion: string | null
    motionLabel: string
    model: string | null
    durationSec: number | null
    createdAt: number
  } | null
  /** `IMAGE 05`, its position in the feed. */
  imageLabel: string
  imageName: string
  imageSrc: string | null
  prompt: string
  /**
   * Models that can actually do this run. Never empty when `ok`.
   *
   * A model that cannot generate from a single image is EXCLUDED here
   * rather than offered and then refused — and the reason it is missing
   * is carried in `reason` when that leaves nothing to offer.
   */
  models: MotionConfirmationModel[]
  modelId: string
  modelDurations: number[]
  modelAudioSupport: boolean
  durationSec: number
  nativeAudio: boolean
  /** `$0.35` — the verified rate × the duration this run will use. */
  estimatedCostLabel: string
  estimatedCost: number | null
  attemptNumber: number
  isRegeneration: boolean
  priceUnavailableReason: string | null
}
