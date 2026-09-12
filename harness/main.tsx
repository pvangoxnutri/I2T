/**
 * COMPONENT HARNESS — real components, a real DOM, real clicks.
 *
 * Markup-only verification twice passed UI that did not work when
 * clicked. This mounts the SHIPPING components in Electron's own
 * renderer, records every bridge call, and dispatches genuine events.
 *
 * Which component to mount is chosen by `?c=` so one bundle covers
 * every case the stabilisation pass has to prove.
 */
import { createRoot } from 'react-dom/client'
// THE APP'S OWN STYLESHEET. Without it these components render unstyled,
// so anything that depends on real layout — widths, overflow, scrolling —
// cannot be tested here at all.
import '/src/renderer/src/styles/global.css'
import { TransitionAnalysisReview } from '/src/renderer/src/components/editor/TransitionAnalysisReview'
import { TransitionInspector } from '/src/renderer/src/components/editor/TransitionInspector'
import { LeftPanel } from '/src/renderer/src/components/editor/LeftPanel'
import { ProjectCatalogue } from '/src/renderer/src/components/editor/ProjectCatalogue'
import { ProjectEditorPage } from '/src/renderer/src/components/pages/ProjectEditorPage'
import { SettingsPage } from '/src/renderer/src/components/pages/SettingsPage'
import { QueuePage } from '/src/renderer/src/components/pages/QueuePage'
import { AppStateProvider } from '/src/renderer/src/state/AppState'

const calls: { fn: string; args: unknown[] }[] = []
;(globalThis as Record<string, unknown>).__calls = calls

const rec =
  (fn: string, result: unknown = { ok: true }) =>
  (...args: unknown[]) => {
    calls.push({ fn, args })
    return Promise.resolve(result)
  }

/**
 * A real (tiny) image so timeline cells have genuine min-content width.
 * With an empty src the flex children shrink to nothing and the track
 * never overflows, which would make a scroll test unable to fail.
 */
const THUMB =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const FROM = 'img-a'
const TO = 'img-b'

/**
 * Enough photographs that the timeline actually overflows.
 *
 * The scroll-position test is meaningless on a track that fits: it can
 * only prove scrollLeft stayed 0. FROM and TO stay first so the pair
 * every other case uses is still transition 1.
 */
const EXTRA_IMAGES = Array.from({ length: 24 }, (_, i) => ({
  id: 'img-x' + i,
  fileName: 'extra-' + i + '.jpg',
  storedName: 'x' + i + '.jpg',
  src: THUMB
}))

const project = {
  id: 'p1',
  name: 'Harness',
  createdAt: 0,
  updatedAt: 0,
  images: [
    { id: FROM, fileName: '0015-15.jpg', storedName: 'a.jpg', src: THUMB },
    { id: TO, fileName: '0014-14.jpg', storedName: 'b.jpg', src: THUMB },
    { id: 'img-c', fileName: '0031-31.jpg', storedName: 'c.jpg', src: THUMB },
    ...EXTRA_IMAGES
  ],
  feedSequence: [FROM, TO, ...EXTRA_IMAGES.map((i) => i.id)],
  transitions: {
    [`${FROM}->${TO}`]: {
      // Wording a human wrote, plus a held suggestion — the exact state
      // the manual-protection UI exists for.
      prompt: 'MY OWN WORDING — hand written',
      promptProvenance: {
        basePrompt: 'base',
        motionInstruction: null,
        effectivePrompt: 'MY OWN WORDING — hand written',
        basis: 'same-room',
        rationale: '',
        manuallyEdited: true,
        plannedAt: 1,
        analysisUpdatedAt: null
      },
      promptSuggestion: {
        text: 'SUGGESTED: reposition smoothly between the two viewpoints.',
        createdAt: 2,
        evidenceSource: 'individual-analysis',
        evidenceFingerprint: 'pair:5000'
      },
      durationSec: 5,
      // THE REPORTED STATE: the generation succeeded, the file is on
      // disk, quality held it back — and the row still says failed.
      status: 'failed',
      clip: null,
      operatorContext: {
        text: 'Add a donkey to the mirror',
        createdAt: 1,
        source: 'operator',
        status: 'needs-review'
      }
    }
  },
  watermark: { enabled: false, imageSrc: null, imageName: null, position: 'center', sizePct: 45, opacityPct: 35 },
  signature: { enabled: false, logoSrc: null, logoName: null, brandName: '', websiteUrl: '', position: 'bottom-right', sizePct: 12, opacityPct: 55 },
  status: 'draft',
  workflow: { previewSentAt: null, paidAt: null, finalSentAt: null }
} as never

