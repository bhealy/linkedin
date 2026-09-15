const assert = require('assert');
const {
  RATE_LIMIT_RETRY_LIMIT,
  SCAN_BROWSER_RESTART_LIMIT,
  describeRateLimit,
  isLostContext,
  isRateLimitStatus,
  parseRetryAfterMs,
  rateLimitBackoffMs,
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

// A throttled page renders no message pane, so it must stay retryable rather
// than being recorded as a conversation with no history.
const unrendered = describeThreadOpenFailure(
  new Error('Waiting for selector `.msg-s-event-listitem` failed'),
  '2-jkl',
  { messagingUiRendered: false }
);
assert.strictEqual(unrendered.retryable, true);
assert.strictEqual(unrendered.reason, 'the conversation pane never loaded');

const emptyButRendered = describeThreadOpenFailure(
  new Error('Waiting for selector `.msg-s-event-listitem` failed'),
  '2-mno',
  { messagingUiRendered: true }
);
assert.strictEqual(emptyButRendered.retryable, undefined);
assert.strictEqual(emptyButRendered.reason, 'no message history in this conversation');

assert.strictEqual(isRateLimitStatus(429), true);
assert.strictEqual(isRateLimitStatus(999), true);
assert.strictEqual(isRateLimitStatus(200), false);
assert.strictEqual(isRateLimitStatus(503), false);

assert.strictEqual(parseRetryAfterMs('120'), 120000);
assert.strictEqual(parseRetryAfterMs(''), 0);
assert.strictEqual(parseRetryAfterMs(undefined), 0);
assert.strictEqual(parseRetryAfterMs('not-a-date'), 0);
const now = Date.parse('2026-09-15T10:00:00Z');
assert.strictEqual(
  parseRetryAfterMs('Tue, 15 Sep 2026 10:01:00 GMT', now),
  60000
);
// A date already in the past must not produce a negative wait.
assert.strictEqual(parseRetryAfterMs('Tue, 15 Sep 2026 09:59:00 GMT', now), 0);

assert.strictEqual(describeRateLimit(200, null, '2-abc'), null);
const limited = describeRateLimit(429, '90', '2-pqr');
assert.strictEqual(limited.rateLimited, true);
assert.strictEqual(limited.retryable, true);
assert.strictEqual(limited.opened, false);
assert.strictEqual(limited.status, 429);
assert.strictEqual(limited.retryAfterMs, 90000);
assert.strictEqual(limited.threadId, '2-pqr');
assert.match(limited.reason, /HTTP 429/);

// Backoff grows per attempt and never undercuts Retry-After.
assert.strictEqual(rateLimitBackoffMs(1), 30000);
assert.strictEqual(rateLimitBackoffMs(2), 60000);
assert.strictEqual(rateLimitBackoffMs(3), 120000);
assert.strictEqual(rateLimitBackoffMs(1, 90000), 90000);
assert.strictEqual(rateLimitBackoffMs(1, 5000), 30000);
assert.strictEqual(rateLimitBackoffMs(99), 600000);
assert.strictEqual(RATE_LIMIT_RETRY_LIMIT, 3);

assert.strictEqual(unreadAfterLostContext({ row: { status: 'listed' } }), true);
assert.strictEqual(unreadAfterLostContext({ row: { status: 'error' } }), true);
assert.strictEqual(unreadAfterLostContext({ row: { status: 'skipped' } }), false);
assert.strictEqual(unreadAfterLostContext({ row: { status: 'candidate' } }), false);

console.log('inbox-scan-recovery tests passed');
