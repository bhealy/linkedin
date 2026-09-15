const fs = require('fs');
const { parseCsvRow, escapeCsv } = require('./connections-csv');
const { writeProtectedFile } = require('./rolling-backup');
const { parseMessagesJson, serializeMessages } = require('./thread-messages');

const CSV_FIELDS = [
  'name',
  'title',
  'profile_url',
  'vanity_name',
  'connected_on',
  'disconnected',
  'disconnected_on',
  'protected',
  'thread_id',
  'last_activity',
  'last_activity_ms',
  'snippet',
  'status',
  'inbound_count',
  'outbound_count',
  'examined_activity',
  'scanned_at',
  'listed_at',
  'messages',
];

// A message thread links to the participant by opaque member id rather than
// their public address, so a slug that starts with ACoAA still needs resolving.
function isObfuscatedVanity(vanityName) {
  return /^ACoAA/i.test(String(vanityName || ''));
}

// connections.csv already holds the public slug for anyone we match by name.
// Taking the thread's opaque id over it would throw that away and force a
// profile page load to recover what we had, so a slug is only ever upgraded:
// empty loses to anything, and an opaque id loses to a public one.
function prefersIncomingVanity(current, incoming) {
  if (!incoming || incoming === current) {
    return false;
  }
  if (!current) {
    return true;
  }
  return isObfuscatedVanity(current) && !isObfuscatedVanity(incoming);
}

function emptyInboxRow(partial = {}) {
  return {
    name: '',
    title: '',
    profileUrl: '',
    vanityName: '',
    connectedOn: '',
    disconnected: '',
    disconnectedOn: '',
    protected: false,
    threadId: '',
    lastActivity: '',
    lastActivityMs: '',
    snippet: '',
    status: 'listed',
    inbound: '',
    outbound: '',
    examinedActivity: '',
    scannedAt: '',
    listedAt: '',
    messages: [],
    ...partial,
  };
}

function loadInboxCsv(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const lines = fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (lines.length <= 1) {
    return [];
  }

  const header = parseCsvRow(lines[0]).map((cell) => cell.trim().toLowerCase());
  const legacy = !header.includes('status');
  const indexOf = (name) => header.indexOf(name);
  const rows = [];

  for (let i = 1; i < lines.length; i += 1) {
    const fields = parseCsvRow(lines[i]);
    const read = (name, fallbackIndex) => {
      const index = indexOf(name);
      if (index >= 0) {
        return fields[index] || '';
      }
      if (legacy && fallbackIndex != null) {
        return fields[fallbackIndex] || '';
      }
      return '';
    };

    const status = read('status') || (legacy ? 'candidate' : 'listed');
    rows.push(
      emptyInboxRow({
        name: read('name', 0),
        title: read('title', 1),
        profileUrl: read('profile_url', 2),
        vanityName: read('vanity_name', 3),
        connectedOn: read('connected_on', 4),
        disconnected: read('disconnected', 5),
        disconnectedOn: read('disconnected_on', 6),
        protected: /^(?:yes|true|protected|1)$/i.test(read('protected')),
        threadId: read('thread_id'),
        lastActivity: read('last_activity', 7),
        lastActivityMs: read('last_activity_ms'),
        snippet: read('snippet'),
        status,
        inbound: read('inbound_count', 8),
        outbound: read('outbound_count'),
        examinedActivity: read('examined_activity') || (legacy ? read('last_activity', 7) : ''),
        scannedAt: read('scanned_at', 9),
        listedAt: read('listed_at') || read('scanned_at', 9),
        messages: parseMessagesJson(read('messages')),
      })
    );
  }

  return rows;
}

function writeInboxCsv(rows, filePath) {
  const lines = [
    CSV_FIELDS.join(','),
    ...rows.map((row) =>
      [
        row.name || '',
        row.title || '',
        row.profileUrl || '',
        row.vanityName || '',
        row.connectedOn || '',
        row.disconnected || '',
        row.disconnectedOn || '',
        row.protected ? 'yes' : '',
        row.threadId || '',
        row.lastActivity || '',
        row.lastActivityMs === '' || row.lastActivityMs == null ? '' : String(row.lastActivityMs),
        row.snippet || '',
        row.status || 'listed',
        row.inbound === '' || row.inbound == null ? '' : String(row.inbound),
        row.outbound === '' || row.outbound == null ? '' : String(row.outbound),
        row.examinedActivity || '',
        row.scannedAt || '',
        row.listedAt || '',
        serializeMessages(row.messages),
      ]
        .map(escapeCsv)
        .join(',')
    ),
  ];
  writeProtectedFile(filePath, `${lines.join('\n')}\n`);
  return rows.length;
}

function findInboxRow(rows, entry) {
  if (entry.threadId) {
    const byThread = rows.find((row) => row.threadId && row.threadId === entry.threadId);
    if (byThread) {
      return byThread;
    }
  }

  const exact = rows.find(
    (row) =>
      row.name === entry.name &&
      row.lastActivity === entry.activityText &&
      String(row.snippet || '') === String(entry.snippet || '')
  );
  if (exact) {
    return exact;
  }

  const sameActivity = rows.filter(
    (row) => row.name === entry.name && row.lastActivity === entry.activityText
  );
  if (sameActivity.length === 1) {
    return sameActivity[0];
  }

  const sameName = rows.filter((row) => row.name === entry.name);
  if (sameName.length === 1) {
    return sameName[0];
  }

  return null;
}

