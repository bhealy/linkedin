const fs = require('fs');
const path = require('path');
const { writeProtectedFile } = require('./rolling-backup');

const DEFAULT_FILE = path.join(__dirname, '..', 'inbox-page-opens.json');
const HOUR_MS = 60 * 60 * 1000;
const FOUR_HOUR_MS = 4 * HOUR_MS;
const HOUR_LIMIT = 2000;
const FOUR_HOUR_LIMIT = 4000;
const WARN_RATIO = 0.8;

function loadOpens(filePath = DEFAULT_FILE) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const opens = Array.isArray(data)
      ? data
      : data && Array.isArray(data.opens)
        ? data.opens
        : [];
    return opens
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
  } catch (err) {
    console.error(err.stack || err.message);
    return [];
  }
}

function pruneOpens(opens, now = Date.now()) {
  const cutoff = now - FOUR_HOUR_MS;
  return opens.filter((at) => at >= cutoff).sort((a, b) => a - b);
}

function saveOpens(opens, filePath = DEFAULT_FILE) {
  writeProtectedFile(
    filePath,
    `${JSON.stringify({ version: 1, opens }, null, 2)}\n`
  );
}

function inWindow(opens, now, windowMs) {
  const cutoff = now - windowMs;
  return opens.filter((at) => at >= cutoff);
}

function nextAvailableAt(opens, now = Date.now()) {
  const hour = inWindow(opens, now, HOUR_MS);
  const four = inWindow(opens, now, FOUR_HOUR_MS);
  let at = now;
  if (hour.length >= HOUR_LIMIT) {
    at = Math.max(at, hour[0] + HOUR_MS);
  }
  if (four.length >= FOUR_HOUR_LIMIT) {
    at = Math.max(at, four[0] + FOUR_HOUR_MS);
  }
  return at;
}

function formatWait(ms) {
  const seconds = Math.max(0, Math.round(Number(ms) / 1000));
  if (seconds < 45) {
    return 'less than a minute';
  }
  if (seconds < 90) {
    return 'about 1 minute';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `about ${minutes} minutes`;
  }
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours === 1 && rem === 0) {
    return 'about 1 hour';
  }
  if (rem === 0) {
    return `about ${hours} hours`;
  }
  return `about ${hours}h ${rem}m`;
}

function inspectPageOpens(now = Date.now(), filePath = DEFAULT_FILE) {
  const opens = pruneOpens(loadOpens(filePath), now);
  const lastHour = inWindow(opens, now, HOUR_MS).length;
  const lastFourHours = inWindow(opens, now, FOUR_HOUR_MS).length;
  const blocked = lastHour >= HOUR_LIMIT || lastFourHours >= FOUR_HOUR_LIMIT;
  const warning =
    lastHour >= Math.floor(HOUR_LIMIT * WARN_RATIO) ||
    lastFourHours >= Math.floor(FOUR_HOUR_LIMIT * WARN_RATIO);
  const availableAt = nextAvailableAt(opens, now);
  const waitMs = Math.max(0, availableAt - now);
  return {
    lastHour,
    lastFourHours,
    hourLimit: HOUR_LIMIT,
    fourHourLimit: FOUR_HOUR_LIMIT,
    blocked,
    warning,
    nextAvailableAt: availableAt,
    waitMs,
    waitLabel: waitMs > 0 ? formatWait(waitMs) : '',
    canOpen: !blocked,
  };
}

function blockReason(snapshot) {
  const parts = [];
  if (snapshot.lastHour >= snapshot.hourLimit) {
    parts.push(
      `${snapshot.lastHour.toLocaleString()} conversation pages in the last hour (limit ${snapshot.hourLimit.toLocaleString()})`
    );
  }
  if (snapshot.lastFourHours >= snapshot.fourHourLimit) {
    parts.push(
      `${snapshot.lastFourHours.toLocaleString()} conversation pages in the last 4 hours (limit ${snapshot.fourHourLimit.toLocaleString()})`
    );
  }
  return parts.join(' and ');
}

function claimPageOpen(options = {}) {
  const now = options.now || Date.now();
  const filePath = options.filePath || DEFAULT_FILE;
  const snapshot = inspectPageOpens(now, filePath);
  if (!snapshot.canOpen && !options.override) {
    return {
      allowed: false,
      snapshot,
      waitMs: snapshot.waitMs,
      reason: blockReason(snapshot),
    };
  }
  const opens = pruneOpens(loadOpens(filePath), now);
  opens.push(now);
  saveOpens(opens, filePath);
  return {
    allowed: true,
    snapshot: inspectPageOpens(now, filePath),
    overBudget: !snapshot.canOpen,
  };
}

module.exports = {
  DEFAULT_FILE,
  HOUR_MS,
  FOUR_HOUR_MS,
  HOUR_LIMIT,
  FOUR_HOUR_LIMIT,
  inspectPageOpens,
  claimPageOpen,
  blockReason,
  formatWait,
  nextAvailableAt,
};
