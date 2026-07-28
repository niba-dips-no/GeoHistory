# GeoHistory

*An open, geo-located historical events dataset and a deterministic timeline protocol. Give it a person's places and dates; get back a sourced timeline of the history that surrounded their life.*

**Status:** v0.7 - comprehensive dataset (~106k events) + curated milestone seed layer (330 rows) + event-radius engine + JSON API + prune tooling

## Overview

GeoHistory answers one question: *"What was happening in and around the places where someone lived, while they lived there?"* It has two parts:

1. **An open events dataset** - a flat, geo-located, pre-scored SQLite table of historically significant events harvested from Wikidata, supplemented by a curated seed layer for categories (like milestone inventions) that benefit from hand review.
2. **A deterministic timeline engine** - a pure function that takes a list of life events (place + date) and returns a ranked, cited timeline. No network calls or model inference at query time.

All intelligence is computed **once, at build time**, and frozen into static columns. Query time is pure lookups, so the same file drives both a server API and an in-browser applet.

## The two axes of relevance

Every event is scored on two independent axes so the timeline is both *placed* and *interesting*:

- **Reach** (`scope` -> `reach_km`): how far the event's relevance radiates. An event matches you when your coordinate falls inside its reach circle. A county fair reaches ~40 km; a national election reaches its country; a world war reaches everywhere.
- **Significance** (`significance`, 0..1): does anyone care? Era-normalized (decade percentile) so a standout 1600s event isn't buried under modern volume. Below a floor, events are dropped; above it, significance ranks them within per-scope quotas.

## Pipeline

```
ingest (sample)  OR  ingest:dump (comprehensive)  [+ seed: curated rows]   ->   score   ->   prune (optional cleanup)   ->   timeline / search / serve
```

1. **Harvest** - two options:
   - `ingest.ts` (`npm run ingest`): quick sample via the live Wikidata SPARQL endpoint (1900-present). Good for tests.
   - `ingest-dump.ts` (`npm run ingest:dump`): the **comprehensive build** from a local Wikidata dump - no rate limits, ~750-year window, and **true date precision**.
2. **Seed (curated rows, optional)** - `seed.ts` (`npm run seed`) merges hand-authored rows into the same `events` table, for categories that are better hand-curated than mined (currently: `milestone`, 330 invention/discovery-first events reviewed in Notion). Source rows live in era-bucketed files under `seed/` (split to avoid single-write truncation on large pushes) and are loaded idempotently: each row's id is `seed:<slug of title>`, and `ingest_version` starts with `seed-` so seed rows are always identifiable and re-seeding after an edit just upserts.
3. `score.ts` (`npm run score`) derives the two axes and materializes the relevance radius. It **preserves the authored scope** on seed rows rather than recomputing it.
4. **Prune (optional cleanup)** - `prune.ts` (`npm run prune <category> [floor] [apply]`) reviews and removes the least-notable rows within one category without re-running the ingest. A dry run (no floor, or a floor without `apply`) prints a notability histogram and shows how many rows each candidate floor would remove; passing `apply` deletes rows below the floor and rebuilds the FTS index. Useful for high-volume, uneven categories like `election`, where most harvested rows are minor local races.
5. `core.ts` matches and ranks at query time using only the frozen columns.

### Comprehensive build (dumps)

1. Download the dump (~90-140 GB gzip):
   `https://dumps.wikimedia.org/wikidatawiki/entities/latest-all.json.gz`
2. Point the ingester at it and run (PowerShell):
   ```powershell
   $env:WIKIDATA_DUMP="D:\wikidata\latest-all.json.gz"; npm run ingest:dump
   npm run score
   npm run timeline
   ```
3. **Validate on a slice first** (stops after N lines), then start from an empty DB for the full run:
   ```powershell
   Remove-Item events.sqlite, events.sqlite-wal, events.sqlite-shm -ErrorAction SilentlyContinue
   $env:WIKIDATA_DUMP="D:\wikidata\latest-all.json.gz"; $env:INGEST_MAX_LINES=2000000; npm run ingest:dump
   ```

How it works: **Pass 1** indexes every entity's coordinates (`P625`) and subclass edges (`P279`); a **closure step** expands each category's root types into their descendants via a recursive query; **Pass 2** classifies and extracts each event, resolving a person's birthplace to coordinates via the pass-1 index, and capturing each date at its real Wikidata precision (year / month / day / decade / century).

Env knobs: `WIKIDATA_DUMP` (required), `INGEST_START_YEAR` (default 1275), `INGEST_END_YEAR` (default current year), `INGEST_MAX_LINES` (0 = all), `INGEST_PASS` (`coords` | `events` | `all`).

### Curated seed layer

Some categories are sparse or noisy straight from Wikidata (e.g. many elections, treaties, and other agreements lack their own coordinates and get dropped - see Known refinements below). For these, a small curated set can be reviewed by hand in a Notion table, exported to JSON, and merged in deterministically:

