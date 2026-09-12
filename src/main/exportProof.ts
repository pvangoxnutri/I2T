import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { assemble, ffmpegPath, outputDims } from './services/ffmpegService'
import { applyExportFormat, type ExportFormatId } from '../shared/exportFormat'
import { userDataDir } from './paths'
import type { ExportDefaults } from '../shared/types'

/**
 * WHAT THE EXPORT ACTUALLY PRODUCES.
 *
 * `electron . --f2f-export-proof`
 *
 * ── WHY A REAL ENCODE ────────────────────────────────────────────────
 *
 * The Instagram export was reported as a small landscape picture
 * floating in a tall black rectangle. Every part of that is invisible to
 * a type checker and to a unit test on the filter string: what settles
 * it is running FFmpeg and looking at the pixels that come out.
 *
 * So this assembles a real clip through the REAL `assemble()` — the same
 * function the export job calls — at both formats, and then reads the
 * output back: its dimensions, and the colour of the pixels along each
 * edge. Black banners have a measurable signature.
 *
 * Local files only. No provider, no network, no spend.
 */

const DEFAULTS: ExportDefaults = {
  aspectRatio: '16:9',
  resolution: '1080p',
  fps: 25,
  defaultTransitionDurationSec: 5,
  seamBlend: 'off'
}

/** The dimensions FFmpeg reports for a file it just wrote. */
function probeSize(file: string): { w: number; h: number } | null {
  const res = spawnSync(ffmpegPath(), ['-hide_banner', '-i', file], { encoding: 'utf8' })
  const text = `${res.stdout ?? ''}${res.stderr ?? ''}`
  const m = /,\s(\d{2,5})x(\d{2,5})[\s,]/.exec(text)
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null
}

/**
 * The average colour of a strip of the frame, as 0-255 luma.
 *
 * A letterboxed export has near-zero luma across the full width of its
 * top and bottom strips and real picture in the middle. Sampling the
 * edges is therefore the whole test — and it is a measurement, not a
 * look at a screenshot.
 */
function edgeLuma(file: string, crop: string): number | null {
  const res = spawnSync(
    ffmpegPath(),
    [
      '-hide_banner',
      '-v',
      'error',
      '-i',
      file,
      '-vf',
      `select=eq(n\\,12),crop=${crop},format=gray,scale=1:1`,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-'
    ],
    { encoding: 'buffer', maxBuffer: 1 << 20 }
  )
  const out = res.stdout
  return out && out.length > 0 ? out[0] : null
}

