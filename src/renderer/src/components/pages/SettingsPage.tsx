import { useAppState } from '../../state/AppState'
import type { AspectRatio, CornerPosition } from '../../types'
import {
  Field,
  ImagePickerButton,
  SectionCard,
  SelectInput,
  SliderRow,
  TextInput,
  Toggle
} from '../common/controls'

export function SettingsPage(): React.JSX.Element {
  const { settings, updateSettings } = useAppState()
  const kling = settings.providers[0]
  const exp = settings.exportDefaults
  const sig = settings.defaultSignature

  const patchKling = (patch: Partial<typeof kling>): void =>
    updateSettings({ providers: [{ ...kling, ...patch }] })

  const patchExport = (patch: Partial<typeof exp>): void =>
    updateSettings({ exportDefaults: { ...exp, ...patch } })

  const patchSignature = (patch: Partial<typeof sig>): void =>
    updateSettings({ defaultSignature: { ...sig, ...patch } })

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">Providers, export defaults and the FrameToFrame brand.</p>
        </div>
      </header>

      <div className="settings-grid">
        <SectionCard
          title="AI Provider"
          subtitle="Credentials are stored locally only. Nothing is sent anywhere in this build — generation is wired up in a later milestone."
        >
          <Field label="Provider">
            <SelectInput value="kling" disabled>
              <option value="kling">Kling (more providers coming)</option>
            </SelectInput>
          </Field>
          <Field label="Kling API Key">
            <TextInput
              type="password"
              placeholder="Not set"
              value={kling.apiKey}
              onChange={(e) => patchKling({ apiKey: e.target.value })}
              autoComplete="off"
            />
          </Field>
          <Field label="Kling API Secret">
            <TextInput
              type="password"
              placeholder="Not set"
              value={kling.apiSecret}
              onChange={(e) => patchKling({ apiSecret: e.target.value })}
              autoComplete="off"
            />
          </Field>
        </SectionCard>

        <SectionCard
          title="FFmpeg"
          subtitle="Local video assembly engine. Detection and bundling ship with the export milestone."
        >
          <div className="ffmpeg-status">
            <span className="status-chip status-chip-queued">Not detected</span>
            <p className="field-hint">
              FrameToFrame will use FFmpeg to stitch generated transitions, render watermarks and
              write the final MP4. No processing happens in this build.
            </p>
          </div>
        </SectionCard>

        <SectionCard title="Export Defaults" subtitle="Applied to every new project.">
          <div className="field-row">
            <Field label="Aspect ratio">
              <SelectInput
                value={exp.aspectRatio}
                onChange={(e) => patchExport({ aspectRatio: e.target.value as AspectRatio })}
              >
                <option value="16:9">16:9 — landscape</option>
                <option value="9:16">9:16 — portrait / social</option>
                <option value="1:1">1:1 — square</option>
                <option value="4:5">4:5 — feed</option>
              </SelectInput>
            </Field>
            <Field label="Resolution">
              <SelectInput
                value={exp.resolution}
                onChange={(e) =>
                  patchExport({ resolution: e.target.value as typeof exp.resolution })
                }
              >
                <option value="720p">720p</option>
                <option value="1080p">1080p</option>
                <option value="4K">4K</option>
              </SelectInput>
            </Field>
          </div>
          <div className="field-row">
            <Field label="Frame rate">
              <SelectInput
                value={String(exp.fps)}
                onChange={(e) => patchExport({ fps: Number(e.target.value) as typeof exp.fps })}
              >
                <option value="24">24 fps</option>
                <option value="25">25 fps</option>
                <option value="30">30 fps</option>
                <option value="60">60 fps</option>
              </SelectInput>
            </Field>
            <Field label="Default transition duration">
              <SelectInput
                value={String(exp.defaultTransitionDurationSec)}
                onChange={(e) =>
                  patchExport({ defaultTransitionDurationSec: Number(e.target.value) })
                }
              >
                <option value="2">2 seconds</option>
                <option value="3">3 seconds</option>
                <option value="4">4 seconds</option>
                <option value="5">5 seconds</option>
                <option value="6">6 seconds</option>
              </SelectInput>
            </Field>
          </div>
        </SectionCard>

        <SectionCard
          title="Default Branding"
          subtitle="The small FrameToFrame signature applied to new projects. Each project can override it."
        >
          <Toggle
            label="Enable signature on new projects"
            checked={sig.enabled}
            onChange={(enabled) => patchSignature({ enabled })}
          />
          <div className="field-row">
            <Field label="Brand name">
              <TextInput
                value={sig.brandName}
                onChange={(e) => patchSignature({ brandName: e.target.value })}
              />
            </Field>
            <Field label="Website URL">
              <TextInput
                value={sig.websiteUrl}
                onChange={(e) => patchSignature({ websiteUrl: e.target.value })}
              />
            </Field>
          </div>
          <div className="field-row">
            <Field label="Default logo">
              <div className="logo-picker">
                {sig.logoSrc ? (
                  <img className="logo-picker-preview" src={sig.logoSrc} alt="" />
                ) : (
                  <span className="logo-picker-empty">No logo</span>
                )}
                <ImagePickerButton
                  label={sig.logoSrc ? 'Replace logo' : 'Upload logo'}
                  onPick={(dataUrl, name) => patchSignature({ logoSrc: dataUrl, logoName: name })}
                />
              </div>
            </Field>
            <Field label="Position">
              <SelectInput
                value={sig.position}
                onChange={(e) => patchSignature({ position: e.target.value as CornerPosition })}
              >
                <option value="bottom-right">Bottom right</option>
                <option value="bottom-left">Bottom left</option>
                <option value="top-right">Top right</option>
                <option value="top-left">Top left</option>
              </SelectInput>
            </Field>
          </div>
          <SliderRow
            label="Size"
            value={sig.sizePct}
            min={6}
            max={30}
            onChange={(sizePct) => patchSignature({ sizePct })}
          />
          <SliderRow
            label="Opacity"
            value={sig.opacityPct}
            min={10}
            max={100}
            onChange={(opacityPct) => patchSignature({ opacityPct })}
          />
        </SectionCard>
      </div>
    </div>
  )
}
