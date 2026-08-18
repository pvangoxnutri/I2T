import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
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
import { mockQueueJobs } from '../mock/queueJobs'

/**
 * All app state lives here, in memory, on purpose — this milestone is the
 * UI foundation. When SQLite lands, this provider keeps its exact API and
 * swaps useState for IPC-backed persistence, so no component changes.
 */

const makeSignature = (): BrandSignature => ({
  enabled: true,
  logoSrc: null,
  logoName: null,
  brandName: 'FrameToFrame',
  websiteUrl: 'frametoframe.io',
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
  providers: [{ id: 'kling', label: 'Kling', apiKey: '', apiSecret: '' }],
  exportDefaults: {
    aspectRatio: '16:9',
    resolution: '1080p',
    fps: 25,
    defaultTransitionDurationSec: 4
  },
  defaultSignature: makeSignature()
}

interface AppState {
  projects: Project[]
  queue: QueueJob[]
  settings: AppSettings

  createProject: () => Project
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
  const [projects, setProjects] = useState<Project[]>([])
  const [queue] = useState<QueueJob[]>(mockQueueJobs)
  const [settings, setSettings] = useState<AppSettings>(initialSettings)

  const patchProject = useCallback((projectId: string, fn: (p: Project) => Project) => {
    setProjects((prev) =>
      prev.map((p) => (p.id === projectId ? { ...fn(p), updatedAt: Date.now() } : p))
    )
  }, [])

  const createProject = useCallback((): Project => {
    const project: Project = {
      id: crypto.randomUUID(),
      name: 'Untitled property',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      images: [],
      transitions: {},
      watermark: makeWatermark(),
      signature: { ...settings.defaultSignature }
    }
    setProjects((prev) => [project, ...prev])
    return project
  }, [settings.defaultSignature])

  const deleteProject = useCallback((projectId: string) => {
    setProjects((prev) => prev.filter((p) => p.id !== projectId))
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
    (projectId: string, imageId: string) =>
      patchProject(projectId, (p) => ({
        ...p,
        images: p.images.filter((i) => i.id !== imageId)
      })),
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
          defaultTransitionSettings(settings.exportDefaults.defaultTransitionDurationSec)
        return { ...p, transitions: { ...p.transitions, [key]: { ...current, ...patch } } }
      }),
    [patchProject, settings.exportDefaults.defaultTransitionDurationSec]
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

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }))
  }, [])

  const value = useMemo<AppState>(
    () => ({
      projects,
      queue,
      settings,
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
      projects,
      queue,
      settings,
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
