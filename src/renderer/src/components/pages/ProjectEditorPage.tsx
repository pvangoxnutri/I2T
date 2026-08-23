import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppState } from '../../state/AppState'
import type { PropertyAnalysis } from '../../../../shared/propertyAnalysis'
import {
  inspectorModeFor,
  previewModeFor,
  reconcileSelection,
  resolveShortcut,
  selectFullVideo,
  selectImage,
  selectTransition,
  type EditorSelection
} from '../../../../shared/editorSelection'
import { EditorToolbar } from '../editor/EditorToolbar'
import { LeftPanel } from '../editor/LeftPanel'
import { PreviewStage } from '../editor/PreviewStage'
import { TimelineStrip } from '../editor/TimelineStrip'
import { TransitionInspector } from '../editor/TransitionInspector'
import { ImageInspector } from '../editor/ImageInspector'
import { ExportDrawer } from '../editor/ExportDrawer'
import { LiveGenerateDialog } from '../editor/LiveGenerateDialog'
import type { LiveConfirmationPayload } from '../../../../preload/index'

/**
 * The I2T editor — a desktop video-editing workspace.
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ toolbar                                      │
 *   ├───────────┬──────────────────────────────────┤
 *   │ left      │ preview                          │
 *   ├───────────┴──────────────────────────────────┤
 *   │ timeline                                     │
 *   ├──────────────────────────────────────────────┤
 *   │ inspector  (image OR transition)             │
 *   └──────────────────────────────────────────────┘
 *
 * ── ONE SELECTION DRIVES EVERYTHING ──────────────────────────────────
 *
 * This page used to hold three independent pieces of state — a selected
 * pair, a selected image and a preview mode — with nothing keeping them
 * consistent. Clicking a photograph selected it in the left panel while
 * the previous transition's clip kept playing and the inspector described
 * a third thing. The user had to work out which of the three the screen
 * was about.
 *
 * Now there is ONE `EditorSelection`. The preview and the inspector are
 * derived from it, so they cannot disagree, and an image and a transition
 * cannot both be selected because that state does not exist.
 *
 * ── GRID, NOT SCROLL ─────────────────────────────────────────────────
 *
 * The layout is a CSS grid sized to the viewport, so the page itself never
 * scrolls. Panels scroll internally where they must, which keeps the
 * timeline and preview permanently in view while working.
 */
