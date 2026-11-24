'use strict';

// Code Breaker group coordinator for WARDOGS Drill Tower guessing.
// Zero dependencies: Node's built-in http server, Server-Sent Events for
// live updates, and a JSON file for persistence across restarts.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildSequence, matchesPattern } = require('./lib/sequence');
const { computeStats, toCsv } = require('./lib/stats');
const { createStore } = require('./lib/store');

// ---------- configuration (environment variables) ----------
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || '';   // server-only, never sent to browsers
const MAX_SOLVES = 200000;
const MAPS = ['', 'Bakurani', 'Ozeti', 'Sabatulo', 'Other'];
const TRUST_PROXY = process.env.TRUST_PROXY === '1';        // set to 1 behind Render/Fly/nginx
const GROUP_TTL_HOURS = parseFloat(process.env.GROUP_TTL_HOURS || '48');
const MAX_GROUPS = parseInt(process.env.MAX_GROUPS || '5000', 10);
const MAX_STREAMS_PER_GROUP = 50;
const MAX_STREAMS_TOTAL = 2000;
const HISTORY_SENT = 50;           // newest attempts sent to browsers
const MIN_LEN = 3, MAX_LEN = 5;
// Guessing is blocked above this many unknown digits: 4 unknown = 10,000
// combinations, 5 = 100,000, far beyond what a group can try before the
// code changes. Capturing towers until exactly 3 are unknown is the plan.
const MAX_UNKNOWN_TO_GUESS = 3;
// Keypad lockouts are per tower and hit everyone at that tower, so each tower
// gets its own code and a squad spread across towers guesses in parallel.
const TOWERS = ['1', '2', '3', '4', '5', '6', '7'];
const LANE_STALE_MS = 15 * 60_000;   // an idle tower's code is freed after this
// The game locks a tower's keypad for about 30 seconds after 3 wrong codes.
const LOCKOUT_AFTER = 3, LOCKOUT_MS = 30_000;
const SOURCES = ['tower', 'told'];   // where a known digit came from

// ---------- invite codes ----------
// 31 unambiguous characters (no 0/O, 1/I/L) x 8 = ~39.6 bits of entropy.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newInviteCode() {
  let c = '';
  for (let i = 0; i < 8; i++) c += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return c;
}
function normalizeCode(raw) {
  if (typeof raw !== 'string') return null;
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length !== 8) return null;
  for (const ch of c) if (!ALPHABET.includes(ch)) return null;
  return c;
}

// ---------- state ----------
const groups = new Map();      // inviteCode -> group
const streams = new Map();     // inviteCode -> Set<res>
const seqCache = new Map();    // inviteCode -> { key, seq }
let totalStreams = 0;
let solves = [];               // correct codes, kept after groups expire

const store = createStore({ dataDir: DATA_DIR, supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_SECRET_KEY });
store.bind(() => ({ groups: [...groups.values()], solves }), () => groups);

async function load() {
  const cutoff = Date.now() - GROUP_TTL_HOURS * 3600_000;
  const data = await store.init(cutoff);
  for (const g of data.groups) { if (!g.seed) g.seed = newSeed(); groups.set(g.id, g); }
  solves = data.solves;
  console.log(`Storage: ${store.kind}. Loaded ${groups.size} group(s) and ${solves.length} correct code(s).`);
}

function blankPattern(len) { return Array(len).fill(null); }

function newSeed() { return crypto.randomBytes(16).toString('hex'); }

function getSequence(g) {
  const key = g.seed + JSON.stringify(g.known);
  const hit = seqCache.get(g.id);
  if (hit && hit.key === key) return hit.seq;
  const seq = buildSequence(g.known, g.seed);
  seqCache.set(g.id, { key, seq });
  return seq;
}

function laneOf(body) { return TOWERS.includes(String(body.lane)) ? String(body.lane) : '1'; }

function triedSet(g) { return new Set(g.attempts.filter(a => a.result === 'wrong').map(a => a.guess)); }

function guessingBlocked(g) {
  return !!g.solved || getSequence(g).unknownCount > MAX_UNKNOWN_TO_GUESS;
}

