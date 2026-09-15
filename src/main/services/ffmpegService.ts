import type { FrameFit } from '../../shared/exportFormat'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { sep } from 'node:path'
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

/**
 * IN A PACKAGED APP THE BUNDLED PATH POINTS INSIDE THE ARCHIVE.
 *
 * `require('ffmpeg-static')` returns a path under node_modules, which in
 * a packaged build lives inside app.asar. Reading a file there works —
 * Electron mounts the archive transparently — so `existsSync` says yes
 * and everything looks fine. EXECUTING one does not: the operating
 * system cannot spawn a process from a file that has no real location on
 * disk, and the failure surfaces much later as an export that dies with
 * an opaque spawn error.
 *
 * electron-builder therefore copies the binary out to `app.asar.unpacked`
 * (see the `asarUnpack` entry in package.json). That copy is the one to
 * run, and this rewrite is what points at it. Outside a packaged build
 * the substring is absent and the path is returned untouched.
 */
function unpackedPath(p: string): string {
  return p.includes(`app.asar${sep}`) ? p.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`) : p
}

function resolveBundled(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const raw = require('ffmpeg-static') as string | null
    if (!raw) return null
    const p = unpackedPath(raw)
    return existsSync(p) ? p : null
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

/**
 * What a clip is, read from ffmpeg's own header dump.
 *
 * ONE SPAWN FOR BOTH FACTS. The assembly needs each clip's duration to
 * plan seams and its frame rate to decide the output rate, and probing
 * twice would double the number of processes an export starts — 44 clips
 * is a real project, not a hypothetical one.
 *
 * (ffmpeg-static ships no ffprobe, which is why this parses stderr.)
 */
export function probeStreamInfo(file: string): { durationSec: number; fps: number } {
  const res = spawnSync(ffmpegPath(), ['-hide_banner', '-i', file], {
    encoding: 'utf8',
    timeout: 20_000
  })
  // ffmpeg exits non-zero without an output file — the header lines are in
  // stderr regardless.
  const text = `${res.stderr}`
  const duration = text.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/)
  const rate = text.match(/,\s*([0-9]+(?:\.[0-9]+)?)\s*fps\b/)
  const fps = rate ? Number(rate[1]) : 0
  return {
    durationSec: duration
      ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) +
        Number(`0.${duration[4]}`)
      : 0,
    // A nonsense rate is treated as unknown rather than propagated into the
    // filter graph, where it would decide the timebase of the whole export.
    fps: Number.isFinite(fps) && fps > 0 && fps <= 240 ? fps : 0
  }
}

/** Clip duration in seconds. */
export function probeDurationSec(file: string): number {
  return probeStreamInfo(file).durationSec
}

/**
 * WHAT THE FINAL ENCODE COSTS AND KEEPS.
 *
 * Two profiles, one of which is the product's. See `quality` on
 * AssembleOptions for which callers use which, and the encoder arguments
 * below for why these numbers.
 */
export type QualityProfile = 'high' | 'standard'

export const QUALITY_PROFILES: Record<QualityProfile, { preset: string; crf: string }> = {
  high: { preset: 'slow', crf: '16' },
  standard: { preset: 'medium', crf: '18' }
}

/**
 * THE RATE THE SOURCES ARE ALREADY IN.
 *
 * ── WHY THE CONFIGURED RATE IS NOT SIMPLY OBEYED ─────────────────────
 *
 * Every clip the provider returns is 24 fps, and the export default was
 * 25. Retiming 24 to 25 duplicates roughly one frame per second, and a
 * duplicated frame in a slow continuous camera move is visible as a
 * stutter — the one artefact a "cinematic" tour cannot have. Nothing was
 * gained in exchange: the sources hold no 25th frame to show.
 *
 * So when every clip agrees on a rate, that rate is the output rate and
 * no frame is invented or dropped. When they disagree there is no single
 * honest answer, and the operator's configured rate decides, exactly as
 * before. Stills have no rate of their own and never vote.
 */
export function sourceFrameRate(rates: number[], configured: number): number {
  const known = rates.filter((rate) => rate > 0)
  if (known.length === 0) return configured
  const first = Math.round(known[0] * 1000)
  return known.every((rate) => Math.round(rate * 1000) === first) ? known[0] : configured
}

// ── Assembly ─────────────────────────────────────────────────────────────

/**
 * One piece of the output timeline.
 *
 * A generated clip, or a still photograph held for a duration. Stills
 * exist so a CUT sequence can put an image on screen that no clip covers —
 * see shared/assemblyPlan.ts, which decides where they are needed.
 */
export interface AssembleSegment {
  kind: 'clip' | 'still'
  path: string
  /** Stills only: how long to hold. Clips are probed. */
  holdSeconds?: number
  /**
   * THE SOURCE RANGE THIS SEGMENT PLAYS.
   *
   * Absent means the whole file, which is every caller that predates the
   * Timeline. Present, only `[sourceStartSec, sourceEndSec)` is used —
   * which is how a split works: two segments over the same path with
   * different ranges, and no second copy of the video on disk.
   *
   * These COMPOSE with the seam trim below rather than replacing it. The
   * seam removes a duplicated key frame at a blended joint; this removes
   * everything outside the operator's in and out points. Both are the
   * same FFmpeg `trim`, applied together.
   */
  sourceStartSec?: number
  sourceEndSec?: number
  /**
   * HOW FAST THIS SEGMENT PLAYS. Absent or 1 is the footage's own speed.
   *
   * A creative edit belonging to the timeline item, not to the file: 2
   * means the same frames pass in half the time. It is applied as a
   * timestamp transformation immediately after the trim, so everything
   * downstream — the interpolation, the seams, the total length — is
   * working in finished timeline time.
   *
   * Stills never carry it. A held photograph has no motion to retime;
   * its hold is simply asked for at the length the timeline wants.
   */
  speed?: number
}

export interface AssembleOptions {
  /** Ordered clip paths — image-sequence order, N-1 clips for N images. */
  clipPaths: string[]
  /**
   * Mixed timeline, when the project has cuts or crossfades.
   *
   * Takes precedence over `clipPaths`. Supplied together with
   * `seamOverrideSec` so a cut is exactly zero and a crossfade is its own
   * length, whatever the project's seam setting says.
   */
  segments?: AssembleSegment[]
  /** Per-boundary seam seconds (length segments − 1). */
  seamOverrideSec?: (number | null)[]
  /**
   * How source frames meet the output frame. Defaults to `contain`, the
   * editor/comparison behaviour. Both customer export formats pass
   * `cover` explicitly — see shared/exportFormat. Neither ever stretches.
   */
  fit?: FrameFit
  /**
   * Background where a `contain` fit leaves the frame unfilled.
   *
   * Defaults to black for internal contain assemblies. Customer exports
   * use cover, so this colour does not enter their filter graph.
   */
  padColor?: 'black' | 'white'
  defaults: ExportDefaults
  /**
   * HOW MUCH THE ENCODER IS ALLOWED TO SPEND.
   *
   * Defaults to `high`, because the default caller is a file a customer
   * receives and keeps. `standard` exists for the renders the operator
   * throws away — the editor preview is rebuilt after every trim, and
   * making them wait for a near-lossless encode of a working file buys
   * nothing they can see at preview size.
   *
   * Deliberately not a setting: the product has one delivery quality.
   */
  quality?: QualityProfile
  /**
   * THE RATE THE FINISHED FILE RUNS AT, when it differs from the sources.
   *
   * Set by the customer export path to CUSTOMER_EXPORT_FPS. Each clip is
   * raised to it by motion-compensated interpolation, never by repeating
   * frames. Omitted — every internal render — means the output follows
   * its sources exactly as before, which is what keeps the editor
   * preview cheap.
   *
   * The SEAM ARITHMETIC does not move with it. Seams trim one SOURCE
   * frame at each blended joint, so that trim stays measured in source
   * frames and the timeline's duration is unchanged by this setting.
   */
  targetFps?: number
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
 * Normalizes every clip (cover/crop or contain/pad, square pixels,
 * uniform fps, audio dropped), concatenates them in order and composites
 * the overlay layers — one FFmpeg pass, H.264/yuv420p MP4 out.
 */
export function assemble(options: AssembleOptions): AssembleHandle {
  const { clipPaths, defaults, overlayPngPaths, outputPath, onProgress } = options
  const fit: FrameFit = options.fit ?? 'contain'
  const padColor = options.padColor ?? 'black'
  const profile = QUALITY_PROFILES[options.quality ?? 'high']
  const { w, h } = outputDims(defaults)
  const blend: SeamBlend = options.seamBlend ?? defaults.seamBlend ?? 'subtle'

  // A plain clip list is the ordinary case and stays exactly as it was.
  // Segments are used only when the project mixes cuts or crossfades in.
  const segments: AssembleSegment[] =
    options.segments ?? clipPaths.map((path) => ({ kind: 'clip' as const, path }))

  // ── THE IN POINT OF EACH SEGMENT, AND HOW LONG IT PLAYS ────────────
  //
  // `sourceIn` is where this segment starts inside its file; `durations`
  // is what it CONTRIBUTES to the output, which is the trimmed length,
  // not the file's length. The seam planner must see the trimmed value —
  // given the whole file it would happily plan a blend longer than the
  // piece the operator actually kept.
  const sourceIn = segments.map((s) => Math.max(0, s.sourceStartSec ?? 0))
  // A stated OUT point needs the trim filter even when the IN point is 0
  // and no seam applies — otherwise the tail of the file would play on.
  const hasOutPoint = segments.map((s) => s.kind !== 'still' && s.sourceEndSec !== undefined)
  // One probe per clip, read once for both the duration and the rate.
  const probes = segments.map((s) =>
    s.kind === 'still' ? { durationSec: 0, fps: 0 } : probeStreamInfo(s.path)
  )
  // A segment's SPEED. Clamped and defaulted here so the filter graph and
  // the seam arithmetic below can never see a zero and divide by it.
  const speeds = segments.map((s) => {
    const raw = s.kind === 'still' ? 1 : s.speed
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0
      ? Math.min(4, Math.max(0.25, raw))
      : 1
  })
  // Durations are in TIMELINE seconds, which is what the seam planner and
  // every offset below are measured in. A clip's source span divided by
  // its speed is the time it actually occupies in the finished film.
  const durations = segments.map((s, i) => {
    if (s.kind === 'still') return s.holdSeconds ?? 1.5
    const full = probes[i].durationSec
    const end = s.sourceEndSec !== undefined ? Math.min(s.sourceEndSec, full) : full
    const sourceSpan = Math.max(0, end - sourceIn[i])
    return Math.max(0, Math.round((sourceSpan / speeds[i]) * 1000) / 1000)
  })
  // ── TWO RATES, AND THEY ARE NOT THE SAME QUESTION ──────────────────
  //
  // `sourceFps` is what the material IS. It owns the seam arithmetic,
  // because a seam trims one source frame — the duplicated key frame the
  // provider renders at both sides of a joint. Measuring that trim in
  // output frames instead would leave most of the duplicate in place AND
  // change the timeline's total duration.
  //
  // `outputFps` is what the finished file RUNS at. It owns the filter
  // graph's timebase and the encoder. For a customer export it is higher
  // than the source, and the gap is filled by interpolation below.
  const sourceFps = sourceFrameRate(probes.map((p) => p.fps), defaults.fps)
  const outputFps = options.targetFps ?? sourceFps
  const plan = planSeams({
    durationsSec: durations,
    blend,
    fps: sourceFps,
    seamOverrideSec: options.seamOverrideSec,
    // A held still has no duplicated key frame to remove, so trimming one
    // would only shorten the hold.
    noTrim: segments.map((s) => s.kind === 'still')
  })
  // Progress is measured against the OUTPUT timeline, which is shorter than
  // the sum of inputs once seams overlap.
  const totalSec = plan.totalSec > 0 ? plan.totalSec : durations.reduce((s, d) => s + d, 0)

  // ── WHAT THE TIMELINE ASKED FOR, SEGMENT BY SEGMENT ────────────────
  //
  // Printed before a frame is encoded, because a timing fault is a fault
  // in this arithmetic and waiting an hour for the file to find out is
  // no way to debug one. Every number an export's length depends on is
  // here: what each source is, what the timeline asked of it, what the
  // seam planner trimmed, and what the segment must therefore contribute.
  console.info(
    `[assemble] timeline ${totalSec.toFixed(3)}s, ${segments.length} segment(s), ` +
      `source ${sourceFps} fps -> output ${outputFps} fps, ${w}x${h}, ` +
      `${overlayPngPaths.length} overlay(s)`
  )
  segments.forEach((segment, i) => {
    console.info(
      `[assemble]   ${i} ${segment.kind} fps=${probes[i].fps || 'n/a'} ` +
        `file=${probes[i].durationSec.toFixed(3)}s ` +
        `in=${sourceIn[i].toFixed(3)} out=${(segment.sourceEndSec ?? NaN).toFixed(3)} ` +
        `requested=${durations[i].toFixed(3)}s ` +
        `trim=[${plan.trimStartSec[i].toFixed(3)},${plan.trimEndSec[i].toFixed(3)}] ` +
        `contributes=${plan.effectiveSec[i].toFixed(3)}s ` +
        `seamAfter=${(plan.seamSec[i] ?? 0).toFixed(3)} ` +
        `xfadeOffset=${(plan.offsetSec[i] ?? 0).toFixed(3)}`
    )
  })

  const args: string[] = ['-y', '-hide_banner']
  for (const segment of segments) {
    if (segment.kind === 'still') {
      // A looped image for a fixed duration. `-t` before `-i` bounds the
      // input itself, so the still can never run forever if a downstream
      // filter changes.
      //
      // Generated at the OUTPUT rate. A photograph has no motion to
      // interpolate, so it is simply held at the timeline's rate and
      // arrives already matching everything it will be joined to.
      args.push(
        '-loop', '1', '-framerate', String(outputFps), '-t', String(segment.holdSeconds ?? 1.5)
      )
    }
    args.push('-i', segment.path)
  }
  for (const overlay of overlayPngPaths) args.push('-i', overlay)

  // Per-clip normalization so heterogeneous clips can be joined safely.
  // xfade is stricter than concat — it requires both inputs to agree on
  // size, pixel aspect and frame rate — so this same normalization is what
  // makes seamless mode work on mixed-resolution sources.
  const chains: string[] = []
  const labels: string[] = []
  segments.forEach((_, i) => {
    // Trim the duplicated key frame at each seam BEFORE blending, so a clip
    // that eases to a stop on its last frame does not stack that hold on
    // top of the next clip's identical first frame. `setpts` rebases the
    // timestamps after trimming, which xfade's offsets depend on.
    // ── ONE TRIM, TWO REASONS ─────────────────────────────────────
    //
    // The seam trim is measured from the start of the SEGMENT, and the
    // segment may itself begin partway into the file. Both are folded
    // into a single absolute range here, so an in/out point and a
    // blended joint compose instead of one silently overwriting the
    // other. Written against `sourceIn[i]`, which is 0 for every caller
    // that does not use source ranges — so their output is unchanged.
    //
    // ── AND THE TRIM IS IN SOURCE SECONDS, NOT TIMELINE SECONDS ────
    //
    // `durations` and the seam plan are measured in finished timeline
    // time. `trim` cuts the FILE. At any speed but 1 those are different
    // clocks, so the span and both seam trims are converted back into
    // source seconds by multiplying by the speed. Getting this wrong
    // would cut the wrong footage AND make the segment the wrong length.
    const speed = speeds[i]
    const start = sourceIn[i] + plan.trimStartSec[i] * speed
    const end = sourceIn[i] + (durations[i] - plan.trimEndSec[i]) * speed
    // ── THEN THE SPEED ITSELF, AS A TIMESTAMP TRANSFORMATION ───────
    //
    // Dividing the presentation times by the speed is what actually
    // retimes the motion: at 2x every frame arrives twice as soon, so
    // the same footage passes in half the time. It happens HERE, before
    // scaling and before interpolation, so everything downstream is
    // already working in finished timeline time — which is what lets the
    // interpolator draw the retimed movement smoothly instead of
    // smoothing the original movement and then stretching the result.
    const retime = speed === 1 ? 'PTS-STARTPTS' : `(PTS-STARTPTS)/${speed}`
    const trimmed =
      plan.trimStartSec[i] > 0 ||
      plan.trimEndSec[i] > 0 ||
      sourceIn[i] > 0 ||
      hasOutPoint[i] ||
      speed !== 1
        ? `trim=start=${start.toFixed(3)}:end=${end.toFixed(3)},setpts=${retime},`
        : ''
    // ── FIT THE FRAME WITHOUT DISTORTING IT ─────────────────────────
    //
    // Both branches preserve the source aspect ratio — neither ever
    // stretches. They differ only in what happens to the mismatch:
    //
    //   contain  scale down until it fits, pad the remainder black
    //   cover    scale up until it fills, crop the overflow evenly
    //
    // Both customer formats use cover. FFmpeg's default crop offsets
    // are (iw-ow)/2 and (ih-oh)/2: the crop is centred. outputDims makes
    // the cropped frame even before yuv420p conversion and H.264 encoding;
    // the intermediate scale can be odd without reaching the encoder.
    // Overlays are composited later, in the final frame's coordinates.
    //
    // ── THE SCALER IS NAMED, NOT INHERITED ──────────────────────────
    //
    // Every customer export is an UPSCALE: the provider returns about
    // 1176x784 and the frame is 1920x1080, a factor of 1.63. swscale's
    // default is bicubic, which on that kind of enlargement softens
    // exactly the edges a property video is judged on — window frames,
    // tile grout, skirting boards. Lanczos keeps them, at a cost in
    // encode time nobody watching the file will ever see.
    //
    // The aspect ratio is preserved by `force_original_aspect_ratio`
    // BEFORE the crop, so the scaler never stretches; lanczos changes
    // how the pixels are resampled, never their geometry.
    const fitChain =
      fit === 'cover'
        ? `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h}`
        : `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,` +
          `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${padColor}`

    // ── REACHING THE OUTPUT RATE ────────────────────────────────────
    //
    // PER SEGMENT, AND BEFORE THE JOINTS. Interpolating the finished
    // timeline instead would run motion estimation straight across every
    // cut and every crossfade: at a cut it would invent frames morphing
    // one room into another, and in a dissolve it would be estimating
    // motion on a picture that is two rooms superimposed. Interpolating
    // each segment on its own means the estimator only ever sees one
    // continuous camera move, which is what it is good at, and the
    // joints are then made between streams that already run at the
    // output rate.
    //
    // A STILL IS HELD, NOT INTERPOLATED. There is no motion between two
    // identical frames, so `fps` simply presents the photograph at the
    // timeline's rate. Spending minutes of motion estimation to compute
    // the same pixels would be waste, not quality.
    //
    // ── AND WHY `fps` STILL FOLLOWS IT ──────────────────────────────
    //
    // `minterpolate` emits frames BETWEEN input frames, so its output
    // stops at the LAST input frame rather than at the end of that
    // frame's screen time. Every interpolated segment therefore came out
    // about one source frame short, and across a timeline that
    // accumulated: 1.60s segments delivered 1.53s and a four-segment
    // export lost 0.15s. Seam offsets are computed in seconds from the
    // planned lengths, so segments that quietly run short also drag the
    // crossfades out of position.
    //
    // `fps` closes exactly that final gap and nothing else: everywhere
    // before it the timestamps already sit on the output grid and pass
    // straight through. The one repeated frame it adds at the tail is
    // not an invention — during that interval the source shows that same
    // frame held, which is what is reproduced.
    // After retiming, the stream's effective rate is the source's rate
    // multiplied by the speed: played at 2x, a 24 fps clip presents 48
    // frames per second of timeline. That, not the file's own rate, is
    // what the output rate has to be compared against.
    const clipFps = (probes[i].fps || sourceFps) * speed
    const interpolated = segments[i].kind === 'clip' && outputFps > clipFps + 0.001
    const rateChain = interpolated
      ? `minterpolate=fps=${outputFps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir,fps=${outputFps}`
      : `fps=${outputFps}`

    chains.push(
      `[${i}:v]${trimmed}${fitChain},setsar=1,${rateChain},` +
        // A COMMON TIMEBASE. A looped still enters the graph with a
        // different one from a decoded video, and xfade refuses to join
        // two inputs whose timebases disagree — "does not match the
        // corresponding second input link xfade timebase". Concat is more
        // forgiving, which is why this only surfaced once cuts and
        // crossfades put stills and clips in the same timeline.
        `settb=1/${outputFps},format=yuv420p[v${i}]`
    )
    labels.push(`[v${i}]`)
  })

  if (plan.blended && segments.length > 1) {
    // SEAMLESS: chain xfade across the sequence. Each step consumes the
    // running result and the next segment, so the offsets come from the
    // accumulated output timeline, not from the raw input durations.
    //
    // A seam of 0 is a HARD CUT. xfade with duration=0 is not reliable, so
    // those boundaries concat instead — which is what a cut is, and leaves
    // no gap for a black frame to appear in.
    let previous = 'v0'
    for (let i = 0; i < segments.length - 1; i++) {
      const out = i === segments.length - 2 ? 'cat' : `xf${i}`
      // `settb` is re-applied to every intermediate result: xfade takes
      // its output timebase from its first input, so the running chain can
      // drift away from the normalized segments it is about to be joined
      // with, and the next xfade then refuses the pair.
      if (plan.seamSec[i] > 0) {
        chains.push(
          `[${previous}][v${i + 1}]xfade=transition=fade:` +
            `duration=${plan.seamSec[i]}:offset=${plan.offsetSec[i]},` +
            `settb=1/${outputFps},setpts=PTS-STARTPTS[${out}]`
        )
      } else {
        chains.push(
          `[${previous}][v${i + 1}]concat=n=2:v=1:a=0,settb=1/${outputFps},setpts=PTS-STARTPTS[${out}]`
        )
      }
      previous = out
    }
  } else {
    // PLAIN CONCAT — the original path, kept intact as the fallback for
    // 'off', for single-segment exports, and for any set too short to
    // give a seam away.
    chains.push(`${labels.join('')}concat=n=${segments.length}:v=1:a=0[cat]`)
  }

  // Overlays are pre-rendered full-frame PNGs → always composited at 0:0.
  let current = 'cat'
  overlayPngPaths.forEach((_, idx) => {
    const inputIndex = segments.length + idx
    const next = `ov${idx}`
    chains.push(`[${current}][${inputIndex}:v]overlay=0:0:format=auto[${next}]`)
    current = next
  })

  args.push(
    '-filter_complex',
    chains.join(';'),
    '-map',
    `[${current}]`,
    // ── THE ONE LOSSY STEP IN THE WHOLE CHAIN ───────────────────────
    //
    // The raw provider clip reaches this encoder untouched — there is no
    // intermediate render between them — so whatever this pass discards
    // is discarded for good, and it is the only place worth spending on.
    //
    // WHAT WAS WRONG. `veryfast` at CRF 19 wrote a 1920x1080 file at
    // about 4.2 Mb/s from sources carrying 5.9 Mb/s at 1176x784 — a
    // third of the bits per pixel the source had, on material that had
    // just been ENLARGED and so needed more, not fewer. The result was
    // visibly softer than the clips it was built from.
    //
    // `slow` at CRF 16 is the customer-facing default. CRF 16 is close
    // to visually lossless for this material, and `slow` is what makes
    // that affordable in bits: the same quality target costs markedly
    // less bitrate than a fast preset, because the encoder is allowed to
    // actually look for redundancy. An export is rendered once and
    // watched many times, so the trade runs the right way.
    //
    // `high` is stated rather than left to libx264's default so the
    // profile is a decision on the record; it is what an 8-bit 4:2:0
    // desktop/social deliverable should be, and every target platform
    // has taken High for a decade. No maxrate or bufsize is set: a cap
    // would reintroduce exactly the starvation this change removes, and
    // no delivery target here demands one.
    '-c:v',
    'libx264',
    '-profile:v',
    'high',
    '-preset',
    profile.preset,
    '-crf',
    profile.crf,
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(outputFps),
    '-an',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    outputPath
  )

  // The graph itself, once, so a timing fault can be read rather than
  // inferred. It carries no secrets: file paths and filter names only.
  console.info(`[assemble] filter_complex: ${chains.join(';')}`)

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
        // ── THE TIMELINE'S LENGTH IS A CONTRACT ──────────────────────
        //
        // Raising the frame rate must add frames BETWEEN existing ones,
        // never stretch the time they occupy: a 38s timeline is a 38s
        // film at any rate. A retiming fault does not corrupt the file,
        // so nothing downstream would notice — it just quietly hands the
        // customer a slow-motion export of the wrong length.
        //
        // Half a second of tolerance covers the final frame's rounding
        // and the millisecond rounding in the seam plan, and is far
        // tighter than any real retiming error, which scales with the
        // whole timeline rather than with one frame.
        const encoded = probeStreamInfo(outputPath).durationSec
        const drift = Math.abs(encoded - totalSec)
        if (totalSec > 0 && drift > 0.5) {
          reject(
            new Error(
              `Export timing is wrong: the timeline is ${totalSec.toFixed(2)}s but the file ` +
                `is ${encoded.toFixed(2)}s (drift ${drift.toFixed(2)}s). The export was not ` +
                `delivered. This is a frame-rate or timestamp fault, not an encoding failure.`
            )
          )
          return
        }
        console.info(
          `[assemble] duration check: timeline ${totalSec.toFixed(3)}s, ` +
            `file ${encoded.toFixed(3)}s, drift ${drift.toFixed(3)}s`
        )
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
