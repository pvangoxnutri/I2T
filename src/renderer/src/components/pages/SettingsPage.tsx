import { useEffect, useState } from 'react'
import { makeWatermark, useAppState } from '../../state/AppState'
import { durationChoices } from '../../../../shared/transitionDuration'
import type {
  AspectRatio,
  CornerPosition,
  Currency,
  FfmpegStatus,
  ProviderId,
  ProviderMode,
  WatermarkPosition
} from '../../types'
import { SELECTABLE_PROVIDERS } from '../../types'
import type { FalModelOption, ProviderMetadataPayload } from '../../../../preload/index'
import { formatPrice, sanitizePricePerImage } from '../../../../shared/pricing'
import { SEAM_SECONDS, type SeamBlend } from '../../../../shared/seamBlend'
import type { AnalyzerMetadata } from '../../../../shared/analyzerTypes'
import {
  Field,
  ImagePickerButton,
  ApiKeyRow,
  SectionCard,
  SelectInput,
  SliderRow,
  TextInput,
  Toggle
} from '../common/controls'

type SettingsTab = 'general' | 'ai' | 'video' | 'branding'

export function SettingsPage(): React.JSX.Element {
  const { settings, updateSettings } = useAppState()
  const [tab, setTab] = useState<SettingsTab>('general')
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus | null>(null)
  const [catalog, setCatalog] = useState<ProviderMetadataPayload[]>([])
  /** The canonical model list — the same one the confirmation dialog uses. */
  const [videoModels, setVideoModels] = useState<FalModelOption[]>([])
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean>>({})
  const [keyDraft, setKeyDraft] = useState('')
  /** Which provider's safety-lock confirmation dialog is open. */
  const [confirmLock, setConfirmLock] = useState<'fal' | 'kling' | null>(null)
  const [contractStatus, setContractStatus] = useState<
    { key: string; label: string; confirmed: boolean; locked: boolean; note: string }[]
  >([])
  const [contractLocked, setContractLocked] = useState<{
    baseUrl: string
    imageToVideoPath: string
    modelId: string
  } | null>(null)
  const [contractDefaults, setContractDefaults] = useState<{ taskStatusPath: string } | null>(null)
  const [creditRates, setCreditRates] = useState<
    { modelId: string; resolution: string; nativeAudio: boolean; creditsPerSecond: number }[]
  >([])
  const [audioDefault, setAudioDefault] = useState(false)
  const [falInfo, setFalInfo] = useState<{
    items: { key: string; label: string; confirmed: boolean; note: string }[]
    modelId: string
    queueHost: string
    rates: { modelId: string; nativeAudio: boolean; usdPerSecond: number }[]
    nativeAudioDefault: boolean
  } | null>(null)
  /** Analyzer roadmap — implemented and planned, all shown honestly. */
  const [analyzers, setAnalyzers] = useState<AnalyzerMetadata[]>([])
  const [geminiModels, setGeminiModels] = useState<{ id: string; label: string; note: string }[]>([])
  /** Whether a key exists — never the key itself. */
  const [analyzerKey, setAnalyzerKey] = useState(false)
  const [analyzerKeyDraft, setAnalyzerKeyDraft] = useState('')
  const [connTest, setConnTest] = useState<
    | { running: true }
    | { running: false; status: 'connected' | 'auth-failed' | 'permission' | 'network'; detail: string[] }
    | null
  >(null)

  const refreshKeys = (): void => {
    for (const id of ['fal', 'kling']) {
      void window.f2f.providers.hasApiKey(id).then((has) => {
        setKeyStatus((prev) => (prev[id] === has ? prev : { ...prev, [id]: has }))
      })
    }
  }

  useEffect(() => {
    let cancelled = false
    void window.f2f.ffmpeg.status().then((status) => {
      if (!cancelled) setFfmpeg(status)
    })
    void window.f2f.generation.models().then((m) => {
      if (!cancelled) setVideoModels(m)
    })
    void window.f2f.providers.catalog().then((c) => {
      if (!cancelled) setCatalog(c)
    })
    refreshKeys()
    void window.f2f.providers.contractStatus().then((s) => {
      if (!cancelled) {
        setContractStatus(s.items)
        setContractLocked(s.locked)
        setContractDefaults(s.defaults)
        setCreditRates(s.rates)
        setAudioDefault(s.nativeAudioDefault)
      }
    })
    void window.f2f.providers.falStatus().then((s) => {
      if (!cancelled) setFalInfo(s)
    })
    void window.f2f.projects.analysis.analyzers().then((a) => {
      if (!cancelled) setAnalyzers(a)
    })
    void window.f2f.projects.analyzerConfig.models().then((m) => {
      if (!cancelled) setGeminiModels(m)
    })
    void window.f2f.projects.analyzerConfig.hasApiKey().then((has) => {
      if (!cancelled) setAnalyzerKey(has)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // ── NO ACTIVE-PROVIDER DERIVATION ───────────────────────────────────
  //
  // Video is fal.ai and analysis is Gemini; live mode and the safety
  // locks are derived in main from whether a key is stored. What stood
  // here — the active provider, its model, the per-provider lock and the
  // list of reasons Live was unavailable — configured a card that no
  // longer exists, and crashed outright on a settings row with no
  // providers array.
  const [brandingError, setBrandingError] = useState<string | null>(null)
  const exp = settings.exportDefaults
  const sig = settings.defaultSignature
  const falModel = catalog.find((p) => p.id === 'fal')
  /** Durations the model publishes — never a hardcoded list. */
  const defaultDurationChoices = durationChoices(
    falModel?.models.find((m) => m.id === falModel?.models[0]?.id)?.durationsSec
  )
  const activeProviderLabel = 'fal.ai'

  const patchExport = (patch: Partial<typeof exp>): void =>
    updateSettings({ exportDefaults: { ...exp, ...patch } })

  const patchSignature = (patch: Partial<typeof sig>): void =>
    updateSettings({ defaultSignature: { ...sig, ...patch } })

  /**
   * THE LARGE VIDEO WATERMARK, AS A DEFAULT.
   *
   * Absent on every settings row written before this section existed, so
   * it hydrates from the shared default rather than reading as "off" —
   * §12's no-destructive-reset rule, honoured by falling back rather
   * than by writing anything on load.
   */
  const wm = settings.defaultWatermark ?? makeWatermark()
  const patchWatermark = (patch: Partial<typeof wm>): void =>
    updateSettings({ defaultWatermark: { ...wm, ...patch } })

  /**
   * Store a picked image as a managed file and keep the short url.
   *
   * The old asset is removed in the same call, so replacing a logo does
   * not leave the previous one on disk forever.
   */
  const pickBrandingAsset = async (
    dataUrl: string,
    name: string,
    replacing: string | null,
    apply: (url: string, name: string) => void
  ): Promise<void> => {
    const res = await window.f2f.projects.branding.save(dataUrl, name, replacing)
    if (res.ok) apply(res.url, name)
    else setBrandingError(res.reason)
  }

  const production = settings.production
  const patchProduction = (patch: Partial<typeof production>): void =>
    updateSettings({ production: { ...production, ...patch } })

  const pricing = settings.pricing
  const patchPricing = (patch: Partial<typeof pricing>): void =>
    updateSettings({ pricing: { ...pricing, ...patch } })

  // Analyzer config. Absent on settings rows written before the analyzer
  // existed, which must hydrate to manual + Dry Run + no key.
  const analyzerCfg = settings.analyzer ?? {
    analyzerId: 'manual',
    model: 'gemini-2.5-flash',
    apiKey: '',
    mode: 'dry-run' as const
  }
  const patchAnalyzer = (patch: Partial<typeof analyzerCfg>): void =>
    // The key is never round-tripped through the renderer: it is written
    // by its own write-only channel and blanked here.
    updateSettings({ analyzer: { ...analyzerCfg, ...patch, apiKey: '' } })

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">Providers, export defaults and the I2T brand.</p>
        </div>
      </header>

      <nav className="settings-tabs" role="tablist">
        {(
          [
            ['general', 'General'],
            ['ai', 'AI'],
            ['video', 'Video'],
            ['branding', 'Branding']
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`settings-tab${tab === key ? ' is-active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      {/* ── ONE TAB, ONE SUBJECT ───────────────────────────────────────
          The tab bar used to sit above a grid that rendered every card
          regardless of which tab was selected, so choosing a tab changed
          nothing and the page stayed a single long scroll. Each card now
          renders only under the tab it belongs to.

          The paid-request confirmation below is deliberately NOT gated:
          a dialog that only exists while one tab is mounted is how a
          confirmation becomes unreachable. */}
      <div className="settings-grid">
        {tab === 'video' && (
        <SectionCard
          title="Generation Defaults"
          subtitle="Applied to transitions that have not been given their own length."
        >
          {/* ── DEFAULT LENGTH ─────────────────────────────────────────
              A default, not a cap: any transition can be set to its own
              length in the inspector, and that choice always wins. The
              values offered are the ones the SELECTED model publishes —
              this list used to be a hardcoded 5/10/15 taken from a model
              this build no longer points at, which put most of the
              configured endpoint's range out of reach. */}
          <Field label="Default transition duration">
            <SelectInput
              value={String(exp.defaultTransitionDurationSec)}
              onChange={(e) =>
                patchExport({ defaultTransitionDurationSec: Number(e.target.value) })
              }
            >
              {defaultDurationChoices.map((s) => (
                <option key={s} value={s}>
                  {s} seconds
                </option>
              ))}
            </SelectInput>
          </Field>
          <p className="field-hint">
            {defaultDurationChoices.length > 0
              ? `${activeProviderLabel} offers ${defaultDurationChoices[0]}–${
                  defaultDurationChoices[defaultDurationChoices.length - 1]
                } seconds. A per-transition duration overrides this.`
              : 'The selected model publishes no duration options.'}
          </p>
        </SectionCard>
        )}

        {/* ── API KEYS ───────────────────────────────────────────────
            I2T generates video with fal.ai and analyses properties with
            Gemini. That is what the product is, not a choice to make, so
            this is the whole of provider configuration: two keys.

            What used to be here — a provider dropdown, a Dry Run / Live
            mode, a per-provider safety lock and a contract-status table —
            described one fact four times, and any one of them being
            wrong silently disabled the app. Live is now derived from the
            key, and spending is confirmed per generation with the cost
            shown, which is where that decision belongs. */}
        {/* ── VIDEO GENERATION ─────────────────────────────────────────
            Where a new generation STARTS. The confirmation dialog can
            change the model for one run without touching this, because
            comparing two models on a transition must not require
            editing a preference. */}
        {tab === 'ai' && (
        <SectionCard
          title="Video generation"
          subtitle="The model new generations open with. You can change it for a single run in the confirmation."
        >
          <Field label="Default model">
            <SelectInput
              value={settings.providers.find((p) => p.id === 'fal')?.model ?? ''}
              onChange={(e) =>
                updateSettings({
                  providers: settings.providers.map((p) =>
                    p.id === 'fal' ? { ...p, model: e.target.value } : p
                  )
                })
              }
            >
              {videoModels.map((m) => (
                <option key={m.id} value={m.id} disabled={!m.confirmed}>
                  {m.displayName}{m.confirmed ? '' : ' — not verified yet'}
                </option>
              ))}
            </SelectInput>
          </Field>
        </SectionCard>
        )}

        {tab === 'ai' && (
        <SectionCard
          title="API Keys"
          subtitle="Stored locally on this machine and never shown again after saving."
        >
          <ApiKeyRow
            label="Gemini"
            hint="Reads the photographs to work out how the rooms connect, and writes the transition prompts."
            connected={analyzerKey}
            draft={analyzerKeyDraft}
            onDraft={setAnalyzerKeyDraft}
            onSave={() =>
              void window.f2f.projects.analyzerConfig
                .setApiKey(analyzerKeyDraft.trim())
                .then(() => {
                  setAnalyzerKeyDraft('')
                  return window.f2f.projects.analyzerConfig.hasApiKey()
                })
                .then(setAnalyzerKey)
            }
            onClear={() =>
              void window.f2f.projects.analyzerConfig
                .setApiKey('')
                .then(() => window.f2f.projects.analyzerConfig.hasApiKey())
                .then(setAnalyzerKey)
            }
          />
          <ApiKeyRow
            label="fal.ai"
            hint="Generates the transition video between each pair of photographs."
            connected={keyStatus['fal'] === true}
            draft={keyDraft}
            onDraft={setKeyDraft}
            onSave={() =>
              void window.f2f.providers.setApiKey('fal', keyDraft.trim()).then(() => {
                setKeyDraft('')
                refreshKeys()
              })
            }
            onClear={() =>
              void window.f2f.providers.setApiKey('fal', '').then(refreshKeys)
            }
          />
        </SectionCard>
        )}


        {confirmLock && (
          <div className="dialog-backdrop" onClick={() => setConfirmLock(null)}>
            <div className="dialog-card" onClick={(e) => e.stopPropagation()}>
              <h3 className="dialog-title">
                Enable paid {confirmLock === 'fal' ? 'fal.ai' : 'Kling'} requests?
              </h3>
              <p className="dialog-body">
                This unlocks Live mode. With Live selected, generating a transition sends a{' '}
                <strong>paid request</strong> to {confirmLock === 'fal' ? 'fal.ai' : 'Kling'} and
                bills your account. Generation stays limited to one transition at a time.
              </p>
              <div className="dialog-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-tiny"
                  onClick={() => setConfirmLock(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-tiny"
                  onClick={() => {
                    patchProduction(
                      confirmLock === 'fal'
                        ? { allowLiveFalRequests: true }
                        : { allowLiveKlingRequests: true }
                    )
                    setConfirmLock(null)
                  }}
                >
                  Enable paid requests
                </button>
              </div>
            </div>
          </div>
        )}


        {/* ── PROPERTY ANALYZER ──────────────────────────────────────────
            Structure for a future vision provider, deliberately inert.
            Everything external is listed as unavailable and cannot be
            selected — a roadmap the operator can see, with no way to
            accidentally reach a half-finished adapter or store a key for
            something that cannot use it. */}
        {tab === 'ai' && (
        <SectionCard
          title="Property Analyzer"
          subtitle="Whole-property analysis reads ALL photos together so transitions can be planned from real context instead of two frames. Only local analyzers exist in this build."
        >
          <Field
            label="Analyzer"
            hint="Manual and Mock run locally and cost nothing. Gemini analyses every project photo in ONE request and is the only paid analyzer."
          >
            <SelectInput
              value={analyzerCfg.analyzerId}
              onChange={(e) => patchAnalyzer({ analyzerId: e.target.value })}
            >
              {analyzers
                .filter((a) => a.available)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName}
                    {a.capabilities.incursCost ? ' — paid' : ' — local, free'}
                  </option>
                ))}
            </SelectInput>
          </Field>

          {analyzerCfg.analyzerId === 'gemini' && (
            <>
              <Field
                label="Gemini model"
                hint="Isolated in configuration so changing model is a settings change, never a code change."
              >
                <SelectInput
                  value={analyzerCfg.model}
                  onChange={(e) => patchAnalyzer({ model: e.target.value })}
                >
                  {/* ── A RETIRED STORED MODEL STAYS VISIBLE ──────────────
                      A settings row written before a model was retired
                      still holds the old id. Dropping it from the list
                      would make the select silently display the first
                      option while the stored value stayed wrong — the
                      operator would read a model id that was not the one
                      about to be used. So it is shown, and labelled. */}
                  {!geminiModels.some((m) => m.id === analyzerCfg.model) && (
                    <option value={analyzerCfg.model}>
                      {analyzerCfg.model} — unavailable, choose a current model
                    </option>
                  )}
                  {geminiModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} — {m.note}
                    </option>
                  ))}
                </SelectInput>
              </Field>
              {!geminiModels.some((m) => m.id === analyzerCfg.model) && (
                <p className="field-hint provider-warning">
                  The configured model <strong>{analyzerCfg.model}</strong> has been retired by the
                  provider and will return a 404. Pick a current one above before analysing.
                </p>
              )}

              <Field
                label="Gemini API key"
                hint={
                  analyzerKey
                    ? 'A key is stored. It is write-only — it is never read back into this window, logged, or included in any debug output.'
                    : 'Sent as the x-goog-api-key header, never in a URL. Stored locally only.'
                }
              >
                <div className="key-row">
                  <TextInput
                    type="password"
                    value={analyzerKeyDraft}
                    placeholder={analyzerKey ? '•••••••• stored' : 'Paste the Gemini API key'}
                    onChange={(e) => setAnalyzerKeyDraft(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost btn-tiny"
                    disabled={!analyzerKeyDraft.trim()}
                    onClick={() =>
                      void window.f2f.projects.analyzerConfig
                        .setApiKey(analyzerKeyDraft)
                        .then(() => {
                          setAnalyzerKeyDraft('')
                          void window.f2f.projects.analyzerConfig
                            .hasApiKey()
                            .then(setAnalyzerKey)
                        })
                    }
                  >
                    Save key
                  </button>
                </div>
              </Field>

              <Field
                label="Mode"
                hint="Dry Run validates every image and builds the exact request without sending it — zero network calls, zero cost."
              >
                <SelectInput
                  value={analyzerCfg.mode}
                  onChange={(e) =>
                    patchAnalyzer({ mode: e.target.value as typeof analyzerCfg.mode })
                  }
                >
                  <option value="dry-run">Dry Run — nothing is sent</option>
                  <option value="live">Live — sends a paid request</option>
                </SelectInput>
              </Field>

              {/* A LOCK OF ITS OWN. Unlocking video generation must never
                  unlock a vision provider, so this is separate from both
                  fal and Kling and defaults OFF. */}
              <Toggle
                label="Allow live Gemini analysis"
                checked={production.allowLiveGeminiAnalysis === true}
                onChange={(v) => patchProduction({ allowLiveGeminiAnalysis: v })}
              />
              <p className="field-hint">
                Off by default. While this is off, no live analysis can run regardless of key or
                mode — the lock is checked in main, not merely in this window.
              </p>
              {/* fal.ai publishes an auth endpoint that costs nothing, so it
                  gets a real Test Connection button. Gemini does not publish
                  one we can point to and promise is never billed, and a
                  button that quietly sends a tiny paid request would be
                  worse than no button. So: no button, and an honest note. */}
              <p className="field-hint">
                There is no free connection test for Gemini — no endpoint is published that we can
                guarantee is never billed. Dry Run is the configuration test: it validates every
                image and builds the exact request without sending it.
              </p>
            </>
          )}
          <ul className="analyzer-roadmap">
            {analyzers.map((a) => (
              <li key={a.id} className={a.available ? 'is-available' : 'is-planned'}>
                <span className="analyzer-roadmap-name">{a.displayName}</span>
                <span className="analyzer-roadmap-provider">{a.provider}</span>
                <span className="analyzer-roadmap-state">
                  {a.available
                    ? a.capabilities.incursCost
                      ? 'available · paid'
                      : 'available · free'
                    : 'not implemented'}
                </span>
              </li>
            ))}
          </ul>
          <p className="field-hint">
            Property-analysis spend is tracked as its own category and is never added to video
            generation. It reads $0.00 today because manual and mock analysis are free.
          </p>
        </SectionCard>
        )}

        {tab === 'branding' && (
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
            <Field
              label="Seamless Assembly"
              hint="Adjacent clips share a key frame — Image 1→2 ends where Image 2→3 begins. A very short blend hides the encoder cut and any small exposure or framing drift, so the finished tour reads as one continuous camera move. This is deliberately not a crossfade: anything long enough to notice looks like a slideshow."
            >
              <SelectInput
                value={exp.seamBlend ?? 'subtle'}
                onChange={(e) => patchExport({ seamBlend: e.target.value as SeamBlend })}
              >
                <option value="off">Off — hard cuts</option>
                <option value="subtle">Subtle — {SEAM_SECONDS.subtle.toFixed(2)}s (default)</option>
                <option value="smooth">Smooth — {SEAM_SECONDS.smooth.toFixed(2)}s</option>
              </SelectInput>
            </Field>
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
          </div>
        </SectionCard>
        )}

        {/* Kept from the removed Advanced tab: if FFmpeg cannot load,
            exporting fails, and that is worth seeing without hunting
            through a technical section for it. Read-only. */}
        {tab === 'general' && (
        <SectionCard title="Video engine" subtitle="Assembles and exports your videos locally.">
          {ffmpeg === null ? (
            <span className="status-chip status-chip-queued">Checking…</span>
          ) : ffmpeg.available ? (
            <span className="status-chip status-chip-completed">Ready</span>
          ) : (
            <span className="status-chip status-chip-failed">Not available — export will fail</span>
          )}
        </SectionCard>
        )}

        {tab === 'general' && (
        <SectionCard
          title="Pricing"
          subtitle="What the CUSTOMER pays — per project image. Unrelated to future AI generation costs."
        >
          <div className="field-row">
            <Field label="Price per image">
              <TextInput
                type="number"
                min={0}
                step={0.01}
                value={String(pricing.pricePerImage)}
                onChange={(e) =>
                  patchPricing({ pricePerImage: sanitizePricePerImage(e.target.value) })
                }
              />
            </Field>
            <Field label="Currency">
              <SelectInput
                value={pricing.currency}
                onChange={(e) => patchPricing({ currency: e.target.value as Currency })}
              >
                <option value="SEK">SEK — Swedish krona</option>
                <option value="EUR">EUR — Euro</option>
                <option value="USD">USD — US dollar</option>
              </SelectInput>
            </Field>
          </div>
          <p className="field-hint">
            Example: a 12-image project ={' '}
            {formatPrice(sanitizePricePerImage(pricing.pricePerImage) * 12, pricing.currency)}.
            Queued jobs snapshot the price at creation — changing this never rewrites historical
            work.
          </p>
        </SectionCard>
        )}


        {/* ── A. VIDEO WATERMARK ──────────────────────────────────────
            THE GAP THIS FILLS. Settings → Branding configured only the
            corner stamp: brand name, website, logo, position, size,
            opacity. The large watermark over the video had no controls
            here at all, so the only way to change it was per project, in
            the Export & Branding drawer — which is why it looked
            unchangeable. Its data model always supported an image; the
            settings screen simply never offered one. */}
        {tab === 'branding' && (
        <SectionCard
          title="Video Watermark"
          subtitle="The large protective mark over the whole video on unpaid preview exports."
        >
          <Toggle
            label="Enable watermark on new projects"
            checked={wm.enabled}
            onChange={(enabled) => patchWatermark({ enabled })}
          />
          <div className="field-row">
            <Field label="Watermark image">
              <div className="logo-picker">
                {wm.imageSrc ? (
                  <img className="logo-picker-preview" src={wm.imageSrc} alt="" />
                ) : (
                  <span className="logo-picker-empty">No image selected</span>
                )}
                <ImagePickerButton
                  label={wm.imageSrc ? 'Choose image' : 'Choose image'}
                  onPick={(dataUrl, name) =>
                    void pickBrandingAsset(dataUrl, name, wm.imageSrc, (url, fileName) =>
                      patchWatermark({ imageSrc: url, imageName: fileName })
                    )
                  }
                />
                {wm.imageSrc && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-tiny"
                    onClick={() => {
                      void window.f2f.projects.branding.remove(wm.imageSrc)
                      patchWatermark({ imageSrc: null, imageName: null })
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
            </Field>
            <Field label="Position">
              <SelectInput
                value={wm.position}
                onChange={(e) => patchWatermark({ position: e.target.value as WatermarkPosition })}
              >
                <option value="center">Center</option>
                <option value="bottom-right">Bottom right</option>
                <option value="bottom-left">Bottom left</option>
                <option value="top-right">Top right</option>
                <option value="top-left">Top left</option>
              </SelectInput>
            </Field>
          </div>
          <SliderRow
            label="Size"
            value={wm.sizePct}
            min={5}
            /* 100 = the full width of the video frame. The cap was 90,
               so the largest mark the product allowed could never be
               asked for. Corner Stamp keeps its own smaller scale. */
            max={100}
            onChange={(sizePct) => patchWatermark({ sizePct })}
          />
          <SliderRow
            label="Opacity"
            value={wm.opacityPct}
            min={5}
            max={100}
            onChange={(opacityPct) => patchWatermark({ opacityPct })}
          />
          {brandingError && <p className="field-hint field-hint-warn">{brandingError}</p>}
        </SectionCard>
        )}

        {/* ── B. CORNER STAMP ─────────────────────────────────────────
            Unchanged behaviour, now named for what it is so the two are
            never confused for one "branding image". */}
        {tab === 'branding' && (
        <SectionCard
          title="Corner Stamp"
          subtitle="The small permanent I2T signature — stays on the final film."
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
        )}
      </div>
    </div>
  )
}