// Conversation names are matched against connections.csv, so a matched thread
// already knows the profile the removal step will need.
function applyConnectionDetails(row, connection) {
  if (!connection) {
    return;
  }
  if (!row.title) row.title = connection.title || '';
  // Listing upgrades an opaque id from an earlier read, so the scan repairs
  // itself here rather than spending a profile load on it later.
  if (prefersIncomingVanity(row.vanityName, connection.vanityName)) {
    row.vanityName = connection.vanityName;
    if (connection.profileUrl) {
      row.profileUrl = connection.profileUrl;
    }
  } else if (connection.profileUrl && !row.profileUrl) {
    row.profileUrl = connection.profileUrl;
  }
  if (!row.connectedOn) row.connectedOn = connection.connectedOn || '';
  if (connection.protected) row.protected = true;
}

function upsertListedConversation(rows, entry) {
  const now = new Date().toISOString();
  let row = findInboxRow(rows, entry);
  if (!row) {
    row = emptyInboxRow({
      name: entry.name || '',
      threadId: entry.threadId || '',
      lastActivity: entry.activityText || '',
      lastActivityMs: entry.lastActivityMs || '',
      snippet: entry.snippet || '',
      status: 'listed',
      listedAt: now,
    });
    applyConnectionDetails(row, entry.connection);
    rows.push(row);
    return { row, created: true, activityChanged: true };
  }

  const activityChanged =
    row.lastActivity !== (entry.activityText || '') ||
    String(row.snippet || '') !== String(entry.snippet || '');
  if (entry.threadId && !row.threadId) {
    row.threadId = entry.threadId;
  }
  if (entry.name) {
    row.name = entry.name;
  }
  row.lastActivity = entry.activityText || row.lastActivity;
  row.lastActivityMs = entry.lastActivityMs || row.lastActivityMs;
  row.snippet = entry.snippet || row.snippet;
  row.listedAt = now;
  applyConnectionDetails(row, entry.connection);
  return { row, created: false, activityChanged };
}

function needsExamineWithParser(row, cutoff, parseActivity) {
  if (!row || row.disconnected) {
    return false;
  }
  if (!row.lastActivity) {
    return false;
  }
  if (cutoff && parseActivity) {
    const parsed = parseActivity(row.lastActivity);
    if (parsed && parsed.getTime() < cutoff.getTime()) {
      return false;
    }
    if (!parsed && (!row.status || row.status === 'listed' || row.status === 'error')) {
      return false;
    }
  }
  if (!row.status || row.status === 'listed' || row.status === 'error') {
    return true;
  }
  if (row.examinedActivity === row.lastActivity) {
    return false;
  }
  return true;
}

function isUnrequitedCandidate(row) {
  if (!row || row.disconnected) {
    return false;
  }
  return row.status === 'candidate';
}

function markInboxDisconnected(rows, target, disconnectedOn = new Date().toISOString()) {
  const vanityName = String(target?.vanityName || '').trim().toLowerCase();
  const profileUrl = String(target?.profileUrl || '').trim().toLowerCase();
  let updated = 0;

  for (const row of rows) {
    const sameVanity =
      vanityName &&
      String(row.vanityName || '').trim().toLowerCase() === vanityName;
    const sameProfile =
      profileUrl &&
      String(row.profileUrl || '').trim().toLowerCase() === profileUrl;
    if (!sameVanity && !sameProfile) {
      continue;
    }
    row.disconnected = 'yes';
    row.disconnectedOn = row.disconnectedOn || disconnectedOn;
    updated += 1;
  }

  return updated;
}

function applyExamineOutcome(row, outcome, extra = {}) {
  const now = extra.scannedAt || new Date().toISOString();
  row.status = outcome.status || row.status;
  row.scannedAt = now;
  row.examinedActivity = extra.activityText != null ? extra.activityText : row.lastActivity;
  if (extra.threadId) {
    row.threadId = extra.threadId;
  }
  if (extra.title) {
    row.title = extra.title;
  }
  // profileUrl and vanityName describe the same link, so they move together.
  if (prefersIncomingVanity(row.vanityName, extra.vanityName)) {
    row.vanityName = extra.vanityName;
    if (extra.profileUrl) {
      row.profileUrl = extra.profileUrl;
    }
  } else if (extra.profileUrl && !row.profileUrl) {
    row.profileUrl = extra.profileUrl;
  }
  if (extra.inbound != null) {
    row.inbound = extra.inbound;
  }
  if (extra.outbound != null) {
    row.outbound = extra.outbound;
  }
  if (extra.messages != null) {
    row.messages = extra.messages;
  }
  if (outcome.status === 'skipped' || outcome.status === 'error') {
    row.status = outcome.status;
  }
  return row;
}

function listCaughtUp(batch, rows) {
  const named = batch.filter((entry) => entry.name);
  if (named.length < 8) {
    return false;
  }
  const tail = named.slice(-8);
  return tail.every((entry) => {
    const row = findInboxRow(rows, entry);
    return (
      row &&
      row.lastActivity === entry.activityText &&
      String(row.snippet || '') === String(entry.snippet || '')
    );
  });
}

module.exports = {
  CSV_FIELDS,
  emptyInboxRow,
  loadInboxCsv,
  writeInboxCsv,
  findInboxRow,
  upsertListedConversation,
  needsExamineWithParser,
  isUnrequitedCandidate,
  isObfuscatedVanity,
  prefersIncomingVanity,
  markInboxDisconnected,
  applyExamineOutcome,
  listCaughtUp,
};
