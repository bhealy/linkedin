'use strict';

const assert = require('assert');
const {
  parseProgressFromLine,
  formatEtaRemaining,
  formatPace,
  createJobEtaTracker,
} = require('../lib/job-eta');

assert.deepStrictEqual(parseProgressFromLine('[720/8795] Ada Lovelace (Sep 13)'), {
  current: 720,
  total: 8795,
  source: 'bracket',
});

assert.deepStrictEqual(
  parseProgressFromLine(
    '[12:04] page 3 · +40 new · 120/5,000 this run (2%) · 8,120 saved'
  ),
  {
    current: 120,
    total: 5000,
    source: 'download-run',
  }
);

assert.deepStrictEqual(
  parseProgressFromLine(
    'Listing… 1,234 connection conversation(s) of 1,500 listed, back to Jan 2020'
  ),
  {
    current: 1500,
    total: null,
    kept: 1234,
    source: 'listing',
  }
);

assert.deepStrictEqual(
  parseProgressFromLine(
    'Listed 200 connection conversation(s) of 250; 40 in the latest window, 35 need a thread read, reading 35 with 3 tab(s).'
  ),
  {
    current: 0,
    total: 35,
    source: 'reading-total',
  }
);

assert.strictEqual(parseProgressFromLine('Signed in as Ada'), null);
assert.strictEqual(formatEtaRemaining(20_000), 'less than a minute remaining');
assert.strictEqual(formatEtaRemaining(60_000), 'about 1 minute remaining');
assert.strictEqual(formatEtaRemaining(10 * 60_000), 'about 10m remaining');
assert.strictEqual(formatEtaRemaining(4 * 3600_000 + 55 * 60_000), 'about 4h 55m remaining');
assert.strictEqual(formatPace(2 / 60_000, 'conversations'), '~2.0 conversations/min');

const tracker = createJobEtaTracker({ startedAt: 1_000_000 });
tracker.observe('[100/1000] a', 1_000_000 + 60_000);
const mid = tracker.observe('[200/1000] b', 1_000_000 + 120_000);
assert.ok(mid.progress);
assert.strictEqual(mid.progress.current, 200);
assert.strictEqual(mid.progress.total, 1000);
assert.ok(mid.etaMs > 0);
assert.match(mid.etaLabel, /remaining$/);

const listing = createJobEtaTracker({ startedAt: 2_000_000 });
listing.observe('Listing… 40 connection conversation(s) of 50 listed', 2_000_000 + 30_000);
const paced = listing.observe(
  'Listing… 80 connection conversation(s) of 100 listed',
  2_000_000 + 60_000
);
assert.strictEqual(paced.progress.total, null);
assert.ok(paced.etaLabel);
assert.match(paced.etaLabel, /conversations/);

console.log('job-eta tests passed');
