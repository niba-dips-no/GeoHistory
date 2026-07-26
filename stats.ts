import Database from 'better-sqlite3';

// Read-only diagnostic: prints dataset composition so you can sanity-check a
// build (counts by category / precision / scope, year span, sample
// year-precision events, and provenance from the meta table).
//   npm run stats

const db = new Database('events.sqlite', { readonly: true });
const rows = (sql: string): any[] => db.prepare(sql).all();
const pad = (v: unknown, n: number) => String(v).padEnd(n);
const num = (n: number) => n.toLocaleString();

console.log('=== GeoHistory dataset stats ===');

const total = (db.prepare('SELECT COUNT(*) AS c FROM events').get() as any).c as number;
console.log(`Total events: ${num(total)}`);

console.log('\nBy category:');
for (const r of rows(`SELECT COALESCE(category,'(null)') AS k, COUNT(*) AS c FROM events GROUP BY k ORDER BY c DESC`)) {
  console.log(`  ${pad(r.k, 12)} ${num(r.c)}`);
}

console.log('\nBy date precision:');
for (const r of rows(`SELECT COALESCE(date_precision,'(null)') AS k, COUNT(*) AS c FROM events GROUP BY k ORDER BY c DESC`)) {
  console.log(`  ${pad(r.k, 10)} ${num(r.c)}`);
}

console.log('\nBy scope:');
for (const r of rows(`SELECT COALESCE(scope,'(unscored)') AS k, COUNT(*) AS c FROM events GROUP BY k ORDER BY c DESC`)) {
  console.log(`  ${pad(r.k, 10)} ${num(r.c)}`);
}

const span = db.prepare(`SELECT MIN(substr(date_start,1,4)) AS lo, MAX(substr(date_start,1,4)) AS hi FROM events`).get() as any;
console.log(`\nYear range: ${span.lo} - ${span.hi}`);

console.log('\nSample YEAR-precision events (proves precision capture):');
const yearSamples = rows(`SELECT title, date_start, date_precision FROM events WHERE date_precision = 'year' ORDER BY notability DESC LIMIT 10`);
if (yearSamples.length === 0) {
  console.log('  (none found - either no year-precision events yet, or precision is not being captured)');
} else {
  for (const r of yearSamples) console.log(`  ${r.date_start}  [${r.date_precision}]  ${r.title}`);
}

console.log('\nMeta:');
for (const r of rows(`SELECT key, value FROM meta ORDER BY key`)) {
  console.log(`  ${r.key} = ${r.value}`);
}

db.close();
