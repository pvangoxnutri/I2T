import type { Database } from 'sql.js'
import { getDb, scheduleFlush } from './index'
import type { MissingContextItem } from '../../shared/operatorContext'
import type {
  PairAnalysisRecord,
  PairAnalysisState,
  PairEvidenceRecord
} from '../../shared/pairAnalysis'

/**
 * Per-pair analysis persistence.
 *
 * One row per (project, pair). A re-analysis of the same pair REPLACES
 * its row: unlike a generation, an analysis costs nothing to keep and
 * everything to confuse — two accepted analyses of one joint is exactly
 * the divergence this project keeps being bitten by.
 */

function run(db: Database, sql: string, params: unknown[] = []): void {
  const stmt = db.prepare(sql)
  try {
    stmt.run(params as never)
  } finally {
    stmt.free()
  }
}

function all<T>(db: Database, sql: string, params: unknown[] = []): T[] {
  const stmt = db.prepare(sql)
  const rows: T[] = []
  try {
    stmt.bind(params as never)
    while (stmt.step()) rows.push(stmt.getAsObject() as T)
  } finally {
    stmt.free()
  }
  return rows
}

interface Row {
  project_id: string
  pair_key: string
  analyzed_at: number
  analyzer: string | null
  model: string | null
  parent_analysis_updated_at: number | null
  feed_fingerprint: string | null
  library_fingerprint: string | null
  evidence_json: string
  decision: string
  missing_context_json: string | null
  motion_instruction: string | null
  prompt_candidate: string | null
  reason: string | null
  state: string
}

const EMPTY_EVIDENCE: PairEvidenceRecord = {
  relation: 'unknown',
  sharedLandmarks: [],
  openings: [],
  reflectiveSurfaces: [],
  geometryConflicts: []
}

function toRecord(r: Row): PairAnalysisRecord {
  let evidence = EMPTY_EVIDENCE
  try {
    evidence = { ...EMPTY_EVIDENCE, ...(JSON.parse(r.evidence_json) as PairEvidenceRecord) }
  } catch {
    // A corrupt blob loses the detail, never the record's existence.
  }
  let missingContext: MissingContextItem[] = []
  if (r.missing_context_json) {
    try {
      const parsed: unknown = JSON.parse(r.missing_context_json)
      if (Array.isArray(parsed)) missingContext = parsed as MissingContextItem[]
    } catch {
      /* same */
    }
  }
  const decision = ['ai', 'cut', 'needs-context'].includes(r.decision)
    ? (r.decision as PairAnalysisRecord['decision'])
    : 'needs-context'
  return {
    projectId: r.project_id,
    pairKey: r.pair_key,
    analyzedAt: r.analyzed_at,
    analyzer: r.analyzer,
    model: r.model,
    parentAnalysisUpdatedAt: r.parent_analysis_updated_at,
    feedFingerprint: r.feed_fingerprint,
    libraryFingerprint: r.library_fingerprint,
    evidence,
    decision,
    missingContext,
    motionInstruction: r.motion_instruction,
    promptCandidate: r.prompt_candidate,
    reason: r.reason,
    state: (['draft', 'accepted', 'outdated'].includes(r.state)
      ? r.state
      : 'draft') as PairAnalysisState
  }
}

export function savePairAnalysis(record: PairAnalysisRecord): void {
  run(
    getDb(),
    `INSERT INTO pair_analysis
       (project_id, pair_key, analyzed_at, analyzer, model,
        parent_analysis_updated_at, feed_fingerprint, library_fingerprint,
        evidence_json, decision, missing_context_json, motion_instruction,
        prompt_candidate, reason, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, pair_key) DO UPDATE SET
       analyzed_at = excluded.analyzed_at,
       analyzer = excluded.analyzer,
       model = excluded.model,
       parent_analysis_updated_at = excluded.parent_analysis_updated_at,
       feed_fingerprint = excluded.feed_fingerprint,
       library_fingerprint = excluded.library_fingerprint,
       evidence_json = excluded.evidence_json,
       decision = excluded.decision,
       missing_context_json = excluded.missing_context_json,
       motion_instruction = excluded.motion_instruction,
       prompt_candidate = excluded.prompt_candidate,
       reason = excluded.reason,
       state = excluded.state`,
    [
      record.projectId,
      record.pairKey,
      record.analyzedAt,
      record.analyzer,
      record.model,
      record.parentAnalysisUpdatedAt,
      record.feedFingerprint,
      record.libraryFingerprint,
      JSON.stringify(record.evidence),
      record.decision,
      record.missingContext.length > 0 ? JSON.stringify(record.missingContext) : null,
      record.motionInstruction,
      record.promptCandidate,
      record.reason,
      record.state
    ]
  )
  scheduleFlush()
}

export function readPairAnalysis(projectId: string, pairKey: string): PairAnalysisRecord | null {
  const rows = all<Row>(
    getDb(),
    'SELECT * FROM pair_analysis WHERE project_id = ? AND pair_key = ?',
    [projectId, pairKey]
  )
  return rows[0] ? toRecord(rows[0]) : null
}

export function listPairAnalyses(projectId: string): PairAnalysisRecord[] {
  return all<Row>(getDb(), 'SELECT * FROM pair_analysis WHERE project_id = ?', [projectId]).map(
    toRecord
  )
}

export function setPairAnalysisState(
  projectId: string,
  pairKey: string,
  state: PairAnalysisState
): void {
  run(getDb(), 'UPDATE pair_analysis SET state = ? WHERE project_id = ? AND pair_key = ?', [
    state,
    projectId,
    pairKey
  ])
  scheduleFlush()
}

/**
 * Mark analyses whose pair the feed no longer contains.
 *
 * NOT deleted: the analysis was real work and remains readable history,
 * and a feed edit is often reverted. It simply stops being applicable,
 * which `resolvePairSpatialEvidence` then refuses to use.
 */
export function markOrphanedPairAnalyses(projectId: string, livePairKeys: string[]): number {
  const live = new Set(livePairKeys)
  let marked = 0
  for (const record of listPairAnalyses(projectId)) {
    if (record.state !== 'outdated' && !live.has(record.pairKey)) {
      setPairAnalysisState(projectId, record.pairKey, 'outdated')
      marked++
    }
  }
  return marked
}

/**
 * Remove every pair analysis belonging to a project.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────
 *
 * `pair_analysis` has no foreign key to `projects` — an analysis is
 * evidence about work and deliberately outlives a row being rewritten —
 * so deleting a project leaves its analyses behind. The smoke suite
 * creates projects constantly, and 44 orphaned rows had accumulated in
 * the operator's real database before anyone counted them.
 *
 * Harmless while nothing reads them; not harmless now. The prompt
 * finalizer looks up an accepted pair analysis to decide a pair's route,
 * so a stale row is a route waiting to be applied to whatever pair key
 * it happens to match.
 */
export function deletePairAnalysesForProject(projectId: string): void {
  run(getDb(), 'DELETE FROM pair_analysis WHERE project_id = ?', [projectId])
  scheduleFlush()
}
