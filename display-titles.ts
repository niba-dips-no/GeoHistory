import Database from 'better-sqlite3';

// ===================== Display titles (post-ingest build pass) =====================
// Wikidata labels the THING. Our rows represent an EVENT about that thing. So a
// row for Arizona's admission to the Union is titled 'Arizona', and a row for
// David Packard's birth is titled 'David Packard' -- correct labels, useless as
// timeline entries, because the reader cannot tell what happened.
//
// The verb is not recoverable from the label: ingest-dump.ts discards P31 once it
// has picked a category. It does not need to be. For a few categories the
// CATEGORY IS THE VERB, so a display title can be derived from structured
// columns (category, founding_kind) plus blurb evidence -- never by parsing the
// title itself.
//
// Deliberately narrow. Only founding and discovery are handled:
//
//   founding + settlement   -> 'Founding of Granby'
//   founding + subnational  -> 'Arizona Statehood'      (blurb confirms a US state)
//   founding + subnational  -> 'Founding of Ontario'    (any other subnational)
//   founding + country      -> 'Founding of Belgium'
//   founding + NULL         -> 'Founding of X'
//   discovery               -> 'Discovery of Radium'
//
// NOT handled, on purpose:
//   - treaty / conflict / event / milestone / election titles are already
//     well-formed sentences ('Treaty of Versailles', 'Battle of the Somme').
//     Prefixing them yields 'Signing of Treaty of Versailles'.
//   - birth / death would benefit most, but are excluded by explicit decision.
//     Bare person names will still appear on timelines.
//   - seed rows (ingest_version LIKE 'seed-%') are hand-authored; never touched.
//
// display_title is NULLABLE and every consumer falls back to title, so a NULL
// simply means "no better phrasing available". The raw title is never modified:
// events_fts indexes it, and search has to keep matching what users type.
//
//   npm run titles -- --dry       preview counts + 20 before/after samples
//   npm run titles                apply
//   npm run titles -- --reset     clear every display_title
//   npm run titles -- --limit=500 cap rows processed (smoke test)

const args = process.argv.slice(2);
const hasFlag = (n: string) => args.includes(`--${n}`);
const flagValue = (n: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : undefined;
};

const dry = hasFlag('dry');
const reset = hasFlag('reset');
const limit = Math.max(0, parseInt(flagValue('limit') ?? '0', 10) || 0);

/**
 * Skip rows whose title already states the event. The audit found zero such rows
 * in founding or discovery, so this is belt-and-braces for future ingests rather
 * than a live concern -- but a second pass over a re-ingested DB must never
 * produce 'Founding of Founding of X'.
 */
const ALREADY_PHRASED =
  /\b(found|founded|founding|foundation|establish|established|establishment|incorporated|incorporation|charter|chartered|statehood|admission|admitted|creation|created|discover|discovered|discovery)\b/i;

/**
 * Statehood phrasing is used ONLY where the blurb affirmatively identifies a US
 * state. 'Founding of the State of Arizona' would be subtly wrong -- Arizona was
 * founded as a territory in 1863 and admitted to the Union in 1912, and this row
 * is the 1912 event. Provinces, territories, and other subnational entities fall
 * back to neutral 'Founding of' phrasing rather than being guessed at.
 */
const US_STATE_BLURB = /(state of the united states|u\.?s\.?\s+state|state in the united states|u\.?s\.?\s+federated state)/i;

const db = new Database('events.sqlite');
db.pragma('journal_mode = WAL');

// ---------- Column bootstrap ----------

const columns = db.prepare(`PRAGMA table_info(events)`).all() as Array<{ name: string }>;
if (!columns.some((c) => c.name === 'display_title')) {
  if (dry) {
    console.log('events.display_title does not exist yet; --dry will report what would be written.');
  } else {
    db.exec(`ALTER TABLE events ADD COLUMN display_title TEXT`);
    console.log('Added column events.display_title.');
  }
}
const columnExists = (db.prepare(`PRAGMA table_info(events)`).all() as Array<{ name: string }>)
  .some((c) => c.name === 'display_title');

