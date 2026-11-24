'use strict';

// Persistence for groups and the correct-code log.
//
// - SupabaseStore: used when SUPABASE_URL and SUPABASE_SECRET_KEY are set.
//   Talks to Supabase's REST API (PostgREST) with Node's built-in fetch, so
//   there are still no npm dependencies. Writes are queued and retried, so a
//   brief Supabase outage never loses a click or crashes the app.
// - FileStore: JSON files on local disk, for running on your own machine.
//
// The app keeps all live state in memory; the store only saves and reloads it.

const fs = require('fs');
const path = require('path');

// ---------- shared shape conversion ----------
function solveToRow(s) {
  return {
    id: s.id, code: s.code, map: s.map || '', unknown_count: s.unknownCount,
    revealed: s.revealed, wrong_before: s.wrongBefore, group_hash: s.group,
    round: s.round, created_at: new Date(s.at).toISOString()
  };
}
function rowToSolve(r) {
  return {
    id: r.id, code: r.code, map: r.map, unknownCount: r.unknown_count,
    revealed: r.revealed, wrongBefore: r.wrong_before, group: r.group_hash,
    round: r.round, at: Date.parse(r.created_at)
  };
}

// ---------- file store ----------
class FileStore {
  constructor(dir) {
    this.kind = 'file';
    this.dir = dir;
    this.groupsFile = path.join(dir, 'groups.json');
    this.solvesFile = path.join(dir, 'solves.json');
    this.timer = null;
    this.snapshot = null; // () => ({ groups: [...], solves: [...] })
  }
  async init(cutoffMs) {
    const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') console.error('Could not read', f, e.message); return []; } };
    return { groups: read(this.groupsFile).filter(g => g.updatedAt >= cutoffMs), solves: read(this.solvesFile) };
  }
  bind(snapshot) { this.snapshot = snapshot; }
  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.writeNow(); }, 1000);
  }
  writeNow() {
    if (!this.snapshot) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const { groups, solves } = this.snapshot();
      for (const [file, data] of [[this.groupsFile, groups], [this.solvesFile, solves]]) {
        fs.writeFileSync(file + '.tmp', JSON.stringify(data));
        fs.renameSync(file + '.tmp', file); // atomic replace
      }
    } catch (e) { console.error('Save failed:', e.message); }
  }
  markGroup() { this.schedule(); }
  deleteGroups() { this.schedule(); }
  addSolve() { this.schedule(); }
  removeSolve() { this.schedule(); }
  async flush() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } this.writeNow(); }
}

// ---------- Supabase store ----------
class SupabaseStore {
  constructor(url, key) {
    this.kind = 'supabase';
    this.base = url.replace(/\/+$/, '') + '/rest/v1';
    this.headers = { apikey: key, 'Content-Type': 'application/json' };
    // Legacy service_role keys are JWTs and also need the Authorization header.
    // New sb_secret_ keys are not JWTs and must only go in the apikey header.
    if (!key.startsWith('sb_')) this.headers.Authorization = 'Bearer ' + key;
    this.groupsById = null;   // () => Map of live groups
    this.dirty = new Set();   // group ids waiting to be upserted
    this.ops = [];            // ordered queue: solve inserts/deletes, group deletes
    this.running = false;
    this.backoff = 0;
    this.timer = null;
  }

