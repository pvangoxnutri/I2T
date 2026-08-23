import initSqlJs, { type Database } from 'sql.js'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { databaseFile, ensureDir, userDataDir } from '../paths'
import { migrate } from './migrations'

/**
 * SQLite via sql.js (SQLite compiled to WebAssembly).
 *
 * WHY WASM AND NOT A NATIVE DRIVER: better-sqlite3 has no prebuilt Electron
 * binaries and this machine has no C++ toolchain — sql.js runs the real
 * SQLite engine and reads/writes the standard SQLite file format, so a later
 * swap to a native driver opens the very same database file.
 *
 * WRITE MODEL: the database lives in memory; every mutation schedules a
 * debounced flush that atomically replaces the file on disk (tmp + rename).
 * `flushNow()` runs on app quit so nothing is lost on close.
 */

let db: Database | null = null
let flushTimer: NodeJS.Timeout | null = null

const FLUSH_DELAY_MS = 250

export async function openDatabase(): Promise<Database> {
  if (db) return db
  ensureDir(userDataDir())

  const SQL = await initSqlJs({
    // Resolve the wasm binary from the installed package (deps are
    // externalized, so node_modules is present at runtime).
    locateFile: (file: string) => join(require.resolve('sql.js/dist/sql-wasm.js'), '..', file)
  })

  const file = databaseFile()
  db = existsSync(file) ? new SQL.Database(readFileSync(file)) : new SQL.Database()

  // MIGRATIONS RUN WITH ENFORCEMENT OFF, which is SQLite's own documented
  // procedure for altering a table: disable foreign keys, recreate inside
  // a transaction, re-enable afterwards.
  //
  // Not a shortcut. A recreation migration copies rows into a table that
  // declares a foreign key, and enforcement during that copy would abort
  // the whole migration over a single pre-existing orphan — turning a data
  // inconsistency into an app that will not start. Rows are copied intact
  // and any inconsistency is reported by `foreignKeyViolations()` for
  // explicit handling, rather than silently dropped or fatal.
  migrate(db)
  armForeignKeys(db)
  flushNow()
  return db
}

/**
 * Turn ON foreign key enforcement — and be prepared to do it again.
 *
 * ── THE BUG THIS EXISTS FOR ──────────────────────────────────────────
 *
 * `PRAGMA foreign_keys` is a CONNECTION setting, not a property of the
 * file, and SQLite defaults it to OFF. sql.js implements `export()` by
 * closing the database and reopening it — so every flush silently handed
 * us a brand-new connection with enforcement back off.
 *
 * The window in which it was ever on was the two lines between setting it
 * and the first `flushNow()`. For the entire working life of the app after
 * that it was off, which meant `ON DELETE CASCADE` never fired: deleting a
 * project left every one of its `project_images` and `transitions` rows
 * behind, permanently. The schema was correct the whole time; nothing was
 * enforcing it.
 *
 * Proven, not assumed: `PRAGMA foreign_keys` reads 1 before `export()` and
 * 0 immediately after, on the same connection. `testForeignKeyEnforcement`
 * pins it, and fails against the pre-fix code.
 */
function armForeignKeys(database: Database): void {
  database.run('PRAGMA foreign_keys = ON')
}

export function getDb(): Database {
  if (!db) throw new Error('Database not opened yet')
  return db
}

/** Call after every mutating operation. */
export function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(flushNow, FLUSH_DELAY_MS)
}

export function flushNow(): void {
  if (!db) return
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  const file = databaseFile()
  const tmp = `${file}.tmp`
  const bytes = db.export()
  // `export()` closed and reopened the connection, so the reopened one is
  // back to SQLite's default of foreign keys OFF. Re-arm it immediately —
  // this single line is the difference between cascading deletes working
  // and every deleted project leaking its rows forever.
  // No environment escape hatch here, unlike the smoke teardown switches:
  // those disable cleanup, this one guarantees data integrity. The guard
  // was proven by temporarily deleting this line — the suite then fails on
  // "foreign key enforcement is on before flushing", which is the root
  // cause named directly rather than a downstream symptom.
  armForeignKeys(db)
  writeFileSync(tmp, Buffer.from(bytes))
  renameSync(tmp, file)
}

/** Whether enforcement is currently on. Test seam for the guard above. */
export function foreignKeysEnabled(): boolean {
  return getDb().exec('PRAGMA foreign_keys')[0]?.values[0]?.[0] === 1
}

/** Rows that violate a declared foreign key. Empty is the healthy state. */
export function foreignKeyViolations(): Array<{ table: string; parent: string }> {
  const result = getDb().exec('PRAGMA foreign_key_check')[0]
  if (!result) return []
  return result.values.map((row) => ({ table: String(row[0]), parent: String(row[2]) }))
}
