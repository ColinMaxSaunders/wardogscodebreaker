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
