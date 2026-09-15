const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadConnectionsCsv,
  writeConnectionsCsv,
  isDisconnected,
  markDisconnected,
  mergeConnections,
} = require('../lib/connections-csv');
const { interpretRemoveResponse, isTrackedRemoved } = require('../lib/remove-response');
const { computeConnectionsAnalytics } = require('../lib/connections-analytics');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkedin-csv-'));
const file = path.join(dir, 'connections.csv');

writeConnectionsCsv(
  [
    {
      name: 'Ada',
      title: 'Engineer',
      profileUrl: 'https://www.linkedin.com/in/ada/',
      vanityName: 'ada',
      connectedOn: 'January 1, 2020',
      disconnected: false,
      disconnectedOn: '',
      protected: true,
    },
  ],
  file
);

const roundTrip = loadConnectionsCsv(file);
assert.strictEqual(roundTrip.length, 1);
assert.strictEqual(roundTrip[0].vanityName, 'ada');
assert.strictEqual(isDisconnected(roundTrip[0]), false);
assert.strictEqual(roundTrip[0].protected, true);

assert.strictEqual(markDisconnected(roundTrip, { vanityName: 'ada', disconnectedOn: '2026-09-02T10:00:00.000Z' }), 'updated');
assert.strictEqual(markDisconnected(roundTrip, { vanityName: 'ada' }), 'already');
assert.strictEqual(
  markDisconnected(roundTrip, {
    vanityName: 'bob',
    name: 'Bob',
    title: 'Recruiter',
    profileUrl: 'https://www.linkedin.com/in/bob/',
    disconnectedOn: '2026-09-02T10:00:00.000Z',
  }),
  'inserted'
);
writeConnectionsCsv(roundTrip, file);
const afterMark = loadConnectionsCsv(file);
assert.strictEqual(afterMark.filter((row) => isDisconnected(row)).length, 2);
assert.strictEqual(afterMark.find((row) => row.vanityName === 'bob').disconnectedOn, '2026-09-02T10:00:00.000Z');

const merged = mergeConnections(afterMark, [
  {
    name: 'Ada',
    title: 'Engineer',
    profileUrl: 'https://www.linkedin.com/in/ada/',
    vanityName: 'ada',
    connectedOn: 'January 1, 2020',
  },
]);
assert.strictEqual(isDisconnected(merged.find((row) => row.vanityName === 'ada')), false);
assert.strictEqual(merged.find((row) => row.vanityName === 'ada').protected, true);
assert.strictEqual(isDisconnected(merged.find((row) => row.vanityName === 'bob')), true);

assert.strictEqual(
  interpretRemoveResponse({ ok: true, status: 200, body: 'Connection removed.' }).outcome,
  'removed'
);
assert.strictEqual(
  interpretRemoveResponse({
    ok: false,
    status: 400,
    body: 'This person is no longer connected.',
  }).outcome,
  'already_disconnected'
);
assert.strictEqual(
  interpretRemoveResponse({ ok: false, status: 500, body: 'server exploded' }).outcome,
  'failed'
);

const state = { removed: { ada: { vanityName: 'ada' } } };
assert.strictEqual(isTrackedRemoved(state, 'ada'), true);
assert.strictEqual(isTrackedRemoved(state, 'ADA'), true);
assert.strictEqual(isTrackedRemoved(state, 'bob'), false);

const analytics = computeConnectionsAnalytics(afterMark);
assert.strictEqual(analytics.summary.total, 2);
assert.strictEqual(analytics.summary.disconnected, 2);
assert.strictEqual(analytics.summary.connected, 0);
assert.strictEqual(analytics.contacts.every((row) => row.disconnected), true);

fs.rmSync(dir, { recursive: true, force: true });
console.log('connections-csv tests passed');
