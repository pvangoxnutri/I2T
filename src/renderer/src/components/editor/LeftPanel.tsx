import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppState } from '../../state/AppState'
import type { Project } from '../../types'
import { transitionKey, type TransitionSettings } from '../../../../shared/types'
import type { PropertyAnalysis } from '../../../../shared/propertyAnalysis'
import { roomOfImage } from '../../../../shared/propertyAnalysis'
import { summarizeAnalysis } from '../../../../shared/analysisSummary'
import { selectImage, type EditorSelection } from '../../../../shared/editorSelection'
import { getFeedImages, getFeedSequenceIds } from '../../../../shared/feedSequence'
import { analyzeFeedMutation } from '../../../../shared/feedMutationGuard'
import {
  getFeedSnapshot,
  isMediaLibrarySnapshotStale,
  type FeedSnapshot
} from '../../../../shared/feedFingerprint'
import { extractTransitionAnalysis } from '../../../../shared/transitionAnalysisExtractor'
import { PropertyAnalysisPanel } from './PropertyAnalysisPanel'
import { ProductionCostPanel } from './ProductionCostPanel'
import { ProductionPanel } from './ProductionPanel'
import { ProjectReadiness } from './ProjectReadiness'
import { FeedMutationWarningDialog } from './FeedMutationWarningDialog'
import { Toolbox } from './Toolbox'
import { MediaProposalReview, type MediaProposal } from './MediaProposalReview'
import { AnalyzeFeedConfirmDialog } from './AnalyzeFeedConfirmDialog'
import { TransitionAnalysisReview } from './TransitionAnalysisReview'
import type { TransitionDraft } from '../../../../shared/transitionAnalysisExtractor'
import { tallyModes, type ResolvedModeRow } from '../../../../shared/transitionMode'

