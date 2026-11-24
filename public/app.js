'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Number(n).toLocaleString();
  const pretty = (c) => c.slice(0, 4) + '-' + c.slice(4);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } }
  };

  let state = null;
  let groupId = null;
  let es = null;
  let busy = false;
  let pendingCorrect = null; // code awaiting "are you sure?"
  let myTower = '1';         // keypad lockouts are per tower, so each tower gets its own code
  let claiming = false;
  let clockOffset = 0;
  let setupOpen = null;      // null until the first state arrives, then true/false       // server time minus this device's time
  let setupDirty = false;
  let draft = { length: 4, known: [null, null, null, null], sources: [null, null, null, null], map: '' };

  // The code this viewer's tower should enter now (null if none).
  function myCode(s) {
    if (!s) return null;
    if (s.solved) return s.solved.guess;
    if (s.phase !== 'no-repeat' && s.phase !== 'repeat') return null;
    return (s.lanes && s.lanes[myTower] && s.lanes[myTower].code) || null;
  }

  // Ask the server for this tower's code if it doesn't have one yet.
  async function ensureClaim() {
    const s = state;
    if (!s || claiming || s.solved || (s.phase !== 'no-repeat' && s.phase !== 'repeat')) return;
    if (s.lanes && s.lanes[myTower]) return;
    claiming = true;
    try {
      const r = await api('/' + groupId + '/claim', { lane: myTower, by: $('myName').value });
      if (r.ok) apply(r.data); else if (r.data.state) apply(r.data.state);
    } finally { claiming = false; }
  }

  // ---------- routing ----------
  const m = location.pathname.match(/^\/g\/([A-Za-z0-9-]+)$/);
  if (m) openGroup(m[1].toUpperCase().replace(/[^A-Z0-9]/g, ''));
  else showLanding();

  function show(id) { for (const s of ['landing', 'group', 'notfound']) $(s).hidden = s !== id; }

  // ---------- API ----------
  async function api(path, body) {
    const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const r = await fetch('/api/groups' + path, opts);
    let data = {};
    try { data = await r.json(); } catch { /* empty */ }
    return { ok: r.ok, status: r.status, data };
  }

  // ---------- landing ----------
  function showLanding() {
    show('landing');
    let len = 4;
    $('createLen').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-len]'); if (!b) return;
      len = Number(b.dataset.len);
      for (const x of $('createLen').children) x.classList.toggle('on', x === b);
    });
    $('createBtn').addEventListener('click', async () => {
      $('createBtn').disabled = true;
      const r = await api('', { length: len });
      $('createBtn').disabled = false;
      if (!r.ok) return alertMsg(r.data.error || 'Could not create group.');
      location.href = '/g/' + r.data.id;
    });
    const join = () => {
      const c = $('joinCode').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (c.length !== 8) { $('joinCode').focus(); return; }
      location.href = '/g/' + c;
    };
    $('joinBtn').addEventListener('click', join);
    $('joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  }
  function alertMsg(t) { window.alert(t); }

  // ---------- group ----------
  async function openGroup(id) {
    groupId = id;
    const r = await api('/' + id);
    if (!r.ok) {
      show('notfound');
      if (r.status === 429) { $('nfTitle').textContent = 'Too many tries'; $('nfMsg').textContent = r.data.error || 'Wait a few minutes and try again.'; }
      return;
    }
    show('group');
    wireGroup();
    apply(r.data);
    connect();
  }

  function connect() {
    if (es) es.close();
    es = new EventSource('/api/groups/' + groupId + '/events');
    const conn = $('conn'); conn.hidden = false;
    es.onopen = () => { conn.textContent = 'Live'; conn.className = 'conn ok'; };
    es.onerror = () => { conn.textContent = 'Reconnecting…'; conn.className = 'conn bad'; };
    es.onmessage = (ev) => { try { apply(JSON.parse(ev.data)); } catch { /* ignore malformed */ } };
  }

  function wireGroup() {
    $('inviteCode').textContent = pretty(groupId);
    myTower = store.get('cb_tower_' + groupId) || '1';
    $('towerSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-t]'); if (!b) return;
      if (pendingCorrect) closeConfirm();
      myTower = b.dataset.t;
      store.set('cb_tower_' + groupId, myTower);
      render();
    });
    // keep this tower's code reserved while the page is open
    setInterval(() => {
      if (document.visibilityState === 'visible' && state && state.lanes && state.lanes[myTower])
        api('/' + groupId + '/claim', { lane: myTower, by: $('myName').value });
    }, 5 * 60_000);
    $('myName').value = store.get('cb_name') || '';
    $('myName').addEventListener('input', () => store.set('cb_name', $('myName').value));

    $('copyLink').addEventListener('click', async () => {
      const link = location.origin + '/g/' + groupId;
      try { await navigator.clipboard.writeText(link); flash('Invite link copied.'); }
      catch { flash('Copy failed. Link: ' + link); }
    });

    $('lenSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-len]'); if (!b) return;
      const len = Number(b.dataset.len);
      const k = draft.known.slice(0, len);
      const src = (draft.sources || []).slice(0, len);
      while (src.length < len) src.push(null);
      while (k.length < len) k.push(null);
      draft = { length: len, known: k, sources: src, map: draft.map };
      markDirty(); renderSetup();
    });
    $('saveSetup').addEventListener('click', saveSetup);
    $('setupToggle').addEventListener('click', () => setSetupOpen(!setupOpen));
    $('mapSel').addEventListener('change', () => { draft.map = $('mapSel').value; markDirty(); });

    $('wrongBtn').addEventListener('click', () => mark('wrong'));
    $('correctBtn').addEventListener('click', askCorrect);
    $('confirmNo').addEventListener('click', closeConfirm);

    // correction: someone typed a different code than the app showed
    const manualCode = () => $('manualCode').value.replace(/[^0-9]/g, '');
    const sendManual = async (result) => {
      const code = manualCode();
      const r = await act('manual', { code, result, lane: myTower, by: $('myName').value });
      if (r && r.ok) {
        $('manualCode').value = ''; $('manualBox').open = false;
        flash(result === 'wrong' ? code + ' logged as tried. It won\'t come up again.' : code + ' recorded as the correct code.');
      }
      $('manualConfirm').hidden = true; $('manualActions').hidden = false;
    };
    $('manualCode').addEventListener('input', () => { $('manualCode').value = manualCode().slice(0, state ? state.length : 5); });
    $('manualWrong').addEventListener('click', () => sendManual('wrong'));
    $('manualCorrect').addEventListener('click', () => {
      const code = manualCode();
      if (!state || code.length !== state.length) { flash('Enter all ' + (state ? state.length : '') + ' digits first.'); return; }
      $('manualConfirmCode').textContent = code;
      $('manualActions').hidden = true; $('manualConfirm').hidden = false;
    });
    $('manualYes').addEventListener('click', () => sendManual('correct'));
    $('manualNo').addEventListener('click', () => { $('manualConfirm').hidden = true; $('manualActions').hidden = false; });

    setInterval(renderLock, 1000);
    $('confirmYes').addEventListener('click', async () => {
      const code = pendingCorrect;
      closeConfirm();
      if (code && myCode(state) === code && !state.solved) await act('correct', { guess: code, lane: myTower, by: $('myName').value });
      else flash('The code changed before you confirmed. Nothing was recorded.');
    });
    $('undoBtn').addEventListener('click', () => act('undo', {}));

    $('resetBtn').addEventListener('click', () => { $('resetBtn').hidden = true; $('resetConfirm').hidden = false; });
    $('resetNo').addEventListener('click', () => { $('resetBtn').hidden = false; $('resetConfirm').hidden = true; });
    $('resetYes').addEventListener('click', async () => {
      $('resetBtn').hidden = false; $('resetConfirm').hidden = true;
      setupDirty = false;
      await act('reset', {});
    });
  }

  function markDirty() { setupDirty = true; $('dirtyNote').hidden = false; }

  async function saveSetup() {
    const r = await act('config', { length: draft.length, known: draft.known, sources: draft.known.map((d, i) => d === null ? null : (draft.sources[i] || 'tower')), map: draft.map });
    if (r && r.ok) { setupDirty = false; $('dirtyNote').hidden = true; setSetupOpen(false); flash('Setup saved for everyone.'); }
  }

  function askCorrect() {
    if (!myCode(state) || state.solved || busy) return;
    pendingCorrect = myCode(state);
    $('confirmCode').textContent = pendingCorrect;
    $('guessActions').hidden = true;
    $('confirmCorrect').hidden = false;
    $('confirmNo').focus();
  }
  function closeConfirm() {
    pendingCorrect = null;
    $('confirmCorrect').hidden = true;
    $('guessActions').hidden = false;
  }

  async function mark(result) {
    if (!myCode(state) || state.solved || busy) return;
    await act(result, { guess: myCode(state), lane: myTower, by: $('myName').value });
  }

  async function act(action, body) {
    busy = true; updateButtons();
    const r = await api('/' + groupId + '/' + action, body);
    busy = false;
    if (r.ok) apply(r.data);
    else {
      if (r.data.state) apply(r.data.state);
      flash(r.data.error || 'Something went wrong.');
    }
    updateButtons();
    return r;
  }

  let toastTimer = null;
  function flash(t) {
    const el = $('toast'); el.textContent = t; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  // ---------- render ----------
  function apply(s) {
    if (!s || s.id !== groupId) return;
    state = s;
    if (s.serverNow) clockOffset = s.serverNow - Date.now();
    if (pendingCorrect && (myCode(s) !== pendingCorrect || s.solved)) { closeConfirm(); flash('Someone else moved on, so that confirmation was cancelled.'); }
    if (!setupDirty) { draft = { length: s.length, known: s.known.slice(), sources: (s.sources || s.known.map(d => d === null ? null : 'tower')).slice(), map: s.map || '' }; $('dirtyNote').hidden = true; }
    render();
  }

  function render() {
    const s = state;
    $('viewers').textContent = s.viewers === 1 ? '1 person viewing' : s.viewers + ' people viewing';
    if (setupOpen === null) {
      const inUse = s.attempts.length > 0 || s.known.some(d => d !== null) || !!s.map;
      setSetupOpen(!inUse);
    }
    renderSetup();
    renderSetupSummary();

    $('warn').hidden = s.eligible;
    const gc = s.guessedCount === undefined ? s.unknownCount : s.guessedCount;
    $('warnCount').textContent = gc === 1 ? 'only 1' : 'only ' + gc;

    for (const b of $('towerSeg').children) b.classList.toggle('on', b.dataset.t === myTower);
    const code = myCode(s);
    const guessing = s.phase === 'no-repeat' || s.phase === 'repeat';
    const hasRepeat = code && new Set(code).size < code.length;
    const phase = {
      'no-repeat': 'Tower ' + myTower + ' · next code' + (hasRepeat ? ' · now including repeated digits' : ' · non-repeating digits first'),
      'repeat': 'Tower ' + myTower + ' · next code' + (hasRepeat ? ' · now including repeated digits' : ' · non-repeating digits first'),
      'exhausted': 'Every combination for this setup has been tried',
      'too-many': 'Capture more towers before guessing',
      'solved': 'Code cracked'
    }[s.phase];
    $('phaseLabel').textContent = phase;

    const disp = $('codeDisplay'); disp.replaceChildren();
    if (code) {
      for (let i = 0; i < code.length; i++) {
        const d = document.createElement('div');
        d.className = 'digit' + (s.solved ? ' solved' : s.known[i] !== null ? ' known' : '');
        d.textContent = code[i];
        disp.appendChild(d);
      }
    } else if (guessing) {
      const p = document.createElement('div'); p.className = 'msg';
      p.textContent = 'Getting a code for Tower ' + myTower + '…';
      disp.appendChild(p);
    } else if (s.phase === 'too-many') {
      const need = s.unknownCount - s.maxUnknownToGuess;
      const p = document.createElement('div'); p.className = 'msg block';
      p.textContent = s.unknownCount + ' digits are unknown, which means ' + fmt(s.totalCombos) + ' possible codes. That is too many to brute-force before the code changes. '
        + 'Capture ' + need + ' more tower' + (need === 1 ? '' : 's') + ' and enter ' + (need === 1 ? 'its digit' : 'their digits') + ' in Setup, so exactly 3 digits are left to guess (at most 1,000 codes).';
      disp.appendChild(p);
    } else {
      const p = document.createElement('div'); p.className = 'msg';
      p.textContent = 'No codes left. Check the known digits and code length, then use Undo or Start fresh attempt.';
      disp.appendChild(p);
    }
    // codes other towers are working on
    const others = $('otherTowers'); others.replaceChildren();
    const busyTowers = Object.keys(s.lanes || {}).filter(t => t !== myTower).sort();
    $('otherTowersWrap').hidden = !busyTowers.length;
    for (const t of busyTowers) {
      const li = document.createElement('li');
      const a = document.createElement('span'); a.textContent = 'Tower ' + t;
      const c = document.createElement('span'); c.className = 'mono'; c.textContent = s.lanes[t].code;
      const w = document.createElement('span'); w.className = 'muted'; w.textContent = s.lanes[t].by || '';
      li.append(a, c, w); others.appendChild(li);
    }

    $('winMsg').hidden = !s.solved;
    if (s.solved) $('winMsg').textContent = 'Solved by ' + s.solved.by + '. Check whether the achievement unlocked. Calling in that drill changed the code, so click Start fresh attempt to go after the next one.';

    $('statAttempts').textContent = fmt(s.attemptsMade);
    $('statRemaining').textContent = fmt(s.remainingTotal);
    $('statNoRepeat').textContent = fmt(s.remainingNoRepeat);
    const done = s.totalCombos - s.remainingTotal;
    $('progressBar').style.width = (s.totalCombos ? (100 * done / s.totalCombos) : 0) + '%';
    $('progressNote').textContent = fmt(done) + ' of ' + fmt(s.totalCombos) + ' combinations for this setup ruled out'
      + (s.attemptsMade !== s.attemptsMatchingSetup ? ' · ' + fmt(s.attemptsMade - s.attemptsMatchingSetup) + ' earlier attempt(s) no longer match the setup' : '');

    const log = $('log'); log.replaceChildren();
    for (const a of s.attempts) {
      const li = document.createElement('li');
      li.className = a.result + (a.stale ? ' stale' : '');
      const g = document.createElement('span'); g.className = 'g'; g.textContent = a.guess;
      const who = document.createElement('span'); who.textContent = (a.result === 'correct' ? 'Correct · ' : 'Wrong · ') + a.by + (a.tower ? ' · Tower ' + a.tower : '') + (a.manual ? ' · typed by mistake' : '');
      const t = document.createElement('span'); t.className = 't'; t.textContent = new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      li.append(g, who, t); log.appendChild(li);
    }
    $('logEmpty').hidden = s.attempts.length > 0;
    updateButtons();
    renderLock();
    $('manualBox').hidden = !!s.solved;
    if (guessing && !code) ensureClaim();
  }

  // This tower's keypad: tries left before the ~30 s lockout, or time left on it.
  function renderLock() {
    const s = state, el = $('lockStatus');
    if (!s || !s.lockout || s.solved || !(s.phase === 'no-repeat' || s.phase === 'repeat')) { el.hidden = true; return; }
    const t = (s.towers || {})[myTower] || { sinceLock: 0, lockedUntil: 0 };
    const left = Math.ceil((t.lockedUntil - (Date.now() + clockOffset)) / 1000);
    el.hidden = false;
    if (left > 0) {
      el.className = 'lock locked';
      el.textContent = 'Tower ' + myTower + ' keypad locked after ' + s.lockout.after + ' wrong codes · about ' + left + 's left. Another tower can keep guessing.';
    } else {
      el.className = 'lock';
      const used = t.sinceLock;
      el.textContent = 'Tower ' + myTower + ': ' + used + ' of ' + s.lockout.after + ' tries used before a ' + Math.round(s.lockout.ms / 1000) + '-second lockout.';
    }
  }

  function setSetupOpen(open) {
    setupOpen = open;
    $('setupBody').hidden = !open;
    $('setupToggle').setAttribute('aria-expanded', String(open));
    $('setupCard').classList.toggle('collapsed', !open);
    renderSetupSummary();
  }

  // Shown while Setup is collapsed, e.g. "Ozeti · ? ? 5* ? · 4 to guess" (* = told)
  function renderSetupSummary() {
    const s = state; if (!s) return;
    const digits = s.known.map((d, i) => d === null ? '?' : String(d) + ((s.sources && s.sources[i] === 'told') ? '*' : '')).join(' ');
    const gc = s.guessedCount === undefined ? s.unknownCount : s.guessedCount;
    const parts = [];
    if (s.map) parts.push(s.map);
    parts.push(digits);
    parts.push(gc + ' to guess');
    $('setupSummary').textContent = setupOpen ? '' : parts.join(' · ');
    $('setupSummary').title = (s.sources || []).includes('told') ? '* = digit told by another team' : '';
  }

  function renderSetup() {
    for (const b of $('lenSeg').children) b.classList.toggle('on', Number(b.dataset.len) === draft.length);
    if ($('mapSel').value !== draft.map) $('mapSel').value = draft.map;
    const wrap = $('slots');
    const inputs = () => [...wrap.querySelectorAll('.slot')];
    const focusedIdx = inputs().indexOf(document.activeElement);
    if (wrap.children.length !== draft.length) {
      wrap.replaceChildren();
      for (let i = 0; i < draft.length; i++) {
        const col = document.createElement('div'); col.className = 'slot-col';
        const inp = document.createElement('input');
        inp.className = 'slot'; inp.inputMode = 'numeric'; inp.maxLength = 1; inp.placeholder = '?';
        inp.setAttribute('aria-label', 'Position ' + (i + 1));
        inp.addEventListener('input', () => {
          const v = inp.value.replace(/[^0-9]/g, '').slice(-1);
          inp.value = v;
          draft.known[i] = v === '' ? null : Number(v);
          draft.sources[i] = v === '' ? null : (draft.sources[i] || 'tower');
          markDirty(); renderSources();
          const next = inputs()[i + 1];
          if (v && next) next.focus();
        });
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSetup(); });
        // where the digit came from: our tower capture, or told by another team
        const src = document.createElement('button');
        src.type = 'button'; src.className = 'src';
        src.addEventListener('click', () => {
          if (draft.known[i] === null) return;
          draft.sources[i] = draft.sources[i] === 'told' ? 'tower' : 'told';
          markDirty(); renderSources();
        });
        col.append(inp, src);
        wrap.appendChild(col);
      }
    }
    inputs().forEach((inp, i) => {
      if (i === focusedIdx && setupDirty) return;
      const v = draft.known[i] === null ? '' : String(draft.known[i]);
      if (inp.value !== v) inp.value = v;
    });
    renderSources();
  }

  function renderSources() {
    [...$('slots').querySelectorAll('.src')].forEach((b, i) => {
      const has = draft.known[i] !== null;
      const told = has && draft.sources[i] === 'told';
      b.hidden = !has;
      b.textContent = told ? 'Told' : 'Tower';
      b.classList.toggle('told', told);
      b.title = told ? 'Told by another team (still counts as guessed). Click to change.' : 'Captured by your faction. Click if another team told you this digit.';
    });
  }


  function updateButtons() {
    const s = state; if (!s) return;
    const canGuess = !!myCode(s) && !s.solved && !busy;
    $('wrongBtn').disabled = !canGuess;
    $('correctBtn').disabled = !canGuess;
    $('undoBtn').disabled = busy || s.attempts.length === 0;
  }
})();
