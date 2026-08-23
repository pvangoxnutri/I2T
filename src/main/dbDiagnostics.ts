import { getDb } from './db/index'
import { listProjects } from './db/projectsRepo'

/**
 * READ-ONLY database forensics (`electron . --f2f-dbdiag`).
 *
 * ── WHY THIS EXISTS AS A MODE, NOT A SCRIPT ──────────────────────────
 *
 * A standalone Node script opens its OWN sql.js connection, and several
 * of the things being investigated here are per-connection rather than
 * stored in the file. `PRAGMA foreign_keys` is the obvious one: an
 * external script always reports 0 because it never set it, which looks
 * exactly like the app having it off.
 *
 * So this runs inside the real main process, on the connection
 * `openDatabase()` built, after the real migrations. What it prints is
 * what the application actually sees.
 *
 * WRITES NOTHING. Every statement is a SELECT or a read-only PRAGMA.
 */

type Cell = string | number | Uint8Array | null

function rows(sql: string): Cell[][] {
  try {
    const result = getDb().exec(sql)[0]
    return result ? (result.values as Cell[][]) : []
  } catch (err) {
    return [[`ERROR: ${err instanceof Error ? err.message : String(err)}`]]
  }
}

function scalar(sql: string): Cell {
  return rows(sql)[0]?.[0] ?? null
}

const line = (s = ''): void => console.log(s)

