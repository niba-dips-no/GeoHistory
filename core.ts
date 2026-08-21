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
  foundingKindWeights: Record<string, number>; // rank multipliers for founding rows, by founding_kind
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
export const ENGINE_VERSION = 'geohistory-core@0.5.2';

/**
 * The lowest significance the SQL prefilter will ever use, regardless of what a
 * caller asked for.
 *
 * server.ts already allowlists and clamps the incoming config (see
 * validate-config.ts), so a request cannot reach here with a negative floor.
 * This is the second, independent guard: the engine is a public function that
 * timeline.ts and any future caller can invoke directly, and a floor is the one
 * knob where an out-of-range value does not produce a wrong answer -- it
 * produces a full table scan of ~107k rows per segment. Belt and braces is
 * cheap here and the failure mode is not.
 *
 * 0.01 sits well below every default in DEFAULT_CONFIG (the lowest is local at
 * 0.05) and below Circa's relaxed retry floor, so no legitimate request is
 * touched by it.
 */
export const ABSOLUTE_MIN_FLOOR = 0.01;

/**
 * Hard ceiling on rows materialized from SQLite per segment.
 *
 * The prefilter is bounded by the reach bbox and the year window, which for a
 * real life segment returns hundreds of rows. It is not bounded by anything a
 * caller cannot influence: a low floor over a dense place and a wide year span
 * is a large result set, and every row of it becomes a JS object, gets a
 * haversine computed, and gets sorted -- before any quota applies.
 *
 * Taken in significance order rather than arbitrarily, for two reasons. The cut
 * is deterministic, so the same request keeps returning the same timeline; and
 * significance is the axis selection actually cares about, so the rows dropped
 * at the boundary are the ones least able to win a slot. A caller under the cap
 * -- which is all normal traffic, by a wide margin -- sees byte-identical
 * output, since the per-segment matches are re-sorted by score immediately
 * afterwards.
 */
export const MAX_CANDIDATE_ROWS = 5000;

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

  // `founding` covers two events that have nothing to do with each other: a town
  // filing incorporation papers, and a territory becoming a state or a colony
  // becoming a country. score.ts already separates their REACH via founding_kind;
  // these weights separate their RANK, which reach cannot do because both land in
  // a tier alongside genuine history.
  //
  // The corpus makes the case: 37,895 settlement rows at avg notability 0.188 vs
  // 2,192 subnational rows at 0.501. And because notability is sitelink-derived --
  // present-day prominence, not contemporary importance -- a settlement founding
  // can top its tier outright: Oklahoma City is settlement/local at significance
  // 1.0, and bare village foundings (Lincolnwood 0.85, Forest View 0.834) were
  // beating the UN Charter for slots in a Chicago timeline.
  //
  // A single flat 0.7 could not serve both ends. It was measured against Pueblo CO
  // 1902-1921 under the OLD significance distribution, and once pass 1 stopped
  // ranking history against biography, non-founding national rows rose and 0.7
  // dropped Oklahoma and New Mexico statehood out of that timeline entirely.
  // 0.9 restores them above the rescored Tulsa Race Massacre without disturbing
  // the tier's ordering otherwise.
  //
  // 'institution' is not emitted by rescope-foundings.ts yet -- universities,
  // companies and museums currently fall through to the unclassified fallback.
  // The key is defined here so the classifier has somewhere to land when it does.
  // Unclassified founding rows keep categoryWeights.founding (0.7).
  foundingKindWeights: { settlement: 0.35, institution: 0.5, subnational: 0.9, country: 0.9 },
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
  category: string | null; founding_kind: string | null; source_url: string | null;
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
    foundingKindWeights: { ...DEFAULT_CONFIG.foundingKindWeights, ...(input.config?.foundingKindWeights ?? {}) },
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

  /**
   * Rank multiplier. Founding rows resolve through founding_kind first, so a town
   * incorporating and a territory achieving statehood are not ranked as the same
   * kind of event; unclassified foundings fall back to categoryWeights.founding.
   */
  const weightFor = (category: string | null, foundingKind: string | null): number => {
    if (category === 'founding' && foundingKind) {
      const w = cfg.foundingKindWeights[foundingKind];
      if (typeof w === 'number') return w;
    }
    return cfg.categoryWeights[category ?? ''] ?? 1;
  };

  // The SQL prefilter can only apply one number, so it applies the loosest floor in
  // play and keeps using idx_events_significance; the exact per-tier floor is
  // enforced per row below.
  //
  // ABSOLUTE_MIN_FLOOR is applied here rather than to the incoming config, so it
  // holds no matter which knob a caller used to get low: significanceFloor,
  // any scopeFloor entry, or a combination. This is the number that decides how
  // much of the table the query touches, so it is the right place to be
  // unconditional.
  const minFloor = Math.max(
    ABSOLUTE_MIN_FLOOR,
    Math.min(
      cfg.significanceFloor,
      ...SCOPES.map((sc) => cfg.scopeFloor[sc]).filter((v): v is number => typeof v === 'number'),
    ),
  );

  const segments = input.segments.slice(0, cfg.maxSegments);

  // display_title and founding_kind are later additions, and Step 1.4 bakes
  // events.sqlite into an immutable image layer -- so probe for the columns instead
  // of assuming them, and keep working against a DB built before they existed.
  let columns = new Set<string>();
  try {
    for (const c of db.prepare(`PRAGMA table_info(events)`).all() as Array<{ name: string }>) columns.add(c.name);
  } catch { /* fall back to the minimal column set */ }
  const hasDisplayTitle = columns.has('display_title');
  const hasFoundingKind = columns.has('founding_kind');

  // An event matches when the observer's coordinate falls inside the event's own
  // reach box (cheap, portable spatial prefilter) -- exact haversine refines below.
  //
  // ORDER BY + LIMIT bound how much this can return. Without them the row count
  // is a function of how low the floor is and how dense the place is, and every
  // returned row costs an object, a haversine and a slot in a sort.
  const stmt = db.prepare(`
    SELECT id, title, ${hasDisplayTitle ? 'display_title' : 'NULL AS display_title'},
           blurb, date_start, date_end, date_precision, lat, lng,
           reach_km, significance, scope, category,
           ${hasFoundingKind ? 'founding_kind' : 'NULL AS founding_kind'}, source_url
    FROM events
    WHERE significance >= @floor
      AND reach_km IS NOT NULL
      AND reach_min_lat <= @lat AND reach_max_lat >= @lat
      AND reach_min_lng <= @lng AND reach_max_lng >= @lng
      AND substr(date_start, 1, 4) BETWEEN @loYear AND @hiYear
    ORDER BY significance DESC, id ASC
    LIMIT @limit
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
      limit: MAX_CANDIDATE_ROWS,
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

      const weight = weightFor(row.category, row.founding_kind); // demote biography and bare foundings vs substantive history
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
    // quotas cut the overflow. Since the quotas sum to 18 and a caller typically
    // asks for 10, the tiers that score highest -- global and national, which win
    // on fame -- consumed every slot, and the local/regional tiers this product
    // exists to surface were truncated first. Round-robin reserves each tier its
    // share up front and lets score decide only WITHIN a tier.
    //
    // Note for callers: because the quotas sum to 18, raising maxPerSegment beyond
    // 18 adds nothing on its own -- the quotas have to move too.
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
