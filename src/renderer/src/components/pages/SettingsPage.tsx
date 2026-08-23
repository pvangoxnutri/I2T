import { useEffect, useState } from 'react'
import { useAppState } from '../../state/AppState'
import type {
  AspectRatio,
  CornerPosition,
  Currency,
  FfmpegStatus,
  ProviderId,
  ProviderMode
} from '../../types'
import { SELECTABLE_PROVIDERS } from '../../types'
import type { ProviderMetadataPayload } from '../../../../preload/index'
import { formatPrice, sanitizePricePerImage } from '../../../../shared/pricing'
import { SEAM_SECONDS, type SeamBlend } from '../../../../shared/seamBlend'
import type { AnalyzerMetadata } from '../../../../shared/analyzerTypes'
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
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus | null>(null)
  const [catalog, setCatalog] = useState<ProviderMetadataPayload[]>([])
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

  // ── The ACTIVE provider — everything below configures this one ─────────
  const activeId: ProviderId =
    settings.activeProviderId ?? settings.providers[0]?.id ?? 'fal'
  const active =
    settings.providers.find((p) => p.id === activeId) ?? settings.providers[0]
  const isFal = active.id === 'fal'
  const providerName = isFal ? 'fal.ai' : 'Kling'
  const hasKey = keyStatus[active.id] === true
  const exp = settings.exportDefaults
  const sig = settings.defaultSignature

  /** Patches ONLY the active provider's entry — the other one is untouched. */
  const patchProvider = (patch: Partial<typeof active>): void =>
    updateSettings({
      providers: settings.providers.map((p) => (p.id === active.id ? { ...p, ...patch } : p))
    })

  const patchExport = (patch: Partial<typeof exp>): void =>
    updateSettings({ exportDefaults: { ...exp, ...patch } })

  const patchSignature = (patch: Partial<typeof sig>): void =>
    updateSettings({ defaultSignature: { ...sig, ...patch } })

  const models = catalog.find((p) => p.id === active.id)?.models ?? []
  const selectedModel = models.find((m) => m.id === active.model)

  const production = settings.production
  const contract = production.klingContract
  const patchProduction = (patch: Partial<typeof production>): void =>
    updateSettings({ production: { ...production, ...patch } })
  const patchContract = (patch: Partial<typeof contract>): void =>
    patchProduction({ klingContract: { ...contract, ...patch } })

  // Each provider has its OWN safety lock — one never unlocks the other.
  const lockOn = isFal ? production.allowLiveFalRequests : production.allowLiveKlingRequests
  const setLock = (on: boolean): void =>
    patchProduction(isFal ? { allowLiveFalRequests: on } : { allowLiveKlingRequests: on })

  // Live becomes selectable ONLY when every requirement is met.
  const liveBlockers: string[] = []
  if (!hasKey) liveBlockers.push('No API key.')
  if (!selectedModel) liveBlockers.push('No capable model selected.')
  else if (!selectedModel.startFrame || !selectedModel.endFrame) {
    liveBlockers.push('Selected model lacks start + end frame support.')
  }
  if (!isFal && !contract.acknowledged) {
    liveBlockers.push('Remaining unconfirmed values not acknowledged.')
  }
  if (!lockOn) liveBlockers.push('Safety lock is off.')
  const liveSelectable = liveBlockers.length === 0
  const unconfirmed = contractStatus.filter((item) => !item.confirmed)
  const falRateOff = falInfo?.rates.find((r) => !r.nativeAudio)?.usdPerSecond

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

      <div className="settings-grid">
        <SectionCard
          title="AI Provider"
          subtitle="Stored locally only. Dry Run validates and builds the request without contacting the provider; Live sends paid requests, one transition at a time."
        >
          <Field
            label="Provider"
            hint="fal.ai is recommended — no large upfront API package required. Each provider keeps its own key, mode and safety lock."
          >
            <SelectInput
              value={activeId}
              onChange={(e) => {
                const id = e.target.value as ProviderId
                setKeyDraft('')
                updateSettings({ activeProviderId: id })
                refreshKeys()
              }}
            >
              {SELECTABLE_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.recommended ? ' — recommended' : ''}
                </option>
              ))}
            </SelectInput>
          </Field>

          <Field
            label={`${providerName} API Key`}
            hint={
              hasKey
                ? 'A key is stored. It is write-only — it is never read back into this window.'
                : isFal
                  ? 'Sent as Authorization: Key <key>. Empty by default.'
                  : 'Sent as Authorization: Bearer <key>. Empty by default.'
            }
          >
            <div className="key-row">
              <TextInput
                type="password"
                placeholder={hasKey ? '•••••••• stored' : 'Not set'}
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                autoComplete="off"
              />
              <button
                type="button"
                className="btn btn-ghost btn-tiny"
                disabled={keyDraft.trim().length === 0}
                onClick={() => {
                  void window.f2f.providers.setApiKey(active.id, keyDraft.trim()).then(() => {
                    setKeyDraft('')
                    refreshKeys()
                  })
                }}
              >
                Save key
              </button>
              {hasKey && (
                <button
                  type="button"
                  className="btn btn-ghost btn-tiny"
                  onClick={() => {
                    void window.f2f.providers.setApiKey(active.id, '').then(refreshKeys)
                  }}
                >
                  Clear
                </button>
              )}
            </div>
          </Field>

          <Field
            label="Mode"
            hint={
              liveSelectable
                ? `Live sends PAID requests to ${providerName} — one transition at a time.`
                : `Live is unavailable: ${liveBlockers.join(' ')}`
            }
          >
            <SelectInput
              value={active.mode}
              onChange={(e) => patchProvider({ mode: e.target.value as ProviderMode })}
            >
              <option value="dry-run">Dry Run — no API request is sent</option>
              <option value="live" disabled={!liveSelectable}>
                {liveSelectable ? 'Live — paid requests enabled' : 'Live — requirements not met'}
              </option>
            </SelectInput>
          </Field>

          <Field
            label="Model"
            hint="Only models that support start + end frame generation are offered."
          >
            <SelectInput
              value={active.model ?? ''}
              onChange={(e) => patchProvider({ model: e.target.value || null })}
            >
              <option value="">Not selected</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </SelectInput>
          </Field>

          <div className="provider-status">
            <span className={`status-chip ${hasKey ? 'status-chip-completed' : 'status-chip-queued'}`}>
              {hasKey ? 'API key configured' : 'Not configured'}
            </span>
            <span className="status-chip status-chip-scheduled">
              {active.mode === 'live' ? 'Live — paid requests' : 'Dry Run — network disabled'}
            </span>
            <span className="status-chip status-chip-queued">
              Capability: Start + End Frame
            </span>
            {isFal && falRateOff !== undefined && (
              <span className="status-chip status-chip-queued">
                ${falRateOff}/s · audio off
              </span>
            )}
          </div>

          {/* ── FREE connection test (fal.ai only) ─────────────────────── */}
          {isFal && (
            <div className="conn-test">
              <div className="conn-test-row">
                <button
                  type="button"
                  className="btn btn-ghost btn-tiny"
                  disabled={connTest !== null && 'running' in connTest && connTest.running}
                  onClick={() => {
                    setConnTest({ running: true })
                    void window.f2f.providers
                      .testConnection()
                      .then((res) => setConnTest({ running: false, ...res }))
                      .catch(() =>
                        setConnTest({
                          running: false,
                          status: 'network',
                          detail: ['The test could not be started.']
                        })
                      )
                  }}
                >
                  {connTest && 'running' in connTest && connTest.running ? 'Testing…' : 'Test connection'}
                </button>
                {connTest && !('running' in connTest && connTest.running) && 'status' in connTest && (
                  <span
                    className={`status-chip ${
                      connTest.status === 'connected'
                        ? 'status-chip-completed'
                        : connTest.status === 'network'
                          ? 'status-chip-scheduled'
                          : 'status-chip-failed'
                    }`}
                  >
                    {connTest.status === 'connected'
                      ? 'Connected'
                      : connTest.status === 'auth-failed'
                        ? 'Authentication failed'
                        : connTest.status === 'permission'
                          ? 'Permission/scope issue'
                          : 'Network error'}
                  </span>
                )}
              </div>
              <p className="field-hint">
                Free — checks the key against rest.fal.ai (storage) and queue.fal.run (queue)
                without running the video model, uploading anything or consuming generation
                credits.
              </p>
              {connTest && 'detail' in connTest && connTest.detail.length > 0 && (
                <ul className="conn-test-detail">
                  {connTest.detail.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {selectedModel && !selectedModel.confirmed && (
            <p className="field-hint provider-warning">
              ⚠ {selectedModel.verificationNote ?? 'Model identifiers are unverified.'} They live in
              one config file and must be confirmed against the official documentation before Live
              mode is enabled.
            </p>
          )}
          {!isFal && active.legacySecret ? (
            <p className="field-hint">
              Legacy Secret — not used for the current Kling API. Retained only so older settings
              hydrate without loss.
            </p>
          ) : null}

          {/* ── The safety lock (per provider) ─────────────────────────── */}
          <div className="safety-lock">
            <Toggle
              label={`Allow live ${providerName} requests`}
              checked={lockOn}
              onChange={(next) => {
                if (!next) {
                  setLock(false)
                  patchProvider({ mode: 'dry-run' })
                  return
                }
                setConfirmLock(active.id === 'fal' ? 'fal' : 'kling')
              }}
            />
            <p className="field-hint">
              <strong>Safety lock — enables paid {providerName} API requests.</strong> While this is
              off, no live request can leave the app regardless of key or mode. Each provider has
              its own lock.
            </p>
          </div>

          {/* ── fal.ai: fully verified contract ─────────────────────────── */}
          {isFal && falInfo && (
            <details className="contract-block">
              <summary>Developer details — fal.ai API contract (all verified)</summary>
              <dl className="contract-locked">
                <div>
                  <dt>Auth</dt>
                  <dd>
                    <code>Authorization: Key &lt;FAL_KEY&gt;</code>
                  </dd>
                </div>
                <div>
                  <dt>Submit</dt>
                  <dd>
                    <code>
                      POST {falInfo.queueHost}/{falInfo.modelId}
                    </code>
                  </dd>
                </div>
                <div>
                  <dt>Frames</dt>
                  <dd>
                    <code>image_url</code> = start · <code>end_image_url</code> = end
                  </dd>
                </div>
                <div>
                  <dt>Statuses</dt>
                  <dd>
                    <code>IN_QUEUE · IN_PROGRESS · COMPLETED</code>
                  </dd>
                </div>
                <div>
                  <dt>Native audio</dt>
                  <dd>
                    {falInfo.nativeAudioDefault
                      ? 'On'
                      : 'Off by default — never enabled automatically'}
                  </dd>
                </div>
              </dl>
              <p className="field-hint">Official fal.ai rates for this endpoint — per output second:</p>
              <ul className="contract-rates">
                {falInfo.rates.map((r) => (
                  <li key={String(r.nativeAudio)}>
                    audio {r.nativeAudio ? 'on' : 'off'} — <strong>${r.usdPerSecond}/s</strong>
                  </li>
                ))}
              </ul>
              <ul className="contract-status">
                {falInfo.items.map((item) => (
                  <li key={item.key} className="is-confirmed">
                    <strong>✓ {item.label}</strong> — {item.note}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {/* ── Kling: remaining unconfirmed values ─────────────────────── */}
          {!isFal && (
            <div className="contract-open">
              <p className="field-hint">
                The base URL, submit endpoint, model id, frame fields, status vocabulary and credit
                pricing are <strong>verified and locked</strong> — nothing to type. Only the values
                below are still unconfirmed.
              </p>
              <ul className="contract-status">
                {unconfirmed.map((item) => (
                  <li key={item.key} className="is-unconfirmed">
                    <strong>? {item.label}</strong> — {item.note}
                  </li>
                ))}
              </ul>
              <Field
                label="Task status path (unverified)"
                hint="Override this if the official documentation uses a different path. {id} is replaced with the task id."
              >
                <TextInput
                  placeholder={contractDefaults?.taskStatusPath ?? ''}
                  value={contract.taskStatusPath ?? ''}
                  onChange={(e) => patchContract({ taskStatusPath: e.target.value })}
                />
              </Field>
              <Toggle
                label="I understand the values above are not confirmed"
                checked={contract.acknowledged}
                onChange={(acknowledged) => patchContract({ acknowledged })}
              />
            </div>
          )}

          {/* ── Kling developer details: the locked contract ────────────── */}
          {!isFal && (
            <details className="contract-block">
              <summary>Developer details — locked API contract</summary>
              <dl className="contract-locked">
                <div>
                  <dt>Auth</dt>
                  <dd>
                    <code>Authorization: Bearer &lt;API_KEY&gt;</code>
                  </dd>
                </div>
                <div>
                  <dt>Submit</dt>
                  <dd>
                    <code>
                      POST {contractLocked?.baseUrl}
                      {contractLocked?.imageToVideoPath}
                    </code>
                  </dd>
                </div>
                <div>
                  <dt>Model</dt>
                  <dd>
                    <code>{contractLocked?.modelId}</code>
                  </dd>
                </div>
                <div>
                  <dt>Frames</dt>
                  <dd>
                    <code>image</code> = start · <code>image_tail</code> = end
                  </dd>
                </div>
                <div>
                  <dt>Statuses</dt>
                  <dd>
                    <code>submitted · processing · succeed · failed</code>
                  </dd>
                </div>
                <div>
                  <dt>Native audio</dt>
                  <dd>{audioDefault ? 'On' : 'Off by default — never enabled automatically'}</dd>
                </div>
              </dl>

              <p className="field-hint">
                Official API rates (Kling 3.0 Omni, no video input) — credits per second:
              </p>
              <ul className="contract-rates">
                {creditRates.map((r) => (
                  <li key={`${r.resolution}-${r.nativeAudio}`}>
                    {r.resolution} · audio {r.nativeAudio ? 'on' : 'off'} —{' '}
                    <strong>{r.creditsPerSecond} credits/s</strong>
                  </li>
                ))}
              </ul>

              <ul className="contract-status">
                {contractStatus.map((item) => (
                  <li key={item.key} className={item.confirmed ? 'is-confirmed' : 'is-unconfirmed'}>
                    <strong>
                      {item.confirmed ? '✓' : '?'} {item.label}
                      {item.locked ? ' (locked)' : ''}
                    </strong>{' '}
                    — {item.note}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </SectionCard>

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

        <SectionCard title="FFmpeg" subtitle="Local video assembly engine.">
          <div className="ffmpeg-status">
            {ffmpeg === null ? (
              <span className="status-chip status-chip-queued">Checking…</span>
            ) : ffmpeg.available ? (
              <span className="status-chip status-chip-completed">
                Detected · v{ffmpeg.version} ({ffmpeg.source === 'bundled' ? 'bundled' : 'system'})
              </span>
            ) : (
              <span className="status-chip status-chip-failed">Not available</span>
            )}
            <p className="field-hint">
              {ffmpeg?.available
                ? 'FFmpeg assembles transition clips, composites branding layers and writes the exported MP4 files — all locally.'
                : 'I2T ships with a bundled FFmpeg; if it cannot be loaded, a system-wide ffmpeg on PATH is used instead.'}
            </p>
          </div>
        </SectionCard>

        {/* ── PROPERTY ANALYZER ──────────────────────────────────────────
            Structure for a future vision provider, deliberately inert.
            Everything external is listed as unavailable and cannot be
            selected — a roadmap the operator can see, with no way to
            accidentally reach a half-finished adapter or store a key for
            something that cannot use it. */}
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
            <Field label="Default transition duration">
              <SelectInput
                value={String(exp.defaultTransitionDurationSec)}
                onChange={(e) =>
                  patchExport({ defaultTransitionDurationSec: Number(e.target.value) })
                }
              >
                {/* Kling 3.0 Omni's real durations, up to its 15 s maximum. */}
                <option value="5">5 seconds</option>
                <option value="10">10 seconds</option>
                <option value="15">15 seconds</option>
              </SelectInput>
            </Field>
          </div>
        </SectionCard>

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

        <SectionCard
          title="Production"
          subtitle="Queue and future AI orchestration. FFmpeg always renders one job at a time."
        >
          <div className="field-row">
            <Field label="Max concurrent AI generations" hint="Prepared for future providers — currently unused.">
              <SelectInput
                value={String(settings.production.maxConcurrentAiGenerations)}
                onChange={(e) =>
                  updateSettings({
                    production: {
                      ...settings.production,
                      maxConcurrentAiGenerations: Number(e.target.value)
                    }
                  })
                }
              >
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <Field
              label="Mock AI cost / second (dev)"
              hint="DEV ONLY — exercises the cost estimator. Empty = no rate, estimates show “—”."
            >
              <TextInput
                type="number"
                min={0}
                step={0.01}
                placeholder="Not configured"
                value={
                  settings.production.mockAiCostPerSecond === null
                    ? ''
                    : String(settings.production.mockAiCostPerSecond)
                }
                onChange={(e) =>
                  updateSettings({
                    production: {
                      ...settings.production,
                      mockAiCostPerSecond:
                        e.target.value.trim() === '' || Number(e.target.value) <= 0
                          ? null
                          : Number(e.target.value)
                    }
                  })
                }
              />
            </Field>
          </div>
          <p className="field-hint">
            No provider pricing is hardcoded. Real per-second rates arrive with the provider
            integration; customer pricing above stays completely separate from production cost.
          </p>
        </SectionCard>

        <SectionCard
          title="Default Branding"
          subtitle="The small I2T signature applied to new projects. Each project can override it."
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
