const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadInboxCsv,
  writeInboxCsv,
  upsertListedConversation,
  findInboxRow,
  needsExamineWithParser,
  isUnrequitedCandidate,
  isObfuscatedVanity,
  prefersIncomingVanity,
  markInboxDisconnected,
  applyExamineOutcome,
  emptyInboxRow,
  listCaughtUp,
} = require('../lib/inbox-csv');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-csv-'));
const file = path.join(dir, 'unrequited-love.csv');

const parseActivity = (text) => {
  if (text === 'Sep 13') {
    return new Date(2026, 8, 13);
  }
  if (text === 'Aug 1') {
    return new Date(2026, 7, 1);
  }
  return null;
};
const cutoff = new Date(2026, 8, 1);

fs.writeFileSync(
  file,
  'name,title,profile_url,vanity_name,connected_on,disconnected,disconnected_on,last_activity,inbound_count,scanned_at\nAda,Engineer,https://www.linkedin.com/in/ada/,ada,,,,Sep 13,2,2026-09-14T12:00:00.000Z\n',
  'utf8'
);

const legacy = loadInboxCsv(file);
assert.strictEqual(legacy.length, 1);
assert.strictEqual(legacy[0].status, 'candidate');
assert.strictEqual(legacy[0].examinedActivity, 'Sep 13');
assert.strictEqual(isUnrequitedCandidate(legacy[0]), true);
assert.strictEqual(needsExamineWithParser(legacy[0], cutoff, parseActivity), false);

legacy[0].lastActivity = 'Sep 14';
legacy[0].snippet = 'new hello';
assert.strictEqual(needsExamineWithParser(legacy[0], cutoff, parseActivity), true);

const rows = [];
upsertListedConversation(rows, {
  name: 'Bea',
  activityText: 'Sep 13',
  snippet: 'hi',
  threadId: 't1',
  connection: {
    profileUrl: 'https://www.linkedin.com/in/bea/',
    vanityName: 'bea',
    protected: true,
  },
});
assert.strictEqual(rows[0].status, 'listed');
assert.strictEqual(rows[0].protected, true);
assert.strictEqual(needsExamineWithParser(rows[0], cutoff, parseActivity), true);
assert.strictEqual(isUnrequitedCandidate(rows[0]), false);

applyExamineOutcome(
  rows[0],
  { status: 'replied' },
  {
    inbound: 2,
    outbound: 1,
    activityText: 'Sep 13',
    messages: [{ direction: 'in', text: 'hi', at: 'Sep 13', sender: 'Bea' }],
  }
);
assert.strictEqual(needsExamineWithParser(rows[0], cutoff, parseActivity), false);

const listedAgain = upsertListedConversation(rows, {
  name: 'Bea',
  activityText: 'Sep 14',
  snippet: 'newer',
  threadId: 't1',
});
assert.strictEqual(listedAgain.activityChanged, true);
assert.strictEqual(rows[0].lastActivity, 'Sep 14');
assert.strictEqual(needsExamineWithParser(rows[0], cutoff, parseActivity), true);

const old = emptyListed('Cal', 'Aug 1');
assert.strictEqual(needsExamineWithParser(old, cutoff, parseActivity), false);

writeInboxCsv(rows, file);
const roundTrip = loadInboxCsv(file);
assert.strictEqual(roundTrip[0].threadId, 't1');
assert.strictEqual(roundTrip[0].status, 'replied');
assert.strictEqual(roundTrip[0].protected, true);
assert.strictEqual(roundTrip[0].messages[0].text, 'hi');
assert.strictEqual(findInboxRow(roundTrip, { threadId: 't1', name: 'Bea' }).name, 'Bea');

