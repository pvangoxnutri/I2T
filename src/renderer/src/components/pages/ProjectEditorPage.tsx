import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppState } from '../../state/AppState'
import type { PropertyAnalysis } from '../../../../shared/propertyAnalysis'
import type { GenerationRecord } from '../../../../shared/types'
import {
  inspectorModeFor,
  previewModeFor,
  reconcileSelection,
  resolveShortcut,
  selectFullVideo,
  selectImage,
  selectTransition,
  selectMotion,
  selectTimeline,
  selectedMotionId,
  type EditorSelection
} from '../../../../shared/editorSelection'
import { getFeedImages, getFeedSequenceIds } from '../../../../shared/feedSequence'
import { transitionKey } from '../../types'
import { useLiveGeneration } from '../../hooks/useLiveGeneration'
import { EditorToolbar } from '../editor/EditorToolbar'
import { LeftPanel } from '../editor/LeftPanel'
import { PreviewStage } from '../editor/PreviewStage'
import { TimelineStrip } from '../editor/TimelineStrip'
import { TransitionInspector } from '../editor/TransitionInspector'
import { ImageInspector } from '../editor/ImageInspector'
import { MotionInspector } from '../editor/MotionInspector'
import { TimelineEditor } from '../editor/TimelineEditor'
import { ExportDrawer } from '../editor/ExportDrawer'
import { CustomerDetailsDrawer } from '../editor/CustomerDetailsDrawer'
import { ProjectCatalogue } from '../editor/ProjectCatalogue'
import {
  latestJobForPair,
  transitionRecovery,
  type TransitionRecovery
} from '../../../../shared/transitionRecovery'
import { pairIndexOf } from '../../../../shared/previewSource'
import { feedTransitionState } from '../../../../shared/feedTransitionState'
import { analyzeFeedMutation, type FeedMutationReport } from '../../../../shared/feedMutationGuard'
import { FeedMutationWarningDialog } from '../editor/FeedMutationWarningDialog'
import type { ResolvedModeRow } from '../../../../shared/transitionMode'
import type { TimelineViewPayload } from '../../../../shared/timeline'

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
  /** The generation Review quality asked to look at, if any. */
  const [focusGeneration, setFocusGeneration] = useState<string | null>(null)
  /**
   * Every generation in this project, so the recovery offered for the
   * selected transition knows whether a clip was downloaded and then
   * rejected. Without it the panel reads "no clip" and offers a free
   * re-download of a file already on disk.
   */
  const [generations, setGenerations] = useState<GenerationRecord[]>([])
  /**
   * Regenerate, driven from Generation History.
   *
   * The SAME hook the inspector uses, so there is exactly one paid path
   * in the renderer: confirmation payload from main, dialog, then submit
   * with the one-shot token. A second copy here would be a second place
   * for a spending guard to go missing.
   */
  const liveGeneration = useLiveGeneration(projectId, refreshProjects)
  const [analysis, setAnalysis] = useState<PropertyAnalysis | null>(null)
  // Bumped whenever a manual override changes, so the effective analysis
  // — and therefore every plan derived from it — is re-read.
  const [factsNonce, setFactsNonce] = useState(0)
  // How every transition will actually behave — generated, cut or
  // dissolved. Resolved once in main so the timeline, both inspectors,
  // readiness and the cost estimate cannot disagree.
  const [modes, setModes] = useState<ResolvedModeRow[]>([])
  const [generateOpening, setGenerateOpening] = useState(false)
  /**
   * Bumped ONLY by keyboard navigation.
   *
   * The timeline scrolls the selection into view when this changes and at
   * no other time, so an ordinary click can never move the track.
   */
  const [keyboardNavNonce, setKeyboardNavNonce] = useState(0)
  const [ctrlArrowWarning, setCtrlArrowWarning] = useState<{ mutation: () => void; report: FeedMutationReport } | null>(null)
  /**
   * THE FINAL EDIT, OWNED HERE.
   *
   * ── WHY THE PAGE HOLDS IT ──────────────────────────────────────────
   *
   * The timeline component used to fetch this itself AND keep its own
   * selected item and playhead, beside its own hidden <video>. That is
   * two preview states: a feed click and a timeline click could each
   * believe they owned the screen, and whichever re-rendered last won.
   *
   * One owner. The page fetches it, the timeline strip renders it, and
   * the preview resolves the playhead from the SAME list — so they
   * cannot disagree even for a frame.
   */
  const [timelineView, setTimelineView] = useState<TimelineViewPayload | null>(null)
  /**
   * Transport state, owned here for the same reason the selection is:
   * the timeline header and the preview both have a play button, and two
   * copies of "is it playing" would let one show a pause glyph while the
   * other showed play.
   */
  const [timelinePlaying, setTimelinePlaying] = useState(false)
  /**
   * PREVIEW LAYER VISIBILITY — editor-local, deliberately.
   *
   * Not persisted, and not part of the branding config. This answers
   * "what do I want to look at right now", which is a property of the
   * session rather than of the project. The export rasterises from the
   * SAVED branding settings and never reads these, so hiding a layer
   * here cannot change what ships.
   */
  const [showWatermark, setShowWatermark] = useState(true)
  const [showCornerStamp, setShowCornerStamp] = useState(true)

  const project = projects.find((p) => p.id === projectId)

  useEffect(() => {
    void window.f2f.projects.timeline.get(projectId).then(setTimelineView)
  }, [projectId, project?.updatedAt])

  /** The shape `resolvePreviewSource` needs. Null until it has loaded. */
  const timelineSource = timelineView?.timeline
    ? { items: timelineView.timeline.items, defaultSeamSec: timelineView.defaultSeamSec }
    : null

  // The EFFECTIVE analysis: accepted, with manual corrections folded in.
  // Read once here and passed down so the timeline, both inspectors and
  // the left panel describe the same understanding rather than each
  // fetching its own copy and drifting.
  useEffect(() => {
    void window.f2f.projects.analysis.effective(projectId).then(setAnalysis)
  }, [projectId, factsNonce])

  // Re-read when the project moves, so a verdict that lands mid-poll
  // reaches the recovery decision without a restart.
  useEffect(() => {
    void window.f2f.projects.catalogue.getAll(projectId).then(setGenerations)
  }, [projectId, project?.updatedAt])

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
   * Every pair the CURRENT feed contains.
   *
   * Generation History outlives feed edits on purpose — a clip generated
   * for two photographs that are no longer adjacent is still real, still
   * paid for, and still worth keeping. But it cannot be regenerated:
   * there is no such transition any more, and a Regenerate button that
   * quietly bought a clip for a pair the video does not contain would be
   * spending money on nothing.
   */
  const currentPairKeys = project
    ? getFeedImages(project)
        .slice(0, -1)
        .map((img, i) => transitionKey(img.id, getFeedImages(project)[i + 1].id))
    : []

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
        // ARROW-KEY REVIEW IS THE ONE CASE THAT MAY SCROLL.
        //
        // Walking the sequence with the keyboard can step onto something
        // off-screen, and leaving the operator staring at an unchanged
        // strip would make the shortcut look broken. A mouse click cannot
        // reach anything off-screen — they clicked what they could see —
        // so it must never move the track. The nonce is what tells the
        // timeline which of the two just happened.
        setKeyboardNavNonce((n) => n + 1)
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
      // THE SAME HOOK THE INSPECTOR AND THE CATALOGUE USE.
      //
      // This path had its own copy, and the copy had drifted: it opened
      // the confirmation for one pairKey but submitted against
      // selection.pairKey. Those are the same value only while the
      // dialog is open and the selection does not move — so selecting a
      // different transition mid-dialog would have bought a clip for a
      // pair the operator never saw priced. The hook holds the pair it
      // was opened with.
      setGenerateOpening(true)
      liveGeneration.open(pairKey)
      setGenerateOpening(false)
    },
    [projectId, liveGeneration, generations, refreshProjects]
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

  /**
   * The newest generation for a pair — the fact both the displayed word
   * and the offered action have to be derived from.
   */
  const latestGenerationFor = (pairKey: string): GenerationRecord | null => {
    const [from, to] = pairKey.split('->')
    return (
      generations
        .filter((g) => g.fromImageId === from && g.toImageId === to)
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
    )
  }

  /**
   * What the preview pane says about the selected transition.
   *
   * The SAME derivation the timeline uses and the same catalogue facts the
   * Queue reads. The preview had its own reading of `transition.status`
   * and so kept printing "Transition 11 → 12 failed" after the timeline
   * had been taught better.
   */
  const selectedView =
    selection.kind === 'transition'
      ? feedTransitionState(
          project.transitions[selection.pairKey],
          latestGenerationFor(selection.pairKey),
          false
        )
      : null

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
          timeline={timelineSource}
          playing={timelinePlaying}
          onPlayingChange={setTimelinePlaying}
          showWatermark={showWatermark}
          showCornerStamp={showCornerStamp}
          onTimelineSeek={(atSec) =>
            setSelection((prev) =>
              // Only while the timeline owns the preview. A frame update
              // arriving after the operator clicked a transition must not
              // drag the selection back.
              prev.kind === 'timeline' ? selectTimeline(prev.itemId, atSec) : prev
            )
          }
          mode={previewModeFor(selection)}
          onShowFullVideo={() => setSelection(selectFullVideo())}
          recovery={recovery}
          transitionMode={selectedMode ?? null}
          view={selectedView}
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
        generations={generations}
        scrollToSelectionNonce={keyboardNavNonce}
        onSelectImage={(id) => setSelection(selectImage(id))}
        onSelectTransition={(key) => setSelection(selectTransition(key))}
        selectedMotionId={selectedMotionId(selection)}
        onSelectMotion={(id) => setSelection(selectMotion(id))}
      />

      {/* ── THE FINAL EDIT ──────────────────────────────────────────
          Directly under the Feed, because that is the reading order:
          the Feed is what to produce, this is what actually ships.
          Nothing it does writes back into the feed. */}
      <TimelineEditor
        project={project}
        view={timelineView}
        selection={selection}
        onSelect={setSelection}
        onViewChanged={setTimelineView}
        playing={timelinePlaying}
        onPlayingChange={setTimelinePlaying}
        showWatermark={showWatermark}
        showCornerStamp={showCornerStamp}
        onShowWatermarkChange={setShowWatermark}
        onShowCornerStampChange={setShowCornerStamp}
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
      {inspector === 'motion' && (
        <MotionInspector
          project={project}
          segmentId={selection.kind === 'motion' ? selection.segmentId : null}
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
        onClose={() => {
          setCatalogueOpen(false)
          setFocusGeneration(null)
        }}
        // Set when Review quality asked about one specific clip, so the
        // operator lands on it rather than on a list to search.
        focusGenerationId={focusGeneration}
        // THE SAME PAID PATH THE INSPECTOR USES — main builds the
        // confirmation, main enforces readiness, main issues the token.
        // The catalogue only supplies which pair.
        onRegenerate={(from, to) => liveGeneration.open(transitionKey(from, to))}
        // Pairs the CURRENT feed actually contains. A generation whose two
        // photographs are no longer adjacent is history, not something to
        // regenerate — see the note in ProjectCatalogue.
        currentPairKeys={currentPairKeys}
      />

      {/* The unchanged paid-request confirmation. Reached from the preview
          and from the inspector's Generation tab; both build it in main
          and neither can submit without passing through it. */}
      {liveGeneration.dialog}

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
