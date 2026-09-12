import { useEffect, useState } from 'react'
import type { GenerationRecord } from '../../types'
import { qualityAllowsActive } from '../../../../shared/qualityValidation'
import { resolvePairSpatialEvidence } from '../../../../shared/pairEvidence'
import { EVIDENCE_SOURCE_LABEL } from '../../../../shared/pairAnalysis'
import {
  evidenceFingerprintOf,
  isPromptBasisCurrent
} from '../../../../shared/promptPlanner'
import type { EvidenceSource, PairAnalysisRecord } from '../../../../shared/pairAnalysis'
import { useLiveGeneration } from '../../hooks/useLiveGeneration'
import { useAppState } from '../../state/AppState'
import { defaultTransitionSettings, transitionKey, type Project } from '../../types'
import { LiveGenerateDialog } from './LiveGenerateDialog'
import type { LiveConfirmationPayload, ProviderMetadataPayload } from '../../../../preload/index'
import {
  durationChoices,
  resolveTransitionDuration,
  stepDuration
} from '../../../../shared/transitionDuration'
import { markManuallyEdited } from '../../../../shared/promptPlanner'
import { relateImages, type PropertyAnalysis } from '../../../../shared/propertyAnalysis'
import { attemptsForPair, formatSpend, type GenerationCostEntry } from '../../../../shared/costLedger'
import { latestJobForPair, transitionRecovery } from '../../../../shared/transitionRecovery'
import { NEUTRAL_MOTION, planSequence } from '../../../../shared/transitionPlan'
import { pairIndexOf } from '../../../../shared/previewSource'
import { getFeedImages } from '../../../../shared/feedSequence'
import { MODE_LABEL, type ResolvedModeRow } from '../../../../shared/transitionMode'
import { orientationLabel } from '../../../../shared/transitionEvidence'

type Tab = 'motion' | 'prompt' | 'generation' | 'clip'

/**
 * Everything about ONE transition, along the bottom.
 *
 * ── WHY IT MOVED HERE ────────────────────────────────────────────────
 *
 * The prompt, the provider settings and the clip used to live in a tall
 * card per transition, so configuring the third transition meant
 * scrolling past the first two. As a horizontal inspector it is always in
 * the same place, and the timeline above stays visible while you work.
 *
 * Tabs rather than stacking: four small groups that are rarely needed at
 * once, and a panel that never grows past its share of the screen.
 */
