import type {
  AspectRatio,
  BrandSignature,
  ExportDefaults,
  PreviewWatermark
} from '../types'

/**
 * Renders the two branding layers to FULL-FRAME transparent PNGs at output
 * resolution. FFmpeg then composites them at 0:0 — all positioning/sizing/
 * opacity logic lives here, in the same code style as the live preview box,
 * so the exported result matches what the editor shows.
 */

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

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not load overlay image'))
    img.src = src
  })
}

function canvasToArrayBuffer(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('Canvas rasterization failed'))
      void blob.arrayBuffer().then(resolve, reject)
    }, 'image/png')
  })
}

interface Anchor {
  h: 'left' | 'center' | 'right'
  v: 'top' | 'center' | 'bottom'
}

function anchorOf(position: string): Anchor {
  const [v, h = 'center'] = position.split('-')
  return {
    v: (v as Anchor['v']) ?? 'center',
    h: (h as Anchor['h']) ?? 'center'
  }
}

function place(
  anchor: Anchor,
  frameW: number,
  frameH: number,
  w: number,
  h: number,
  margin: number
): { x: number; y: number } {
  const x =
    anchor.h === 'left' ? margin : anchor.h === 'right' ? frameW - w - margin : (frameW - w) / 2
  const y =
    anchor.v === 'top' ? margin : anchor.v === 'bottom' ? frameH - h - margin : (frameH - h) / 2
  return { x, y }
}

/** Large customer-protection watermark for PREVIEW exports. */
export async function rasterizeWatermark(
  wm: PreviewWatermark,
  defaults: ExportDefaults
): Promise<ArrayBuffer | null> {
  if (!wm.enabled) return null
  const { w: W, h: H } = outputDims(defaults)
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  ctx.globalAlpha = wm.opacityPct / 100
  const margin = Math.round(Math.min(W, H) * 0.04)
  const anchor = anchorOf(wm.position)

  if (wm.imageSrc) {
    const img = await loadImage(wm.imageSrc)
    const targetW = (wm.sizePct / 100) * W
    const targetH = targetW * (img.naturalHeight / img.naturalWidth)
    const { x, y } = place(anchor, W, H, targetW, targetH, margin)
    ctx.drawImage(img, x, y, targetW, targetH)
  } else {
    // Text fallback — the same "PREVIEW" the editor's preview box shows.
    const fontSize = Math.max(24, Math.round((W * (wm.sizePct / 3)) / 330))
    ctx.font = `700 ${fontSize}px Georgia, serif`
    ctx.shadowColor = 'rgba(0,0,0,0.6)'
    ctx.shadowBlur = fontSize / 3
    ctx.fillStyle = '#ffffff'
    const letterSpacing = fontSize * 0.35
    const text = 'PREVIEW'
    const widths = [...text].map((ch) => ctx.measureText(ch).width)
    const totalW = widths.reduce((a, b) => a + b, 0) + letterSpacing * (text.length - 1)
    const { x, y } = place(anchor, W, H, totalW, fontSize, margin)
    let cursor = x
    ctx.textBaseline = 'top'
    for (let i = 0; i < text.length; i++) {
      ctx.fillText(text[i], cursor, y)
      cursor += widths[i] + letterSpacing
    }
  }

  return canvasToArrayBuffer(canvas)
}

/** Small permanent FrameToFrame signature pill. */
export async function rasterizeSignature(
  sig: BrandSignature,
  defaults: ExportDefaults
): Promise<ArrayBuffer | null> {
  if (!sig.enabled) return null
  const { w: W, h: H } = outputDims(defaults)
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!

  // Scale factor mirrors the preview box (designed at ~330px width).
  const s = (Math.min(W, H) / 330) * (sig.sizePct / 12)
  const padX = 8 * s
  const padY = 4 * s
  const nameSize = 9.5 * s
  const urlSize = 8 * s
  const logoH = 14 * s
  const gap = 6 * s

  const logo = sig.logoSrc ? await loadImage(sig.logoSrc) : null
  const logoW = logo ? logoH * (logo.naturalWidth / logo.naturalHeight) : 0

  ctx.font = `600 ${nameSize}px "Segoe UI", Arial, sans-serif`
  const nameW = sig.brandName ? ctx.measureText(sig.brandName).width : 0
  ctx.font = `400 ${urlSize}px "Segoe UI", Arial, sans-serif`
  const urlW = sig.websiteUrl ? ctx.measureText(sig.websiteUrl).width : 0

  const textW = Math.max(nameW, urlW)
  const textH =
    (sig.brandName ? nameSize * 1.2 : 0) + (sig.websiteUrl ? urlSize * 1.25 : 0)
  const contentH = Math.max(logo ? logoH : 0, textH)
  const pillW = padX * 2 + (logo ? logoW + gap : 0) + textW
  const pillH = padY * 2 + contentH

  const margin = Math.round(Math.min(W, H) * 0.03)
  const { x, y } = place(anchorOf(sig.position), W, H, pillW, pillH, margin)

  ctx.globalAlpha = sig.opacityPct / 100

  // Pill background + hairline border (same look as the preview).
  const r = 6 * s
  ctx.beginPath()
  ctx.roundRect(x, y, pillW, pillH, r)
  ctx.fillStyle = 'rgba(10, 11, 12, 0.55)'
  ctx.fill()
  ctx.lineWidth = Math.max(1, s)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)'
  ctx.stroke()

  let cursorX = x + padX
  if (logo) {
    ctx.drawImage(logo, cursorX, y + (pillH - logoH) / 2, logoW, logoH)
    cursorX += logoW + gap
  }

  let textY = y + (pillH - textH) / 2
  ctx.textBaseline = 'top'
  if (sig.brandName) {
    ctx.font = `600 ${nameSize}px "Segoe UI", Arial, sans-serif`
    ctx.fillStyle = '#ffffff'
    ctx.fillText(sig.brandName, cursorX, textY)
    textY += nameSize * 1.2
  }
  if (sig.websiteUrl) {
    ctx.font = `400 ${urlSize}px "Segoe UI", Arial, sans-serif`
    ctx.fillStyle = 'rgba(255,255,255,0.75)'
    ctx.fillText(sig.websiteUrl, cursorX, textY)
  }

  return canvasToArrayBuffer(canvas)
}
