'use strict';

// Analysis of correct codes, to test how WARDOGS might generate them.
// Baseline ("model A"): every digit independent and uniform over 0-9.

const LENGTHS = [3, 4, 5];

// P(at least one repeated digit) for n independent uniform digits.
function expectedRepeatRate(n) {
  let pNone = 1;
  for (let i = 0; i < n; i++) pNone *= (10 - i) / 10;
  return 1 - pNone;
}

// Wilson 95% interval for a proportion.
function wilson(k, n) {
  if (!n) return null;
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

// Chi-square upper-tail p-value with 9 degrees of freedom (digits 0-9),
// via the regularized gamma function. Good enough for a dashboard.
function chiSquareP(x, df = 9) {
  const a = df / 2, xx = x / 2;
  // series for lower regularized gamma P(a, xx)
  let sum = 1 / a, term = 1 / a;
  for (let k = 1; k < 500; k++) { term *= xx / (a + k); sum += term; if (term < sum * 1e-12) break; }
  const lnGammaA = lnGamma(a);
  const P = Math.exp(-xx + a * Math.log(xx) - lnGammaA) * sum;
  return Math.max(0, Math.min(1, 1 - P));
}
function lnGamma(z) {
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1; let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function filterSolves(solves, source) {
  if (source === 'revealed') return solves.filter(s => s.unknownCount === 0);
  if (source === 'guessed') return solves.filter(s => s.unknownCount > 0);
  return solves;
}

function computeStats(allSolves, source = 'all') {
  const solves = filterSolves(allSolves, source);
  const out = {
    source,
    count: solves.length,
    countAll: allSolves.length,
    countRevealed: allSolves.filter(s => s.unknownCount === 0).length,
    countGuessed: allSolves.filter(s => s.unknownCount > 0).length,
    byMap: {},
    repeats: [],
    digits: { counts: Array(10).fill(0), total: 0 },
    positions: {}
  };

  for (const s of solves) out.byMap[s.map || 'Not set'] = (out.byMap[s.map || 'Not set'] || 0) + 1;

  for (const n of LENGTHS) {
    const group = solves.filter(s => s.code.length === n);
    const withRepeat = group.filter(s => new Set(s.code).size < n).length;
    const exp = expectedRepeatRate(n);
    out.repeats.push({
      length: n,
      n: group.length,
      withRepeat,
      observed: group.length ? withRepeat / group.length : null,
      expected: exp,
      ci: wilson(withRepeat, group.length),
      // Chance of seeing this few repeats (or fewer) if digits were independent
      pAtMostObserved: group.length ? binomCdf(withRepeat, group.length, exp) : null,
      // Chance of seeing this many repeats (or more) if digits were independent
      pAtLeastObserved: group.length ? (withRepeat === 0 ? 1 : 1 - binomCdf(withRepeat - 1, group.length, exp)) : null
    });
    const pos = Array.from({ length: n }, () => Array(10).fill(0));
    for (const s of group) for (let i = 0; i < n; i++) pos[i][Number(s.code[i])]++;
    out.positions[n] = { n: group.length, counts: pos };
  }

  for (const s of solves) for (const ch of s.code) { out.digits.counts[Number(ch)]++; out.digits.total++; }
  const e = out.digits.total / 10;
  if (out.digits.total >= 50) {
    const chi = out.digits.counts.reduce((acc, o) => acc + (o - e) * (o - e) / e, 0);
    out.digits.chiSquare = chi;
    out.digits.pValue = chiSquareP(chi, 9);
  }
  out.digits.zeroShare = out.digits.total ? out.digits.counts[0] / out.digits.total : null;
  out.digits.pNoZeros = out.digits.total ? Math.pow(0.9, out.digits.total) : null;
  return out;
}

function binomCdf(k, n, p) {
  let sum = 0, logC = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log((n - i + 1) / i);
    sum += Math.exp(logC + i * Math.log(p) + (n - i) * Math.log(1 - p));
  }
  return Math.min(1, sum);
}

function toCsv(solves) {
  const head = 'recorded_at_utc,code,length,map,unknown_digits,revealed_pattern,wrong_guesses_before,group,d1,d2,d3,d4,d5';
  const rows = solves.map(s => {
    const d = [...s.code].concat(Array(5 - s.code.length).fill(''));
    const map = String(s.map || '').replace(/"/g, '""');
    return [new Date(s.at).toISOString(), `"${s.code}"`, s.code.length, `"${map}"`, s.unknownCount,
      `"${s.revealed}"`, s.wrongBefore, s.group, ...d].join(',');
  });
  return [head, ...rows].join('\n') + '\n';
}

module.exports = { computeStats, expectedRepeatRate, chiSquareP, binomCdf, toCsv };
