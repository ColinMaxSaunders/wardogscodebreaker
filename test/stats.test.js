'use strict';
const assert = require('assert');
const { computeStats, expectedRepeatRate, chiSquareP, binomCdf, toCsv } = require('../lib/stats');

assert.ok(Math.abs(expectedRepeatRate(3) - 0.28) < 1e-9);
assert.ok(Math.abs(expectedRepeatRate(4) - 0.496) < 1e-9);
assert.ok(Math.abs(expectedRepeatRate(5) - 0.6976) < 1e-9);
// chi-square df=9: critical value 16.919 at p=0.05
assert.ok(Math.abs(chiSquareP(16.919) - 0.05) < 0.002);
assert.ok(Math.abs(chiSquareP(0.0001) - 1) < 1e-3);
// binomial: P(X<=0) for n=20, p=0.28 = 0.72^20
assert.ok(Math.abs(binomCdf(0, 20, 0.28) - Math.pow(0.72, 20)) < 1e-12);

const mk = (code, unknownCount = 3, map = 'Ozeti') => ({ id: code, code, map, unknownCount, revealed: 'xxx', wrongBefore: 1, group: 'g', at: 0 });
// 20 three-digit codes with no repeats and no zeros -> both flags
const codes = ['123','456','789','132','465','798','213','546','879','231','564','897','312','645','978','321','654','987','147','258'];
const s = computeStats(codes.map(c => mk(c)));
const r3 = s.repeats.find(r => r.length === 3);
assert.strictEqual(r3.n, 20); assert.strictEqual(r3.withRepeat, 0);
assert.ok(r3.pAtMostObserved < 0.05);
assert.strictEqual(s.digits.total, 60); assert.strictEqual(s.digits.counts[0], 0);
assert.ok(s.digits.pNoZeros < 0.01);
assert.strictEqual(s.positions[3].counts[0][1], 3); // '1' leads 123, 132, 147

// source filters
const mixed = [mk('111', 0), mk('222', 3)];
assert.strictEqual(computeStats(mixed, 'revealed').count, 1);
assert.strictEqual(computeStats(mixed, 'guessed').count, 1);
assert.strictEqual(computeStats(mixed, 'all').count, 2);

// CSV keeps leading zeros via per-digit columns
const csv = toCsv([mk('012')]);
assert.ok(csv.split('\n')[1].includes('"012"'));
assert.ok(csv.split('\n')[1].endsWith(',0,1,2,,'));
console.log('stats tests passed');
