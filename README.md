# GeoHistory

*An open, geo-located historical events dataset and a deterministic timeline protocol. Give it a person's places and dates; get back a sourced timeline of the history that surrounded their life.*

**Status:** v0.1 — proof of concept

## Overview

GeoHistory answers one question: *"What was happening in and around the places where someone lived, while they lived there?"* It has two parts:

1. **An open events dataset** — a normalized, geo-located SQLite table of historical events harvested from open structured sources (primarily Wikidata), each with dates, coordinates, a place hierarchy, a scope tier, and source links.
2. **A deterministic timeline engine** — a pure function that takes a list of life events (place + date) and returns a ranked, cited timeline. No network calls or model inference at query time.

Two product surfaces sit on the same core:

- **Web applet** — location + date pickers produce an interactive timeline, runnable entirely in the browser via `sql.js`.
- **JSON API** — the same engine behind an HTTP endpoint for integrators.

## Repo layout

| File | Purpose |
| --- | --- |
| `schema.sql` | Canonical SQLite schema (`events` + `places`) |
| `ingest.ts` | Offline batch job: harvests events from Wikidata into `events.sqlite` |
| `timeline.ts` | The deterministic timeline query engine (`getTimeline`) |

`events.sqlite` is a build artifact and is gitignored — it will be published via GitHub Releases.

## Quick start

```bash
npm install
npm run ingest     # builds events.sqlite from Wikidata (proof-of-concept sample)
npm run timeline   # prints a sample timeline
```

Requires Node.js >= 18.

## License

- **Code:** MIT (see `LICENSE`).
- **Data:** the built `events.sqlite` is derived from Wikidata (CC0) and Wikipedia excerpts (CC BY-SA), so the dataset is distributed under **CC BY-SA** with per-event attribution via `source_url`.
