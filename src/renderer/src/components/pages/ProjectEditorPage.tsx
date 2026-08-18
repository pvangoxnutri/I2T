import { useRef, useState } from 'react'
import { useAppState } from '../../state/AppState'
import type { ProjectImage } from '../../types'
import { ImageSequence } from '../editor/ImageSequence'
import { BrandingExportPanel } from '../editor/BrandingExportPanel'

/** Reads picked/dropped files into local object URLs — no disk writes yet. */
function filesToImages(files: FileList | File[]): Promise<ProjectImage[]> {
  const list = Array.from(files).filter((f) => f.type.startsWith('image/'))
  return Promise.all(
    list.map(
      (file) =>
        new Promise<ProjectImage>((resolve) => {
          const reader = new FileReader()
          reader.onload = () =>
            resolve({ id: crypto.randomUUID(), fileName: file.name, src: String(reader.result) })
          reader.readAsDataURL(file)
        })
    )
  )
}

export function ProjectEditorPage({
  projectId,
  onBack
}: {
  projectId: string
  onBack: () => void
}): React.JSX.Element {
  const { projects, renameProject, addImages } = useAppState()
  const [dropActive, setDropActive] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const project = projects.find((p) => p.id === projectId)
  if (!project) {
    return (
      <div className="page">
        <p className="queue-empty">This project no longer exists.</p>
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          ← Back to projects
        </button>
      </div>
    )
  }

  const importFiles = async (files: FileList | File[]): Promise<void> => {
    const images = await filesToImages(files)
    if (images.length > 0) addImages(project.id, images)
  }

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDropActive(false)
    // Only OS file drops — internal card reordering has no files attached.
    if (e.dataTransfer.files.length > 0) void importFiles(e.dataTransfer.files)
  }

  const transitionCount = Math.max(0, project.images.length - 1)

  return (
    <div className="page editor-page">
      <header className="editor-head">
        <button type="button" className="btn btn-ghost editor-back" onClick={onBack}>
          ← Projects
        </button>
        <input
          className="editor-name"
          value={project.name}
          placeholder="Untitled property"
          onChange={(e) => renameProject(project.id, e.target.value)}
        />
        <span className="editor-meta">
          {project.images.length} photos · {transitionCount} transitions
        </span>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => fileInputRef.current?.click()}
        >
          + Add photos
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files) void importFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </header>

      <div className="editor-columns">
        <div className="editor-sequence-col">
          <div
            className={`dropzone${dropActive ? ' is-active' : ''}${project.images.length > 0 ? ' is-compact' : ''}`}
            onDragOver={(e) => {
              // Only light up for OS file drags, not internal reorder drags.
              if (e.dataTransfer.types.includes('Files')) {
                e.preventDefault()
                setDropActive(true)
              }
            }}
            onDragLeave={() => setDropActive(false)}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
          >
            <div className="dropzone-inner">
              <span className="dropzone-icon" aria-hidden>
                ⇩
              </span>
              <span className="dropzone-title">
                {project.images.length === 0
                  ? 'Drop the listing photos here'
                  : 'Drop more photos here'}
              </span>
              <span className="dropzone-hint">
                …or click to browse. Order them in walk-through order — every consecutive pair
                becomes one AI transition.
              </span>
            </div>
          </div>

          <ImageSequence project={project} />
        </div>

        <BrandingExportPanel project={project} />
      </div>
    </div>
  )
}
