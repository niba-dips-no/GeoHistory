import Database from 'better-sqlite3';

// ===================== Build-time scorer =====================
// Two independently-patchable passes, both fully deterministic and baked into the
// static file. The (future) LLM refiner plugs into pass 1; pass 2 is a pure formula.
//
//   npm run score            -> run both passes (scores, then reach)
//   npm run score scores     -> pass 1 only (scope + significance)
//   npm run score reach      -> pass 2 only (reach_km + bbox) -- the cheap no-LLM patch

const MODE = (process.argv[2] ?? 'all').toLowerCase(); // 'all' | 'scores' | 'reach'
const SCORING_VERSION = 'struct-v0.5';
const REACH_VERSION = 'reach-v0.2';

const db = new Database('events.sqlite');
db.pragma('journal_mode = WAL');

type Scope = 'local' | 'regional' | 'national' | 'global';

// ---------- migration (idempotent; lets the scorer run on pre-scoring DBs) ----------
function migrate(): void {
  const cols = [
    'significance REAL', 'reach_km REAL',
    'reach_min_lat REAL', 'reach_max_lat REAL', 'reach_min_lng REAL', 'reach_max_lng REAL',
    'founding_kind TEXT',
  ];
  for (const c of cols) {
    try { db.exec(`ALTER TABLE events ADD COLUMN ${c};`); } catch { /* column already exists */ }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_significance ON events(significance);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_reach_box ON events(reach_min_lat, reach_max_lat, reach_min_lng, reach_max_lng);`);
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);`);
}