// A tower's code is valid while it is recent, untried and fits the setup.
function laneValid(g, lane, tried) {
  const a = g.lanes && g.lanes[lane];
  return !!a && Date.now() - a.at < LANE_STALE_MS && !tried.has(a.code) && matchesPattern(a.code, g.known);
}

// Next code for a tower: first in the shuffled order that nobody has tried
// and no other active tower is holding.
function nextCodeFor(g, lane, tried = triedSet(g)) {
  const held = new Set();
  for (const t of Object.keys(g.lanes || {})) if (t !== lane && laneValid(g, t, tried)) held.add(g.lanes[t].code);
  const seq = getSequence(g);
  for (const c of seq.noRepeat) if (!tried.has(c) && !held.has(c)) return c;
  for (const c of seq.withRepeat) if (!tried.has(c) && !held.has(c)) return c;
  return null;
}

function assignLane(g, lane, by) {
  if (!g.lanes) g.lanes = {};
  const code = guessingBlocked(g) ? null : nextCodeFor(g, lane);
  if (code) g.lanes[lane] = { code, at: Date.now(), by };
  else delete g.lanes[lane];
}

// The code a tower should be entering right now.
function expectedCode(g, lane) {
  const tried = triedSet(g);
  return laneValid(g, lane, tried) ? g.lanes[lane].code : nextCodeFor(g, lane, tried);
}

// Known digits come from capturing a tower ('tower') or from another team
// telling you ('told'). Only tower captures reveal digits to your faction in
// game, so told digits still count toward the 3 guessed digits.
function sourcesOf(g) {
  return g.known.map((d, i) => d === null ? null : (g.sources && SOURCES.includes(g.sources[i]) ? g.sources[i] : 'tower'));
}

// Per tower: wrong codes since its last lockout, and when the lockout ends.
function towerStatus(g) {
  const out = {};
  for (const a of g.attempts) {
    if (a.result !== 'wrong' || !a.tower) continue;
    const t = out[a.tower] || (out[a.tower] = { sinceLock: 0, lockedUntil: 0 });
    if (a.at < t.lockedUntil) continue; // can't happen in game; ignore late clicks
    t.sinceLock++;
    if (t.sinceLock >= LOCKOUT_AFTER) { t.lockedUntil = a.at + LOCKOUT_MS; t.sinceLock = 0; }
  }
  return out;
}

function recordSolve(g, entry, v) {
  // Record for pattern analysis. No names, and the group is stored only
  // as a one-way hash so the public data never exposes invite codes.
  entry.solveId = crypto.randomBytes(6).toString('hex');
  const solve = {
    id: entry.solveId,
    code: entry.guess,
    map: g.map || '',
    unknownCount: v.unknownCount,
    revealed: g.known.map(d => d === null ? 'x' : String(d)).join(''),
    wrongBefore: v.attemptsMatchingSetup,
    group: crypto.createHash('sha256').update('cb:' + g.id).digest('hex').slice(0, 10),
    round: g.round,
    at: entry.at
  };
  solves.push(solve);
  store.addSolve(solve);
  if (solves.length > MAX_SOLVES) solves.splice(0, solves.length - MAX_SOLVES);
  g.solved = entry;
}

