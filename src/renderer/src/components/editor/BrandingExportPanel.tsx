import { useAppState } from '../../state/AppState'
import type { CornerPosition, Project, WatermarkPosition } from '../../types'
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
 *  2. FrameToFrame signature — small, premium, sits in a corner on everything.
 * The preview box renders both live so the customer-facing result is obvious.
 */
export function BrandingExportPanel({ project }: { project: Project }): React.JSX.Element {
  const { updateWatermark, updateSignature } = useAppState()
  const wm = project.watermark
  const sig = project.signature
  const coverSrc = project.images[0]?.src ?? null

  return (
    <div className="branding-panel">
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
                  <strong>{sig.brandName || 'FrameToFrame'}</strong>
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
            disabled
            title="Video generation and rendering arrive in a later milestone"
          >
            Export Preview with Watermark
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-block"
            disabled
            title="Removes the preview watermark. Available after generation is wired up."
          >
            Export Final
          </button>
          <p className="field-hint">
            Preview export carries the large watermark until the customer has paid. Final export
            removes it — only the FrameToFrame signature remains.
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
        title="FrameToFrame Signature"
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
