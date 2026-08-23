import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { AspectRatio, ExportDefaults, FfmpegStatus } from '../../shared/types'
import { planSeams, type SeamBlend } from '../../shared/seamBlend'

/**
 * All FFmpeg knowledge lives here — detection, probing and assembly. The
 * rest of the app talks in domain terms (clips in, MP4 out, progress 0–100).
 *
 * BINARY RESOLUTION, in order:
 *  1. the bundled ffmpeg-static binary (works offline, and is the path that
 *     later ships in the packaged app — with asarUnpack for the .exe)
 *  2. `ffmpeg` on the system PATH as a fallback
 * The user never configures a path.
 */

let cached: { path: string | null; status: FfmpegStatus } | null = null

function tryVersion(path: string): string | null {
  try {
    const res = spawnSync(path, ['-version'], { encoding: 'utf8', timeout: 10_000 })
    if (res.status !== 0 || !res.stdout) return null
    const match = res.stdout.match(/ffmpeg version (\S+)/)
    return match ? match[1] : 'unknown'
  } catch {
    return null
  }
}

function resolveBundled(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p = require('ffmpeg-static') as string | null
    return p && existsSync(p) ? p : null
  } catch {
    return null
  }
}

export function ffmpegStatus(): FfmpegStatus {
  if (cached) return cached.status

  const bundled = resolveBundled()
  if (bundled) {
    const version = tryVersion(bundled)
    if (version) {
      cached = { path: bundled, status: { available: true, version, source: 'bundled' } }
      return cached.status
    }
  }

  const systemVersion = tryVersion('ffmpeg')
  if (systemVersion) {
    cached = { path: 'ffmpeg', status: { available: true, version: systemVersion, source: 'system' } }
    return cached.status
  }

  cached = { path: null, status: { available: false, version: null, source: null } }
  return cached.status
}

export function ffmpegPath(): string {
  ffmpegStatus()
  if (!cached?.path) throw new Error('FFmpeg is not available on this system')
  return cached.path
}

// ── Output geometry ──────────────────────────────────────────────────────

const BASE_DIMS: Record<AspectRatio, { w: number; h: number }> = {
  '16:9': { w: 1920, h: 1080 },
  '9:16': { w: 1080, h: 1920 },
  '1:1': { w: 1080, h: 1080 },
  '4:5': { w: 1080, h: 1350 }
}

const RESOLUTION_SCALE: Record<ExportDefaults['resolution'], number> = {
  '720p': 720 / 1080,
  '1080p': 1,
  '4K': 2
}

const even = (n: number): number => 2 * Math.round(n / 2)

export function outputDims(defaults: ExportDefaults): { w: number; h: number } {
  const base = BASE_DIMS[defaults.aspectRatio]
  const scale = RESOLUTION_SCALE[defaults.resolution]
  return { w: even(base.w * scale), h: even(base.h * scale) }
}

// ── Probing ──────────────────────────────────────────────────────────────

/** Clip duration in seconds via ffmpeg's own header dump (no ffprobe in
 * ffmpeg-static). */
export function probeDurationSec(file: string): number {
  const res = spawnSync(ffmpegPath(), ['-hide_banner', '-i', file], {
    encoding: 'utf8',
    timeout: 20_000
  })
  // ffmpeg exits non-zero without an output file — the Duration line is in
  // stderr regardless.
  const match = `${res.stderr}`.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/)
  if (!match) return 0
  const [, h, m, s, cs] = match
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(`0.${cs}`)
}

// ── Assembly ─────────────────────────────────────────────────────────────

export interface AssembleOptions {
  /** Ordered clip paths — image-sequence order, N-1 clips for N images. */
  clipPaths: string[]
  defaults: ExportDefaults
  /** Full-frame transparent PNG overlays, applied bottom-up in order
   * (watermark first, signature last so it stays on top). */
  overlayPngPaths: string[]
  outputPath: string
  onProgress?: (pct: number) => void
  /**
   * Seam handling between adjacent clips. Omitted → the project default.
   * 'off' is the original plain-concat path, byte-for-byte unchanged.
   */
  seamBlend?: SeamBlend
}

export interface AssembleHandle {
  done: Promise<void>
  cancel: () => void
}

/**
 * Normalizes every clip (scale-with-pad to the target frame, square pixels,
 * uniform fps, audio dropped), concatenates them in order and composites
 * the overlay layers — one FFmpeg pass, H.264/yuv420p MP4 out.
 */