const draft = {
  feedImageIds: [FROM, TO],
  createdAt: 0,
  status: 'draft',
  pairs: [
    {
      fromId: FROM,
      toId: TO,
      recommendation: 'cut',
      decision: 'needs-context',
      missingContext: [
        { type: 'reflection-content', question: 'What should the mirror reflect as the camera moves?' }
      ],
      safety: { fromImageId: FROM, toImageId: TO, level: 'needs-context', reasoning: 'A large mirror is visible.' }
    }
  ]
} as never

/** The mocked pair-analysis result, returned through the real UI path. */
const pairRecord = {
  projectId: 'p1',
  pairKey: `${FROM}->${TO}`,
  analyzedAt: Date.now(),
  analyzer: 'gemini',
  model: 'test-model',
  parentAnalysisUpdatedAt: 1,
  feedFingerprint: `${FROM}|${TO}`,
  libraryFingerprint: `${FROM}|${TO}|img-c`,
  evidence: {
    relation: 'same-room',
    roomLabel: 'Bathroom',
    sharedLandmarks: ['vanity'],
    openings: [],
    reflectiveSurfaces: [
      { type: 'wall mirror', dominant: true, expectedVisibleContent: ['white doorway', 'beige wall tile'] }
    ],
    geometryConflicts: []
  },
  decision: 'ai',
  missingContext: [],
  motionInstruction: 'reposition smoothly between the two viewpoints',
  promptCandidate: null,
  reason: 'Both frames are in Bathroom and overlap, sharing vanity.',
  state: 'draft'
}

