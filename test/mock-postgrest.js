'use strict';
// Minimal in-memory stand-in for Supabase's REST API (PostgREST), covering
// only the requests lib/store.js makes. Used by test/store.integration.js.
const http = require('http');

function createMock({ key }) {
  const tables = { groups: new Map(), solves: new Map() };
  const log = [];
  let failNext = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const send = (code, data, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(data === undefined ? '' : JSON.stringify(data)); };
      // auth rules that match Supabase's new secret keys
      if (req.headers.apikey !== key) return send(401, { message: 'bad apikey' });
      if (key.startsWith('sb_') && req.headers.authorization) return send(401, { message: 'secret key must not be sent as a Bearer token' });
      if (failNext > 0) { failNext--; return send(503, { message: 'injected failure' }); }

      const m = url.pathname.match(/^\/rest\/v1\/(groups|solves)$/);
      if (!m) return send(404, { message: 'no route' });
      const t = tables[m[1]];
      log.push(`${req.method} ${m[1]}`);
      const prefer = req.headers.prefer || '';

      if (req.method === 'GET') {
        let rows = [...t.values()];
        const gte = url.searchParams.get('updated_at');
        if (gte && gte.startsWith('gte.')) rows = rows.filter(r => r.updated_at >= gte.slice(4));
        if (m[1] === 'solves') rows.sort((a, b) => a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : (a.id < b.id ? -1 : 1));
        else rows.sort((a, b) => a.id < b.id ? -1 : 1);
        const sel = url.searchParams.get('select');
        if (sel === 'data') rows = rows.map(r => ({ data: r.data }));
        const range = (req.headers.range || '0-999').split('-').map(Number);
        const cap = Math.min(range[1], range[0] + 999); // server-side 1000-row cap
        return send(200, rows.slice(range[0], cap + 1));
      }
      if (req.method === 'POST') {
        const rows = [].concat(JSON.parse(body));
        for (const r of rows) {
          if (t.has(r.id)) {
            if (prefer.includes('ignore-duplicates')) continue;
            if (!prefer.includes('merge-duplicates')) return send(409, { message: 'duplicate key' });
          }
          t.set(r.id, { ...r });
        }
        return send(201);
      }
      if (req.method === 'DELETE') {
        const eq = url.searchParams.get('id') || '';
        if (eq.startsWith('eq.')) t.delete(decodeURIComponent(eq.slice(3)));
        else if (eq.startsWith('in.(')) for (const id of eq.slice(4, -1).split(',')) t.delete(decodeURIComponent(id));
        return send(204);
      }
      send(405, { message: 'method' });
    });
  });
  return { server, tables, log, fail(n) { failNext = n; } };
}

module.exports = { createMock };
