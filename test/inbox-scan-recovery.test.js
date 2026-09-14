const assert = require('assert');
const {
  SCAN_BROWSER_RESTART_LIMIT,
  isLostContext,
  describeThreadOpenFailure,
  unreadAfterLostContext,
} = require('../lib/inbox-scan-recovery');

assert.strictEqual(SCAN_BROWSER_RESTART_LIMIT, 3);
assert.strictEqual(isLostContext(new Error('Target closed')), true);
assert.strictEqual(isLostContext(new Error('Attempted to use detached Frame')), true);
assert.strictEqual(
  isLostContext(new Error("Waiting for selector `.msg-s-event-listitem` failed")),
  false
);

const closed = describeThreadOpenFailure(new Error('Target closed'), '2-abc');
assert.strictEqual(closed.lostContext, true);
assert.strictEqual(closed.reason, 'browser session closed');
assert.strictEqual(closed.threadId, '2-abc');

const empty = describeThreadOpenFailure(
  new Error('Waiting for selector `.msg-s-event-listitem` failed'),
  '2-def'
);
assert.strictEqual(empty.lostContext, undefined);
assert.strictEqual(empty.reason, 'no message history in this conversation');

const timedOut = describeThreadOpenFailure(
  new Error('TimeoutError: Navigation timeout of 60000 ms exceeded'),
  '2-ghi'
);
assert.strictEqual(timedOut.reason, 'conversation timed out');

assert.strictEqual(unreadAfterLostContext({ row: { status: 'listed' } }), true);
assert.strictEqual(unreadAfterLostContext({ row: { status: 'error' } }), true);
assert.strictEqual(unreadAfterLostContext({ row: { status: 'skipped' } }), false);
assert.strictEqual(unreadAfterLostContext({ row: { status: 'candidate' } }), false);

console.log('inbox-scan-recovery tests passed');