function view(g) {
  const seq = getSequence(g);
  const tried = new Set(g.attempts.filter(a => a.result === 'wrong').map(a => a.guess));
  let current = null, phase = 'exhausted';
  let remNoRepeat = 0, remRepeat = 0;
  for (const c of seq.noRepeat) if (!tried.has(c)) { remNoRepeat++; if (!current) { current = c; phase = 'no-repeat'; } }
  for (const c of seq.withRepeat) if (!tried.has(c)) { remRepeat++; if (!current) { current = c; phase = 'repeat'; } }
  if (g.solved) { phase = 'solved'; current = g.solved.guess; }
  else if (seq.unknownCount > MAX_UNKNOWN_TO_GUESS) { phase = 'too-many'; current = null; }

  if (phase === 'no-repeat' || phase === 'repeat') current = nextCodeFor(g, null, tried) || current;
  const lanes = {};
  if (phase === 'no-repeat' || phase === 'repeat') {
    for (const t of Object.keys(g.lanes || {})) if (laneValid(g, t, tried)) lanes[t] = g.lanes[t];
  }

  const wrongCount = g.attempts.filter(a => a.result === 'wrong').length;
  const relevantWrong = g.attempts.filter(a => a.result === 'wrong' && matchesPattern(a.guess, g.known)).length;
  return {
    id: g.id,
    round: g.round,
    length: g.known.length,
    known: g.known,
    map: g.map || '',
    unknownCount: seq.unknownCount,
    sources: sourcesOf(g),
    toldCount: sourcesOf(g).filter(x => x === 'told').length,
    guessedCount: seq.unknownCount + sourcesOf(g).filter(x => x === 'told').length,
    eligible: seq.unknownCount + sourcesOf(g).filter(x => x === 'told').length >= 3,
    towers: towerStatus(g),
    lockout: { after: LOCKOUT_AFTER, ms: LOCKOUT_MS },
    serverNow: Date.now(),
    maxUnknownToGuess: MAX_UNKNOWN_TO_GUESS,
    current,
    phase,
    lanes,
    totalCombos: seq.noRepeat.length + seq.withRepeat.length,
    remainingNoRepeat: remNoRepeat,
    remainingRepeat: remRepeat,
    remainingTotal: remNoRepeat + remRepeat,
    attemptsMade: wrongCount,
    attemptsMatchingSetup: relevantWrong,
    attempts: g.attempts.slice(-HISTORY_SENT).reverse().map(a => ({
      ...a, stale: !matchesPattern(a.guess, g.known)
    })),
    solved: g.solved,
    viewers: (streams.get(g.id) || new Set()).size,
    updatedAt: g.updatedAt
  };
}

function broadcast(g) {
  const set = streams.get(g.id);
  if (!set) return;
  const payload = `data: ${JSON.stringify(view(g))}\n\n`;
  for (const res of set) res.write(payload);
}
function touch(g) { g.updatedAt = Date.now(); store.markGroup(g); broadcast(g); }

// ---------- rate limiting (fixed window per IP) ----------
const buckets = new Map();
const LIMITS = {
  create: { max: 10, windowMs: 10 * 60_000 },
  badLookup: { max: 30, windowMs: 10 * 60_000 },
  write: { max: 240, windowMs: 60_000 }
};
function hit(ip, kind, peekOnly = false) {
  const k = kind + '|' + ip;
  const now = Date.now();
  let b = buckets.get(k);
  if (!b || now - b.start > LIMITS[kind].windowMs) { b = { start: now, n: 0 }; buckets.set(k, b); }
  if (!peekOnly) b.n++;
  return b.n <= LIMITS[kind].max;
}
function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

// ---------- helpers ----------
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',   // keeps invite codes in URLs from leaking
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};
function send(res, status, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra });
  res.end(JSON.stringify(body));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 2048) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}
function cleanName(v) {
  if (typeof v !== 'string') return 'Someone';
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
  return s || 'Someone';
}
function validLength(n) { return Number.isInteger(n) && n >= MIN_LEN && n <= MAX_LEN; }
function validKnown(arr, len) {
  return Array.isArray(arr) && arr.length === len &&
    arr.every(d => d === null || (Number.isInteger(d) && d >= 0 && d <= 9));
}

// ---------- static files ----------
const PUBLIC = path.join(__dirname, 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/stats': ['stats.html', 'text/html; charset=utf-8'],
  '/stats.js': ['stats.js', 'text/javascript; charset=utf-8']
};
function serveStatic(req, res, pathname) {
  const entry = STATIC[pathname] || (pathname.startsWith('/g/') ? STATIC['/'] : null);
  if (!entry) return false;
  fs.readFile(path.join(PUBLIC, entry[0]), (err, buf) => {
    if (err) { res.writeHead(500); res.end(); return; }
    res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
    res.end(buf);
  });
  return true;
}

