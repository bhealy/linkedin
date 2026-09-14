// LinkedIn's "Connections" inbox filter stops serving results after roughly a
// hundred threads, so the inbox scan lists everything and decides who is a
// connection locally, using the connections.csv we already downloaded.

const DECORATION = /[^\p{L}\p{N}\s'-]/gu;

function normaliseName(value) {
  const text = String(value || '')
    .replace(/\(.*?\)/g, ' ')
    .split(',')[0]
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(DECORATION, ' ');
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function threadParticipants(name) {
  return String(name || '')
    .split(/\s*,\s*|\s+and\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

// "Harjot Gill, PMP" is one person; "Alice Smith and Bob Jones" is a group. Only
// a credential-style fragment lacks a space, so full-name parts give it away.
function isGroupThread(name) {
  const text = String(name || '');
  if (/\band you\b|\s+and\s+/i.test(text)) {
    return true;
  }
  const commaParts = text.split(/\s*,\s*/).filter(Boolean);
  if (commaParts.length < 2) {
    return false;
  }
  if (commaParts.length > 2) {
    return true;
  }
  const credential = /^(?:mba|pmp|phd|ph\.d\.?|md|m\.d\.?|ai|msc|m\.sc\.?|bsc|b\.sc\.?|cpa|cfa|aca|fca|fcma|mihi)(?:\s+[a-z.]+)*$/i;
  return !credential.test(commaParts[1]);
}

function buildConnectionIndex(connections) {
  const index = new Map();
  for (const row of connections) {
    if (row.disconnected) {
      continue;
    }
    const key = normaliseName(row.name);
    if (!key) {
      continue;
    }
    const bucket = index.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      index.set(key, [row]);
    }
  }
  return index;
}

function matchConnection(index, name) {
  if (isGroupThread(name)) {
    return { match: null, ambiguous: false, reason: 'group' };
  }
  const key = normaliseName(name);
  if (!key) {
    return { match: null, ambiguous: false, reason: 'unnamed' };
  }
  const bucket = index.get(key);
  if (!bucket || !bucket.length) {
    return { match: null, ambiguous: false, reason: 'not-a-connection' };
  }
  // Two connections with the same name means we cannot tell which profile this
  // thread belongs to, so the thread read has to resolve the real URL.
  return {
    match: bucket.length === 1 ? bucket[0] : null,
    ambiguous: bucket.length > 1,
    reason: 'connection',
  };
}

module.exports = {
  normaliseName,
  threadParticipants,
  isGroupThread,
  buildConnectionIndex,
  matchConnection,
};
