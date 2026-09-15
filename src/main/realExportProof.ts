import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import {
  deleteProjectRows,
  getSettingsJson,
  listProjects,
  saveProject,
  saveSettingsJson
} from './db/projectsRepo'
import { deleteProjectFiles, projectTransitionsDir } from './files'
import { projectImagesDir } from './paths'
import { exportAssembly, startExport } from './services/exportService'
import {
  assemble,
  ffmpegPath,
  outputDims,
  probeStreamInfo,
  type AssembleSegment
} from './services/ffmpegService'
import { initQueue, listJobs, resumeQueue, stopQueue } from './services/queueService'
import {
  applyExportFormat,
  CUSTOMER_EXPORT_FPS,
  type ExportFormatId
} from '../shared/exportFormat'
import type { TransitionMode } from '../shared/transitionMode'
import type { AspectRatio, ExportDefaults, Project } from '../shared/types'

/**
 * THE STANDARD EXPORT, PROVEN THROUGH THE PATH THE PRODUCT USES.
 *
 * ── WHY THIS EXISTS AND `--f2f-export-proof` WAS NOT ENOUGH ──────────
 *
 * Twice now a geometry bug has survived a passing proof, for the same
 * reason both times: the proof called `assemble()` directly, with
 * arguments it chose itself. `assemble()` was never the faulty layer.
 * The fault was in what the layers ABOVE it decided and handed down —
 * once a job that did not carry the chosen format, once an export format
 * that said `contain`.
 *
 * So this proof starts where the operator starts: `startExport`, the
 * same function the Export Video button reaches through IPC. Every step
 * after it is the product's own — the queue job and its metadata, the
 * registered runner, `exportAssembly`, `applyExportFormat`, the filter
 * graph and the encoder. Nothing is passed in by hand.
 *
 * THE ONLY SUBSTITUTION is the native save dialog, which no automation
 * can answer, and which is replaced by the seam the product already has
 * for it: F2F_EXPORT_DEST. It chooses a directory. It decides nothing
 * about geometry.
 *
 * What is asserted is the FILE: its container geometry, and its decoded
 * pixels at the first and middle frames.
 *
 * Run it against a scratch user-data directory, never the operator's:
 *
 *   electron . --f2f-real-export-proof --user-data-dir=<scratch>
 */

const log = (msg: string): void => console.log(`[real-export] ${msg}`)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function ff(args: string[], what: string): void {
  const res = spawnSync(ffmpegPath(), ['-y', '-hide_banner', '-v', 'error', ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true
  })
  assert.equal(res.status, 0, `${what}: ${res.stderr?.slice(-400)}`)
}

/**
 * HOW MANY FRAMES THE FILE REALLY CONTAINS.
 *
 * A full decode, not a header read. The header is what the muxer was
 * told; this is what comes out, and it is the only thing that can tell a
 * true 120 fps file from a 24 fps one wearing a 120 fps label.
 */
function decodedFrameCount(file: string): number {
  const res = spawnSync(ffmpegPath(), ['-hide_banner', '-i', file, '-map', '0:v:0', '-f', 'null', '-'], {
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 40 * 1024 * 1024,
    windowsHide: true
  })
  const matches = `${res.stderr}`.replace(/\r/g, '\n').match(/frame=\s*(\d+)/g)
  const last = matches?.at(-1)?.match(/(\d+)/)?.[1]
  return last ? Number(last) : 0
}

/** `ffmpeg -i` header dump — ffmpeg-static ships no ffprobe. */
function probeHeader(file: string): string {
  return `${spawnSync(ffmpegPath(), ['-hide_banner', '-i', file], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true
  }).stderr}`
}

/**
 * A SOURCE FRAME THAT MAKES EVERY FAILURE VISIBLE.
 *
 * A mid-grey field that reaches all four edges, so any black bar in the
 * output is the export's own and not the source's. A blue square in the
 * middle, because a square is the one shape that reports stretching: it
 * survives a correct cover crop as a square, and a `scale` without
 * `force_original_aspect_ratio` turns it into a rectangle.
 */
function fixturePpm(dir: string, w: number, h: number): string {
  const pixels = Buffer.alloc(w * h * 3, 160)
  const side = 100
  const left = Math.floor((w - side) / 2)
  const top = Math.floor((h - side) / 2)
  for (let y = top; y < top + side; y++) {
    for (let x = left; x < left + side; x++) {
      pixels.set([20, 40, 240], (y * w + x) * 3)
    }
  }
  const file = join(dir, `src-${w}x${h}.ppm`)
  writeFileSync(file, Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), pixels]))
  return file
}

/** A full-frame transparent overlay with one opaque box — what the
 * renderer rasterises for a watermark or a corner stamp. */