// ---------- API ----------
async function handleApi(req, res, parts, ip) {
  // POST /api/groups  -> create
  if (parts.length === 2 && req.method === 'POST') {
    if (!hit(ip, 'create')) return send(res, 429, { error: 'Too many groups created. Try again later.' });
    if (groups.size >= MAX_GROUPS) return send(res, 503, { error: 'Server is full. Try again later.' });
    const body = await readJson(req);
    const len = validLength(body.length) ? body.length : 4;
    let id; do { id = newInviteCode(); } while (groups.has(id));
    const g = { id, round: 1, seed: newSeed(), known: blankPattern(len), attempts: [], solved: null, createdAt: Date.now(), updatedAt: Date.now() };
    groups.set(id, g); store.markGroup(g);
    return send(res, 201, view(g));
  }

  // all other routes: /api/groups/:code[/action]
  if (!hit(ip, 'badLookup', true)) return send(res, 429, { error: 'Too many invalid invite codes. Wait a few minutes.' });
  const id = normalizeCode(parts[2]);
  const g = id && groups.get(id);
  if (!g) { hit(ip, 'badLookup'); return send(res, 404, { error: 'No group with that invite code.' }); }
  const action = parts[3] || '';

  if (req.method === 'GET' && action === '') return send(res, 200, view(g));

  if (req.method === 'GET' && action === 'events') {
    const set = streams.get(id) || new Set();
    if (set.size >= MAX_STREAMS_PER_GROUP || totalStreams >= MAX_STREAMS_TOTAL) return send(res, 503, { error: 'Too many viewers.' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SECURITY_HEADERS });
    res.write('retry: 3000\n\n');
    set.add(res); streams.set(id, set); totalStreams++;
    broadcast(g); // send state to everyone (updates viewer count)
    req.on('close', () => {
      set.delete(res); totalStreams--;
      if (!set.size) streams.delete(id); else broadcast(g);
    });
    return;
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  if (!hit(ip, 'write')) return send(res, 429, { error: 'Slow down.' });
  const body = await readJson(req);

  switch (action) {
    case 'config': {
      if (!validLength(body.length) || !validKnown(body.known, body.length))
        return send(res, 400, { error: 'Code length must be 3-5 and each known digit 0-9 or blank.' });
      if (body.map !== undefined && !MAPS.includes(body.map))
        return send(res, 400, { error: 'Unknown map.' });
      if (body.sources !== undefined && !(Array.isArray(body.sources) && body.sources.length === body.length &&
          body.sources.every((x, i) => body.known[i] === null ? x === null : SOURCES.includes(x))))
        return send(res, 400, { error: 'Each known digit must be marked as from a tower or told by another team.' });
      g.known = body.known.slice();
      g.sources = body.sources ? body.sources.slice() : g.known.map(d => d === null ? null : 'tower');
      if (body.map !== undefined) g.map = body.map;
      g.lanes = {}; // every tower re-claims a code that fits the new setup
      touch(g); return send(res, 200, view(g));
    }
    case 'wrong':
    case 'correct': {
      if (g.solved) return send(res, 409, { error: 'Already solved. Start a fresh attempt to continue.', state: view(g) });
      const v = view(g);
      // Guard against double clicks / two people clicking at once:
      // the click only counts if it refers to the code currently on screen.
      if (v.phase === 'too-many')
        return send(res, 409, { error: `Too many unknown digits to guess. Capture ${v.unknownCount - MAX_UNKNOWN_TO_GUESS} more tower(s) first.`, state: v });
      const lane = laneOf(body);
      const expected = expectedCode(g, lane);
      if (!expected || body.guess !== expected)
        return send(res, 409, { error: 'Someone at your tower already moved on. Showing the latest code.', state: v });
      const entry = { guess: expected, by: cleanName(body.by), at: Date.now(), result: action, tower: lane };
      if (action === 'correct') recordSolve(g, entry, v);
      g.attempts.push(entry);
      if (action === 'wrong') assignLane(g, lane, entry.by); // this tower's next code, straight away
      else g.lanes = {};
      touch(g); return send(res, 200, view(g));
    }
    case 'manual': {
      // Someone typed a different code than the app showed. Record what was
      // really entered so it is never handed out again.
      if (g.solved) return send(res, 409, { error: 'Already solved. Start a fresh attempt to continue.', state: view(g) });
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      if (!/^[0-9]+$/.test(code) || code.length !== g.known.length)
        return send(res, 400, { error: `Enter all ${g.known.length} digits of the code that was typed in.` });
      if (!matchesPattern(code, g.known))
        return send(res, 400, { error: "That code doesn't fit the known digits in Setup, so it can't be the answer. Nothing to record." });
      if (body.result !== 'wrong' && body.result !== 'correct') return send(res, 400, { error: 'Bad result.' });
      if (body.result === 'wrong' && triedSet(g).has(code))
        return send(res, 409, { error: `${code} was already tried. Nothing new to record.`, state: view(g) });
      const v = view(g);
      const lane = laneOf(body);
      const entry = { guess: code, by: cleanName(body.by), at: Date.now(), result: body.result, tower: lane, manual: true };
      if (body.result === 'correct') recordSolve(g, entry, v);
      g.attempts.push(entry);
      if (body.result === 'correct') g.lanes = {};
      // a tower holding that code now needs a new one; claim handles it
      touch(g); return send(res, 200, view(g));
    }
    case 'claim': {
      // A viewer at a tower asks for (or keeps alive) that tower's code.
      const lane = laneOf(body);
      if (!guessingBlocked(g)) {
        if (laneValid(g, lane, triedSet(g))) g.lanes[lane].at = Date.now();
        else assignLane(g, lane, cleanName(body.by));
      }
      touch(g); return send(res, 200, view(g));
    }
    case 'undo': {
      if (!g.attempts.length) return send(res, 409, { error: 'Nothing to undo.', state: view(g) });
      const last = g.attempts.pop();
      if (g.solved && g.solved.at === last.at) g.solved = null;
      // a misclicked "wrong" goes straight back to the tower that clicked it
      if (last.result === 'wrong' && last.tower && !last.manual && !guessingBlocked(g)) {
        if (!g.lanes) g.lanes = {};
        g.lanes[last.tower] = { code: last.guess, at: Date.now(), by: last.by };
      }
      if (last.solveId) { // misclicked "correct" leaves no bad data
        solves = solves.filter(s => s.id !== last.solveId);
        store.removeSolve(last.solveId);
      }
      touch(g); return send(res, 200, view(g));
    }
    case 'reset': {
      // scope 'code': new code on the same map (keeps length and map).
      // scope 'map': new map, so the map choice is cleared too.
      if (body.scope === 'map') g.map = '';
      g.round += 1; g.seed = newSeed(); g.attempts = []; g.solved = null; g.lanes = {}; g.known = blankPattern(g.known.length); g.sources = blankPattern(g.known.length);
      touch(g); return send(res, 200, view(g));
    }
    default: return send(res, 404, { error: 'Unknown action' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = clientIp(req);
  try {
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (url.pathname === '/favicon.ico') { res.writeHead(204, SECURITY_HEADERS); return res.end(); }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'api' && parts[1] === 'groups') return await handleApi(req, res, parts, ip);
    if (req.method === 'GET' && url.pathname === '/api/stats') {
      const source = ['all', 'revealed', 'guessed'].includes(url.searchParams.get('source')) ? url.searchParams.get('source') : 'all';
      return send(res, 200, computeStats(solves, source));
    }
    if (req.method === 'GET' && url.pathname === '/api/stats/solves.csv') {
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="codebreaker-correct-codes.csv"', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
      return res.end(toCsv(solves));
    }
    if (req.method === 'GET' && serveStatic(req, res, url.pathname)) return;
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    if (!res.headersSent) send(res, 400, { error: 'Bad request' });
  }
});

// SSE keep-alive, idle-group cleanup, rate-limit bucket cleanup
setInterval(() => { for (const set of streams.values()) for (const r of set) r.write(': ping\n\n'); }, 25_000);
setInterval(() => {
  const cutoff = Date.now() - GROUP_TTL_HOURS * 3600_000;
  const expired = [];
  for (const [id, g] of groups) if (g.updatedAt < cutoff && !streams.has(id)) { groups.delete(id); seqCache.delete(id); expired.push(id); }
  store.deleteGroups(expired);
  const now = Date.now();
  for (const [k, b] of buckets) if (now - b.start > 15 * 60_000) buckets.delete(k);
}, 15 * 60_000);

load().then(() => {
  server.listen(PORT, HOST, () => console.log(`Code Breaker coordinator on http://${HOST}:${PORT}`));
}).catch((e) => {
  console.error('Could not load saved data, refusing to start:', e.message);
  process.exit(1);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  try { await store.flush(); } catch (e) { console.error('Final save failed:', e.message); }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
