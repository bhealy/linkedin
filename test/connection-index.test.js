const assert = require('assert');
const {
  buildConnectionIndex,
  isGroupThread,
  matchConnection,
  normaliseName,
} = require('../lib/connection-index');

assert.strictEqual(normaliseName('Harjot Gill, PMP'), 'harjot gill');
assert.strictEqual(normaliseName('Ada Lovelace (Acme)'), 'ada lovelace');
assert.strictEqual(normaliseName('  Síle   Ó Brien 🚀 '), 'sile o brien');
assert.strictEqual(normaliseName(''), '');

assert.strictEqual(isGroupThread('Harjot Gill, PMP'), false);
assert.strictEqual(isGroupThread('Scott Bewley, MBA AI'), false);
assert.strictEqual(isGroupThread('Alice Smith and Bob Jones'), true);
assert.strictEqual(isGroupThread('Alice Smith, Bob Jones'), true);
assert.strictEqual(isGroupThread('Alice Smith, Bob Jones, Carol Woods'), true);
assert.strictEqual(isGroupThread('Sanjesh Kumar'), false);

const index = buildConnectionIndex([
  { name: 'Harjot Gill', vanityName: 'harjotgill', title: 'CEO', profileUrl: 'u/1', connectedOn: '2024-01-02' },
  { name: 'Alice Smith', vanityName: 'alice-1' },
  { name: 'Alice Smith', vanityName: 'alice-2' },
  { name: 'Gone Person', vanityName: 'gone', disconnected: true },
]);

const hit = matchConnection(index, 'Harjot Gill, PMP');
assert.strictEqual(hit.reason, 'connection');
assert.strictEqual(hit.match.vanityName, 'harjotgill');
assert.strictEqual(hit.ambiguous, false);

// Two connections share a name, so the profile has to come from the thread read.
const dupe = matchConnection(index, 'Alice Smith');
assert.strictEqual(dupe.reason, 'connection');
assert.strictEqual(dupe.match, null);
assert.strictEqual(dupe.ambiguous, true);

assert.strictEqual(matchConnection(index, 'Random Recruiter').reason, 'not-a-connection');
assert.strictEqual(matchConnection(index, 'Gone Person').reason, 'not-a-connection');
assert.strictEqual(matchConnection(index, 'Alice Smith and Bob Jones').reason, 'group');
assert.strictEqual(matchConnection(index, '').reason, 'unnamed');

console.log('connection-index tests passed');
