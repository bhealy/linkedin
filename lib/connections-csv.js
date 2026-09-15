const fs = require('fs');
const { snapshotBeforeWrite } = require('./rolling-backup');

function parseCsvRow(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  fields.push(current);
  return fields;
}

function escapeCsv(value) {
  const text = value == null ? '' : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function truthyDisconnected(value) {
  const flag = String(value || '').trim().toLowerCase();
  return flag === 'yes' || flag === 'true' || flag === 'disconnected' || flag === '1';
}

function truthyProtected(value) {
  const flag = String(value || '').trim().toLowerCase();
  return flag === 'yes' || flag === 'true' || flag === 'protected' || flag === '1';
}

function isDisconnected(row) {
  if (!row) {
    return false;
  }
  if (row.disconnected === true) {
    return true;
  }
  return truthyDisconnected(row.disconnected) || Boolean(row.disconnectedOn);
}

function headerIndex(header, name) {
  return header.indexOf(name);
}

function loadConnectionsCsv(filePath) {
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
  const nameI = headerIndex(header, 'name');
  const titleI = headerIndex(header, 'title');
  const urlI = headerIndex(header, 'profile_url');
  const vanityI = headerIndex(header, 'vanity_name');
  const connectedI = headerIndex(header, 'connected_on');
  const disconnectedI = headerIndex(header, 'disconnected');
  const disconnectedOnI = headerIndex(header, 'disconnected_on');
  const protectedI = headerIndex(header, 'protected');
  const positional = nameI < 0;

  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const fields = parseCsvRow(lines[i]);
    const name = positional ? fields[0] : fields[nameI];
    const title = positional ? fields[1] : fields[titleI];
    const profileUrl = positional ? fields[2] : fields[urlI];
    const vanityName = positional ? fields[3] : fields[vanityI];
    const connectedOn = positional ? fields[4] : fields[connectedI];
    const disconnectedRaw = disconnectedI >= 0 ? fields[disconnectedI] : '';
    const disconnectedOn = disconnectedOnI >= 0 ? (fields[disconnectedOnI] || '') : '';
    const protectedRaw = protectedI >= 0 ? fields[protectedI] : '';

    if (!vanityName && !profileUrl) {
      continue;
    }

    const disconnected = truthyDisconnected(disconnectedRaw) || Boolean(disconnectedOn);
    rows.push({
      name: name || '',
      title: title || '',
      profileUrl: profileUrl || '',
      vanityName: vanityName || '',
      connectedOn: connectedOn || '',
      disconnected,
      disconnectedOn: disconnectedOn || '',
      protected: truthyProtected(protectedRaw),
    });
  }
  return rows;
}

function writeConnectionsCsv(rows, filePath) {
  const header = [
    'name',
    'title',
    'profile_url',
    'vanity_name',
    'connected_on',
    'disconnected',
    'disconnected_on',
    'protected',
  ];
  const lines = [
    header.join(','),
    ...rows.map((row) =>
      [
        row.name,
        row.title,
        row.profileUrl,
        row.vanityName,
        row.connectedOn,
        isDisconnected(row) ? 'yes' : '',
        isDisconnected(row) ? (row.disconnectedOn || '') : '',
        row.protected ? 'yes' : '',
      ]
        .map(escapeCsv)
        .join(',')
    ),
  ];
  const contents = `${lines.join('\n')}\n`;
  snapshotBeforeWrite(filePath, contents);
  fs.writeFileSync(filePath, contents, 'utf8');
}

function vanityKey(vanityName) {
  return String(vanityName || '').trim().toLowerCase();
}

function markDisconnected(rows, patch) {
  const key = vanityKey(patch.vanityName);
  if (!key) {
    return 'skipped';
  }

  const at = patch.disconnectedOn || new Date().toISOString();
  const found = rows.find((row) => vanityKey(row.vanityName) === key);
  if (found) {
    const already = isDisconnected(found);
    found.disconnected = true;
    found.disconnectedOn = found.disconnectedOn || at;
    if (patch.name && !found.name) found.name = patch.name;
    if (patch.title && !found.title) found.title = patch.title;
    if (patch.profileUrl && !found.profileUrl) found.profileUrl = patch.profileUrl;
    return already ? 'already' : 'updated';
  }

  rows.push({
    name: patch.name || '',
    title: patch.title || '',
    profileUrl: patch.profileUrl || '',
    vanityName: patch.vanityName,
    connectedOn: patch.connectedOn || '',
    disconnected: true,
    disconnectedOn: at,
  });
  return 'inserted';
}

function mergeConnections(existing, incoming) {
  const byVanity = new Map();
  for (const row of existing) {
    if (row.vanityName) {
      byVanity.set(row.vanityName, row);
    }
  }
  for (const row of incoming) {
    if (!row.vanityName) {
      continue;
    }
    const prev = byVanity.get(row.vanityName) || {};
    byVanity.set(row.vanityName, {
      ...prev,
      ...row,
      disconnected: false,
      disconnectedOn: '',
      protected: Boolean(prev.protected || row.protected),
    });
  }
  return [...byVanity.values()];
}

module.exports = {
  parseCsvRow,
  escapeCsv,
  isDisconnected,
  truthyProtected,
  loadConnectionsCsv,
  writeConnectionsCsv,
  markDisconnected,
  mergeConnections,
  vanityKey,
};
