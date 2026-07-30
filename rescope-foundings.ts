import Database from 'better-sqlite3';

// ===================== Founding sub-type classifier (stopgap) =====================
// `ingest-dump.ts` uses an item's P31 types to pick a category and then discards
// them. So "Las Vegas was incorporated" and "Arizona became a state" arrive in the
// events table as indistinguishable `founding` rows, and score.ts's notability
// ladder gave BOTH a national scope -> a 1,950 km reach. That is why a Pueblo
// timeline ranked the founding of Las Vegas, 961 km away, as national context.
//
// The proper fix is a v2 ingest that retains P31. Until then we recover the
// distinction from the one place it survives in the current file: the Wikidata
// English description already stored in events.blurb --
//   "city in Nevada, United States"        -> settlement   -> local
//   "state of the United States"           -> subnational  -> national (see score.ts)
//   "sovereign state in South America"     -> country      -> national / global
//
// founding_kind now drives RANK as well as scope: core.ts resolves its per-row
// weight through DEFAULT_CONFIG.foundingKindWeights (settlement 0.35, institution
// 0.5, subnational 0.9, country 0.9) before falling back to categoryWeights.
// A row left unclassified therefore keeps both the old notability-ladder scope and
// the old flat 0.7 weight -- classification is now worth more than it used to be.
//
// KNOWN GAP: there is no 'institution' pattern set yet, so universities, companies,
// museums and clubs fall through to unclassified and are scored on raw sitelink
// notability. Because sitelinks measure present-day prominence rather than
// contemporary importance, a well-known institution can inherit a very large reach
// from a founding that was purely local at the time.
//
// This script writes ONLY events.founding_kind. score.ts remains the sole owner of
// scope and reach, so the pipeline is:
//
//   npm run rescope:foundings          # classify (this script)
//   npm run score                      # derive scope from founding_kind, re-materialize reach
//
// Flags:
//   --dry     classify and report without writing anything
//   --reset   clear founding_kind first (use when re-running after editing patterns)
//   --limit=N sample only N rows (quick pattern iteration)