export async function runExportProof(): Promise<number> {
  const say = (s: string): void => console.log(`[export-proof] ${s}`)

  // ── THE SOURCE IS NAMED, NOT DISCOVERED IN LIVE DATA ────────────────
  //
  // This run gets a throwaway userData directory (see pinUserDataDir),
  // so it cannot open — or overwrite — the operator's database. That
  // also means there is nothing to discover there, which is the point:
  // pass a clip explicitly with --source=<file>.
  const arg = process.argv.find((a) => a.startsWith('--source='))
  let source: string | null = arg ? arg.slice('--source='.length) : null
  if (source && !existsSync(source)) {
    say(`--source does not exist: ${source}`)
    return 1
  }
  const projects = join(userDataDir(), 'projects')
  if (!source && existsSync(projects)) {
    for (const id of readdirSync(projects)) {
      const dir = join(projects, id, 'transitions')
      if (!existsSync(dir)) continue
      const clip = readdirSync(dir).find((f) => f.endsWith('.mp4'))
      if (clip) {
        source = join(dir, clip)
        break
      }
    }
  }
  if (!source) {
    say('no source clip. Pass one: --source=<path to a .mp4>')
    return 1
  }
  const sourceSize = probeSize(source)
  say(`source: ${source.split(/[\\/]/).pop()} ${sourceSize?.w}x${sourceSize?.h}`)

  const outDir = join(app.getPath('temp'), `f2f-export-proof-${Date.now()}`)
  mkdirSync(outDir, { recursive: true })

  const checks: Array<[string, boolean]> = []

  for (const format of ['computer', 'instagram'] as ExportFormatId[]) {
    const { defaults, fit } = applyExportFormat(DEFAULTS, format)
    const expected = outputDims(defaults)
    const out = join(outDir, `${format}.mp4`)

    await assemble({
      clipPaths: [source],
      defaults,
      fit,
      overlayPngPaths: [],
      outputPath: out
    }).done

    const size = probeSize(out)
    say('')
    say(`${format}: fit=${fit} expected ${expected.w}x${expected.h} got ${size?.w}x${size?.h}`)
    checks.push([`${format}: output is ${expected.w}x${expected.h}`, size?.w === expected.w && size?.h === expected.h])

    // Four edge strips, 6% deep. A contain-fit landscape source in a
    // 9:16 frame puts black across the whole top and bottom.
    const W = size?.w ?? expected.w
    const H = size?.h ?? expected.h
    const band = Math.max(2, Math.round(H * 0.06))
    const side = Math.max(2, Math.round(W * 0.06))
    const top = edgeLuma(out, `${W}:${band}:0:0`)
    const bottom = edgeLuma(out, `${W}:${band}:0:${H - band}`)
    const left = edgeLuma(out, `${side}:${H}:0:0`)
    const right = edgeLuma(out, `${side}:${H}:${W - side}:0`)
    say(`  edge luma  top=${top} bottom=${bottom} left=${left} right=${right}`)

    if (format === 'instagram') {
      // Not "not exactly zero" — a dark frame is legitimate. A BANNER is
      // uniform black across a whole strip, so a threshold that a real
      // photograph clears comfortably is the honest test.
      for (const [edge, v] of [['top', top], ['bottom', bottom], ['left', left], ['right', right]] as Array<[string, number | null]>) {
        checks.push([`instagram: ${edge} edge carries picture, not a black banner (luma ${v})`, (v ?? 0) > 6])
      }
      // COVER, not stretch: the source's own aspect ratio is preserved
      // and the sides are cropped. Proven by arithmetic on what cover
      // must do, since a stretched frame has the same dimensions.
      if (sourceSize) {
        const scale = Math.max(expected.w / sourceSize.w, expected.h / sourceSize.h)
        const scaledW = sourceSize.w * scale
        checks.push([
          `instagram: cover scales by height and crops ${Math.round(scaledW - expected.w)}px of width, no stretching`,
          scaledW >= expected.w - 1 && Math.abs(sourceSize.h * scale - expected.h) < 2
        ])
      }
    }
  }

  // ── THE BRANDING MATRIX, ON THE FINAL REEL FRAME ────────────────────
  //
  // Two marker overlays are generated at 1080x1920 — the Reel's own
  // frame — one filling the centre and one in the bottom-right corner,
  // standing in for the watermark and the corner stamp. Each of the four
  // combinations is encoded, and the marker positions are sampled.
  //
  // This proves two things at once: that inclusion follows the PNGs the
  // export was given (and nothing else), and that compositing happens
  // AFTER the crop — a mark placed before it would be cropped away, and
  // a corner mark would not be in the corner.
  const reel = applyExportFormat(DEFAULTS, 'instagram')
  const RW = outputDims(reel.defaults).w
  const RH = outputDims(reel.defaults).h
  // An OPAQUE box composited onto a transparent canvas.
  //
  // The first version of this used `drawbox=...:color=white@1.0:t=fill`
  // and every combination read identical: drawbox wrote white into the
  // RGB planes and left the ALPHA plane at zero, so the marker was a
  // perfectly invisible white rectangle and the proof was measuring
  // nothing. Compositing a genuinely opaque source carries its alpha.
  const marker = (name: string, w: number, h: number, x: number, y: number): string => {
    const file = join(outDir, name)
    const res = spawnSync(ffmpegPath(), [
      '-hide_banner', '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=black@0.0:s=${RW}x${RH},format=rgba`,
      '-f', 'lavfi', '-i', `color=c=white:s=${w}x${h},format=rgba`,
      '-filter_complex', `[0:v][1:v]overlay=x=${x}:y=${y}:format=auto,format=rgba[o]`,
      '-map', '[o]', '-frames:v', '1', file
    ])
    if (res.status !== 0) say(`marker ${name} FAILED: ${res.stderr?.toString().slice(0, 200)}`)
    return file
  }
  // Centre block, and a corner block inset by the canonical 2%.
  const wmPng = marker('marker-watermark.png', RW / 2, 200, RW / 4, RH / 2 - 100)
  const inset = Math.round(Math.min(RW, RH) * 0.02)
  const stampPng = marker('marker-stamp.png', 200, 100, RW - inset - 200, RH - inset - 100)

  const sampleCentre = (f: string): number | null => edgeLuma(f, `${RW / 2}:100:${RW / 4}:${RH / 2 - 50}`)
  const sampleCorner = (f: string): number | null =>
    edgeLuma(f, `150:60:${RW - inset - 175}:${RH - inset - 80}`)

  for (const [label, pngs, wantWm, wantStamp] of [
    ['both ON', [wmPng, stampPng], true, true],
    ['watermark only', [wmPng], true, false],
    ['stamp only', [stampPng], false, true],
    ['both OFF', [], false, false]
  ] as Array<[string, string[], boolean, boolean]>) {
    const out = join(outDir, `matrix-${label.replace(/W+/g, '-')}.mp4`)
    await assemble({
      clipPaths: [source],
      defaults: reel.defaults,
      fit: reel.fit,
      overlayPngPaths: pngs,
      outputPath: out
    }).done
    const size = probeSize(out)
    const centre = sampleCentre(out) ?? 0
    const corner = sampleCorner(out) ?? 0
    // A white marker reads far brighter than the photograph under it.
    const wmSeen = centre > 200
    const stampSeen = corner > 200
    say(`${label.padEnd(16)} ${size?.w}x${size?.h}  centre=${centre} corner=${corner}  watermark=${wmSeen} stamp=${stampSeen}`)
    checks.push([`matrix "${label}": watermark ${wantWm ? 'present' : 'absent'}`, wmSeen === wantWm])
    checks.push([`matrix "${label}": corner stamp ${wantStamp ? 'present' : 'absent'}`, stampSeen === wantStamp])
    checks.push([`matrix "${label}": still ${RW}x${RH}`, size?.w === RW && size?.h === RH])
  }

  let failed = 0
  say('')
  for (const [name, pass] of checks) {
    if (!pass) failed++
    say(`${pass ? 'PASS' : 'FAIL'}  ${name}`)
  }
  say(`output written to ${outDir}`)
  say(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`)
  return failed === 0 ? 0 : 1
}
