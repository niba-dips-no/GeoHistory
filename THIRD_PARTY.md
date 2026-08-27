# Third-party provenance

This repository is a **fork** of
[noffsingercb/GeoHistory](https://github.com/noffsingercb/GeoHistory), kept here for
reference and as a staging point for vendoring the engine into
[havsudden-hub](https://github.com/niba-dips-no/havsudden-hub) (private).

## License

The upstream project is **MIT licensed** — see [`LICENSE`](./LICENSE),
© Ben Noffsinger. This fork carries no additional license terms of its own; the MIT
license applies to this fork's code as it does to upstream's.

## Dataset

`events.sqlite` (a build artifact, not committed here) is derived from:

- **Wikidata** — CC0.
- **Wikipedia** — CC BY-SA (article text). Share-alike + attribution applies if this
  text is redistributed. Per-row attribution is carried in each event's `source_url`.

See upstream's [README](https://github.com/noffsingercb/GeoHistory#readme) for the
full pipeline and licensing detail.

## What this fork is for

Havsudden-Hub does **not** run the full Wikidata-scale dataset or the Render-hosted
API. Instead, only `core.ts` (the deterministic timeline-matching engine — pure
functions, no network, no DB dependency beyond a `db.prepare().all()`-shaped
interface) is vendored, adapted to run in-process against a small, hand-curated,
Finland/Porvoo-relevant event set instead of the full dataset.

The vendored copy lives at `havsudden-hub/vendor/geohistory-core/` and notes the
exact upstream commit it was taken from and what (if anything) was changed.

## Status of this fork

- GitHub Actions are **disabled** on this fork (upstream's CI builds a Docker image
  and ingests a multi-GB Wikidata dump — neither is relevant here).
- This fork is not actively developed independently of upstream; it exists for
  attribution/provenance and as a source to vendor from, not as a project in its
  own right.
