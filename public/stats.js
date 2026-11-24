'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const pct = (x, d = 0) => x === null || x === undefined ? '—' : (100 * x).toFixed(d) + '%';
  const chance = (p) => p < 0.001 ? 'under 0.1%' : pct(p, 1);
  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
  const verdict = (box, text, flag) => box.appendChild(el('p', text, 'verdict' + (flag ? ' flag' : '')));

  async function load() {
    const source = $('source').value;
    let s;
    try {
      const r = await fetch('/api/stats?source=' + encodeURIComponent(source));
      s = await r.json();
    } catch { $('counts').textContent = 'Could not load stats.'; return; }
    render(s);
  }

  function render(s) {
    $('counts').textContent = s.countAll + ' correct code(s) recorded · ' + s.countRevealed + ' fully revealed · ' + s.countGuessed + ' found by guessing · showing ' + s.count;

    // Repeats
    const rows = $('repeatRows'); rows.replaceChildren();
    const rv = $('repeatVerdicts'); rv.replaceChildren();
    for (const r of s.repeats) {
      const tr = el('tr');
      tr.append(el('td', r.length + ' digits'), el('td', String(r.n)), el('td', String(r.withRepeat)),
        el('td', r.n ? pct(r.observed) + (r.ci ? ' (' + pct(r.ci[0]) + '–' + pct(r.ci[1]) + ')' : '') : '—'),
        el('td', pct(r.expected)));
      rows.appendChild(tr);
      if (!r.n) continue;
      if (r.n < 10) { verdict(rv, r.length + '-digit: ' + r.n + ' code(s) so far. Need at least 10 to say anything.'); continue; }
      if (r.pAtMostObserved < 0.05) {
        verdict(rv, r.length + '-digit: fewer repeats than random chance allows. If digits were independent, a result this low has a ' + chance(r.pAtMostObserved) + ' chance. This suggests the game avoids repeated digits.', true);
      } else if (r.pAtLeastObserved < 0.05) {
        verdict(rv, r.length + '-digit: more repeats than random chance allows (' + chance(r.pAtLeastObserved) + ' chance if digits were independent). This suggests the game favors repeated digits.', true);
      } else {
        verdict(rv, r.length + '-digit: repeat rate is consistent with fully random digits so far.');
      }
    }

    // Digit frequency
    const counts = s.digits.counts, total = s.digits.total;
    const max = Math.max(1, ...counts);
    const bars = $('bars'); bars.replaceChildren();
    const labels = $('barLabels'); labels.replaceChildren();
    counts.forEach((c, d) => {
      const b = el('div', undefined, 'bar');
      b.style.height = (100 * c / max) + '%';
      b.title = d + ': ' + c + ' (' + (total ? pct(c / total, 1) : '—') + ')';
      bars.appendChild(b);
      labels.appendChild(el('div', d + ' · ' + c));
    });
    const dv = $('digitVerdicts'); dv.replaceChildren();
    if (!total) verdict(dv, 'No codes recorded yet.');
    else if (total < 50) verdict(dv, total + ' digits so far. Need at least 50 to test whether digits are fair.');
    else if (s.digits.pValue < 0.05) verdict(dv, 'Digits are not evenly spread (chance of this much imbalance if fair: ' + chance(s.digits.pValue) + '). Some digits come up more than others.', true);
    else verdict(dv, 'Digit spread is consistent with fair, random digits (imbalance this large happens ' + chance(s.digits.pValue) + ' of the time by luck).');
    if (total >= 20 && counts[0] === 0) verdict(dv, '0 has never appeared in ' + total + ' digits. If 0 were possible, the chance of that is ' + chance(s.digits.pNoZeros) + '. Digits may be limited to 1–9.', true);

    // Positions
    const pos = $('positions'); pos.replaceChildren();
    let any = false;
    for (const len of [3, 4, 5]) {
      const p = s.positions[len];
      if (!p || !p.n) continue;
      any = true;
      pos.appendChild(el('div', len + '-digit codes (' + p.n + ')', 'lbl'));
      const t = el('table', undefined, 'stat-table heat');
      const head = el('tr'); head.appendChild(el('th', 'Position'));
      for (let d = 0; d < 10; d++) head.appendChild(el('th', String(d)));
      const thead = el('thead'); thead.appendChild(head); t.appendChild(thead);
      const tb = el('tbody');
      const cmax = Math.max(1, ...p.counts.flat());
      p.counts.forEach((row, i) => {
        const tr = el('tr'); tr.appendChild(el('td', '#' + (i + 1)));
        row.forEach(c => {
          const td = el('td', String(c));
          td.style.background = 'rgba(217, 180, 74, ' + (0.08 + 0.6 * c / cmax).toFixed(2) + ')';
          tr.appendChild(td);
        });
        tb.appendChild(tr);
      });
      t.appendChild(tb); pos.appendChild(t);
    }
    if (!any) pos.appendChild(el('p', 'No codes recorded yet.', 'muted small'));

    // Maps
    const mr = $('mapRows'); mr.replaceChildren();
    const entries = Object.entries(s.byMap).sort((a, b) => b[1] - a[1]);
    if (!entries.length) { const tr = el('tr'); tr.append(el('td', 'No codes yet'), el('td', '0')); mr.appendChild(tr); }
    for (const [m, n] of entries) { const tr = el('tr'); tr.append(el('td', m), el('td', String(n))); mr.appendChild(tr); }
  }

  $('source').addEventListener('change', load);
  load();
})();
