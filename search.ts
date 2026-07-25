import Database from 'better-sqlite3';

const term = process.argv.slice(2).join(' ').trim();
if (!term) {
  console.error('Usage: npx tsx search.ts <query>   (e.g. \"moon landing\")');
  process.exit(1);
}

const db = new Database('events.sqlite', { readonly: true });
const rows = db.prepare(`
  SELECT e.id, e.title, e.blurb, e.date_start, e.category, e.lat, e.lng, e.notability, e.source_url
  FROM events_fts f
  JOIN events e ON e.rowid = f.rowid
  WHERE events_fts MATCH ?
  ORDER BY e.notability DESC, e.date_start ASC
  LIMIT 25
`).all(term) as Array<Record<string, unknown>>;

if (rows.length === 0) {
  console.log(`No matches for \"${term}\".`);
} else {
  for (const r of rows) {
    console.log(`\u2022 ${r.date_start}  [${r.category}]  ${r.title}`);
    if (r.blurb) console.log(`    ${r.blurb}`);
    console.log(`    (${r.lat}, ${r.lng})  notability ${r.notability}  ${r.source_url}`);
  }
  console.log(`\n${rows.length} result(s).`);
}
db.close();
