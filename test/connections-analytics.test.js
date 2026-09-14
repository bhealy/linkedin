const assert = require('assert');
const {
  computeConnectionsAnalytics,
  filterConnectionsByConnectedOn,
} = require('../lib/connections-analytics');

const rows = [
  { name: 'Ada', title: 'Founder & CEO @ Acme', connectedOn: 'January 5, 2021' },
  { name: 'Ben', title: 'Software Engineer at Widget', connectedOn: 'March 12, 2024' },
  { name: 'Cara', title: 'Sales Director', connectedOn: 'June 1, 2024' },
  { name: 'Dan', title: 'Intern', connectedOn: '', disconnected: 'yes' },
];

const all = computeConnectionsAnalytics(rows);
assert.strictEqual(all.summary.total, 4);
assert.strictEqual(all.summary.connected, 3);
assert.strictEqual(all.summary.disconnected, 1);
assert.ok(all.charts.activityByYear.some((item) => item.label === '2024' && item.count === 2));

const filtered = filterConnectionsByConnectedOn(rows, { from: '2024-01-01', to: '2024-12-31' });
assert.deepStrictEqual(filtered.map((row) => row.name), ['Ben', 'Cara']);

const fromOnly = filterConnectionsByConnectedOn(rows, { from: '2024-03-01' });
assert.deepStrictEqual(fromOnly.map((row) => row.name), ['Ben', 'Cara']);

const toOnly = filterConnectionsByConnectedOn(rows, { to: '2021-12-31' });
assert.deepStrictEqual(toOnly.map((row) => row.name), ['Ada']);

const empty = filterConnectionsByConnectedOn(rows, { from: '2010-01-01', to: '2010-12-31' });
assert.strictEqual(empty.length, 0);

const unfiltered = filterConnectionsByConnectedOn(rows, {});
assert.strictEqual(unfiltered.length, 4);

const scoped = computeConnectionsAnalytics(filtered);
assert.strictEqual(scoped.summary.total, 2);
assert.strictEqual(scoped.summary.connected, 2);
assert.ok(!scoped.charts.activityByYear.some((item) => item.label === '2021'));

console.log('connections-analytics tests passed');