assert.strictEqual(
  listCaughtUp(
    [
      { name: 'Bea', activityText: 'Sep 14', snippet: 'newer', threadId: 't1' },
      { name: 'Bea', activityText: 'Sep 14', snippet: 'newer', threadId: 't1' },
      { name: 'Bea', activityText: 'Sep 14', snippet: 'newer', threadId: 't1' },
      { name: 'Bea', activityText: 'Sep 14', snippet: 'newer', threadId: 't1' },
      { name: 'Bea', activityText: 'Sep 14', snippet: 'newer', threadId: 't1' },
      { name: 'Bea', activityText: 'Sep 14', snippet: 'newer', threadId: 't1' },
      { name: 'Bea', activityText: 'Sep 14', snippet: 'newer', threadId: 't1' },
      { name: 'Bea', activityText: 'Sep 14', snippet: 'newer', threadId: 't1' },
    ],
    roundTrip
  ),
  true
);

const disconnectedAt = '2026-09-14T15:00:00.000Z';
assert.strictEqual(
  markInboxDisconnected(rows, { vanityName: 'bea' }, disconnectedAt),
  1
);
assert.strictEqual(isUnrequitedCandidate(rows[0]), false);
upsertListedConversation(rows, {
  name: 'Bea',
  activityText: 'Sep 15',
  snippet: 'latest',
  threadId: 't1',
});
assert.strictEqual(rows[0].disconnected, 'yes');
assert.strictEqual(rows[0].disconnectedOn, disconnectedAt);
assert.strictEqual(needsExamineWithParser(rows[0], cutoff, parseActivity), false);
writeInboxCsv(rows, file);
const disconnectedRoundTrip = loadInboxCsv(file);
assert.strictEqual(disconnectedRoundTrip[0].disconnected, 'yes');
assert.strictEqual(disconnectedRoundTrip[0].disconnectedOn, disconnectedAt);

// A thread read must never trade a public slug for the thread's opaque member
// id, or the scan has to load a profile page to recover what it already had.
const obfuscated = 'ACoAAExampleOpaqueMemberId00000000000';
const keepsSlug = emptyInboxRow({
  name: 'Bea',
  profileUrl: 'https://www.linkedin.com/in/bea/',
  vanityName: 'bea',
});
applyExamineOutcome(
  keepsSlug,
  { status: 'candidate' },
  {
    profileUrl: `https://www.linkedin.com/in/${obfuscated}`,
    vanityName: obfuscated,
    activityText: 'Sep 14',
  }
);
assert.strictEqual(keepsSlug.vanityName, 'bea');
assert.strictEqual(keepsSlug.profileUrl, 'https://www.linkedin.com/in/bea/');
assert.strictEqual(keepsSlug.status, 'candidate');

// An opaque id is still better than nothing, and a real slug replaces it.
const takesAnything = emptyInboxRow({ name: 'Cass' });
applyExamineOutcome(
  takesAnything,
  { status: 'candidate' },
  {
    profileUrl: `https://www.linkedin.com/in/${obfuscated}`,
    vanityName: obfuscated,
    activityText: 'Sep 14',
  }
);
assert.strictEqual(takesAnything.vanityName, obfuscated);
applyExamineOutcome(
  takesAnything,
  { status: 'candidate' },
  {
    profileUrl: 'https://www.linkedin.com/in/cass/',
    vanityName: 'cass',
    activityText: 'Sep 15',
  }
);
assert.strictEqual(takesAnything.vanityName, 'cass');
assert.strictEqual(takesAnything.profileUrl, 'https://www.linkedin.com/in/cass/');

assert.strictEqual(isObfuscatedVanity(obfuscated), true);
assert.strictEqual(isObfuscatedVanity('bea'), false);
assert.strictEqual(isObfuscatedVanity(''), false);
assert.strictEqual(prefersIncomingVanity('', obfuscated), true);
assert.strictEqual(prefersIncomingVanity('bea', obfuscated), false);
assert.strictEqual(prefersIncomingVanity(obfuscated, 'bea'), true);
assert.strictEqual(prefersIncomingVanity('bea', ''), false);
// Two usable slugs: keep the one already stored rather than churning it.
assert.strictEqual(prefersIncomingVanity('bea', 'bea-2'), false);
assert.strictEqual(prefersIncomingVanity(obfuscated, obfuscated), false);

function emptyListed(name, activityText) {
  return {
    name,
    lastActivity: activityText,
    snippet: '',
    status: 'listed',
    disconnected: '',
    examinedActivity: '',
  };
}

console.log('inbox-csv tests passed');