;(window as unknown as { f2f: unknown }).f2f = {
  platform: 'win32',
  projects: {
    list: () => Promise.resolve([project]),
    save: rec('projects.save'),
    onUpdated: () => () => {},
    transitions: { setOperatorContext: rec('setOperatorContext'), clearClip: rec('clearClip') },
    pairAnalysis: {
      read: () => Promise.resolve(null),
      analyze: rec('pairAnalysis.analyze', { ok: true, record: pairRecord }),
      accept: rec('pairAnalysis.accept', { ok: true, record: { ...pairRecord, state: 'accepted' } }),
      // The single approval call. What the click test checks is that the
      // buttons reach THIS and not the old three-write sequence — the
      // sequence that left an approved pair unable to generate.
      approve: rec('pairAnalysis.approve', {
        ok: true,
        evidenceSource: 'operator',
        evidenceFingerprint: 'operator:12345',
        manualPromptPreserved: false
      }),
      replacePrompt: rec('pairAnalysis.replacePrompt', { ok: true })
    },
    catalogue: {
      // A REAL served clip url, injected by the driver so the component
      // under test plays an actual mp4 through the real protocol.
      getAll: () =>
        Promise.resolve(
          JSON.parse(sessionStorage.getItem('catalogueRows') ?? '[]') as never[]
        ),
      attach: rec('catalogue.attach'),
      attach: rec('catalogue.attach'),
      approveQuality: rec('catalogue.approveQuality')
    },
    transitionAnalysis: {
      read: () => Promise.resolve(draft),
      markOutdated: rec('transitionAnalysis.markOutdated'),
      save: rec('transitionAnalysis.save')
    },
    analysis: {
      effective: () => Promise.resolve(null),
      transitionModes: () => Promise.resolve([]),
      /**
       * The single-pair adopt. The DOM test clicks the real button and
       * then flips the mocked persisted state the way main would, so the
       * badge is re-rendered from the SAME shape production returns.
       */
      useAnalysisPrompt: rec('analysis.useAnalysisPrompt', {
        ok: true,
        replacedManualPrompt: true
      }),
      analyzers: () => Promise.resolve([]),
      confirmation: rec('analysis.confirmation', {
        ok: true,
        blockers: [],
        analyzer: 'Gemini',
        model: 'gemini-test',
        imageCount: 3,
        paidLive: true,
        estimatedCostLabel: '~$0.11',
        estimatedCostBasis: 'per request',
        warning: '',
        token: 'stub-token'
      })
    },
    feed: {
      acceptAnalysis: rec('feed.acceptAnalysis', {
        ok: true,
        promptsUpdated: 3,
        manualPromptsPreserved: 1,
        stillNeedContext: 0,
        operatorDecisionsPreserved: 2
      })
    },
    // The image inspector's surface — without these, clicking a photo
    // in the timeline throws and unmounts the whole editor, which is a
    // harness gap rather than an app fault.
    overrides: {
      facts: () =>
        Promise.resolve({
          room: { value: null, source: 'analysis' },
          orientation: { value: 'into-room', source: 'analysis' },
          openings: { value: [], source: 'analysis' },
          landmarks: { value: [], source: 'analysis' },
          overlapWith: [],
          roomConfidence: null,
          analyzed: false,
          overridden: false
        }),
      set: rec('overrides.set'),
      clear: rec('overrides.clear')
    },
    review: { list: () => Promise.resolve([]) },
    analyzerConfig: {
      models: () => Promise.resolve([]),
      hasApiKey: () =>
        Promise.resolve(JSON.parse(sessionStorage.getItem('keys') ?? '{}')['gemini'] === true),
      setApiKey: (key: string) => {
        const keys = JSON.parse(sessionStorage.getItem('keys') ?? '{}')
        keys['gemini'] = key.trim().length > 0
        sessionStorage.setItem('keys', JSON.stringify(keys))
        calls.push({ fn: 'analyzerConfig.setApiKey', args: [key] })
        return Promise.resolve(true)
      }
    },
    cost: {
      entries: () => Promise.resolve([]),
      summary: () =>
        Promise.resolve({
          spent: 0,
          remainingEstimate: 0,
          projectedTotal: 0,
          currency: 'USD',
          entryCount: 0,
          activePairKeys: []
        })
    }
  },
  clips: { info: () => Promise.resolve({ exists: false, bytes: 0 }), showInFolder: rec('clips.showInFolder') },
  exports: {
    previewState: () => Promise.resolve({ url: null, builtAt: null, missing: [] }),
    buildPreview: rec('exports.buildPreview', { ok: false, reason: 'not in the harness' })
  },
  generation: {
    models: () =>
      Promise.resolve([
        { id: 'fal-ai/kling-video/o3/standard/image-to-video', displayName: 'Kling O3 Standard', durationsSec: [5], resolutions: ['standard'], defaultResolution: 'standard', audioSupport: true, confirmed: true, verificationNote: '', rates: [{ nativeAudio: false, usdPerSecond: 0.084 }] },
        { id: 'fal-ai/kling-video/v2.6/pro/image-to-video', displayName: 'Kling 2.6 Pro', durationsSec: [5, 10], resolutions: ['standard'], defaultResolution: 'standard', audioSupport: true, confirmed: true, verificationNote: '', rates: [{ nativeAudio: false, usdPerSecond: 0.07 }] }
      ]),
    liveConfirmation: (_p: string, _k: string, modelId?: string | null) => {
      calls.push({ fn: 'liveConfirmation', args: [_p, _k, modelId] })
      const chosen = modelId ?? 'fal-ai/kling-video/o3/standard/image-to-video'
      return Promise.resolve({
        ok: true, reasons: [], projectName: 'Harness', transitionLabel: 'Image 1 → Image 2',
        provider: 'fal.ai', model: chosen.includes('2.6') ? 'Kling 2.6 Pro' : 'Kling O3 Standard',
        modelId: chosen, modelConfirmed: !chosen.includes('2.6'),
        modelNote: chosen.includes('2.6') ? 'NOT VERIFIED.' : null,
        modelDurations: chosen.includes('2.6') ? [5, 10] : [5], modelResolutions: ['standard'], modelAudioSupport: true,
        durationSec: 5, resolution: 'standard', nativeAudio: false, prompt: 'x',
        startImage: null, endImage: null,
        estimatedCostLabel: chosen.includes('2.6') ? '$0.35' : '$0.42',
        estimatedCostBasis: 'basis', customerPriceLabel: '0 kr', warning: '',
        attemptNumber: 2, isRegeneration: true, additionalCostLabel: '-', spentSoFarLabel: '-',
        projectedAfterLabel: '-', spatialGuidance: 'analysis',
        overrideWarning: null, overrideReason: null
      })
    },
    generateLive: rec('generateLive')
  },
  settings: { get: () => Promise.resolve(null), save: rec('settings.save') },
  queue: { list: () => Promise.resolve([]), onChanged: () => () => {}, isPaused: () => Promise.resolve(false) },
  ffmpeg: { status: () => Promise.resolve({ available: true, version: '7.0', source: 'bundled' }) },
  providers: {
    catalog: () => Promise.resolve([]),
    hasApiKey: (id: string) =>
      Promise.resolve(JSON.parse(sessionStorage.getItem('keys') ?? '{}')[id] === true),
    setApiKey: (id: string, key: string) => {
      const keys = JSON.parse(sessionStorage.getItem('keys') ?? '{}')
      keys[id] = key.trim().length > 0
      sessionStorage.setItem('keys', JSON.stringify(keys))
      calls.push({ fn: 'providers.setApiKey', args: [id, key] })
      return Promise.resolve()
    },
    contractStatus: () =>
      Promise.resolve({ items: [], locked: false, defaults: {}, rates: {}, nativeAudioDefault: false }),
    falStatus: () => Promise.resolve({})
  }
}

