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
  id             TEXT PRIMARY KEY,          -- Wikidata QID: the stable outward reference
  title          TEXT NOT NULL,
  blurb          TEXT,                      -- <= 280 chars, enforced at ingest
  date_start     TEXT NOT NULL,             -- ISO 8601, may be partial (1871, 1871-10, 1871-10-08)
  date_end       TEXT,
  date_precision TEXT CHECK (date_precision IN ('day','month','year','decade','century')),
  lat            REAL,
  lng            REAL,
  place_id       TEXT REFERENCES places(id),
  scope          TEXT CHECK (scope IN ('local','regional','national','global')),
  category       TEXT,
  notability     REAL,                      -- 0..1 normalized
  source_url     TEXT,
  source_ids     TEXT,                      -- JSON provenance: {"wikidata":"Q..."}
  ingest_version TEXT NOT NULL
);

-- Indexes the timeline engine relies on (bounding-box + date-range scans)
CREATE INDEX IF NOT EXISTS idx_events_lat_lng    ON events(lat, lng);
CREATE INDEX IF NOT EXISTS idx_events_date_start ON events(date_start);
CREATE INDEX IF NOT EXISTS idx_events_place      ON events(place_id);
CREATE INDEX IF NOT EXISTS idx_places_parent     ON places(parent_id);
