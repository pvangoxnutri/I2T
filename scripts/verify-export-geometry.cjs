// Standalone regression: node scripts/verify-export-geometry.cjs
// Loads only pure geometry and FFmpeg modules; never starts Electron or opens app data.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const childProcess = require('node:child_process')
const ts = require('typescript')

require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  })
  module._compile(outputText, filename)
}

const commands = []
const originalSpawn = childProcess.spawn
childProcess.spawn = (binary, args, options) => {
  commands.push({ binary, args })
  return originalSpawn(binary, args, options)
}
const { assemble, ffmpegPath, outputDims } = require('../src/main/services/ffmpegService.ts')
const { applyExportFormat, CUSTOMER_EXPORT_FPS } = require('../src/shared/exportFormat.ts')
const { outputDims: overlayDims } = require('../src/renderer/src/utils/rasterizeOverlays.ts')
const scratch = path.resolve(__dirname, '../scratch')
fs.mkdirSync(scratch, { recursive: true })
const dir = fs.mkdtempSync(path.join(scratch, 'export-geometry-'))
const base = {
  aspectRatio: '1:1', resolution: '1080p', fps: 25,
  defaultTransitionDurationSec: 5, seamBlend: 'off'
}

function ffmpeg(args, options = {}) {
  const result = childProcess.spawnSync(ffmpegPath(), ['-hide_banner', '-v', 'error', ...args], {
    maxBuffer: 40 * 1024 * 1024, timeout: 60000, windowsHide: true, ...options
  })
  assert.equal(result.status, 0, result.stderr?.toString())
  return result.stdout
}

// A grey field with a blue square: the square measures scale, distortion and centering.
function fixture(w, h) {
  const pixels = Buffer.alloc(w * h * 3, 160)
  const side = 100
  const left = Math.floor((w - side) / 2)
  const top = Math.floor((h - side) / 2)
  for (let y = top; y < top + side; y++) {
    for (let x = left; x < left + side; x++) {
      pixels.set([20, 40, 240], (y * w + x) * 3)
    }
  }
  const file = path.join(dir, `source-${w}x${h}.ppm`)
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), pixels]))
  return file
}

