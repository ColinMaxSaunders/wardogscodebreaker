'use strict';
const crypto = require('crypto');

// Builds the ordered guess list for a code pattern.
// pattern: array of length 3-5, each entry a digit 0-9 or null (unknown).
// Order: phase 1 = codes whose full set of digits (known + guessed) never
// repeats; phase 2 = every remaining code. Each phase is shuffled with a
// seeded PRNG, so every viewer (and every server restart) gets the same order
// for the same seed, and no phase-2 code appears until phase 1 is used up.

// sfc32: small, fast, well-distributed 32-bit PRNG. seed = 32 hex chars.
function rng(seedHex) {
  let a = parseInt(seedHex.slice(0, 8), 16) >>> 0, b = parseInt(seedHex.slice(8, 16), 16) >>> 0;
  let c = parseInt(seedHex.slice(16, 24), 16) >>> 0, d = parseInt(seedHex.slice(24, 32), 16) >>> 0;
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b | 0) + d | 0;
    d = d + 1 | 0;
    a = b ^ (b >>> 9);
    b = c + (c << 3) | 0;
    c = (c << 21) | (c >>> 11);
    c = c + t | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 15; i++) next(); // warm up
  return next;
}

// Fisher-Yates shuffle in place.
function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

function buildSequence(pattern, seedHex) {
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
  if (seedHex) {
    // Separate streams per phase, keyed to the pattern, so changing known
    // digits gives a fresh but still deterministic order.
    const salt = pattern.map(d => d === null ? 'x' : d).join('');
    shuffle(noRepeat, rng(mix(seedHex, 'A' + salt)));
    shuffle(withRepeat, rng(mix(seedHex, 'B' + salt)));
  }
  return { noRepeat, withRepeat, unknownCount: u };
}

function mix(seedHex, label) {
  return crypto.createHash('sha256').update(seedHex + ':' + label).digest('hex').slice(0, 32);
}

function matchesPattern(code, pattern) {
  if (code.length !== pattern.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== null && Number(code[i]) !== pattern[i]) return false;
  }
  return true;
}

module.exports = { buildSequence, matchesPattern };
