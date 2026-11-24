'use strict';
// End-to-end check of Supabase persistence against the mock REST API:
// writes, undo, retry after outages, reload after restart, paging past
// 1000 rows, and flushing queued writes on shutdown.
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const { createMock } = require('./mock-postgrest');

const KEY = 'sb_secret_testkey_123';
const MOCK_PORT = 3891, APP_PORT = 3892;
const APP = `http://127.0.0.1:${APP_PORT}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function startApp() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(APP_PORT), HOST: '127.0.0.1', SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}/`, SUPABASE_SECRET_KEY: KEY },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  return { child, output: () => out };
}
async function waitUp() {
  await sleep(300); // never mistake a stale server for the new one
  for (let i = 0; i < 50; i++) { try { await fetch(APP + '/healthz'); return; } catch { await sleep(100); } }
  throw new Error('app did not start');
}
async function api(p, body) {
  const r = await fetch(APP + p, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
// the code Tower 1 should enter (falls back to the next free code before Tower 1 has one)
const t1 = (s) => (s.lanes && s.lanes['1'] && s.lanes['1'].code) || s.current;
const stop = (app) => new Promise(r => { app.child.on('exit', r); app.child.kill('SIGTERM'); });

let current = null;
process.on('exit', () => { if (current) try { current.child.kill('SIGKILL'); } catch {} });

(async () => {
  const mock = createMock({ key: KEY });
  await new Promise(r => mock.server.listen(MOCK_PORT, '127.0.0.1', r));

  // seed 2,500 old solves to prove paging past the 1000-row cap
  for (let i = 0; i < 2500; i++) {
    const id = 'seed' + String(i).padStart(5, '0');
    mock.tables.solves.set(id, { id, code: '123', map: '', unknown_count: 0, revealed: '123', wrong_before: 0, group_hash: 'h', round: 1, created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() });
  }

  let app = current = startApp(); await waitUp();
  let stats = await api('/api/stats');
  assert.strictEqual(stats.countAll, 2500, 'loads all pages');

  const g = await api('/api/groups', { length: 3 });
  let s = await api(`/api/groups/${g.id}/config`, { length: 3, known: [null, null, null], map: 'Ozeti' });
  s = await api(`/api/groups/${g.id}/wrong`, { guess: t1(s), lane: '1', by: 'C' });
  await sleep(1200);
  assert.ok(mock.tables.groups.has(g.id), 'group saved');
  assert.strictEqual(mock.tables.groups.get(g.id).data.attempts.length, 1);

  // correct -> solve row; undo -> row removed
  s = await api(`/api/groups/${g.id}/correct`, { guess: t1(s), lane: '1', by: 'C' });
  await sleep(1200);
  const mine = () => [...mock.tables.solves.values()].filter(r => !r.id.startsWith('seed'));
  assert.strictEqual(mine().length, 1, 'solve inserted');
  assert.strictEqual(mine()[0].map, 'Ozeti');
  assert.ok(!JSON.stringify(mine()[0]).includes(g.id), 'invite code never stored in solves');
  await api(`/api/groups/${g.id}/undo`, {});
  await sleep(1200);
  assert.strictEqual(mine().length, 0, 'undo deletes solve');

  // Supabase outage: next 4 requests fail; writes must retry and land in order
  mock.fail(4);
  s = await api(`/api/groups/${g.id}`);
  s = await api(`/api/groups/${g.id}/correct`, { guess: t1(s), lane: '1', by: 'C' });
  const solvedCode = t1(s);
  await sleep(1000);
  assert.strictEqual(mine().length, 0, 'not written during outage');
  await sleep(16000); // retries after 1s, 2s, 4s, 8s
  assert.strictEqual(mine().length, 1, 'written after outage');
  assert.ok(mock.tables.groups.get(g.id).data.solved, 'group state caught up');

  // restart: state reloads from Supabase
  await stop(app);
  app = current = startApp(); await waitUp();
  s = await api(`/api/groups/${g.id}`);
  assert.strictEqual(s.solved.guess, solvedCode, 'group restored after restart');
  assert.strictEqual(s.map, 'Ozeti');
  stats = await api('/api/stats');
  assert.strictEqual(stats.countAll, 2501, 'solves restored after restart');

  // shutdown flushes queued writes
  s = await api(`/api/groups/${g.id}/reset`, {});
  s = await api(`/api/groups/${g.id}/wrong`, { guess: t1(s), lane: '1', by: 'C' });
  await stop(app);
  assert.strictEqual(mock.tables.groups.get(g.id).data.attempts.length, 1, 'flushed on SIGTERM');

  // refuses to start when Supabase rejects the key
  const bad = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(APP_PORT), SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}`, SUPABASE_SECRET_KEY: 'sb_secret_wrong' }, stdio: 'ignore'
  });
  const code = await new Promise(r => bad.on('exit', r));
  assert.strictEqual(code, 1, 'exits when storage unavailable');

  mock.server.close();
  console.log('store integration tests passed');
})().catch(e => { console.error(e); process.exit(1); });
