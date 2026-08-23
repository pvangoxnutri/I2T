import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import {
  defaultTransitionSettings,
  transitionKey,
  type AppSettings,
  type BrandSignature,
  type PreviewWatermark,
  type Project,
  type ProjectImage,
  type QueueJob,
  type TransitionSettings
} from '../types'
import { DEFAULT_PRICING } from '../../../shared/pricing'

/**
 * App state with SQLite persistence behind it.
 *
 * The components see exactly the same API as the in-memory milestone — all
 * persistence flows through here:
 *  - startup: hydrate projects + settings from the main process (SQLite)
 *  - edits: mark the project dirty and autosave DEBOUNCED (400 ms), so
 *    typing a prompt doesn't write on every keystroke
 *  - create/delete: persisted immediately
 *  - pending saves flush on beforeunload as a last resort; the main process
 *    additionally flushes the database file itself on quit
 */

const SAVE_DEBOUNCE_MS = 400

const makeSignature = (): BrandSignature => ({
  enabled: true,
  logoSrc: null,
  logoName: null,
  // The signature burned into exported video. DEFAULT ONLY — projects that
  // already stored a signature keep theirs, so nothing a customer has
  // already been sent changes retroactively.
  brandName: 'I2T',
  websiteUrl: 'i2t.studio',
  position: 'bottom-right',
  sizePct: 12,
  opacityPct: 55
})

const makeWatermark = (): PreviewWatermark => ({
  enabled: true,
  imageSrc: null,
  imageName: null,
  position: 'center',
  sizePct: 45,
  opacityPct: 35
})

const initialSettings: AppSettings = {
  providers: [
    // Keys are write-only across the bridge and are never held here.
    // fal.ai leads: it needs no upfront API package, so it is the
    // recommended default. Kling stays fully configured alongside it.
    {
      id: 'fal',
      label: 'fal.ai',
      apiKey: '',
      mode: 'dry-run',
      model: 'fal-ai/kling-video/o3/standard/image-to-video'
    },
    { id: 'kling', label: 'Kling', apiKey: '', legacySecret: '', mode: 'dry-run', model: null }
  ],
  activeProviderId: 'fal',
  exportDefaults: {
    aspectRatio: '16:9',
    resolution: '1080p',
    fps: 25,
    // 5 s is Kling 3.0 Omni's shortest real duration — a smaller default
    // would only be snapped upwards at submit time.
    defaultTransitionDurationSec: 5,
    // Seamless Assembly ON by default (part B1). Adjacent clips share a key
    // frame, and without a short blend every joint reads as a hard cut.
    seamBlend: 'subtle'
  },
  defaultSignature: makeSignature(),
  pricing: { ...DEFAULT_PRICING },
  production: {
    maxConcurrentAiGenerations: 1,
    mockAiCostPerSecond: null,
    // Safety lock defaults OFF — no paid request is possible out of the box.
    allowLiveKlingRequests: false,
    // Each provider has its OWN lock — unlocking one never unlocks the other.
    allowLiveFalRequests: false,
    klingContract: { acknowledged: false }
  }
}

interface AppState {
  hydrated: boolean
  projects: Project[]
  queue: QueueJob[]
  queuePaused: boolean
  settings: AppSettings
  setProjectStatus: (projectId: string, status: Project['status']) => void
  markWorkflow: (
    projectId: string,
    field: 'previewSentAt' | 'paidAt' | 'finalSentAt',
    value: number | null
  ) => void
  refreshProjects: () => void

  createProject: () => Promise<Project>
  deleteProject: (projectId: string) => void
  renameProject: (projectId: string, name: string) => void

  addImages: (projectId: string, images: ProjectImage[]) => void
  removeImage: (projectId: string, imageId: string) => void
  moveImage: (projectId: string, fromIndex: number, toIndex: number) => void
  updateTransition: (
    projectId: string,
    fromImageId: string,
    toImageId: string,
    patch: Partial<TransitionSettings>
  ) => void

  updateWatermark: (projectId: string, patch: Partial<PreviewWatermark>) => void
  updateSignature: (projectId: string, patch: Partial<BrandSignature>) => void
  updateSettings: (patch: Partial<AppSettings>) => void
}

const Ctx = createContext<AppState | null>(null)