export function ProjectEditorPage({
  projectId,
  onBack
}: {
  projectId: string
  onBack: () => void
}): React.JSX.Element {
  const { projects, moveImage, refreshProjects } = useAppState()
  const [selection, setSelection] = useState<EditorSelection>(selectFullVideo())
  const [exportOpen, setExportOpen] = useState(false)
  const [analysis, setAnalysis] = useState<PropertyAnalysis | null>(null)
  // Bumped whenever a manual override changes, so the effective analysis
  // — and therefore every plan derived from it — is re-read.
  const [factsNonce, setFactsNonce] = useState(0)
  const [liveConfirm, setLiveConfirm] = useState<LiveConfirmationPayload | null>(null)
  const [generateOpening, setGenerateOpening] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const project = projects.find((p) => p.id === projectId)

  // The EFFECTIVE analysis: accepted, with manual corrections folded in.
  // Read once here and passed down so the timeline, both inspectors and
  // the left panel describe the same understanding rather than each
  // fetching its own copy and drifting.
  useEffect(() => {
    void window.f2f.projects.analysis.effective(projectId).then(setAnalysis)
  }, [projectId, factsNonce])

  const imageIds = project?.images.map((i) => i.id) ?? []
  const imageIdKey = imageIds.join('|')

  // Keep the selection meaningful as the project changes. A photo that
  // merely MOVED keeps its selection — the user selected the picture, not
  // the slot — and only something genuinely gone falls back to Full Video.
  useEffect(() => {
    setSelection((current) => reconcileSelection(current, imageIdKey ? imageIdKey.split('|') : []))
  }, [imageIdKey])

  /**
   * KEYBOARD NAVIGATION.
   *
   * Bound to the window rather than to the timeline, because reviewing a
   * sequence means looking at the PREVIEW — nobody keeps focus on a
   * thumbnail strip while doing it. `resolveShortcut` decides whether the
   * press means anything at all, including refusing every key while the
   * user is typing in a prompt.
   */
  const selectionRef = useRef(selection)
  selectionRef.current = selection

  const onKeyDown = useCallback(
    (event: KeyboardEvent): void => {
      if (!project) return
      const ids = project.images.map((i) => i.id)
      const action = resolveShortcut(
        {
          key: event.key,
          shiftKey: event.shiftKey,
          target: event.target as HTMLElement | null
        },
        selectionRef.current,
        ids
      )
      if (action.type === 'none') return
      // Only now — an unhandled arrow must still scroll the page.
      event.preventDefault()
      if (action.type === 'select-image') {
        setSelection(selectImage(action.imageId))
        return
      }
      // Shift+Arrow: the SAME persistent reorder path as drag and drop.
      moveImage(project.id, action.fromIndex, action.toIndex)
    },
    [project, moveImage]
  )

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onKeyDown])

  /**
   * GENERATE, FROM THE PREVIEW.
   *
   * Deliberately the SAME path the inspector's Generation tab uses: build
   * the paid confirmation in main, show it, and submit only on confirm.
   * The preview is given a callback rather than the provider API, so no
   * safety gate, provider lock or cost dialog is bypassed by putting the
   * button somewhere more findable.
   */
  const openGenerate = useCallback(
    (pairKey: string): void => {
      setGenerateOpening(true)
      void window.f2f.generation
        .liveConfirmation(projectId, pairKey)
        .then((data) => {
          if (data) setLiveConfirm(data)
        })
        .finally(() => setGenerateOpening(false))
    },
    [projectId]
  )

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

  const inspector = inspectorModeFor(selection)

  return (
    <div className="editor">
      <EditorToolbar project={project} onBack={onBack} onOpenExport={() => setExportOpen(true)} />

      <div className="editor-stage">
        <LeftPanel
          project={project}
          analysis={analysis}
          selection={selection}
          onSelect={setSelection}
          onAnalysisChange={() => setFactsNonce((n) => n + 1)}
        />
        <PreviewStage
          project={project}
          selection={selection}
          mode={previewModeFor(selection)}
          onShowFullVideo={() => setSelection(selectFullVideo())}
          onGenerate={
            selection.kind === 'transition' ? () => openGenerate(selection.pairKey) : undefined
          }
          generating={generateOpening}
        />
      </div>

      <TimelineStrip
        project={project}
        analysis={analysis}
        selection={selection}
        onSelectImage={(id) => setSelection(selectImage(id))}
        onSelectTransition={(key) => setSelection(selectTransition(key))}
      />

      {inspector === 'image' && (
        <ImageInspector
          project={project}
          analysis={analysis}
          imageId={selection.kind === 'image' ? selection.imageId : ''}
          onOverridesChanged={() => setFactsNonce((n) => n + 1)}
        />
      )}
      {inspector === 'transition' && (
        <TransitionInspector
          project={project}
          analysis={analysis}
          pairKey={selection.kind === 'transition' ? selection.pairKey : null}
        />
      )}
      {inspector === 'none' && (
        <section className="inspector inspector-empty">
          <p>Select an image or a transition in the timeline.</p>
        </section>
      )}

      <ExportDrawer project={project} open={exportOpen} onClose={() => setExportOpen(false)} />

      {/* The unchanged paid-request confirmation. Reached from the preview
          and from the inspector's Generation tab; both build it in main
          and neither can submit without passing through it. */}
      {liveConfirm && selection.kind === 'transition' && (
        <LiveGenerateDialog
          data={liveConfirm}
          busy={submitting}
          onCancel={() => setLiveConfirm(null)}
          onConfirm={() => {
            setSubmitting(true)
            void window.f2f.generation
              .generateLive(project.id, [selection.pairKey])
              .then(() => {
                setSubmitting(false)
                setLiveConfirm(null)
                refreshProjects()
              })
          }}
        />
      )}
    </div>
  )
}
