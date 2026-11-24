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
  let setupDirty = false;
  let draft = { length: 4, known: [null, null, null, null], map: '' };

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
      while (k.length < len) k.push(null);
      draft = { length: len, known: k, map: draft.map };
      markDirty(); renderSetup();
    });
    $('saveSetup').addEventListener('click', saveSetup);
    $('mapSel').addEventListener('change', () => { draft.map = $('mapSel').value; markDirty(); });

    $('wrongBtn').addEventListener('click', () => mark('wrong'));
    $('correctBtn').addEventListener('click', () => mark('correct'));
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
    const r = await act('config', { length: draft.length, known: draft.known, map: draft.map });
    if (r && r.ok) { setupDirty = false; $('dirtyNote').hidden = true; flash('Setup saved for everyone.'); }
  }

  async function mark(result) {
    if (!state || !state.current || state.solved || busy) return;
    await act(result, { guess: state.current, by: $('myName').value });
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
    if (!setupDirty) { draft = { length: s.length, known: s.known.slice(), map: s.map || '' }; $('dirtyNote').hidden = true; }
    render();
  }

  function render() {
    const s = state;
    $('viewers').textContent = s.viewers === 1 ? '1 person viewing' : s.viewers + ' people viewing';
    renderSetup();

    $('warn').hidden = s.eligible;
    $('warnCount').textContent = s.unknownCount === 1 ? '1 unknown digit' : s.unknownCount + ' unknown digits';

    const phase = {
      'no-repeat': 'Next code to try · non-repeating digits first',
      'repeat': 'Next code to try · now including repeated digits',
      'exhausted': 'Every combination for this setup has been tried',
      'solved': 'Code cracked'
    }[s.phase];
    $('phaseLabel').textContent = phase;

    const disp = $('codeDisplay'); disp.replaceChildren();
    if (s.current) {
      for (let i = 0; i < s.current.length; i++) {
        const d = document.createElement('div');
        d.className = 'digit' + (s.solved ? ' solved' : s.known[i] !== null ? ' known' : '');
        d.textContent = s.current[i];
        disp.appendChild(d);
      }
    } else {
      const p = document.createElement('div'); p.className = 'msg';
      p.textContent = 'No codes left. Check the known digits and code length, then use Undo or Start fresh attempt.';
      disp.appendChild(p);
    }
    $('winMsg').hidden = !s.solved;
    if (s.solved) $('winMsg').textContent = 'Solved by ' + s.solved.by + '. Check whether the achievement unlocked. The game has now picked a new code, so click Start fresh attempt to go after the next one.';

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
      const who = document.createElement('span'); who.textContent = (a.result === 'correct' ? 'Correct · ' : 'Wrong · ') + a.by;
      const t = document.createElement('span'); t.className = 't'; t.textContent = new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      li.append(g, who, t); log.appendChild(li);
    }
    $('logEmpty').hidden = s.attempts.length > 0;
    updateButtons();
  }

  function renderSetup() {
    for (const b of $('lenSeg').children) b.classList.toggle('on', Number(b.dataset.len) === draft.length);
    if ($('mapSel').value !== draft.map) $('mapSel').value = draft.map;
    const wrap = $('slots');
    const focusedIdx = [...wrap.children].indexOf(document.activeElement);
    if (wrap.children.length !== draft.length) {
      wrap.replaceChildren();
      for (let i = 0; i < draft.length; i++) {
        const inp = document.createElement('input');
        inp.className = 'slot'; inp.inputMode = 'numeric'; inp.maxLength = 1; inp.placeholder = '?';
        inp.setAttribute('aria-label', 'Position ' + (i + 1));
        inp.addEventListener('input', () => {
          const v = inp.value.replace(/[^0-9]/g, '').slice(-1);
          inp.value = v;
          draft.known[i] = v === '' ? null : Number(v);
          markDirty();
          if (v && wrap.children[i + 1]) wrap.children[i + 1].focus();
        });
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSetup(); });
        wrap.appendChild(inp);
      }
    }
    [...wrap.children].forEach((inp, i) => {
      if (i === focusedIdx && setupDirty) return;
      const v = draft.known[i] === null ? '' : String(draft.known[i]);
      if (inp.value !== v) inp.value = v;
    });
  }

  function updateButtons() {
    const s = state; if (!s) return;
    const canGuess = !!s.current && !s.solved && !busy;
    $('wrongBtn').disabled = !canGuess;
    $('correctBtn').disabled = !canGuess;
    $('undoBtn').disabled = busy || s.attempts.length === 0;
  }
})();