export function AppStateProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [hydrated, setHydrated] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [queue, setQueue] = useState<QueueJob[]>([])
  const [settings, setSettings] = useState<AppSettings>(initialSettings)

  const [queuePaused, setQueuePaused] = useState(false)

  // Live production queue: seeded once, then pushed from the main process.
  useEffect(() => {
    void window.f2f.queue.list().then(setQueue)
    void window.f2f.queue.isPaused().then(setQueuePaused)
    return window.f2f.queue.onChanged((next) => {
      setQueue(next)
      void window.f2f.queue.isPaused().then(setQueuePaused)
    })
  }, [])

  // ── Autosave plumbing ─────────────────────────────────────────────────
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const dirtyProjectIdsRef = useRef(new Set<string>())
  const settingsDirtyRef = useRef(false)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushSaves = useCallback((): void => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    for (const id of dirtyProjectIdsRef.current) {
      const project = projectsRef.current.find((p) => p.id === id)
      if (project) void window.f2f.projects.save(project)
    }
    dirtyProjectIdsRef.current.clear()
    if (settingsDirtyRef.current) {
      settingsDirtyRef.current = false
      void window.f2f.settings.save(settingsRef.current)
    }
  }, [])

  const scheduleSave = useCallback(
    (projectId?: string): void => {
      if (projectId) dirtyProjectIdsRef.current.add(projectId)
      else settingsDirtyRef.current = true
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(flushSaves, SAVE_DEBOUNCE_MS)
    },
    [flushSaves]
  )

  // Last-resort flush when the window goes away mid-debounce.
  useEffect(() => {
    const flush = (): void => flushSaves()
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [flushSaves])

  // ── Main-process project pushes ───────────────────────────────────────
  //
  // Generation finishes asynchronously. There is no click to hang a refresh
  // off, and the one refresh on the generation path fired when generation
  // STARTED — before a clip could exist. So a finished clip sat in the
  // database while the editor rendered the copy it loaded at mount. This
  // subscription is what makes completion visible on its own.
  //
  // MERGE, don't clobber. A project can have edits still sitting in the
  // autosave debounce (a prompt the user is typing). Main owns what
  // generation produces — transition status and clip; the renderer owns
  // what the user is editing. When a project is dirty we take only the
  // generation-owned fields; otherwise the pushed row is simply newer and
  // wins outright.
  useEffect(() => {
    return window.f2f.projects.onUpdated((incoming) => {
      setProjects((prev) => {
        const index = prev.findIndex((p) => p.id === incoming.id)
        if (index === -1) return [incoming, ...prev]
        const local = prev[index]
        if (!dirtyProjectIdsRef.current.has(incoming.id)) {
          return prev.map((p) => (p.id === incoming.id ? incoming : p))
        }
        const transitions = { ...local.transitions }
        for (const [key, remote] of Object.entries(incoming.transitions)) {
          const mine = transitions[key]
          transitions[key] = mine
            ? { ...mine, status: remote.status, clip: remote.clip }
            : remote
        }
        return prev.map((p) => (p.id === incoming.id ? { ...local, transitions } : p))
      })
    })
  }, [])

  // ── Hydration ─────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [storedProjects, storedSettings] = await Promise.all([
        window.f2f.projects.list(),
        window.f2f.settings.get()
      ])
      if (cancelled) return
      setProjects(storedProjects)
      if (storedSettings) {
        // Settings stored before a field existed get its default — the
        // JSON-blob settings row needs no schema migration for additions.
        // Providers merge BY ID: settings saved before fal existed gain the
        // fal entry without losing the stored Kling configuration.
        setSettings({
          ...initialSettings,
          ...storedSettings,
          providers: initialSettings.providers.map(
            (fallback) =>
              (storedSettings.providers ?? []).find((p) => p.id === fallback.id) ?? fallback
          ),
          activeProviderId: storedSettings.activeProviderId ?? initialSettings.activeProviderId,
          pricing: storedSettings.pricing ?? { ...DEFAULT_PRICING },
          production: { ...initialSettings.production, ...(storedSettings.production ?? {}) }
        })
      } else {
        // First launch: persist the defaults so they exist from day one.
        void window.f2f.settings.save(initialSettings)
      }
      setHydrated(true)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // ── Mutations (every one marks its project dirty) ─────────────────────

  const patchProject = useCallback(
    (projectId: string, fn: (p: Project) => Project) => {
      setProjects((prev) =>
        prev.map((p) => (p.id === projectId ? { ...fn(p), updatedAt: Date.now() } : p))
      )
      scheduleSave(projectId)
    },
    [scheduleSave]
  )

  const createProject = useCallback(async (): Promise<Project> => {
    const project: Project = {
      id: crypto.randomUUID(),
      name: 'Untitled property',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      images: [],
      transitions: {},
      watermark: makeWatermark(),
      signature: { ...settingsRef.current.defaultSignature },
      status: 'draft',
      workflow: { previewSentAt: null, paidAt: null, finalSentAt: null }
    }
    setProjects((prev) => [project, ...prev])
    await window.f2f.projects.save(project)
    return project
  }, [])

  /** Re-reads projects from SQLite — used after main-side mutations (mock
   * generation writes transition states directly). */
  const refreshProjects = useCallback((): void => {
    void window.f2f.projects.list().then(setProjects)
  }, [])

  const setProjectStatus = useCallback(
    (projectId: string, status: Project['status']): void => {
      setProjects((prev) => prev.map((p) => (p.id === projectId ? { ...p, status } : p)))
      dirtyProjectIdsRef.current.delete(projectId)
      void window.f2f.projects.setStatus(projectId, status)
    },
    []
  )

  const markWorkflow = useCallback(
    (
      projectId: string,
      field: 'previewSentAt' | 'paidAt' | 'finalSentAt',
      value: number | null
    ): void => {
      setProjects((prev) =>
        prev.map((p) => (p.id === projectId ? { ...p, workflow: { ...p.workflow, [field]: value } } : p))
      )
      dirtyProjectIdsRef.current.delete(projectId)
      void window.f2f.projects.markWorkflow(projectId, field, value)
    },
    []
  )

  const deleteProject = useCallback((projectId: string) => {
    dirtyProjectIdsRef.current.delete(projectId)
    setProjects((prev) => prev.filter((p) => p.id !== projectId))
    void window.f2f.projects.delete(projectId)
  }, [])

  const renameProject = useCallback(
    (projectId: string, name: string) => patchProject(projectId, (p) => ({ ...p, name })),
    [patchProject]
  )

  const addImages = useCallback(
    (projectId: string, images: ProjectImage[]) =>
      patchProject(projectId, (p) => ({ ...p, images: [...p.images, ...images] })),
    [patchProject]
  )

  const removeImage = useCallback(
    (projectId: string, imageId: string) => {
      const image = projectsRef.current
        .find((p) => p.id === projectId)
        ?.images.find((i) => i.id === imageId)
      patchProject(projectId, (p) => ({
        ...p,
        images: p.images.filter((i) => i.id !== imageId)
      }))
      // The managed file itself is deleted fire-and-forget; the DB row goes
      // with the debounced project save.
      if (image) void window.f2f.images.remove(projectId, image.storedName)
    },
    [patchProject]
  )

  const moveImage = useCallback(
    (projectId: string, fromIndex: number, toIndex: number) =>
      patchProject(projectId, (p) => {
        if (fromIndex === toIndex) return p
        const images = [...p.images]
        const [moved] = images.splice(fromIndex, 1)
        images.splice(toIndex, 0, moved)
        return { ...p, images }
      }),
    [patchProject]
  )

  const updateTransition = useCallback(
    (projectId: string, fromImageId: string, toImageId: string, patch: Partial<TransitionSettings>) =>
      patchProject(projectId, (p) => {
        const key = transitionKey(fromImageId, toImageId)
        const current =
          p.transitions[key] ??
          defaultTransitionSettings(settingsRef.current.exportDefaults.defaultTransitionDurationSec)
        return { ...p, transitions: { ...p.transitions, [key]: { ...current, ...patch } } }
      }),
    [patchProject]
  )

  const updateWatermark = useCallback(
    (projectId: string, patch: Partial<PreviewWatermark>) =>
      patchProject(projectId, (p) => ({ ...p, watermark: { ...p.watermark, ...patch } })),
    [patchProject]
  )

  const updateSignature = useCallback(
    (projectId: string, patch: Partial<BrandSignature>) =>
      patchProject(projectId, (p) => ({ ...p, signature: { ...p.signature, ...patch } })),
    [patchProject]
  )

  const updateSettings = useCallback(
    (patch: Partial<AppSettings>) => {
      setSettings((prev) => ({ ...prev, ...patch }))
      scheduleSave()
    },
    [scheduleSave]
  )

  const value = useMemo<AppState>(
    () => ({
      hydrated,
      projects,
      queue,
      queuePaused,
      settings,
      setProjectStatus,
      markWorkflow,
      refreshProjects,
      createProject,
      deleteProject,
      renameProject,
      addImages,
      removeImage,
      moveImage,
      updateTransition,
      updateWatermark,
      updateSignature,
      updateSettings
    }),
    [
      hydrated,
      projects,
      queue,
      queuePaused,
      settings,
      setProjectStatus,
      markWorkflow,
      refreshProjects,
      createProject,
      deleteProject,
      renameProject,
      addImages,
      removeImage,
      moveImage,
      updateTransition,
      updateWatermark,
      updateSignature,
      updateSettings
    ]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAppState(): AppState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAppState must be used inside AppStateProvider')
  return ctx
}