- Export curated rows to `seed/*.json` using the exact Notion column names (`Title`, `Blurb`, `Date start`, `Precision`, `Category`, `Place`, `Lat`, `Lng`, `Notability`, `Scope (intended)`, `Source URL`, `Ingest version`).
- Keep files reasonably small (tens of rows each) rather than one large file - very large single-file writes are prone to silent truncation depending on how they're pushed.
- Add each new file to the `FILES` list in `seed.ts`, then run `npm run seed` followed by `npm run score`.
- The `milestone` category (firsts in invention/discovery, e.g. the Moon Landing) is the first curated set, sourced from Wikipedia's "Timeline of historic inventions." Not every instance of a repeating milestone-adjacent category (e.g. presidential elections) is inherently notable - curation should keep only the genuinely important instances rather than every occurrence.

### Inspecting a build

`npm run stats` prints a read-only composition report - total count, breakdown by category / date precision / scope, year span, sample year-precision events, and the `meta` provenance rows. Use it to sanity-check a build before shipping it.

## API service

A thin, dependency-free HTTP server (Node's built-in `http`, no extra packages) that serves the timeline engine and full-text search over the local `events.sqlite`. All access is read-only, so the same static file can back this server or an in-browser applet.

```powershell
npm run serve            # http://localhost:8787  (override with PORT)
```

| Method / path | Purpose |
| --- | --- |
| `GET /` | self-documenting: service info + an example request body |
| `GET /health` | liveness check |
| `GET /meta` | dataset provenance (version, window) + event count |
| `GET /search?q=<term>&limit=<n>` | full-text search (default 25, max 100) |
| `POST /timeline` | body = `TimelineInput` JSON -> `Timeline` JSON; add `?format=markdown` for Markdown |

`POST /timeline` takes a person's life segments and returns the ranked, cited timeline:

```json
{
  "person": "Ada Example",
  "segments": [
    { "label": "Childhood", "place": { "name": "Chicago", "lat": 41.8819, "lng": -87.6278 }, "start": "1939", "end": "1945" }
  ]
}
```

The response is the exact `Timeline` object `getTimeline()` returns (`entries` + `meta` + `datasetVersion`). Invalid input (missing segments, non-numeric coordinates, unparseable dates) returns a `400` with a specific message. CORS is open so a browser applet can call it directly.

## Repo layout

| File | Purpose |
| --- | --- |
| `schema.sql` | SQLite schema (`events`, `places`, `meta`) + `events_fts` search index |
| `ingest.ts` | Sample harvester via live SPARQL (1900-present) |
| `ingest-dump.ts` | Comprehensive harvester from a local Wikidata dump (true date precision) |
| `seed.ts` | Curated seed loader - merges hand-authored rows from `seed/*.json` into `events`, idempotently (`npm run seed`) |
| `seed/*.json` | Curated event rows exported from the Notion review table (currently: `milestone` inventions, 330 rows, era-bucketed into multiple files) |
| `score.ts` | Build-time scorer: scope + significance (pass 1), reach + bbox (pass 2); preserves authored scope on seed rows |
| `prune.ts` | Review + delete low-notability rows within one category without a full re-ingest (`npm run prune <category> [floor] [apply]`) |
| `core.ts` | Deterministic event-radius timeline engine (`getTimeline`) - importable, no side effects |
| `timeline.ts` | CLI demo: runs `getTimeline` against `events.sqlite` |
| `search.ts` | CLI full-text search over the dataset (`events_fts`) |
| `stats.ts` | Read-only dataset diagnostics (counts by category / precision / scope + provenance) |
| `server.ts` | JSON API wrapping `getTimeline` + search over `events.sqlite` (`npm run serve`) |

`events.sqlite` is a build artifact (gitignored) and will be published via GitHub Releases.

## Relevance tuning

Query-time knobs live in `DEFAULT_CONFIG` in `core.ts` (no rescoring needed):

- `significanceFloor` (0.15) - drop events below this era-normalized importance.
- `scopeQuota` (`local 4 / regional 3 / national 4 / global 5`) - per-segment cap **per tier**; the flood control that guarantees a blend of local color + world context.
- `categoryWeights` (`birth 0.4 / death 0.5`) - rank multipliers; celebrity births are demoted vs. substantive history.

Scope thresholds live in `score.ts` pass 1; the reach formula in pass 2. Retuning reach is a no-LLM patch: `npm run score reach`.

## Known refinements (planned)

- **Coordinate-less events** - events without their own `P625` (many elections, treaties, and agreements) are currently dropped, so those categories are under-represented; a country-centroid (`P17`) fallback would capture them.
- **Scope threshold skew** - for scored (non-seed) categories, `scope` is derived from a notability threshold rather than the event's true geographic nature. This can misclassify comparably important events into different reach tiers (e.g. two national elections a few notability points apart landing in `national` vs. `regional`), under-serving the lower-scoring one outside its home region. Needs its own tuning pass, separate from significance.
- **LLM semantic scoring** - pass 1 is currently a structural baseline (category + fame + decade percentile); a batched, cached LLM refiner will improve `scope` and `significance`.
- **Place hierarchy** - matching is coordinate-based; the `places` admin hierarchy will be repopulated via coordinate reverse-geocoding.
- **R-tree spatial index** - the portable bbox columns can be upgraded to a SQLite R-tree at full scale.
- **BCE / ancient events** - the dump ingester currently skips BCE dates.

## License

- **Code:** MIT (see `LICENSE`).
- **Data:** derived from Wikidata (CC0) with Wikipedia links; distributed under **CC BY-SA** with per-item attribution via `source_url`.
