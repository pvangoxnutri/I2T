import { useEffect, useState } from 'react'
import { useAppState } from '../../state/AppState'
import type { CornerPosition, Project, WatermarkPosition } from '../../types'
import { resolveBranding } from '../../../../shared/branding'
import { formatPrice, priceSnapshot } from '../../../../shared/pricing'
import { rasterizeSignature, rasterizeWatermark } from '../../utils/rasterizeOverlays'
import { getFeedImages } from '../../../../shared/feedSequence'
import {
  applyExportFormat,
  DEFAULT_MOTION_QUALITY,
  MOTION_QUALITIES,
  type ExportFormatId,
  type MotionQuality
} from '../../../../shared/exportFormat'
import {
  Field,
  ImagePickerButton,
  SectionCard,
  SelectInput,
  SliderRow,
  TextInput,
  Toggle
} from '../common/controls'

const WATERMARK_POSITIONS: { value: WatermarkPosition; label: string }[] = [
  { value: 'top-left', label: 'Top left' },
  { value: 'top-center', label: 'Top center' },
  { value: 'top-right', label: 'Top right' },
  { value: 'center-left', label: 'Center left' },
  { value: 'center', label: 'Center' },
  { value: 'center-right', label: 'Center right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom-center', label: 'Bottom center' },
  { value: 'bottom-right', label: 'Bottom right' }
]

/** Maps a watermark position to flex alignment inside the preview box. */
function positionStyle(position: WatermarkPosition | CornerPosition): React.CSSProperties {
  const [v, h = 'center'] = position.split('-') as [string, string?]
  return {
    justifyContent: h === 'left' ? 'flex-start' : h === 'right' ? 'flex-end' : 'center',
    alignItems: v === 'top' ? 'flex-start' : v === 'bottom' ? 'flex-end' : 'center'
  }
}

/**
 * Branding & export column. Two SEPARATE layers by design:
 *  1. Preview watermark — large, covers unpaid preview exports, removed on final.
 *  2. I2T signature — small, premium, sits in a corner on everything.
 * The preview box renders both live so the customer-facing result is obvious.
 */
