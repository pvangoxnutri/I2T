import { randomUUID } from 'node:crypto'
import { getDb, scheduleFlush } from './index'
import type { CostCategory, GenerationCostEntry } from '../../shared/costLedger'
import { nextAttemptNumber } from '../../shared/costLedger'

/**
 * The production-spend ledger. APPEND-ONLY — see shared/costLedger.ts.
 *
 * There is no update and no delete for a recorded charge, deliberately.
 * The only mutation allowed is filling in the ACTUAL cost once the real
 * rate is known, which refines an existing charge rather than removing
 * one. Money already spent cannot be un-spent by regenerating.
 */

interface Row {
  id: string
  project_id: string
  pair_key: string
  transition_pair: string
  provider: string
  model: string
  duration_sec: number | null
  resolution: string | null
  created_at: number
  remote_task_id: string | null
  job_id: string | null
  attempt_number: number
  estimated_cost: number | null
  actual_cost: number | null
  currency: string
  status: string
  is_regeneration: number
  category: string | null
}

function toEntry(row: Row): GenerationCostEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    pairKey: row.pair_key,
    transitionPair: row.transition_pair,
    provider: row.provider,
    model: row.model,
    durationSec: row.duration_sec,
    resolution: row.resolution,
    createdAt: row.created_at,
    remoteTaskId: row.remote_task_id,
    jobId: row.job_id,
    attemptNumber: row.attempt_number,
    estimatedCost: row.estimated_cost,
    actualCost: row.actual_cost,
    currency: row.currency,
    status: row.status as GenerationCostEntry['status'],
    isRegeneration: row.is_regeneration === 1,
    // Absent on rows written before categories existed — and every one
    // of those was a video generation.
    category: (row.category ?? 'video-generation') as GenerationCostEntry['category']
  }
}

export function listCostEntries(projectId: string): GenerationCostEntry[] {
  const db = getDb()
  const stmt = db.prepare(
    'SELECT * FROM generation_cost_entries WHERE project_id = ? ORDER BY created_at ASC'
  )
  const out: GenerationCostEntry[] = []
  try {
    stmt.bind([projectId])
    while (stmt.step()) out.push(toEntry(stmt.getAsObject() as unknown as Row))
  } finally {
    stmt.free()
  }
  return out
}

/**
 * The charge already recorded for one remote task, WITHIN one project.
 *
 * Scoped to the project deliberately (see migration 9): a task id seen
 * under some other project must not suppress this project's charge.
 * Under-recording spend is worse than the duplicate it would prevent —
 * the money leaves either way, and only one outcome is visible.
 */
export function costEntryForTask(
  projectId: string,
  remoteTaskId: string
): GenerationCostEntry | null {
  const db = getDb()
  const stmt = db.prepare(
    'SELECT * FROM generation_cost_entries WHERE project_id = ? AND remote_task_id = ?'
  )
  try {
    stmt.bind([projectId, remoteTaskId])
    if (!stmt.step()) return null
    return toEntry(stmt.getAsObject() as unknown as Row)
  } finally {
    stmt.free()
  }
}

export interface RecordSpendInput {
  projectId: string
  pairKey: string
  transitionPair: string
  provider: string
  model: string
  durationSec: number | null
  resolution: string | null
  remoteTaskId: string | null
  jobId: string | null
  estimatedCost: number | null
  actualCost?: number | null
  currency: string
  status?: GenerationCostEntry['status']
  /** Defaults to video generation — the only category that exists today. */
  category?: CostCategory
}

/**
 * Record ONE accepted paid generation.
 *
 * IDEMPOTENT ON THE REMOTE TASK ID. The poller, a Retry, a resumed poll
 * after a crash and a restart can all pass through the record path for the
 * same task; charging that task more than once would inflate our reported
 * spend for a single generation. A regeneration gets a NEW remote task id,
 * so it correctly records as a new attempt.
 *
 * Callers must only reach here once the provider has ACCEPTED the request.
 * Dry runs, the mock provider and pre-submit validation failures never do.
 */