function overlayPng(
  dir: string,
  name: string,
  w: number,
  h: number,
  box: { x: number; y: number; w: number; h: number; rgb: [number, number, number] }
): string {
  const pixels = Buffer.alloc(w * h * 4)
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      pixels.set([...box.rgb, 255], (y * w + x) * 4)
    }
  }
  const raw = join(dir, `${name}.rgba`)
  const png = join(dir, `${name}.png`)
  writeFileSync(raw, pixels)
  ff(
    ['-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${w}x${h}`, '-i', raw,
     '-frames:v', '1', png],
    `overlay ${name}`
  )
  return png
}

/** One decoded output frame, as an (x, y) → [r, g, b] reader. */
function frameReader(
  file: string,
  frameIndex: number,
  w: number,
  h: number
): (x: number, y: number) => [number, number, number] {
  const res = spawnSync(
    ffmpegPath(),
    ['-hide_banner', '-v', 'error', '-i', file,
     '-vf', `select=eq(n\\,${frameIndex})`, '-frames:v', '1',
     '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
    { timeout: 60_000, maxBuffer: 200 * 1024 * 1024, windowsHide: true }
  )
  const buf = res.stdout
  assert.equal(
    buf.length,
    w * h * 3,
    `frame ${frameIndex} decodes at exactly ${w}x${h} (got ${buf.length} bytes)`
  )
  return (x, y) => {
    const i = (y * w + x) * 3
    return [buf[i], buf[i + 1], buf[i + 2]]
  }
}

interface EdgeReport {
  left: number
  right: number
  top: number
  bottom: number
}

/** Mean luma of a 4px strip along each edge of the finished frame. */
function edgeMeans(
  pixel: (x: number, y: number) => [number, number, number],
  w: number,
  h: number
): EdgeReport {
  const luma = (x: number, y: number): number => {
    const [r, g, b] = pixel(x, y)
    return 0.299 * r + 0.587 * g + 0.114 * b
  }
  const mean = (xs: number[], ys: number[]): number => {
    let sum = 0
    for (const x of xs) for (const y of ys) sum += luma(x, y)
    return sum / (xs.length * ys.length)
  }
  const cols = (from: number): number[] => [from, from + 1, from + 2, from + 3]
  const sampleY = Array.from({ length: 64 }, (_, i) => Math.floor((i * (h - 1)) / 63))
  const sampleX = Array.from({ length: 64 }, (_, i) => Math.floor((i * (w - 1)) / 63))
  return {
    left: mean(cols(0), sampleY),
    right: mean(cols(w - 4), sampleY),
    top: mean(sampleX, cols(0)),
    bottom: mean(sampleX, cols(h - 4))
  }
}

/**
 * THE ASSERTIONS THAT DECIDE WHETHER THE FILE IS FULL BLEED.
 *
 * A pillarboxed 1920x1080 export reads ~0 down its left and right
 * strips; a letterboxed one reads ~0 across its top and bottom. The
 * blue square then reports whether the picture that IS there was
 * cropped honestly or stretched to fit.
 */
function verifyFrame(
  file: string,
  frameIndex: number,
  w: number,
  h: number,
  source: { w: number; h: number } | null,
  what: string,
  /**
   * A FIXTURE'S EDGES ARE A KNOWN GREY; A PHOTOGRAPH'S ARE NOT.
   *
   * Real material has dark corners, dark rooms and dark frames, so a
   * brightness floor would fail on content rather than on geometry.
   * What a bar actually is, is DEGENERATE: every pixel in the strip is
   * the same near-zero value, in every frame. That is what is tested.
   */
  mode: 'fixture' | 'photographic' = 'fixture'
): EdgeReport {
  const pixel = frameReader(file, frameIndex, w, h)
  const edges = edgeMeans(pixel, w, h)

  const floor = mode === 'fixture' ? 40 : 10
  for (const [name, value] of Object.entries(edges)) {
    assert.ok(
      value > floor,
      `${what} frame ${frameIndex}: the picture reaches the ${name} edge ` +
        `(mean luma ${value.toFixed(1)} — a bar would be ~0)`
    )
  }

  if (mode === 'fixture') {
    // The picture is present in the corners too, not just along the
    // middle of each edge.
    for (const x of [1, Math.floor(w / 2), w - 2]) {
      for (const y of [1, Math.floor(h / 2), h - 2]) {
        assert.ok(
          Math.max(...pixel(x, y)) > 40,
          `${what} frame ${frameIndex}: picture present at (${x}, ${y})`
        )
      }
    }
  } else {
    // NOT A BAR: a pillarbox or letterbox is uniformly black down the
    // whole strip. Fewer than a third of the sampled pixels may be
    // near-black before the strip stops being picture.
    const black = (x: number, y: number): boolean => Math.max(...pixel(x, y)) < 8
    const strips: [string, number[], number[]][] = [
      ['left', [0, 1, 2, 3], []],
      ['right', [w - 4, w - 3, w - 2, w - 1], []],
      ['top', [], [0, 1, 2, 3]],
      ['bottom', [], [h - 4, h - 3, h - 2, h - 1]]
    ]
    for (const [name, xs, ys] of strips) {
      const columns = xs.length > 0 ? xs : Array.from({ length: 64 }, (_, i) => Math.floor((i * (w - 1)) / 63))
      const rows = ys.length > 0 ? ys : Array.from({ length: 64 }, (_, i) => Math.floor((i * (h - 1)) / 63))
      let dark = 0
      let total = 0
      for (const x of columns) {
        for (const y of rows) {
          total++
          if (black(x, y)) dark++
        }
      }
      assert.ok(
        dark / total < 0.34,
        `${what} frame ${frameIndex}: the ${name} strip is picture, not a bar ` +
          `(${((dark / total) * 100).toFixed(0)}% near-black; a bar is 100%)`
      )
    }
  }

  if (source) {
    // THE SQUARE'S BOUNDING BOX, not a scanline through its middle: a
    // watermark composited over the centre occludes any single line
    // across it, and measuring one would report the branding rather than
    // the geometry. The extremes of the square are never covered.
    const blue = ([r, g, b]: [number, number, number]): boolean => b > 170 && r < 90 && g < 110
    let minX = w
    let maxX = -1
    let minY = h
    let maxY = -1
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!blue(pixel(x, y))) continue
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
    assert.ok(maxX >= 0 && maxY >= 0, `${what}: the measured square is present`)
    const across = maxX - minX + 1
    const down = maxY - minY + 1

    // COVER: scale = max(w/sw, h/sh), applied to both axes equally.
    const expected = 100 * Math.max(w / source.w, h / source.h)
    assert.ok(
      Math.abs(across - expected) < 6,
      `${what}: horizontal cover scale ${across}px ≈ ${expected.toFixed(1)}px`
    )
    assert.ok(
      Math.abs(down - expected) < 6,
      `${what}: vertical cover scale ${down}px ≈ ${expected.toFixed(1)}px`
    )
    // NO STRETCHING: a square stays a square.
    assert.ok(
      Math.abs(across - down) < 5,
      `${what}: the square is still square (${across} x ${down})`
    )
    // The crop is centred, so the middle of the source survives.
    assert.ok(
      Math.abs((minX + maxX) / 2 - w / 2) < 5,
      `${what}: crop centred horizontally`
    )
    assert.ok(
      Math.abs((minY + maxY) / 2 - h / 2) < 5,
      `${what}: crop centred vertically`
    )
  }

  return edges
}

