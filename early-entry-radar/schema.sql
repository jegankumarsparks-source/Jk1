-- SOLANA EARLY-ENTRY INTELLIGENCE RADAR - event store schema (D1/SQLite)
-- All timestamps UTC ISO-8601. Storage is append-only; facts are never overwritten.
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS sources (
  source TEXT PRIMARY KEY,            -- adapter name, e.g. 'pumpfun'
  source_type TEXT NOT NULL,          -- 'api' | 'rpc' | 'web_preview' | ...
  auth_status TEXT NOT NULL DEFAULT 'none',  -- none | key | oauth | blocked
  reliability_notes TEXT
);

CREATE TABLE IF NOT EXISTS raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL REFERENCES sources(source),
  source_id TEXT NOT NULL,            -- provider-native id (mint, pool addr, msg id, url hash)
  url TEXT,                           -- original URL where one exists
  observed_at TEXT,                   -- when the source says it happened (UTC); NULL when source gives none (never invented)
  ingested_at TEXT NOT NULL,          -- when we pulled it (UTC)
  payload TEXT NOT NULL,              -- raw JSON as received
  retrieval_status TEXT NOT NULL DEFAULT 'ok',  -- ok | partial | error
  UNIQUE (source, source_id)          -- idempotent ingestion dedupe key
);

CREATE TABLE IF NOT EXISTS source_health (
  source TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  status TEXT NOT NULL,               -- LIVE | DELAYED | DEGRADED | OFFLINE | GAP
  latency_ms INTEGER,
  http_status INTEGER,
  rate_limit TEXT,                    -- observed rate-limit info
  error TEXT,
  PRIMARY KEY (source, checked_at)
);

-- Canonical coin profile. Identity = verified mint, or provisional internal id.
CREATE TABLE IF NOT EXISTS entities (
  entity_id TEXT PRIMARY KEY,         -- 'mint:<mint>' or 'prov:<hash>'
  kind TEXT NOT NULL,                 -- 'mint' | 'provisional'
  mint TEXT UNIQUE,                   -- NULL until mint verified
  name TEXT,
  ticker TEXT,
  first_evidence_at TEXT NOT NULL,    -- earliest observed_at across evidence
  created_at TEXT NOT NULL,
  launch_status TEXT NOT NULL DEFAULT 'STATUS UNKNOWN'
);

-- Evidence links events to entities; a mint-bearing event attaches to exactly one mint entity.
CREATE TABLE IF NOT EXISTS entity_evidence (
  entity_id TEXT NOT NULL REFERENCES entities(entity_id),
  raw_event_id INTEGER NOT NULL REFERENCES raw_events(id),
  field TEXT NOT NULL,                -- what this event evidences: 'mint'|'profile'|'pool'|'mention'|'link'
  linked_at TEXT NOT NULL,
  PRIMARY KEY (entity_id, raw_event_id, field)
);

-- Extracted social mentions (kept separate from market facts; reposts flagged, never merged into 'independent' count)
CREATE TABLE IF NOT EXISTS mentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_event_id INTEGER NOT NULL REFERENCES raw_events(id),
  entity_id TEXT REFERENCES entities(entity_id),  -- NULL when no entity resolved
  author TEXT,
  url TEXT,
  published_at TEXT,                  -- source-stated time
  ingested_at TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'unknown', -- announcement|endorsement|disclosed_paid|speculation|criticism|warning|unknown
  is_duplicate INTEGER NOT NULL DEFAULT 0,  -- copy/repost of an earlier mention
  confidence TEXT NOT NULL DEFAULT 'low',   -- low|medium|high
  text TEXT,
  fingerprint TEXT                          -- normalized-text hash for copy/repost detection
);
CREATE INDEX IF NOT EXISTS idx_mentions_fp ON mentions(fingerprint);

-- Candidate links between provisional entities and mints - recorded, never auto-merged.
CREATE TABLE IF NOT EXISTS candidate_links (
  provisional_id TEXT NOT NULL REFERENCES entities(entity_id),
  mint TEXT NOT NULL,
  basis TEXT NOT NULL,                -- why we think they may be the same coin
  status TEXT NOT NULL DEFAULT 'UNVERIFIED', -- UNVERIFIED | CONFIRMED | REJECTED
  created_at TEXT NOT NULL,
  PRIMARY KEY (provisional_id, mint)
);

CREATE TABLE IF NOT EXISTS launch_status_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL REFERENCES entities(entity_id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  reasons TEXT NOT NULL,              -- JSON array of human-readable reasons
  at TEXT NOT NULL
);
