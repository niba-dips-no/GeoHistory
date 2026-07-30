import type Database from 'better-sqlite3';

// ===================== Public contract types =====================

export type Precision = 'day' | 'month' | 'year' | 'decade' | 'century';
export type Scope = 'local' | 'regional' | 'national' | 'global';

/**
 * Draw tiers for the round-robin fill. Identical to Scope plus 'person', which
 * is not a scope a row can carry -- it is derived from category at draw time so
 * births and deaths stop competing with local history. See TIER_ORDER.
 */
export type Tier = Scope | 'person';

export interface PlaceInput {
  name: string;
  lat: number;
  lng: number;
  level?: 'locality' | 'county' | 'admin1' | 'country';
}

export interface SegmentInput {
  label?: string;
  place: PlaceInput;
  start: string;   // "1832" | "1871-10" | "1871-10-08" | "July 12, 1832"
  end?: string;    // omit for a point-in-time life event
}

export interface EngineConfig {
  significanceFloor: number;             // events below this era-normalized importance are dropped
  scopeFloor: Partial<Record<Scope, number>>; // per-tier override of significanceFloor
  maxPerSegment: number;                 // hard cap on entries contributed per life segment
  maxSegments: number;
  scopeQuota: Record<Scope, number>;     // per-segment cap PER scope tier (the flood control)
  personQuota: number;                   // per-segment cap for birth/death rows
  categoryWeights: Record<string, number>; // rank multipliers; unspecified categories default to 1
}

export type TimelineConfigInput = Partial<EngineConfig>;

export interface TimelineInput {
  person?: string;
  segments: SegmentInput[];
  config?: TimelineConfigInput;
}

export interface TimelineEntry {
  id: string;
  /** Raw source label, e.g. 'Arizona'. Matches what events_fts indexes. */
  title: string;
  /**
   * Event-phrased title for rendering, e.g. 'Arizona Statehood'. ALWAYS
   * populated -- falls back to `title` when no display title was derived -- so
   * clients can render this field unconditionally and never implement the
   * fallback themselves. See display-titles.ts for which categories get one.
   */
  displayTitle: string;
  blurb: string | null;
  date: string;
  dateStartISO: string;
  dateEndISO: string;
  precision: Precision;
  lat: number;
  lng: number;
  distanceKm: number;
  reachKm: number;
  scope: string | null;
  significance: number;
  category: string | null;
  sourceUrl: string | null;
  segmentIndex: number;
  score: number;
}

export interface Timeline {
  datasetVersion: string | null;
  person?: string;
  generatedWith: string;
  entries: TimelineEntry[];
  meta: { segmentCount: number; totalMatched: number; returned: number };
}

/**
 * Engine identity stamped onto every Timeline and reported by GET /v1/meta.
 * Bump whenever output changes for identical input -- including tuning defaults,
 * not just code structure.
 */
export const ENGINE_VERSION = 'geohistory-core@0.5.0';

/** Categories drawn from the 'person' tier rather than their nominal scope. */
const PERSON_CATEGORIES = new Set(['birth', 'death']);
const SCOPES: Scope[] = ['local', 'regional', 'national', 'global'];