function makeProject(name: string): Project {
  return {
    id: `realexport-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    images: [],
    transitions: {},
    watermark: {
      enabled: true,
      imageSrc: null,
      imageName: null,
      position: 'center',
      sizePct: 45,
      opacityPct: 35
    },
    signature: {
      enabled: true,
      logoSrc: null,
      logoName: null,
      brandName: 'Image 2 Transition',
      websiteUrl: 'image2transition.io',
      position: 'bottom-right',
      sizePct: 12,
      opacityPct: 55
    },
    status: 'draft',
    workflow: { previewSentAt: null, paidAt: null, finalSentAt: null }
  }
}

/**
 * THE EXPORT PANEL'S BRANDING CHECKBOXES, as a case can set them.
 * All four states are reachable from the UI, so all four are exercised.
 */
type OverlayChoice = 'both' | 'watermark' | 'stamp' | 'none'

const wantsWatermark = (c: OverlayChoice): boolean => c === 'both' || c === 'watermark'
const wantsStamp = (c: OverlayChoice): boolean => c === 'both' || c === 'stamp'

interface Case {
  name: string
  format: ExportFormatId
  /** The project/editor aspect ratio the operator has configured. */
  projectAspect: AspectRatio
  /** Source sizes, in feed order; each pair becomes one clip. */
  sources: [number, number][]
  /** Per-pair transition mode; 'cut' emits held stills instead of a clip. */
  modes: TransitionMode[]
  /** The timeline length this case must still produce, in seconds. */
  expectedSec: number
  /** Asserted against the decoded square. Null where sources differ. */
  measured: { w: number; h: number } | null
  overlays: OverlayChoice
}

async function runCase(dir: string, testCase: Case): Promise<void> {
  const project = makeProject(testCase.name)
  const imagesDir = projectImagesDir(project.id)
  const clipsDir = projectTransitionsDir(project.id)
  mkdirSync(imagesDir, { recursive: true })
  mkdirSync(clipsDir, { recursive: true })

  // ── THE OPERATOR'S OWN SETTINGS ────────────────────────────────────
  //
  // Deliberately hostile where the case says so: a project configured
  // 9:16 must still produce a 1920x1080 Standard export, because the
  // Export Video button is a landscape deliverable and not a mirror of
  // the editor's shape.
  saveSettingsJson(
    JSON.stringify({
      exportDefaults: {
        aspectRatio: testCase.projectAspect,
        resolution: '1080p',
        fps: 25,
        defaultTransitionDurationSec: 5,
        seamBlend: 'subtle'
      }
    })
  )

  testCase.sources.forEach(([w, h], i) => {
    const ppm = fixturePpm(dir, w, h)
    ff(['-i', ppm, join(imagesDir, `img${i}.png`)], `still ${i}`)
    project.images.push({
      id: `${project.id}-img${i}`,
      fileName: `img${i}.png`,
      storedName: `img${i}.png`,
      src: ''
    })
  })
  project.feedSequence = project.images.map((img) => img.id)

  testCase.modes.forEach((mode, i) => {
    const key = `${project.images[i].id}->${project.images[i + 1].id}`
    if (mode !== 'ai') {
      project.transitions[key] = {
        prompt: 'p',
        durationSec: 5,
        status: 'not-generated',
        clip: null,
        mode,
        modeProvenance: 'manual'
      }
      return
    }
    const [w, h] = testCase.sources[i]
    const clip = join(clipsDir, `clip${i}.mp4`)
    ff(
      ['-loop', '1', '-i', fixturePpm(dir, w, h), '-t', '1.6', '-r', '25',
       '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip],
      `clip ${i}`
    )
    project.transitions[key] = {
      prompt: 'p',
      durationSec: 1.6,
      status: 'completed',
      mode: 'ai',
      modeProvenance: 'manual',
      clip: { storedName: `clip${i}.mp4`, originalName: `clip${i}.mp4`, source: 'fal', src: '' }
    }
  })
  saveProject(project)

  // The frame the UI would rasterise overlays against — the same call
  // the export panel makes before it asks for the export.
  const applied = applyExportFormat(
    {
      aspectRatio: testCase.projectAspect,
      resolution: '1080p',
      fps: 25,
      defaultTransitionDurationSec: 5,
      seamBlend: 'subtle'
    },
    testCase.format
  )
  const { w, h } = outputDims(applied.defaults)

  // ── THE EXPORT PANEL'S TWO CHECKBOXES ──────────────────────────────
  //
  // Inclusion is expressed by whether a PNG was rasterised at all, so
  // all four states of the pair are reachable and each must land
  // correctly: both, either one alone, and neither.
  const toArrayBuffer = (file: string): ArrayBuffer => {
    const b = readFileSync(file)
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
  }
  const overlays: { watermarkPng?: ArrayBuffer; signaturePng?: ArrayBuffer } = {}
  if (wantsWatermark(testCase.overlays)) {
    overlays.watermarkPng = toArrayBuffer(
      overlayPng(dir, `${testCase.name}-wm`, w, h, {
        x: Math.floor(w / 2) - 40,
        y: Math.floor(h / 2) - 40,
        w: 80,
        h: 80,
        rgb: [255, 255, 255]
      })
    )
  }
  if (wantsStamp(testCase.overlays)) {
    overlays.signaturePng = toArrayBuffer(
      overlayPng(dir, `${testCase.name}-stamp`, w, h, {
        x: w - 120,
        y: h - 80,
        w: 80,
        h: 40,
        rgb: [20, 240, 40]
      })
    )
  }

  // ── THE REAL ENTRY POINT ───────────────────────────────────────────
  const result = await startExport(project.id, 'final', overlays, null, testCase.format)
  assert.ok(result.ok, `startExport refused: ${'reason' in result ? result.reason : 'canceled'}`)
  const jobId = result.jobId

  resumeQueue()
  const deadline = Date.now() + 3 * 3600_000
  let job = listJobs().find((j) => j.id === jobId)
  while (Date.now() < deadline && !['completed', 'failed'].includes(job?.status ?? '')) {
    await sleep(100)
    job = listJobs().find((j) => j.id === jobId)
  }
  assert.equal(job?.status, 'completed', `export job did not complete: ${job?.note}`)

  const outputPath = job!.metadata.outputPath!
  assert.ok(existsSync(outputPath), 'the export wrote a file')

  // ── CONTAINER GEOMETRY ─────────────────────────────────────────────
  const header = probeHeader(outputPath)
  const expectedDar = testCase.format === 'instagram' ? '9:16' : '16:9'
  assert.ok(
    header.includes(`${w}x${h} [SAR 1:1 DAR ${expectedDar}]`),
    `${testCase.name}: expected ${w}x${h} SAR 1:1 DAR ${expectedDar}\n${header}`
  )
  assert.ok(!/displaymatrix|rotation of/i.test(header), `${testCase.name}: no rotation metadata`)
  assert.ok(header.includes('yuv420p'), `${testCase.name}: yuv420p`)

  // ── THE DELIVERED RATE, AND THAT IT IS REAL ────────────────────────
  //
  // A header can claim any rate. What proves it is the number of frames
  // the decoder actually produces: duration times the rate, give or take
  // the final frame. Counting them also catches the failure this change
  // is most exposed to — a graph that satisfies the container by simply
  // repeating frames.
  const { durationSec: duration, fps: encodedFps } = probeStreamInfo(outputPath)
  assert.equal(
    encodedFps,
    CUSTOMER_EXPORT_FPS,
    `${testCase.name}: customer exports are ${CUSTOMER_EXPORT_FPS} fps (got ${encodedFps})`
  )
  const counted = decodedFrameCount(outputPath)
  const expectedFrames = duration * CUSTOMER_EXPORT_FPS
  assert.ok(
    Math.abs(counted - expectedFrames) <= 3,
    `${testCase.name}: ${counted} decoded frames ≈ ${expectedFrames.toFixed(0)} ` +
      `(${duration}s x ${CUSTOMER_EXPORT_FPS})`
  )
  // TIGHT ON PURPOSE. A loose window is what let the first attempt pass:
  // interpolation was silently dropping the last source frame of every
  // segment, and 1.60s arriving as 1.53s looked fine against ±0.2. One
  // output frame is 0.008s, so 0.05 is generous and still catches it.
  assert.ok(
    Math.abs(duration - testCase.expectedSec) < 0.05,
    `${testCase.name}: timeline duration preserved — expected ~${testCase.expectedSec}s, got ${duration}s`
  )
  const middle = Math.max(1, Math.floor((duration * (encodedFps || 25)) / 2))
  const first = verifyFrame(outputPath, 0, w, h, testCase.measured, testCase.name)
  const mid = verifyFrame(outputPath, middle, w, h, testCase.measured, testCase.name)

  // ── BRANDING IS MEASURED AGAINST THE FINISHED FRAME ────────────────
  //
  // Each mark is asserted present when its checkbox is on and ABSENT
  // when it is off. Only checking the "on" half would pass a build that
  // composited both marks regardless of what the operator chose.
  {
    const pixel = frameReader(outputPath, middle, w, h)
    const centre = pixel(Math.floor(w / 2), Math.floor(h / 2))
    const corner = pixel(w - 80, h - 60)
    if (wantsWatermark(testCase.overlays)) {
      assert.ok(
        centre.every((v) => v > 230),
        `${testCase.name}: the watermark is at the centre of the finished frame`
      )
    } else {
      assert.ok(
        !centre.every((v) => v > 230),
        `${testCase.name}: no watermark was asked for, and none was composited`
      )
    }
    if (wantsStamp(testCase.overlays)) {
      assert.ok(
        corner[1] > 200 && corner[0] < 70,
        `${testCase.name}: the corner stamp is at the finished frame's bottom-right`
      )
      assert.ok(
        Math.max(...pixel(w - 6, h - 6)) > 40,
        `${testCase.name}: and the margin beside it is picture, not a black bar`
      )
    } else {
      assert.ok(
        !(corner[1] > 200 && corner[0] < 70),
        `${testCase.name}: no corner stamp was asked for, and none was composited`
      )
    }
  }

  log(
    `PASS ${testCase.name}: ${w}x${h} SAR 1:1 DAR ${expectedDar}, ${duration.toFixed(2)}s, ` +
      `edges L/R/T/B first ${first.left.toFixed(0)}/${first.right.toFixed(0)}/` +
      `${first.top.toFixed(0)}/${first.bottom.toFixed(0)} ` +
      `mid ${mid.left.toFixed(0)}/${mid.right.toFixed(0)}/${mid.top.toFixed(0)}/${mid.bottom.toFixed(0)}`
  )

  try {
    rmSync(outputPath, { force: true })
    deleteProjectFiles(project.id)
    deleteProjectRows(project.id)
  } catch {
    /* scratch user-data dir — best effort */
  }
}

