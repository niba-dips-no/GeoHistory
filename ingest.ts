import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ===================== Config (override via env for smaller test runs) =====================
const END_YEAR = Number(process.env.INGEST_END_YEAR ?? new Date().getUTCFullYear());
const START_YEAR = Number(process.env.INGEST_START_YEAR ?? 1900);
const ONLY = (process.env.INGEST_CATEGORIES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const REQUEST_DELAY_MS = Number(process.env.INGEST_DELAY_MS ?? 250);
const INGEST_VERSION = 'v0.3';
const WIKIDATA_ENDPOINT = 'https://query.wikidata.org/sparql';

// ===================== DB =====================
const db = new Database('events.sqlite');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
const __dirname = dirname(fileURLToPath(import.meta.url));
db.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));

const insertEvent = db.prepare(`
  INSERT OR IGNORE INTO events
    (id, title, blurb, date_start, date_end, date_precision, lat, lng, place_id, scope, category, notability, source_url, source_ids, ingest_version)
  VALUES (@id, @title, @blurb, @date_start, NULL, NULL, @lat, @lng, NULL, NULL, @category, @notability, @source_url, @source_ids, @ingest_version)
`);

// ===================== Wikidata response shape =====================
interface Cell { value: string; }
type Row = Record<string, Cell | undefined>;
interface SparqlResponse { results: { bindings: Row[] }; }

// ===================== Harvesters =====================
// Each harvester is one lean query per calendar year. Keeping every request to a
// single year keeps result sets small and well under the ~60s WDQS timeout.
interface Harvester {
  category: string;
  typeConstraint: string; // triple pattern(s) constraining ?item
  dateProps: string[];    // date properties (alternation) used for the year filter
  coordsPattern: string;  // binds ?coords (a WKT Point)
  minSitelinks: number;   // notability floor + volume control
  cap: number;            // LIMIT per year (keeps the most notable via ORDER BY)
  idSuffix?: string;      // disambiguates person-based rows (a human QID has both a birth and a death)
}

const HARVESTERS: Harvester[] = [
  { category: 'conflict', typeConstraint: '?item wdt:P31/wdt:P279* wd:Q180684 .', dateProps: ['P585', 'P580'], coordsPattern: '?item wdt:P625 ?coords .', minSitelinks: 5, cap: 250 },
  { category: 'election', typeConstraint: '?item wdt:P31/wdt:P279* wd:Q40231 .', dateProps: ['P585'], coordsPattern: '?item wdt:P625 ?coords .', minSitelinks: 3, cap: 150 },
  { category: 'founding', typeConstraint: 'VALUES ?ftype { wd:Q6256 wd:Q3624078 wd:Q515 wd:Q3957 wd:Q532 wd:Q10864048 } ?item wdt:P31/wdt:P279* ?ftype .', dateProps: ['P571'], coordsPattern: '?item wdt:P625 ?coords .', minSitelinks: 5, cap: 250 },
  { category: 'discovery', typeConstraint: 'VALUES ?dtype { wd:Q12772819 wd:Q11019 } ?item wdt:P31/wdt:P279* ?dtype .', dateProps: ['P575', 'P571'], coordsPattern: '?item wdt:P625 ?coords .', minSitelinks: 3, cap: 150 },
  { category: 'birth', typeConstraint: '?item wdt:P31 wd:Q5 .', dateProps: ['P569'], coordsPattern: '?item wdt:P19 ?bplace . ?bplace wdt:P625 ?coords .', minSitelinks: 25, cap: 300, idSuffix: '#birth' },
  { category: 'death', typeConstraint: '?item wdt:P31 wd:Q5 .', dateProps: ['P570'], coordsPattern: '?item wdt:P20 ?dplace . ?dplace wdt:P625 ?coords .', minSitelinks: 25, cap: 300, idSuffix: '#death' },
  // General catch-all runs last so more specific categories win on shared QIDs.
  { category: 'event', typeConstraint: '?item wdt:P31/wdt:P279* wd:Q1190554 .', dateProps: ['P585'], coordsPattern: '?item wdt:P625 ?coords .', minSitelinks: 8, cap: 400 },
];

function buildQuery(h: Harvester, year: number): string {
  const lo = `${year}-01-01T00:00:00Z`;
  const hi = `${year + 1}-01-01T00:00:00Z`;
  const dateAlt = h.dateProps.map((p) => `wdt:${p}`).join('|');
  return `
    SELECT ?item ?itemLabel ?itemDescription ?date ?coords ?sitelinks ?article WHERE {
      ${h.typeConstraint}
      ?item (${dateAlt}) ?date .
      FILTER(\"${lo}\"^^xsd:dateTime <= ?date && ?date < \"${hi}\"^^xsd:dateTime)
      ${h.coordsPattern}
      ?item wikibase:sitelinks ?sitelinks .
      FILTER(?sitelinks >= ${h.minSitelinks})
      OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . }
      SERVICE wikibase:label { bd:serviceParam wikibase:language \"en\". }
    }
    ORDER BY DESC(?sitelinks)
    LIMIT ${h.cap}
  `;
}