export function recordGenerationSpend(input: RecordSpendInput): GenerationCostEntry {
  if (input.remoteTaskId) {
    const existing = costEntryForTask(input.projectId, input.remoteTaskId)
    if (existing) return existing
  }

  const all = listCostEntries(input.projectId)
  const attemptNumber = nextAttemptNumber(all, input.pairKey)
  const entry: GenerationCostEntry = {
    id: randomUUID(),
    projectId: input.projectId,
    pairKey: input.pairKey,
    transitionPair: input.transitionPair,
    provider: input.provider,
    model: input.model,
    durationSec: input.durationSec,
    resolution: input.resolution,
    createdAt: Date.now(),
    remoteTaskId: input.remoteTaskId,
    jobId: input.jobId,
    attemptNumber,
    estimatedCost: input.estimatedCost,
    actualCost: input.actualCost ?? null,
    currency: input.currency,
    status: input.status ?? 'submitted',
    // Anything past the first attempt for this pair is a regeneration.
    isRegeneration: attemptNumber > 1,
    category: input.category ?? 'video-generation'
  }

  const db = getDb()
  db.run(
    `INSERT INTO generation_cost_entries (
       id, project_id, pair_key, transition_pair, provider, model, duration_sec,
       resolution, created_at, remote_task_id, job_id, attempt_number,
       estimated_cost, actual_cost, currency, status, is_regeneration, category
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      entry.id,
      entry.projectId,
      entry.pairKey,
      entry.transitionPair,
      entry.provider,
      entry.model,
      entry.durationSec,
      entry.resolution,
      entry.createdAt,
      entry.remoteTaskId,
      entry.jobId,
      entry.attemptNumber,
      entry.estimatedCost,
      entry.actualCost,
      entry.currency,
      entry.status,
      entry.isRegeneration ? 1 : 0,
      entry.category ?? 'video-generation'
    ]
  )
  scheduleFlush()
  return entry
}

/**
 * Record ONE whole-property analysis charge.
 *
 * ── WHEN, AND WHAT IS HONEST TO WRITE ────────────────────────────────
 *
 * Called only once a provider has ACCEPTED a real request — a dry run
 * never reaches here, and neither does the mock or manual analyzer.
 *
 * `actualCost` is written ONLY when the configured rate has been verified
 * against the vendor's published pricing. With an unverified rate we keep
 * the token usage — which is a fact the provider reported — and leave the
 * money null. A fabricated dollar figure would look reconcilable against
 * an invoice and would not be, which is the worse of the two failures.
 *
 * Idempotent on the operation id, like a generation charge: a retry or a
 * restart passing through here again must not double-count one analysis.
 */
export interface RecordAnalysisSpendInput {
  projectId: string
  provider: string
  model: string
  /** Provider request/operation id, when one is returned. */
  operationId: string | null
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  /** Null unless the configured rate is verified. */
  actualCost: number | null
  estimatedCost: number | null
  currency: string
}

export function recordAnalysisSpend(input: RecordAnalysisSpendInput): GenerationCostEntry {
  if (input.operationId) {
    const existing = costEntryForTask(input.projectId, input.operationId)
    if (existing) return existing
  }

  const usageNote =
    input.totalTokens !== null
      ? `${input.inputTokens ?? '?'} in / ${input.outputTokens ?? '?'} out / ${input.totalTokens} total tokens`
      : 'usage not reported'

  const entry: GenerationCostEntry = {
    id: randomUUID(),
    projectId: input.projectId,
    // Analysis is a PROPERTY-level charge, not a transition-level one, so
    // it carries no pair key. `transitionPair` holds the usage instead, so
    // the history line says something true rather than blank.
    pairKey: '',
    transitionPair: `Whole-property analysis · ${usageNote}`,
    provider: input.provider,
    model: input.model,
    durationSec: null,
    resolution: null,
    createdAt: Date.now(),
    remoteTaskId: input.operationId,
    jobId: null,
    attemptNumber: nextAttemptNumber(listCostEntries(input.projectId), ''),
    estimatedCost: input.estimatedCost,
    actualCost: input.actualCost,
    currency: input.currency,
    status: 'succeeded',
    isRegeneration: false,
    category: 'vision-analysis'
  }

  const db = getDb()
  db.run(
    `INSERT INTO generation_cost_entries (
       id, project_id, pair_key, transition_pair, provider, model, duration_sec,
       resolution, created_at, remote_task_id, job_id, attempt_number,
       estimated_cost, actual_cost, currency, status, is_regeneration, category
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      entry.id,
      entry.projectId,
      entry.pairKey,
      entry.transitionPair,
      entry.provider,
      entry.model,
      null,
      null,
      entry.createdAt,
      entry.remoteTaskId,
      null,
      entry.attemptNumber,
      entry.estimatedCost,
      entry.actualCost,
      entry.currency,
      entry.status,
      0,
      'vision-analysis'
    ]
  )
  scheduleFlush()
  return entry
}

/**
 * Remove every ledger row for a project.
 *
 * NOT part of normal operation — the ledger is append-only precisely so
 * spend cannot be erased. This exists for two cases where the rows are not
 * accounting at all: tearing down smoke-test fixtures, and deleting a
 * project outright (at which point its spend history has nothing left to
 * describe). Never call it to "reset" a live project's costs.
 */
export function deleteCostEntriesForProject(projectId: string): void {
  const db = getDb()
  db.run('DELETE FROM generation_cost_entries WHERE project_id = ?', [projectId])
  scheduleFlush()
}

/**
 * Refine an existing charge once the outcome or the real rate is known.
 * Never changes the fact that the charge happened.
 */
export function settleGenerationSpend(
  projectId: string,
  remoteTaskId: string,
  patch: { actualCost?: number | null; status?: GenerationCostEntry['status'] }
): void {
  const existing = costEntryForTask(projectId, remoteTaskId)
  if (!existing) return
  const db = getDb()
  db.run(
    'UPDATE generation_cost_entries SET actual_cost = ?, status = ? WHERE project_id = ? AND remote_task_id = ?',
    [
      patch.actualCost === undefined ? existing.actualCost : patch.actualCost,
      patch.status ?? existing.status,
      projectId,
      remoteTaskId
    ]
  )
  scheduleFlush()
}
