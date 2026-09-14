const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadInboxCsv } = require('../lib/inbox-csv');
const {
  applyUnrequitedSafeList,
  isInboxCsv,
  loadTargetsFromCsv,
  parseArgs,
  persistDisconnectedOnInbox,
} = require('../remove-connections');

const defaultArgs = parseArgs(['node', 'remove-connections.js']);
assert.strictEqual(defaultArgs.protectUnrequited, true);
assert.deepStrictEqual(defaultArgs.safeKeywords, []);

const disabledArgs = parseArgs([
  'node',
  'remove-connections.js',
  '--no-unrequited-safe-list',
  '--safe-keywords',
  'advisor, ambassador',
]);
assert.strictEqual(disabledArgs.protectUnrequited, false);
assert.deepStrictEqual(disabledArgs.safeKeywords, ['advisor', 'ambassador']);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remove-connections-'));
const inboxPath = path.join(dir, 'inbox.csv');
fs.writeFileSync(
  inboxPath,
  [
    'name,title,profile_url,vanity_name,connected_on,disconnected,disconnected_on,thread_id,last_activity,snippet,status,inbound_count,outbound_count,examined_activity,scanned_at,listed_at',
    'Ada,Founder,https://www.linkedin.com/in/ada/,ada,,,,thread-1,Sep 13,,candidate,1,0,Sep 13,,',
    'Bea,Software Engineer,https://www.linkedin.com/in/bea/,bea,,,,thread-2,Sep 13,,candidate,1,0,Sep 13,,',
    '',
  ].join('\n'),
  'utf8'
);

assert.strictEqual(isInboxCsv(inboxPath), true);
const inboxRows = loadInboxCsv(inboxPath);
const targets = loadTargetsFromCsv(inboxPath, defaultArgs, inboxRows);
const filtered = applyUnrequitedSafeList(targets, inboxRows, defaultArgs);
assert.deepStrictEqual(
  filtered.protectedTargets.map((target) => target.vanityName),
  ['ada']
);
assert.deepStrictEqual(
  filtered.pending.map((target) => target.vanityName),
  ['bea']
);
assert.strictEqual(inboxRows[1].disconnected, '');
const unprotected = applyUnrequitedSafeList(targets, inboxRows, disabledArgs);
assert.strictEqual(unprotected.protectedTargets.length, 0);
assert.strictEqual(unprotected.pending.length, 2);

const disconnectedAt = '2026-09-14T15:30:00.000Z';
assert.strictEqual(
  persistDisconnectedOnInbox(
    inboxRows,
    inboxPath,
    filtered.pending[0],
    disconnectedAt
  ),
  1
);
const persisted = loadInboxCsv(inboxPath);
assert.strictEqual(persisted[0].disconnected, '');
assert.strictEqual(persisted[1].disconnected, 'yes');
assert.strictEqual(persisted[1].disconnectedOn, disconnectedAt);

console.log('remove-connections tests passed');