// Ambient-history defaults. A person's birth/death is weighted DOWN because a
// celebrity's fame is not the same as that birth being significant local history
// at the time. Per-scope quotas guarantee a blend (local color + world context)
// rather than letting one tier -- births or battles -- monopolize the slots.
// That guarantee is delivered by the round-robin fill in getTimeline; the quota
// numbers alone cannot do it (see the comment on the fill loop).
//
// `founding` is demoted for a related reason: sitelink count measures a place's
// PRESENT-DAY prominence, not how far the news of its founding travelled at the
// time. Its inflated REACH is corrected separately in score.ts via founding_kind
// (a settlement's founding is local), so this weight only has to handle RANK.
//
// 0.7 was measured, not guessed, against Pueblo CO 1902-1921: at 0.5 the 1907-1912
// statehood entries were quota-cut out of the national tier entirely; at 1.0 they
// crowded out the 1906 San Francisco earthquake and the Tulsa Race Massacre. 0.7
// returns all three statehood rows AND leaves room for the Ludlow Massacre 101 km
// away. Re-measure this if the notability ceiling is ever softened.
//
// The category weight was never enough to keep biography secondary on its own,
// because score.ts scopes birth/death as 'local' and the weight only orders rows
// WITHIN a tier. A famous person at significance 0.95 still scored 0.38 against a
// curated local event at 0.30 -- inside the four local slots, which the fill draws
// first precisely because that tier loses every tiebreak on raw score. Biography
// now draws from its own tier instead, and the weights below only rank persons
// against each other.
//
// scopeFloor exists because a single percentile floor assumes one population. It
// is not: dump events enter at a 3-12 sitelink floor (a long tail at 0.03-0.12)
// while humans enter at 30 sitelinks, and curated seed rows carry hand-authored
// notability on a third scale entirely. 0.05 for local admits curated
// neighborhood history that 0.15 was silently cutting; the higher global floor
// tightens the tier that matches everyone on Earth and is the most crowded.
export const DEFAULT_CONFIG: EngineConfig = {
  significanceFloor: 0.15,
  scopeFloor: { local: 0.05, regional: 0.15, national: 0.15, global: 0.2 },
  maxPerSegment: 12,
  maxSegments: 20,
  scopeQuota: { local: 4, regional: 3, national: 4, global: 5 },
  personQuota: 2,
  categoryWeights: { birth: 0.4, death: 0.5, founding: 0.7 },
};

/**
 * Tier draw order for the round-robin fill: most geographically specific first,
 * biography last. When maxPerSegment is smaller than the sum of the quotas, the
 * tiers listed first are the ones guaranteed a slot -- and local/regional are
 * exactly the tiers that lose every tiebreak on raw score, so they are drawn
 * first. 'person' is drawn last for the same reason in reverse: births and
 * deaths win on fame and would otherwise crowd out the history around them.
 */
