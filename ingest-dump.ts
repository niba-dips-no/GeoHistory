import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

// ===================== Comprehensive dump ingester (v0.5) =====================
// Harvests the full geo-located event dataset from a LOCAL Wikidata JSON dump
// (no live SPARQL -> no rate limits, fully reproducible). Two streaming passes:
//
//   Pass 1 (coords): index every entity's coordinates (P625) + subclass edges (P279)
//   -> closure step expands category root types into their full descendant sets
//   Pass 2 (events): classify + extract each event WITH true Wikidata date precision
//
// Download the dump first (~90-140 GB gzip):
//   https://dumps.wikimedia.org/wikidatawiki/entities/latest-all.json.gz
//
// Usage (PowerShell):
//   $env:WIKIDATA_DUMP="D:\\wikidata\\latest-all.json.gz"; npm run ingest:dump
//   # validate on a slice first:
//   $env:WIKIDATA_DUMP="..."; $env:INGEST_MAX_LINES=2000000; npm run ingest:dump
//   then: npm run score  &&  npm run timeline

const __dirname = dirname(fileURLToPath(import.meta.url));

const DUMP = process.env.WIKIDATA_DUMP;
const START_YEAR = parseInt(process.env.INGEST_START_YEAR ?? '1275', 10); // ~750 years back
const END_YEAR = parseInt(process.env.INGEST_END_YEAR ?? String(new Date().getUTCFullYear()), 10);
const MAX_LINES = process.env.INGEST_MAX_LINES ? parseInt(process.env.INGEST_MAX_LINES, 10) : 0; // 0 = no limit
const PASS = (process.env.INGEST_PASS ?? 'all').toLowerCase(); // 'coords' | 'events' | 'all'
const INGEST_VERSION = 'dump-v0.5';

if (!DUMP || !fs.existsSync(DUMP)) {
  console.error('Set WIKIDATA_DUMP to a local latest-all.json.gz path. Download: https://dumps.wikimedia.org/wikidatawiki/entities/latest-all.json.gz');
  process.exit(1);
}

const db = new Database('events.sqlite');
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = OFF');
db.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));

// Scratch indexes used only during the build (gitignored DB).
db.exec(`CREATE TABLE IF NOT EXISTS _coords (qid TEXT PRIMARY KEY, lat REAL, lng REAL);`);
db.exec(`CREATE TABLE IF NOT EXISTS _subclass (child TEXT, parent TEXT);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_subclass_parent ON _subclass(parent);`);

// ---------- category definitions (root types + which date props carry the event date) ----------
interface CategoryDef { category: string; roots: string[]; dateProps: string[]; floor: number; }
const CATEGORIES: CategoryDef[] = [
  { category: 'conflict',  roots: ['Q180684', 'Q198', 'Q178561', 'Q831663'], dateProps: ['P585', 'P580'], floor: 5 },
  { category: 'election',  roots: ['Q40231'],                                 dateProps: ['P585', 'P580'], floor: 3 },
  { category: 'founding',  roots: ['Q6256', 'Q3624078', 'Q515', 'Q3957', 'Q532', 'Q10864048', 'Q1549591'], dateProps: ['P571'], floor: 5 },
  { category: 'discovery', roots: ['Q12772819', 'Q11019'],                    dateProps: ['P575', 'P571'], floor: 3 },
  { category: 'event',     roots: ['Q1190554', 'Q1656682'],                   dateProps: ['P585', 'P580'], floor: 8 },
];
const HUMAN_FLOOR = 30; // sitelink floor for births/deaths (keeps the file to notable people)

// ===================== dump streaming =====================
function streamDump(onEntity: (e: any) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(DUMP as string).pipe(zlib.createGunzip()),
      crlfDelay: Infinity,
    });
    let n = 0;
    rl.on('line', (raw) => {
      n++;
      const line = raw.trim().replace(/,$/, '');
      if (line.length < 2 || line === '[' || line === ']') { maybeStop(); return; }
      let e: any;
      try { e = JSON.parse(line); } catch { maybeStop(); return; }
      if (e && e.type === 'item' && typeof e.id === 'string' && e.id[0] === 'Q') onEntity(e);
      maybeStop();
      function maybeStop() {
        if (n % 500000 === 0) console.log(`  ...scanned ${n.toLocaleString()} lines`);
        if (MAX_LINES && n >= MAX_LINES) rl.close();
      }
    });
    rl.on('close', () => resolve(n));
    rl.on('error', reject);
  });
}

// ===================== helpers =====================
const instanceIds = (e: any): string[] =>
  (e.claims?.P31 ?? []).map((c: any) => c?.mainsnak?.datavalue?.value?.id).filter(Boolean);

