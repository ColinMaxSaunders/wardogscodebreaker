'use strict';
const assert = require('assert');
const { buildSequence, matchesPattern } = require('../lib/sequence');

// 3 unknown: 720 non-repeating + 280 repeating = 1000
let s = buildSequence([null, null, null]);
assert.strictEqual(s.noRepeat.length, 720);
assert.strictEqual(s.withRepeat.length, 280);
assert.strictEqual(s.noRepeat[0], '012');
assert.strictEqual(s.withRepeat[0], '000');

// 4-digit, one known: unknown digits can't reuse the known digit in phase 1 (9*8*7 = 504)
s = buildSequence([7, null, null, null]);
assert.strictEqual(s.noRepeat.length, 504);
assert.strictEqual(s.noRepeat.length + s.withRepeat.length, 1000);
assert.ok(s.noRepeat.every(c => c[0] === '7' && new Set(c).size === 4));

// 5-digit, two known: 8*7*6 = 336
s = buildSequence([null, 3, null, 9, null]);
assert.strictEqual(s.noRepeat.length, 336);
assert.strictEqual(s.unknownCount, 3);

// 5 unknown
s = buildSequence([null, null, null, null, null]);
assert.strictEqual(s.noRepeat.length, 30240);
assert.strictEqual(s.noRepeat.length + s.withRepeat.length, 100000);

// Known digits that repeat each other leave no non-repeating codes
s = buildSequence([4, 4, null, null, null]);
assert.strictEqual(s.noRepeat.length, 0);

assert.ok(matchesPattern('1234', [1, null, null, 4]));
assert.ok(!matchesPattern('1234', [2, null, null, 4]));
assert.ok(!matchesPattern('123', [null, null, null, null]));
console.log('sequence tests passed');

// ---- shuffled order ----
const seedA = '0123456789abcdef0123456789abcdef';
const seedB = 'fedcba9876543210fedcba9876543210';
const pat = [null, 3, null, null];
const plain = buildSequence(pat);
const a1 = buildSequence(pat, seedA), a2 = buildSequence(pat, seedA), b = buildSequence(pat, seedB);
// same seed -> identical order (every viewer / restart agrees)
assert.deepStrictEqual(a1.noRepeat, a2.noRepeat);
assert.deepStrictEqual(a1.withRepeat, a2.withRepeat);
// different seed -> different order
assert.notDeepStrictEqual(a1.noRepeat, b.noRepeat);
// shuffled, not sorted
assert.notDeepStrictEqual(a1.noRepeat, plain.noRepeat);
// same members in each phase: no repeat-digit code leaks into phase 1
assert.deepStrictEqual([...a1.noRepeat].sort(), [...plain.noRepeat].sort());
assert.deepStrictEqual([...a1.withRepeat].sort(), [...plain.withRepeat].sort());
assert.ok(a1.noRepeat.every(c => new Set(c).size === c.length));
assert.ok(a1.withRepeat.every(c => new Set(c).size < c.length));
// rough uniformity: first digit of the first 300 phase-1 codes is spread out
const firstDigits = new Set(a1.noRepeat.slice(0, 50).map(c => c[0]));
assert.ok(firstDigits.size >= 6);
console.log('shuffle tests passed');