const TIER_ORDER: Tier[] = ['local', 'regional', 'national', 'global', 'person'];

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

  const isoM = s.match(/^(\d{3,4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (isoM && /^\d/.test(s)) {
    const year = parseInt(isoM[1], 10);
    const month = isoM[2] ? parseInt(isoM[2], 10) : undefined;
    const day = isoM[3] ? parseInt(isoM[3], 10) : undefined;
    if (month && day) return dayRange(year, month, day);
    if (month) return monthRange(year, month);
    return yearRange(year);
  }

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

// ===================== Core query (event-radius matching) =====================

interface EventRow {
  id: string; title: string; display_title: string | null; blurb: string | null;
  date_start: string | null; date_end: string | null; date_precision: string | null;
  lat: number | null; lng: number | null;
  reach_km: number | null; significance: number | null; scope: string | null;
  category: string | null; source_url: string | null;
}

function normalizeEventDate(row: EventRow): DateRange {
  const start = (row.date_start as string).slice(0, 10);
  const s = parseDate(start);
  let precision: Precision = s.precision;
  if (row.date_precision && ['day', 'month', 'year', 'decade', 'century'].includes(row.date_precision)) {
    precision = row.date_precision as Precision;
  }
  const hiISO = row.date_end ? parseDate((row.date_end as string).slice(0, 10)).hiISO : s.hiISO;
  return { loISO: s.loISO, hiISO, precision };
}

/** Normalize a stored scope string to a known tier, defaulting to the conservative one. */
function scopeOf(raw: string | null): Scope {
  const s = (raw ?? 'local') as Scope;
  return SCOPES.includes(s) ? s : 'local';
}

export function getTimeline(db: Database.Database, input: TimelineInput): Timeline {
  const cfg: EngineConfig = {
    significanceFloor: input.config?.significanceFloor ?? DEFAULT_CONFIG.significanceFloor,
    scopeFloor: { ...DEFAULT_CONFIG.scopeFloor, ...(input.config?.scopeFloor ?? {}) },
    maxPerSegment: input.config?.maxPerSegment ?? DEFAULT_CONFIG.maxPerSegment,
    maxSegments: input.config?.maxSegments ?? DEFAULT_CONFIG.maxSegments,
    scopeQuota: { ...DEFAULT_CONFIG.scopeQuota, ...(input.config?.scopeQuota ?? {}) },
    personQuota: input.config?.personQuota ?? DEFAULT_CONFIG.personQuota,
    categoryWeights: { ...DEFAULT_CONFIG.categoryWeights, ...(input.config?.categoryWeights ?? {}) },
  };

  // A caller that sets only significanceFloor means it as a global floor, so drop
  // any default per-scope override that would sit below it. Explicit scopeFloor
  // entries still win -- that is what the knob is for.
  if (input.config?.significanceFloor !== undefined) {
    const explicit = input.config?.scopeFloor ?? {};
    for (const sc of SCOPES) {
      if (explicit[sc] === undefined) cfg.scopeFloor[sc] = Math.max(cfg.scopeFloor[sc] ?? 0, cfg.significanceFloor);
    }
  }

  /** Person rows keep the global floor even though score.ts scopes them local. */
  const floorFor = (category: string | null, scope: Scope): number => {
    if (PERSON_CATEGORIES.has(category ?? '')) return cfg.significanceFloor;
    return cfg.scopeFloor[scope] ?? cfg.significanceFloor;
  };

  // The SQL prefilter can only apply one number, so it applies the loosest floor in
  // play and keeps using idx_events_significance; the exact per-tier floor is
  // enforced per row below.
  const minFloor = Math.min(
    cfg.significanceFloor,
    ...SCOPES.map((sc) => cfg.scopeFloor[sc]).filter((v): v is number => typeof v === 'number'),
  );

  const segments = input.segments.slice(0, cfg.maxSegments);

  // display_title is a later addition, and Step 1.4 bakes events.sqlite into an
  // immutable image layer -- so probe for the column instead of assuming it, and
  // keep working against a DB built before display-titles.ts existed.
  let hasDisplayTitle = false;
  try {
    hasDisplayTitle = (db.prepare(`PRAGMA table_info(events)`).all() as Array<{ name: string }>)
      .some((c) => c.name === 'display_title');
  } catch { /* fall back to title-only */ }

  // An event matches when the observer's coordinate falls inside the event's own
  // reach box (cheap, portable spatial prefilter) -- exact haversine refines below.
  const stmt = db.prepare(`
    SELECT id, title, ${hasDisplayTitle ? 'display_title' : 'NULL AS display_title'},
           blurb, date_start, date_end, date_precision, lat, lng,
           reach_km, significance, scope, category, source_url
    FROM events
    WHERE significance >= @floor
      AND reach_km IS NOT NULL
      AND reach_min_lat <= @lat AND reach_max_lat >= @lat
      AND reach_min_lng <= @lng AND reach_max_lng >= @lng
      AND substr(date_start, 1, 4) BETWEEN @loYear AND @hiYear
  `);

  let datasetVersion: string | null = null;
  try {
    const r = db.prepare(`SELECT value FROM meta WHERE key = 'dataset_version'`).get() as { value?: string } | undefined;
    datasetVersion = r?.value ?? null;
  } catch { /* meta table may not exist on very old DBs */ }

  const seen = new Set<string>();
  const entries: TimelineEntry[] = [];
  let totalMatched = 0;

  segments.forEach((seg, segmentIndex) => {
    const segLo = parseDate(seg.start).loISO;
    const segHi = (seg.end ? parseDate(seg.end) : parseDate(seg.start)).hiISO;

    const rows = stmt.all({
      floor: minFloor,
      lat: seg.place.lat,
      lng: seg.place.lng,
      loYear: segLo.slice(0, 4),
      hiYear: segHi.slice(0, 4),
    }) as EventRow[];

    const matches: TimelineEntry[] = [];
    for (const row of rows) {
      if (row.lat == null || row.lng == null || !row.date_start || row.reach_km == null) continue;

      const significance = typeof row.significance === 'number' ? row.significance : 0;
      if (significance < floorFor(row.category, scopeOf(row.scope))) continue; // exact per-tier floor

      const ev = normalizeEventDate(row);
      if (!rangesOverlap(ev.loISO, ev.hiISO, segLo, segHi)) continue;

      const distanceKm = haversineKm(seg.place.lat, seg.place.lng, row.lat, row.lng);
      if (distanceKm > row.reach_km) continue; // exact reach-circle test

      const weight = cfg.categoryWeights[row.category ?? ''] ?? 1; // demote births/deaths/foundings vs substantive history
      const headroom = 1 - Math.min(1, distanceKm / row.reach_km); // 1 at the event, 0 at the edge
      const score = Math.round(significance * weight * (0.6 + 0.4 * headroom) * 1000) / 1000;

      totalMatched++;
      matches.push({
        id: row.id, title: row.title,
        displayTitle: row.display_title?.trim() || row.title,
        blurb: row.blurb,
        date: formatDate(ev.loISO, ev.precision),
        dateStartISO: ev.loISO, dateEndISO: ev.hiISO, precision: ev.precision,
        lat: row.lat, lng: row.lng,
        distanceKm: Math.round(distanceKm * 10) / 10,
        reachKm: row.reach_km,
        scope: row.scope, significance, category: row.category, sourceUrl: row.source_url,
        segmentIndex, score,
      });
    }

    matches.sort((a, b) =>
      b.score !== a.score ? b.score - a.score :
      a.dateStartISO !== b.dateStartISO ? (a.dateStartISO < b.dateStartISO ? -1 : 1) :
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

    // Bucket the matches by tier, preserving the score order established above.
    // Anything with a missing or unrecognized scope is treated as local, which is
    // the conservative reading: an event we cannot place is not world history.
    // Births and deaths are pulled out of local into their own tier so biography
    // cannot consume the slots reserved for the history around it.
    const pools: Record<Tier, TimelineEntry[]> = { local: [], regional: [], national: [], global: [], person: [] };
    for (const m of matches) {
      if (seen.has(m.id)) continue; // an event appears once, under its best-scoring segment
      const tier: Tier = PERSON_CATEGORIES.has(m.category ?? '') ? 'person' : scopeOf(m.scope);
      pools[tier].push(m);
    }

    // Draw ROUND-ROBIN across tiers rather than greedily by score, so the quotas
    // are guarantees and not merely caps.
    //
    // The greedy version took the top maxPerSegment matches overall and let the
    // quotas cut the overflow. Since the quotas sum to 16 and a caller typically
    // asks for 10, the tiers that score highest -- global and national, which win
    // on fame -- consumed every slot, and the local/regional tiers this product
    // exists to surface were truncated first. Round-robin reserves each tier its
    // share up front and lets score decide only WITHIN a tier.
    //
    // Quotas are still hard ceilings, so flood control is unchanged, and slots can
    // still go unfilled when a tier genuinely has no matches. Do NOT read an empty
    // tier as a data gap without checking here first: the local tier looked empty
    // for Pueblo CO 1902-1921 under greedy fill, but a local match existed the
    // whole time (David Packard's 1912 birth, 1.7 km out) and was simply always
    // truncated. That row now draws from the person tier.
    const cursor: Record<Tier, number> = { local: 0, regional: 0, national: 0, global: 0, person: 0 };
    const kept: TimelineEntry[] = [];
    let drewOne = true;
    while (kept.length < cfg.maxPerSegment && drewOne) {
      drewOne = false;
      for (const sc of TIER_ORDER) {
        if (kept.length >= cfg.maxPerSegment) break;
        const quota = sc === 'person' ? cfg.personQuota : (cfg.scopeQuota[sc] ?? cfg.maxPerSegment);
        const next = cursor[sc];
        if (next >= quota || next >= pools[sc].length) continue; // tier capped or exhausted
        kept.push(pools[sc][next]);
        cursor[sc] = next + 1;
        drewOne = true;
      }
    }

    for (const m of kept) {
      seen.add(m.id);
      entries.push(m);
    }
  });

  entries.sort((a, b) =>
    a.dateStartISO < b.dateStartISO ? -1 :
    a.dateStartISO > b.dateStartISO ? 1 :
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  return {
    datasetVersion,
    person: input.person,
    generatedWith: ENGINE_VERSION,
    entries,
    meta: { segmentCount: segments.length, totalMatched, returned: entries.length },
  };
}

// ===================== Renderer =====================

export function renderMarkdown(t: Timeline): string {
  const out: string[] = [`# Timeline${t.person ? ` \u2014 ${t.person}` : ''}`, ''];
  for (const e of t.entries) {
    out.push(`- **${e.date}** \u2014 ${e.displayTitle}`);
    if (e.blurb) out.push(`  ${e.blurb}`);
    out.push(`  _${e.scope ?? 'n/a'} \u00b7 sig ${e.significance} \u00b7 ${e.distanceKm}/${e.reachKm} km${e.sourceUrl ? ` \u00b7 [source](${e.sourceUrl})` : ''}_`);
  }
  out.push('', `_Dataset ${t.datasetVersion ?? 'unknown'} \u00b7 ${t.meta.returned} of ${t.meta.totalMatched} matched events_`);
  return out.join('\n');
}
