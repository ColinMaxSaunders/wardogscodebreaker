'use strict';

// Code Breaker group coordinator for WARDOGS Drill Tower guessing.
// Zero dependencies: Node's built-in http server, Server-Sent Events for
// live updates, and a JSON file for persistence across restarts.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildSequence, matchesPattern } = require('./lib/sequence');

// ---------- configuration (environment variables) ----------
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'groups.json');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';        // set to 1 behind Render/Fly/nginx
const GROUP_TTL_HOURS = parseFloat(process.env.GROUP_TTL_HOURS || '48');
const MAX_GROUPS = parseInt(process.env.MAX_GROUPS || '5000', 10);
const MAX_STREAMS_PER_GROUP = 50;
const MAX_STREAMS_TOTAL = 2000;
const HISTORY_SENT = 50;           // newest attempts sent to browsers
const MIN_LEN = 3, MAX_LEN = 5;

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

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const g of raw) { if (!g.seed) g.seed = newSeed(); groups.set(g.id, g); }
    console.log(`Loaded ${groups.size} group(s)`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Could not read data file:', e.message);
  }
}
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify([...groups.values()]));
      fs.renameSync(tmp, DATA_FILE); // atomic replace
    } catch (e) { console.error('Save failed:', e.message); }
  }, 1000);
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

function view(g) {
  const seq = getSequence(g);
  const tried = new Set(g.attempts.filter(a => a.result === 'wrong').map(a => a.guess));
  let current = null, phase = 'exhausted';
  let remNoRepeat = 0, remRepeat = 0;
  for (const c of seq.noRepeat) if (!tried.has(c)) { remNoRepeat++; if (!current) { current = c; phase = 'no-repeat'; } }
  for (const c of seq.withRepeat) if (!tried.has(c)) { remRepeat++; if (!current) { current = c; phase = 'repeat'; } }
  if (g.solved) { phase = 'solved'; current = g.solved.guess; }

  const wrongCount = g.attempts.filter(a => a.result === 'wrong').length;
  const relevantWrong = g.attempts.filter(a => a.result === 'wrong' && matchesPattern(a.guess, g.known)).length;
  return {
    id: g.id,
    round: g.round,
    length: g.known.length,
    known: g.known,
    unknownCount: seq.unknownCount,
    eligible: seq.unknownCount >= 3,
    current,
    phase,
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
function touch(g) { g.updatedAt = Date.now(); scheduleSave(); broadcast(g); }

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
  '/styles.css': ['styles.css', 'text/css; charset=utf-8']
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
    groups.set(id, g); scheduleSave();
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
      g.known = body.known.slice();
      touch(g); return send(res, 200, view(g));
    }
    case 'wrong':
    case 'correct': {
      if (g.solved) return send(res, 409, { error: 'Already solved. Start a fresh attempt to continue.', state: view(g) });
      const v = view(g);
      // Guard against double clicks / two people clicking at once:
      // the click only counts if it refers to the code currently on screen.
      if (!v.current || body.guess !== v.current)
        return send(res, 409, { error: 'Someone already moved on. Showing the latest code.', state: v });
      const entry = { guess: v.current, by: cleanName(body.by), at: Date.now(), result: action };
      g.attempts.push(entry);
      if (action === 'correct') g.solved = entry;
      touch(g); return send(res, 200, view(g));
    }
    case 'undo': {
      if (!g.attempts.length) return send(res, 409, { error: 'Nothing to undo.', state: view(g) });
      const last = g.attempts.pop();
      if (g.solved && g.solved.at === last.at) g.solved = null;
      touch(g); return send(res, 200, view(g));
    }
    case 'reset': {
      g.round += 1; g.seed = newSeed(); g.attempts = []; g.solved = null; g.known = blankPattern(g.known.length);
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
  for (const [id, g] of groups) if (g.updatedAt < cutoff && !streams.has(id)) { groups.delete(id); seqCache.delete(id); }
  scheduleSave();
  const now = Date.now();
  for (const [k, b] of buckets) if (now - b.start > 15 * 60_000) buckets.delete(k);
}, 15 * 60_000);

load();
server.listen(PORT, HOST, () => console.log(`Code Breaker coordinator on http://${HOST}:${PORT}`));

function shutdown() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(DATA_FILE, JSON.stringify([...groups.values()])); } catch {} process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
