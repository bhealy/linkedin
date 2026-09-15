const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  HOUR_LIMIT,
  FOUR_HOUR_LIMIT,
  HOUR_MS,
  FOUR_HOUR_MS,
  inspectPageOpens,
  claimPageOpen,
  nextAvailableAt,
  formatWait,
} = require('../lib/inbox-page-budget');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-page-budget-'));
const filePath = path.join(dir, 'inbox-page-opens.json');

function writeOpens(opens) {
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({ version: 1, opens }, null, 2)}\n`,
    'utf8'
  );
}

const now = Date.parse('2026-09-15T14:00:00.000Z');
writeOpens([]);

let snap = inspectPageOpens(now, filePath);
assert.strictEqual(snap.lastHour, 0);
assert.strictEqual(snap.lastFourHours, 0);
assert.strictEqual(snap.canOpen, true);
assert.strictEqual(snap.blocked, false);

const claimed = claimPageOpen({ now, filePath });
assert.strictEqual(claimed.allowed, true);
assert.strictEqual(claimed.snapshot.lastHour, 1);

writeOpens(Array.from({ length: HOUR_LIMIT }, (_, i) => now - 1000 - i));
snap = inspectPageOpens(now, filePath);
assert.strictEqual(snap.blocked, true);
assert.strictEqual(snap.lastHour, HOUR_LIMIT);
assert.ok(snap.waitMs > 0);

const denied = claimPageOpen({ now, filePath });
assert.strictEqual(denied.allowed, false);
assert.strictEqual(inspectPageOpens(now, filePath).lastHour, HOUR_LIMIT);

const forced = claimPageOpen({ now, filePath, override: true });
assert.strictEqual(forced.allowed, true);
assert.strictEqual(forced.overBudget, true);
assert.strictEqual(inspectPageOpens(now, filePath).lastHour, HOUR_LIMIT + 1);

const hourOpens = Array.from({ length: HOUR_LIMIT }, (_, i) => now - (HOUR_LIMIT - 1 - i) * 10);
assert.strictEqual(nextAvailableAt(hourOpens, now), hourOpens[0] + HOUR_MS);

const fourOpens = Array.from(
  { length: FOUR_HOUR_LIMIT },
  (_, i) => now - (FOUR_HOUR_LIMIT - 1 - i) * 10
);
assert.strictEqual(nextAvailableAt(fourOpens, now), fourOpens[0] + FOUR_HOUR_MS);

assert.strictEqual(formatWait(20 * 1000), 'less than a minute');
assert.strictEqual(formatWait(60 * 60 * 1000), 'about 1 hour');

fs.rmSync(dir, { recursive: true, force: true });
console.log('inbox-page-budget tests passed');
