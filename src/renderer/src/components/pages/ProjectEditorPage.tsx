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
import { getFeedSequenceIds } from '../../../../shared/feedSequence'
import { EditorToolbar } from '../editor/EditorToolbar'
import { LeftPanel } from '../editor/LeftPanel'
import { PreviewStage } from '../editor/PreviewStage'
import { TimelineStrip } from '../editor/TimelineStrip'
import { TransitionInspector } from '../editor/TransitionInspector'
import { ImageInspector } from '../editor/ImageInspector'
import { ExportDrawer } from '../editor/ExportDrawer'
import { LiveGenerateDialog } from '../editor/LiveGenerateDialog'
import { CustomerDetailsDrawer } from '../editor/CustomerDetailsDrawer'
import { ProjectCatalogue } from '../editor/ProjectCatalogue'
import type { LiveConfirmationPayload } from '../../../../preload/index'
import {
  latestJobForPair,
  transitionRecovery,
  type TransitionRecovery
} from '../../../../shared/transitionRecovery'
import { pairIndexOf } from '../../../../shared/previewSource'
import { analyzeFeedMutation, type FeedMutationReport } from '../../../../shared/feedMutationGuard'
import { FeedMutationWarningDialog } from '../editor/FeedMutationWarningDialog'
import type { ResolvedModeRow } from '../../../../shared/transitionMode'

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
  const { projects, queue, moveImage, moveFeedImage, removeFromFeed, refreshProjects } = useAppState()
  const [selection, setSelection] = useState<EditorSelection>(selectFullVideo())
  const [exportOpen, setExportOpen] = useState(false)
  const [customerOpen, setCustomerOpen] = useState(false)
  const [catalogueOpen, setCatalogueOpen] = useState(false)
  const [analysis, setAnalysis] = useState<PropertyAnalysis | null>(null)
  // Bumped whenever a manual override changes, so the effective analysis
  // — and therefore every plan derived from it — is re-read.
  const [factsNonce, setFactsNonce] = useState(0)
  const [liveConfirm, setLiveConfirm] = useState<LiveConfirmationPayload | null>(null)
  // How every transition will actually behave — generated, cut or
  // dissolved. Resolved once in main so the timeline, both inspectors,
  // readiness and the cost estimate cannot disagree.
  const [modes, setModes] = useState<ResolvedModeRow[]>([])
  const [generateOpening, setGenerateOpening] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [ctrlArrowWarning, setCtrlArrowWarning] = useState<{ mutation: () => void; report: FeedMutationReport } | null>(null)

  const project = projects.find((p) => p.id === projectId)

  // The EFFECTIVE analysis: accepted, with manual corrections folded in.
  // Read once here and passed down so the timeline, both inspectors and
  // the left panel describe the same understanding rather than each
  // fetching its own copy and drifting.
  useEffect(() => {
    void window.f2f.projects.analysis.effective(projectId).then(setAnalysis)
  }, [projectId, factsNonce])

  // Re-read whenever the project changes: a mode is stored on the
  // transition, and Auto can resolve differently after an accepted
  // analysis changes.
  useEffect(() => {
    void window.f2f.projects.analysis.transitionModes(projectId).then(setModes)
  }, [projectId, factsNonce, project?.updatedAt, analysis?.updatedAt])

  // Reconciliation runs against the FEED, because that is what a selected
  // transition is a transition IN.
  const feedIdKey = project ? getFeedSequenceIds(project).join('|') : ''

  /**
   * Keep the selection meaningful as the project changes. A photo that
   * merely MOVED keeps its selection — the user selected the picture, not
   * the slot — and only something genuinely gone falls back to Full Video.
   *
   * ── WHY THE FEED, AND WHY IT RE-RUNS ON FEED CHANGES ───────────────
   *
   * This validated the selected PAIR against library adjacency and only
   * re-ran when the library changed. Both halves were wrong, and the
   * dangerous half is the second: reordering the feed left a selection
   * pointing at a pair the video no longer contains, and that stale pair
   * was what reached the paid generation dialog. A pair that happened to
   * remain library-adjacent survived reconciliation entirely.
   */
  useEffect(() => {
    const ids = feedIdKey ? feedIdKey.split('|') : []
    setSelection((current) => reconcileSelection(current, ids))
  }, [feedIdKey])

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

      // Delete: remove the selected image from the feed (if it is in it).
      //
      // THROUGH THE SAME GUARD AS EVERY OTHER REMOVAL. This path used to
      // call `removeFromFeed` directly, so pressing Delete on an image
      // whose transition had already been generated dropped that clip out
      // of the sequence with no confirmation — while the identical action
      // via the × button or Ctrl+Arrow asked first.
      if (event.key === 'Delete' && selectionRef.current.kind === 'image') {
        const imageId = selectionRef.current.imageId
        const feedIds = getFeedSequenceIds(project)
        if (feedIds.includes(imageId)) {
          event.preventDefault()
          const report = analyzeFeedMutation(
            project,
            feedIds.filter((id) => id !== imageId)
          )
          if (report.requiresConfirmation) {
            setCtrlArrowWarning({
              mutation: () => removeFromFeed(project.id, imageId),
              report
            })
          } else {
            removeFromFeed(project.id, imageId)
          }
          return
        }
      }

      // Keyboard navigation and reorder operates on the video sequence (feedSequence),
      // not the library. This ensures arrow keys match what user sees
      // in the timeline, and Ctrl+Arrow commands work on feed order, not library order.
      const feedIds = getFeedSequenceIds(project)
      const action = resolveShortcut(
        {
          key: event.key,
          shiftKey: event.shiftKey,
          ctrlKey: event.ctrlKey,
          target: event.target as HTMLElement | null
        },
        selectionRef.current,
        feedIds
      )
      if (action.type === 'none') return
      // Only now — an unhandled arrow must still scroll the page.
      event.preventDefault()
      if (action.type === 'select-image') {
        setSelection(selectImage(action.imageId))
        return
      }
      // Ctrl+Arrow: reorder within feedSequence (video sequence), not library.
      // Guard against breaking generated transitions.
      if (!project) return
      if (feedIds.length === 0) return

      // Simulate the reorder to check if it breaks generated clips
      const newFeedIds = [...feedIds]
      const temp = newFeedIds[action.fromIndex]
      newFeedIds[action.fromIndex] = newFeedIds[action.toIndex]
      newFeedIds[action.toIndex] = temp

      const report = analyzeFeedMutation(project, newFeedIds)
      if (report.requiresConfirmation) {
        setCtrlArrowWarning({
          mutation: () => moveFeedImage(project.id, action.fromIndex, action.toIndex),
          report
        })
      } else {
        moveFeedImage(project.id, action.fromIndex, action.toIndex)
      }
    },
    [project, moveFeedImage, removeFromFeed, setCtrlArrowWarning]
  )

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onKeyDown])

  /**
   * RECOVERY, FROM THE PREVIEW.
   *
   * ── THREE ACTIONS, THREE COSTS ───────────────────────────────────────
   *
   * Resume and Retry download continue work the provider has ALREADY been
   * paid for, so they go straight through — there is nothing to confirm,
   * and making someone confirm a free action teaches them to click through
   * confirmations. Regenerate submits a NEW paid task, so it takes exactly
   * the same confirmation path the inspector uses. No safety gate,
   * provider lock or cost dialog is bypassed by making the button easier
   * to find.
   */
  const recover = useCallback(
    (pairKey: string, action: TransitionRecovery): void => {
      if (action.kind === 'resume' && action.jobId) {
        void window.f2f.queue.resumePolling(action.jobId).then(() => refreshProjects())
        return
      }
      if (action.kind === 'retry-download' && action.jobId) {
        // The remote task already succeeded — this re-runs the transfer
        // and can never resubmit, by construction of the queue's own
        // idempotency state machine.
        void window.f2f.queue.resumePolling(action.jobId).then(() => refreshProjects())
        return
      }
      setGenerateOpening(true)
      void window.f2f.generation
        .liveConfirmation(projectId, pairKey)
        .then((data) => {
          if (data) setLiveConfirm(data)
        })
        .finally(() => setGenerateOpening(false))
    },
    [projectId, refreshProjects]
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
  const selectedMode = modes.find(
    (m) => selection.kind === 'transition' && m.pairKey === selection.pairKey
  )

  // What to offer for the selected transition. Decided in `shared` from
  // the REMOTE task state, so a free recovery is never mislabelled as a
  // paid one or the other way round.
  const recovery =
    selection.kind === 'transition'
      ? transitionRecovery(
          project.transitions[selection.pairKey],
          latestJobForPair(queue, project.id, selection.pairKey),
          `${pairIndexOf(project, selection.pairKey) + 1} → ${pairIndexOf(project, selection.pairKey) + 2}`
        )
      : null

  return (
    <div className="editor">
      <EditorToolbar
        project={project}
        onBack={onBack}
        onOpenExport={() => setExportOpen(true)}
        onOpenCustomer={() => setCustomerOpen(true)}
        onOpenCatalogue={() => setCatalogueOpen(true)}
      />

      <div className="editor-stage">
        <LeftPanel
          project={project}
          analysis={analysis}
          selection={selection}
          modes={modes}
          onSelect={setSelection}
          onAnalysisChange={() => setFactsNonce((n) => n + 1)}
        />
        <PreviewStage
          project={project}
          selection={selection}
          mode={previewModeFor(selection)}
          onShowFullVideo={() => setSelection(selectFullVideo())}
          recovery={recovery}
          transitionMode={selectedMode ?? null}
          onRecover={
            selection.kind === 'transition' && recovery
              ? () => recover(selection.pairKey, recovery)
              : undefined
          }
          generating={generateOpening}
        />
      </div>

      <TimelineStrip
        project={project}
        analysis={analysis}
        selection={selection}
        modes={modes}
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
          modes={modes}
        />
      )}
      {inspector === 'none' && (
        <section className="inspector inspector-empty">
          <p>Select an image or a transition in the timeline.</p>
        </section>
      )}

      <ExportDrawer project={project} open={exportOpen} onClose={() => setExportOpen(false)} />
      {project && (
        <CustomerDetailsDrawer
          project={project}
          open={customerOpen}
          onClose={() => setCustomerOpen(false)}
        />
      )}

      <ProjectCatalogue
        projectId={projectId}
        open={catalogueOpen}
        onClose={() => setCatalogueOpen(false)}
      />

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

      {ctrlArrowWarning && project && (
        <FeedMutationWarningDialog
          project={project}
          report={ctrlArrowWarning.report}
          onCancel={() => setCtrlArrowWarning(null)}
          onContinue={() => {
            ctrlArrowWarning.mutation()
            setCtrlArrowWarning(null)
          }}
        />
      )}
    </div>
  )
}
