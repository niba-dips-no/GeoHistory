import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { getTimeline, renderMarkdown, type TimelineInput } from './core';

// ===================== geohistory JSON API (v0.6) =====================
// A thin, dependency-free HTTP wrapper (Node built-in http) around the
// deterministic timeline engine (core.ts) and full-text search, reading the
// local events.sqlite strictly read-only. The same static file can back this
// server or a browser applet.
//   npm run serve            # http://localhost:8787  (override with PORT)

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.GEOHISTORY_DB ?? join(__dirname, 'events.sqlite');
const PORT = parseInt(process.env.PORT ?? '8787', 10);

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
db.pragma('query_only = ON');

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
  res.end(JSON.stringify(payload, null, 2));
}
function sendText(res: http.ServerResponse, status: number, text: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': type, ...CORS });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) { req.destroy(); reject(new Error('Request body too large.')); return; }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function validateInput(body: any): TimelineInput {
  if (!body || typeof body !== 'object') throw new Error('Body must be a JSON object.');
  if (!Array.isArray(body.segments) || body.segments.length === 0) {
    throw new Error('segments must be a non-empty array.');
  }
  body.segments.forEach((seg: any, i: number) => {
    if (!seg || typeof seg !== 'object') throw new Error(`segments[${i}] must be an object.`);
    const p = seg.place;
    if (!p || typeof p !== 'object') throw new Error(`segments[${i}].place is required.`);
    if (typeof p.lat !== 'number' || !isFinite(p.lat) || typeof p.lng !== 'number' || !isFinite(p.lng)) {
      throw new Error(`segments[${i}].place.lat and .lng must be finite numbers.`);
    }
    if (typeof seg.start !== 'string' || !seg.start.trim()) {
      throw new Error(`segments[${i}].start must be a non-empty date string.`);
    }
    if (seg.end != null && typeof seg.end !== 'string') {
      throw new Error(`segments[${i}].end must be a string when provided.`);
    }
  });
  if (body.person != null && typeof body.person !== 'string') throw new Error('person must be a string.');
  if (body.config != null && typeof body.config !== 'object') throw new Error('config must be an object.');
  return body as TimelineInput;
}

const searchStmt = db.prepare(`
  SELECT e.id, e.title, e.blurb, e.date_start, e.date_precision, e.category,
         e.lat, e.lng, e.scope, e.significance, e.notability, e.source_url
  FROM events_fts f
  JOIN events e ON e.rowid = f.rowid
  WHERE events_fts MATCH ?
  ORDER BY e.notability DESC, e.date_start ASC
  LIMIT ?
`);

function datasetMeta(): Record<string, unknown> {
  const meta: Record<string, string> = {};
  try {
    for (const r of db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>) {
      meta[r.key] = r.value;
    }
  } catch { /* meta table may be absent on old DBs */ }
  const total = (db.prepare('SELECT COUNT(*) AS c FROM events').get() as any).c as number;
  return { totalEvents: total, ...meta };
}

const ROOT_DOC = {
  service: 'geohistory-api',
  version: '0.6.0',
  endpoints: {
    'GET /health': 'liveness check',
    'GET /meta': 'dataset provenance + event count',
    'GET /search?q=<term>&limit=<n>': 'full-text search (default 25, max 100)',
    'POST /timeline': 'body = TimelineInput JSON -> Timeline JSON; add ?format=markdown for Markdown',
  },
  exampleTimelineRequest: {
    person: 'Ada Example',
    segments: [
      { label: 'Childhood', place: { name: 'Chicago', lat: 41.8819, lng: -87.6278 }, start: '1939', end: '1945' },
    ],
  },
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    let path = url.pathname;
    while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

    if (req.method === 'GET' && path === '/') return sendJson(res, 200, ROOT_DOC);
    if (req.method === 'GET' && path === '/health') return sendJson(res, 200, { ok: true });
    if (req.method === 'GET' && path === '/meta') return sendJson(res, 200, datasetMeta());

    if (req.method === 'GET' && path === '/search') {
      const q = (url.searchParams.get('q') ?? '').trim();
      if (!q) return sendJson(res, 400, { error: 'Missing ?q= search term.' });
      let limit = parseInt(url.searchParams.get('limit') ?? '25', 10);
      if (!Number.isFinite(limit) || limit < 1) limit = 25;
      limit = Math.min(limit, 100);
      try {
        const results = searchStmt.all(q, limit);
        return sendJson(res, 200, { query: q, count: results.length, results });
      } catch (e: any) {
        return sendJson(res, 400, { error: `Invalid search query: ${e?.message ?? e}` });
      }
    }

    if (req.method === 'POST' && path === '/timeline') {
      const raw = await readBody(req);
      let parsed: any;
      try { parsed = JSON.parse(raw || '{}'); }
      catch { return sendJson(res, 400, { error: 'Request body is not valid JSON.' }); }

      let input: TimelineInput;
      try { input = validateInput(parsed); }
      catch (e: any) { return sendJson(res, 400, { error: e?.message ?? 'Invalid input.' }); }

      let result;
      try { result = getTimeline(db, input); }
      catch (e: any) { return sendJson(res, 400, { error: `Could not build timeline: ${e?.message ?? e}` }); }

      const wantsMd = url.searchParams.get('format') === 'markdown' || (req.headers.accept ?? '').includes('text/markdown');
      if (wantsMd) return sendText(res, 200, renderMarkdown(result), 'text/markdown; charset=utf-8');
      return sendJson(res, 200, result);
    }

    return sendJson(res, 404, { error: `Not found: ${req.method} ${path}`, see: 'GET /' });
  } catch (e: any) {
    return sendJson(res, 500, { error: e?.message ?? 'Internal server error.' });
  }
});

server.listen(PORT, () => {
  const m = datasetMeta();
  console.log(`geohistory-api listening on http://localhost:${PORT}`);
  console.log(`  dataset ${m.dataset_version ?? 'unknown'} - ${Number(m.totalEvents).toLocaleString()} events`);
  console.log(`  docs:   curl http://localhost:${PORT}/`);
});
