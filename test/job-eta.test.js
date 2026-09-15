'use strict';

const assert = require('assert');
const {
  parsePhaseFromLine,
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

assert.deepStrictEqual(
  parseProgressFromLine('Resolving profile names for 50 candidate(s) across 1 tab(s)…'),
  {
    current: 0,
    total: 50,
    source: 'resolving-total',
  }
);

assert.deepStrictEqual(parsePhaseFromLine('Resolving profile names for 50 candidate(s)…'), {
  label: 'Resolving profiles',
  unit: 'profiles',
});
assert.deepStrictEqual(
  parsePhaseFromLine('Listed 10 of 10; 3 need a thread read, reading 3 with 1 tab(s).'),
  { label: 'Reading conversations', unit: 'conversations' }
);
assert.deepStrictEqual(parsePhaseFromLine('Listing… 40 connection conversation(s) of 50 listed'), {
  label: 'Listing conversations',
  unit: 'conversations',
});
assert.strictEqual(parsePhaseFromLine('Signed in as Ada'), null);
assert.strictEqual(parsePhaseFromLine(''), null);

// The profile phase used to be invisible, leaving the finished conversation
// count ("3/3 · finishing…") on screen while profiles were still loading.
const phases = createJobEtaTracker({ startedAt: 3_000_000 });
phases.observe(
  'Listed 10 connection conversation(s) of 10; 10 in the latest window, 3 need a thread read, reading 3 with 1 tab(s).',
  3_000_000
);
const reading = phases.observe('[3/3] Ada Lovelace (6:45 PM) — keeping: 1 in, 1 out', 3_030_000);
assert.strictEqual(reading.progress.phase, 'Reading conversations');
assert.strictEqual(reading.progress.current, 3);
assert.strictEqual(reading.etaLabel, 'finishing…');

const started = phases.observe(
  'Resolving profile names for 50 candidate(s) across 1 tab(s)…',
  3_040_000
);
assert.strictEqual(started.progress.phase, 'Resolving profiles');
assert.strictEqual(started.progress.current, 0);
assert.strictEqual(started.progress.total, 50);
// The previous phase's samples must not leak in and claim this one is done.
assert.notStrictEqual(started.etaLabel, 'finishing…');

phases.observe('  [10/50] Ada Lovelace → ada-lovelace', 3_080_000);
const resolving = phases.observe('  [20/50] Alan Turing → alan-turing', 3_120_000);
assert.strictEqual(resolving.progress.phase, 'Resolving profiles');
assert.strictEqual(resolving.progress.current, 20);
assert.strictEqual(resolving.progress.total, 50);
assert.ok(resolving.etaMs > 0);
assert.match(resolving.paceLabel, /profiles\/min$/);

// A row that cannot be resolved still advances the phase.
const unresolved = phases.observe(
  '  [21/50] Ada Lovelace: could not resolve a profile name',
  3_124_000
);
assert.strictEqual(unresolved.progress.current, 21);

console.log('job-eta tests passed');