export function assemble(options: AssembleOptions): AssembleHandle {
  const { clipPaths, defaults, overlayPngPaths, outputPath, onProgress } = options
  const { w, h } = outputDims(defaults)
  const fps = defaults.fps
  const blend: SeamBlend = options.seamBlend ?? defaults.seamBlend ?? 'subtle'

  const durations = clipPaths.map((p) => probeDurationSec(p))
  const plan = planSeams({ durationsSec: durations, blend, fps })
  // Progress is measured against the OUTPUT timeline, which is shorter than
  // the sum of inputs once seams overlap.
  const totalSec = plan.totalSec > 0 ? plan.totalSec : durations.reduce((s, d) => s + d, 0)

  const args: string[] = ['-y', '-hide_banner']
  for (const clip of clipPaths) args.push('-i', clip)
  for (const overlay of overlayPngPaths) args.push('-i', overlay)

  // Per-clip normalization so heterogeneous clips can be joined safely.
  // xfade is stricter than concat — it requires both inputs to agree on
  // size, pixel aspect and frame rate — so this same normalization is what
  // makes seamless mode work on mixed-resolution sources.
  const chains: string[] = []
  const labels: string[] = []
  clipPaths.forEach((_, i) => {
    // Trim the duplicated key frame at each seam BEFORE blending, so a clip
    // that eases to a stop on its last frame does not stack that hold on
    // top of the next clip's identical first frame. `setpts` rebases the
    // timestamps after trimming, which xfade's offsets depend on.
    const start = plan.trimStartSec[i]
    const end = plan.trimEndSec[i]
    const trimmed =
      start > 0 || end > 0
        ? `trim=start=${start}:end=${(durations[i] - end).toFixed(3)},setpts=PTS-STARTPTS,`
        : ''
    chains.push(
      `[${i}:v]${trimmed}scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p[v${i}]`
    )
    labels.push(`[v${i}]`)
  })

  if (plan.blended && clipPaths.length > 1) {
    // SEAMLESS: chain xfade across the sequence. Each step consumes the
    // running result and the next clip, so the offsets come from the
    // accumulated output timeline, not from the raw input durations.
    let previous = 'v0'
    for (let i = 0; i < clipPaths.length - 1; i++) {
      const out = i === clipPaths.length - 2 ? 'cat' : `xf${i}`
      chains.push(
        `[${previous}][v${i + 1}]xfade=transition=fade:` +
          `duration=${plan.seamSec[i]}:offset=${plan.offsetSec[i]}[${out}]`
      )
      previous = out
    }
  } else {
    // PLAIN CONCAT — the original path, kept intact as the fallback for
    // 'off', for single-clip exports, and for any clip set too short to
    // give a seam away.
    chains.push(`${labels.join('')}concat=n=${clipPaths.length}:v=1:a=0[cat]`)
  }

  // Overlays are pre-rendered full-frame PNGs → always composited at 0:0.
  let current = 'cat'
  overlayPngPaths.forEach((_, idx) => {
    const inputIndex = clipPaths.length + idx
    const next = `ov${idx}`
    chains.push(`[${current}][${inputIndex}:v]overlay=0:0:format=auto[${next}]`)
    current = next
  })

  args.push(
    '-filter_complex',
    chains.join(';'),
    '-map',
    `[${current}]`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '19',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(fps),
    '-an',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    outputPath
  )

  let child: ChildProcess | null = null
  let cancelled = false

  const done = new Promise<void>((resolve, reject) => {
    child = spawn(ffmpegPath(), args, { windowsHide: true })

    let stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000)
    })

    child.stdout?.on('data', (chunk: Buffer) => {
      // -progress pipe:1 emits key=value lines; out_time_us tracks progress.
      const match = chunk.toString().match(/out_time_us=(\d+)/)
      if (match && totalSec > 0) {
        const pct = Math.min(99, Math.round(Number(match[1]) / 1e6 / totalSec * 100))
        onProgress?.(pct)
      }
    })

    child.on('error', reject)
    child.on('close', (code) => {
      child = null
      if (cancelled) {
        reject(new Error('Cancelled'))
      } else if (code === 0) {
        onProgress?.(100)
        resolve()
      } else {
        reject(new Error(`FFmpeg exited with code ${code}: …${stderrTail.slice(-500)}`))
      }
    })
  })

  return {
    done,
    cancel: () => {
      cancelled = true
      // ffmpeg is spawned directly (no shell), so killing the child leaves
      // no orphan processes.
      child?.kill()
    }
  }
}