export function TransitionInspector({
  project,
  analysis,
  pairKey,
  modes
}: {
  project: Project
  analysis: PropertyAnalysis | null
  pairKey: string | null
  /** Resolved once in main so nothing here can disagree with the timeline. */
  modes: ResolvedModeRow[]
}): React.JSX.Element {
  const { updateTransition, settings, queue, refreshProjects } = useAppState()
  const [tab, setTab] = useState<Tab>('motion')
  /**
   * The paid path, shared with Generation History.
   *
   * Both places that can spend money drive ONE hook — confirmation from
   * main, dialog, submit with the one-shot token — so a guard cannot go
   * missing from one of two copies.
   */
  const live = useLiveGeneration(project.id, refreshProjects)
  const [entries, setEntries] = useState<GenerationCostEntry[]>([])
  const [providerCatalog, setProviderCatalog] = useState<ProviderMetadataPayload[]>([])
  const [confirmClearClip, setConfirmClearClip] = useState(false)
  /** Asked before a NEW paid submit, separately from Resume. */
  const [confirmRegenerate, setConfirmRegenerate] = useState(false)
  const [clipInfo, setClipInfo] = useState<{ exists: boolean; bytes: number } | null>(null)
  const [note, setNote] = useState<string | null>(null)
  /**
   * Every generation for this pair, newest first.
   *
   * ── WHY THE INSPECTOR NEEDS THE WHOLE HISTORY ──────────────────────
   *
   * Shown as Generation History: every attempt for this pair, so an
   * older clip can be brought back without paying again.
   */
  const [history, setHistory] = useState<GenerationRecord[]>([])
  /** This pair's own analysis, when one has ever been run. */
  const [pairRecord, setPairRecord] = useState<PairAnalysisRecord | null>(null)
  /** What main says governs this pair. Null until the first answer. */
  const [currentEvidence, setCurrentEvidence] = useState<{
    source: EvidenceSource
    fingerprint: string
    operatorContextFingerprint?: string
  } | null>(null)
  const [pairBusy, setPairBusy] = useState(false)
  const [pairError, setPairError] = useState<string | null>(null)
  /** Paid confirmation for a single-pair run. Null = nothing pending. */
  const [pairConfirm, setPairConfirm] = useState<{ payload: any; token: string | null } | null>(null)
  /** The result awaiting the operator's decision. Never auto-applied. */
  const [pairReview, setPairReview] = useState<PairAnalysisRecord | null>(null)
  const [pairContext, setPairContext] = useState('')
  const [showSuggestion, setShowSuggestion] = useState(false)

  /**
   * THE PAIR, LOCATED IN THE FEED.
   *
   * ── THE BUG THIS FIXES ─────────────────────────────────────────────
   *
   * This searched `project.images` — the imported LIBRARY — while the
   * preview header resolved the very same `pairKey` through
   * `pairIndexOf`, which reads the FEED. One selection, two lookup
   * lists, and they disagree the moment the feed stops matching library
   * order — which is precisely what accepting a proposal does.
   *
   * The visible result was a header reading "TRANSITION 1 → 2" above an
   * inspector saying "Select a transition in the timeline", about the
   * transition that was already selected.
   *
   * `pairIndexOf` is the canonical lookup and is now the only one used,
   * so the two panes cannot describe different things again.
   */
  const feedImages = getFeedImages(project)
  const index = pairKey ? pairIndexOf(project, pairKey) : -1
  const start = index >= 0 ? feedImages[index] : null
  const end = index >= 0 ? feedImages[index + 1] : null

  /**
   * A TRANSITION EXISTS AS SOON AS TWO PHOTOS ARE ADJACENT.
   *
   * ── THE BUG THIS FIXES ───────────────────────────────────────────────
   *
   * `project.transitions` is keyed by image pair and written LAZILY — a
   * row appears the first time something about that transition is edited.
   * A freshly imported project has thirty photographs, twenty-nine
   * transitions and zero rows.
   *
   * This inspector used to bail out when the row was missing, showing
   * "Select a transition in the timeline to configure it." — the exact
   * message it showed when nothing was selected at all. So clicking a
   * transition selected it, switched the preview and highlighted the
   * block, and the inspector still said "select a transition". It read as
   * the click having done nothing, and there was no way to reach Generate
   * because the panel holding it never rendered.
   *
   * The absence of a settings row means "not configured yet", not "does
   * not exist". Defaults are supplied so the transition can be inspected
   * and generated, and the row is written when something is actually
   * changed — which keeps the lazy-write behaviour the rest of the app
   * relies on.
   */
  const stored = pairKey ? project.transitions[pairKey] : undefined
  const transition =
    stored ?? defaultTransitionSettings(settings.exportDefaults.defaultTransitionDurationSec)

  useEffect(() => {
    if (!pairKey) return
    void window.f2f.projects.cost.entries(project.id).then(setEntries)
  }, [project.id, pairKey, project.updatedAt])

  // Provider capabilities drive which durations may be offered.
  useEffect(() => {
    void window.f2f.providers.catalog().then(setProviderCatalog)
  }, [])

  useEffect(() => {
    const stored = transition?.clip?.storedName
    if (!stored) {
      setClipInfo(null)
      return
    }
    void window.f2f.clips.info(project.id, stored).then(setClipInfo)
  }, [project.id, transition?.clip?.storedName])

  useEffect(() => {
    let cancelled = false
    void window.f2f.projects.catalogue.getAll(project.id).then((all) => {
      if (!cancelled) setHistory(all)
    })
    return () => {
      cancelled = true
    }
    // Re-read when the clip changes: a finished generation is exactly
    // when the newest row and the active row may start disagreeing.
  }, [project.id, transition?.clip?.storedName])

  useEffect(() => {
    if (!pairKey) return
    let cancelled = false
    void window.f2f.projects.pairAnalysis.read(project.id, pairKey).then((r) => {
      if (!cancelled) setPairRecord(r)
    })
    return () => {
      cancelled = true
    }
  }, [project.id, pairKey, project.updatedAt])

  /**
   * WHAT THE GATE SAYS THIS PAIR IS BASED ON — asked, not re-derived.
   *
   * This panel used to resolve precedence itself, passing "a plan exists
   * for this pair" as `coveredByFeedAnalysis`. That is not the same claim
   * as "the accepted feed analysis covers it", so the badge could read
   * current while generation refused the pair, or the reverse. Main owns
   * the answer; the label reports it.
   */
  useEffect(() => {
    if (!pairKey) return
    let cancelled = false
    void window.f2f.projects.pairAnalysis.currentEvidence(project.id, pairKey).then((e) => {
      if (!cancelled) setCurrentEvidence(e)
    })
    return () => {
      cancelled = true
    }
  }, [project.id, pairKey, project.updatedAt])

  // Only a genuinely unresolvable pair falls back — an id that names no
  // adjacent pair in the current order, which a reorder can produce.
  if (!pairKey || !start || !end) {
    return (
      <section className="inspector inspector-empty">
        <p>Select a transition in the timeline to configure it.</p>
      </section>
    )
  }

  // Decided in `shared` from the REMOTE task state — the same answer the
  // preview shows, so the two can never offer different recoveries.
  const recovery = transitionRecovery(
    stored,
    latestJobForPair(queue, project.id, pairKey),
    `${index + 1} → ${index + 2}`
  )

  const mode = modes.find((m) => m.pairKey === pairKey) ?? null
  const hasAnalysis = analysis !== null && analysis.rooms.length > 0
  // The plan for THIS pair, from the whole-sequence planner so continuity
  // is the same value the prompt was built with.
  // PLANNED OVER THE FEED, because `index` is a FEED position. Planning
  // over the library meant feed position N read the plan for library
  // position N — a different pair, and therefore safety reasoning and a
  // motion instruction belonging to two other photographs.
  const plan =
    planSequence(
      analysis,
      feedImages.map((i) => i.id)
    )[index] ?? null
  const relation = analysis ? relateImages(analysis, start.id, end.id) : { kind: 'unknown' as const }
  const attempts = attemptsForPair(entries, pairKey)
  const provider = settings.providers.find(
    (p) => p.id === (settings.activeProviderId ?? settings.providers[0]?.id)
  )
  const providerName = provider?.id === 'fal' ? 'fal.ai' : 'Kling'
  const pendingDownload = transition.clip === null && attempts.length > 0

  // ── ACTIVE CLIP vs LATEST GENERATION ────────────────────────────────
  //
  // Normally the same row. They diverge exactly when the newest
  // generation was inspected and refused, which is the case that must
  // never read as "the regenerate did nothing".
  const pairHistory = history.filter(
    (g) => g.fromImageId === start.id && g.toImageId === end.id
  )
  const latestGeneration = pairHistory[0] ?? null
  const activeGeneration = pairHistory.find((g) => g.active) ?? null

  // WHAT THIS MODEL CAN ACTUALLY BE ASKED FOR.
  //
  // Read from the provider's published capability rather than a literal.
  // The control used to offer [5, 10] from a comment about a model this
  // build no longer points at, while the configured endpoint accepts every
  // integer from 3 to 15 — so most of the range was unreachable, and the
  // reason was a stale hardcode nobody could see from the UI.
  const allowedDurations = durationChoices(
    providerCatalog
      .find((p) => p.id === provider?.id)
      ?.models.find((m) => m.id === provider?.model)?.durationsSec
  )
  const durationSec = resolveTransitionDuration(
    transition,
    settings.exportDefaults.defaultTransitionDurationSec
  )
  // A cut generates nothing, so a generation length is not a question that
  // applies to it.
  const generatesClip = mode ? mode.effectiveMode === 'ai' : true
  const setDuration = (next: number): void =>
    updateTransition(project.id, start.id, end.id, { durationSec: next })

  const openGenerate = (): void => live.open(pairKey)

  /**
   * STEP ONE: confirm. Nothing is spent here.
   *
   * Reuses the same one-shot token the whole-property runs use, so there
   * is exactly one paid analyzer path rather than an ad-hoc second one.
   */
  const openPairConfirmation = async (): Promise<void> => {
    setPairError(null)
    setPairBusy(true)
    try {
      const payload = await window.f2f.projects.analysis.confirmation(project.id, 'gemini')
      if (!payload) {
        setPairError('Could not prepare this analysis. Check the analyzer settings.')
        return
      }
      setPairConfirm({ payload, token: payload.token ?? null })
      console.log('[pair-analyse] confirmation open pair=' + pairKey)
    } catch (err) {
      setPairError(err instanceof Error ? err.message : 'Could not prepare this analysis.')
    } finally {
      setPairBusy(false)
    }
  }

  /** STEP TWO: the operator confirmed. This is what spends. */
  const runPairAnalysis = async (): Promise<void> => {
    if (!pairConfirm) return
    setPairBusy(true)
    setPairError(null)
    try {
      console.log('[pair-analyse] submit pair=' + pairKey)
      const res = await window.f2f.projects.pairAnalysis.analyze(
        project.id,
        pairKey,
        pairConfirm.payload.paidLive ? (pairConfirm.token ?? undefined) : undefined
      )
      setPairConfirm(null)
      if (!res.ok || !res.record) {
        setPairError(res.reason ?? 'The analysis failed.')
        return
      }
      // Reviewed, never applied on arrival.
      setPairReview(res.record)
      setPairContext(transition.operatorContext?.text ?? '')
    } catch (err) {
      setPairError(err instanceof Error ? err.message : 'The analysis failed.')
    } finally {
      setPairBusy(false)
    }
  }

  /** Accept the reviewed pair analysis. Touches only this pair. */
  const acceptPair = async (mode: 'ai' | 'cut', context?: string): Promise<void> => {
    setPairBusy(true)
    setPairError(null)
    try {
      // ONE call. This used to be three — save context, accept, set mode —
      // and the prompt rebuild hung off the last one, judged against a
      // record written before the operator answered. An approved pair
      // could come out the far end still marked as based on outdated
      // evidence, and generation refused it.
      const text = (context ?? '').trim()
      const res = await window.f2f.projects.pairAnalysis.approve(
        project.id,
        pairKey,
        mode,
        text
      )
      if (!res.ok) {
        setPairError(res.reason ?? 'The approval could not be saved.')
        return
      }
      setPairReview(null)
      setPairRecord({ ...(pairReview as PairAnalysisRecord), state: 'accepted' })
      // Reload from disk rather than patching what is on screen — the
      // prompt and its recorded basis were both just rewritten in main,
      // and a locally-patched copy would show the old ones.
      refreshProjects()
      console.log(
        `[pair-analyse] approved pair=${pairKey} mode=${mode} basis=${res.evidenceSource}` +
          (res.manualPromptPreserved ? ' (manual prompt kept)' : '')
      )
    } catch (err) {
      setPairError(err instanceof Error ? err.message : 'Could not accept the analysis.')
    } finally {
      setPairBusy(false)
    }
  }

  /** Explicit swap. Never a side effect of anything else. */
  const replaceManual = async (): Promise<void> => {
    setPairBusy(true)
    setPairError(null)
    try {
      const res = await window.f2f.projects.pairAnalysis.replacePrompt(project.id, pairKey)
      if (!res.ok) {
        setPairError(res.reason ?? 'The suggestion could not be applied.')
        return
      }
      setShowSuggestion(false)
      refreshProjects()
      console.log('[pair-analyse] manual prompt replaced pair=' + pairKey)
    } catch (err) {
      setPairError(err instanceof Error ? err.message : 'The suggestion could not be applied.')
    } finally {
      setPairBusy(false)
    }
  }

  /**
   * WHAT THE PROMPT IS BASED ON, named.
   *
   * Resolved through the one canonical helper so the label cannot claim
   * a source the generation path does not actually use.
   */
  const evidence = resolvePairSpatialEvidence({
    pairKey,
    analysis,
    pairAnalysis: pairRecord,
    operatorContext: transition.operatorContext,
    // Main's answer when it has arrived. The local resolve stays only as
    // the first-paint fallback, and only for the LABEL — the currency
    // check below never uses it.
    coveredByFeedAnalysis: currentEvidence
      ? currentEvidence.source === 'feed-analysis'
      : Boolean(plan),
    fingerprints: {
      feedFingerprint: feedImages.map((i) => i.id).join('|'),
      libraryFingerprint: project.images.map((i) => i.id).join('|')
    }
  })
  const evidenceLabel = evidence.individualOutdated ? 'Outdated' : evidence.label

  /**
   * IS THE STORED WORDING STILL BUILT ON WHAT WE NOW BELIEVE?
   *
   * "A prompt exists" was the old test, and it is how a prompt written
   * against a five-week-old map kept guiding generation after a fresh
   * analysis. This compares what the prompt RECORDS against what
   * resolves for the pair today.
   */
  //
  // ASKED, NOT RECOMPUTED. The panel derived this fingerprint itself and
  // could therefore disagree with the gate — the badge saying the prompt
  // was fine while generation refused it, which is the same "screen says
  // one thing, paid path does another" failure this codebase keeps
  // removing. Until main answers, nothing is claimed either way.
  const basisCurrent = currentEvidence
    ? isPromptBasisCurrent(transition.promptProvenance, currentEvidence)
    : true
  const manualPrompt = transition.promptProvenance?.manuallyEdited === true
  const suggestion = transition.promptSuggestion ?? null

  return (
    <section className="inspector">
      <header className="inspector-head">
        <span className="inspector-pair">
          TRANSITION {index + 1} → {index + 2}
        </span>
        <nav className="inspector-tabs" role="tablist">
          {(
            [
              ['motion', 'Motion'],
              ['prompt', 'Prompt'],
              ['generation', 'Generation'],
              ['clip', 'Clip']
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={`inspector-tab${tab === key ? ' is-active' : ''}`}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      {/* ── TRANSITION TYPE ─────────────────────────────────────────────
          The first control, not something hidden in Advanced. Whether a
          pair becomes generated video, a cut or a dissolve is the most
          consequential decision about it: it decides whether anything is
          paid for at all, and whether the model is asked to move a camera
          through architecture the photographs never showed. */}
      <div className="transition-mode-row">
        <span className="transition-mode-label">Transition type</span>
        <div className="transition-mode-options" role="radiogroup" aria-label="Transition type">
          {(
            [
              ['auto', 'Auto'],
              ['ai', 'AI'],
              ['cut', 'Cut'],
              ['crossfade', 'Crossfade']
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={(transition.mode ?? 'auto') === value}
              className={`transition-mode-option${
                (transition.mode ?? 'auto') === value ? ' is-active' : ''
              }`}
              // MARKED AS THE OPERATOR'S OWN DECISION. This is the only
              // place a human sets a mode, and it is what distinguishes an
              // informed AI override — allowed with a stated risk — from
              // one the analyzer proposed, which needs the accepted map
              // that justified it before money is spent.
              onClick={() =>
                updateTransition(project.id, start.id, end.id, {
                  mode: value,
                  modeProvenance: 'manual'
                })
              }
            >
              {label}
            </button>
          ))}
        </div>
        {mode && (
          <span className={`transition-mode-effect is-${mode.effectiveMode}`}>
            {mode.requestedMode === 'auto'
              ? `Auto → ${MODE_LABEL[mode.effectiveMode]}`
              : MODE_LABEL[mode.effectiveMode]}
            <span className="transition-mode-reason">{mode.reason}</span>
          </span>
        )}
        {mode?.forcedAgainstEvidence && (
          /* Not blocked — an expert may know the property better than the
             photographs show. But the risk is stated, and the generation
             path asks again before anything is paid for. */
          <p className="transition-mode-warning">
            ⚠ AI navigation is not spatially supported here and may invent architecture.
          </p>
        )}
        {mode?.recommendationDiffers && (
          <p className="transition-mode-note">
            Transition recommendation changed — the current analysis would choose{' '}
            {MODE_LABEL[mode.recommendedMode]}. Your manual choice is kept.
          </p>
        )}
      </div>

      <div className="inspector-body">
        {/* ── MOTION: what the system believes about these two frames ── */}
        {tab === 'motion' && (
          <div className="inspector-motion">
            {relation.kind === 'same-room' && (
              <>
                <Field label="Room relation" value={`${relation.room.label} (same room)`} />
                <Field label="Confidence" value="Confirmed — both images assigned to one room" />
                <Field
                  label="Shared landmarks"
                  value={relation.shared.length > 0 ? relation.shared.join(', ') : 'None recorded'}
                />
              </>
            )}
            {relation.kind === 'adjacent-room' && (
              <>
                <Field
                  label="Room relation"
                  value={`${relation.from.label} → ${relation.to.label}`}
                />
                <Field
                  label="Confidence"
                  value={relation.confidence === 'confirmed' ? 'Confirmed' : 'Probable'}
                />
                <Field
                  label="Visible openings"
                  value={
                    relation.openings.length > 0
                      ? relation.openings.join(', ')
                      : 'None visible in the start frame'
                  }
                />
              </>
            )}
            {relation.kind === 'unknown' && (
              /* THE SAFETY MESSAGE. If the system cannot see how two rooms
                 connect it says so, and says what it will therefore NOT
                 do. A tour that walks through a wall misrepresents a home
                 someone is selling.

                 Two different situations produce this, and they need
                 different advice: nothing has been analysed at all (a
                 recommendation), or analysis ran and honestly could not
                 place these two photographs (a statement of fact). Showing
                 "analyze first" to someone who already did would be a lie
                 about why the transition is generic. */
              <div className="inspector-unknown">
                <span className="inspector-unknown-title">
                  Physical navigation unavailable — safe cinematic transition will be used
                </span>
                {!hasAnalysis ? (
                  <p>
                    Analyze Property first for better spatial accuracy. Without it the system has no
                    whole-property context and will not pretend otherwise.
                  </p>
                ) : (
                  <p>
                    The analysis could not place these two photographs relative to each other. No
                    doorway or corridor will be invented.
                  </p>
                )}
                <p className="inspector-hint">
                  This transition still generates normally — nothing is blocked.
                </p>
              </div>
            )}

            {relation.kind === 'adjacent-room' && relation.openings.length === 0 && (
              /* Confirmed adjacency is not enough on its own. The camera
                 can only move through an opening it can actually see. */
              <div className="inspector-unknown">
                <span className="inspector-unknown-title">
                  Physical navigation unavailable — safe cinematic transition will be used
                </span>
                <p>
                  No opening is visible in the start frame, so the camera is moved toward the end
                  viewpoint without depicting travel through a doorway.
                </p>
              </div>
            )}

            {/* ── WHY THIS MOTION AND NOT ANOTHER ────────────────────────
                Every transition used to read `slow forward dolly, slight
                clockwise rotation` because the wording came first and the
                direction was invented. Showing the evidence a plan was
                built from is what makes a generic plan visibly generic. */}
            {plan && (
              <div className="inspector-evidence">
                <span className="inspector-planned-label">Evidence</span>
                {plan.hasEvidence ? (
                  <dl className="evidence-list">
                    {plan.sharedLandmarks.length > 0 && (
                      <div>
                        <dt>Shared landmarks</dt>
                        <dd>{plan.sharedLandmarks.join(', ')}</dd>
                      </div>
                    )}
                    {plan.leavingLandmarks.length > 0 && (
                      <div>
                        <dt>Leaves frame</dt>
                        <dd>{plan.leavingLandmarks.join(', ')}</dd>
                      </div>
                    )}
                    {plan.enteringLandmarks.length > 0 && (
                      <div>
                        <dt>Enters frame</dt>
                        <dd>{plan.enteringLandmarks.join(', ')}</dd>
                      </div>
                    )}
                    <div>
                      <dt>Start orientation</dt>
                      <dd>{orientationLabel(plan.startOrientation)}</dd>
                    </div>
                    <div>
                      <dt>End orientation</dt>
                      <dd>{orientationLabel(plan.endOrientation)}</dd>
                    </div>
                    <div>
                      <dt>Rotation</dt>
                      <dd className={plan.rotationDirection === 'unknown' ? 'is-unknown' : undefined}>
                        {plan.rotationDirection === 'unknown'
                          ? 'Not determinable from the recorded orientations'
                          : plan.rotationDirection === 'none'
                            ? 'No turn'
                            : plan.rotationDirection}
                      </dd>
                    </div>
                    {plan.visiblePassage && (
                      <div>
                        <dt>Passage</dt>
                        <dd>{plan.visiblePassage}</dd>
                      </div>
                    )}
                    <div>
                      <dt>Derived from</dt>
                      <dd>
                        {plan.evidenceImageIds
                          .map((id) => {
                            const i = project.images.findIndex((x) => x.id === id)
                            return i >= 0 ? `IMAGE_${String(i + 1).padStart(3, '0')}` : null
                          })
                          .filter(Boolean)
                          .join(', ') || 'none'}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <p className="inspector-hint">
                    Insufficient spatial evidence for a directional camera path. Safe cinematic
                    motion will be used — no rotation or travel direction is invented.
                  </p>
                )}
              </div>
            )}

            <div className="inspector-planned">
              <span className="inspector-planned-label">Planned motion</span>
              <p>
                {transition.promptProvenance?.motionInstruction ??
                  (plan && !plan.hasEvidence
                    ? NEUTRAL_MOTION
                    : 'No analysis-derived motion instruction — the base safety prompt is used unchanged.')}
              </p>
            </div>
          </div>
        )}

        {/* ── PROMPT ─────────────────────────────────────────────────── */}
        {tab === 'prompt' && (
          <div className="inspector-prompt">
            {/* ── WHAT THIS PROMPT IS ACTUALLY BASED ON ─────────────
                Generation used to be guided by whichever spatial source
                a component happened to hold, and the operator had no way
                to see which. Named here, next to the wording it
                produced. */}
            <div className="inspector-evidence-row">
              <span className="inspector-evidence-label">
                Evidence: <strong>{evidenceLabel}</strong>
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-tiny"
                disabled={pairBusy}
                title="Analyse only this transition. Other imported images are used as spatial context."
                onClick={() => {
                  console.log('[pair-analyse] click pair=' + pairKey)
                  void openPairConfirmation()
                }}
              >
                {pairBusy ? 'Analysing…' : 'Re-analyse'}
              </button>
            </div>
            {/* WHAT THE WORDING IS BUILT ON — named, and whether it
                still matches the evidence in force. */}
            <p className="inspector-basis">
              {manualPrompt
                ? 'Manual prompt'
                : basisCurrent
                  ? `Based on: ${EVIDENCE_SOURCE_LABEL[evidence.source]}`
                  : 'Prompt basis outdated'}
            </p>

            {/* A suggestion a re-analysis produced for wording a human
                wrote. Offered, never applied — replacing their sentence
                is theirs to choose. */}
            {suggestion && manualPrompt && (
              <div className="inspector-suggestion">
                <p className="inspector-suggestion-title">New AI suggestion available</p>
                {showSuggestion && (
                  <pre className="inspector-suggestion-text">{suggestion.text}</pre>
                )}
                <div className="inspector-suggestion-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-tiny"
                    onClick={() => setShowSuggestion((v) => !v)}
                  >
                    {showSuggestion ? 'Hide suggestion' : 'Review suggestion'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-tiny"
                    disabled={pairBusy}
                    onClick={() => void replaceManual()}
                  >
                    Replace manual prompt
                  </button>
                </div>
              </div>
            )}
            {pairError && <p className="inspector-pair-error">{pairError}</p>}

            {/* THE EDITOR ROW. Separated from the notices above so the
                layout does not depend on how many of them happen to be
                showing: with everything in one grid, an extra notice
                pushed the textarea into an auto-sized row and it
                collapsed. This row is the one that grows. */}
            <div className="inspector-prompt-editor">
            <textarea
              className="inspector-textarea"
              value={transition.prompt}
              placeholder="Leave empty to use the default I2T transition prompt."
              onChange={(e) =>
                updateTransition(project.id, start.id, end.id, {
                  prompt: e.target.value,
                  // Only a REAL edit sets this. Once set, rebuilding from
                  // Property Analysis skips this transition for good.
                  promptProvenance: markManuallyEdited(
                    transition.promptProvenance,
                    e.target.value,
                    Date.now()
                  )
                })
              }
            />
            <div className="inspector-prompt-side">
              {transition.promptProvenance?.manuallyEdited ? (
                <>
                  <span className="prompt-provenance-tag is-manual">Manually edited</span>
                  <p className="inspector-hint">Property Analysis will not overwrite this.</p>
                  <button
                    type="button"
                    className="btn btn-ghost btn-tiny"
                    onClick={() => {
                      if (
                        !window.confirm(
                          'Replace your custom prompt with the one planned from Property Analysis?\n\nYour wording for this transition will be discarded.'
                        )
                      )
                        return
                      void window.f2f.projects.analysis
                        .useAnalysisPrompt(project.id, pairKey)
                        .then(() => refreshProjects())
                    }}
                  >
                    Use analysis prompt
                  </button>
                </>
              ) : (
                <>
                  <span className="prompt-provenance-tag">
                    {transition.promptProvenance ? 'From analysis' : 'Default prompt'}
                  </span>
                  <p className="inspector-hint">
                    {transition.promptProvenance?.rationale ??
                      'Rebuilt automatically when Property Analysis changes.'}
                  </p>
                  <button
                    type="button"
                    className="btn btn-ghost btn-tiny"
                    onClick={() =>
                      void window.f2f.projects.analysis
                        .useAnalysisPrompt(project.id, pairKey)
                        .then(() => refreshProjects())
                    }
                  >
                    Use analysis prompt
                  </button>
                </>
              )}
            </div>
            </div>
          </div>
        )}

        {/* ── GENERATION ─────────────────────────────────────────────── */}
        {tab === 'generation' && (
          <div className="inspector-generation">
            <Field label="Provider" value={providerName} />
            <Field label="Model" value={provider?.model ?? '—'} />
            {/* ── GENERATION LENGTH ────────────────────────────────────
                A setting, not a result: changing it sends nothing, costs
                nothing and leaves any existing clip exactly as it was. It
                describes the next generation of THIS transition. */}
            {generatesClip && allowedDurations.length > 0 && (
              <div className="inspector-duration">
                <span className="inspector-duration-label">Duration</span>
                <div className="inspector-duration-control">
                  <button
                    type="button"
                    className="inspector-duration-step"
                    aria-label="Shorter"
                    disabled={durationSec <= allowedDurations[0]}
                    onClick={() => setDuration(stepDuration(durationSec, -1, allowedDurations))}
                  >
                    –
                  </button>
                  <span className="inspector-duration-value">{durationSec} s</span>
                  <button
                    type="button"
                    className="inspector-duration-step"
                    aria-label="Longer"
                    disabled={durationSec >= allowedDurations[allowedDurations.length - 1]}
                    onClick={() => setDuration(stepDuration(durationSec, 1, allowedDurations))}
                  >
                    +
                  </button>
                  <span className="inspector-duration-range">
                    {allowedDurations[0]}–{allowedDurations[allowedDurations.length - 1]} s
                  </span>
                </div>
                {transition.clip && (
                  <span className="inspector-duration-note">
                    Applies to the next generation. The existing clip is unchanged.
                  </span>
                )}
              </div>
            )}
            {!generatesClip && (
              <p className="inspector-duration-na">
                This transition is a {MODE_LABEL[mode!.effectiveMode].toLowerCase()}, so no clip is
                generated and no duration applies.
              </p>
            )}
            <Field
              label="Spent on this transition"
              value={
                attempts.length > 0
                  ? `${formatSpend(
                      attempts.reduce((s, a) => s + (a.actualCost ?? a.estimatedCost ?? 0), 0),
                      attempts[0].currency
                    )} over ${attempts.length} attempt${attempts.length === 1 ? '' : 's'}`
                  : 'Nothing yet'
              }
            />
            {mode && mode.effectiveMode !== 'ai' ? (
              /* ── NOTHING TO GENERATE ───────────────────────────────────
                 A cut or a crossfade produces no provider request, no
                 prompt, no queue job and no charge. Offering Generate here
                 would invite someone to pay for a transition the project
                 has decided not to generate. */
              <p className="inspector-cost-note is-free inspector-span">
                This transition is a {MODE_LABEL[mode.effectiveMode].toLowerCase()} — no video is
                generated, nothing is sent to a provider and nothing is charged. Change the
                transition type above to generate one.
              </p>
            ) : (
            <div className="inspector-actions">
              {/* ── THREE ACTIONS, THREE COSTS ────────────────────────────
                  Resume continues a paid task that is already running.
                  Retry download fetches a result that already exists and
                  is already paid for. Regenerate submits a NEW paid task.
                  Calling all three "Retry" is how someone pays twice for a
                  clip sitting on the provider's server, so each gets its
                  own word — and the decision comes from the remote task
                  state, not from how the UI feels about it. */}
              <button
                type="button"
                className={`btn btn-tiny ${recovery.costsMoney ? 'btn-primary' : 'btn-ghost'}${
                  recovery.kind === 'regenerate' ? ' btn-regenerate' : ''
                }`}
                disabled={recovery.kind === 'waiting'}
                onClick={() => {
                  if (recovery.kind === 'resume' || recovery.kind === 'retry-download') {
                    if (recovery.jobId) {
                      void window.f2f.queue
                        .resumePolling(recovery.jobId)
                        .then(() => refreshProjects())
                    }
                    return
                  }
                  openGenerate()
                }}
                title={
                  recovery.costsMoney
                    ? 'Opens the paid-request confirmation before anything is sent'
                    : 'Costs nothing — the provider work is already paid for'
                }
              >
                {/* NAMED, NOT ABBREVIATED. "Regenerate clip" says what
                    is produced, which is what separates it at a glance
                    from the Delete beside it — one makes a new clip, the
                    other stops using this one. */}
                {recovery.kind === 'preview'
                  ? 'Regenerate clip — costs again'
                  : recovery.kind === 'regenerate'
                    ? 'Regenerate clip'
                    : recovery.label}
              </button>
              {/* ── A DELIBERATE NEW GENERATION ───────────────────────
                  `recovery.secondary` was computed by the shared logic
                  and rendered nowhere, so whenever a paid task already
                  existed the only visible action was Resume — which
                  merely keeps tracking that same task and can never
                  produce a different clip. Resume became the de-facto
                  "try again" button while being the one action that
                  cannot try anything.

                  Regenerate is a NEW paid submit. It never replaces or
                  deletes an earlier generation: those stay in History,
                  and the new one becomes active when it succeeds. */}
              {/* ── ONLY WHEN THE PRIMARY IS NOT ALREADY REGENERATE ────
                  With a clip attached, `transitionRecovery` returns
                  `preview` WITH a regenerate secondary — and the primary
                  above renders `preview` as "Regenerate clip — costs
                  again". Both conditions were true at once, so the same
                  action appeared twice, with the same words, side by
                  side.

                  The secondary earns its place only where the primary is
                  a FREE action: Resume and Retry download continue work
                  already paid for and can never produce a different
                  clip, so paying for a new one has to be offered
                  separately. */}
              {recovery.secondary?.kind === 'regenerate' &&
                recovery.kind !== 'preview' &&
                recovery.kind !== 'regenerate' && (
                  <button
                    type="button"
                    className="btn btn-tiny btn-regenerate"
                    onClick={() => setConfirmRegenerate(true)}
                    title="Submits a NEW paid request. Existing generations stay in History."
                  >
                    {transition.clip ? 'Regenerate clip — costs again' : 'Generate new clip'}
                  </button>
                )}
              <button
                type="button"
                className="btn btn-ghost btn-tiny"
                onClick={() =>
                  void window.f2f.generation.queue(project.id, [pairKey]).then(() => {
                    refreshProjects()
                    setNote('Queued.')
                  })
                }
              >
                Add to Queue
              </button>
              {/* ── DETACH, NEVER DESTROY ────────────────────────────
                  Removes only which clip this transition USES. The
                  generation, its provider metadata and the file itself
                  stay in the catalogue, which is what makes this
                  reversible — the same clip can be re-attached from
                  History without paying again.

                  ── WHY IT IS PUSHED APART AND STYLED AS DESTRUCTIVE ──
                  This sat immediately beside "Add to Queue" as a third
                  identical ghost button, so the one action that throws
                  work away looked exactly like the two that do not. It
                  is now separated from the constructive actions and
                  reads as destructive, and its label names precisely
                  what goes — the CLIP, not the transition and not the
                  image. */}
              {transition.clip && (
                <div className="inspector-danger">
                  <button
                    type="button"
                    className="btn btn-danger-ghost btn-tiny"
                    onClick={() => setConfirmClearClip(true)}
                    title="Removes only which clip this transition uses. The generation stays in History and can be re-attached without paying again."
                  >
                    Delete clip
                  </button>
                </div>
              )}
            </div>
            )}
            <p className={`inspector-cost-note${recovery.costsMoney ? '' : ' is-free'}`}>
              {mode && mode.effectiveMode !== 'ai' ? '' : recovery.detail}
            </p>

            {transition.clip && (
              <p className="inspector-cost-note">
                A clip already exists. Regenerating submits a new paid request and does not replace
                the spend already recorded for this transition.
              </p>
            )}
            {attempts.length > 0 && (
              <ul className="inspector-attempts">
                {attempts.map((a) => (
                  <li key={a.id}>
                    Attempt {a.attemptNumber} · {a.provider} ·{' '}
                    {formatSpend(a.actualCost ?? a.estimatedCost ?? 0, a.currency)} · {a.status}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* ── CLIP ───────────────────────────────────────────────────── */}
        {tab === 'clip' && (
          <div className="inspector-clip">
            {transition.clip ? (
              <>
                <Field
                  label="Source"
                  value={
                    transition.clip.source === 'fal'
                      ? 'Generated with fal.ai'
                      : transition.clip.source === 'kling'
                        ? 'Generated with Kling'
                        : 'Attached manually'
                  }
                />
                <Field
                  label="File"
                  value={
                    clipInfo?.exists
                      ? `${transition.clip.originalName} · ${formatBytes(clipInfo.bytes)}`
                      : 'Missing on disk'
                  }
                />
                <div className="inspector-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-tiny"
                    onClick={() =>
                      void window.f2f.clips.showInFolder(project.id, transition.clip!.storedName)
                    }
                  >
                    Open folder
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-tiny"
                    onClick={() => {
                      const old = transition.clip
                      if (old) void window.f2f.clips.remove(project.id, old.storedName)
                      updateTransition(project.id, start.id, end.id, {
                        clip: null,
                        status: 'not-generated'
                      })
                    }}
                  >
                    Remove clip
                  </button>
                  {/* Development action, marked as one. */}
                  <button
                    type="button"
                    className="btn btn-ghost btn-tiny btn-dev"
                    title="Development: import an MP4 as this transition's output"
                    onClick={() =>
                      void window.f2f.clips.attach(project.id).then((clip) => {
                        if (!clip) return
                        updateTransition(project.id, start.id, end.id, {
                          clip,
                          status: 'completed'
                        })
                      })
                    }
                  >
                    ⚙ Attach Test Clip
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="inspector-hint">
                  {pendingDownload
                    ? 'A generation was paid for but no clip is attached. Retrying the download costs nothing.'
                    : 'No clip yet for this transition.'}
                </p>
                <div className="inspector-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-tiny btn-dev"
                    title="Development: import an MP4 as this transition's output"
                    onClick={() =>
                      void window.f2f.clips.attach(project.id).then((clip) => {
                        if (!clip) return
                        updateTransition(project.id, start.id, end.id, {
                          clip,
                          status: 'completed'
                        })
                      })
                    }
                  >
                    ⚙ Attach Test Clip
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {note && <p className="inspector-note">{note}</p>}

      {live.dialog}

      {/* ── RE-ANALYSE ONE TRANSITION: CONFIRM FIRST ────────────────
          A paid run, so the first click only reaches here. The wording
          states the two things that distinguish it from a feed run:
          scope, and what the other photographs are for. */}
      {pairConfirm && (
        <div className="dialog-backdrop" onClick={() => setPairConfirm(null)}>
          <div className="dialog-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="dialog-title">Re-analyse this transition?</h3>
            <p className="dialog-body">
              <strong>{start.fileName}</strong> → <strong>{end.fileName}</strong>
            </p>
            <p className="dialog-body">
              Analyzer: {pairConfirm.payload.analyzer} · {pairConfirm.payload.model ?? 'default model'}
            </p>
            <p className="dialog-body dialog-emphasis">Only this transition will be analysed.</p>
            <p className="dialog-body">
              Other imported images may be used as spatial context —{' '}
              {Math.max(0, project.images.length - 2)} supporting photograph
              {project.images.length - 2 === 1 ? '' : 's'}. The feed order is not changed and no
              other transition is touched.
            </p>
            <p className="dialog-body">
              <strong>Cost:</strong> {pairConfirm.payload.estimatedCostLabel}
            </p>
            {pairConfirm.payload.warning && (
              <p className="dialog-body dialog-warning">{pairConfirm.payload.warning}</p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="btn btn-ghost btn-tiny"
                onClick={() => setPairConfirm(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary btn-tiny"
                disabled={pairBusy}
                onClick={() => void runPairAnalysis()}
              >
                {pairBusy ? 'Analysing…' : 'Re-analyse transition'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── THE RESULT, REVIEWED — never applied on arrival ────────── */}
      {pairReview && (
        <div className="dialog-backdrop" onClick={() => setPairReview(null)}>
          <div className="dialog-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="dialog-title">
              {pairReview.decision === 'ai'
                ? 'Analysis: AI'
                : pairReview.decision === 'cut'
                  ? 'Analysis: CUT'
                  : 'Analysis: Missing context'}
            </h3>
            <p className="dialog-body">{pairReview.reason}</p>
            {pairReview.evidence.sharedLandmarks.length > 0 && (
              <p className="dialog-body">
                Shared in both frames: {pairReview.evidence.sharedLandmarks.join(', ')}
              </p>
            )}
            {pairReview.motionInstruction && (
              <p className="dialog-body dialog-emphasis">{pairReview.motionInstruction}</p>
            )}
            {pairReview.missingContext.map((m, i) => (
              <p key={i} className="dialog-body dialog-warning">
                Missing: {m.question}
              </p>
            ))}

            {pairReview.decision === 'needs-context' && (
              <textarea
                className="transition-review-context-input"
                rows={3}
                placeholder="Example: The mirror reflects only the beige wall and the doorway opposite the sink."
                value={pairContext}
                onChange={(e) => setPairContext(e.target.value)}
              />
            )}
            {pairError && <p className="inspector-pair-error">{pairError}</p>}

            <div className="dialog-actions">
              <button
                type="button"
                className="btn btn-ghost btn-tiny"
                onClick={() => setPairReview(null)}
              >
                Cancel
              </button>
              {pairReview.decision === 'cut' ? (
                <>
                  <button
                    type="button"
                    className="btn btn-primary btn-tiny"
                    disabled={pairBusy}
                    onClick={() => void acceptPair('cut')}
                  >
                    Accept CUT
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-tiny"
                    disabled={pairBusy}
                    onClick={() => void acceptPair('ai')}
                  >
                    Override to AI
                  </button>
                </>
              ) : pairReview.decision === 'ai' ? (
                <button
                  type="button"
                  className="btn btn-primary btn-tiny"
                  disabled={pairBusy}
                  onClick={() => void acceptPair('ai')}
                >
                  Accept analysis
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn-primary btn-tiny"
                    disabled={pairBusy}
                    onClick={() => void acceptPair('ai', pairContext)}
                  >
                    {pairContext.trim().length > 0 ? 'Approve AI with context' : 'Approve AI'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-tiny"
                    disabled={pairBusy}
                    onClick={() => void acceptPair('cut')}
                  >
                    Keep as CUT
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── A NEW PAID GENERATION IS A DECISION ────────────────────────
          Stated before the provider confirmation rather than after,
          because the thing being agreed to here is "buy another one",
          which is different from the cost dialog's "this is what it
          costs". It also says plainly what is NOT lost, so an operator
          is never guessing whether regenerating discards the clip they
          already have. */}
      {confirmRegenerate && (
        <div className="dialog-backdrop" onClick={() => setConfirmRegenerate(false)}>
          <div className="dialog-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="dialog-title">Generate a new clip?</h3>
            <p className="dialog-body">
              This creates a new paid generation for this transition. Your existing generations
              remain in History and can be attached again at any time.
            </p>
            {recovery.kind === 'resume' && (
              <p className="dialog-body">
                A previous request is still running at the provider. Generating now starts a
                separate one — it does not cancel or replace the request already paid for.
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="btn btn-ghost btn-tiny"
                onClick={() => setConfirmRegenerate(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary btn-tiny"
                onClick={() => {
                  setConfirmRegenerate(false)
                  // Straight into the normal paid path: the provider
                  // confirmation, its cost figure and its one-shot token
                  // are not bypassed by this dialog.
                  openGenerate()
                }}
              >
                Generate new clip
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Detaching is reversible, but the operator should still know what
          it does and — more importantly — what it does NOT do. */}
      {confirmClearClip && (
        <div className="dialog-backdrop" onClick={() => setConfirmClearClip(false)}>
          <div className="dialog-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="dialog-title">Delete this transition’s clip?</h3>
            <p className="dialog-body">
              Only the clip this transition currently uses is removed. The transition itself, both
              images and the Transition Feed are untouched.
            </p>
            <p className="dialog-body">
              The generated clip will remain available in Project Catalogue, and can be attached
              to this transition again without generating — or paying — a second time.
            </p>
            <div className="dialog-actions">
              <button
                type="button"
                className="btn btn-ghost btn-tiny"
                onClick={() => setConfirmClearClip(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger btn-tiny"
                onClick={() => {
                  void window.f2f.projects.transitions
                    .clearClip(project.id, pairKey)
                    .then((res) => {
                      setConfirmClearClip(false)
                      refreshProjects()
                      setNote(res.ok ? 'Clip removed. It is still in Project Catalogue.' : res.reason)
                    })
                }}
              >
                Remove clip
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="inspector-field">
      <span className="inspector-field-label">{label}</span>
      <span className="inspector-field-value">{value}</span>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
