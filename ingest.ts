import Database from 'better-sqlite3';

// Minimal shape of the Wikidata SPARQL JSON response we consume.
interface SparqlBinding {
  event: { value: string };
  eventLabel?: { value: string };
  date?: { value: string };
  coords?: { value: string };
  wikipediaUrl?: { value: string };
}
interface SparqlResponse {
  results: { bindings: SparqlBinding[] };
}

// 1. Initialize SQLite Database
const db = new Database('events.sqlite');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 2. Set up Schema (mirrors schema.sql)
db.exec(`
  CREATE TABLE IF NOT EXISTS places (
    id TEXT PRIMARY KEY,
    name TEXT,
    level TEXT,
    parent_id TEXT,
    lat REAL,
    lng REAL,
    aliases TEXT,
    FOREIGN KEY(parent_id) REFERENCES places(id)
  );

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    title TEXT,
    blurb TEXT,
    date_start TEXT,
    date_end TEXT,
    date_precision TEXT,
    lat REAL,
    lng REAL,
    place_id TEXT,
    scope TEXT,
    category TEXT,
    notability REAL,
    source_url TEXT,
    source_ids TEXT,
    ingest_version TEXT,
    FOREIGN KEY(place_id) REFERENCES places(id)
  );
`);

console.log("\u2705 Database schema initialized.");

// 3. Wikidata SPARQL Query (Proof of Concept)
// Fetches events (Q1190554 or subclasses) that have a point in time (P585)
// and coordinates (P625). Limited to 50 for the initial test.
const query = `
  SELECT ?event ?eventLabel ?date ?coords ?wikipediaUrl WHERE {
    # Select + LIMIT first so the label/sitelink lookups only run on the
    # 50 rows we keep (this keeps us under the ~60s WDQS query timeout).
    {
      SELECT ?event ?date ?coords WHERE {
        ?event wdt:P31/wdt:P279* wd:Q1190554 ; # instance of Event (or subclass)
               wdt:P625 ?coords ;              # must have coordinates
               wdt:P585 ?date .                # point in time
      }
      LIMIT 50
    }

    # Get English label
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }

    # Get English Wikipedia link
    OPTIONAL {
      ?wikipediaUrl schema:about ?event;
                    schema:isPartOf <https://en.wikipedia.org/>.
    }
  }
`;

const WIKIDATA_ENDPOINT = "https://query.wikidata.org/sparql";

// Retry helper: WDQS occasionally returns transient 429/502/503/504 responses.
// Linear backoff usually clears a one-off gateway timeout.
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

async function runIngest() {
  console.log("Fetching sample data from Wikidata...");

  try {
    // POST is the recommended method for non-trivial SPARQL queries.
    const response = await fetchWithRetry(WIKIDATA_ENDPOINT, {
      method: "POST",
      headers: {
        "Accept": "application/sparql-results+json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "GeoHistoryTimeline/1.0 (Contact: noffsingercb@gmail.com)" // Real contact avoids WDQS throttling
      },
      body: new URLSearchParams({ query }).toString()
    });

    if (!response.ok) {
      throw new Error(`Wikidata request failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as SparqlResponse;
    const results = data.results.bindings;

    // Prepare insert statement
    const insertEvent = db.prepare(`
      INSERT OR IGNORE INTO events (id, title, date_start, lat, lng, source_url, source_ids, ingest_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const ingestAll = db.transaction((rows: SparqlBinding[]) => {
      let inserted = 0;
      for (const row of rows) {
        const qid = row.event.value.split('/').pop();
        const title = row.eventLabel ? row.eventLabel.value : 'Unknown Event';
        const date = row.date ? row.date.value : null; // Typically ISO format like 1902-01-01T00:00:00Z
        const wikiUrl = row.wikipediaUrl ? row.wikipediaUrl.value : null;

        // Parse Point(lng lat) string from Wikidata
        let lat: number | null = null;
        let lng: number | null = null;
        if (row.coords) {
          const coordsMatch = row.coords.value.match(/Point\(([-\d.]+) ([-\d.]+)\)/);
          if (coordsMatch) {
            lng = parseFloat(coordsMatch[1]);
            lat = parseFloat(coordsMatch[2]);
          }
        }

        const sourceIds = JSON.stringify({ wikidata: qid });

        insertEvent.run(qid, title, date, lat, lng, wikiUrl, sourceIds, "v0.1-poc");
        inserted++;
      }
      return inserted;
    });

    const count = ingestAll(results);

    console.log(`\u2705 Successfully ingested ${count} sample events into SQLite.`);

  } catch (error) {
    console.error("Error during ingest:", error);
  } finally {
    db.close();
  }
}

runIngest();
