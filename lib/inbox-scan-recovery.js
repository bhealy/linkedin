const SCAN_BROWSER_RESTART_LIMIT = 3;

function isLostContext(err) {
  return /Execution context was destroyed|Target closed|detached Frame|Session closed|Navigating frame/i.test(
    String(err && err.message)
  );
}

function describeThreadOpenFailure(err, threadId) {
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
    return {
      opened: false,
      reason: 'no message history in this conversation',
      threadId: threadId || '',
    };
  }
  if (/timeout|waiting for/i.test(message)) {
    return {
      opened: false,
      reason: 'conversation timed out',
      threadId: threadId || '',
    };
  }
  return {
    opened: false,
    reason: 'conversation did not open',
    threadId: threadId || '',
  };
}

function unreadAfterLostContext(entry) {
  const status = String((entry && entry.row && entry.row.status) || 'listed');
  return !status || status === 'listed' || status === 'error';
}

module.exports = {
  SCAN_BROWSER_RESTART_LIMIT,
  isLostContext,
  describeThreadOpenFailure,
  unreadAfterLostContext,
};
