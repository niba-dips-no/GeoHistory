PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS places (
  id        TEXT PRIMARY KEY,              -- Wikidata QID or GeoNames ID (reference to source)
  name      TEXT NOT NULL,
  level     TEXT CHECK (level IN ('locality','county','admin1','country')),
  parent_id TEXT REFERENCES places(id),    -- containment chain (self-referential)
  lat       REAL,
  lng       REAL,
  aliases   TEXT                           -- JSON array of alternate/historical names
);

CREATE TABLE IF NOT EXISTS events (
  id             TEXT PRIMARY KEY,          -- Wikidata QID (+ optional #birth / #death / #founding suffix)
  title          TEXT NOT NULL,
  blurb          TEXT,                      -- short description (<= 280 chars)
  date_start     TEXT NOT NULL,             -- ISO 8601, may be partial (1871, 1871-10, 1871-10-08)
  date_end       TEXT,
  date_precision TEXT CHECK (date_precision IN ('day','month','year','decade','century')),
  lat            REAL,
  lng            REAL,
  place_id       TEXT REFERENCES places(id),
  scope          TEXT CHECK (scope IN ('local','regional','national','global')),  -- geographic reach class
  category       TEXT,                      -- event | conflict | election | founding | discovery | birth | death | milestone
  notability     REAL,                      -- absolute fame proxy: normalized Wikidata sitelinks (0..1)
  significance   REAL,                      -- era-normalized importance (0..1); drives the floor + ranking
  reach_km       REAL,                      -- materialized relevance radius (derived from scope + significance)
  reach_min_lat  REAL,                      -- reach bounding box (portable spatial prefilter for the engine)
  reach_max_lat  REAL,
  reach_min_lng  REAL,
  reach_max_lng  REAL,
  source_url     TEXT,
  source_ids     TEXT,                      -- JSON provenance: {"wikidata":"Q..."}
  ingest_version TEXT NOT NULL
);

-- Build provenance / reproducibility (dataset version, scorer + reach formula versions, timestamps)
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Indexes the ingest, scorer, search, and timeline engine rely on
CREATE INDEX IF NOT EXISTS idx_events_lat_lng      ON events(lat, lng);
CREATE INDEX IF NOT EXISTS idx_events_date_start   ON events(date_start);
CREATE INDEX IF NOT EXISTS idx_events_place        ON events(place_id);
CREATE INDEX IF NOT EXISTS idx_events_category     ON events(category);
CREATE INDEX IF NOT EXISTS idx_events_significance ON events(significance);
CREATE INDEX IF NOT EXISTS idx_events_reach_box    ON events(reach_min_lat, reach_max_lat, reach_min_lng, reach_max_lng);
CREATE INDEX IF NOT EXISTS idx_places_parent       ON places(parent_id);

-- Full-text search over title + blurb (external-content FTS5; rebuilt after ingest).
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  title, blurb, content='events', content_rowid='rowid'
);
