import Database from 'better-sqlite3';

// ===================== Category pruner (post-ingest, no re-ingest) =====================
// Weeds out low-relevance rows from an over-represented category (e.g. the long
// tail of minor elections) WITHOUT rerunning the multi-hour Wikidata ingest.
// Review-first and non-destructive by default.
//
//   npm run prune                                  -> review 'election' (counts + notability buckets + sample)
//   npm run prune <category>                       -> review a different category
//   npm run prune <category> <minNotability>       -> DRY RUN: how many rows are below the floor
//   npm run prune <category> <minNotability> apply -> DELETE rows below the floor, then rebuild FTS
//
// Example: npm run prune election 0.3 apply

const category = (process.argv[2] ?? 'election').toLowerCase();
const minArg = process.argv[3];
const apply = (process.argv[4] ?? '').toLowerCase() === 'apply';
const minNotability = minArg !== undefined ? parseFloat(minArg) : null;

const db = new Database('events.sqlite');
db.pragma('journal_mode = WAL');

const total = (db.prepare(`SELECT COUNT(*) AS c FROM events WHERE category = ?`).get(category) as any).c as number;
if (total === 0) {
  console.log(`No rows found for category "${category}".`);
  db.close();
  process.exit(0);
}

console.log(`Category "${category}": ${total.toLocaleString()} rows.\n`);

// scope breakdown
const byScope = db.prepare(`SELECT COALESCE(scope,'(unscored)') AS s, COUNT(*) AS c FROM events WHERE category = ? GROUP BY s ORDER BY c DESC`).all(category) as Array<{ s: string; c: number }>;
console.log('By scope:');
for (const r of byScope) console.log(`  ${r.s.padEnd(12)} ${r.c.toLocaleString()}`);

// notability distribution (0.1-wide buckets)
const buckets = db.prepare(`
  SELECT bucket, COUNT(*) AS c FROM (
    SELECT CAST(MIN(0.99, MAX(0.0, notability)) * 10 AS INT) / 10.0 AS bucket
    FROM events WHERE category = ? AND notability IS NOT NULL
  ) GROUP BY bucket ORDER BY bucket
`).all(category) as Array<{ bucket: number; c: number }>;
console.log('\nNotability distribution (0.1-wide buckets):');
for (const b of buckets) {
  const bar = '#'.repeat(Math.max(1, Math.round((b.c / Math.max(1, total)) * 60)));
  console.log(`  ${b.bucket.toFixed(1)}  ${String(b.c).padStart(6)}  ${bar}`);
}

// cumulative removals at candidate floors
console.log('\nRows removed at candidate floors:');
for (const f of [0.15, 0.2, 0.25, 0.3, 0.35, 0.4]) {
  const c = (db.prepare(`SELECT COUNT(*) AS c FROM events WHERE category = ? AND notability < ?`).get(category, f) as any).c as number;
  console.log(`  < ${f.toFixed(2)}  removes ${String(c).padStart(6)}  (keeps ${(total - c).toLocaleString()})`);
}

if (minNotability === null || Number.isNaN(minNotability)) {
  console.log(`\nReview only. To prune, pass a floor (dry run):  npm run prune ${category} 0.3`);
  console.log(`Then apply it with:                            npm run prune ${category} 0.3 apply`);
  db.close();
  process.exit(0);
}

const doomed = (db.prepare(`SELECT COUNT(*) AS c FROM events WHERE category = ? AND notability < ?`).get(category, minNotability) as any).c as number;
console.log(`\nFloor ${minNotability}: ${doomed.toLocaleString()} of ${total.toLocaleString()} "${category}" rows are below it.`);

const sample = db.prepare(`SELECT title, date_start, notability FROM events WHERE category = ? AND notability < ? ORDER BY notability ASC, date_start ASC LIMIT 25`).all(category, minNotability) as Array<{ title: string; date_start: string; notability: number }>;
console.log('\nLeast-notable rows that would be removed (sample of 25):');
for (const r of sample) console.log(`  ${String(r.notability).padStart(5)}  ${String(r.date_start).slice(0, 4)}  ${r.title}`);

if (!apply) {
  console.log(`\nDRY RUN. Nothing deleted. Re-run with "apply" to delete these ${doomed.toLocaleString()} rows:`);
  console.log(`  npm run prune ${category} ${minNotability} apply`);
  db.close();
  process.exit(0);
}

const info = db.prepare(`DELETE FROM events WHERE category = ? AND notability < ?`).run(category, minNotability);
db.exec(`INSERT INTO events_fts(events_fts) VALUES('rebuild');`);
db.prepare(`INSERT INTO meta(key, value) VALUES('last_prune', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(`${category}<${minNotability} removed ${info.changes} at ${new Date().toISOString()}`);
console.log(`\nDeleted ${info.changes} "${category}" rows below ${minNotability}. Rebuilt FTS.`);
console.log('Tip: re-run "npm run score" to refresh era-normalized significance without the pruned rows.');
db.close();