function sitelinkCount(e: any): number { return e.sitelinks ? Object.keys(e.sitelinks).length : 0; }

function firstCoordinate(e: any): { lat: number; lng: number } | null {
  const c = (e.claims?.P625 ?? [])[0]?.mainsnak?.datavalue?.value;
  if (c && typeof c.latitude === 'number' && typeof c.longitude === 'number') return { lat: c.latitude, lng: c.longitude };
  return null;
}

function firstItemId(e: any, prop: string): string | null {
  return (e.claims?.[prop] ?? [])[0]?.mainsnak?.datavalue?.value?.id ?? null;
}

interface ParsedDate { date_start: string; precision: 'day' | 'month' | 'year' | 'decade' | 'century'; year: number; }
function parseTimeClaim(e: any, props: string[]): ParsedDate | null {
  for (const prop of props) {
    const dv = (e.claims?.[prop] ?? [])[0]?.mainsnak?.datavalue?.value;
    if (!dv || typeof dv.time !== 'string') continue;
    const m = dv.time.match(/^([+-])(\d+)-(\d{2})-(\d{2})/);
    if (!m) continue;
    const year = (m[1] === '-' ? -1 : 1) * parseInt(m[2], 10);
    if (year < 1) return null; // skip BCE for now
    let month = parseInt(m[3], 10) || 1;
    let day = parseInt(m[4], 10) || 1;
    const p: number = dv.precision ?? 11;
    const precision = p >= 11 ? 'day' : p === 10 ? 'month' : p === 9 ? 'year' : p === 8 ? 'decade' : 'century';
    const pad = (n: number, l = 2) => String(n).padStart(l, '0');
    return { date_start: `${pad(year, 4)}-${pad(month)}-${pad(day)}`, precision, year };
  }
  return null;
}

function sourceUrl(e: any): string {
  const title = e.sitelinks?.enwiki?.title;
  if (title) return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  return `http://www.wikidata.org/entity/${e.id}`;
}

// ===================== PASS 1: coords + subclass edges =====================
function runCoordsPass(): Promise<void> {
  console.log('Pass 1: indexing coordinates (P625) + subclass edges (P279)...');
  db.exec('DELETE FROM _coords; DELETE FROM _subclass;');
  const insCoord = db.prepare('INSERT OR IGNORE INTO _coords(qid, lat, lng) VALUES(?, ?, ?)');
  const insSub = db.prepare('INSERT INTO _subclass(child, parent) VALUES(?, ?)');
  let batch = 0;
  db.exec('BEGIN');
  const flush = () => { if (++batch % 50000 === 0) { db.exec('COMMIT'); db.exec('BEGIN'); } };
  return streamDump((e) => {
    const coord = firstCoordinate(e);
    if (coord) { insCoord.run(e.id, coord.lat, coord.lng); flush(); }
    for (const c of (e.claims?.P279 ?? [])) {
      const parent = c?.mainsnak?.datavalue?.value?.id;
      if (parent) { insSub.run(e.id, parent); flush(); }
    }
  }).then((n) => {
    db.exec('COMMIT');
    const coords = (db.prepare('SELECT COUNT(*) AS c FROM _coords').get() as any).c;
    console.log(`Pass 1 done: ${n.toLocaleString()} lines, ${coords.toLocaleString()} geo-entities indexed.`);
  });
}

// ---------- closure: expand each category's roots into descendant type sets ----------
function buildTypeToCategory(): Map<string, string> {
  console.log('Closure: expanding category root types via P279* ...');
  const map = new Map<string, string>();
  const closure = db.prepare(`
    WITH RECURSIVE d(q) AS (
      SELECT @root
      UNION
      SELECT s.child FROM _subclass s JOIN d ON s.parent = d.q
    )
    SELECT q FROM d
  `);
  // Priority order = CATEGORIES order; first assignment wins (conflict before event, etc.).
  for (const def of CATEGORIES) {
    for (const root of def.roots) {
      for (const row of closure.all({ root }) as Array<{ q: string }>) {
        if (!map.has(row.q)) map.set(row.q, def.category);
      }
    }
  }
  console.log(`Closure done: ${map.size.toLocaleString()} type QIDs mapped to categories.`);
  return map;
}

