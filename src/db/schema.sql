-- RippleReview persistence.
--
-- Applied in one transaction by MigrationRunner. Written as plain SQL rather than through
-- an ORM's migration DSL: the schema is three tables, and an ORM would add a code
-- generation step to CI to describe them.

CREATE TABLE IF NOT EXISTS runs (
  id                  UUID PRIMARY KEY,
  created_at          TIMESTAMPTZ  NOT NULL,
  repo_root           TEXT         NOT NULL,
  base_ref            TEXT         NOT NULL,
  head_ref            TEXT         NOT NULL,
  -- False for a diff-only baseline run. The eval's two arms are distinguishable here.
  graph_grounded      BOOLEAN      NOT NULL,
  provider            TEXT         NOT NULL,
  model               TEXT         NOT NULL,
  prompt_tokens       INTEGER      NOT NULL,
  completion_tokens   INTEGER      NOT NULL,
  -- Null when the provider does not report cost. Never guessed: an invented number here
  -- would later be summed and reported as a measurement.
  estimated_cost_usd  NUMERIC(12, 6),
  llm_latency_ms      INTEGER      NOT NULL,
  -- How many model calls one review needed, repairs included.
  attempts            INTEGER      NOT NULL,
  total_duration_ms   INTEGER      NOT NULL,
  findings_count      INTEGER      NOT NULL,
  rejected_count      INTEGER      NOT NULL
);

CREATE INDEX IF NOT EXISTS runs_created_at_idx ON runs (created_at DESC);

CREATE TABLE IF NOT EXISTS findings (
  id              BIGSERIAL PRIMARY KEY,
  run_id          UUID        NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  severity        TEXT        NOT NULL,
  category        TEXT        NOT NULL,
  file            TEXT        NOT NULL,
  line            INTEGER     NOT NULL,
  summary         TEXT        NOT NULL,
  rationale       TEXT        NOT NULL,
  evidence_refs   TEXT[]      NOT NULL DEFAULT '{}',
  confidence      REAL,
  -- False for a finding the grounding guard dropped. Kept rather than discarded: a guard
  -- whose rejections are invisible cannot be told from one that never fires.
  grounded        BOOLEAN     NOT NULL,
  rejection_reason TEXT
);

CREATE INDEX IF NOT EXISTS findings_run_id_idx ON findings (run_id);

CREATE TABLE IF NOT EXISTS impact_snapshots (
  run_id                UUID PRIMARY KEY REFERENCES runs (id) ON DELETE CASCADE,
  hop_limit             INTEGER NOT NULL,
  module_count          INTEGER NOT NULL,
  edge_count            INTEGER NOT NULL,
  changed_symbol_count  INTEGER NOT NULL,
  impacted_site_count   INTEGER NOT NULL,
  -- Warm-up is stored apart from steady-state lookup cost. They differ by orders of
  -- magnitude and are fixed by different things; averaged together they mislead.
  warm_up_ms            INTEGER NOT NULL,
  lookup_ms             INTEGER NOT NULL,
  lookups               INTEGER NOT NULL,
  duration_ms           INTEGER NOT NULL,
  -- The whole ChangeImpact, so a stored run can be re-rendered exactly as it was served.
  impact                JSONB   NOT NULL
);
