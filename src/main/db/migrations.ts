import type { Database } from 'sql.js'

/**
 * Versioned schema migrations, applied in order against SQLite's built-in
 * `PRAGMA user_version`. The schema WILL grow (queue, generated clips,
 * exports), so every change lands as a new entry here — never by editing an
 * old one, which would desync existing databases.
 */

interface Migration {
  version: number
  up: (db: Database) => void
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.run(`
        CREATE TABLE projects (
          id            TEXT PRIMARY KEY,
          name          TEXT NOT NULL,
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL,
          watermark_json TEXT NOT NULL,
          signature_json TEXT NOT NULL
        );

        CREATE TABLE project_images (
          id            TEXT PRIMARY KEY,
          project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          position      INTEGER NOT NULL,
          original_name TEXT NOT NULL,
          stored_name   TEXT NOT NULL
        );
        CREATE INDEX idx_project_images ON project_images(project_id, position);

        CREATE TABLE transitions (
          project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          pair_key     TEXT NOT NULL,
          prompt       TEXT NOT NULL,
          duration_sec REAL NOT NULL,
          status       TEXT NOT NULL,
          PRIMARY KEY (project_id, pair_key)
        );

        CREATE TABLE app_settings (
          id   INTEGER PRIMARY KEY CHECK (id = 1),
          json TEXT NOT NULL
        );
      `)
    }
  },
  {
    // Milestone 3: transitions can reference a local output video clip.
    // Provider-agnostic on purpose — manual test imports today, Kling and
    // future providers later populate the exact same columns.
    version: 2,
    up: (db) => {
      db.run(`
        ALTER TABLE transitions ADD COLUMN clip_name TEXT;
        ALTER TABLE transitions ADD COLUMN clip_original_name TEXT;
        ALTER TABLE transitions ADD COLUMN clip_source TEXT;
      `)
    }
  },
  {
    // Milestone 4: production workflow, persistent queue and scheduling.
    version: 3,
    up: (db) => {
      db.run(`
        -- Project production status + internal customer workflow. Only the
        -- user-set statuses are stored; queued/generating are derived from
        -- live queue activity so a crash cannot strand a project.
        ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'draft';
        ALTER TABLE projects ADD COLUMN preview_sent_at INTEGER;
        ALTER TABLE projects ADD COLUMN paid_at INTEGER;
        ALTER TABLE projects ADD COLUMN final_sent_at INTEGER;

        -- 'processing' was the old transition state name; the generation
        -- vocabulary calls it 'generating'.
        UPDATE transitions SET status = 'generating' WHERE status = 'processing';

        -- Persistent queue. Rows are self-describing (metadata_json) so a
        -- job survives termination and can run on the next launch without
        -- any in-memory closure.
        CREATE TABLE queue_jobs (
          id             TEXT PRIMARY KEY,
          project_id     TEXT NOT NULL,
          project_name   TEXT NOT NULL,
          kind           TEXT NOT NULL,
          status         TEXT NOT NULL,
          queue_order    INTEGER NOT NULL,
          progress_pct   INTEGER NOT NULL DEFAULT 0,
          transition_count INTEGER NOT NULL DEFAULT 0,
          created_at     INTEGER NOT NULL,
          scheduled_for  INTEGER,
          started_at     INTEGER,
          completed_at   INTEGER,
          error          TEXT,
          price_json     TEXT,
          metadata_json  TEXT NOT NULL DEFAULT '{}',
          output_path    TEXT
        );
        CREATE INDEX idx_queue_status ON queue_jobs(status, queue_order);
        CREATE INDEX idx_queue_project ON queue_jobs(project_id);

        -- Queue-level state (paused across restarts).
        CREATE TABLE queue_state (
          id     INTEGER PRIMARY KEY CHECK (id = 1),
          paused INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO queue_state (id, paused) VALUES (1, 0);
      `)
    }
  },
  {
    // Milestone 5A: provider lifecycle for AI generation jobs. Dedicated
    // columns (not just metadata JSON) because a future real generation must
    // be recoverable after a restart: provider_task_id is the idempotency
    // anchor that stops a retry from paying for a second remote task.
    version: 4,
    up: (db) => {
      db.run(`
        ALTER TABLE queue_jobs ADD COLUMN provider TEXT;
        ALTER TABLE queue_jobs ADD COLUMN provider_model TEXT;
        ALTER TABLE queue_jobs ADD COLUMN provider_dry_run INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE queue_jobs ADD COLUMN provider_task_id TEXT;
        ALTER TABLE queue_jobs ADD COLUMN provider_status TEXT;
        ALTER TABLE queue_jobs ADD COLUMN provider_submitted_at INTEGER;
        ALTER TABLE queue_jobs ADD COLUMN provider_last_polled_at INTEGER;
        ALTER TABLE queue_jobs ADD COLUMN provider_meta_json TEXT;
        ALTER TABLE queue_jobs ADD COLUMN estimated_cost REAL;
        ALTER TABLE queue_jobs ADD COLUMN actual_cost REAL;
        ALTER TABLE queue_jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX idx_queue_provider_task ON queue_jobs(provider_task_id);
      `)
    }
  },
  {
    // Milestone 5B follow-up: Kling bills in CREDITS, not currency, and no
    // official credit→money conversion is published. Credits get their own
    // columns so a cost number can never be silently mistaken for a price.
    version: 5,
    up: (db) => {
      db.run(`
        ALTER TABLE queue_jobs ADD COLUMN estimated_credits REAL;
        ALTER TABLE queue_jobs ADD COLUMN actual_credits REAL;
      `)
    }
  },
  {
    // Milestone 6A: whole-property analysis.
    //
    // Stored as ONE JSON document per project rather than normalized rooms
    // and edges. The shape is still being learned — rooms, landmarks,
    // adjacency confidence, per-image cues — and a provider swap (mock
    // today, a vision model later) will change what a room record carries.
    // A JSON column absorbs that without a migration per field, and the
    // scene graph is always read and written whole anyway.
    version: 6,
    up: (db) => {
      db.run(`
        CREATE TABLE property_analysis (
          project_id  TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
          json        TEXT NOT NULL,
          updated_at  INTEGER NOT NULL
        );
      `)
    }
  },
  {
    // Milestone 6B: OUR production spend ledger.
    //
    // APPEND-ONLY BY DESIGN. Three generations of the same transition are
    // three rows totalling three charges — the old row is never replaced by
    // the newest attempt, because the money was really spent either way.
    // Nothing here is derived from the CUSTOMER price, which lives in
    // projects/pricing and means something entirely different.
    //
    // Money stays in the PROVIDER's currency. No FX is invented.
    version: 7,
    up: (db) => {
      db.run(`
        CREATE TABLE generation_cost_entries (
          id                 TEXT PRIMARY KEY,
          project_id         TEXT NOT NULL,
          pair_key           TEXT NOT NULL,
          transition_pair    TEXT NOT NULL,
          provider           TEXT NOT NULL,
          model              TEXT NOT NULL,
          duration_sec       REAL,
          resolution         TEXT,
          created_at         INTEGER NOT NULL,
          remote_task_id     TEXT,
          job_id             TEXT,
          attempt_number     INTEGER NOT NULL DEFAULT 1,
          estimated_cost     REAL,
          actual_cost        REAL,
          currency           TEXT NOT NULL DEFAULT 'USD',
          status             TEXT NOT NULL,
          is_regeneration    INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_cost_project ON generation_cost_entries(project_id, created_at);
        CREATE INDEX idx_cost_pair ON generation_cost_entries(project_id, pair_key);
        -- One remote task can only ever be charged once, however many times
        -- the poller, a retry or a restart passes through the record path.
        CREATE UNIQUE INDEX idx_cost_remote_task
          ON generation_cost_entries(remote_task_id)
          WHERE remote_task_id IS NOT NULL;
      `)
    }
  },
  {
    // Milestone 6C: prompt provenance.
    //
    // WHY THIS NEEDS COLUMNS. `transitions.prompt` alone cannot answer the
    // one question that matters when Property Analysis changes: did a
    // HUMAN write this wording, or did we generate it? Comparing the text
    // against the current plan is not a substitute — an operator may type
    // something that happens to match, and a plan may drift after they
    // edited. Only an explicit flag, set by a real edit, is trustworthy.
    //
    // prompt_manually_edited is therefore the protected bit: once true, a
    // rebuild from analysis must skip that transition.
    version: 8,
    up: (db) => {
      db.run(`
        ALTER TABLE transitions ADD COLUMN prompt_base TEXT;
        ALTER TABLE transitions ADD COLUMN prompt_motion TEXT;
        ALTER TABLE transitions ADD COLUMN prompt_effective TEXT;
        ALTER TABLE transitions ADD COLUMN prompt_basis TEXT;
        ALTER TABLE transitions ADD COLUMN prompt_rationale TEXT;
        ALTER TABLE transitions ADD COLUMN prompt_manually_edited INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE transitions ADD COLUMN prompt_planned_at INTEGER;
        -- The analysis revision the wording was built from, so a stale
        -- plan can be spotted without re-running the planner.
        ALTER TABLE transitions ADD COLUMN prompt_analysis_at INTEGER;
      `)
    }
  },
  {
    // Milestone 6C fix: the charge-idempotency key is scoped to the PROJECT.
    //
    // Migration 7 made remote_task_id globally unique. That prevents the
    // double-charge we care about — the same task recorded twice by a
    // poll, a retry or a restart — but it also means a task id seen under
    // ANY other project silently suppresses the charge, and the caller
    // gets an existing row back instead of a new one. Under-recording
    // spend is the worse failure: money leaves the account either way,
    // and only one of the two outcomes is visible.
    //
    // (project_id, remote_task_id) still blocks the real duplicate, and a
    // genuinely new project always records its own charge.
    version: 9,
    up: (db) => {
      db.run(`
        DROP INDEX IF EXISTS idx_cost_remote_task;
        CREATE UNIQUE INDEX idx_cost_project_task
          ON generation_cost_entries(project_id, remote_task_id)
          WHERE remote_task_id IS NOT NULL;
      `)
    }
  },
  {
    // Milestone 7: spend CATEGORIES.
    //
    // Whole-property analysis will eventually cost money at a vision
    // provider, and that is a different kind of spend from video
    // generation: different provider, different unit, different reason.
    // Totalling them into one number would make neither reconcilable.
    //
    // Existing rows are all video generation, so they are backfilled to
    // that category rather than left null — a null would force every
    // reader to guess, and guessing about money is what this ledger
    // exists to stop.
    version: 10,
    up: (db) => {
      db.run(`
        ALTER TABLE generation_cost_entries
          ADD COLUMN category TEXT NOT NULL DEFAULT 'video-generation';
        UPDATE generation_cost_entries SET category = 'video-generation';
        CREATE INDEX idx_cost_category ON generation_cost_entries(project_id, category);
      `)
    }
  },
  {
    // Milestone 8: ground-truth review of analysis facts.
    //
    // Local evaluation metadata — how often the analyzer is actually
    // right on real property sets. Never sent anywhere.
    //
    // KEYED SEMANTICALLY, not by uuid: an analyzer mints fresh room ids
    // every run, so a uuid-keyed review would be orphaned by the next
    // re-analysis and every fact would look new. `fact_key` is built from
    // the project's own stable image id plus the normalised room label.
    //
    // SCOPED so a re-analysis starts clean: draft reviews are separate
    // from accepted ones, and the accepted analysis keeps its review
    // history until a replacement is explicitly accepted.
    version: 11,
    up: (db) => {
      db.run(`
        CREATE TABLE analysis_reviews (
          project_id  TEXT NOT NULL,
          scope       TEXT NOT NULL,
          fact_key    TEXT NOT NULL,
          kind        TEXT NOT NULL,
          label       TEXT NOT NULL,
          verdict     TEXT NOT NULL,
          updated_at  INTEGER NOT NULL,
          PRIMARY KEY (project_id, scope, fact_key)
        );
        CREATE INDEX idx_review_project ON analysis_reviews(project_id, scope);
      `)
    }
  },
  {
    // Manual corrections to analysis-derived image facts.
    //
    // Kept OUT of the property_analysis document deliberately. Accepting a
    // new draft replaces that document wholesale — which is exactly right
    // for an analysis and exactly wrong for a correction someone typed.
    // Keyed by the project's own stable image id, so a re-analysis that
    // mints fresh room UUIDs cannot orphan one.
    //
    // Every column is nullable and absence means "no override": a row
    // exists only for fields the operator actually changed, so a stored
    // NULL for `room_label` genuinely means "deliberately unassigned"
    // rather than "not set" — see `has_room` for that distinction.
    version: 12,
    up: (db) => {
      db.run(`
        CREATE TABLE image_overrides (
          project_id  TEXT NOT NULL,
          image_id    TEXT NOT NULL,
          has_room    INTEGER NOT NULL DEFAULT 0,
          room_label  TEXT,
          orientation TEXT,
          openings    TEXT,
          landmarks   TEXT,
          updated_at  INTEGER NOT NULL,
          PRIMARY KEY (project_id, image_id)
        );
        CREATE INDEX idx_image_overrides ON image_overrides(project_id);
      `)
    }
  },
  {
    /**
     * Make the two newest project-scoped tables declare their ownership.
     *
     * ── WHY, GIVEN THE CASCADE BUG WAS ELSEWHERE ─────────────────────
     *
     * The orphan leak was NOT a schema fault: `project_images`,
     * `transitions` and `property_analysis` all carried correct
     * `ON DELETE CASCADE` the whole time, and nothing enforced them
     * because `PRAGMA foreign_keys` was being reset by every flush (see
     * db/index.ts). That is fixed at the source.
     *
     * These two tables, though, were written with no foreign key at all —
     * so they would have leaked even with enforcement working. Three
     * project-scoped tables where one cascades and two do not is exactly
     * the inconsistency that produces the next leak, so they are brought
     * into line rather than special-cased in the deletion path.
     *
     * ── NON-DESTRUCTIVE ──────────────────────────────────────────────
     *
     * SQLite cannot add a foreign key to an existing table, so each is
     * recreated. Every row is copied — deliberately NOT filtered to rows
     * with a live parent. Dropping data as a side effect of a schema
     * migration is not something a migration should decide; any resulting
     * inconsistency is reported by `PRAGMA foreign_key_check` and handled
     * as an explicit, approved cleanup instead.
     *
     * Both tables were empty when this shipped, so the copy is provably
     * lossless here.
     */
    version: 13,
    up: (db) => {
      db.run(`
        CREATE TABLE analysis_reviews_new (
          project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          scope       TEXT NOT NULL,
          fact_key    TEXT NOT NULL,
          kind        TEXT NOT NULL,
          label       TEXT NOT NULL,
          verdict     TEXT NOT NULL,
          updated_at  INTEGER NOT NULL,
          PRIMARY KEY (project_id, scope, fact_key)
        );
        INSERT INTO analysis_reviews_new
          SELECT project_id, scope, fact_key, kind, label, verdict, updated_at
          FROM analysis_reviews;
        DROP INDEX IF EXISTS idx_review_project;
        DROP TABLE analysis_reviews;
        ALTER TABLE analysis_reviews_new RENAME TO analysis_reviews;
        CREATE INDEX idx_review_project ON analysis_reviews(project_id, scope);

        CREATE TABLE image_overrides_new (
          project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          image_id    TEXT NOT NULL,
          has_room    INTEGER NOT NULL DEFAULT 0,
          room_label  TEXT,
          orientation TEXT,
          openings    TEXT,
          landmarks   TEXT,
          updated_at  INTEGER NOT NULL,
          PRIMARY KEY (project_id, image_id)
        );
        INSERT INTO image_overrides_new
          SELECT project_id, image_id, has_room, room_label, orientation,
                 openings, landmarks, updated_at
          FROM image_overrides;
        DROP INDEX IF EXISTS idx_image_overrides;
        DROP TABLE image_overrides;
        ALTER TABLE image_overrides_new RENAME TO image_overrides;
        CREATE INDEX idx_image_overrides ON image_overrides(project_id);
      `)
    }
  },
  {
    /**
     * Transition type: generated, cut or dissolved.
     *
     * NULL is the important value here and means `auto` — the transition
     * has never been configured and the spatial evidence decides. Every
     * row written before this column existed reads as NULL, which is
     * exactly right: nobody chose anything for them.
     *
     * A stored value is a DECISION, and re-analysis never overwrites one.
     */
    version: 14,
    up: (db) => {
      db.run(`ALTER TABLE transitions ADD COLUMN mode TEXT`)
    }
  }
]

export function migrate(db: Database): void {
  const current = (db.exec('PRAGMA user_version')[0]?.values[0]?.[0] as number) ?? 0
  for (const migration of MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version
  )) {
    db.run('BEGIN')
    try {
      migration.up(db)
      db.run(`PRAGMA user_version = ${migration.version}`)
      db.run('COMMIT')
    } catch (err) {
      db.run('ROLLBACK')
      throw err
    }
  }
}