// ===================== PASS 2: extract events =====================
function runEventsPass(typeToCategory: Map<string, string>): Promise<void> {
  console.log('Pass 2: extracting events with date precision...');
  const catByName = new Map(CATEGORIES.map((c) => [c.category, c]));
  const getCoord = db.prepare('SELECT lat, lng FROM _coords WHERE qid = ?');
  const insEvent = db.prepare(`
    INSERT OR IGNORE INTO events
      (id, title, blurb, date_start, date_precision, lat, lng, category, notability, source_url, source_ids, ingest_version)
    VALUES
      (@id, @title, @blurb, @date_start, @date_precision, @lat, @lng, @category, @notability, @source_url, @source_ids, @ingest_version)
  `);

  let kept = 0;
  let batch = 0;
  db.exec('BEGIN');
  const flush = () => { if (++batch % 20000 === 0) { db.exec('COMMIT'); db.exec('BEGIN'); } };

  const inWindow = (year: number) => year >= START_YEAR && year <= END_YEAR;
  const notabilityOf = (sl: number) => Math.round(Math.min(1, sl / 100) * 1000) / 1000;

  const add = (row: any) => { insEvent.run(row); kept++; flush(); };

  return streamDump((e) => {
    const types = instanceIds(e);
    if (types.length === 0) return;
    const sl = sitelinkCount(e);
    const title = e.labels?.en?.value;
    if (!title) return;
    const blurb = e.descriptions?.en?.value ?? null;

    // --- humans: births + deaths (coords resolved from birth/death place) ---
    if (types.includes('Q5')) {
      if (sl < HUMAN_FLOOR) return;
      const birth = parseTimeClaim(e, ['P569']);
      if (birth && inWindow(birth.year)) {
        const placeId = firstItemId(e, 'P19');
        const co = placeId ? (getCoord.get(placeId) as any) : null;
        if (co) add({ id: `${e.id}#birth`, title, blurb, date_start: birth.date_start, date_precision: birth.precision, lat: co.lat, lng: co.lng, category: 'birth', notability: notabilityOf(sl), source_url: sourceUrl(e), source_ids: JSON.stringify({ wikidata: e.id }), ingest_version: INGEST_VERSION });
      }
      const death = parseTimeClaim(e, ['P570']);
      if (death && inWindow(death.year)) {
        const placeId = firstItemId(e, 'P20');
        const co = placeId ? (getCoord.get(placeId) as any) : null;
        if (co) add({ id: `${e.id}#death`, title, blurb, date_start: death.date_start, date_precision: death.precision, lat: co.lat, lng: co.lng, category: 'death', notability: notabilityOf(sl), source_url: sourceUrl(e), source_ids: JSON.stringify({ wikidata: e.id }), ingest_version: INGEST_VERSION });
      }
      return;
    }

    // --- typed events (conflict/election/founding/discovery/event) ---
    let category: string | null = null;
    for (const t of types) { const c = typeToCategory.get(t); if (c) { category = c; break; } }
    if (!category) return;
    const def = catByName.get(category)!;
    if (sl < def.floor) return;

    const coord = firstCoordinate(e);
    if (!coord) return; // event must be placeable
    const date = parseTimeClaim(e, def.dateProps);
    if (!date || !inWindow(date.year)) return;

    add({ id: e.id, title, blurb, date_start: date.date_start, date_precision: date.precision, lat: coord.lat, lng: coord.lng, category, notability: notabilityOf(sl), source_url: sourceUrl(e), source_ids: JSON.stringify({ wikidata: e.id }), ingest_version: INGEST_VERSION });
  }).then((n) => {
    db.exec('COMMIT');
    console.log(`Pass 2 done: scanned ${n.toLocaleString()} lines, inserted ${kept.toLocaleString()} events.`);
  });
}

// ===================== main =====================
(async () => {
  const t0 = Date.now();
  if (PASS === 'all' || PASS === 'coords') await runCoordsPass();
  const typeToCategory = buildTypeToCategory();
  if (PASS === 'all' || PASS === 'events') await runEventsPass(typeToCategory);

  // Rebuild FTS + stamp provenance.
  db.exec(`INSERT INTO events_fts(events_fts) VALUES('rebuild');`);
  db.prepare(`INSERT INTO meta(key, value) VALUES('dataset_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(INGEST_VERSION);
  db.prepare(`INSERT INTO meta(key, value) VALUES('window', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(`${START_YEAR}-${END_YEAR}`);

  const total = (db.prepare('SELECT COUNT(*) AS c FROM events').get() as any).c;
  console.log(`\nTotal events in DB: ${total.toLocaleString()}  (window ${START_YEAR}-${END_YEAR})`);
  console.log(`Elapsed: ${Math.round((Date.now() - t0) / 1000)}s. Next: npm run score`);
  db.close();
})().catch((err) => { console.error(err); process.exit(1); });
