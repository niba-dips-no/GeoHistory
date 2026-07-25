import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ===================== Wikidata response shapes =====================
interface EventBinding {
  event: { value: string };
  eventLabel?: { value: string };
  date?: { value: string };
  coords?: { value: string };
  wikipediaUrl?: { value: string };
}
interface EventResponse { results: { bindings: EventBinding[] }; }

interface PlaceBinding {
  event: { value: string };
  directAdmin: { value: string };
  place: { value: string };
  placeLabel?: { value: string };
  coords?: { value: string };
  parent?: { value: string };
  type?: { value: string };
}
interface PlaceResponse { results: { bindings: PlaceBinding[] }; }

type Level = 'locality' | 'county' | 'admin1' | 'country';

// ===================== DB setup =====================
const db = new Database('events.sqlite');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema from the canonical schema.sql (single source of truth).
const __dirname = dirname(fileURLToPath(import.meta.url));
db.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));
console.log("\u2705 Database schema initialized (from schema.sql).");

const WIKIDATA_ENDPOINT = "https://query.wikidata.org/sparql";
const INGEST_VERSION = "v0.2-poc";

// ===================== Helpers =====================
const qidOf = (uri?: string): string | null =>
  uri ? uri.split('/').pop() ?? null : null;

function parsePoint(value?: string): { lat: number | null; lng: number | null } {
  if (!value) return { lat: null, lng: null };
  const m = value.match(/Point\(([-\d.]+) ([-\d.]+)\)/);
  if (!m) return { lat: null, lng: null };
  return { lat: parseFloat(m[2]), lng: parseFloat(m[1]) };
}

// Wikidata "instance of" (P31) QIDs -> our coarse admin level (interim classifier).
const LEVEL_BY_TYPE: Record<string, Level> = {
  Q6256: 'country', Q3624078: 'country',
  Q10864048: 'admin1', Q35657: 'admin1',
  Q13220204: 'county', Q28575: 'county', Q47168: 'county',
  Q486972: 'locality', Q515: 'locality', Q3957: 'locality',
  Q532: 'locality', Q5119: 'locality', Q1093829: 'locality',
};
const LEVEL_PRIORITY: Level[] = ['country', 'admin1', 'county', 'locality'];

function classifyLevel(types: Set<string>): Level | null {
  const found = new Set<Level>();
  for (const t of types) {
    const lvl = LEVEL_BY_TYPE[t];
    if (lvl) found.add(lvl);
  }
  for (const lvl of LEVEL_PRIORITY) if (found.has(lvl)) return lvl;
  return null;
}