function setMeta(key: string, value: string): void {
  db.prepare(`INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

// ---------- pass 1: scope + significance ----------
// Scope (geographic reach class) from category + absolute fame. Thresholds are
// tuned so world-shaping conflicts/events/discoveries become GLOBAL and reach
// everyone alive at the time (a WWII battle is context for a Chicagoan, not just
// for people near the battlefield). This is the structural baseline; the LLM
// refiner will later overwrite these labels semantically.
//
// FOUNDING is a special case. The ingest discards P31, so a settlement's
// incorporation and a territory's statehood are indistinguishable here, and the
// notability ladder below sent both to 'national' (a 1,950 km reach) whenever the
// place is well known today. But sitelink count measures a place's PRESENT-DAY
// prominence, not how far the news of its founding actually travelled at the time.
// rescope-foundings.ts recovers the missing distinction from events.blurb into
// founding_kind; when it is set, it overrides the ladder.
const FOUNDING_KIND_SCOPE: Record<string, (notability: number) => Scope> = {
  settlement: () => 'local',                                     // a town coming into existence is local news
  // Deliberately 'national' rather than 'regional'. Admission to a federation --
  // New Mexico, Arizona and Oklahoma becoming states in 1907-1912 -- genuinely was
  // national news, and a regional 390 km cap dropped all of them out of a Pueblo,
  // CO timeline covering exactly those years. The cost is that provinces, counties
  // and departments created by administrative fiat are overweighted here. The
  // current data cannot separate the two cases (both are bare P571 place items),
  // and losing real statehood is the worse error. Revisit when P31 is retained.
  subnational: () => 'national',
  country: (n) => (n >= 0.6 ? 'global' : 'national'),            // independence / founding of a nation
};

function scopeFor(category: string | null, notability: number, foundingKind: string | null = null): Scope {
  switch (category) {
    case 'election':  return notability >= 0.5 ? 'national' : 'regional';
    case 'conflict':  return notability >= 0.6 ? 'global' : notability >= 0.3 ? 'national' : notability >= 0.15 ? 'regional' : 'local';
    case 'founding': {
      const byKind = foundingKind ? FOUNDING_KIND_SCOPE[foundingKind] : undefined;
      if (byKind) return byKind(notability);
      return notability >= 0.75 ? 'national' : notability >= 0.4 ? 'regional' : 'local';
    }
    case 'discovery': return notability >= 0.4 ? 'global' : 'national';
    // milestone (inventions / first-of-its-kind): full 4-tier ladder so minor
    // novelties stay local while world-changing firsts reach everyone.
    case 'milestone': return notability >= 0.75 ? 'global' : notability >= 0.45 ? 'national' : notability >= 0.25 ? 'regional' : 'local';
    case 'treaty':    return notability >= 0.6 ? 'global' : notability >= 0.3 ? 'national' : 'regional';
    case 'event':     return notability >= 0.6 ? 'global' : notability >= 0.35 ? 'national' : notability >= 0.2 ? 'regional' : 'local';
    case 'birth':
    case 'death':     return 'local'; // a person's birth/death reaches locally; their fame lives in significance
    default:          return notability >= 0.6 ? 'national' : 'local';
  }
}

// Person rows are ranked against other person rows, never against history.
//
// Two different instruments feed `notability`. Dump events use sitelinks/100 with
// per-category floors as low as 3 sitelinks, so their long tail sits at 0.03-0.12.
// Humans enter at a 30-sitelink floor, so every person row starts at 0.30 by
// construction. Percentiling both against one decade-wide distribution meant a
// decade's biographical volume decided what counted as significant history: a
// curated county-level event at notability 0.12 was ranked below every birth and
// death in the decade and fell under the engine's significance floor, while the
// births themselves were flattered by the events' long tail.
//
// Splitting the two populations makes significance mean "important for its kind,
// in its decade", which is what both the engine floor and the per-tier draw in
// core.ts assume it means.
const PERSON_CATEGORIES = new Set(['birth', 'death']);
const isPersonRow = (category: string | null): boolean => PERSON_CATEGORIES.has(category ?? '');

interface ScoreRow { id: string; category: string | null; notability: number | null; date_start: string | null; scope: string | null; ingest_version: string | null; founding_kind: string | null; }

function runScoring(): void {
  const rows = db.prepare(`SELECT id, category, notability, date_start, scope, ingest_version, founding_kind FROM events`).all() as ScoreRow[];

  // Era-normalize: significance = percentile of notability WITHIN the event's decade,
  // among rows of the same kind (person vs history). This is what keeps sparse
  // historical decades from being buried under modern volume.
  const decadeOf = (ds: string | null): number => {
    const y = parseInt(String(ds ?? '').slice(0, 4), 10);
    return Number.isFinite(y) ? Math.floor(y / 10) * 10 : 0;
  };
  const byDecade = { person: new Map<number, number[]>(), history: new Map<number, number[]>() };
  const bucketOf = (r: ScoreRow) => (isPersonRow(r.category) ? byDecade.person : byDecade.history);
  for (const r of rows) {
    const d = decadeOf(r.date_start);
    const map = bucketOf(r);
    let arr = map.get(d);
    if (!arr) { arr = []; map.set(d, arr); }
    arr.push(typeof r.notability === 'number' ? r.notability : 0);
  }
  for (const map of [byDecade.person, byDecade.history]) {
    for (const arr of map.values()) arr.sort((a, b) => a - b);
  }

  const percentile = (map: Map<number, number[]>, decade: number, n: number): number => {
    const arr = map.get(decade);
    if (!arr || arr.length <= 1) return 0.5;
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= n) lo = mid + 1; else hi = mid; }
    return lo / arr.length;
  };

  const upd = db.prepare(`UPDATE events SET scope = @scope, significance = @significance WHERE id = @id`);
  let byKind = 0;
  let persons = 0;
  const tx = db.transaction((items: ScoreRow[]) => {
    for (const r of items) {
      const notability = typeof r.notability === 'number' ? r.notability : 0;
      const map = bucketOf(r);
      if (isPersonRow(r.category)) persons++;
      const significance = Math.round(percentile(map, decadeOf(r.date_start), notability) * 1000) / 1000;
      // Curated seed rows carry an authored scope; preserve it rather than deriving
      // one from the structural formula, so hand-tuned relevance tiers survive scoring.
      const isSeed = typeof r.ingest_version === 'string' && r.ingest_version.startsWith('seed-');
      if (r.category === 'founding' && r.founding_kind && FOUNDING_KIND_SCOPE[r.founding_kind]) byKind++;
      const scope = (isSeed && r.scope) ? r.scope : scopeFor(r.category, notability, r.founding_kind);
      upd.run({ id: r.id, scope, significance });
    }
  });
  tx(rows);
  setMeta('scoring_version', SCORING_VERSION);
  setMeta('scored_at', new Date().toISOString());
  console.log(`Pass 1: scored ${rows.length} events (scope + era-normalized significance; authored scope preserved for seed rows).`);
  console.log(`  percentiled separately: ${(rows.length - persons).toLocaleString()} history rows, ${persons.toLocaleString()} person rows (birth/death).`);
  console.log(`  founding rows scoped by founding_kind: ${byKind.toLocaleString()} (run "npm run rescope:foundings" to classify more).`);
}

// ---------- pass 2: reach_km + bounding box (pure formula; the cheap patch) ----------
const SCOPE_BASE_KM: Record<Scope, number> = { local: 50, regional: 300, national: 1500, global: 20038 };

// How much significance is allowed to stretch a tier's radius.
//
// The local tier is deliberately flat. At the shared 0.7 + 0.6s curve a 40 km base
// spanned 28-64 km, so whether a genuinely local event 30-50 km away reached you
// depended on its percentile: 50 km required significance >= 0.92, i.e. never.
// "Local" should be a stable neighborhood radius, not a fame-scaled one, so it now
// spans 45-60 km around a 50 km base. Everything above local keeps the original
// curve, where a wider spread is meaningful.
const REACH_CURVE: Record<Scope, { floor: number; span: number }> = {
  local:    { floor: 0.9, span: 0.2 },
  regional: { floor: 0.7, span: 0.6 },
  national: { floor: 0.7, span: 0.6 },
  global:   { floor: 0.7, span: 0.6 },
};

interface ReachRow { id: string; lat: number | null; lng: number | null; scope: string | null; significance: number | null; }

function runReach(): void {
  const rows = db.prepare(`SELECT id, lat, lng, scope, significance FROM events WHERE lat IS NOT NULL AND lng IS NOT NULL`).all() as ReachRow[];
  const upd = db.prepare(`
    UPDATE events
    SET reach_km = @reach_km, reach_min_lat = @minLat, reach_max_lat = @maxLat, reach_min_lng = @minLng, reach_max_lng = @maxLng
    WHERE id = @id
  `);
  const tx = db.transaction((items: ReachRow[]) => {
    for (const r of items) {
      const scope = (r.scope ?? 'local') as Scope;
      const sig = typeof r.significance === 'number' ? r.significance : 0;
      const lat = r.lat as number;
      const lng = r.lng as number;
      const base = SCOPE_BASE_KM[scope] ?? SCOPE_BASE_KM.local;
      const curve = REACH_CURVE[scope] ?? REACH_CURVE.local;

      let reach_km: number, minLat: number, maxLat: number, minLng: number, maxLng: number;
      if (scope === 'global') {
        reach_km = SCOPE_BASE_KM.global; // half Earth circumference -> matches everywhere
        minLat = -90; maxLat = 90; minLng = -180; maxLng = 180;
      } else {
        reach_km = Math.round(base * (curve.floor + curve.span * sig)); // more significant -> reaches a bit further
        const dLat = reach_km / 111;
        const dLng = reach_km / (111 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
        minLat = Math.max(-90, lat - dLat); maxLat = Math.min(90, lat + dLat);
        minLng = lng - dLng; maxLng = lng + dLng;
        if (dLng >= 180) { minLng = -180; maxLng = 180; } // antimeridian-safe fallback
      }
      upd.run({ id: r.id, reach_km, minLat, maxLat, minLng, maxLng });
    }
  });
  tx(rows);
  setMeta('reach_version', REACH_VERSION);
  setMeta('reached_at', new Date().toISOString());
  console.log(`Pass 2: materialized reach + bbox for ${rows.length} events.`);
}

// ===================== Main =====================
migrate();
if (MODE === 'all' || MODE === 'scores') runScoring();
if (MODE === 'all' || MODE === 'reach') runReach();

try {
  const top = db.prepare(`SELECT ingest_version AS v, COUNT(*) AS c FROM events GROUP BY ingest_version ORDER BY c DESC LIMIT 1`).get() as { v?: string } | undefined;
  if (top?.v) setMeta('dataset_version', String(top.v));
} catch { /* ignore */ }

db.close();
console.log('Done. To retune relevance without rescoring, edit the pass-2 formula and run: npm run score reach');