/**
 * The evidence main reports for the harness pair.
 *
 * A test flips this the way a real adopt would — the badge must follow
 * what MAIN says, never a value the panel worked out for itself.
 */
let harnessEvidence: unknown = {
  source: 'feed-analysis',
  fingerprint: 'feed:1725700000000'
}
;(globalThis as Record<string, unknown>).__setEvidence = (e: unknown) => {
  harnessEvidence = e
}
;(globalThis as Record<string, unknown>).__setClip = (clip: unknown) => {
  ;(project.transitions as Record<string, { clip: unknown; status: string }>)[
    `${FROM}->${TO}`
  ].clip = clip
  ;(project.transitions as Record<string, { clip: unknown; status: string }>)[
    `${FROM}->${TO}`
  ].status = 'completed'
  project.updatedAt = project.updatedAt + 1
}
;(globalThis as Record<string, unknown>).__setProvenance = (p: unknown) => {
  ;(project.transitions as Record<string, { promptProvenance: unknown; prompt: string }>)[
    `${FROM}->${TO}`
  ].promptProvenance = p
  project.updatedAt = project.updatedAt + 1
}
;(
  (window as unknown as { f2f: { projects: { pairAnalysis: Record<string, unknown> } } }).f2f
).projects.pairAnalysis.currentEvidence = (...args: unknown[]) => {
  calls.push({ fn: 'pairAnalysis.currentEvidence', args })
  return Promise.resolve(harnessEvidence)
}

const which = new URLSearchParams(location.search).get('c') ?? 'review'
const root = createRoot(document.getElementById('root')!)

root.render(
  <AppStateProvider>
    {which === 'settings' ? (
      <SettingsPage />
    ) : which === 'queue' ? (
      <QueuePage />
    ) : which === 'editor' ? (
      <ProjectEditorPage projectId="p1" onBack={() => calls.push({ fn: 'onBack', args: [] })} />
    ) : which === 'catalogue' ? (
      <ProjectCatalogue
        projectId="p1"
        open={true}
        onClose={() => calls.push({ fn: 'onClose', args: [] })}
        onRegenerate={() => calls.push({ fn: 'onRegenerate', args: [] })}
        currentPairKeys={[`${FROM}->${TO}`]}
      />
    ) : which === 'panel' ? (
      <LeftPanel
        project={project}
        analysis={null}
        selection={{ kind: 'transition', pairKey: `${FROM}->${TO}` } as never}
        modes={[]}
        onSelect={() => calls.push({ fn: 'onSelect', args: [] })}
        onAnalysisChange={() => calls.push({ fn: 'onAnalysisChange', args: [] })}
      />
    ) : which === 'inspector' ? (
      <TransitionInspector
        project={project}
        analysis={null}
        pairKey={`${FROM}->${TO}`}
        modes={[]}
      />
    ) : (
      <TransitionAnalysisReview
        project={project}
        draft={draft}
        visible={true}
        onAccept={() => calls.push({ fn: 'onAccept', args: [] })}
        onDecline={() => calls.push({ fn: 'onDecline', args: [] })}
        onRefresh={() => calls.push({ fn: 'onRefresh', args: [] })}
      />
    )}
  </AppStateProvider>
)