// ===================== HTTP =====================
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url: string, options: RequestInit, retries = 4, backoffMs = 3000): Promise<Response> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, options);
      if ([429, 502, 503, 504].includes(response.status)) throw new Error(`Transient HTTP ${response.status}`);
      return response;
    } catch (err) {
      if (attempt === retries) throw err;
      const wait = backoffMs * attempt;
      console.warn(`    retry ${attempt} in ${wait}ms (${err instanceof Error ? err.message : err})`);
      await sleep(wait);
    }
  }
  throw new Error('unreachable');
}

async function sparql(query: string): Promise<SparqlResponse> {
  const response = await fetchWithRetry(WIKIDATA_ENDPOINT, {
    method: 'POST',
    headers: {
      'Accept': 'application/sparql-results+json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'GeoHistoryTimeline/0.3 (Contact: noffsingercb@gmail.com)',
    },
    body: new URLSearchParams({ query }).toString(),
  });
  if (!response.ok) throw new Error(`Wikidata request failed: ${response.status} ${response.statusText}`);
  return (await response.json()) as SparqlResponse;
}

// ===================== Parsing helpers =====================
function parsePoint(value: string): { lat: number; lng: number } | null {
  const m = value.match(/Point\(([-\d.]+) ([-\d.]+)\)/);
  if (!m) return null;
  return { lng: parseFloat(m[1]), lat: parseFloat(m[2]) };
}
const qidOf = (uri: string): string => uri.split('/').pop() ?? uri;

function ingestRows(h: Harvester, rows: Row[]): number {
  const tx = db.transaction((bindings: Row[]) => {
    let inserted = 0;
    for (const b of bindings) {
      if (!b.item?.value || !b.date?.value || !b.coords?.value) continue;
      const pt = parsePoint(b.coords.value);
      if (!pt) continue;
      const qid = qidOf(b.item.value);
      const sitelinks = b.sitelinks ? parseInt(b.sitelinks.value, 10) : 0;
      const res = insertEvent.run({
        id: h.idSuffix ? `${qid}${h.idSuffix}` : qid,
        title: b.itemLabel?.value ?? qid,
        blurb: b.itemDescription?.value ? b.itemDescription.value.slice(0, 280) : null,
        date_start: b.date.value.slice(0, 10),
        lat: pt.lat,
        lng: pt.lng,
        category: h.category,
        notability: Math.round(Math.min(1, sitelinks / 100) * 1000) / 1000,
        source_url: b.article?.value ?? `https://www.wikidata.org/wiki/${qid}`,
        source_ids: JSON.stringify({ wikidata: qid }),
        ingest_version: INGEST_VERSION,
      });
      if (res.changes > 0) inserted++;
    }
    return inserted;
  });
  return tx(rows);
}

// ===================== Main =====================
async function main(): Promise<void> {
  const harvesters = ONLY.length ? HARVESTERS.filter((h) => ONLY.includes(h.category)) : HARVESTERS;
  console.log(`GeoHistory ingest ${INGEST_VERSION}: years ${END_YEAR} -> ${START_YEAR}, categories: ${harvesters.map((h) => h.category).join(', ')}`);

  let grandTotal = 0;
  for (let year = END_YEAR; year >= START_YEAR; year--) {
    let yearTotal = 0;
    for (const h of harvesters) {
      try {
        const data = await sparql(buildQuery(h, year));
        yearTotal += ingestRows(h, data.results.bindings);
      } catch (err) {
        console.warn(`  [${year} ${h.category}] skipped: ${err instanceof Error ? err.message : err}`);
      }
      await sleep(REQUEST_DELAY_MS);
    }
    grandTotal += yearTotal;
    console.log(`\u2705 ${year}: +${yearTotal} (running total ${grandTotal})`);
  }

  console.log('Rebuilding full-text search index...');
  db.exec(`INSERT INTO events_fts(events_fts) VALUES('rebuild');`);
  const { c } = db.prepare(`SELECT COUNT(*) AS c FROM events`).get() as { c: number };
  console.log(`Done. events table now holds ${c} rows.`);
  db.close();
}

main().catch((err) => {
  console.error('Fatal:', err);
  db.close();
  process.exitCode = 1;
});