function decode(file, w, h) {
  const pixels = ffmpeg(['-i', file, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'])
  assert.equal(pixels.length, w * h * 3, 'decoded frame has the exact output dimensions')
  return (x, y) => [...pixels.subarray((y * w + x) * 3, (y * w + x) * 3 + 3)]
}

function verifyPicture(file, w, h, sourceW, sourceH) {
  const pixel = decode(file, w, h)
  for (const x of [2, Math.floor(w / 2), w - 3]) {
    for (const y of [2, Math.floor(h / 2), h - 3]) {
      assert.ok(Math.max(...pixel(x, y)) > 100, `picture reaches (${x}, ${y})`)
    }
  }
  const blue = ([r, g, b]) => b > 170 && r < 80 && g < 100
  const xs = Array.from({ length: w }, (_, x) => x).filter(x => blue(pixel(x, Math.floor(h / 2))))
  const ys = Array.from({ length: h }, (_, y) => y).filter(y => blue(pixel(Math.floor(w / 2), y)))
  const expectedSide = 100 * Math.max(w / sourceW, h / sourceH)
  assert.ok(Math.abs(xs.length - expectedSide) < 5, 'horizontal cover scale is correct')
  assert.ok(Math.abs(ys.length - expectedSide) < 5, 'vertical cover scale is correct')
  assert.ok(Math.abs(xs.length - ys.length) < 4, 'square stays square, no stretching')
  assert.ok(Math.abs((xs[0] + xs.at(-1)) / 2 - w / 2) < 4, 'crop is horizontally centered')
  assert.ok(Math.abs((ys[0] + ys.at(-1)) / 2 - h / 2) < 4, 'crop is vertically centered')
}

function overlay(w, h, name, x, y, boxW, boxH, color) {
  const pixels = Buffer.alloc(w * h * 4)
  for (let yy = y; yy < y + boxH; yy++) {
    for (let xx = x; xx < x + boxW; xx++) pixels.set([...color, 255], (yy * w + xx) * 4)
  }
  const file = path.join(dir, name + '.png')
  ffmpeg(['-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${w}x${h}`,
    '-i', 'pipe:0', '-frames:v', '1', file], { input: pixels })
  return file
}

async function render(name, format, resolution, segments, overlays = [], seams, targetFps) {
  const applied = applyExportFormat({ ...base, resolution }, format)
  const { w, h } = outputDims(applied.defaults)
  assert.deepEqual(overlayDims(applied.defaults), { w, h }, 'overlay and encoder canvases agree')
  assert.equal(w % 2, 0)
  assert.equal(h % 2, 0)
  const file = path.join(dir, name + '.mp4')
  await assemble({
    clipPaths: [], segments, ...applied, overlayPngPaths: overlays,
    outputPath: file, seamOverrideSec: seams, targetFps
  }).done
  const { args } = commands.at(-1)
  const graph = args[args.indexOf('-filter_complex') + 1]
  // Lanczos is named on the scale: every customer export is an upscale and
  // swscale's default softens the edges the picture is judged on.
  assert.ok(graph.includes(`force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h}`))
  assert.ok(!graph.includes('pad='), 'customer export has no padding filter')
  assert.ok(graph.includes('setsar=1'))
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264')
  assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p')
  // The delivery rate is reached by motion compensation, never by repeating
  // frames. Omitting targetFps must leave the graph free of it, which is
  // what keeps the internal renders cheap.
  if (targetFps) {
    assert.ok(
      graph.includes(`minterpolate=fps=${targetFps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir`),
      'interpolated to the delivery rate, not frame-duplicated'
    )
    assert.equal(args[args.indexOf('-r') + 1], String(targetFps))
  } else {
    assert.ok(!graph.includes('minterpolate'), 'internal renders are not interpolated')
  }
  const info = childProcess.spawnSync(ffmpegPath(), ['-hide_banner', '-i', file], {
    encoding: 'utf8', windowsHide: true, timeout: 20000
  }).stderr
  assert.ok(info.includes(`${w}x${h} [SAR 1:1 DAR ${format === 'instagram' ? '9:16' : '16:9'}]`), info)
  assert.ok(info.includes('yuv420p'), info)
  console.log(`PASS ${name}: ${w}x${h}, square pixels, H.264/yuv420p, cover without pad`)
  return { file, w, h }
}

async function main() {
  for (const aspectRatio of ['16:9', '9:16', '1:1', '4:5']) {
    const defaults = { ...base, aspectRatio }
    for (const format of ['computer', undefined, null]) {
      assert.equal(applyExportFormat(defaults, format).defaults.aspectRatio, '16:9')
      assert.equal(defaults.aspectRatio, aspectRatio)
    }
    assert.equal(applyExportFormat(defaults, 'instagram').defaults.aspectRatio, '9:16')
  }
  const still = (file) => ({ kind: 'still', path: file, holdSeconds: 0.4 })
  const landscape = fixture(900, 600)
  for (const resolution of ['720p', '1080p', '4K']) {
    const { file, w, h } = await render(`standard-${resolution}`, 'computer', resolution, [still(landscape)])
    verifyPicture(file, w, h, 900, 600)
  }
  for (const [sourceW, sourceH] of [[901, 601], [1200, 500], [600, 900], [960, 540]]) {
    const { file, w, h } = await render(`standard-${sourceW}x${sourceH}`, 'computer', '1080p',
      [still(fixture(sourceW, sourceH))])
    verifyPicture(file, w, h, sourceW, sourceH)
  }
  const clip = path.join(dir, 'source-clip.mp4')
  ffmpeg(['-loop', '1', '-i', landscape, '-t', '0.4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip])
  const mixed = await render('standard-mixed-xfade', 'computer', '1080p',
    [{ kind: 'clip', path: clip }, still(landscape)], [], [0.08])
  verifyPicture(mixed.file, mixed.w, mixed.h, 900, 600)

  const instagram = await render('instagram-regression', 'instagram', '1080p', [still(landscape)])
  verifyPicture(instagram.file, instagram.w, instagram.h, 900, 600)

  // ── THE DELIVERY RATE, IN BOTH FORMATS ─────────────────────────────
  // A real clip, because a still has no motion to interpolate and would
  // prove nothing about the interpolation path. Geometry must survive it.
  const motion = path.join(dir, 'motion-source.mp4')
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=900x600:rate=24:duration=0.5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', motion])
  for (const format of ['computer', 'instagram']) {
    const out = await render(`${format}-120fps`, format, '1080p',
      [{ kind: 'clip', path: motion }], [], undefined, CUSTOMER_EXPORT_FPS)
    const info = childProcess.spawnSync(ffmpegPath(), ['-hide_banner', '-i', out.file], {
      encoding: 'utf8', windowsHide: true, timeout: 20000
    }).stderr
    assert.ok(info.includes(`${CUSTOMER_EXPORT_FPS} fps`), info)
    console.log(`PASS ${format}-120fps: encoded at ${CUSTOMER_EXPORT_FPS} fps`)
  }

  for (const format of ['computer', 'instagram']) {
    const { w, h } = outputDims(applyExportFormat(base, format).defaults)
    const mark = overlay(w, h, format + '-watermark', w / 2 - 40, h / 2 - 40, 80, 80, [255, 255, 255])
    const stamp = overlay(w, h, format + '-stamp', w - 120, h - 80, 80, 40, [20, 240, 40])
    const out = await render(format + '-overlays', format, '1080p', [still(landscape)], [mark, stamp])
    const pixel = decode(out.file, w, h)
    assert.ok(pixel(w / 2, h / 2).every(v => v > 230), 'watermark stays centered after cropping')
    const corner = pixel(w - 80, h - 60)
    assert.ok(corner[1] > 200 && corner[0] < 60, 'stamp stays at its final-frame corner')
    assert.ok(pixel(w - 10, h - 10).every(v => v > 130 && v < 190), 'stamp retains its margin')
  }
  fs.writeFileSync(path.join(dir, 'commands.json'), JSON.stringify(commands, null, 2))
  console.log(`All geometry, decoded-pixel and overlay checks passed. Artifacts: ${dir}`)
}

main().catch(error => { console.error(error); process.exitCode = 1 })
