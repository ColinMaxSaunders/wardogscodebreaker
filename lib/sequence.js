'use strict';

// Builds the ordered guess list for a code pattern.
// pattern: array of length 3-5, each entry a digit 0-9 or null (unknown).
// Order: phase 1 = codes whose full set of digits (known + guessed) never
// repeats; phase 2 = every remaining code. Within a phase, ascending order.

function buildSequence(pattern) {
  const unknownIdx = [];
  pattern.forEach((d, i) => { if (d === null) unknownIdx.push(i); });
  const u = unknownIdx.length;
  const total = Math.pow(10, u);
  const noRepeat = [];
  const withRepeat = [];
  const digits = pattern.slice();

  for (let n = 0; n < total; n++) {
    let rem = n;
    for (let k = u - 1; k >= 0; k--) {
      digits[unknownIdx[k]] = rem % 10;
      rem = Math.floor(rem / 10);
    }
    const code = digits.join('');
    if (new Set(digits).size === digits.length) noRepeat.push(code);
    else withRepeat.push(code);
  }
  return { noRepeat, withRepeat, unknownCount: u };
}

function matchesPattern(code, pattern) {
  if (code.length !== pattern.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== null && Number(code[i]) !== pattern[i]) return false;
  }
  return true;
}

module.exports = { buildSequence, matchesPattern };
