const fs = require('fs');
const { escapeCsv, parseCsvRow } = require('./connections-csv');
const { writeProtectedFile } = require('./rolling-backup');
const {
  filterMessages,
  parseMessagesJson,
  serializeMessages,
  threadUrl,
} = require('./thread-messages');

function truthyProtected(value) {
  return ['yes', 'true', 'protected', '1'].includes(
    String(value || '').trim().toLowerCase()
  );
}

function loadSourceRows(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`CSV file not found: ${filePath}`);
  }
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const nonempty = lines.filter((line) => line.trim());
  if (!nonempty.length) {
    return { header: [], rows: [] };
  }
  const header = parseCsvRow(nonempty[0]);
  const normalized = header.map((cell) => cell.trim().toLowerCase());
  const rows = nonempty.slice(1).map((line, index) => ({
    fields: parseCsvRow(line),
    sourceIndex: index,
  }));
  return { header, normalized, rows };
}

function fieldAt(row, normalized, name, fallback = '') {
  const index = normalized.indexOf(name);
  return index >= 0 ? row.fields[index] || '' : fallback;
}

function numericField(row, normalized, name) {
  const index = normalized.indexOf(name);
  if (index < 0 || row.fields[index] == null || row.fields[index] === '') {
    return null;
  }
  const n = Number(row.fields[index]);
  return Number.isFinite(n) ? n : null;
}

function sourceRowKey(row, normalized) {
  return (
    fieldAt(row, normalized, 'vanity_name') ||
    fieldAt(row, normalized, 'profile_url') ||
    String(row.sourceIndex)
  );
}

function listSourceContacts(filePath, options = {}) {
  const { header, normalized, rows } = loadSourceRows(filePath);
  const query = String(options.query || '').trim().toLowerCase();
  const page = Math.max(1, Number(options.page) || 1);
  const pageSize = Math.min(250, Math.max(1, Number(options.pageSize) || 100));
  const filtered = rows.filter((row) => {
    if (!query) {
      return true;
    }
    return [
      fieldAt(row, normalized, 'name', row.fields[0] || ''),
      fieldAt(row, normalized, 'title', row.fields[1] || ''),
      fieldAt(row, normalized, 'profile_url', row.fields[2] || ''),
      fieldAt(row, normalized, 'vanity_name', row.fields[3] || ''),
      fieldAt(row, normalized, 'snippet'),
    ].some((value) => String(value).toLowerCase().includes(query));
  });
  const start = (page - 1) * pageSize;
  const protectedIndex = normalized.indexOf('protected');
  const inbox = normalized.includes('inbound_count') || normalized.includes('thread_id');
  return {
    header,
    inbox,
    total: rows.length,
    filtered: filtered.length,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(filtered.length / pageSize)),
    contacts: filtered.slice(start, start + pageSize).map((row) => {
      const messages = parseMessagesJson(fieldAt(row, normalized, 'messages'));
      const inbound = numericField(row, normalized, 'inbound_count');
      const outbound = numericField(row, normalized, 'outbound_count');
      return {
        key: sourceRowKey(row, normalized),
        name: fieldAt(row, normalized, 'name', row.fields[0] || ''),
        title: fieldAt(row, normalized, 'title', row.fields[1] || ''),
        profileUrl: fieldAt(row, normalized, 'profile_url', row.fields[2] || ''),
        vanityName: fieldAt(row, normalized, 'vanity_name'),
        protected:
          protectedIndex >= 0 && truthyProtected(row.fields[protectedIndex]),
        inbound:
          inbound != null ? inbound : messages.filter((m) => m.direction === 'in').length,
        outbound:
          outbound != null ? outbound : messages.filter((m) => m.direction === 'out').length,
        snippet: fieldAt(row, normalized, 'snippet'),
        threadId: fieldAt(row, normalized, 'thread_id'),
        hasMessages: messages.length > 0,
      };
    }),
  };
}

function ensureColumn(header, normalized, rows, name) {
  let index = normalized.indexOf(name);
  if (index < 0) {
    header.push(name);
    normalized.push(name);
    index = header.length - 1;
  }
  for (const row of rows) {
    while (row.fields.length < header.length) {
      row.fields.push('');
    }
  }
  return index;
}

function writeSourceRows(filePath, header, rows) {
  const contents = [
    header.map(escapeCsv).join(','),
    ...rows.map((row) => row.fields.map(escapeCsv).join(',')),
  ].join('\n');
  writeProtectedFile(filePath, `${contents}\n`);
}

function findSourceRow(filePath, key) {
  const loaded = loadSourceRows(filePath);
  const target = loaded.rows.find(
    (row) => sourceRowKey(row, loaded.normalized) === String(key)
  );
  if (!target) {
    throw new Error('Contact was not found in the source CSV.');
  }
  return { ...loaded, target };
}

function setSourceContactProtected(filePath, key, protectedValue) {
  const { header, normalized, rows, target } = findSourceRow(filePath, key);
  const protectedIndex = ensureColumn(header, normalized, rows, 'protected');
  target.fields[protectedIndex] = protectedValue ? 'yes' : '';
  writeSourceRows(filePath, header, rows);
  return {
    key: sourceRowKey(target, normalized),
    protected: Boolean(protectedValue),
  };
}

function contactFromRow(row, normalized) {
  const messages = parseMessagesJson(fieldAt(row, normalized, 'messages'));
  const inbound = numericField(row, normalized, 'inbound_count');
  const outbound = numericField(row, normalized, 'outbound_count');
  const threadId = fieldAt(row, normalized, 'thread_id');
  return {
    key: sourceRowKey(row, normalized),
    name: fieldAt(row, normalized, 'name', row.fields[0] || ''),
    title: fieldAt(row, normalized, 'title', row.fields[1] || ''),
    threadId,
    threadUrl: threadUrl(threadId),
    snippet: fieldAt(row, normalized, 'snippet'),
    inbound: inbound != null ? inbound : messages.filter((m) => m.direction === 'in').length,
    outbound: outbound != null ? outbound : messages.filter((m) => m.direction === 'out').length,
    messages,
  };
}

function getSourceContactMessages(filePath, key, direction) {
  const { normalized, target } = findSourceRow(filePath, key);
  const contact = contactFromRow(target, normalized);
  return {
    ...contact,
    messages: filterMessages(contact.messages, direction),
    cached: contact.messages.length > 0,
  };
}

function setSourceContactMessages(filePath, key, messages) {
  const { header, normalized, rows, target } = findSourceRow(filePath, key);
  const messagesIndex = ensureColumn(header, normalized, rows, 'messages');
  const inboundIndex = ensureColumn(header, normalized, rows, 'inbound_count');
  const outboundIndex = ensureColumn(header, normalized, rows, 'outbound_count');
  const parsed = parseMessagesJson(messages);
  target.fields[messagesIndex] = serializeMessages(parsed);
  target.fields[inboundIndex] = String(parsed.filter((m) => m.direction === 'in').length);
  target.fields[outboundIndex] = String(parsed.filter((m) => m.direction === 'out').length);
  writeSourceRows(filePath, header, rows);
  return contactFromRow(target, normalized);
}

module.exports = {
  listSourceContacts,
  setSourceContactProtected,
  getSourceContactMessages,
  setSourceContactMessages,
  truthyProtected,
};
