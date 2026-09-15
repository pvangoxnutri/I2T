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
  },
  {
    /**
     * Feed sequence: the ordered list of image IDs that form the video sequence.
     *
     * Stored as JSON array. Null/empty means the fallback applies: all images
     * in project order. This allows old projects to work without migration,
     * while new projects have explicit feed control separate from the library.
     */
    version: 15,
    up: (db) => {
      db.run(`ALTER TABLE projects ADD COLUMN feed_sequence_json TEXT`)
    }
  },
  {
    /**
     * Customer details: name, contact, email, phone, notes for delivery/invoicing.
     *
     * Stored as JSON. Optional — projects created before this migration
     * will have null/undefined, which is fine (all fields are optional).
     */
    version: 16,
    up: (db) => {
      db.run(`ALTER TABLE projects ADD COLUMN customer_details_json TEXT`)
    }
  },
  {
    /**
     * Transition Generations Catalogue — immutable history of ALL generated clips.
     *
     * IDEMPOTENCY GUARANTEE:
     * Each successful generation is recorded exactly once via queue_job_id.
     * Even if polling resumes, app restarts, or completion callbacks repeat,
     * the UNIQUE(queue_job_id) constraint ensures only ONE catalogue entry
     * per actual generation job.
     *
     * New regenerations get new job IDs → new catalogue rows (full history preserved).
     */
    version: 17,
    up: (db) => {
      db.run(`
        CREATE TABLE transition_generations (
          id                 TEXT PRIMARY KEY,
          queue_job_id       TEXT UNIQUE NOT NULL,
          project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          from_image_id      TEXT NOT NULL,
          to_image_id        TEXT NOT NULL,
          provider           TEXT NOT NULL,
          model              TEXT,
          created_at         INTEGER NOT NULL,
          status             TEXT NOT NULL,
          clip_name          TEXT,
          clip_original_name TEXT,
          clip_source        TEXT,
          prompt_used        TEXT,
          provider_meta_json TEXT,
          generation_cost    REAL,
          generation_credits REAL,
          active             INTEGER NOT NULL DEFAULT 0
        );
        CREATE UNIQUE INDEX idx_generations_job ON transition_generations(queue_job_id);
        CREATE INDEX idx_generations_project ON transition_generations(project_id);
        CREATE INDEX idx_generations_pair ON transition_generations(project_id, from_image_id, to_image_id);
        CREATE INDEX idx_generations_created ON transition_generations(created_at DESC);
      `)
    }
  },
  {
    /**
     * Transition Analysis Draft — per-project persistent draft/accepted state.
     *
     * UPSERT SEMANTICS: one row per project. Stores the most recent analysis draft.
     * status: 'draft' | 'accepted' | 'declined'
     * isOutdated: flag set when feed structure changes (but record kept for history)
     *
     * Feed snapshot is stored as JSON for staleness detection on load.
     * Results (pairs with recommendations, safety levels, evidence) stored as JSON.
     *
     * This allows transition analysis drafts to survive app restarts and browser
     * reloads, and Toolbox can show "Review Transition Analysis" after reopening.
     */
    version: 18,
    up: (db) => {
      db.run(`
        CREATE TABLE transition_analysis_draft (
          project_id    TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
          json          TEXT NOT NULL,
          updated_at    INTEGER NOT NULL,
          is_outdated   INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_analysis_draft_project ON transition_analysis_draft(project_id);
      `)
    }
  },
  {
    /**
     * The analyzer DRAFT, kept beside the accepted analysis.
     *
     * ── WHY A SECOND COLUMN AND NOT A SECOND ROW ────────────────────
     *
     * `property_analysis` is keyed by project, one row each, and that row
     * is the ACCEPTED analysis — the thing the planner and inspectors
     * read. A paid Gemini run produces a draft, which until now existed
     * only in renderer memory: after a restart there was no way to see
     * what the model had actually returned, and the run cost money.
     *
     * Writing the draft into the existing `json` column would silently
     * replace an accepted analysis with an unreviewed one, which is the
     * single thing the draft/accept workflow exists to prevent. Its own
     * columns keep both facts addressable in the same row, and no second
     * document model appears.
     */
    version: 19,
    up: (db) => {
      db.run(`
        ALTER TABLE property_analysis ADD COLUMN draft_json TEXT;
        ALTER TABLE property_analysis ADD COLUMN draft_updated_at INTEGER;
      `)
    }
  },
  {
    /**
     * WHO chose a transition's mode.
     *
     * `mode` records the decision; this records its author, because the
     * two carry different permissions at the moment money is spent. An
     * AI mode the analyzer proposed needs the accepted spatial map that
     * justified it. An AI mode a human deliberately set is an informed
     * override and is allowed through with a stated risk.
     *
     * NULL is deliberately NOT "manual". Every row written before this
     * column existed reads as null — including the eight that generated
     * against an empty analysis — and those must not be retro-classified
     * as human decisions, because manual is the permissive branch.
     */
    version: 20,
    up: (db) => {
      db.run(`ALTER TABLE transitions ADD COLUMN mode_provenance TEXT`)
    }
  },
  {
    /**
     * The catalogue's idempotency key is scoped to the PROJECT.
     *
     * Migration 17 made `queue_job_id` globally unique, which does stop
     * the duplicate we care about — the same completion recorded twice by
     * a poll, a retry or a restart. But it also means a job id seen under
     * ANY other project silently suppresses the insert, and the caller is
     * told nothing. Under-recording history is the worse failure: the
     * generation happened, the file exists, the money was spent, and the
     * catalogue would simply not mention it.
     *
     * Exactly the reasoning behind migration 9 for the cost ledger, and
     * exactly the same fix. (project_id, queue_job_id) still blocks the
     * real duplicate.
     */
    version: 21,
    up: (db) => {
      db.run(`
        DROP INDEX IF EXISTS idx_generations_job;
        CREATE UNIQUE INDEX idx_generations_project_job
          ON transition_generations(project_id, queue_job_id);
      `)
    }
  },
  {
    /**
     * Finish scoping the catalogue key — the column-level UNIQUE has to go.
     *
     * Migration 21 replaced the named index, but `queue_job_id TEXT UNIQUE`
     * in the original table definition also creates an IMPLICIT unique
     * index, and `DROP INDEX` cannot remove that one. So the global
     * constraint was still enforced while the schema claimed otherwise —
     * a migration whose comment and behaviour disagreed.
     *
     * SQLite has no way to drop a column constraint, so the table is
     * recreated. Rows are copied verbatim: this table is generation
     * HISTORY, recording money that was really spent and files that
     * really exist, and nothing here may lose one.
     */
    version: 22,
    up: (db) => {
      db.run(`
        CREATE TABLE transition_generations_new (
          id                 TEXT PRIMARY KEY,
          queue_job_id       TEXT NOT NULL,
          project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          from_image_id      TEXT NOT NULL,
          to_image_id        TEXT NOT NULL,
          provider           TEXT NOT NULL,
          model              TEXT,
          created_at         INTEGER NOT NULL,
          status             TEXT NOT NULL,
          clip_name          TEXT,
          clip_original_name TEXT,
          clip_source        TEXT,
          prompt_used        TEXT,
          provider_meta_json TEXT,
          generation_cost    REAL,
          generation_credits REAL,
          active             INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO transition_generations_new
          SELECT id, queue_job_id, project_id, from_image_id, to_image_id, provider,
                 model, created_at, status, clip_name, clip_original_name, clip_source,
                 prompt_used, provider_meta_json, generation_cost, generation_credits, active
          FROM transition_generations;

        DROP INDEX IF EXISTS idx_generations_project;
        DROP INDEX IF EXISTS idx_generations_pair;
        DROP INDEX IF EXISTS idx_generations_created;
        DROP INDEX IF EXISTS idx_generations_project_job;
        DROP TABLE transition_generations;
        ALTER TABLE transition_generations_new RENAME TO transition_generations;

        CREATE UNIQUE INDEX idx_generations_project_job
          ON transition_generations(project_id, queue_job_id);
        CREATE INDEX idx_generations_project ON transition_generations(project_id);
        CREATE INDEX idx_generations_pair
          ON transition_generations(project_id, from_image_id, to_image_id);
        CREATE INDEX idx_generations_created ON transition_generations(created_at DESC);
      `)
    }
  },
  {
    /**
     * WHY a provider call failed, classified rather than described.
     *
     * The queue reduced every failure to a message string, which loses
     * the one distinction the recovery UI needs: a provider REFUSAL kills
     * the remote task id, while losing CONTACT leaves a paid task that may
     * still be running. Both then looked like `status=failed`, and a
     * request rejected with HTTP 422 kept offering "Resume polling" —
     * which could only ever return the same rejection.
     *
     * Its own column rather than a corner of `provider_meta_json`: that
     * blob is the provider's sanitized response, and this is OUR
     * conclusion about it.
     */
    version: 23,
    up: (db) => {
      db.run(`ALTER TABLE queue_jobs ADD COLUMN provider_failure_json TEXT`)
    }
  },
  {
    /**
     * POST-GENERATION QUALITY RESULT, on the generation it belongs to.
     *
     * ── WHY HERE AND NOT A NEW TABLE ─────────────────────────────────
     *
     * A quality verdict is a property of one generation attempt, has the
     * same lifetime, and is always read with it. A parallel table would
     * need its own join, its own cascade and its own orphan cleanup, and
     * would let a clip exist with a verdict pointing at nothing.
     *
     * ── not-run IS NOT passed ────────────────────────────────────────
     *
     * Every existing row gets 'not-run', which is what was true: nobody
     * looked. Defaulting them to 'passed' would be a claim we never
     * checked, and defaulting to 'failed' would retroactively break clips
     * the customer already paid for and approved. `qualityAllowsActive`
     * treats 'not-run' as usable for exactly that reason.
     */
    version: 24,
    up: (db) => {
      db.run(
        `ALTER TABLE transition_generations ADD COLUMN quality_status TEXT NOT NULL DEFAULT 'not-run'`
      )
      db.run(`ALTER TABLE transition_generations ADD COLUMN quality_reason TEXT`)
      db.run(`ALTER TABLE transition_generations ADD COLUMN quality_checked_at INTEGER`)
      db.run(`ALTER TABLE transition_generations ADD COLUMN quality_frames_json TEXT`)
      db.run(`ALTER TABLE transition_generations ADD COLUMN quality_validator TEXT`)
      // NULL = never overridden. 'manual' = an operator accepted it
      // knowingly, which is a provenance fact and never inferred.
      db.run(`ALTER TABLE transition_generations ADD COLUMN quality_override TEXT`)
    }
  },
  {
    /**
     * OPERATOR-SUPPLIED SPATIAL CONTEXT, on the pair it describes.
     *
     * ── WHY ITS OWN COLUMN AND NOT PROMPT TEXT ───────────────────────
     *
     * Because it is EVIDENCE, not wording. Folded into the generated
     * prompt it would be indistinguishable from generated wording, and
     * the next "Analyse Prompts — All" would overwrite the one thing in
     * the prompt that no analyzer could reproduce: a fact the operator
     * knew from standing in the room.
     *
     * Kept on the transition row so it is keyed by the exact pair, and
     * so re-running analysis — which rewrites prompts — cannot touch it.
     */
    version: 25,
    up: (db) => {
      db.run(`ALTER TABLE transitions ADD COLUMN operator_context_text TEXT`)
      db.run(`ALTER TABLE transitions ADD COLUMN operator_context_at INTEGER`)
    }
  },
  {
    /**
     * OPERATOR CONTEXT GAINS A LIFECYCLE.
     *
     * "Survives re-analysis" was the right instinct and the wrong rule:
     * it left old text SILENTLY AUTHORITATIVE, still steering prompts
     * built from an analysis it had never been checked against. Neither
     * deleting it nor trusting it is correct — it is kept and demoted.
     *
     * Existing rows default to 'current': they were current when written,
     * and demoting every one on upgrade would invalidate real operator
     * knowledge nobody asked to re-check.
     */
    version: 26,
    up: (db) => {
      db.run(
        `ALTER TABLE transitions ADD COLUMN operator_context_status TEXT NOT NULL DEFAULT 'current'`
      )
      db.run(`ALTER TABLE transitions ADD COLUMN operator_context_fingerprint INTEGER`)
    }
  },
  {
    /**
     * PER-PAIR ANALYSIS, IN ITS OWN TABLE.
     *
     * ── WHY NOT MERGE INTO PropertyAnalysis ──────────────────────────
     *
     * Because a two-image answer is not a property map. Folding it into
     * the accepted analysis would let a single transition's re-analysis
     * silently rewrite room membership, landmarks and adjacency for
     * thirty-five photographs it never looked at — the destructive
     * version of exactly the divergence this project has already been
     * bitten by twice.
     *
     * Kept beside the global map instead, and preferred only for the ONE
     * pair it describes. `resolvePairSpatialEvidence` owns that
     * precedence so no component invents its own.
     *
     * The fingerprints are what make staleness detectable: a pair
     * analysis outlives the feed it was run against, and must be able to
     * say so rather than quietly steering a pair that no longer exists.
     */
    version: 27,
    up: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS pair_analysis (
          project_id                 TEXT NOT NULL,
          pair_key                   TEXT NOT NULL,
          analyzed_at                INTEGER NOT NULL,
          analyzer                   TEXT,
          model                      TEXT,
          parent_analysis_updated_at INTEGER,
          feed_fingerprint           TEXT,
          library_fingerprint        TEXT,
          evidence_json              TEXT NOT NULL,
          decision                   TEXT NOT NULL,
          missing_context_json       TEXT,
          motion_instruction         TEXT,
          prompt_candidate           TEXT,
          reason                     TEXT,
          state                      TEXT NOT NULL DEFAULT 'draft',
          PRIMARY KEY (project_id, pair_key)
        )
      `)
    }
  },
  {
    /**
     * WHAT A PROMPT WAS BUILT FROM, and a suggestion that must not
     * overwrite a human's wording.
     *
     * `prompt_analysis_at` alone stopped being enough once a pair could
     * be guided by four different sources: an individual pair analysis
     * and the global map can share a timestamp and mean different
     * things, and the second is stale the moment the first lands.
     *
     * `prompt_suggestion` exists because a re-analysis of a pair whose
     * wording a human wrote has something useful to say and no right to
     * say it in place of them. It is held until they choose.
     */
    version: 28,
    up: (db) => {
      db.run(`ALTER TABLE transitions ADD COLUMN prompt_evidence_source TEXT`)
      db.run(`ALTER TABLE transitions ADD COLUMN prompt_evidence_fingerprint TEXT`)
      db.run(`ALTER TABLE transitions ADD COLUMN prompt_operator_fingerprint TEXT`)
      db.run(`ALTER TABLE transitions ADD COLUMN prompt_suggestion TEXT`)
      db.run(`ALTER TABLE transitions ADD COLUMN prompt_suggestion_at INTEGER`)
      db.run(`ALTER TABLE transitions ADD COLUMN prompt_suggestion_source TEXT`)
      db.run(`ALTER TABLE transitions ADD COLUMN prompt_suggestion_fingerprint TEXT`)
    }
  },
  {
    /**
     * SINGLE-IMAGE MOTION SEGMENTS.
     *
     * Their own table, not a column on `transitions`. A transition is
     * keyed by an image PAIR and every consumer of that table reasons
     * about two photographs; a segment made from one has no pair, and
     * storing it there would have put it in front of the spatial analysis
     * as evidence that a room connects to itself.
     *
     * Additive: a project written before this existed simply has no rows,
     * which reads as no motion segments.
     */
    version: 29,
    up: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS motion_segments (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          image_id TEXT NOT NULL,
          motion TEXT NOT NULL,
          duration_sec INTEGER NOT NULL,
          status TEXT NOT NULL,
          clip_name TEXT,
          clip_original_name TEXT,
          clip_source TEXT,
          prompt TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
      `)
      db.run(
        `CREATE INDEX IF NOT EXISTS idx_motion_segments_project ON motion_segments(project_id)`
      )
    }
  },
  {
    /**
     * SINGLE-IMAGE GENERATIONS IN THE CATALOGUE.
     *
     * The generation history is shared with transitions — a paid fal.ai
     * run is a paid fal.ai run, and splitting the ledger in two would
     * mean two places to look for what a project cost. What differs is
     * the SUBJECT, so the subject is what gets recorded.
     *
     * `to_image_id` is NOT NULL and stays that way; a motion row writes
     * the EMPTY STRING there. That is deliberate and load-bearing: an
     * empty id can never equal a real image id, so `activeGenerationForPair`
     * cannot return a motion row for any pair, no matter how it is
     * called. Writing the source image into both columns would have made
     * a motion clip answer to the pair (image, image) — the A → A shape
     * this whole feature was built to avoid.
     */
    version: 30,
    up: (db) => {
      db.run(`ALTER TABLE transition_generations ADD COLUMN motion_segment_id TEXT`)
      db.run(`ALTER TABLE transition_generations ADD COLUMN motion_type TEXT`)
      db.run(
        `CREATE INDEX IF NOT EXISTS idx_generations_motion
           ON transition_generations(project_id, motion_segment_id)`
      )
    }
  },
  {
    /**
     * THE LENGTH A GENERATION WAS ACTUALLY MADE AT.
     *
     * The catalogue recorded the model and the prompt per run but not
     * the duration, so history borrowed it from the segment's CURRENT
     * value. Regenerating a 5s clip at 10s therefore rewrote what the
     * 5s row appeared to be — the old generation's own record changing
     * because of a later run, which is exactly what history must not do.
     *
     * NULL on every existing row, and read as "not recorded" rather than
     * back-filled from the segment: inventing a number for a past run is
     * the same mistake in the opposite direction.
     */
    version: 31,
    up: (db) => {
      db.run(`ALTER TABLE transition_generations ADD COLUMN duration_sec INTEGER`)
    }
  },
  {
    /**
     * THE FINAL EDIT, AS TABLES.
     *
     * Normalised rather than a JSON blob on the project, matching how
     * every other first-class entity here is stored (images, transitions,
     * generations, motion segments). A timeline is a list that gets
     * reordered, split and deleted item by item; a blob would make every
     * one of those a whole-document rewrite, and would put the ordering
     * key somewhere no index can reach it.
     *
     * Two tables because there are two lifetimes: the ITEMS change on
     * every edit, while the project-level facts — what the timeline was
     * built from, and whether a human has touched it — change rarely and
     * must survive an item list being replaced wholesale.
     *
     * `manually_edited` is the flag that makes a rebuild require
     * confirmation, and `feed_fingerprint` is what detects that the feed
     * moved on. Neither is derivable after the fact, which is exactly why
     * they are stored.
     */
    version: 32,
    up: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS timelines (
          project_id       TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
          feed_fingerprint TEXT NOT NULL,
          manually_edited  INTEGER NOT NULL DEFAULT 0,
          updated_at       INTEGER NOT NULL
        )
      `)
      db.run(`
        CREATE TABLE IF NOT EXISTS timeline_items (
          id                   TEXT PRIMARY KEY,
          project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          position             INTEGER NOT NULL,
          source_type          TEXT NOT NULL,
          source_id            TEXT NOT NULL,
          -- The EXACT generation this item plays. Pinned so a later
          -- regeneration cannot move an operator's in/out points onto
          -- different footage.
          source_generation_id TEXT,
          source_clip_name     TEXT,
          source_image_name    TEXT,
          start_offset_sec     REAL NOT NULL,
          end_offset_sec       REAL NOT NULL,
          -- NULL means "the project's seam setting decides this joint".
          seam_after_sec       REAL
        )
      `)
      db.run(
        `CREATE INDEX IF NOT EXISTS idx_timeline_items_project
           ON timeline_items(project_id, position)`
      )
    }
  },
  {
    /**
     * HOW FAST EACH TIMELINE ITEM PLAYS.
     *
     * ── THE BUG THIS EXISTS BECAUSE OF ───────────────────────────────
     *
     * `playbackRate` was added to the item type, the service validated
     * it, the export honoured it and the UI offered it — and none of it
     * survived a save, because the column was not here. The write simply
     * dropped the field, the read returned items without it, and every
     * reader defaulted it back to 1. Nothing failed: the operator set a
     * speed, the panel showed 1.00x again, and the export was normal
     * speed.
     *
     * NULL is the default and reads as 1, so every timeline written
     * before this migration keeps playing exactly as it did.
     */
    version: 33,
    up: (db) => {
      const columns = db.exec('PRAGMA table_info(timeline_items)')[0]
      const has = columns?.values.some((row) => row[1] === 'playback_rate')
      if (!has) db.run('ALTER TABLE timeline_items ADD COLUMN playback_rate REAL')
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