/**
 * THE OPERATOR'S OWN PROJECT, EXPORTED THE WAY THEY EXPORT IT.
 *
 * `--f2f-real-export-proof --project=<id>` exports a project that already
 * exists in the user-data directory — real generated clips, real
 * photographs, the real timeline — and measures the file. The fixtures
 * above prove the geometry; this proves it on the material that produced
 * the pillarboxed file in the first place.
 *
 * Point it at a COPY of the user-data directory: it queues a job and
 * writes an export, which is work the operator did not ask for.
 */
async function runExistingProject(projectId: string, dir: string): Promise<number> {
  const { w, h } = outputDims(
    applyExportFormat(
      {
        aspectRatio: '16:9',
        resolution: '1080p',
        fps: 25,
        defaultTransitionDurationSec: 5,
        seamBlend: 'subtle'
      },
      'computer'
    ).defaults
  )

  // ── WHAT THE ENCODER IS ACTUALLY FED ───────────────────────────────
  //
  // The export must read the provider's own clips. If an intermediate
  // render — the editor preview above all — ever became the source, the
  // delivered file would carry two lossy generations and no setting on
  // the final encode could win that back. This prints the directories
  // the segments resolve to, so the claim is checked rather than assumed.
  const project = listProjects().find((p) => p.id === projectId)
  if (project) {
    const { segments } = exportAssembly(project)
    const folders = [...new Set(segments.map((s) => dirname(s.path)))]
    log(`segments: ${segments.length} from ${folders.length} folder(s)`)
    for (const folder of folders) log(`  source folder: ${folder}`)
    const suspicious = segments.filter((s) => /exports|preview|_hard-cuts|_seamless/i.test(s.path))
    assert.equal(suspicious.length, 0, 'no rendered intermediate is used as an export source')
  }

  const result = await startExport(projectId, 'final', {}, null, 'computer')
  assert.ok(result.ok, `startExport refused: ${'reason' in result ? result.reason : 'canceled'}`)

  resumeQueue()
  const deadline = Date.now() + 3 * 3600_000
  let job = listJobs().find((j) => j.id === result.jobId)
  while (Date.now() < deadline && !['completed', 'failed'].includes(job?.status ?? '')) {
    await sleep(250)
    job = listJobs().find((j) => j.id === result.jobId)
  }
  assert.equal(job?.status, 'completed', `export job did not complete: ${job?.note}`)

  const outputPath = job!.metadata.outputPath!
  const header = probeHeader(outputPath)
  log(`file: ${outputPath}`)
  log(header.split('\n').filter((l) => /Stream #0:0|Duration/.test(l)).join('\n       '))
  assert.ok(
    header.includes(`${w}x${h} [SAR 1:1 DAR 16:9]`),
    `expected ${w}x${h} SAR 1:1 DAR 16:9\n${header}`
  )
  assert.ok(!/displaymatrix|rotation of/i.test(header), 'no rotation metadata')

  // The delivered rate, counted rather than read off the header.
  const probe = probeStreamInfo(outputPath)
  assert.equal(
    probe.fps,
    CUSTOMER_EXPORT_FPS,
    `customer exports are ${CUSTOMER_EXPORT_FPS} fps (got ${probe.fps})`
  )
  const counted = decodedFrameCount(outputPath)
  const expected = probe.durationSec * CUSTOMER_EXPORT_FPS
  assert.ok(
    Math.abs(counted - expected) <= 3,
    `${counted} decoded frames ≈ ${expected.toFixed(0)} (${probe.durationSec}s x ${CUSTOMER_EXPORT_FPS})`
  )
  log(`rate: ${probe.fps} fps, ${counted} decoded frames over ${probe.durationSec}s`)

  // Frame indices come from the FILE's own rate. Hard-coding 25 broke the
  // moment the export started following its sources' 24.
  const { durationSec: duration, fps } = probeStreamInfo(outputPath)
  const total = Math.floor(duration * (fps || 25))
  const frames = [0, Math.floor(total * 0.25), Math.floor(total / 2), Math.floor(total * 0.75), total - 3]
  for (const frame of frames) {
    const edges = verifyFrame(
      outputPath,
      frame,
      w,
      h,
      null,
      `real-project frame ${frame}`,
      'photographic'
    )
    log(
      `frame ${String(frame).padStart(4)}: L ${edges.left.toFixed(1)} R ${edges.right.toFixed(1)} ` +
        `T ${edges.top.toFixed(1)} B ${edges.bottom.toFixed(1)}`
    )
  }
  log(`PASS real project ${projectId}: ${w}x${h}, full bleed across ${frames.length} frames`)
  writeFileSync(join(dir, 'real-project-output.txt'), outputPath)
  return 0
}

/**
 * THE TIMING CONTRACT, CASE BY CASE.
 *
 * ── WHY THESE ARE SEPARATE FROM THE GEOMETRY CASES ───────────────────
 *
 * Raising the frame rate must add frames BETWEEN the existing ones and
 * never change how long they are on screen. That is one sentence, and it
 * has one failure mode per way of joining segments — a cut, a crossfade,
 * a still, a split — so each gets its own arithmetic here, with the
 * expected length written out rather than derived from the code under
 * test.
 *
 * Rendered at 720p on purpose: timing is resolution-independent, and
 * motion estimation at 1080p would make this too slow to run often.
 */
export async function runTimingProof(): Promise<number> {
  const dir = join(app.getPath('temp'), `f2f-timing-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  const defaults: ExportDefaults = {
    aspectRatio: '16:9',
    resolution: '720p',
    fps: 25,
    defaultTransitionDurationSec: 5,
    seamBlend: 'off'
  }
  const SOURCE_FPS = 24
  const frame = 1 / SOURCE_FPS

  /** A 24 fps clip of `sec` seconds with real movement to interpolate. */
  const clip = (name: string, sec: number): string => {
    const file = join(dir, `${name}.mp4`)
    ff(
      ['-f', 'lavfi', '-i', `testsrc2=size=640x426:rate=${SOURCE_FPS}:duration=${sec}`,
       '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', file],
      `clip ${name}`
    )
    return file
  }
  const stillImage = (name: string): string => {
    const file = join(dir, `${name}.png`)
    ff(['-f', 'lavfi', '-i', 'color=c=teal:s=640x426:d=1', '-frames:v', '1', file], `still ${name}`)
    return file
  }

  const five = clip('five', 5)
  const image = stillImage('hold')
  let failures = 0

  const check = async (
    name: string,
    expectedSec: number,
    segments: AssembleSegment[],
    seamOverrideSec?: (number | null)[]
  ): Promise<void> => {
    const outputPath = join(dir, `${name}.mp4`)
    try {
      await assemble({
        clipPaths: [],
        segments,
        seamOverrideSec,
        defaults,
        fit: 'cover',
        padColor: 'black',
        targetFps: CUSTOMER_EXPORT_FPS,
        overlayPngPaths: [],
        outputPath
      }).done
      const { durationSec, fps } = probeStreamInfo(outputPath)
      const frames = decodedFrameCount(outputPath)
      const expectedFrames = expectedSec * CUSTOMER_EXPORT_FPS
      assert.equal(fps, CUSTOMER_EXPORT_FPS, `${name}: encoded at ${CUSTOMER_EXPORT_FPS} fps`)
      assert.ok(
        Math.abs(durationSec - expectedSec) <= 0.05,
        `${name}: expected ${expectedSec.toFixed(3)}s, got ${durationSec.toFixed(3)}s`
      )
      assert.ok(
        Math.abs(frames - expectedFrames) <= 6,
        `${name}: expected ~${expectedFrames.toFixed(0)} frames, got ${frames}`
      )
      log(
        `PASS ${name}: ${durationSec.toFixed(3)}s (expected ${expectedSec.toFixed(3)}), ` +
          `${frames} frames at ${fps} fps`
      )
    } catch (err) {
      failures++
      console.error(`[real-export] FAIL ${name}:`, err instanceof Error ? err.message : err)
    }
  }

  // A. One clip, unchanged length. 24 fps in, 120 fps out, same 5 seconds.
  await check('A-single-5s', 5, [{ kind: 'clip', path: five }])

  // B. Two hard-cut clips. No seam, so nothing is trimmed: 5 + 5.
  await check('B-hard-cut', 10, [
    { kind: 'clip', path: five },
    { kind: 'clip', path: five }
  ], [0])

  // C. Two clips with a one-second crossfade. 5 + 5 − 1, less the one
  //    SOURCE frame the seam planner trims from each side of the joint,
  //    which is 1/24s and not 1/120s — that distinction is the whole
  //    reason the seam arithmetic runs on the source rate.
  await check('C-crossfade-1s', 10 - 1 - 2 * frame, [
    { kind: 'clip', path: five },
    { kind: 'clip', path: five }
  ], [1])

  // D. A held photograph followed by a clip. A still has no motion to
  //    interpolate and must come out exactly as long as it was held.
  await check('D-still-plus-clip', 8, [
    { kind: 'still', path: image, holdSeconds: 3 },
    { kind: 'clip', path: five }
  ], [0])

  // E. One source split into two timeline items. The pieces must add up
  //    to what the whole was, with no gap and no overlap.
  await check('E-split-2s-3s', 5, [
    { kind: 'clip', path: five, sourceStartSec: 0, sourceEndSec: 2 },
    { kind: 'clip', path: five, sourceStartSec: 2, sourceEndSec: 5 }
  ], [0, 0])

  // F. A mixed timeline: still, crossfade, a short split piece, hard cut.
  //
  // ── TWO DOCUMENTED CLAMPS DECIDE THIS NUMBER ────────────────────
  //
  // The 2s piece is short enough to engage both safety rules in the seam
  // planner, and the expectation has to account for them or the test is
  // just asserting a guess:
  //
  //   1. A seam may not exceed 40% of the shorter segment it joins, so
  //      the 1s crossfade against a 2s neighbour is clamped to 0.8s.
  //   2. A segment too short to give a frame away is not trimmed at all,
  //      so the 2s piece keeps its full length while the 5s one loses
  //      its one source frame.
  //
  //   3 + (5 − 1/24) + 2 + 5 − 0.8 = 14.158
  //
  // Both rules exist so that seamless mode degrades to a hard cut rather
  // than eating a short clip, and both are worth pinning.
  await check('F-mixed-timeline', 3 + (5 - frame) + 2 + 5 - 0.8, [
    { kind: 'still', path: image, holdSeconds: 3 },
    { kind: 'clip', path: five },
    { kind: 'clip', path: five, sourceStartSec: 0, sourceEndSec: 2 },
    { kind: 'clip', path: five }
  ], [0, 1, 0])

  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
  log(failures === 0 ? 'TIMING: all cases hold' : `TIMING: ${failures} case(s) FAILED`)
  return failures === 0 ? 0 : 1
}

export async function runRealExportProof(): Promise<number> {
  const dir = join(app.getPath('temp'), `f2f-real-export-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  const destination = join(dir, 'out')
  mkdirSync(destination, { recursive: true })
  process.env.F2F_EXPORT_DEST = destination

  const settingsBefore = getSettingsJson()
  initQueue()

  // `--project=<id>` exports an EXISTING project instead of the fixtures.
  const requested = process.argv.find((a) => a.startsWith('--project='))?.slice('--project='.length)
  if (requested) {
    try {
      const code = await runExistingProject(requested, dir)
      stopQueue()
      return code
    } catch (err) {
      console.error('[real-export] FAIL real project:', err instanceof Error ? err.message : err)
      stopQueue()
      return 1
    }
  }

  const cases: Case[] = [
    // A. The operator's own shape: 3:2 sources in a 16:9 frame. This is
    //    the export that came out pillarboxed.
    {
      name: 'A-3x2-source',
      expectedSec: 1.6,
      format: 'computer',
      projectAspect: '16:9',
      sources: [[1176, 784], [1176, 784]],
      modes: ['ai'],
      measured: { w: 1176, h: 784 },
      overlays: 'both'
    },
    // B. A 16:9 source needs no crop at all.
    {
      name: 'B-16x9-source',
      expectedSec: 1.6,
      format: 'computer',
      projectAspect: '16:9',
      sources: [[1920, 1080], [1920, 1080]],
      modes: ['ai'],
      measured: { w: 1920, h: 1080 },
      overlays: 'none'
    },
    // C. Portrait source: cover crops the sides and still fills 16:9.
    {
      name: 'C-portrait-source',
      expectedSec: 1.6,
      format: 'computer',
      projectAspect: '16:9',
      sources: [[784, 1176], [784, 1176]],
      modes: ['ai'],
      measured: { w: 784, h: 1176 },
      overlays: 'none'
    },
    // D. A mixed timeline — three ratios, a clip, a crossfade and held
    //    stills — must be full bleed in EVERY frame, not only the first.
    {
      name: 'D-mixed-ratios',
      expectedSec: 3.2,
      format: 'computer',
      projectAspect: '16:9',
      sources: [[1176, 784], [1920, 1080], [784, 1176], [1000, 1000]],
      modes: ['ai', 'cut', 'ai'],
      measured: null,
      overlays: 'both'
    },
    // E. THE SETTING THAT USED TO DECIDE THE SHAPE. A project configured
    //    portrait must still export Standard as 1920x1080.
    {
      name: 'E-portrait-project-setting',
      expectedSec: 1.6,
      format: 'computer',
      projectAspect: '9:16',
      sources: [[1176, 784], [1176, 784]],
      modes: ['ai'],
      measured: { w: 1176, h: 784 },
      overlays: 'none'
    },
    // F. INSTAGRAM IS UNCHANGED: still 1080x1920, still full bleed.
    {
      name: 'F-instagram-regression',
      expectedSec: 1.6,
      format: 'instagram',
      projectAspect: '16:9',
      sources: [[1176, 784], [1176, 784]],
      modes: ['ai'],
      measured: { w: 1176, h: 784 },
      overlays: 'both'
    },
    // G and H. THE OTHER TWO CHECKBOX STATES. Both-on and both-off are
    // covered above; these are the mixed ones, where a build that
    // composited whatever it was given regardless of the operator's
    // choice would finally show up.
    {
      name: 'G-watermark-only',
      expectedSec: 1.6,
      format: 'computer',
      projectAspect: '16:9',
      sources: [[1176, 784], [1176, 784]],
      modes: ['ai'],
      measured: { w: 1176, h: 784 },
      overlays: 'watermark'
    },
    {
      name: 'H-stamp-only',
      expectedSec: 1.6,
      format: 'instagram',
      projectAspect: '16:9',
      sources: [[1176, 784], [1176, 784]],
      modes: ['ai'],
      measured: { w: 1176, h: 784 },
      overlays: 'stamp'
    }
  ]

  let failures = 0
  for (const testCase of cases) {
    try {
      await runCase(dir, testCase)
    } catch (err) {
      failures++
      console.error(`[real-export] FAIL ${testCase.name}:`, err instanceof Error ? err.message : err)
    }
  }

  stopQueue()
  if (settingsBefore) saveSettingsJson(settingsBefore)
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }

  if (failures === 0) {
    log('ALL CASES PASS — the real Export Video path produces full-bleed files')
  } else {
    log(`${failures} case(s) FAILED`)
  }
  return failures === 0 ? 0 : 1
}
