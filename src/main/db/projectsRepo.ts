import type { Database } from 'sql.js'
import type {
  PreviewWatermark,
  BrandSignature,
  ClipSource,
  Project,
  TransitionClip,
  TransitionMode,
  TransitionSettings
} from '../../shared/types'
import type { PromptPlanBasis, PromptProvenance } from '../../shared/promptPlanner'
import type { EvidenceSource } from '../../shared/pairAnalysis'
import { getDb, scheduleFlush } from './index'
import { clipUrl, imageUrl } from '../files'
import type { MotionSegment, MotionType } from '../../shared/motionSegment'

/**
 * All project persistence. The renderer works with the full Project object
 * graph; this repo maps it to/from the relational schema. Saves replace the
 * project's images/transitions atomically — order lives in the `position`
 * column, transition settings in one row per image pair.
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

interface ProjectRow {
  id: string
  name: string
  created_at: number
  updated_at: number
  watermark_json: string
  signature_json: string
  status: string | null
  preview_sent_at: number | null
  paid_at: number | null
  final_sent_at: number | null
  feed_sequence_json: string | null
  customer_details_json: string | null
}

interface ImageRow {
  id: string
  project_id: string
  position: number
  original_name: string
  stored_name: string
}

interface MotionSegmentRow {
  id: string
  project_id: string
  image_id: string
  motion: string
  duration_sec: number
  status: string
  clip_name: string | null
  clip_original_name: string | null
  clip_source: string | null
  prompt: string
  created_at: number
}

interface TransitionRow {
  project_id: string
  pair_key: string
  prompt: string
  duration_sec: number
  status: string
  clip_name: string | null
  clip_original_name: string | null
  clip_source: string | null
  prompt_base: string | null
  prompt_motion: string | null
  prompt_effective: string | null
  prompt_basis: string | null
  prompt_rationale: string | null
  prompt_manually_edited: number | null
  prompt_planned_at: number | null
  prompt_analysis_at: number | null
  mode: string | null
  mode_provenance: string | null
  operator_context_text: string | null
  operator_context_at: number | null
  operator_context_status: string | null
  operator_context_fingerprint: number | null
  prompt_evidence_source: string | null
  prompt_evidence_fingerprint: string | null
  prompt_operator_fingerprint: string | null
  prompt_suggestion: string | null
  prompt_suggestion_at: number | null
  prompt_suggestion_source: string | null
  prompt_suggestion_fingerprint: string | null
}

export function listProjects(): Project[] {
  const db = getDb()
  const projects = all<ProjectRow>(db, 'SELECT * FROM projects ORDER BY updated_at DESC')
  // ── SCOPED IN SQL, NOT ONLY IN JAVASCRIPT ───────────────────────────
  //
  // The `.filter()` below already guaranteed correctness — a project has
  // only ever been given rows carrying its own id, so an orphan could not
  // appear in anyone's editor. But reading every row first meant this
  // scaled with the size of the TABLE rather than with live data: on the
  // real database that was 1966 image rows parsed to render 30, on every
  // list, save and broadcast.
  //
  // The cascade bug made those orphans; this makes their presence stop
  // costing anything, which also means historical cleanup can wait for
  // approval without the app paying for the delay.
  const images = all<ImageRow>(
    db,
    `SELECT * FROM project_images
     WHERE project_id IN (SELECT id FROM projects)
     ORDER BY project_id, position`
  )
  const transitions = all<TransitionRow>(
    db,
    'SELECT * FROM transitions WHERE project_id IN (SELECT id FROM projects)'
  )
  // Single-image motion segments live in their own table — see the
  // migration note. A project written before it existed has no rows,
  // which reads as none.
  const motionRows = all<MotionSegmentRow>(
    db,
    'SELECT * FROM motion_segments WHERE project_id IN (SELECT id FROM projects) ORDER BY created_at'
  )

  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    watermark: JSON.parse(p.watermark_json) as PreviewWatermark,
    signature: JSON.parse(p.signature_json) as BrandSignature,
    status: (p.status ?? 'draft') as Project['status'],
    workflow: {
      previewSentAt: p.preview_sent_at,
      paidAt: p.paid_at,
      finalSentAt: p.final_sent_at
    },
    images: images
      .filter((i) => i.project_id === p.id)
      .map((i) => ({
        id: i.id,
        fileName: i.original_name,
        storedName: i.stored_name,
        src: imageUrl(p.id, i.stored_name)
      })),
    feedSequence: p.feed_sequence_json ? JSON.parse(p.feed_sequence_json) as string[] : undefined,
    motionSegments: motionRows
      .filter((m) => m.project_id === p.id)
      .map((m) => ({
        id: m.id,
        kind: 'single-motion' as const,
        imageId: m.image_id,
        motion: m.motion as MotionType,
        durationSec: m.duration_sec,
        status: m.status as MotionSegment['status'],
        clip: m.clip_name
          ? {
              storedName: m.clip_name,
              originalName: m.clip_original_name ?? m.clip_name,
              source: (m.clip_source ?? 'fal') as TransitionClip['source'],
              src: clipUrl(p.id, m.clip_name)
            }
          : null,
        prompt: m.prompt,
        createdAt: m.created_at
      })),
    customer: p.customer_details_json ? JSON.parse(p.customer_details_json) : undefined,
    transitions: Object.fromEntries(
      transitions
        .filter((t) => t.project_id === p.id)
        .map((t) => [
          t.pair_key,
          {
            prompt: t.prompt,
            durationSec: t.duration_sec,
            status: t.status,
            // NULL is `auto`: never configured, so the evidence decides.
            mode: (t.mode ?? 'auto') as TransitionMode,
            // Anything that is not an explicit marker reads as ABSENT.
            // `manual` is the branch that lets a generation proceed without
            // an accepted map, so it is never inferred — only stored.
            modeProvenance:
              t.mode_provenance === 'manual' || t.mode_provenance === 'analysis'
                ? t.mode_provenance
                : undefined,
            // Evidence the operator supplied, kept beside the analyzer's.
            operatorContext:
              t.operator_context_text && t.operator_context_text.trim().length > 0
                ? {
                    text: t.operator_context_text,
                    createdAt: t.operator_context_at ?? 0,
                    source: 'operator' as const,
                    analysisFingerprintAtCreation:
                      t.operator_context_fingerprint ?? undefined,
                    // Absent reads as 'current': rows written before the
                    // lifecycle existed were current when written, and
                    // demoting them all on upgrade would invalidate real
                    // operator knowledge nobody asked to re-check.
                    status: (t.operator_context_status === 'needs-review'
                      ? 'needs-review'
                      : 'current') as 'current' | 'needs-review'
                  }
                : undefined,
            promptSuggestion:
              t.prompt_suggestion && t.prompt_suggestion.trim().length > 0
                ? {
                    text: t.prompt_suggestion,
                    createdAt: t.prompt_suggestion_at ?? 0,
                    evidenceSource: (t.prompt_suggestion_source ??
                      'individual-analysis') as EvidenceSource,
                    evidenceFingerprint: t.prompt_suggestion_fingerprint ?? ''
                  }
                : undefined,
            clip: t.clip_name
              ? {
                  storedName: t.clip_name,
                  originalName: t.clip_original_name ?? t.clip_name,
                  source: (t.clip_source ?? 'manual') as ClipSource,
                  src: clipUrl(p.id, t.clip_name)
                }
              : null,
            // Absent for every transition written before migration 8. A
            // missing provenance record means "we have never planned this
            // prompt", which is exactly how an untouched transition should
            // read — and canRebuildPrompt(null) already allows a rebuild.
            promptProvenance:
              t.prompt_effective === null && t.prompt_manually_edited !== 1
                ? null
                : {
                    basePrompt: t.prompt_base ?? '',
                    motionInstruction: t.prompt_motion,
                    effectivePrompt: t.prompt_effective ?? '',
                    basis: (t.prompt_basis ?? 'unknown') as PromptPlanBasis,
                    rationale: t.prompt_rationale ?? '',
                    manuallyEdited: t.prompt_manually_edited === 1,
                    plannedAt: t.prompt_planned_at ?? 0,
                    analysisUpdatedAt: t.prompt_analysis_at ?? null,
                    // Absent reads as "we do not know what this was built
                    // from", which makes the wording stale rather than
                    // assumed to match the evidence in force today.
                    evidenceSource:
                      (t.prompt_evidence_source as PromptProvenance['evidenceSource']) ?? undefined,
                    evidenceFingerprint: t.prompt_evidence_fingerprint ?? undefined,
                    operatorContextFingerprint: t.prompt_operator_fingerprint ?? undefined,
                    pairKey: t.pair_key
                  }
          } as TransitionSettings
        ])
    )
  }))
}

/**
 * Savepoint names must be UNIQUE per invocation.
 *
 * SQLite's RELEASE frees the named savepoint AND every savepoint opened
 * after it. `saveProject` is now called from inside larger operations
 * that themselves call it again (Accept, then the prompt rebuild), so a
 * shared name meant an inner RELEASE silently discarded the outer one —
 * and the outer RELEASE then failed with "no such savepoint", masking
 * whatever had actually gone wrong.
 */
