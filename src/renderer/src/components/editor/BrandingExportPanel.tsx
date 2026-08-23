import { useState } from 'react'
import { useAppState } from '../../state/AppState'
import { transitionKey, type CornerPosition, type Project, type WatermarkPosition } from '../../types'
import { formatPrice, priceSnapshot } from '../../../../shared/pricing'
import { rasterizeSignature, rasterizeWatermark } from '../../utils/rasterizeOverlays'
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
  /** Compare Assembly runs two full FFmpeg passes — disable while busy. */
  const [comparing, setComparing] = useState(false)
  const wm = project.watermark
  const sig = project.signature
  const coverSrc = project.images[0]?.src ?? null

  // Sequence validation: N images need N-1 clips before export is possible.
  const missingPairs: string[] = []
  for (let i = 0; i < project.images.length - 1; i++) {
    const key = transitionKey(project.images[i].id, project.images[i + 1].id)
    if (!project.transitions[key]?.clip) missingPairs.push(`${i + 1} → ${i + 2}`)
  }
  const canExport = project.images.length >= 2 && missingPairs.length === 0 && !starting

  const runExport = async (kind: 'preview' | 'final'): Promise<void> => {
    setStarting(true)
    setExportNote(null)
    try {
      // Overlays are rasterized here, at output resolution, so the export
      // matches the live preview exactly. Final never gets the watermark.
      const [watermarkPng, signaturePng] = await Promise.all([
        kind === 'preview' ? rasterizeWatermark(wm, settings.exportDefaults) : null,
        rasterizeSignature(sig, settings.exportDefaults)
      ])
      const result = await window.f2f.exports.run(project.id, kind, {
        watermarkPng,
        signaturePng
      })
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

        <div className="export-actions">
          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={!canExport}
            title={
              canExport
                ? 'Assemble all transition clips and export with the preview watermark'
                : 'Requires at least two images and a clip on every transition'
            }
            onClick={() => void runExport('preview')}
          >
            Export Preview with Watermark
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-block"
            disabled={!canExport}
            title={
              canExport
                ? 'Assemble and export WITHOUT the customer-protection watermark'
                : 'Requires at least two images and a clip on every transition'
            }
            onClick={() => void runExport('final')}
          >
            Export Final
          </button>
          {/* DEVELOPMENT/EVALUATION TOOL.
              Exports the SAME clips twice so hard cuts and Seamless
              Assembly can be watched back to back — the only honest way
              to judge whether the seam work is worth having. Re-uses
              clips that already exist: no AI generation, no provider
              request, no charge. */}
          <button
            type="button"
            className="btn btn-ghost btn-block btn-dev"
            disabled={!canExport || project.images.length < 3 || comparing}
            title={
              project.images.length < 3
                ? 'Needs at least two clips — a single clip has no seam to compare'
                : 'Development tool: exports these clips twice, hard cuts and seamless, for side-by-side comparison. Generates nothing and costs nothing.'
            }
            onClick={() => {
              setComparing(true)
              setExportNote(null)
              void window.f2f.exports
                .compareAssembly(project.id)
                .then((res) => {
                  if (res.canceled) return
                  setExportNote(
                    res.ok
                      ? `Comparison written — ${res.hardCutsPath?.split(/[\\/]/).pop()} and ${res.seamlessPath?.split(/[\\/]/).pop()}. No AI generation was involved.`
                      : (res.reason ?? 'Comparison failed.')
                  )
                })
                .finally(() => setComparing(false))
            }}
          >
            {comparing ? 'Assembling both versions…' : '⚙ Compare Assembly (dev)'}
          </button>
          {missingPairs.length > 0 && project.images.length >= 2 && (
            <p className="export-missing">
              Missing transition clips: <strong>{missingPairs.join(', ')}</strong>
            </p>
          )}
          {exportNote && <p className="export-note">{exportNote}</p>}
          <p className="field-hint">
            Preview export carries the large watermark until the customer has paid. Final export
            removes it — only the I2T signature remains.
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
          min={15}
          max={90}
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
