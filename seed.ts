import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

// ===================== Curated seed loader (non-scripted rows) =====================
// Merges hand-authored event rows (curated in Notion, exported to seed/*.json)
// into the SAME events table as the Wikidata dump ingest. Kept separate from the
// scripted ingest so these rows are reproducible, identifiable (ingest_version
// starts with "seed-"), and can be re-run or rolled back independently.
//
//   npm run seed     -> upsert all curated rows, then rebuild FTS
//   npm run score    -> (run afterwards) computes significance + reach; the scorer
//                       PRESERVES each seed row's authored scope.
//
// Idempotent: id = "seed:<slug of Seed ID, else title>"; the upsert refreshes
// mutable fields so editing the JSON and re-seeding applies the edits. Fails fast
// on id collisions.
//
// A note on ids: deriving the id from the title alone assumes titles are globally
// unique. That holds for the curated invention rows (each names a distinct thing)
// but NOT for timeline rows titled after a place -- "Hungary" or "Canada" legitimately
// recur across centuries. Such files must set an explicit "Seed ID" per row.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_VERSION = 'seed-inventions-v0.1';
// Split into era-bucketed files to avoid single-write truncation on large pushes.
const FILES = [
  'inventions.json',
  'inventions-2-1873-1909.json',
  'inventions-3-1911-1948.json',
  'inventions-4-1950-1984.json',
  'inventions-5-1986-2020.json',
];

// Curated rows are stored in the exact shape exported from the Notion review
// table (display-name keys) so an export can be pasted in verbatim.
interface RawRow {
  Title: string;
  Blurb: string | null;
  'Date start': string;
  Precision: 'day' | 'month' | 'year' | 'decade' | 'century';
  Category: string;
  Place?: string | null;
  Lat: number | null;
  Lng: number | null;
  Notability: number | null;
  'Scope (intended)': 'local' | 'regional' | 'national' | 'global';
  'Source URL': string | null;
  'Ingest version'?: string | null;
  // Optional stable identifier. When present it replaces the title as the basis
  // for the row id, which is what lets files with repeated titles load at all.
  // Changing it after a seed run creates a NEW row rather than updating the old one.
  'Seed ID'?: string | null;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

const db = new Database('events.sqlite');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF');
db.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf8')); // ensure tables exist

const upsert = db.prepare(`
  INSERT INTO events
    (id, title, blurb, date_start, date_precision, lat, lng, scope, category, notability, source_url, source_ids, ingest_version)
  VALUES
    (@id, @title, @blurb, @date_start, @date_precision, @lat, @lng, @scope, @category, @notability, @source_url, @source_ids, @ingest_version)
  ON CONFLICT(id) DO UPDATE SET
    title          = excluded.title,
    blurb          = excluded.blurb,
    date_start     = excluded.date_start,
    date_precision = excluded.date_precision,
    lat            = excluded.lat,
    lng            = excluded.lng,
    scope          = excluded.scope,
    category       = excluded.category,
    notability     = excluded.notability,
    source_url     = excluded.source_url,
    source_ids     = excluded.source_ids,
    ingest_version = excluded.ingest_version
`);

const seenIds = new Map<string, string>(); // id -> "file: title" of first claimant
let total = 0;

function loadFile(name: string): void {
  const rows = JSON.parse(readFileSync(join(__dirname, 'seed', name), 'utf8')) as RawRow[];
  const tx = db.transaction((items: RawRow[]) => {
    for (const r of items) {
      const title = (r.Title ?? '').trim();
      if (!title) continue;

      // Prefer the curator-authored Seed ID; fall back to the title so existing
      // seed files keep the exact ids they were first loaded with.
      const explicit = (r['Seed ID'] ?? '').trim();
      const id = `seed:${slugify(explicit || title)}`;

      const prior = seenIds.get(id);
      if (prior !== undefined) {
        const suggestion = slugify(`${title}-${r['Date start'] ?? ''}`);
        throw new Error(
          `Duplicate seed id "${id}" in seed/${name} (title: ${title}); already claimed by ${prior}. ` +
            `Give this row a unique "Seed ID", e.g. "${suggestion}".`,
        );
      }
      seenIds.set(id, `${name}: ${title}`);

      upsert.run({
        id,
        title,
        blurb: r.Blurb ?? null,
        date_start: r['Date start'],
        date_precision: r.Precision,
        lat: typeof r.Lat === 'number' ? r.Lat : null,
        lng: typeof r.Lng === 'number' ? r.Lng : null,
        scope: r['Scope (intended)'],
        category: r.Category ?? 'milestone',
        notability: typeof r.Notability === 'number' ? r.Notability : null,
        source_url: r['Source URL'] ?? null,
        source_ids: JSON.stringify({ seed: name.replace(/\.json$/, ''), place: r.Place ?? null }),
        ingest_version: r['Ingest version'] ?? SEED_VERSION,
      });
      total++;
    }
  });
  tx(rows);
  console.log(`Seeded ${rows.length} rows from seed/${name}`);
}

for (const f of FILES) loadFile(f);

// Rebuild external-content FTS so the new rows are searchable.
db.exec(`INSERT INTO events_fts(events_fts) VALUES('rebuild');`);

const seedCount = (db.prepare(`SELECT COUNT(*) AS c FROM events WHERE ingest_version LIKE 'seed-%'`).get() as any).c;
const grand = (db.prepare(`SELECT COUNT(*) AS c FROM events`).get() as any).c;
console.log(`\nUpserted ${total} curated rows. Seed rows in DB: ${seedCount}. Total events: ${grand}.`);
console.log('Next: npm run score   (computes significance + reach; preserves authored scope for seed rows)');
db.close();
