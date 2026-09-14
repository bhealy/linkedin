const assert = require('assert');
const {
  activityMs,
  filterConversations,
  computeInboxAnalytics,
  paginateConversations,
} = require('../lib/inbox-analytics');

const rows = [
  {
    name: 'Ada',
    title: 'Founder & CEO',
    profileUrl: 'https://www.linkedin.com/in/ada/',
    lastActivity: '2024-02-20T10:00:00.000Z',
    lastActivityMs: '1708423200000',
    snippet: 'Hello',
    status: 'candidate',
    inbound: '2',
    outbound: '0',
    examinedActivity: 'Feb 20',
  },
  {
    name: 'Bea',
    title: 'Software Engineer',
    lastActivity: '2023-12-04T10:00:00.000Z',
    snippet: 'Thanks',
    status: 'replied',
    inbound: '1',
    outbound: '1',
    examinedActivity: 'Dec 4',
  },
  {
    name: 'Cal',
    title: '',
    lastActivity: '',
    status: 'listed',
    disconnected: 'yes',
  },
];

assert.strictEqual(activityMs(rows[0]), 1708423200000);
assert.strictEqual(activityMs({ lastActivityMs: '1708423200' }), 1708423200000);
assert.strictEqual(activityMs(rows[2]), null);

assert.deepStrictEqual(
  filterConversations(rows, { q: 'software' }).map((row) => row.name),
  ['Bea']
);
assert.deepStrictEqual(
  filterConversations(rows, { unrequited: 'true' }).map((row) => row.name),
  ['Ada']
);
assert.deepStrictEqual(
  filterConversations(rows, { disconnected: 'true' }).map((row) => row.name),
  ['Cal']
);
assert.deepStrictEqual(
  filterConversations(rows, { protected: 'true' }).map((row) => row.name),
  ['Ada']
);
assert.deepStrictEqual(
  filterConversations(rows, { from: '2024-01-01' }).map((row) => row.name),
  ['Ada']
);

const analytics = computeInboxAnalytics(rows, { cacheComplete: false });
assert.strictEqual(analytics.summary.total, 3);
assert.strictEqual(analytics.summary.unrequited, 1);
assert.strictEqual(analytics.summary.replied, 1);
assert.strictEqual(analytics.summary.disconnected, 1);
assert.strictEqual(analytics.summary.protectedTitles, 1);
assert.strictEqual(analytics.summary.examined, 2);
assert.strictEqual(analytics.summary.listedOnly, 1);
assert.strictEqual(analytics.summary.profileLinked, 1);
assert.strictEqual(analytics.summary.dated, 2);
assert.strictEqual(analytics.summary.cacheComplete, false);
assert.deepStrictEqual(
  analytics.charts.activityByYear,
  [
    { label: '2023', count: 1 },
    { label: '2024', count: 1 },
  ]
);

const page = paginateConversations(rows, { page: 2, limit: 2 });
assert.strictEqual(page.pagination.total, 3);
assert.strictEqual(page.pagination.pageCount, 2);
assert.strictEqual(page.rows.length, 1);

console.log('inbox-analytics tests passed');
