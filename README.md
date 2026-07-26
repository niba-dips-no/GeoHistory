# GeoHistory

*An open, geo-located historical events dataset and a deterministic timeline protocol. Give it a person's places and dates; get back a sourced timeline of the history that surrounded their life.*

**Status:** v0.5 - comprehensive dump-based ingest + scored dataset + event-radius engine

## Overview

GeoHistory answers one question: *"What was happening in and around the places where someone lived, while they lived there?"* It has two parts:

1. **An open events dataset** - a flat, geo-located, pre-scored SQLite table of historically significant events harvested from Wikidata.
2. **A deterministic timeline engine** - a pure function that takes a list of life events (place + date) and returns a ranked, cited timeline. No network calls or model inference at query time.

All intelligence is computed **once, at build time**, and frozen into static columns. Query time is pure lookups, so the same file drives both a server API and an in-browser applet.

## The two axes of relevance

Every event is scored on two independent axes so the timeline is both *placed* and *interesting*:

- **Reach** (`scope` -> `reach_km`): how far the event's relevance radiates. An event matches you when your coordinate falls inside its reach circle. A county fair reaches ~40 km; a national election reaches its country; a world war reaches everywhere.
- **Significance** (`significance`, 0..1): does anyone care? Era-normalized (decade percentile) so a standout 1600s event isn't buried under modern volume. Below a floor, events are dropped; above it, significance ranks them within per-scope quotas.

## Pipeline

```
ingest (sample)  OR  ingest:dump (comprehensive)   ->   score   ->   timeline / search
```

1. **Harvest** - two options:
   - `ingest.ts` (`npm run ingest`): quick sample via the live Wikidata SPARQL endpoint (1900-present). Good for tests.
   - `ingest-dump.ts` (`npm run ingest:dump`): the **comprehensive build** from a local Wikidata dump - no rate limits, ~750-year window, and **true date precision**.
2. `score.ts` (`npm run score`) derives the two axes and materializes the relevance radius.
3. `core.ts` matches and ranks at query time using only the frozen columns.

### Comprehensive build (dumps)

1. Download the dump (~90-140 GB gzip):
   `https://dumps.wikimedia.org/wikidatawiki/entities/latest-all.json.gz`
2. Point the ingester at it and run (PowerShell):
   ```powershell
   $env:WIKIDATA_DUMP="D:\wikidata\latest-all.json.gz"; npm run ingest:dump
   npm run score
   npm run timeline
   ```
3. **Validate on a slice first** (stops after N lines):
   ```powershell
   $env:WIKIDATA_DUMP="D:\wikidata\latest-all.json.gz"; $env:INGEST_MAX_LINES=2000000; npm run ingest:dump
   ```

How it works: **Pass 1** indexes every entity's coordinates (`P625`) and subclass edges (`P279`); a **closure step** expands each category's root types into their descendants via a recursive query; **Pass 2** classifies and extracts each event, resolving a person's birthplace to coordinates via the pass-1 index, and capturing each date at its real Wikidata precision (year / month / day / decade / century).

Env knobs: `WIKIDATA_DUMP` (required), `INGEST_START_YEAR` (default 1275), `INGEST_END_YEAR` (default current year), `INGEST_MAX_LINES` (0 = all), `INGEST_PASS` (`coords` | `events` | `all`).

## Repo layout

| File | Purpose |
| --- | --- |
| `schema.sql` | SQLite schema (`events`, `places`, `meta`) + `events_fts` search index |
| `ingest.ts` | Sample harvester via live SPARQL (1900-present) |
| `ingest-dump.ts` | Comprehensive harvester from a local Wikidata dump (true date precision) |
| `score.ts` | Build-time scorer: scope + significance (pass 1), reach + bbox (pass 2) |
| `core.ts` | Deterministic event-radius timeline engine (`getTimeline`) - importable, no side effects |
| `timeline.ts` | CLI demo: runs `getTimeline` against `events.sqlite` |
| `search.ts` | CLI full-text search over the dataset (`events_fts`) |

`events.sqlite` is a build artifact (gitignored) and will be published via GitHub Releases.

## Relevance tuning

Query-time knobs live in `DEFAULT_CONFIG` in `core.ts` (no rescoring needed):

- `significanceFloor` (0.15) - drop events below this era-normalized importance.
- `scopeQuota` (`local 4 / regional 3 / national 4 / global 5`) - per-segment cap **per tier**; the flood control that guarantees a blend of local color + world context.
- `categoryWeights` (`birth 0.4 / death 0.5`) - rank multipliers; celebrity births are demoted vs. substantive history.

Scope thresholds live in `score.ts` pass 1; the reach formula in pass 2. Retuning reach is a no-LLM patch: `npm run score reach`.

## Known refinements (planned)

- **LLM semantic scoring** - pass 1 is currently a structural baseline (category + fame + decade percentile); a batched, cached LLM refiner will improve `scope` and `significance`.
- **Place hierarchy** - matching is coordinate-based; the `places` admin hierarchy will be repopulated via coordinate reverse-geocoding.
- **R-tree spatial index** - the portable bbox columns can be upgraded to a SQLite R-tree at full scale.
- **BCE / ancient events** - the dump ingester currently skips BCE dates.

## License

- **Code:** MIT (see `LICENSE`).
- **Data:** derived from Wikidata (CC0) with Wikipedia links; distributed under **CC BY-SA** with per-item attribution via `source_url`.
