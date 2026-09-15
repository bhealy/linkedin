const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_ROOT = path.join(__dirname, '..');
const KEEP_RECENT = 20;
const MIN_INTERVAL_MS = 15 * 60 * 1000;

const PROTECTED_NAMES = new Set([
  'connections.csv',
  'sales-connections.csv',
  'download-connections-state.json',
  'scrape-state.json',
  'remove-connections-state.json',
  'remove-connections-results.json',
  'inbox-scan-state.json',
  'inbox-page-opens.json',
  'unrequited-love.csv',
  'connections-analytics.html',
]);

function projectRoot() {
  return process.env.LINKEDIN_BACKUP_ROOT
    ? path.resolve(process.env.LINKEDIN_BACKUP_ROOT)
    : DEFAULT_ROOT;
}

function backupRoot() {
  return path.join(projectRoot(), '.backups');
}

function isProtectedPath(filePath) {
  const resolved = path.resolve(filePath);
  const root = projectRoot();
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return false;
  }
  if (rel.split(path.sep)[0] === '.backups') {
    return false;
  }
  return PROTECTED_NAMES.has(path.basename(resolved));
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function fileList(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name !== '.latest-hash')
    .map((name) => {
      const filePath = path.join(dir, name);
      const stat = fs.statSync(filePath);
      return {
        name,
        path: filePath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function prune(dir) {
  const files = fileList(dir);
  if (files.length <= KEEP_RECENT) {
    return;
  }

  const keep = new Set(files.slice(0, KEEP_RECENT).map((file) => file.path));
  let largest = files[0];
  for (const file of files) {
    if (file.size > largest.size) {
      largest = file;
    }
  }
  keep.add(largest.path);

  for (const file of files) {
    if (!keep.has(file.path)) {
      fs.unlinkSync(file.path);
    }
  }
}

function slotDir(basename) {
  return path.join(backupRoot(), basename);
}

function latestHashPath(dir) {
  return path.join(dir, '.latest-hash');
}

function readLatestHash(dir) {
  const filePath = latestHashPath(dir);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch (err) {
    console.error(err.stack || err.message);
    return null;
  }
}

function writeLatestHash(dir, digest) {
  fs.writeFileSync(latestHashPath(dir), `${digest}\n`, 'utf8');
}

function snapshotFile(filePath, options = {}) {
  const resolved = path.resolve(filePath);
  if (!isProtectedPath(resolved) || !fs.existsSync(resolved)) {
    return null;
  }

  const basename = path.basename(resolved);
  const dir = slotDir(basename);
  fs.mkdirSync(dir, { recursive: true });

  const digest = hashFile(resolved);
  if (readLatestHash(dir) === digest) {
    return null;
  }

  const files = fileList(dir);
  const newest = files[0];
  const shrinking =
    options.shrinking === true ||
    (Number.isFinite(options.incomingBytes) &&
      options.incomingBytes < fs.statSync(resolved).size);

  if (!options.force && !shrinking && newest) {
    if (Date.now() - newest.mtimeMs < MIN_INTERVAL_MS) {
      return null;
    }
  }

  let dest = path.join(dir, `${stamp()}${path.extname(basename) || ''}`);
  let extra = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(
      dir,
      `${stamp()}-${extra}${path.extname(basename) || ''}`
    );
    extra += 1;
  }

  fs.copyFileSync(resolved, dest);
  try {
    fs.chmodSync(dest, 0o444);
  } catch (err) {
    console.error(err.stack || err.message);
  }
  writeLatestHash(dir, digest);
  prune(dir);

  const mb = (fs.statSync(resolved).size / (1024 * 1024)).toFixed(1);
  console.log(`Backup: ${basename} → ${path.relative(projectRoot(), dest)} (${mb} MB)`);
  return dest;
}

function snapshotBeforeWrite(filePath, contents) {
  const incomingBytes = Buffer.byteLength(
    contents == null ? '' : String(contents),
    'utf8'
  );
  return snapshotFile(filePath, { incomingBytes });
}

function writeProtectedFile(filePath, contents) {
  snapshotBeforeWrite(filePath, contents);
  fs.writeFileSync(filePath, contents, 'utf8');
}

function removeProtectedFile(filePath) {
  snapshotFile(filePath, { force: true, shrinking: true });
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function snapshotAll() {
  const root = projectRoot();
  const copied = [];
  for (const name of PROTECTED_NAMES) {
    const dest = snapshotFile(path.join(root, name), { force: true });
    if (dest) {
      copied.push(dest);
    }
  }
  return copied;
}

function listBackups() {
  const root = backupRoot();
  if (!fs.existsSync(root)) {
    return [];
  }
  const listed = [];
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    if (!fs.statSync(dir).isDirectory()) {
      continue;
    }
    for (const file of fileList(dir)) {
      listed.push({
        name,
        path: file.path,
        size: file.size,
        mtimeMs: file.mtimeMs,
      });
    }
  }
  return listed.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

if (require.main === module) {
  const list = process.argv.includes('--list');
  if (list) {
    const rows = listBackups();
    if (rows.length === 0) {
      console.log('No backups yet.');
    } else {
      for (const row of rows) {
        const when = new Date(row.mtimeMs).toISOString();
        const mb = (row.size / (1024 * 1024)).toFixed(1);
        console.log(`${when}  ${mb} MB  ${path.relative(projectRoot(), row.path)}`);
      }
    }
  } else {
    const copied = snapshotAll();
    console.log(
      copied.length
        ? `Saved ${copied.length} backup(s) under .backups/`
        : 'Nothing new to back up.'
    );
  }
}

module.exports = {
  PROTECTED_NAMES,
  snapshotFile,
  snapshotBeforeWrite,
  snapshotAll,
  writeProtectedFile,
  removeProtectedFile,
  listBackups,
  isProtectedPath,
  backupRoot,
};
