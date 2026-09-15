const fs = require('fs');
const { escapeCsv, parseCsvRow } = require('./connections-csv');
const { writeProtectedFile } = require('./rolling-backup');

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
    ].some((value) => String(value).toLowerCase().includes(query));
  });
  const start = (page - 1) * pageSize;
  const protectedIndex = normalized.indexOf('protected');
  return {
    header,
    total: rows.length,
    filtered: filtered.length,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(filtered.length / pageSize)),
    contacts: filtered.slice(start, start + pageSize).map((row) => ({
      key: sourceRowKey(row, normalized),
      name: fieldAt(row, normalized, 'name', row.fields[0] || ''),
      title: fieldAt(row, normalized, 'title', row.fields[1] || ''),
      profileUrl: fieldAt(row, normalized, 'profile_url', row.fields[2] || ''),
      vanityName: fieldAt(row, normalized, 'vanity_name'),
      protected:
        protectedIndex >= 0 && truthyProtected(row.fields[protectedIndex]),
    })),
  };
}

function setSourceContactProtected(filePath, key, protectedValue) {
  const { header, normalized, rows } = loadSourceRows(filePath);
  if (!header.length) {
    throw new Error('CSV has no header.');
  }
  let protectedIndex = normalized.indexOf('protected');
  if (protectedIndex < 0) {
    header.push('protected');
    normalized.push('protected');
    protectedIndex = header.length - 1;
  }
  const target = rows.find((row) => sourceRowKey(row, normalized) === String(key));
  if (!target) {
    throw new Error('Contact was not found in the source CSV.');
  }
  for (const row of rows) {
    while (row.fields.length < header.length) {
      row.fields.push('');
    }
  }
  target.fields[protectedIndex] = protectedValue ? 'yes' : '';
  const contents = [
    header.map(escapeCsv).join(','),
    ...rows.map((row) => row.fields.map(escapeCsv).join(',')),
  ].join('\n');
  writeProtectedFile(filePath, `${contents}\n`);
  return {
    key: sourceRowKey(target, normalized),
    protected: Boolean(protectedValue),
  };
}

module.exports = {
  listSourceContacts,
  setSourceContactProtected,
  truthyProtected,
};
