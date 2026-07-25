import Database from 'better-sqlite3';

// ===================== Public contract types =====================

export type Precision = 'day' | 'month' | 'year' | 'decade' | 'century';
export type Tier = 'local' | 'regional' | 'national';

export interface PlaceInput {
  name: string;
  lat: number;
  lng: number;
  level?: 'locality' | 'county' | 'admin1' | 'country'; // hint; used by the hierarchy matcher (v0.2)
}

export interface SegmentInput {
  label?: string;
  place: PlaceInput;
  start: string;        // "1832" | "1871-10" | "1871-10-08" | "July 12, 1832"
  end?: string;         // omit for a point-in-time life event
  radiusKm?: number;    // per-segment override for the "local" radius
}

export interface EngineConfig {
  maxPerSegment: number;
  maxSegments: number;
  tiersKm: { local: number; regional: number; national: number };
}

export type TimelineConfigInput = {
  maxPerSegment?: number;
  maxSegments?: number;
  tiersKm?: Partial<EngineConfig['tiersKm']>;
};

export interface TimelineInput {
  person?: string;
  segments: SegmentInput[];
  config?: TimelineConfigInput;
}

export interface TimelineEntry {
  id: string;
  title: string;
  blurb: string | null;
  date: string;
  dateStartISO: string;
  dateEndISO: string;
  precision: Precision;
  lat: number;
  lng: number;
  distanceKm: number;
  tier: Tier;
  scope: string | null;
  category: string | null;
  sourceUrl: string | null;
  segmentIndex: number;
  score: number;
}

export interface Timeline {
  ingestVersion: string | null;
  person?: string;
  generatedWith: string;
  entries: TimelineEntry[];
  meta: { segmentCount: number; totalMatched: number; returned: number };
}

export const DEFAULT_CONFIG: EngineConfig = {
  maxPerSegment: 12,
  maxSegments: 20,
  tiersKm: { local: 50, regional: 300, national: 1500 },
};

// ===================== Date handling =====================

