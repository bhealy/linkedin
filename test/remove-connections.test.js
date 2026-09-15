const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadInboxCsv } = require('../lib/inbox-csv');
const {
  applyExplicitProtection,
  applyUnrequitedInboundFilter,
  applyUnrequitedSafeList,
  isInboxCsv,
  loadTargetsFromCsv,
  parseArgs,
  persistDisconnectedOnInbox,
} = require('../remove-connections');
const {
  listSourceContacts,
  setSourceContactProtected,
} = require('../lib/source-protection');

const defaultArgs = parseArgs(['node', 'remove-connections.js']);
assert.strictEqual(defaultArgs.protectUnrequited, true);
assert.strictEqual(defaultArgs.includeSingleMessage, false);
assert.deepStrictEqual(defaultArgs.safeKeywords, []);

const disabledArgs = parseArgs([
  'node',
  'remove-connections.js',
  '--no-unrequited-safe-list',
  '--include-single-message',
  '--safe-keywords',
  'advisor, ambassador',
]);
assert.strictEqual(disabledArgs.protectUnrequited, false);
assert.strictEqual(disabledArgs.includeSingleMessage, true);
assert.deepStrictEqual(disabledArgs.safeKeywords, ['advisor', 'ambassador']);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remove-connections-'));
const inboxPath = path.join(dir, 'inbox.csv');
fs.writeFileSync(
  inboxPath,
  [
    'name,title,profile_url,vanity_name,connected_on,disconnected,disconnected_on,thread_id,last_activity,snippet,status,inbound_count,outbound_count,examined_activity,scanned_at,listed_at',
    'Ada,Founder,https://www.linkedin.com/in/ada/,ada,,,,thread-1,Sep 13,,candidate,1,0,Sep 13,,',
    'Bea,Software Engineer,https://www.linkedin.com/in/bea/,bea,,,,thread-2,Sep 13,,candidate,2,0,Sep 13,,',
    'Cal,Product Manager,https://www.linkedin.com/in/cal/,cal,,,,thread-3,Sep 13,,candidate,1,0,Sep 13,,',
    'Dee,Founder,https://www.linkedin.com/in/dee/,dee,,,,thread-4,Sep 13,,candidate,3,0,Sep 13,,',
    '',
  ].join('\n'),
  'utf8'
);

assert.strictEqual(isInboxCsv(inboxPath), true);
const inboxRows = loadInboxCsv(inboxPath);
const targets = loadTargetsFromCsv(inboxPath, defaultArgs, inboxRows);
assert.deepStrictEqual(
  targets.map((target) => target.vanityName),
  ['ada', 'bea', 'cal', 'dee']
);
assert.deepStrictEqual(
  targets.map((target) => target.inbound),
  [1, 2, 1, 3]
);

const inboundFiltered = applyUnrequitedInboundFilter(targets, inboxRows, defaultArgs);
assert.deepStrictEqual(
  inboundFiltered.pending.map((target) => target.vanityName),
  ['bea', 'dee']
);
assert.deepStrictEqual(
  inboundFiltered.skipped.map((target) => target.vanityName),
  ['ada', 'cal']
);
const inboundIncluded = applyUnrequitedInboundFilter(targets, inboxRows, disabledArgs);
assert.deepStrictEqual(
  inboundIncluded.pending.map((target) => target.vanityName),
  ['ada', 'bea', 'cal', 'dee']
);
assert.strictEqual(inboundIncluded.skipped.length, 0);

const explicit = applyExplicitProtection([
  { vanityName: 'ada', protected: true },
  { vanityName: 'bea', protected: false },
]);
assert.deepStrictEqual(
  explicit.protectedTargets.map((target) => target.vanityName),
  ['ada']
);
assert.deepStrictEqual(
  explicit.pending.map((target) => target.vanityName),
  ['bea']
);

const filtered = applyUnrequitedSafeList(inboundFiltered.pending, inboxRows, defaultArgs);
assert.deepStrictEqual(
  filtered.protectedTargets.map((target) => target.vanityName),
  ['dee']
);
assert.deepStrictEqual(
  filtered.pending.map((target) => target.vanityName),
  ['bea']
);
assert.strictEqual(inboxRows[1].disconnected, '');
const unprotected = applyUnrequitedSafeList(
  inboundIncluded.pending,
  inboxRows,
  disabledArgs
);
assert.strictEqual(unprotected.protectedTargets.length, 0);
assert.strictEqual(unprotected.pending.length, 4);

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

const salesPath = path.join(dir, 'sales.csv');
fs.writeFileSync(
  salesPath,
  [
    'name,title,profile_url,status,search_id,geo',
    'Ada,Engineer,https://www.linkedin.com/in/ada/,sales,s1,IE',
    'Bea,Founder,https://www.linkedin.com/in/bea/,sales,s2,GB',
    '',
  ].join('\n'),
  'utf8'
);
let sales = listSourceContacts(salesPath, { pageSize: 1 });
assert.strictEqual(sales.total, 2);
assert.strictEqual(sales.pages, 2);
assert.strictEqual(sales.contacts[0].protected, false);
assert.strictEqual(sales.contacts[0].key, 'https://www.linkedin.com/in/ada/');
setSourceContactProtected(salesPath, sales.contacts[0].key, true);
sales = listSourceContacts(salesPath, { query: 'ada' });
assert.strictEqual(sales.filtered, 1);
assert.strictEqual(sales.contacts[0].protected, true);
const protectedSalesTargets = loadTargetsFromCsv(salesPath, defaultArgs);
assert.strictEqual(
  protectedSalesTargets.find((target) => target.name === 'Ada').protected,
  true
);
assert.match(fs.readFileSync(salesPath, 'utf8').split('\n')[0], /,protected$/);
setSourceContactProtected(salesPath, sales.contacts[0].key, false);
sales = listSourceContacts(salesPath, { query: 'ada' });
assert.strictEqual(sales.contacts[0].protected, false);

console.log('remove-connections tests passed');
