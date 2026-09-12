/**
 * NO LONGER WIRED INTO THE PRODUCT. Sampled frames for the removed
 * post-generation quality validator; nothing calls it now.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ffmpegPath, probeDurationSec } from './ffmpegService'

/**
 * SAMPLE A GENERATED CLIP FOR INSPECTION.
 *
 * ── WHY A HANDFUL OF FRAMES ──────────────────────────────────────────
 *
 * A 5-second clip is ~125 frames. Sending them all to a vision model
 * would cost more than the generation did and answer the same question.
 * A person or a camera that appears in a generated transition is not a
 * single-frame artefact — the model renders it across the movement — so
 * six spread samples find it.
 *
 * ── WHY NOT THE EXACT LAST FRAME ─────────────────────────────────────
 *
 * Every I2T clip is required to settle on a still landing, so the tail is
 * often several identical frames of the supplied end photograph. That
 * photograph is real and was never generated, so inspecting it wastes a
 * sample on the one frame that cannot contain a hallucination. The last
 * sample is taken at 95%.
 */
const SAMPLE_POINTS = [0, 0.2, 0.4, 0.6, 0.8, 0.95]

export interface SampledFrame {
  /** Position in SAMPLE_POINTS order — what the validator reports back. */
  index: number
  /** Where in the clip it came from, for the operator-facing reason. */
  atSeconds: number
  base64: string
  mimeType: 'image/jpeg'
}

export interface FrameSampleResult {
  ok: boolean
  frames: SampledFrame[]
  reason?: string
}

/**
 * Extract the sample set as JPEGs.
 *
 * Downscaled to 640px wide: a vision model does not need a 1080p frame to
 * see a person, and the token cost scales with pixels. Written to a temp
 * directory and removed immediately — the frames are an intermediate, and
 * leaving stills of a customer's property on disk is not something to do
 * as a side effect of a quality check.
 */
export function sampleClipFrames(clipPath: string): FrameSampleResult {
  if (!existsSync(clipPath)) {
    return { ok: false, frames: [], reason: 'The generated clip is not on disk.' }
  }

  const duration = probeDurationSec(clipPath)
  if (!duration || duration <= 0) {
    return { ok: false, frames: [], reason: 'The clip duration could not be read.' }
  }

  let ffmpeg: string
  try {
    ffmpeg = ffmpegPath()
  } catch {
    return { ok: false, frames: [], reason: 'FFmpeg is not available on this system.' }
  }

  const dir = mkdtempSync(join(tmpdir(), 'i2t-qc-'))
  try {
    const frames: SampledFrame[] = []
    for (const [index, point] of SAMPLE_POINTS.entries()) {
      const at = Math.min(duration * point, Math.max(0, duration - 0.05))
      const out = join(dir, `frame-${index}.jpg`)
      // -ss BEFORE -i seeks by keyframe and is fast; accuracy to the
      // nearest keyframe is irrelevant when the question is "is there a
      // person anywhere in this clip".
      const res = spawnSync(
        ffmpeg,
        [
          '-hide_banner',
          '-loglevel', 'error',
          '-ss', at.toFixed(3),
          '-i', clipPath,
          '-frames:v', '1',
          '-vf', 'scale=640:-2',
          '-q:v', '4',
          '-y',
          out
        ],
        { timeout: 30_000, windowsHide: true }
      )
      if (res.status !== 0 || !existsSync(out)) continue
      frames.push({
        index,
        atSeconds: Number(at.toFixed(2)),
        base64: readFileSync(out).toString('base64'),
        mimeType: 'image/jpeg'
      })
    }

    if (frames.length === 0) {
      return { ok: false, frames: [], reason: 'No frames could be extracted from the clip.' }
    }
    return { ok: true, frames }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
