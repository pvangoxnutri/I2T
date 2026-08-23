import { useCallback, useEffect, useState } from 'react'
import type { Project } from '../../types'
import {
  type AnalysisConfidence,
  type AnalyzerMetadata,
  type PropertyAnalysis
} from '../../../../shared/propertyAnalysis'
import type { RebuildPlanSummary } from '../../../../shared/promptPlanner'
import type { AnalysisDiff } from '../../../../shared/analysisDiff'
import {
  summarizeAnalysis,
  summaryHeadline,
  summarySubline,
  type AnalysisIssue,
  type AnalysisSummary
} from '../../../../shared/analysisSummary'
import {
  selectImage,
  selectTransition,
  type EditorSelection
} from '../../../../shared/editorSelection'
import type { ReviewVerdict } from '../../../../shared/analysisReview'
import type { AnalysisConfirmationPayload } from '../../../../preload/index'
import { AnalyzeConfirmDialog } from './AnalyzeConfirmDialog'
import { GroundTruthReview } from './GroundTruthReview'
import { SceneGraph } from './SceneGraph'

/**
 * WHOLE-PROPERTY ANALYSIS — the summary, not the database.
 *
 * ── WHAT CHANGED AND WHY ─────────────────────────────────────────────
 *
 * This panel used to show everything the system knew: every room, every
 * landmark, a confidence dropdown per room pair, the raw scene graph, the
 * full transition plan list and a per-image editor. All of it true, all of
 * it still available — and together it buried the only two questions an
 * operator has after pressing Analyze: did it work, and is anything wrong?
 *
 * The default view now answers exactly those two and offers exactly three
 * actions. The detail moved to two places that suit it better: per-image
 * facts to the Image Inspector (where that image is), and the rest behind
 * Advanced (where someone went looking for it).
 *
 * ── ONE OBVIOUS PATH ─────────────────────────────────────────────────
 *
 * `Analyze Property` uses the configured default analyzer and model. There
 * is no analyzer picker, no model picker and no confidence strategy on the
 * primary view — those are configuration, not per-run decisions, and a
 * screen that asks five questions before the useful button teaches people
 * that the useful button is dangerous.
 *
 * ── IT IS STILL A PROPOSAL ───────────────────────────────────────────
 *
 * A result is a DRAFT. The accepted analysis is untouched until someone
 * accepts, the diff says exactly what accepting would cost, and manual
 * overrides survive it. None of that got simpler.
 */
type AnalysisStatus = 'not-analyzed' | 'analyzing' | 'draft' | 'needs-review' | 'accepted'

