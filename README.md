# GeoHistory

*An open, geo-located historical events dataset and a deterministic timeline protocol. Give it a person's places and dates; get back a sourced timeline of the history that surrounded their life.*

**Status:** v0.4 - scored dataset + event-radius timeline engine

## Overview

GeoHistory answers one question: *"What was happening in and around the places where someone lived, while they lived there?"* It has two parts:

1. **An open events dataset** - a flat, geo-located, pre-scored SQLite table of historically significant events harvested from Wikidata.
2. **A deterministic timeline engine** - a pure function that takes a list of life events (place + date) and returns a ranked, cited timeline. No network calls or model inference at query time.

All intelligence is computed **once, at build time**, and frozen into static columns. Query time is pure lookups, so the same file drives both the server API and an in-browser applet.

## The two axes of relevance

Every event is scored on two independent axes so the timeline is both *placed* and *interesting*:

- **Reach** (`scope` -> `reach_km`): how far the event's relevance radiates. An event matches you when your coordinate falls inside its reach circle. A county fair reaches ~40 km; a national election reaches its country; a world war reaches everywhere.
- **Significance** (`significance`, 0..1): does anyone care? Era-normalized so a standout 1600s event isn't buried under modern volume. Below a floor, events are dropped; above it, significance ranks them. This is what keeps "leap day observed" (global reach, ~zero significance) off your timeline.

## Pipeline

```
ingest  ->  score  ->  timeline / search
```

1. `ingest.ts` harvests raw events (title, date, coordinates, category, notability) from Wikidata.
2. `score.ts` derives the two axes and materializes the relevance radius (details below).
3. `core.ts` matches and ranks at query time using only the frozen columns.

### Scoring is split into two patchable passes

| Command | Pass | Cost | What it writes |
| --- | --- | --- | --- |
| `npm run score scores` | 1 | (LLM later) | `scope`, `significance` |
| `npm run score reach` | 2 | pure formula | `reach_km`, reach bounding box |
| `npm run score` | both | - | all of the above |

Because pass 2 is a deterministic formula over pass-1 scores, **retuning the relevance radius is a no-LLM patch**: edit the formula and run `npm run score reach`. The (future) LLM semantic refiner plugs into pass 1 only.

## Repo layout

| File | Purpose |
| --- | --- |
| `schema.sql` | SQLite schema (`events`, `places`, `meta`) + `events_fts` search index |
| `ingest.ts` | Batched Wikidata harvester (one lean query per category per year) |
| `score.ts` | Build-time scorer: scope + significance (pass 1), reach + bbox (pass 2) |
| `core.ts` | Deterministic event-radius timeline engine (`getTimeline`) - importable, no side effects |
| `timeline.ts` | CLI demo: runs `getTimeline` against `events.sqlite` |
| `search.ts` | CLI full-text search over the dataset (`events_fts`) |

`events.sqlite` is a build artifact (gitignored) and will be published via GitHub Releases.

## Quick start

```bash
npm install
npm run ingest              # harvest (long-running; re-runs are idempotent)
npm run score               # derive scope + significance + reach
npm run timeline            # print a sample timeline
npm run search -- moon landing
```

Requires Node.js >= 18. `score.ts` self-migrates, so it also works on a DB built before scoring existed.

### Smaller test runs

```bash
# macOS / Linux
INGEST_START_YEAR=1939 INGEST_END_YEAR=1945 npm run ingest && npm run score

# Windows (PowerShell)
$env:INGEST_START_YEAR=1939; $env:INGEST_END_YEAR=1945; npm run ingest; npm run score
```

## Dataset scope (current)

Harvest walks from the current year back to 1900 (a sample window before the full multi-century build). Categories: `conflict`, `election`, `founding`, `discovery`, `birth`, `death`, and a general `event` catch-all. Every row requires coordinates and clears a notability floor.

## Known refinements (planned)

- **LLM semantic scoring** - pass 1 is currently a structural baseline (category + fame + decade percentile); a batched, cached LLM refiner will improve `scope` and `significance` during the comprehensive build.
- **Comprehensive build via dumps** - the full 600-750-year build will read offline Wikidata dumps instead of the live query service (no rate limits, reproducible).
- **Date precision** - dates are stored at day granularity for now; true Wikidata precision comes later.
- **Place hierarchy** - matching is coordinate-based; the `places` admin hierarchy will be repopulated via coordinate reverse-geocoding.

## License

- **Code:** MIT (see `LICENSE`).
- **Data:** derived from Wikidata (CC0) with Wikipedia links; distributed under **CC BY-SA** with per-item attribution via `source_url`.