  async req(method, pathQuery, body, extraHeaders = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(this.base + pathQuery, {
        method, headers: { ...this.headers, ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Supabase ${method} ${pathQuery.split('?')[0]} -> ${res.status} ${text.slice(0, 200)}`);
      }
      return res;
    } finally { clearTimeout(t); }
  }

  // Supabase caps each response (1000 rows by default), so page through.
  async getAll(table, query) {
    const out = [];
    const page = 1000;
    for (let from = 0; ; from += page) {
      const res = await this.req('GET', `/${table}?${query}`, undefined, { Range: `${from}-${from + page - 1}`, 'Range-Unit': 'items' });
      const rows = await res.json();
      out.push(...rows);
      if (rows.length < page) break;
    }
    return out;
  }

  async init(cutoffMs) {
    const since = encodeURIComponent(new Date(cutoffMs).toISOString());
    let lastErr;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const groupRows = await this.getAll('groups', `select=data&updated_at=gte.${since}&order=id`);
        const solveRows = await this.getAll('solves', 'select=*&order=created_at.asc,id.asc');
        return { groups: groupRows.map(r => r.data), solves: solveRows.map(rowToSolve) };
      } catch (e) {
        lastErr = e;
        console.error(`Supabase load attempt ${attempt} failed: ${e.message}`);
        await new Promise(r => setTimeout(r, attempt * 2000));
      }
    }
    // Refuse to start rather than run without the saved data.
    throw lastErr;
  }

  bind(_snapshot, groupsById) { this.groupsById = groupsById; }

  kick() {
    if (this.timer || this.running) return;
    this.timer = setTimeout(() => { this.timer = null; this.drain(); }, this.backoff || 500);
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      // 1. ordered operations
      while (this.ops.length) {
        await this.runOp(this.ops[0]);
        this.ops.shift();
      }
      // 2. latest state of every changed group, in one request
      if (this.dirty.size) {
        const ids = [...this.dirty];
        this.dirty.clear();
        const live = this.groupsById();
        const rows = ids.map(id => live.get(id)).filter(Boolean)
          .map(g => ({ id: g.id, data: g, updated_at: new Date(g.updatedAt).toISOString() }));
        try {
          if (rows.length) await this.req('POST', '/groups?on_conflict=id', rows, { Prefer: 'resolution=merge-duplicates,return=minimal' });
        } catch (e) { for (const id of ids) this.dirty.add(id); throw e; }
      }
      this.backoff = 0;
    } catch (e) {
      this.backoff = Math.min(30_000, (this.backoff || 500) * 2); // 1s, 2s, 4s ... 30s
      console.error(`Supabase write failed, retrying in ${this.backoff / 1000}s: ${e.message}`);
    } finally {
      this.running = false;
      if (this.ops.length || this.dirty.size) this.kick();
    }
  }

  async runOp(op) {
    if (op.type === 'insertSolve') {
      // ignore-duplicates makes a retry after a timeout safe
      await this.req('POST', '/solves?on_conflict=id', solveToRow(op.solve), { Prefer: 'resolution=ignore-duplicates,return=minimal' });
    } else if (op.type === 'deleteSolve') {
      await this.req('DELETE', `/solves?id=eq.${encodeURIComponent(op.id)}`, undefined, { Prefer: 'return=minimal' });
    } else if (op.type === 'deleteGroups') {
      await this.req('DELETE', `/groups?id=in.(${op.ids.map(encodeURIComponent).join(',')})`, undefined, { Prefer: 'return=minimal' });
    }
  }

  markGroup(g) { this.dirty.add(g.id); this.kick(); }
  deleteGroups(ids) {
    if (!ids.length) return;
    for (const id of ids) this.dirty.delete(id);
    for (let i = 0; i < ids.length; i += 100) this.ops.push({ type: 'deleteGroups', ids: ids.slice(i, i + 100) });
    this.kick();
  }
  addSolve(s) { this.ops.push({ type: 'insertSolve', solve: s }); this.kick(); }
  removeSolve(id) { this.ops.push({ type: 'deleteSolve', id }); this.kick(); }

  // Called on shutdown: try hard to write everything still queued.
  async flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const deadline = Date.now() + 8000;
    while ((this.ops.length || this.dirty.size || this.running) && Date.now() < deadline) {
      if (!this.running) await this.drain();
      else await new Promise(r => setTimeout(r, 100));
    }
  }
}

function createStore({ dataDir, supabaseUrl, supabaseKey }) {
  if (supabaseUrl && supabaseKey) return new SupabaseStore(supabaseUrl, supabaseKey);
  if (supabaseUrl || supabaseKey) throw new Error('Set both SUPABASE_URL and SUPABASE_SECRET_KEY, or neither.');
  return new FileStore(dataDir);
}

module.exports = { createStore, solveToRow, rowToSolve };
