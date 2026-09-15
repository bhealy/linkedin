const SCAN_BROWSER_RESTART_LIMIT = 3;
// 999 is LinkedIn's own throttle code; it means the same thing as a 429.
const RATE_LIMIT_STATUSES = new Set([429, 999]);
const RATE_LIMIT_RETRY_LIMIT = 3;
const RATE_LIMIT_BASE_BACKOFF_MS = 30000;
const RATE_LIMIT_MAX_BACKOFF_MS = 600000;

function isLostContext(err) {
  return /Execution context was destroyed|Target closed|detached Frame|Session closed|Navigating frame/i.test(
    String(err && err.message)
  );
}

function isRateLimitStatus(status) {
  return RATE_LIMIT_STATUSES.has(Number(status));
}

// Retry-After is either a delay in seconds or an HTTP date.
function parseRetryAfterMs(value, now = Date.now()) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) {
    return 0;
  }
  if (/^\d+$/.test(raw)) {
    return Number(raw) * 1000;
  }
  const at = Date.parse(raw);
  return Number.isNaN(at) ? 0 : Math.max(0, at - now);
}

function describeRateLimit(status, retryAfterHeader, threadId, now = Date.now()) {
  if (!isRateLimitStatus(status)) {
    return null;
  }
  return {
    opened: false,
    rateLimited: true,
    retryable: true,
    status: Number(status),
    retryAfterMs: parseRetryAfterMs(retryAfterHeader, now),
    reason: `LinkedIn rate limited the request (HTTP ${Number(status)})`,
    threadId: threadId || '',
  };
}

function rateLimitBackoffMs(attempt, retryAfterMs = 0) {
  const step = RATE_LIMIT_BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(
    RATE_LIMIT_MAX_BACKOFF_MS,
    Math.max(step, Number(retryAfterMs) || 0)
  );
}

function describeThreadOpenFailure(err, threadId, options = {}) {
  if (isLostContext(err)) {
    return {
      opened: false,
      lostContext: true,
      reason: 'browser session closed',
      threadId: threadId || '',
      error: err,
    };
  }
  const message = String((err && err.message) || '');
  if (/Waiting for selector `.msg-s-event-listitem` failed/i.test(message)) {
    // An empty thread still renders the message pane. If even that is missing
    // the page never became a conversation, so the thread is still unread and
    // must not be recorded as having no history.
    if (options.messagingUiRendered === false) {
      return {
        opened: false,
        retryable: true,
        reason: 'the conversation pane never loaded',
        threadId: threadId || '',
      };
    }
    return {
      opened: false,
      reason: 'no message history in this conversation',
      threadId: threadId || '',
    };
  }
  // Puppeteer reports a waitForFunction timeout as "Waiting failed: Nms
  // exceeded", which carries no "timeout" wording of its own.
  if (/timeout|waiting for|waiting failed/i.test(message)) {
    return {
      opened: false,
      retryable: true,
      reason: 'conversation timed out',
      threadId: threadId || '',
    };
  }
  // The thread was never observed, so it stays unread rather than being given
  // a verdict that would stop it being tried again.
  return {
    opened: false,
    retryable: true,
    reason: 'conversation did not open',
    threadId: threadId || '',
  };
}

// Runs before every pass to drop threads already read, so a browser restart
// does not re-open them. A verdict recorded against older activity is not a
// read of the thread as it stands now: the queue only holds threads that
// changed, and a read in this pass stamps examinedActivity with the activity
// we queued. Treating those as done silently skipped the re-read.
function unreadAfterLostContext(entry) {
  const row = (entry && entry.row) || {};
  const status = String(row.status || 'listed');
  if (!status || status === 'listed' || status === 'error') {
    return true;
  }
  return String(row.examinedActivity || '') !== String(entry?.activityText || '');
}

module.exports = {
  SCAN_BROWSER_RESTART_LIMIT,
  RATE_LIMIT_RETRY_LIMIT,
  isLostContext,
  isRateLimitStatus,
  parseRetryAfterMs,
  describeRateLimit,
  rateLimitBackoffMs,
  describeThreadOpenFailure,
  unreadAfterLostContext,
};