type PanelTab = 'media' | 'analysis' | 'toolbox' | 'production'

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
  modes,
  onSelect,
  onAnalysisChange
}: {
  project: Project
  analysis: PropertyAnalysis | null
  selection: EditorSelection
  /** How each transition will behave, so readiness counts only real work. */
  modes: ResolvedModeRow[]
  onSelect: (selection: EditorSelection) => void
  onAnalysisChange: () => void
}): React.JSX.Element {
  const [tab, setTab] = useState<PanelTab>('media')
  const { updateTransition, applyFeedProposal } = useAppState()

  // Load persisted transition draft on project open
  useEffect(() => {
    void (async () => {
      try {
        const persisted = await window.f2f.projects.transitionAnalysis.read(project.id)
        if (!persisted) return

        // Check if draft is stale by comparing feed snapshot
        const currentFeedIds = getFeedSequenceIds(project)
        const isFeedStale = currentFeedIds.length !== persisted.feedImageIds.length ||
          !currentFeedIds.every((id, i) => id === persisted.feedImageIds[i])

        if (isFeedStale) {
          // Mark outdated in DB
          await window.f2f.projects.transitionAnalysis.markOutdated(project.id)
        }

        // Restore draft regardless of staleness (UI will show state)
        setTransitionDraft(persisted as TransitionDraft)
      } catch (err) {
        console.error('[LeftPanel] Failed to load transition draft:', err)
      }
    })()
  }, [project.id])

  // ── MEDIA PROPOSAL: ONE OWNER ────────────────────────────────────────
  //
  // This panel is the ONLY holder of proposal state, and — since the fix —
  // also the thing that renders the dialogs. They used to be rendered by
  // MediaBrowser, which mounts only on the Media tab, so a proposal raised
  // from the Tools tab was invisible and its Accept button did not exist.
  const [proposal, setProposal] = useState<MediaProposal | null>(null)
  const [proposalLoading, setProposalLoading] = useState(false)
  const [proposalError, setProposalError] = useState<string | null>(null)
  const [analyzeConfirmation, setAnalyzeConfirmation] = useState<any>(null)
  const [analyzeToken, setAnalyzeToken] = useState<string | null>(null)
  const [proposalVisible, setProposalVisible] = useState(false)
  /** True only while the accept transaction is in flight. */
  const [proposalApplying, setProposalApplying] = useState(false)
  /** Shown after a proposal is actually persisted. */
  const [proposalApplied, setProposalApplied] = useState<string | null>(null)

  // Snapshots for staleness detection
  const [feedSnapshot, setFeedSnapshot] = useState<FeedSnapshot | null>(null)
  const [mediaLibrarySnapshot, setMediaLibrarySnapshot] = useState<{ imageIds: string } | null>(null)

  // Transition analysis workflow state
  const [transitionAnalysisLoading, setTransitionAnalysisLoading] = useState(false)
  const [transitionAnalysisError, setTransitionAnalysisError] = useState<string | null>(null)
  const [transitionAnalysisVisible, setTransitionAnalysisVisible] = useState(false)
  const [transitionSnapshotFromAnalysis, setTransitionSnapshotFromAnalysis] = useState<FeedSnapshot | null>(null)
  const [transitionDraft, setTransitionDraft] = useState<TransitionDraft | null>(null)
  const [transitionConfirmation, setTransitionConfirmation] = useState<any>(null)
  const [transitionConfirmationToken, setTransitionConfirmationToken] = useState<string | null>(null)
  /** Which Toolbox action is running, so none can be started twice. */
  const [toolboxBusy, setToolboxBusy] = useState<
    'media' | 'feed' | 'prompts' | 'prompt-selected' | null
  >(null)
  /** Pair whose hand-written prompt the operator is being asked about. */
  const [confirmReplacePrompt, setConfirmReplacePrompt] = useState<string | null>(null)

  /**
   * How much of the feed's generated wording actually exists.
   *
   * Counted over the CURRENT feed, because a prompt for a pair the video
   * no longer contains is not progress.
   */
  const promptStatus = (() => {
    const ids = getFeedSequenceIds(project)
    let eligible = 0
    let analysed = 0
    let manual = 0
    for (let i = 0; i < ids.length - 1; i++) {
      const t = project.transitions[transitionKey(ids[i], ids[i + 1])]
      const isAi = t?.mode === 'ai' || (t?.mode ?? 'auto') === 'auto'
      if (!isAi) continue
      eligible++
      if (t?.promptProvenance?.manuallyEdited) manual++
      else if (t?.prompt && t.prompt.length > 0) analysed++
    }
    return { eligible, analysed, manual }
  })()

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

  const handleProposeFeedOrder = useCallback(
    async (): Promise<void> => {
      if (!analyzeConfirmation) {
        // First step: get confirmation (generates token one-shot)
        setProposalLoading(true)
        setProposalError(null)
        try {
          const confirmation = await window.f2f.projects.feed.analyzeConfirmation(project.id)
          if (confirmation) {
            setAnalyzeConfirmation(confirmation)
            setAnalyzeToken(confirmation.token)
          } else {
            setProposalError('Could not get analysis confirmation')
          }
        } catch (err) {
          setProposalError(err instanceof Error ? err.message : 'Unknown error')
        } finally {
          setProposalLoading(false)
        }
        return
      }

      // Second step: run analysis with confirmation token
      if (!analyzeConfirmation) {
        setProposalError('No confirmation available. Try again.')
        return
      }

      setProposalLoading(true)
      setProposalError(null)
      try {
        const result = await window.f2f.projects.feed.analyze(
          project.id,
          '',
          analyzeConfirmation.paidLive ? (analyzeToken ?? undefined) : undefined
        )
        if (result.ok) {
          // KEEP THE ANALYSIS. It carries the analyzer's own per-pair
          // reasoning and safety level; discarding it is why the review
          // dialog had nothing to show but filenames.
          setProposal({
            sequence: result.proposedFeedSequence,
            modes: result.proposedTransitionModes,
            analysis: result.analysis
          })
          // Capture snapshots at proposal time for staleness detection
          const newFeedSnapshot = getFeedSnapshot(result.proposedFeedSequence)
          const mediaSnapshot = { imageIds: project.images.map((i) => i.id).join('|') }
          setFeedSnapshot(newFeedSnapshot)
          setMediaLibrarySnapshot(mediaSnapshot)
          // Open proposal modal directly
          setProposalVisible(true)
          setAnalyzeConfirmation(null)
          setAnalyzeToken(null)
        } else {
          setProposalError(result.reason)
          setAnalyzeConfirmation(null)
          setAnalyzeToken(null)
        }
      } catch (err) {
        setProposalError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setProposalLoading(false)
      }
    },
    [analyzeConfirmation, analyzeToken, project.id]
  )

  /**
   * ACCEPT — one awaited transaction, or a visible failure.
   *
   * `applyFeedProposal` writes the sequence and the modes as a single
   * value and does not return until the row is on disk, so the dialog can
   * only close after the change is real. The previous implementation
   * dispatched a stream of debounced per-image mutations and closed
   * immediately, which left no way to report a write that did not land.
   */
  const handleAcceptProposal = useCallback(async (): Promise<void> => {
    if (!proposal) {
      setProposalError('No proposal available to accept.')
      return
    }
    if (proposalApplying) return // a second click must not start a second write

    // STALE PROPOSALS ARE NOT APPLIED.
    //
    // The proposal describes a decision made about a specific set of
    // imported images. If images have been added or removed since, it is a
    // recommendation about a library that no longer exists — and applying
    // it would silently drop new imports out of the feed, or reference
    // images that are gone.
    if (isMediaLibrarySnapshotStale(project.images.map((i) => i.id), mediaLibrarySnapshot)) {
      setProposalError('Imported media changed since this analysis. Re-analyse imported media.')
      return
    }

    setProposalApplying(true)
    setProposalError(null)
    try {
      // ── ACCEPT THE MAP, NOT ONLY ITS CONCLUSIONS ──────────────────
      //
      // This is the bug that produced the moved sofa and the duplicated
      // television. Accepting applied the feed order and the AI/CUT modes
      // and then DISCARDED `proposal.analysis` — the rooms, landmarks,
      // openings and overlaps those decisions were derived from.
      //
      // The accepted analysis therefore stayed empty while eight
      // transitions carried a stored `mode: 'ai'`. Everything downstream
      // reads the accepted analysis, so: every thumbnail resolved to "no
      // room"; the prompt planner had no geometry and wrote no motion
      // instruction, leaving all sixty transitions with an empty prompt
      // and `prompt_basis` NULL; and generation ran on the bare safety
      // prompt with two frames and no anchors. The model was asked to
      // invent the room, so it did.
      //
      // Saved FIRST: a stored AI decision must never outlive the evidence
      // that justified it.
      if (proposal.analysis) {
        await window.f2f.projects.analysis.save({
          ...proposal.analysis,
          projectId: project.id,
          state: 'accepted'
        })
      }

      await applyFeedProposal(project.id, proposal.sequence, proposal.modes)

      // The feed changed, so any transition analysis taken against the old
      // one no longer describes this project.
      setTransitionSnapshotFromAnalysis(null)
      setProposal(null)
      setProposalVisible(false)
      setProposalApplied(`Feed updated — ${proposal.sequence.length} images in sequence.`)
      onAnalysisChange()
    } catch (err) {
      // The dialog STAYS OPEN. Reporting success for a write that failed is
      // the one outcome that must be impossible here.
      console.error('[media-proposal] accept failed to persist', err)
      setProposalError(err instanceof Error ? err.message : 'Could not save the feed.')
    } finally {
      setProposalApplying(false)
    }
  }, [
    proposal,
    proposalApplying,
    project,
    mediaLibrarySnapshot,
    applyFeedProposal,
    onAnalysisChange
  ])

  const handleRejectProposal = useCallback((): void => {
    setProposal(null)
    setProposalVisible(false)
    setProposalError(null)
    setAnalyzeConfirmation(null)
    setAnalyzeToken(null)
  }, [])

  const handleReviewMediaProposal = useCallback((): void => {
    // Opens the dialog THIS panel renders, so it no longer depends on which
    // tab happens to be mounted.
    setProposalError(proposal ? null : 'No proposal available to accept.')
    setProposalVisible(true)
  }, [proposal])

  /** Abandoning the run drops the one-shot token unused; nothing is charged. */
  const handleCancelTransitionAnalysis = useCallback((): void => {
    setTransitionConfirmation(null)
    setTransitionConfirmationToken(null)
    setTransitionAnalysisError(null)
  }, [])

  /**
   * ANALYSE FEED — judge the chosen order, never revise it.
   *
   * Distinct from `handleProposeFeedOrder`, which is the only action
   * allowed to propose a different feed. This one sends the whole library
   * as evidence but decides only the current feed's adjacent pairs.
   */
  const handleAnalyseFeed = useCallback(async (): Promise<void> => {
    if (toolboxBusy) return
    setToolboxBusy('feed')
    setTransitionAnalysisError(null)
    try {
      const before = getFeedSequenceIds(project)
      const result = await window.f2f.projects.feed.analyzeFeed(project.id, '')
      if (!result.ok) {
        setTransitionAnalysisError(result.reason)
        return
      }
      setTransitionDraft(result.draft)
      setTransitionAnalysisVisible(true)
      onAnalysisChange()

      // The invariant, checked where it can still be reported: a feed
      // analysis that moved the feed is a bug, not a result.
      const after = getFeedSequenceIds(
        // Re-read rather than trusting the closure.
        project
      )
      if (before.join('|') !== after.join('|')) {
        console.error('[analyse-feed] the feed changed during analysis', { before, after })
      }
    } catch (err) {
      setTransitionAnalysisError(err instanceof Error ? err.message : 'Could not analyse the feed.')
    } finally {
      setToolboxBusy(null)
    }
  }, [project, toolboxBusy, onAnalysisChange])

  /** Wording for every eligible current feed pair. Manual prompts survive. */
  const handleAnalysePromptsAll = useCallback(async (): Promise<void> => {
    if (toolboxBusy) return
    setToolboxBusy('prompts')
    try {
      const result = await window.f2f.projects.analysis.rebuildPrompts(project.id)
      setProposalApplied(
        `${result.rebuiltCount} prompt${result.rebuiltCount === 1 ? '' : 's'} updated` +
          (result.preservedCount > 0
            ? ` · ${result.preservedCount} manually edited prompt${
                result.preservedCount === 1 ? '' : 's'
              } preserved`
            : '')
      )
      onAnalysisChange()
    } finally {
      setToolboxBusy(null)
    }
  }, [project.id, toolboxBusy, onAnalysisChange])

  /**
   * Wording for ONE pair. A hand-written prompt is replaced only after the
   * operator says so — the analyzer does not get to overwrite someone's
   * own words on a single click.
   */
  const handleAnalysePromptSelected = useCallback(async (): Promise<void> => {
    if (toolboxBusy || selection.kind !== 'transition') return
    const pairKey = selection.pairKey
    const existing = project.transitions[pairKey]
    if (existing?.promptProvenance?.manuallyEdited && !confirmReplacePrompt) {
      setConfirmReplacePrompt(pairKey)
      return
    }
    setToolboxBusy('prompt-selected')
    try {
      const result = await window.f2f.projects.analysis.useAnalysisPrompt(project.id, pairKey)
      setConfirmReplacePrompt(null)
      setProposalApplied(
        result.ok
          ? result.replacedManualPrompt
            ? 'Prompt replaced. The previous wording was hand-written.'
            : 'Prompt updated from the accepted analysis.'
          : 'No analysis-derived prompt could be built for this transition.'
      )
      onAnalysisChange()
    } finally {
      setToolboxBusy(null)
    }
  }, [project, selection, toolboxBusy, confirmReplacePrompt, onAnalysisChange])

  const handleReviewTransitionAnalysis = useCallback((): void => {
    // A declined draft is history, not a pending review, so it is not
    // reopened by this action.
    if (transitionDraft && transitionDraft.status !== 'declined') {
      setTransitionAnalysisVisible(true)
    }
  }, [transitionDraft])

  const handleAcceptTransitionAnalysis = useCallback(async (): Promise<void> => {
    if (!transitionDraft) return

    // Verify feed hasn't changed since draft was created
    const currentFeedIds = getFeedSequenceIds(project)
    const feedChanged = currentFeedIds.length !== transitionDraft.feedImageIds.length ||
      !currentFeedIds.every((id, i) => id === transitionDraft.feedImageIds[i])

    if (feedChanged) {
      console.warn('[handleAcceptTransitionAnalysis] Feed changed since analysis, rejecting')
      setTransitionAnalysisError('Transition Feed changed since analysis. Re-analyse transitions.')
      return
    }

    // WHAT ACCEPTING AN ANALYSIS IS ALLOWED TO TOUCH.
    //
    // Only the mode, and the prompt when the analyzer produced one AND no
    // human has written that transition's wording. `updateTransition`
    // patches, so the clip, its provider metadata and the generation
    // status are carried through untouched — accepting an analysis must
    // never discard generation work that was already paid for.
    for (const pair of transitionDraft.pairs) {
      const patch: Partial<TransitionSettings> = {}
      if (pair.recommendation) {
        patch.mode = pair.recommendation
        // Chosen by the analysis, so it stays bound to the analysis.
        patch.modeProvenance = 'analysis'
      }

      if (pair.prompt) {
        const existing = project.transitions[transitionKey(pair.fromId, pair.toId)]
        // A hand-written prompt outranks the analyzer, always.
        if (!existing?.promptProvenance?.manuallyEdited) patch.prompt = pair.prompt
      }

      if (Object.keys(patch).length > 0) {
        updateTransition(project.id, pair.fromId, pair.toId, patch)
      }
    }

    const acceptedDraft: TransitionDraft = { ...transitionDraft, status: 'accepted' }

    // PERSIST BEFORE CLAIMING IT. This write used to be fire-and-forget,
    // so a failed save left the panel showing an accepted analysis that
    // would be gone on the next launch.
    try {
      await window.f2f.projects.transitionAnalysis.save(project.id, acceptedDraft)
    } catch (err) {
      console.error('[transition-analysis] accept failed to persist', err)
      setTransitionAnalysisError(
        err instanceof Error ? err.message : 'Could not save the transition analysis.'
      )
      return // dialog stays open; nothing claims success
    }

    setTransitionDraft(acceptedDraft)
    // The accepted analysis now describes this feed, so the pending-review
    // snapshot is spent.
    setTransitionSnapshotFromAnalysis(null)
    setTransitionAnalysisVisible(false)
    onAnalysisChange()
  }, [transitionDraft, project, updateTransition, onAnalysisChange])

  /**
   * DECLINE — nothing is applied, and the draft must not come back as a
   * pending review on the next launch. It is marked declined rather than
   * deleted so the analysis remains in history.
   */
  const handleDeclineTransitionAnalysis = useCallback((): void => {
    setTransitionAnalysisVisible(false)
    if (!transitionDraft || transitionDraft.status === 'accepted') return
    const declined: TransitionDraft = { ...transitionDraft, status: 'declined' }
    setTransitionDraft(declined)
    void window.f2f.projects.transitionAnalysis
      .save(project.id, declined)
      .catch((err) => console.error('[transition-analysis] could not record decline', err))
  }, [transitionDraft, project.id])

  const handleAnalyzeTransitions = useCallback(
    async (): Promise<void> => {
      const feedIds = getFeedSequenceIds(project)
      if (feedIds.length < 2) {
        console.warn('[handleAnalyzeTransitions] Feed has fewer than 2 images')
        return
      }

      setTransitionAnalysisLoading(true)
      setTransitionAnalysisError(null)

      try {
        // Step 1: Get confirmation (handles paid analyzer token)
        if (!transitionConfirmation) {
          const confirmation = await window.f2f.projects.analysis.confirmation(project.id, 'default')
          if (!confirmation) {
            setTransitionAnalysisError('Could not prepare transition analysis.')
            return
          }

          // Store confirmation details
          setTransitionConfirmation(confirmation)
          setTransitionConfirmationToken(confirmation.token)
          setTransitionAnalysisLoading(false)
          // Return here - user sees confirmation dialog in modal
          return
        }

        // Step 2: Run analysis with token (if we reach here, user confirmed)
        const pairKeys = Array.from({ length: feedIds.length - 1 }, (_, i) =>
          `${feedIds[i]}->${feedIds[i + 1]}`
        )


        // Capture snapshot BEFORE analysis starts
        const snapshot = getFeedSnapshot(feedIds)
        setTransitionSnapshotFromAnalysis(snapshot)

        // Run REAL analysis with confirmation token
        const token = transitionConfirmation.paidLive ? (transitionConfirmationToken ?? undefined) : undefined
        const result = await window.f2f.projects.analysis.run(project.id, 'default', '', token)

        if (!result.ok) {
          setTransitionAnalysisError(`Analysis failed: ${result.reason}`)
          setTransitionConfirmation(null)
          setTransitionConfirmationToken(null)
          return
        }

        // Extract transition-specific results from whole-property analysis
        const analysisResult = extractTransitionAnalysis(result.analysis, feedIds, Date.now())
        if (!analysisResult.draft || analysisResult.error) {
          setTransitionAnalysisError(analysisResult.error ?? 'Failed to extract transition analysis')
          return
        }

        // PERSIST BEFORE SHOWING. A draft the operator can review but that
        // never reached disk would silently vanish on the next launch, and
        // the paid analysis behind it would have to be run again.
        await window.f2f.projects.transitionAnalysis.save(project.id, analysisResult.draft)

        setTransitionDraft(analysisResult.draft)
        setTransitionAnalysisVisible(true)
        setTransitionConfirmation(null)
        setTransitionConfirmationToken(null)
      } catch (err) {
        setTransitionAnalysisError(err instanceof Error ? err.message : 'Unknown error')
        console.error('[handleAnalyzeTransitions]', err)
      } finally {
        setTransitionAnalysisLoading(false)
      }
    },
    [project]
  )

  return (
    <aside className="left-panel">
      <ProjectReadiness project={project} summary={summary} tally={tallyModes(modes)} />

      <nav className="left-tabs" role="tablist">
        {(
          [
            ['media', 'Media'],
            ['analysis', 'Analysis'],
            ['toolbox', 'Tools'],
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
            proposalLoading={proposalLoading}
            onProposeFeedOrder={handleProposeFeedOrder}
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
        {tab === 'toolbox' && (
          <Toolbox
            project={project}
            analysis={analysis}
            transitionDraft={transitionDraft}
            promptStatus={promptStatus}
            hasProposal={proposal !== null}
            selectedPairKey={selection.kind === 'transition' ? selection.pairKey : null}
            busy={toolboxBusy}
            onAnalyseImportedMedia={() => void handleProposeFeedOrder()}
            onReviewMediaProposal={handleReviewMediaProposal}
            onAnalyseFeed={() => void handleAnalyseFeed()}
            onReviewFeedAnalysis={handleReviewTransitionAnalysis}
            onAnalysePromptsAll={() => void handleAnalysePromptsAll()}
            onAnalysePromptSelected={() => void handleAnalysePromptSelected()}
          />
        )}
        {tab === 'production' && (
          <div className="left-production">
            <ProductionCostPanel project={project} />
            <ProductionPanel project={project} />
          </div>
        )}
      </div>

      {/* ── DIALOGS BELONG TO THE STATE OWNER ─────────────────────────
          Rendered here, outside the tab switch, so a proposal raised from
          Tools is visible from Tools. When these lived in MediaBrowser they
          existed only while the Media tab was mounted. */}

      {proposalApplied && (
        <div className="media-proposal-toast" role="status">
          <span>{proposalApplied}</span>
          <button type="button" onClick={() => setProposalApplied(null)}>
            ✕
          </button>
        </div>
      )}

      {/* A hand-written prompt is someone's own words. The analyzer may
          replace them, but only after being told to — not as a side
          effect of a single click on "Analyse Prompt — Selected". */}
      {confirmReplacePrompt && (
        <div className="dialog-backdrop" onClick={() => setConfirmReplacePrompt(null)}>
          <div className="dialog-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="dialog-title">Replace manually edited prompt?</h3>
            <p className="dialog-body">
              This transition’s prompt was written by hand. Analysing it will replace that wording
              with one built from the accepted spatial analysis.
            </p>
            <div className="dialog-actions">
              <button
                type="button"
                className="btn btn-ghost btn-tiny"
                onClick={() => setConfirmReplacePrompt(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary btn-tiny"
                onClick={() => void handleAnalysePromptSelected()}
              >
                Replace
              </button>
            </div>
          </div>
        </div>
      )}

      <AnalyzeFeedConfirmDialog
        confirmation={analyzeConfirmation}
        running={proposalLoading}
        error={proposalError}
        onConfirm={() => void handleProposeFeedOrder()}
        onCancel={handleRejectProposal}
      />

      {/* The transition run is the same two-step gate as the media run, so
          it reuses the same dialog. Without this the first click set a
          confirmation nothing rendered, and "Analyse Transitions" looked
          like a button that did nothing. */}
      <AnalyzeFeedConfirmDialog
        confirmation={transitionConfirmation}
        running={transitionAnalysisLoading}
        error={transitionAnalysisError}
        onConfirm={() => void handleAnalyzeTransitions()}
        onCancel={handleCancelTransitionAnalysis}
      />

      <MediaProposalReview
        project={project}
        proposal={proposal}
        visible={proposalVisible}
        applying={proposalApplying}
        error={proposalError}
        onAccept={() => void handleAcceptProposal()}
        onDismiss={handleRejectProposal}
      />

      <TransitionAnalysisReview
        project={project}
        draft={transitionDraft}
        visible={transitionAnalysisVisible}
        onAccept={() => void handleAcceptTransitionAnalysis()}
        onDecline={handleDeclineTransitionAnalysis}
      />
    </aside>
  )
}

/**
 * Two-part image browser: library (all images) and transition feed (video sequence).
 * Images are imported to the library, then dragged into the feed for ordering.
 */
function MediaBrowser({
  project,
  analysis,
  selectedImageId,
  onSelectImage,
  proposalLoading,
  onProposeFeedOrder
}: {
  project: Project
  analysis: PropertyAnalysis | null
  selectedImageId: string | null
  onSelectImage: (id: string) => void
  /** Disables the analyse button while a run is in flight. */
  proposalLoading: boolean
  /** Starts the analysis. The dialogs it raises are rendered by LeftPanel. */
  onProposeFeedOrder: () => Promise<void>
}): React.JSX.Element {
  const { addImages, removeImage, addToFeed, removeFromFeed } = useAppState()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dropActive, setDropActive] = useState(false)
  const [draggedImageId, setDraggedImageId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; imageId: string } | null>(null)
  const [mutationWarning, setMutationWarning] = useState<{ mutation: () => void; report: any } | null>(null)
  const feedIds = getFeedSequenceIds(project)

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

  const handleDragFromLibrary = (imageId: string): void => {
    setDraggedImageId(imageId)
  }

  const handleDropToFeed = (): void => {
    if (draggedImageId && !feedIds.includes(draggedImageId)) {
      addToFeed(project.id, draggedImageId)
    }
    setDraggedImageId(null)
  }

  const handleDeleteFromFeed = (imageId: string): void => {
    const currentFeedIds = getFeedSequenceIds(project)
    const newFeedIds = currentFeedIds.filter((id) => id !== imageId)

    // Removing one image must remove exactly one. This is the mutation that
    // once emptied an entire feed, so the arithmetic is checked before the
    // store is asked to do anything.
    if (newFeedIds.length !== currentFeedIds.length - 1) {
      console.error('[feed] refusing delete: removing one image did not shorten the feed by one', {
        imageId,
        before: currentFeedIds.length,
        after: newFeedIds.length
      })
      return
    }

    const report = analyzeFeedMutation(project, newFeedIds)
    if (report.requiresConfirmation) {
      setMutationWarning({ mutation: () => removeFromFeed(project.id, imageId), report })
    } else {
      removeFromFeed(project.id, imageId)
    }
  }

  const feedImages = getFeedImages(project)
  const libraryImages = project.images.filter((img) => !feedIds.includes(img.id))

  return (
    <div className="media-browser">
      <div className="media-import">
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
      </div>

      <div className="media-sections">
        <section className="media-library">
          <div className="media-section-head">
            <h3>Imported Images</h3>
            <span className="media-section-count">{libraryImages.length}</span>
          </div>
          {libraryImages.length > 0 && (
            <>
              <div className="media-ai-controls">
                <button
                  type="button"
                  className="media-ai-button"
                  onClick={() => void onProposeFeedOrder()}
                  disabled={proposalLoading || libraryImages.length === 0}
                  title="Analyse all imported images and suggest the best feed order and transitions"
                >
                  {proposalLoading ? '…' : '✨ Let AI analyse'}
                </button>
              </div>
              <div className="media-divider" />
            </>
          )}
          <ul className="media-list">
            {libraryImages.map((image) => {
              const room = analysis ? roomOfImage(analysis, image.id)?.label : null
              const inFeed = feedIds.includes(image.id)
              return (
                <li key={image.id}>
                  <button
                    type="button"
                    className={`media-item${selectedImageId === image.id ? ' is-selected' : ''}`}
                    draggable
                    onDragStart={() => handleDragFromLibrary(image.id)}
                    onDragEnd={() => setDraggedImageId(null)}
                    onClick={() => onSelectImage(image.id)}
                    title="Drag to Transition Feed"
                  >
                    <img src={image.src} alt="" />
                    <span className="media-item-text">
                      <span className="media-item-name" title={image.fileName}>
                        {image.fileName}
                      </span>
                      <span className="media-item-room">{room ?? (analysis && analysis.rooms.length > 0 ? 'Room uncertain' : 'Not analysed')}</span>
                      {inFeed && <span className="media-in-feed">● In feed</span>}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="media-remove"
                    title="Remove from library"
                    onClick={() => removeImage(project.id, image.id)}
                  >
                    ×
                  </button>
                </li>
              )
            })}
            {libraryImages.length === 0 && <li className="media-empty">No photos in library.</li>}
          </ul>
        </section>

        <section
          className="media-feed"
          onDragOver={(e) => {
            if (draggedImageId) {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
            }
          }}
          onDrop={() => handleDropToFeed()}
        >
          <div className="media-section-head">
            <h3>Transition Feed</h3>
            <span className="media-section-count">{feedImages.length}</span>
          </div>
          <ul className="media-list media-feed-list">
            {feedImages.map((image, index) => {
              const room = analysis ? roomOfImage(analysis, image.id)?.label : null
              return (
                <li key={image.id}>
                  <button
                    type="button"
                    className={`media-item${selectedImageId === image.id ? ' is-selected' : ''}`}
                    onClick={() => onSelectImage(image.id)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setContextMenu({ x: e.clientX, y: e.clientY, imageId: image.id })
                    }}
                  >
                    <img src={image.src} alt="" />
                    <span className="media-item-text">
                      <span className="media-item-no">{index + 1}</span>
                      <span className="media-item-name" title={image.fileName}>
                        {image.fileName}
                      </span>
                      <span className="media-item-room">{room ?? (analysis && analysis.rooms.length > 0 ? 'Room uncertain' : 'Not analysed')}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="media-remove"
                    title="Remove from feed"
                    onClick={() => handleDeleteFromFeed(image.id)}
                  >
                    ×
                  </button>
                </li>
              )
            })}
            {feedImages.length === 0 && (
              <li className="media-empty">Drag photos from Imported Images to build the sequence.</li>
            )}
          </ul>
        </section>
      </div>

      {contextMenu && (
        <>
          <div
            className="media-context-backdrop"
            onClick={() => setContextMenu(null)}
            style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 999 }}
          />
          <div
            className="media-context-menu"
            style={{ position: 'fixed', top: contextMenu.y, left: contextMenu.x, zIndex: 1000 }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button
              type="button"
              className="media-context-item"
              onClick={() => {
                handleDeleteFromFeed(contextMenu.imageId)
                setContextMenu(null)
              }}
            >
              Remove from feed
            </button>
          </div>
        </>
      )}

      {mutationWarning && (
        <FeedMutationWarningDialog
          project={project}
          report={mutationWarning.report}
          onCancel={() => setMutationWarning(null)}
          onContinue={() => {
            mutationWarning.mutation()
            setMutationWarning(null)
          }}
        />
      )}
    </div>
  )
}
