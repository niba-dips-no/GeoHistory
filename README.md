# GeoHistory

*An open, geo-located historical events dataset and a deterministic timeline protocol. Give it a person's places and dates; get back a sourced timeline of the history that surrounded their life.*

**Status:** v0.3 - scaled dataset build (batched multi-category Wikidata harvest)

## Overview

GeoHistory answers one question: *"What was happening in and around the places where someone lived, while they lived there?"* It has two parts:

1. **An open events dataset** - a flat, geo-located SQLite table of historically significant events harvested from Wikidata, each with a date, coordinates, a category, a notability score, and source links.
2. **A deterministic timeline engine** - a pure function that takes a list of life events (place + date) and returns a ranked, cited timeline. No network calls or model inference at query time.

Two product surfaces sit on the same core:

- **Circa** - the web applet: location + date pickers produce an interactive timeline.
- **JSON API** - the same engine behind an HTTP endpoint for integrators.

## Repo layout

| File | Purpose |
| --- | --- |
| `schema.sql` | SQLite schema (`events` + `places`) and the `events_fts` search index |
| `ingest.ts` | Batched Wikidata harvester (one lean query per category per year) |
| `core.ts` | Deterministic timeline engine (`getTimeline`, `parseDate`, `renderMarkdown`) - importable, no side effects |
| `timeline.ts` | CLI demo: runs `getTimeline` against `events.sqlite` |
| `search.ts` | CLI full-text search over the dataset (`events_fts`) |

`events.sqlite` is a build artifact (gitignored) and will be published via GitHub Releases.

## Dataset scope (v0.3)

The harvester walks from the current year back to 1900, running one query per category per year so no single request approaches the WDQS timeout. Categories:

- `conflict` - wars, battles, and other conflicts
- `election` - notable elections
- `founding` - inception of countries, states, cities, and towns
- `discovery` - discoveries and inventions
- `birth` / `death` - notable people (stored as `QID#birth` / `QID#death`)
- `event` - general catch-all of significant occurrences

Every row requires coordinates (so it can be placed on the map/timeline) and clears a notability floor (a minimum Wikidata sitelink count), which controls volume and keeps the set to significant items. `notability` is a normalized 0..1 sitelink score, and `ORDER BY sitelinks DESC` keeps the most-linked items within each per-year cap.

Not region-limited: a North America filter would add query complexity (extra joins), so per the brief we rely on year-batching + notability for volume control instead.

## Quick start

```bash
npm install
npm run ingest                    # full 1900-present harvest (long-running; re-runs are idempotent)
npm run timeline                  # print a sample timeline
npm run search -- moon landing    # full-text search the dataset
```

Requires Node.js >= 18.

### Smaller test runs

Scope the harvest with env vars before committing to the full run.

```bash
# macOS / Linux
INGEST_START_YEAR=2015 INGEST_END_YEAR=2020 npm run ingest
INGEST_CATEGORIES=conflict,birth INGEST_START_YEAR=1939 INGEST_END_YEAR=1945 npm run ingest

# Windows (PowerShell)
$env:INGEST_START_YEAR=2015; $env:INGEST_END_YEAR=2020; npm run ingest
```

Delete `events.sqlite` first if you want a clean rebuild.

## Known refinements (planned)

- **Date precision** - dates are stored at day granularity for now; true Wikidata precision (year/decade) will be captured later for cleaner display.
- **Place hierarchy** - at scale we match on coordinates; the `places` admin hierarchy and `place_id` linking will be repopulated via coordinate reverse-geocoding rather than per-entity `P131` walks.

## License

- **Code:** MIT (see `LICENSE`).
- **Data:** derived from Wikidata (CC0) with Wikipedia links; the dataset is distributed under **CC BY-SA** with per-item attribution via `source_url`.