// Retry helper: WDQS occasionally returns transient 429/502/503/504 responses.
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 4,
  backoffMs = 2000
): Promise<Response> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, options);
      if ([429, 502, 503, 504].includes(response.status)) {
        throw new Error(`Transient HTTP ${response.status}`);
      }
      return response;
    } catch (err) {
      if (attempt === retries) throw err;
      const wait = backoffMs * attempt; // 2s, 4s, 6s, ...
      console.warn(`Attempt ${attempt} failed (${err instanceof Error ? err.message : err}). Retrying in ${wait}ms...`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error("unreachable");
}

async function sparql<T>(query: string): Promise<T> {
  const response = await fetchWithRetry(WIKIDATA_ENDPOINT, {
    method: "POST",
    headers: {
      "Accept": "application/sparql-results+json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "GeoHistoryTimeline/1.0 (Contact: noffsingercb@gmail.com)"
    },
    body: new URLSearchParams({ query }).toString()
  });
  if (!response.ok) {
    throw new Error(`Wikidata request failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

// ===================== Pass 1: events =====================
// Events (Q1190554 or subclasses) with a point in time (P585) and coordinates
// (P625). Select + LIMIT first so label/sitelink lookups only run on the 50
// rows we keep (keeps us under the ~60s WDQS query timeout).
const EVENT_QUERY = `
  SELECT ?event ?eventLabel ?date ?coords ?wikipediaUrl WHERE {
    {
      SELECT ?event ?date ?coords WHERE {
        ?event wdt:P31/wdt:P279* wd:Q1190554 ;
               wdt:P625 ?coords ;
               wdt:P585 ?date .
      }
      LIMIT 50
    }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    OPTIONAL {
      ?wikipediaUrl schema:about ?event;
                    schema:isPartOf <https://en.wikipedia.org/>.
    }
  }
`;

async function runEvents(): Promise<void> {
  console.log("Fetching sample events from Wikidata...");
  const data = await sparql<EventResponse>(EVENT_QUERY);
  const rows = data.results.bindings;

  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO events (id, title, date_start, lat, lng, source_url, source_ids, ingest_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const ingestAll = db.transaction((bindings: EventBinding[]) => {
    let inserted = 0;
    for (const row of bindings) {
      const qid = qidOf(row.event.value);
      const title = row.eventLabel ? row.eventLabel.value : 'Unknown Event';
      const date = row.date ? row.date.value : null;
      const wikiUrl = row.wikipediaUrl ? row.wikipediaUrl.value : null;
      const { lat, lng } = parsePoint(row.coords?.value);
      const sourceIds = JSON.stringify({ wikidata: qid });
      insertEvent.run(qid, title, date, lat, lng, wikiUrl, sourceIds, INGEST_VERSION);
      inserted++;
    }
    return inserted;
  });

  const count = ingestAll(rows);
  console.log(`\u2705 Ingested ${count} sample events.`);
}

// ===================== Pass 2: places + place_id linking =====================
// For every ingested event, walk its administrative containment chain (P131)
// up to the country. Insert each place once, wire up parent_id, classify a
// coarse level, and set events.place_id to the event's direct admin entity.
interface PlaceAccum {
  name: string;
  lat: number | null;
  lng: number | null;
  parentQid: string | null;
  types: Set<string>;
}

async function runPlaces(): Promise<void> {
  const eventRows = db.prepare(`SELECT id FROM events WHERE id IS NOT NULL`).all() as { id: string }[];
  if (eventRows.length === 0) {
    console.log("No events found; skipping place linking.");
    return;
  }

  const values = eventRows.map((r) => `wd:${r.id}`).join(' ');
  const placeQuery = `
    SELECT ?event ?directAdmin ?place ?placeLabel ?coords ?parent ?type WHERE {
      VALUES ?event { ${values} }
      ?event wdt:P131 ?directAdmin .
      ?directAdmin wdt:P131* ?place .
      OPTIONAL { ?place wdt:P625 ?coords. }
      OPTIONAL { ?place wdt:P131 ?parent. }
      OPTIONAL { ?place wdt:P31 ?type. }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
  `;

  console.log("Fetching administrative hierarchy from Wikidata...");
  const data = await sparql<PlaceResponse>(placeQuery);
  const rows = data.results.bindings;

  const places = new Map<string, PlaceAccum>();
  const eventDirect = new Map<string, string>(); // eventQid -> directAdminQid (deterministic)

  for (const row of rows) {
    const eventQid = qidOf(row.event.value);
    const directQid = qidOf(row.directAdmin.value);
    const placeQid = qidOf(row.place.value);
    if (!placeQid) continue;

    if (eventQid && directQid) {
      const cur = eventDirect.get(eventQid);
      if (!cur || directQid < cur) eventDirect.set(eventQid, directQid);
    }

    let acc = places.get(placeQid);
    if (!acc) {
      acc = { name: placeQid, lat: null, lng: null, parentQid: null, types: new Set() };
      places.set(placeQid, acc);
    }
    if (row.placeLabel?.value) acc.name = row.placeLabel.value;
    if (row.coords?.value) {
      const { lat, lng } = parsePoint(row.coords.value);
      if (lat !== null) acc.lat = lat;
      if (lng !== null) acc.lng = lng;
    }
    const parentQid = qidOf(row.parent?.value);
    if (parentQid) acc.parentQid = parentQid;
    const typeQid = qidOf(row.type?.value);
    if (typeQid) acc.types.add(typeQid);
  }

  const upsertPlace = db.prepare(`
    INSERT INTO places (id, name, level, lat, lng) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name  = excluded.name,
      level = COALESCE(excluded.level, places.level),
      lat   = COALESCE(excluded.lat, places.lat),
      lng   = COALESCE(excluded.lng, places.lng)
  `);
  const setParent = db.prepare(`UPDATE places SET parent_id = ? WHERE id = ?`);
  const setEventPlace = db.prepare(`UPDATE events SET place_id = ? WHERE id = ?`);

  const writeAll = db.transaction(() => {
    // Phase 1: insert every place with parent_id left NULL (avoids FK ordering issues).
    for (const [id, p] of places) {
      upsertPlace.run(id, p.name, classifyLevel(p.types), p.lat, p.lng);
    }
    // Phase 2: wire parent_id now that all rows exist.
    let linkedParents = 0;
    for (const [id, p] of places) {
      if (p.parentQid && places.has(p.parentQid)) {
        setParent.run(p.parentQid, id);
        linkedParents++;
      }
    }
    // Phase 3: link each event to its direct administrative entity.
    let linkedEvents = 0;
    for (const [eventQid, directQid] of eventDirect) {
      if (places.has(directQid)) {
        setEventPlace.run(directQid, eventQid);
        linkedEvents++;
      }
    }
    return { linkedParents, linkedEvents };
  });

  const { linkedParents, linkedEvents } = writeAll();
  console.log(`\u2705 Inserted ${places.size} places (${linkedParents} parent links); linked ${linkedEvents}/${eventRows.length} events to a place.`);
}

// ===================== Main =====================
async function main(): Promise<void> {
  try {
    await runEvents();
    await runPlaces();
  } catch (error) {
    console.error("Error during ingest:", error);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
