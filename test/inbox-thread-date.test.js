const assert = require('assert');
const {
  cutoffForDays,
  parseThreadDate,
} = require('../lib/inbox-thread-date');

const now = new Date(2026, 8, 14, 15, 30);

assert.deepStrictEqual(parseThreadDate('Today', now), new Date(2026, 8, 14));
assert.deepStrictEqual(
  parseThreadDate('Yesterday at 8:27 AM', now),
  new Date(2026, 8, 13)
);
assert.deepStrictEqual(parseThreadDate('Sep 13', now), new Date(2026, 8, 13));
assert.deepStrictEqual(parseThreadDate('Dec 30', now), new Date(2025, 11, 30));
assert.deepStrictEqual(parseThreadDate('9/13', now), new Date(2026, 8, 13));
assert.deepStrictEqual(parseThreadDate('9/13/25', now), new Date(2025, 8, 13));
assert.deepStrictEqual(
  parseThreadDate('2026-09-12T08:00:00Z', now),
  new Date(2026, 8, 12)
);
assert.deepStrictEqual(parseThreadDate('8:27 AM', now), new Date(2026, 8, 14));
assert.deepStrictEqual(parseThreadDate('16:45', now), new Date(2026, 8, 14));
assert.strictEqual(parseThreadDate('not a date', now), null);
assert.deepStrictEqual(cutoffForDays(30, now), new Date(2026, 7, 16));

console.log('inbox-thread-date tests passed');
