import { useCallback, useRef, useState } from 'react'
import { useAppState } from '../../state/AppState'
import type { Project } from '../../types'
import type { PropertyAnalysis } from '../../../../shared/propertyAnalysis'
import { roomOfImage } from '../../../../shared/propertyAnalysis'
import { summarizeAnalysis } from '../../../../shared/analysisSummary'
import { selectImage, type EditorSelection } from '../../../../shared/editorSelection'
import { PropertyAnalysisPanel } from './PropertyAnalysisPanel'
import { ProductionCostPanel } from './ProductionCostPanel'
import { ProductionPanel } from './ProductionPanel'
import { ProjectReadiness } from './ProjectReadiness'

type PanelTab = 'media' | 'analysis' | 'production'

/**
 * The left workspace: three compact views of the same project.
 *
 * Tabs rather than a scrolling stack — each answers a different question
 * ("what am I working with", "what does the system understand", "what has
 * this cost"), and they are rarely needed at the same moment.
 *
 * Project readiness sits above the tabs, permanently, because "what should
 * I do next" is the one question that does not belong to any single tab.
 */
export function LeftPanel({
  project,
  analysis,
  selection,
  onSelect,
  onAnalysisChange
}: {
  project: Project
  analysis: PropertyAnalysis | null
  selection: EditorSelection
  onSelect: (selection: EditorSelection) => void
  onAnalysisChange: () => void
}): React.JSX.Element {
  const [tab, setTab] = useState<PanelTab>('media')

  const imageLabel = useCallback(
    (id: string): string => {
      const i = project.images.findIndex((x) => x.id === id)
      return i >= 0 ? `Image ${String(i + 1).padStart(2, '0')}` : 'Image ?'
    },
    [project.images]
  )
  const summary = summarizeAnalysis(
    analysis,
    project.images.map((i) => i.id),
    imageLabel
  )

  return (
    <aside className="left-panel">
      <ProjectReadiness project={project} summary={summary} />

      <nav className="left-tabs" role="tablist">
        {(
          [
            ['media', 'Media'],
            ['analysis', 'Analysis'],
            ['production', 'Production']
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`left-tab${tab === key ? ' is-active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="left-body">
        {tab === 'media' && (
          <MediaBrowser
            project={project}
            analysis={analysis}
            selectedImageId={selection.kind === 'image' ? selection.imageId : null}
            onSelectImage={(id) => onSelect(selectImage(id))}
          />
        )}
        {tab === 'analysis' && (
          <PropertyAnalysisPanel
            project={project}
            analysis={analysis}
            onSelect={onSelect}
            onAnalysisChange={onAnalysisChange}
          />
        )}
        {tab === 'production' && (
          <div className="left-production">
            <ProductionCostPanel project={project} />
            <ProductionPanel project={project} />
          </div>
        )}
      </div>
    </aside>
  )
}

/**
 * A compact image browser. The TIMELINE is the sequence editor — this is
 * for finding and inspecting a photo, so it stays a dense list rather
 * than competing with the timeline for that job.
 */
function MediaBrowser({
  project,
  analysis,
  selectedImageId,
  onSelectImage
}: {
  project: Project
  analysis: PropertyAnalysis | null
  selectedImageId: string | null
  onSelectImage: (id: string) => void
}): React.JSX.Element {
  const { addImages, removeImage } = useAppState()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dropActive, setDropActive] = useState(false)

  const importFiles = async (files: FileList | File[]): Promise<void> => {
    const list = Array.from(files).filter((f) => f.type.startsWith('image/'))
    const payloads = await Promise.all(
      list.map(async (file) => {
        const sourcePath = window.f2f.getPathForFile(file)
        if (sourcePath) return { sourcePath, name: file.name }
        return { bytes: await file.arrayBuffer(), name: file.name }
      })
    )
    const images = await window.f2f.images.import(project.id, payloads)
    if (images.length > 0) addImages(project.id, images)
  }

  return (
    <div className="media-browser">
      <div
        className={`media-drop${dropActive ? ' is-active' : ''}`}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            setDropActive(true)
          }
        }}
        onDragLeave={() => setDropActive(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDropActive(false)
          if (e.dataTransfer.files.length > 0) void importFiles(e.dataTransfer.files)
        }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
      >
        Drop photos or click to import
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files) void importFiles(e.target.files)
          e.target.value = ''
        }}
      />

      <ul className="media-list">
        {project.images.map((image, index) => {
          const room = analysis ? roomOfImage(analysis, image.id)?.label : null
          return (
            <li key={image.id}>
              <button
                type="button"
                className={`media-item${selectedImageId === image.id ? ' is-selected' : ''}`}
                onClick={() => onSelectImage(image.id)}
              >
                <img src={image.src} alt="" />
                <span className="media-item-text">
                  <span className="media-item-no">{index + 1}</span>
                  <span className="media-item-name" title={image.fileName}>
                    {image.fileName}
                  </span>
                  <span className="media-item-room">{room ?? 'No room'}</span>
                </span>
              </button>
              <button
                type="button"
                className="media-remove"
                title="Remove this photo"
                onClick={() => removeImage(project.id, image.id)}
              >
                ×
              </button>
            </li>
          )
        })}
        {project.images.length === 0 && <li className="media-empty">No photos yet.</li>}
      </ul>
    </div>
  )
}