export function PropertyAnalysisPanel({
  project,
  analysis,
  onSelect,
  onAnalysisChange
}: {
  project: Project
  /** The EFFECTIVE analysis — accepted, with manual corrections applied. */
  analysis: PropertyAnalysis | null
  onSelect: (selection: EditorSelection) => void
  onAnalysisChange: () => void
}): React.JSX.Element {
  const [analyzers, setAnalyzers] = useState<AnalyzerMetadata[]>([])
  const [status, setStatus] = useState<AnalysisStatus>('not-analyzed')
  const [pendingResult, setPendingResult] = useState<PropertyAnalysis | null>(null)
  const [diff, setDiff] = useState<AnalysisDiff | null>(null)
  const [analyzerId, setAnalyzerId] = useState('mock')
  const [rebuild, setRebuild] = useState<RebuildPlanSummary | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<AnalysisConfirmationPayload | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [showIssues, setShowIssues] = useState(false)

  useEffect(() => {
    void window.f2f.projects.analysis.analyzers().then(setAnalyzers)
  }, [])

  useEffect(() => {
    if (!analysis) return
    setStatus(analysis.state ?? (analysis.rooms.length > 0 ? 'accepted' : 'not-analyzed'))
  }, [analysis?.updatedAt, analysis?.state])

  const imageLabel = useCallback(
    (id: string): string => {
      const i = project.images.findIndex((x) => x.id === id)
      return i >= 0 ? `Image ${String(i + 1).padStart(2, '0')}` : 'Image ?'
    },
    [project.images]
  )

  // Reviews feed the summary so a connection someone rejected is reported
  // as disabled here too, not only inside the planner.
  const [reviews, setReviews] = useState<Map<string, ReviewVerdict>>(new Map())
  useEffect(() => {
    void window.f2f.projects.review.list(project.id, 'accepted').then((entries) => {
      setReviews(new Map(entries.map((e) => [e.factKey, e.verdict])))
    })
  }, [project.id, analysis?.updatedAt])

  const summary: AnalysisSummary = summarizeAnalysis(
    analysis,
    project.images.map((i) => i.id),
    imageLabel,
    reviews
  )

  const selectedAnalyzer = analyzers.find((a) => a.id === analyzerId) ?? null
  const warnings = summary.issues.filter((i) => i.severity === 'warning')

  // ── Running it ────────────────────────────────────────────────────────

  const executeAnalyzer = (id: string, token?: string): void => {
    setStatus('analyzing')
    setNote(null)
    void window.f2f.projects.analysis.run(project.id, id, '', token).then((res) => {
      setConfirm(null)
      if (!res.ok) {
        setStatus(analysis && analysis.rooms.length > 0 ? 'accepted' : 'not-analyzed')
        setNote(res.reason)
        return
      }
      // PROPOSED, not applied. The accepted analysis is untouched until
      // someone explicitly accepts — and the diff shows what that costs.
      setPendingResult(res.analysis)
      setStatus('needs-review')
      setNote(res.notes.join(' '))
      void window.f2f.projects.analysis.diff(project.id, res.analysis).then(setDiff)
    })
  }

  /**
   * A free or dry-run analyzer sends nothing and runs straight away.
   * A LIVE billable run always stops for confirmation and carries back a
   * one-shot token without which main refuses it.
   */
  const requestAnalysis = (id: string): void => {
    const meta = analyzers.find((a) => a.id === id)
    if (!meta?.capabilities.incursCost) {
      executeAnalyzer(id)
      return
    }
    setNote(null)
    void window.f2f.projects.analysis.confirmation(project.id, id).then((payload) => {
      if (!payload) {
        setNote('This analyzer could not be prepared for review.')
        return
      }
      if (!payload.paidLive) {
        executeAnalyzer(id)
        return
      }
      setConfirm(payload)
    })
  }

  const busy = status === 'analyzing' || confirm !== null
  const dryRun = selectedAnalyzer?.capabilities.incursCost === true && confirm === null

  return (
    <div className="analysis-workspace">
      {/* ── SUMMARY ────────────────────────────────────────────────────
          The default view. Two sentences and three buttons. */}
      <div className={`analysis-summary is-${summary.phase}`}>
        <span className="analysis-summary-head">{summaryHeadline(summary)}</span>
        <span className="analysis-summary-sub">{summarySubline(summary)}</span>

        {summary.phase !== 'not-analyzed' && (
          <ul className="analysis-counts">
            <li>
              <strong>{summary.imageCount}</strong> images
            </li>
            <li>
              <strong>{summary.spaceCount}</strong> space{summary.spaceCount === 1 ? '' : 's'}{' '}
              identified
            </li>
            <li>
              <strong>{summary.confidentTransitions}</strong> transition
              {summary.confidentTransitions === 1 ? '' : 's'} understood confidently
            </li>
            {summary.uncertainTransitions > 0 && (
              <li className="is-warn">
                <strong>{summary.uncertainTransitions}</strong> transition
                {summary.uncertainTransitions === 1 ? '' : 's'} need review
              </li>
            )}
          </ul>
        )}

        <div className="analysis-summary-actions">
          <button
            type="button"
            className="btn btn-primary btn-tiny"
            disabled={busy || project.images.length < 2}
            onClick={() => requestAnalysis(analyzerId)}
            title={selectedAnalyzer?.description}
          >
            {status === 'analyzing'
              ? 'Analyzing…'
              : summary.phase === 'not-analyzed'
                ? 'Analyze Property'
                : 'Re-analyze'}
          </button>

          {warnings.length > 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-tiny"
              onClick={() => setShowIssues((v) => !v)}
            >
              {showIssues ? 'Hide issues' : `Review ${warnings.length} Issue${warnings.length === 1 ? '' : 's'}`}
            </button>
          )}

          <button
            type="button"
            className="btn btn-ghost btn-tiny"
            onClick={() => setAdvanced((v) => !v)}
          >
            {advanced ? 'Hide Advanced' : 'Advanced Analysis'}
          </button>
        </div>

        {/* Which analyzer, and whether it will actually send anything. */}
        <span className="analysis-summary-meta">
          {selectedAnalyzer?.displayName ?? 'No analyzer'}
          {selectedAnalyzer?.capabilities.incursCost
            ? dryRun
              ? ' · paid — confirmation required'
              : ' · paid'
            : ' · free / local'}
        </span>
      </div>

      {/* ── ISSUES ─────────────────────────────────────────────────────
          Warnings to resolve, the way professional software presents
          them: a list you click into, not a form you fill in. */}
      {showIssues && (
        <IssueList
          issues={summary.issues}
          onSelect={(issue) =>
            onSelect(
              issue.target.kind === 'image'
                ? selectImage(issue.target.imageId)
                : selectTransition(issue.target.pairKey)
            )
          }
        />
      )}

      {/* ── DRAFT REVIEW ───────────────────────────────────────────────
          A draft NEVER becomes the accepted analysis on its own. */}
      {pendingResult && (
        <div className="analysis-review">
          <span className="analysis-review-title">Analysis draft — review before accepting</span>
          <p>
            {pendingResult.rooms.length} room{pendingResult.rooms.length === 1 ? '' : 's'},{' '}
            {pendingResult.edges.length} connection{pendingResult.edges.length === 1 ? '' : 's'}{' '}
            proposed.
          </p>
          {diff && !diff.identical && (
            <ul className="analysis-diff">
              {diff.addedRooms.length > 0 && <li>+ rooms: {diff.addedRooms.join(', ')}</li>}
              {diff.removedRooms.length > 0 && (
                <li className="is-loss">− rooms removed: {diff.removedRooms.join(', ')}</li>
              )}
              {diff.reassignedImages.length > 0 && (
                <li>{diff.reassignedImages.length} image assignments would change</li>
              )}
              {diff.addedConnections.length > 0 && (
                <li>
                  + connections:{' '}
                  {diff.addedConnections.map((c) => `${c.label} (${c.confidence})`).join(', ')}
                </li>
              )}
              {diff.removedConnections.length > 0 && (
                <li className="is-loss">− connections lost: {diff.removedConnections.join(', ')}</li>
              )}
              {diff.changedConfidence.map((c) => (
                <li key={c.label}>
                  {c.label}: {c.from} → {c.to}
                </li>
              ))}
            </ul>
          )}
          {diff?.identical && <p>Identical to the accepted analysis — nothing would change.</p>}
          <p className="analysis-hint">
            Manual overrides on individual images are kept — accepting this draft will not undo
            them.
          </p>

          <div className="analysis-review-actions">
            <button
              type="button"
              className="btn btn-ghost btn-tiny"
              onClick={() => {
                void window.f2f.projects.review.clearDraft(project.id)
                setPendingResult(null)
                setDiff(null)
                setStatus(analysis && analysis.rooms.length > 0 ? 'accepted' : 'not-analyzed')
              }}
            >
              Discard Draft
            </button>
            <button
              type="button"
              className="btn btn-primary btn-tiny"
              onClick={() => {
                void window.f2f.projects.analysis
                  .save({ ...pendingResult, state: 'accepted' })
                  .then(() =>
                    window.f2f.projects.review.promoteDraft(project.id).then(() => {
                      setPendingResult(null)
                      setDiff(null)
                      setStatus('accepted')
                      onAnalysisChange()
                    })
                  )
              }}
            >
              Accept Analysis
            </button>
          </div>

          {advanced && (
            <GroundTruthReview projectId={project.id} scope="draft" analysis={pendingResult} />
          )}
        </div>
      )}

      {/* ── ADVANCED / FINE TUNE ───────────────────────────────────────
          Everything that used to be the default view. Still complete,
          still reachable — just no longer the first thing. */}
      {advanced && (
        <AdvancedAnalysis
          project={project}
          analysis={analysis}
          analyzers={analyzers}
          analyzerId={analyzerId}
          onAnalyzerChange={setAnalyzerId}
          onRebuild={() =>
            void window.f2f.projects.analysis.planRebuild(project.id).then(setRebuild)
          }
          onAnalysisChange={onAnalysisChange}
        />
      )}

      {note && <p className="analysis-hint">{note}</p>}

      {confirm && (
        <AnalyzeConfirmDialog
          data={confirm}
          busy={status === 'analyzing'}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            if (status === 'analyzing') return
            executeAnalyzer(analyzerId, confirm.token ?? undefined)
          }}
        />
      )}

      {rebuild && (
        <div className="dialog-backdrop" onClick={() => setRebuild(null)}>
          <div className="dialog-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="dialog-title">Rebuild transition prompts</h3>
            <ul className="rebuild-summary">
              <li>
                <strong>{rebuild.rebuildable.length}</strong> transition
                {rebuild.rebuildable.length === 1 ? '' : 's'} will be rebuilt
              </li>
              <li>
                <strong>{rebuild.preserved.length}</strong> manually edited prompt
                {rebuild.preserved.length === 1 ? '' : 's'} will be preserved
              </li>
            </ul>
            {rebuild.rebuildable.length > 0 && (
              <ul className="rebuild-list">
                {rebuild.rebuildable.map((r) => (
                  <li key={r.pairKey}>
                    <span className="rebuild-list-label">{r.label}</span>
                    <span className="rebuild-list-basis">{r.basis}</span>
                    <span className="rebuild-list-preview">{r.preview}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="btn btn-ghost btn-tiny"
                onClick={() => setRebuild(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary btn-tiny"
                disabled={rebuild.rebuildable.length === 0}
                onClick={() =>
                  void window.f2f.projects.analysis
                    .rebuildPrompts(project.id)
                    .then(() => setRebuild(null))
                }
              >
                Rebuild {rebuild.rebuildable.length} Prompt
                {rebuild.rebuildable.length === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Warnings to resolve. Clicking one takes you to the thing it is about. */
function IssueList({
  issues,
  onSelect
}: {
  issues: AnalysisIssue[]
  onSelect: (issue: AnalysisIssue) => void
}): React.JSX.Element {
  if (issues.length === 0) {
    return <p className="analysis-hint">No spatial issues found.</p>
  }
  return (
    <ul className="issue-list">
      {issues.map((issue) => (
        <li key={issue.id}>
          <button
            type="button"
            className={`issue-row is-${issue.severity}`}
            onClick={() => onSelect(issue)}
          >
            <span className="issue-icon" aria-hidden>
              {issue.severity === 'warning' ? '⚠' : 'ⓘ'}
            </span>
            <span className="issue-text">
              <span className="issue-title">{issue.title}</span>
              <span className="issue-detail">{issue.detail}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * FINE TUNE — the expert surface.
 *
 * Analyzer choice, the raw scene graph, room connections and ground-truth
 * evaluation. Everything here was previously the default view; none of it
 * was removed, and nothing in the normal flow requires opening it.
 */
function AdvancedAnalysis({
  project,
  analysis,
  analyzers,
  analyzerId,
  onAnalyzerChange,
  onRebuild,
  onAnalysisChange
}: {
  project: Project
  analysis: PropertyAnalysis | null
  analyzers: AnalyzerMetadata[]
  analyzerId: string
  onAnalyzerChange: (id: string) => void
  onRebuild: () => void
  onAnalysisChange: () => void
}): React.JSX.Element {
  const [edgesOpen, setEdgesOpen] = useState(false)

  const setEdge = (a: string, b: string, confidence: AnalysisConfidence): void => {
    if (!analysis) return
    const others = analysis.edges.filter(
      (e) => !((e.fromRoomId === a && e.toRoomId === b) || (e.fromRoomId === b && e.toRoomId === a))
    )
    // 'unknown' REMOVES the edge: absence of evidence is stored as absence,
    // not as a claim we cannot support.
    void window.f2f.projects.analysis
      .save({
        ...analysis,
        edges:
          confidence === 'unknown'
            ? others
            : [
                ...others,
                {
                  id: `edge-${a}-${b}`,
                  fromRoomId: a,
                  toRoomId: b,
                  confidence,
                  supportingImageIds: []
                }
              ]
      })
      .then(onAnalysisChange)
  }

  const roomPairs: Array<[string, string]> = []
  const rooms = analysis?.rooms ?? []
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) roomPairs.push([rooms[i].id, rooms[j].id])
  }

  return (
    <div className="analysis-advanced">
      <span className="analysis-section-title">Fine tune</span>

      <label className="analysis-inline">
        <span>Analyzer</span>
        <select value={analyzerId} onChange={(e) => onAnalyzerChange(e.target.value)}>
          {analyzers.map((a) => (
            <option key={a.id} value={a.id} disabled={!a.available}>
              {a.displayName}
              {a.available ? '' : ' — not implemented'}
            </option>
          ))}
        </select>
      </label>
      <p className="analysis-hint">
        Model and safety locks live in Settings. The default is used unless you change it here.
      </p>

      {rooms.length > 0 && (
        <>
          <span className="analysis-map-title">
            Spatial relationship graph — inferred, not surveyed
          </span>
          <SceneGraph analysis={analysis!} />
        </>
      )}

      {roomPairs.length > 0 && (
        <>
          <button
            type="button"
            className="analysis-disclosure"
            onClick={() => setEdgesOpen((v) => !v)}
          >
            {edgesOpen ? '▾' : '▸'} Room connections ({roomPairs.length})
          </button>
          {edgesOpen &&
            roomPairs.map(([a, b]) => {
              const edge = analysis!.edges.find(
                (e) =>
                  (e.fromRoomId === a && e.toRoomId === b) ||
                  (e.fromRoomId === b && e.toRoomId === a)
              )
              const confidence: AnalysisConfidence = edge?.confidence ?? 'unknown'
              return (
                <label key={`${a}-${b}`} className="analysis-edge-row">
                  <span className="analysis-edge-name">
                    {rooms.find((r) => r.id === a)?.label} ↔ {rooms.find((r) => r.id === b)?.label}
                  </span>
                  <select
                    value={confidence}
                    onChange={(e) => setEdge(a, b, e.target.value as AnalysisConfidence)}
                  >
                    <option value="unknown">Unknown</option>
                    <option value="probable">Probable</option>
                    <option value="confirmed">Confirmed</option>
                  </select>
                </label>
              )
            })}
        </>
      )}

      {analysis && analysis.rooms.length > 0 && (
        <GroundTruthReview
          projectId={project.id}
          scope="accepted"
          analysis={analysis}
          onReviewed={onAnalysisChange}
        />
      )}

      <div className="analysis-actions">
        <button type="button" className="btn btn-ghost btn-tiny" onClick={onRebuild}>
          Rebuild transition prompts from analysis
        </button>
      </div>
    </div>
  )
}