if (reset) {
  if (!columnExists) {
    console.log('Nothing to reset: events.display_title does not exist.');
    db.close();
    process.exit(0);
  }
  const info = db.prepare(`UPDATE events SET display_title = NULL WHERE display_title IS NOT NULL`).run();
  console.log(`Cleared display_title on ${info.changes.toLocaleString()} rows.`);
  db.close();
  process.exit(0);
}

// ---------- Rule ----------

interface Row {
  id: string;
  title: string;
  blurb: string | null;
  category: string | null;
  founding_kind: string | null;
}

type RuleName = 'settlement' | 'statehood' | 'subnational' | 'country' | 'founding-unclassified' | 'discovery';

function displayTitleFor(row: Row): { title: string; rule: RuleName } | null {
  const name = row.title.trim();
  if (!name) return null;
  if (ALREADY_PHRASED.test(name)) return null;

  if (row.category === 'discovery') {
    return { title: `Discovery of ${name}`, rule: 'discovery' };
  }

  if (row.category === 'founding') {
    switch (row.founding_kind) {
      case 'settlement':
        return { title: `Founding of ${name}`, rule: 'settlement' };
      case 'subnational':
        return US_STATE_BLURB.test(row.blurb ?? '')
          ? { title: `${name} Statehood`, rule: 'statehood' }
          : { title: `Founding of ${name}`, rule: 'subnational' };
      case 'country':
        return { title: `Founding of ${name}`, rule: 'country' };
      default:
        return { title: `Founding of ${name}`, rule: 'founding-unclassified' };
    }
  }

  return null;
}

// ---------- Pass ----------

const rows = db.prepare(`
  SELECT id, title, blurb, category, founding_kind
  FROM events
  WHERE category IN ('founding', 'discovery')
    AND ingest_version NOT LIKE 'seed-%'
  ORDER BY id
  ${limit > 0 ? `LIMIT ${limit}` : ''}
`).all() as Row[];

const counts: Record<string, number> = {};
const samples: Array<{ rule: RuleName; before: string; after: string }> = [];
const updates: Array<{ id: string; display_title: string }> = [];
let skipped = 0;

for (const row of rows) {
  const result = displayTitleFor(row);
  if (!result) { skipped++; continue; }
  counts[result.rule] = (counts[result.rule] ?? 0) + 1;
  updates.push({ id: row.id, display_title: result.title });
  if (samples.length < 20 && !samples.some((s) => s.rule === result.rule && samples.filter((x) => x.rule === result.rule).length >= 4)) {
    samples.push({ rule: result.rule, before: row.title, after: result.title });
  }
}

console.log(`\nExamined ${rows.length.toLocaleString()} founding/discovery rows (seed rows excluded).\n`);
console.log('  RULE                     ROWS');
for (const [rule, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${rule.padEnd(23)}  ${String(n).padStart(6)}`);
}
console.log(`  ${'(skipped, already phrased)'.padEnd(23)}  ${String(skipped).padStart(6)}`);
console.log(`\n  TOTAL to write           ${String(updates.length).padStart(6)}`);

console.log('\nSamples:');
for (const s of samples) {
  console.log(`  [${s.rule}] ${s.before}  ->  ${s.after}`);
}

if (dry) {
  console.log('\nDRY RUN. Nothing written. Re-run without --dry to apply.');
  db.close();
  process.exit(0);
}

const upd = db.prepare(`UPDATE events SET display_title = @display_title WHERE id = @id`);
let written = 0;
const run = db.transaction((batch: typeof updates) => {
  for (const u of batch) written += upd.run(u).changes;
});
run(updates);

db.prepare(`INSERT INTO meta(key, value) VALUES('last_display_titles', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
  .run(`${written} rows at ${new Date().toISOString()}`);

console.log(`\nWrote display_title on ${written.toLocaleString()} rows.`);
console.log('events_fts is untouched: search still matches the raw Wikidata labels, which is intended.');
db.close();