export function BrandingExportPanel({ project }: { project: Project }): React.JSX.Element {
  const { updateWatermark, updateSignature, settings } = useAppState()
  const [exportNote, setExportNote] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  // ── THE RESOLVED BRANDING, NOT THE RAW PROJECT ROW ────────────────
  //
  // A project that has never chosen its own image INHERITS the one
  // configured in Settings. Reading `project.watermark` directly meant a
  // null image was read as "no watermark" rather than "nothing
  // overridden", so a watermark configured in Settings never reached an
  // existing project — neither its preview nor its export.
  //
  // The rasterisers below feed on this, so the exported PNG is built
  // from exactly what the preview draws.
  const branding = resolveBranding(project, settings)
  const wm = branding.watermark
  const sig = branding.signature
  const feedImages = getFeedImages(project)
  const coverSrc = feedImages[0]?.src ?? null

  /**
   * READINESS COMES FROM MAIN, NOT FROM HERE.
   *
   * ── THE BUG THIS REPLACES ──────────────────────────────────────────
   *
   * This block used to be a loop with the rule "N images in the feed need
   * N−1 clips", demanding a generated clip for EVERY pair without ever
   * asking what the transition is. A cut generates nothing by definition,
   * so on a finished feed every cut was reported as a missing clip and
   * Export stayed disabled — on the real project, exactly
   * "5 → 6, 7 → 8, 9 → 10, 11 → 12, 13 → 14", the five pairs that are a
   * cut with no clip.
   *
   * It was also a SECOND readiness implementation. Fixing the assembler
   * changed nothing here because this never called it. Now there is one
   * answer, from the same assembly the exporter runs on.
   */
  const [readiness, setReadiness] = useState<{
    ready: boolean
    missingAiClips: string[]
    reason: string | null
  } | null>(null)

  useEffect(() => {
    void window.f2f.exports.readiness(project.id).then(setReadiness)
    // Re-read whenever a mode, a clip or the feed itself changes — all of
    // which move through `updatedAt`.
  }, [project.id, project.updatedAt])

  const missingPairs = readiness?.missingAiClips ?? []
  const canExport = (readiness?.ready ?? false) && !starting

  /**
   * WHAT THIS EXPORT CARRIES — not what the preview shows.
   *
   * The timeline preview has its own Watermark and Corner Stamp
   * checkboxes and they are deliberately NOT these. Those decide what is
   * on screen while editing; these decide what is rasterised into the
   * file. An operator can work with a clean picture and still ship a
   * branded one, which is the normal way round.
   *
   * Local state, not settings: it is a decision about one export, and
   * storing it would make the next export inherit a choice nobody made.
   * Saved Branding Settings still own the asset, position, size and
   * opacity; these own only whether it is included.
   */
  /**
   * SMOOTHNESS FOR THIS EXPORT. Standard by default.
   *
   * Local to the panel, like the branding checkboxes: it is a decision
   * about one export, and storing it would make the next one inherit a
   * choice nobody made. The value travels with the queued job, so a
   * retry or a restart reproduces what was chosen here.
   */
  const [motionQuality, setMotionQuality] = useState<MotionQuality>(DEFAULT_MOTION_QUALITY)
  const [exportWatermark, setExportWatermark] = useState(true)
  const [exportStamp, setExportStamp] = useState(true)

  const runExport = async (format: ExportFormatId): Promise<void> => {
    setStarting(true)
    setExportNote(null)
    try {
      // ── THE OVERLAYS ARE BUILT FOR THE FRAME THEY LAND ON ─────────
      //
      // THE BUG THIS FIXES. These were rasterised against
      // `settings.exportDefaults` — the PROJECT's aspect ratio, 16:9 —
      // whatever shape the export itself was. An Instagram Reel renders
      // 1080x1920, so a 1920x1080 overlay PNG was composited onto it at
      // 0:0: clipped off the right edge, covering only the top half, and
      // the corner stamp — anchored to the bottom-right of a LANDSCAPE
      // canvas — landed near the middle of the Reel and off its side.
      //
      // The format decides the frame, so the format decides the overlay.
      const { defaults: frame } = applyExportFormat(settings.exportDefaults, format)
      const [watermarkPng, signaturePng] = await Promise.all([
        exportWatermark ? rasterizeWatermark(wm, frame) : null,
        exportStamp ? rasterizeSignature(sig, frame) : null
      ])
      const result = await window.f2f.exports.run(
        project.id,
        'final',
        { watermarkPng, signaturePng },
        null,
        format,
        motionQuality
      )
      if (result.ok) {
        setExportNote('Export queued — follow progress under Queue.')
      } else if ('canceled' in result && result.canceled) {
        setExportNote(null)
      } else {
        setExportNote(
          result.missing.length > 0
            ? `Missing transition clips: ${result.missing.join(', ')}`
            : result.reason
        )
      }
    } catch (err) {
      setExportNote(err instanceof Error ? err.message : 'Export failed to start')
    } finally {
      setStarting(false)
    }
  }

  // Draft projects price against CURRENT settings; queued jobs snapshot.
  const price = priceSnapshot(project.images.length, settings.pricing)

  return (
    <div className="branding-panel">
      <div className="pricing-summary">
        <div className="pricing-row">
          <span>Images</span>
          <span>{price.imageCount}</span>
        </div>
        <div className="pricing-row">
          <span>Price per image</span>
          <span>{formatPrice(price.pricePerImage, price.currency)}</span>
        </div>
        <div className="pricing-row pricing-total">
          <span>Total</span>
          <span>{formatPrice(price.totalPrice, price.currency)}</span>
        </div>
      </div>

      <SectionCard title="Preview" subtitle="How branded exports will look.">
        <div className="brand-preview">
          {coverSrc ? (
            <img className="brand-preview-photo" src={coverSrc} alt="" draggable={false} />
          ) : (
            <div className="brand-preview-empty">Add photos to see the preview</div>
          )}

          {wm.enabled && (
            <div className="brand-preview-layer" style={positionStyle(wm.position)}>
              {wm.imageSrc ? (
                <img
                  src={wm.imageSrc}
                  alt=""
                  draggable={false}
                  style={{ width: `${wm.sizePct}%`, opacity: wm.opacityPct / 100 }}
                />
              ) : (
                <span
                  className="brand-preview-watermark-text"
                  style={{ opacity: wm.opacityPct / 100, fontSize: `${Math.max(10, wm.sizePct / 3)}px` }}
                >
                  PREVIEW
                </span>
              )}
            </div>
          )}

          {sig.enabled && (
            <div className="brand-preview-layer" style={positionStyle(sig.position)}>
              <span
                className="brand-preview-signature"
                style={{ opacity: sig.opacityPct / 100, maxWidth: `${sig.sizePct * 2.4}%` }}
              >
                {sig.logoSrc ? <img src={sig.logoSrc} alt="" draggable={false} /> : null}
                <span className="brand-preview-signature-text">
                  <strong>{sig.brandName || 'I2T'}</strong>
                  {sig.websiteUrl ? <em>{sig.websiteUrl}</em> : null}
                </span>
              </span>
            </div>
          )}
        </div>

        {/* ── HOW SMOOTH THE MOTION IS ────────────────────────────────
            Smoothness only. Neither level changes how long the film runs
            or how fast anything in it moves — that is the timeline's
            Speed, and the two are deliberately separate. */}
        <fieldset className="export-quality">
          <legend>Export quality</legend>
          {(Object.keys(MOTION_QUALITIES) as MotionQuality[]).map((id) => (
            <label className="export-quality-option" key={id}>
              <input
                type="radio"
                name="export-quality"
                value={id}
                checked={motionQuality === id}
                onChange={() => setMotionQuality(id)}
              />
              <span>
                <strong>{MOTION_QUALITIES[id].label}</strong>
                <small>{MOTION_QUALITIES[id].note}</small>
                {MOTION_QUALITIES[id].caveat ? (
                  <small className="export-quality-caveat">{MOTION_QUALITIES[id].caveat}</small>
                ) : null}
              </span>
            </label>
          ))}
        </fieldset>

        {/* ── BRANDING FOR THIS EXPORT ────────────────────────────────
            Not the timeline preview's checkboxes. Those decide what is
            on screen; these decide what is rasterised into the file, and
            they apply to both buttons below. */}
        <fieldset className="export-branding">
          <legend>Branding</legend>
          <label className="export-branding-option">
            <input
              type="checkbox"
              checked={exportWatermark}
              onChange={(e) => setExportWatermark(e.target.checked)}
            />
            <span>Watermark</span>
          </label>
          <label className="export-branding-option">
            <input
              type="checkbox"
              checked={exportStamp}
              onChange={(e) => setExportStamp(e.target.checked)}
            />
            <span>Corner Stamp</span>
          </label>
        </fieldset>

        <div className="export-actions">
          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={!canExport}
            title={
              canExport
                ? 'Export the timeline as a 16:9 landscape video, cropped centrally to fill the frame'
                : 'Requires at least two images and a clip on every transition'
            }
            onClick={() => void runExport('computer')}
          >
            Export Video
          </button>
          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={!canExport}
            title={
              canExport
                ? 'Assemble the TIMELINE and export it as a 1080×1920 vertical Reel, cropped to fill the frame'
                : 'Requires at least two images and a clip on every transition'
            }
            onClick={() => void runExport('instagram')}
          >
            Export Instagram Reel
          </button>
          {/* THE COMPARE-ASSEMBLY TOOL IS NOT IN THE PRODUCT UI.
              It exports the same clips twice so seam work can be judged
              side by side — a developer's question, not an operator's,
              and a third button next to two export buttons is exactly
              the ambiguity this panel was rebuilt to remove. The service
              and its IPC channel are untouched and still reachable from
              test code. */}
          {missingPairs.length > 0 && feedImages.length >= 2 && (
            <p className="export-missing">
              Missing transition clips: <strong>{missingPairs.join(', ')}</strong>
            </p>
          )}
          {exportNote && <p className="export-note">{exportNote}</p>}
          <p className="field-hint">
            Both export the TIMELINE below the Feed — its order, its trims and whatever you
            removed. Standard is 16:9 and crops centrally to fill the frame without stretching.
            The Reel is 1080×1920 and crops the sides to fill the frame rather than
            padding it. The checkboxes above decide what branding this file carries; Settings
            decide which asset, where, how big and how opaque.
          </p>
        </div>
      </SectionCard>

      <SectionCard
        title="Preview Watermark"
        subtitle="Large protective mark on unpaid preview exports."
      >
        <Toggle
          label="Watermark preview exports"
          checked={wm.enabled}
          onChange={(enabled) => updateWatermark(project.id, { enabled })}
        />
        <Field label="Watermark image">
          <div className="logo-picker">
            {wm.imageSrc ? (
              <img className="logo-picker-preview" src={wm.imageSrc} alt="" />
            ) : (
              <span className="logo-picker-empty">Text fallback</span>
            )}
            <ImagePickerButton
              label={wm.imageSrc ? 'Replace image' : 'Upload image'}
              onPick={(dataUrl, name) =>
                updateWatermark(project.id, { imageSrc: dataUrl, imageName: name })
              }
            />
          </div>
        </Field>
        <Field label="Position">
          <SelectInput
            value={wm.position}
            onChange={(e) =>
              updateWatermark(project.id, { position: e.target.value as WatermarkPosition })
            }
          >
            {WATERMARK_POSITIONS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </SelectInput>
        </Field>
        <SliderRow
          label="Size"
          value={wm.sizePct}
          min={5}
          /* 100 = the full width of the video frame. See Settings. */
          max={100}
          onChange={(sizePct) => updateWatermark(project.id, { sizePct })}
        />
        <SliderRow
          label="Opacity"
          value={wm.opacityPct}
          min={5}
          max={100}
          onChange={(opacityPct) => updateWatermark(project.id, { opacityPct })}
        />
      </SectionCard>

      <SectionCard
        title="I2T Signature"
        subtitle="Small permanent brand mark — stays on the final film."
      >
        <Toggle
          label="Show signature"
          checked={sig.enabled}
          onChange={(enabled) => updateSignature(project.id, { enabled })}
        />
        <div className="field-row">
          <Field label="Brand name">
            <TextInput
              value={sig.brandName}
              onChange={(e) => updateSignature(project.id, { brandName: e.target.value })}
            />
          </Field>
          <Field label="Website URL">
            <TextInput
              value={sig.websiteUrl}
              onChange={(e) => updateSignature(project.id, { websiteUrl: e.target.value })}
            />
          </Field>
        </div>
        <Field label="Brand logo">
          <div className="logo-picker">
            {sig.logoSrc ? (
              <img className="logo-picker-preview" src={sig.logoSrc} alt="" />
            ) : (
              <span className="logo-picker-empty">No logo</span>
            )}
            <ImagePickerButton
              label={sig.logoSrc ? 'Replace logo' : 'Upload logo'}
              onPick={(dataUrl, name) =>
                updateSignature(project.id, { logoSrc: dataUrl, logoName: name })
              }
            />
          </div>
        </Field>
        <Field label="Position">
          <SelectInput
            value={sig.position}
            onChange={(e) =>
              updateSignature(project.id, { position: e.target.value as CornerPosition })
            }
          >
            <option value="bottom-right">Bottom right</option>
            <option value="bottom-left">Bottom left</option>
            <option value="top-right">Top right</option>
            <option value="top-left">Top left</option>
          </SelectInput>
        </Field>
        <SliderRow
          label="Size"
          value={sig.sizePct}
          min={6}
          max={30}
          onChange={(sizePct) => updateSignature(project.id, { sizePct })}
        />
        <SliderRow
          label="Opacity"
          value={sig.opacityPct}
          min={10}
          max={100}
          onChange={(opacityPct) => updateSignature(project.id, { opacityPct })}
        />
      </SectionCard>
    </div>
  )
}