const argv = process.argv.slice(2).map((a) => a.toLowerCase());
const DRY = argv.includes('--dry');
const RESET = argv.includes('--reset');
const LIMIT = (() => {
  const a = argv.find((x) => x.startsWith('--limit='));
  const n = a ? parseInt(a.split('=')[1], 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
})();

const db = new Database('events.sqlite');
db.pragma('journal_mode = WAL');

// Idempotent migration so this runs against an existing DB with no rebuild.
try { db.exec('ALTER TABLE events ADD COLUMN founding_kind TEXT;'); } catch { /* column already exists */ }
db.exec('CREATE INDEX IF NOT EXISTS idx_events_founding_kind ON events(founding_kind);');

type FoundingKind = 'settlement' | 'subnational' | 'country';

// An explicit settlement noun is decisive even when the description also names the
// containing state or country ("city in the state of Nevada", "capital city of Peru").
const SETTLEMENT: RegExp[] = [
  /\b(city|cities|town|township|village|hamlet|borough|municipality|commune|settlement|suburb|neighborhood|neighbourhood|metropolis|locality)\b/,
  /\burban (area|district|settlement)\b/,
  /\bunincorporated (area|community)\b/,
  /\bcensus-designated place\b/,
  /\bcapital (city )?of\b/,
  /\bhuman settlement\b/,
  /\bport (city|town)\b/,
];

// Subnational administrative divisions. Checked BEFORE the generic country rules so
// "republic in Russia" (Tatarstan) is not mistaken for a sovereign state.
const SUBNATIONAL: RegExp[] = [
  /\bstate (of|in)\b/,
  /\bfederal state\b/,
  /\b(republic|oblast|krai|okrug) (in|of) (russia|the russian federation|the soviet union|the ussr)\b/,
  /\bprovince\b/,
  /\bprefecture\b/,
  /\bregion (of|in)\b/,
  /\bcounty\b/,
  /\bparish\b/,
  /\bdistrict\b/,
  /\bdepartment (of|in)\b/,
  /\bcanton\b/,
  /\boblast\b/,
  /\bkrai\b/,
  /\bokrug\b/,
  /\bvoivodeship\b/,
  /\bgovernorate\b/,
  /\bautonomous (community|region|okrug|oblast|republic)\b/,
  /\bterritory (of|in)\b/,
  /\badministrative (division|region|unit|territorial entity)\b/,
];

const COUNTRY: RegExp[] = [
  /\bcountry\b/,
  /\bnation\b/,
  /\b(federal |islamic |people's |socialist |democratic )?republic (in|of)\b/,
  /\bkingdom (in|of)\b/,
  /\bempire\b/,
  /\bcaliphate\b/,
  /\bconfederation\b/,
];

/**
 * Order is load-bearing:
 *   1. settlement nouns win outright,
 *   2. "sovereign state" beats the generic "state of/in" subnational rule,
 *   3. subnational divisions beat the generic country rules,
 *   4. remaining country wording.
 * Anything unmatched returns null and keeps the old notability-ladder behavior.
 */
function classify(blurb: string | null): FoundingKind | null {
  if (!blurb) return null;
  const b = blurb.toLowerCase();
  if (SETTLEMENT.some((re) => re.test(b))) return 'settlement';
  if (/\bsovereign state\b/.test(b) || /\bindependent (country|state|nation)\b/.test(b)) return 'country';
  if (SUBNATIONAL.some((re) => re.test(b))) return 'subnational';
  if (COUNTRY.some((re) => re.test(b))) return 'country';
  return null;
}

// Mirrors FOUNDING_KIND_SCOPE in score.ts and foundingKindWeights in core.ts --
// reporting only, kept in sync by hand.
const SCOPE_LABEL: Record<string, string> = {
  settlement: 'local (50-60 km), rank weight 0.35',
  subnational: 'national (1,050-1,950 km), rank weight 0.9',
  country: 'national / global (by notability), rank weight 0.9',
  unclassified: 'unchanged (notability ladder), rank weight 0.7',
};

// ===================== Run =====================

if (RESET && !DRY) {
  const cleared = db.prepare(`UPDATE events SET founding_kind = NULL WHERE category = 'founding'`).run();
  console.log(`--reset: cleared founding_kind on ${cleared.changes.toLocaleString()} rows.`);
}

interface Row { id: string; title: string; blurb: string | null; notability: number | null; }

const rows = db.prepare(`
  SELECT id, title, blurb, notability
  FROM events
  WHERE category = 'founding'
  ORDER BY notability DESC
  ${LIMIT ? 'LIMIT ' + LIMIT : ''}
`).all() as Row[];

const tally: Record<string, number> = { settlement: 0, subnational: 0, country: 0, unclassified: 0 };
const decided: Array<{ id: string; kind: FoundingKind }> = [];
const unclassified: Row[] = [];

for (const r of rows) {
  const kind = classify(r.blurb);
  if (kind) { tally[kind]++; decided.push({ id: r.id, kind }); }
  else { tally.unclassified++; unclassified.push(r); }
}

if (!DRY) {
  const upd = db.prepare(`UPDATE events SET founding_kind = @kind WHERE id = @id`);
  const tx = db.transaction((items: Array<{ id: string; kind: FoundingKind }>) => {
    for (const it of items) upd.run(it);
  });
  tx(decided);
}

// ---------- report ----------
console.log(`\nfounding rows examined: ${rows.length.toLocaleString()}${DRY ? '  (dry run, nothing written)' : ''}`);
console.table(
  Object.entries(tally).map(([kind, count]) => ({
    kind,
    count,
    share: rows.length ? `${((count / rows.length) * 100).toFixed(1)}%` : '-',
    scope: SCOPE_LABEL[kind] ?? '?',
  })),
);

// The unclassified rows that matter are the famous ones -- those are the entries
// that will keep surfacing in timelines with an inflated reach.
if (unclassified.length) {
  console.log(`\nTop unclassified by notability (extend the patterns if these look systematic):`);
  console.table(unclassified.slice(0, 20).map((r) => ({
    notability: r.notability,
    title: r.title.slice(0, 40),
    blurb: (r.blurb ?? '(none)').slice(0, 70),
  })));
}

console.log(`\nNext: npm run score      # derives scope from founding_kind and re-materializes reach`);
if (DRY) console.log('(re-run without --dry to write founding_kind)');

db.close();