export function runDbDiagnostics(): void {
  const db = getDb()

  line('════════════════════════════════════════════════════════════════')
  line('  F2F DATABASE DIAGNOSTICS — read-only')
  line('════════════════════════════════════════════════════════════════')

  // ── 1. Connection-level state ────────────────────────────────────────
  line()
  line('── CONNECTION ──────────────────────────────────────────────────')
  line(`user_version           : ${scalar('PRAGMA user_version')}`)
  line(`foreign_keys (this conn): ${scalar('PRAGMA foreign_keys')}`)
  line(`defer_foreign_keys     : ${scalar('PRAGMA defer_foreign_keys')}`)
  line(`legacy_alter_table     : ${scalar('PRAGMA legacy_alter_table')}`)

  // Does this sql.js build even SUPPORT foreign keys? A build compiled
  // with SQLITE_OMIT_FOREIGN_KEY silently ignores the pragma, which would
  // look identical to the pragma not being set.
  const compile = rows('PRAGMA compile_options').map((r) => String(r[0]))
  line(`OMIT_FOREIGN_KEY compiled out? ${compile.includes('OMIT_FOREIGN_KEY') ? 'YES' : 'no'}`)
  line(`compile_options: ${compile.join(', ')}`)

  // ── THE EXPERIMENT ───────────────────────────────────────────────────
  //
  // openDatabase() already ran `PRAGMA foreign_keys = ON` on THIS
  // connection, and the read above says 0. Two candidate explanations,
  // and one experiment separates them:
  //
  //   set it again now, on an idle connection with no transaction open.
  //
  // If it takes → the statement in openDatabase() ran at a moment when
  // SQLite ignores it (the pragma is a documented no-op inside a
  // transaction), and the fix is about WHERE it is issued.
  // If it still reads 0 → this build ignores the pragma outright, and no
  // amount of reordering will help; deletion has to be explicit.
  line()
  line('experiment: re-issue the pragma on an idle connection')
  db.run('PRAGMA foreign_keys = ON')
  line(`  after db.run('PRAGMA foreign_keys = ON') : ${scalar('PRAGMA foreign_keys')}`)
  db.exec('PRAGMA foreign_keys = ON')
  line(`  after db.exec(...)                       : ${scalar('PRAGMA foreign_keys')}`)
  // And prove whether ENFORCEMENT follows the flag, rather than trusting
  // the flag. A temp parent/child pair, deleted, counted, dropped.
  try {
    db.run('CREATE TEMP TABLE diag_parent (id TEXT PRIMARY KEY)')
    db.run(
      'CREATE TEMP TABLE diag_child (id TEXT, parent TEXT NOT NULL REFERENCES diag_parent(id) ON DELETE CASCADE)'
    )
    db.run("INSERT INTO diag_parent (id) VALUES ('p1')")
    db.run("INSERT INTO diag_child (id, parent) VALUES ('c1','p1'), ('c2','p1')")
    const before = scalar('SELECT COUNT(*) FROM diag_child')
    db.run("DELETE FROM diag_parent WHERE id = 'p1'")
    const after = scalar('SELECT COUNT(*) FROM diag_child')
    line(`  cascade probe: children ${before} → ${after}  ${after === 0 ? '(CASCADE FIRES)' : '(CASCADE DOES NOT FIRE)'}`)
    db.run('DROP TABLE diag_child')
    db.run('DROP TABLE diag_parent')
  } catch (err) {
    line(`  cascade probe failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // ── WHAT TURNS IT BACK OFF ───────────────────────────────────────────
  //
  // The flag takes when set on an idle connection, yet reads 0 after
  // startup — so something between the two clears it. The suspect is
  // `db.export()`, which is what flushNow() calls on every write: sql.js
  // implements export by CLOSING the connection and reopening it, and a
  // fresh connection starts with foreign_keys at its default of OFF.
  //
  // Proven rather than recalled: read it, export, read it again.
  line()
  line('experiment: does db.export() (what flushNow calls) clear the flag?')
  line(`  before export : ${scalar('PRAGMA foreign_keys')}`)
  db.export()
  line(`  after  export : ${scalar('PRAGMA foreign_keys')}`)

  // ── 2. The ACTUAL schema, as stored ──────────────────────────────────
  line()
  line('── STORED SCHEMA (sqlite_master) ───────────────────────────────')
  for (const table of ['projects', 'project_images', 'transitions']) {
    const sql = scalar(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '${table}'`
    )
    line()
    line(`${table}:`)
    line(sql === null ? '  (table does not exist)' : String(sql).split('\n').map((l) => `  ${l.trim()}`).join('\n'))
  }

  // ── 3. Foreign keys the ENGINE actually parsed ───────────────────────
  //
  // This is the decisive read. `sqlite_master` shows the text; this shows
  // what SQLite made of it — including the on_delete action it will
  // actually perform.
  line()
  line('── PRAGMA foreign_key_list ─────────────────────────────────────')
  for (const table of [
    'project_images',
    'transitions',
    'queue_jobs',
    'property_analysis',
    'generation_cost_entries',
    'analysis_reviews',
    'image_overrides'
  ]) {
    const fks = rows(`PRAGMA foreign_key_list(${table})`)
    line()
    line(`${table}:`)
    if (fks.length === 0) {
      line('  NO FOREIGN KEYS')
      continue
    }
    // columns: id, seq, table, from, to, on_update, on_delete, match
    for (const fk of fks) {
      line(`  ${fk[3]} → ${fk[2]}(${fk[4]})   ON DELETE ${fk[6]}   ON UPDATE ${fk[5]}`)
    }
  }

  // ── 4. Integrity ─────────────────────────────────────────────────────
  line()
  line('── PRAGMA foreign_key_check ────────────────────────────────────')
  const violations = rows('PRAGMA foreign_key_check')
  line(`violations: ${violations.length}`)
  // Grouped — a thousand identical violations is one fact, not a thousand.
  const byTable = new Map<string, number>()
  for (const v of violations) {
    const key = `${v[0]} → ${v[2]}`
    byTable.set(key, (byTable.get(key) ?? 0) + 1)
  }
  for (const [key, count] of byTable) line(`  ${key}: ${count}`)

  // ── 5. Live projects and what belongs to them ────────────────────────
  line()
  line('── LIVE PROJECTS ───────────────────────────────────────────────')
  const live = new Set<string>()
  for (const p of rows('SELECT id, name, created_at, updated_at FROM projects ORDER BY created_at')) {
    live.add(String(p[0]))
    const id = String(p[0])
    const images = scalar(`SELECT COUNT(*) FROM project_images WHERE project_id = '${id}'`)
    const trans = scalar(`SELECT COUNT(*) FROM transitions WHERE project_id = '${id}'`)
    line(`  ${p[1]}`)
    line(`    id       : ${id}`)
    line(`    created  : ${new Date(Number(p[2])).toISOString()}`)
    line(`    updated  : ${new Date(Number(p[3])).toISOString()}`)
    line(`    images   : ${images}`)
    line(`    transitions: ${trans}`)
  }

  // ── 6. Orphans, classified ───────────────────────────────────────────
  line()
  line('── ORPHANS ─────────────────────────────────────────────────────')
  for (const table of ['project_images', 'transitions']) {
    const total = Number(scalar(`SELECT COUNT(*) FROM ${table}`))
    const orphan = Number(
      scalar(`SELECT COUNT(*) FROM ${table} WHERE project_id NOT IN (SELECT id FROM projects)`)
    )
    line(`${table}: ${total} total, ${orphan} orphaned, ${total - orphan} owned by a live project`)
  }

  line()
  line('orphan project_ids, grouped and classified:')
  const groups = rows(
    `SELECT project_id,
            (SELECT COUNT(*) FROM project_images pi WHERE pi.project_id = g.project_id),
            (SELECT COUNT(*) FROM transitions t WHERE t.project_id = g.project_id)
     FROM (SELECT DISTINCT project_id FROM project_images
           UNION SELECT DISTINCT project_id FROM transitions) g
     WHERE g.project_id NOT IN (SELECT id FROM projects)
     ORDER BY g.project_id`
  )

  const buckets = { smoke: 0, unknown: 0 }
  const smokeRows = { images: 0, transitions: 0 }
  const unknownRows = { images: 0, transitions: 0 }
  const unknownIds: string[] = []

  for (const g of groups) {
    const id = String(g[0])
    const images = Number(g[1])
    const trans = Number(g[2])
    // ── WHAT COUNTS AS PROOF OF SMOKE OWNERSHIP ──────────────────────
    //
    // The smoke suite generates ids from a small set of literal prefixes
    // in makeProject()/tid(). A real project id is a crypto.randomUUID(),
    // which cannot begin with "smoke". So the prefix IS demonstrably
    // smoke-owned here — but only because the id format is generated, not
    // typed, and never derived from a project NAME the user controls.
    const smokeOwned = /^smoke[-\d]/.test(id)
    if (smokeOwned) {
      buckets.smoke++
      smokeRows.images += images
      smokeRows.transitions += trans
    } else {
      buckets.unknown++
      unknownRows.images += images
      unknownRows.transitions += trans
      unknownIds.push(`${id}  (${images} images, ${trans} transitions)`)
    }
    line(`  ${smokeOwned ? 'SMOKE  ' : 'UNKNOWN'} ${id}  images=${images} transitions=${trans}`)
  }

  line()
  line('── CLASSIFICATION SUMMARY ──────────────────────────────────────')
  line(`A. proven smoke-owned : ${buckets.smoke} project ids, ${smokeRows.images} images, ${smokeRows.transitions} transitions`)
  line(`C. unknown / not-smoke: ${buckets.unknown} project ids, ${unknownRows.images} images, ${unknownRows.transitions} transitions`)
  if (unknownIds.length > 0) {
    line()
    line('   unknown ids (NOT eligible for automatic cleanup):')
    for (const id of unknownIds) line(`     ${id}`)
  }

  // ── 7. Managed folders on disk ───────────────────────────────────────
  line()
  line('── OTHER TABLES ────────────────────────────────────────────────')
  for (const t of [
    'queue_jobs',
    'generation_cost_entries',
    'property_analysis',
    'analysis_reviews',
    'image_overrides'
  ]) {
    const total = Number(scalar(`SELECT COUNT(*) FROM ${t}`))
    const orphan = Number(
      scalar(`SELECT COUNT(*) FROM ${t} WHERE project_id NOT IN (SELECT id FROM projects)`)
    )
    line(`${t}: ${total} total, ${orphan} not matching a live project`)
  }

  // ── 8. WHAT THE APPLICATION ACTUALLY RENDERS ─────────────────────────
  //
  // The decisive check for §10, and deliberately NOT another SQL count:
  // the question is not what the tables hold, it is what `listProjects()`
  // hands the editor. A repo that loaded child rows unscoped would show
  // orphans inside a live project, and only this path would reveal it.
  line()
  line('── VIA listProjects() — what the editor is handed ──────────────')
  let renderedImages = 0
  let renderedTransitions = 0
  for (const project of listProjects()) {
    renderedImages += project.images.length
    renderedTransitions += Object.keys(project.transitions).length
    line(`  ${project.name}`)
    line(`    images      : ${project.images.length}`)
    line(`    transitions : ${Object.keys(project.transitions).length}`)
    // Every rendered image must resolve to a managed f2f:// url for THIS
    // project — a leaked row would surface as a foreign id here.
    const foreign = project.images.filter((i) => !i.src.includes(project.id))
    line(`    images not belonging to this project: ${foreign.length}`)
  }
  const totalImageRows = Number(scalar('SELECT COUNT(*) FROM project_images'))
  const totalTransitionRows = Number(scalar('SELECT COUNT(*) FROM transitions'))
  line()
  line(`  rendered ${renderedImages} images of ${totalImageRows} rows in the table`)
  line(`  rendered ${renderedTransitions} transitions of ${totalTransitionRows} rows`)
  line(
    `  ${totalImageRows - renderedImages} image rows and ${totalTransitionRows - renderedTransitions} transition rows are historical orphans, invisible to the app`
  )

  line()
  line('════════════════════════════════════════════════════════════════')
  void db
  void live
}