let savepointSeq = 0

/** Insert-or-replace the whole project graph in one transaction. */
export function saveProject(project: Project): void {
  const db = getDb()
  // SAVEPOINT, not BEGIN: this is called from inside larger operations
  // (Accept, and the prompt rebuild it triggers), and SQLite refuses a
  // nested BEGIN. A savepoint behaves as a transaction when outermost.
  const sp = `save_project_${++savepointSeq}`
  db.run(`SAVEPOINT ${sp}`)
  try {
    run(
      db,
      `INSERT INTO projects
         (id, name, created_at, updated_at, watermark_json, signature_json,
          status, preview_sent_at, paid_at, final_sent_at, feed_sequence_json, customer_details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         updated_at = excluded.updated_at,
         watermark_json = excluded.watermark_json,
         signature_json = excluded.signature_json,
         status = excluded.status,
         preview_sent_at = excluded.preview_sent_at,
         paid_at = excluded.paid_at,
         final_sent_at = excluded.final_sent_at,
         feed_sequence_json = excluded.feed_sequence_json,
         customer_details_json = excluded.customer_details_json`,
      [
        project.id,
        project.name,
        project.createdAt,
        project.updatedAt,
        JSON.stringify(project.watermark),
        JSON.stringify(project.signature),
        // Derived statuses are never persisted — they come from the queue.
        project.status === 'queued' || project.status === 'generating' ? 'ready' : project.status,
        project.workflow?.previewSentAt ?? null,
        project.workflow?.paidAt ?? null,
        project.workflow?.finalSentAt ?? null,
        project.feedSequence ? JSON.stringify(project.feedSequence) : null,
        project.customer ? JSON.stringify(project.customer) : null
      ]
    )

    run(db, 'DELETE FROM project_images WHERE project_id = ?', [project.id])
    project.images.forEach((image, position) => {
      run(
        db,
        `INSERT INTO project_images (id, project_id, position, original_name, stored_name)
         VALUES (?, ?, ?, ?, ?)`,
        [image.id, project.id, position, image.fileName, image.storedName]
      )
    })

    // ── MOTION SEGMENTS, REPLACED WHOLE LIKE THE TRANSITIONS ──────────
    //
    // Only when the project actually carries the field. `undefined` means
    // a caller that predates single-image motion and knows nothing about
    // it — deleting the rows on its behalf would silently drop segments
    // an older code path never intended to touch.
    if (project.motionSegments !== undefined) {
      run(db, 'DELETE FROM motion_segments WHERE project_id = ?', [project.id])
      for (const segment of project.motionSegments) {
        run(
          db,
          `INSERT INTO motion_segments
             (id, project_id, image_id, motion, duration_sec, status,
              clip_name, clip_original_name, clip_source, prompt, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            segment.id,
            project.id,
            segment.imageId,
            segment.motion,
            segment.durationSec,
            segment.status,
            segment.clip?.storedName ?? null,
            segment.clip?.originalName ?? null,
            segment.clip?.source ?? null,
            segment.prompt,
            segment.createdAt
          ]
        )
      }
    }

    run(db, 'DELETE FROM transitions WHERE project_id = ?', [project.id])
    for (const [pairKey, t] of Object.entries(project.transitions)) {
      run(
        db,
        `INSERT INTO transitions
           (project_id, pair_key, prompt, duration_sec, status,
            clip_name, clip_original_name, clip_source,
            prompt_base, prompt_motion, prompt_effective, prompt_basis,
            prompt_rationale, prompt_manually_edited, prompt_planned_at,
            prompt_analysis_at, mode, mode_provenance,
            operator_context_text, operator_context_at,
            operator_context_status, operator_context_fingerprint,
            prompt_evidence_source, prompt_evidence_fingerprint,
            prompt_operator_fingerprint, prompt_suggestion,
            prompt_suggestion_at, prompt_suggestion_source,
            prompt_suggestion_fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          project.id,
          pairKey,
          t.prompt,
          t.durationSec,
          t.status,
          t.clip?.storedName ?? null,
          t.clip?.originalName ?? null,
          t.clip?.source ?? null,
          t.promptProvenance?.basePrompt ?? null,
          t.promptProvenance?.motionInstruction ?? null,
          t.promptProvenance?.effectivePrompt ?? null,
          t.promptProvenance?.basis ?? null,
          t.promptProvenance?.rationale ?? null,
          t.promptProvenance?.manuallyEdited ? 1 : 0,
          t.promptProvenance?.plannedAt ?? null,
          t.promptProvenance?.analysisUpdatedAt ?? null,
          // NULL means `auto` — nobody has decided, and the evidence does.
          // Storing 'auto' explicitly would be indistinguishable from a
          // deliberate choice, and re-analysis must be free to revisit one
          // but never the other.
          t.mode && t.mode !== 'auto' ? t.mode : null,
          // Only meaningful alongside a stored mode; auto has no author.
          t.mode && t.mode !== 'auto' ? (t.modeProvenance ?? null) : null,
          // Written whenever it exists, independent of mode: it is a fact
          // about the property, not a decision about the transition, and
          // it must outlive any mode the pair happens to carry.
          t.operatorContext?.text ?? null,
          t.operatorContext?.createdAt ?? null,
          // Written explicitly rather than left to the column default:
          // the whole point of the lifecycle is that `needs-review` must
          // persist, and a default of 'current' would silently re-trust
          // text the operator has not confirmed.
          t.operatorContext?.status ?? 'current',
          t.operatorContext?.analysisFingerprintAtCreation ?? null,
          // What the wording was built from. Absent reads downstream as
          // "unknown", which makes the prompt stale rather than assumed
          // to match — see isPromptBasisCurrent.
          t.promptProvenance?.evidenceSource ?? null,
          t.promptProvenance?.evidenceFingerprint ?? null,
          t.promptProvenance?.operatorContextFingerprint ?? null,
          // A suggestion held beside a hand-written prompt, never in it.
          t.promptSuggestion?.text ?? null,
          t.promptSuggestion?.createdAt ?? null,
          t.promptSuggestion?.evidenceSource ?? null,
          t.promptSuggestion?.evidenceFingerprint ?? null
        ]
      )
    }

    db.run(`RELEASE ${sp}`)
  } catch (err) {
    // The ORIGINAL error is what matters. A failed rollback — the
    // savepoint already gone because an outer unit unwound first —
    // must not replace it with a confusing "no such savepoint".
    try {
      db.run(`ROLLBACK TO ${sp}`)
      db.run(`RELEASE ${sp}`)
    } catch (rollbackErr) {
      console.error('[projects] rollback could not run', rollbackErr)
    }
    throw err
  }
  scheduleFlush()
}

/**
 * Delete one project and everything it owns.
 *
 * ── WHAT GOES, AND HOW ───────────────────────────────────────────────
 *
 * CASCADE-DELETED by the schema, because these tables declare
 * `REFERENCES projects(id) ON DELETE CASCADE` and mean it:
 *
 *   project_images      the photographs' rows
 *   transitions         prompts, durations, clip references, provenance
 *   property_analysis   the accepted analysis document
 *   analysis_reviews    ground-truth verdicts, both scopes
 *   image_overrides     manual corrections
 *
 * Deliberately NOT re-deleted by hand here. Enforcement is now armed on
 * every connection (see db/index.ts), and duplicating the cascade in code
 * would hide a future regression: `testProjectDeletionCascade` asserts the
 * child rows are gone, and it must be the SCHEMA that makes that true.
 *
 * INTENTIONALLY RETAINED, handled elsewhere and on purpose:
 *
 *   queue_jobs                finished history stays so completed customer
 *                             value remains visible; PENDING work for this
 *                             project is cancelled by the caller.
 *   generation_cost_entries   the spend ledger is append-only. Money that
 *                             left the account is not un-spent by deleting
 *                             the project it was spent on, and a ledger
 *                             that quietly shrinks cannot be reconciled.
 *
 * Neither has a foreign key, which is what makes that retention possible
 * rather than accidental.
 *
 * The managed folder on disk is removed by the caller — this repo owns
 * rows, not files.
 */
export function deleteProjectRows(projectId: string): void {
  const db = getDb()
  run(db, 'DELETE FROM projects WHERE id = ?', [projectId])
  scheduleFlush()
}

export function getSettingsJson(): string | null {
  const rows = all<{ json: string }>(getDb(), 'SELECT json FROM app_settings WHERE id = 1')
  return rows[0]?.json ?? null
}

export function saveSettingsJson(json: string): void {
  run(
    getDb(),
    `INSERT INTO app_settings (id, json) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
    [json]
  )
  scheduleFlush()
}