interface DateRange { loISO: string; hiISO: string; precision: Precision; }

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** Parse a partial or human date into an inclusive [lo, hi] day range + precision. */
export function parseDate(raw: string): DateRange {
  const s = raw.trim();

  // ISO-ish: 1871 | 1871-10 | 1871-10-08 | 1871-10-08T00:00:00Z
  const isoM = s.match(/^(\d{3,4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (isoM && /^\d/.test(s)) {
    const year = parseInt(isoM[1], 10);
    const month = isoM[2] ? parseInt(isoM[2], 10) : undefined;
    const day = isoM[3] ? parseInt(isoM[3], 10) : undefined;
    if (month && day) return dayRange(year, month, day);
    if (month) return monthRange(year, month);
    return yearRange(year);
  }

  // Human: "July 12, 1832" | "July 1832"
  const hM = s.match(/^([A-Za-z]+)\s+(?:(\d{1,2}),?\s+)?(\d{3,4})$/);
  if (hM) {
    const month = MONTHS[hM[1].toLowerCase()];
    const day = hM[2] ? parseInt(hM[2], 10) : undefined;
    const year = parseInt(hM[3], 10);
    if (month && day) return dayRange(year, month, day);
    if (month) return monthRange(year, month);
    return yearRange(year);
  }

  const d = new Date(s);
  if (!isNaN(d.getTime())) return dayRange(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  throw new Error(`Unparseable date: "${raw}"`);
}

const pad = (n: number, len = 2) => String(n).padStart(len, '0');
const isoStr = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const yearRange = (y: number): DateRange => ({ loISO: isoStr(y, 1, 1), hiISO: isoStr(y, 12, 31), precision: 'year' });
const monthRange = (y: number, m: number): DateRange => ({ loISO: isoStr(y, m, 1), hiISO: isoStr(y, m, lastDay(y, m)), precision: 'month' });
const dayRange = (y: number, m: number, d: number): DateRange => ({ loISO: isoStr(y, m, d), hiISO: isoStr(y, m, d), precision: 'day' });

/** Inclusive overlap; lexicographic compare is valid for zero-padded ISO day strings. */
const rangesOverlap = (aLo: string, aHi: string, bLo: string, bHi: string) => aLo <= bHi && bLo <= aHi;

function formatDate(dateStartISO: string, precision: Precision): string {
  const m = dateStartISO.match(/^(\d+)-(\d{2})-(\d{2})$/);
  if (!m) return dateStartISO;
  const year = parseInt(m[1], 10), month = parseInt(m[2], 10), day = parseInt(m[3], 10);
  if (precision === 'day') return `${MONTH_NAMES[month]} ${day}, ${year}`;
  if (precision === 'month') return `${MONTH_NAMES[month]} ${year}`;
  return `${year}`;
}

// ===================== Geo =====================

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLng = (bLng - aLng) * Math.PI / 180;
  const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLng / 2);
  const a = s1 * s1 + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

const TIER_RANK: Record<Tier, number> = { local: 0, regional: 1, national: 2 };

function tierFor(distanceKm: number, localRadiusKm: number, cfg: EngineConfig): Tier | null {
  if (distanceKm <= Math.max(localRadiusKm, cfg.tiersKm.local)) return 'local';
  if (distanceKm <= cfg.tiersKm.regional) return 'regional';
  if (distanceKm <= cfg.tiersKm.national) return 'national';
  return null;
}

// ===================== Core query =====================

interface EventRow {
  id: string; title: string; blurb: string | null;
  date_start: string | null; date_end: string | null; date_precision: string | null;
  lat: number | null; lng: number | null;
  scope: string | null; category: string | null; notability: number | null;
  source_url: string | null; ingest_version: string | null;
}

function normalizeEventDate(row: EventRow): DateRange {
  const start = (row.date_start as string).slice(0, 10); // strip any time component
  const s = parseDate(start);
  let precision: Precision = s.precision;
  if (row.date_precision && ['day', 'month', 'year', 'decade', 'century'].includes(row.date_precision)) {
    precision = row.date_precision as Precision;
  }
  const hiISO = row.date_end ? parseDate((row.date_end as string).slice(0, 10)).hiISO : s.hiISO;
  return { loISO: s.loISO, hiISO, precision };
}

function scoreOf(tier: Tier, distanceKm: number, notability: number | null, cfg: EngineConfig): number {
  const tierScore = 1 - TIER_RANK[tier] / 3;                       // local 1 · regional .67 · national .33
  const proximity = 1 - Math.min(1, distanceKm / cfg.tiersKm.national);
  const note = notability ?? 0;                                    // 0 until notability is ingested
  return Math.round((0.5 * tierScore + 0.3 * note + 0.2 * proximity) * 1000) / 1000;
}

function rankCompare(a: TimelineEntry, b: TimelineEntry): number {
  if (a.tier !== b.tier) return TIER_RANK[a.tier] - TIER_RANK[b.tier];  // scope proximity first
  if (b.score !== a.score) return b.score - a.score;                    // score desc
  if (a.dateStartISO !== b.dateStartISO) return a.dateStartISO < b.dateStartISO ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;                        // deterministic tiebreak
}

export function getTimeline(db: Database.Database, input: TimelineInput): Timeline {
  const cfg: EngineConfig = {
    maxPerSegment: input.config?.maxPerSegment ?? DEFAULT_CONFIG.maxPerSegment,
    maxSegments: input.config?.maxSegments ?? DEFAULT_CONFIG.maxSegments,
    tiersKm: { ...DEFAULT_CONFIG.tiersKm, ...(input.config?.tiersKm ?? {}) },
  };

  const segments = input.segments.slice(0, cfg.maxSegments);
  const stmt = db.prepare(`
    SELECT id, title, blurb, date_start, date_end, date_precision,
           lat, lng, scope, category, notability, source_url, ingest_version
    FROM events
    WHERE lat IS NOT NULL AND lng IS NOT NULL AND date_start IS NOT NULL
      AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
  `);

  const seen = new Set<string>();
  const entries: TimelineEntry[] = [];
  let totalMatched = 0;
  let ingestVersion: string | null = null;

  segments.forEach((seg, segmentIndex) => {
    const segLo = parseDate(seg.start).loISO;
    const segHi = (seg.end ? parseDate(seg.end) : parseDate(seg.start)).hiISO;

    // Bounding box on the widest tier keeps the scan cheap as the dataset grows.
    const dLat = cfg.tiersKm.national / 111;
    const dLng = cfg.tiersKm.national / (111 * Math.max(0.2, Math.cos(seg.place.lat * Math.PI / 180)));
    const rows = stmt.all(
      seg.place.lat - dLat, seg.place.lat + dLat,
      seg.place.lng - dLng, seg.place.lng + dLng,
    ) as EventRow[];

    const matches: TimelineEntry[] = [];
    for (const row of rows) {
      if (row.lat == null || row.lng == null || !row.date_start) continue;
      ingestVersion ??= row.ingest_version;

      const ev = normalizeEventDate(row);
      if (!rangesOverlap(ev.loISO, ev.hiISO, segLo, segHi)) continue;

      const distanceKm = haversineKm(seg.place.lat, seg.place.lng, row.lat, row.lng);
      const tier = tierFor(distanceKm, seg.radiusKm ?? cfg.tiersKm.local, cfg);
      if (!tier) continue;

      totalMatched++;
      matches.push({
        id: row.id, title: row.title, blurb: row.blurb,
        date: formatDate(ev.loISO, ev.precision),
        dateStartISO: ev.loISO, dateEndISO: ev.hiISO, precision: ev.precision,
        lat: row.lat, lng: row.lng,
        distanceKm: Math.round(distanceKm * 10) / 10,
        tier, scope: row.scope, category: row.category, sourceUrl: row.source_url,
        segmentIndex, score: scoreOf(tier, distanceKm, row.notability, cfg),
      });
    }

    matches.sort(rankCompare);
    let kept = 0;
    for (const m of matches) {
      if (seen.has(m.id)) continue;          // an event appears once, under its best segment
      seen.add(m.id);
      entries.push(m);
      if (++kept >= cfg.maxPerSegment) break;
    }
  });

  // Merge all segments into one chronological timeline.
  entries.sort((a, b) =>
    a.dateStartISO < b.dateStartISO ? -1 :
    a.dateStartISO > b.dateStartISO ? 1 :
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  return {
    ingestVersion,
    person: input.person,
    generatedWith: 'geohistory-core@0.1.0',
    entries,
    meta: { segmentCount: segments.length, totalMatched, returned: entries.length },
  };
}

// ===================== Renderers =====================

export function renderMarkdown(t: Timeline): string {
  const out: string[] = [`# Timeline${t.person ? ` — ${t.person}` : ''}`, ''];
  for (const e of t.entries) {
    out.push(`- **${e.date}** — ${e.title}`);
    if (e.blurb) out.push(`  ${e.blurb}`);
    out.push(`  _${e.distanceKm} km · ${e.tier}_${e.sourceUrl ? ` · [source](${e.sourceUrl})` : ''}`);
  }
  out.push('', `_Dataset ${t.ingestVersion ?? 'unknown'} · ${t.meta.returned} of ${t.meta.totalMatched} matched events_`);
  return out.join('\n');
}

// ===================== Demo (remove this block when importing as a library) =====================

const db = new Database('events.sqlite', { readonly: true });
const demo: TimelineInput = {
  person: 'Ada Example',
  segments: [
    { label: 'Childhood', place: { name: 'Pueblo, Colorado, USA', lat: 38.2544, lng: -104.6091 }, start: '1902', end: '1921-06' },
    { label: 'Adulthood', place: { name: 'Chicago, Illinois, USA', lat: 41.8781, lng: -87.6298 }, start: '1921-06', end: '1954' },
  ],
};
const timeline = getTimeline(db, demo);
console.log(renderMarkdown(timeline));
console.log('\n--- Canonical JSON ---\n');
console.log(JSON.stringify(timeline, null, 2));
db.close();
