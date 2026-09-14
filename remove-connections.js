const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const { ensureLoggedIn, launchLinkedInBrowser } = require('./lib/linkedin-auth');
const {
  parseCsvRow,
  loadConnectionsCsv,
  writeConnectionsCsv,
  isDisconnected,
  markDisconnected,
} = require('./lib/connections-csv');
const {
  loadInboxCsv,
  isUnrequitedCandidate,
  markInboxDisconnected,
  writeInboxCsv,
} = require('./lib/inbox-csv');
const { interpretRemoveResponse, isTrackedRemoved } = require('./lib/remove-response');
const {
  DEFAULT_PROTECTED_TITLE_KEYWORDS,
  normalizeKeywords,
  titleMatchesKeywords,
  titleMatchesProtectedKeywords,
} = require('./lib/keyword-filter');
const {
  snapshotAll,
  writeProtectedFile,
  removeProtectedFile,
} = require('./lib/rolling-backup');

const LINKEDIN_EMAIL = process.env.LINKEDIN_EMAIL;
const INPUT_CSV = path.join(__dirname, 'sales-connections.csv');
const MASTER_CSV = path.join(__dirname, 'connections.csv');
const RESULT_FILE = path.join(__dirname, 'remove-connections-results.json');
const REMOVE_STATE_FILE = path.join(__dirname, 'remove-connections-state.json');
const REMOVE_STATE_VERSION = 1;
const REMOVE_ENDPOINT_BASE =
  'https://www.linkedin.com/flagship-web/rsc-action/actions/server-request';
const REMOVE_ACTION_ID = 'com.linkedin.sdui.mynetwork.RemoveConnectionVanityName';

const SPAM_STATUSES = new Set(['sales', 'recruitment', 'sales_and_recruitment']);
const DEFAULT_IGNORE_COMPANIES = ['Manna', 'Meili'];

function matchesStatusFilter(rowStatus, filterStatus) {
  if (!filterStatus) {
    return true;
  }
  if (filterStatus === 'spam') {
    return SPAM_STATUSES.has(rowStatus);
  }
  return rowStatus === filterStatus;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseIgnoreCompanies(argv) {
  const companies = [...DEFAULT_IGNORE_COMPANIES];

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--ignore-company' && argv[i + 1]) {
      companies.push(argv[i + 1].trim());
      i += 1;
      continue;
    }
    if (arg === '--ignore-companies' && argv[i + 1]) {
      for (const company of argv[i + 1].split(',')) {
        const trimmed = company.trim();
        if (trimmed) {
          companies.push(trimmed);
        }
      }
      i += 1;
    }
  }

  return [...new Set(companies.filter(Boolean))];
}

function parseArgs(argv) {
  const args = {
    execute: false,
    fresh: false,
    limit: null,
    status: null,
    csv: INPUT_CSV,
    masterCsv: MASTER_CSV,
    match: null,
    keywords: [],
    protectUnrequited: true,
    safeKeywords: [],
    ignoreCompanies: parseIgnoreCompanies(argv),
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--execute') {
      args.execute = true;
      continue;
    }
    if (arg === '--fresh') {
      args.fresh = true;
      continue;
    }
    if (arg === '--limit' && argv[i + 1]) {
      args.limit = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--status' && argv[i + 1]) {
      args.status = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--csv' && argv[i + 1]) {
      args.csv = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--master' && argv[i + 1]) {
      args.masterCsv = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--match' && argv[i + 1]) {
      args.match = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--keywords' && argv[i + 1]) {
      args.keywords = normalizeKeywords(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--no-unrequited-safe-list') {
      args.protectUnrequited = false;
      continue;
    }
    if (arg === '--safe-keywords' && argv[i + 1]) {
      args.safeKeywords = normalizeKeywords(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--prune-sales-bd-crypto') {
      args.match = require('./lib/prune-title-pattern').source;
    }
  }

  return args;
}

function extractVanityName(profileUrl) {
  if (!profileUrl) {
    return '';
  }

  const match = String(profileUrl).match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!match || !match[1]) {
    return '';
  }

  try {
    return decodeURIComponent(match[1]).trim();
  } catch (err) {
    console.error(err.stack || err.message);
    return String(match[1]).trim();
  }
}

function buildEmptyRemoveState() {
  return {
    version: REMOVE_STATE_VERSION,
    removed: {},
    updatedAt: new Date().toISOString(),
  };
}

function loadRemoveState() {
  if (!fs.existsSync(REMOVE_STATE_FILE)) {
    return buildEmptyRemoveState();
  }

  try {
    const state = JSON.parse(fs.readFileSync(REMOVE_STATE_FILE, 'utf8'));
    if (!state || typeof state.removed !== 'object') {
      return buildEmptyRemoveState();
    }
    state.version = REMOVE_STATE_VERSION;
    state.removed = state.removed || {};
    return state;
  } catch (err) {
    console.error(err.stack || err.message);
    return buildEmptyRemoveState();
  }
}

function saveRemoveState(state) {
  state.updatedAt = new Date().toISOString();
  writeProtectedFile(REMOVE_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function migrateRemovedFromResults(state) {
  if (!fs.existsSync(RESULT_FILE)) {
    return state;
  }

  try {
    const results = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8'));
    if (!Array.isArray(results)) {
      return state;
    }

    for (const entry of results) {
      if (!entry.removed || !entry.vanityName || state.removed[entry.vanityName]) {
        continue;
      }
      state.removed[entry.vanityName] = {
        vanityName: entry.vanityName,
        name: entry.name || '',
        profileUrl: entry.profileUrl || '',
        removedAt: entry.at || new Date().toISOString(),
        responseStatus: entry.responseStatus ?? null,
      };
    }
  } catch (err) {
    console.error(err.stack || err.message);
  }

  return state;
}

function recordRemovedConnection(state, target, response, at = new Date().toISOString()) {
  state.removed[target.vanityName] = {
    vanityName: target.vanityName,
    name: target.name,
    profileUrl: target.profileUrl,
    removedAt: at,
    responseStatus: response.status,
  };
  saveRemoveState(state);
}

function isAlreadyRemoved(state, target) {
  return isDisconnected(target) || isTrackedRemoved(state, target.vanityName);
}

function filterAlreadyRemoved(targets, state) {
  const pending = [];
  let skipped = 0;

  for (const target of targets) {
    if (isAlreadyRemoved(state, target)) {
      skipped += 1;
      continue;
    }
    pending.push(target);
  }

  return { pending, skipped };
}

function syncMasterCsvFromRemoveState(masterPath, removeState) {
  const rows = fs.existsSync(masterPath) ? loadConnectionsCsv(masterPath) : [];
  const tally = { already: 0, updated: 0, inserted: 0 };

  for (const entry of Object.values(removeState.removed || {})) {
    if (!entry?.vanityName) {
      continue;
    }
    const result = markDisconnected(rows, {
      vanityName: entry.vanityName,
      name: entry.name || '',
      title: entry.title || '',
      profileUrl: entry.profileUrl || '',
      disconnectedOn: entry.removedAt || new Date().toISOString(),
    });
    if (tally[result] != null) {
      tally[result] += 1;
    }
  }

  writeConnectionsCsv(rows, masterPath);
  return { rows, tally };
}

function persistDisconnectedOnMaster(masterRows, masterPath, target, at) {
  markDisconnected(masterRows, {
    vanityName: target.vanityName,
    name: target.name,
    title: target.title,
    profileUrl: target.profileUrl,
    connectedOn: target.connectedOn || '',
    disconnectedOn: at,
  });
  writeConnectionsCsv(masterRows, masterPath);
}

function findIgnoredCompanyMatch(title, ignoreCompanies) {
  const searchable = String(title || '').toLowerCase();
  if (!searchable) {
    return null;
  }

  for (const company of ignoreCompanies) {
    const needle = String(company || '').trim().toLowerCase();
    if (needle && searchable.includes(needle)) {
      return company;
    }
  }

  return null;
}

function filterIgnoredCompanies(targets, ignoreCompanies) {
  const pending = [];
  let skipped = 0;

  for (const target of targets) {
    const matchedCompany = findIgnoredCompanyMatch(target.title, ignoreCompanies);
    if (matchedCompany) {
      skipped += 1;
      continue;
    }
    pending.push(target);
  }

  return { pending, skipped };
}

function filterProtectedTitles(targets, keywords) {
  const pending = [];
  const protectedTargets = [];

  for (const target of targets) {
    if (titleMatchesProtectedKeywords(target.title, keywords)) {
      protectedTargets.push(target);
      continue;
    }
    pending.push(target);
  }

  return { pending, protectedTargets };
}

function applyUnrequitedSafeList(targets, inboxSource, args) {
  const keywords = [
    ...DEFAULT_PROTECTED_TITLE_KEYWORDS,
    ...(args.safeKeywords || []),
  ];
  if (!inboxSource || !args.protectUnrequited) {
    return { pending: targets, protectedTargets: [], keywords };
  }
  return {
    ...filterProtectedTitles(targets, keywords),
    keywords,
  };
}

function formatTargetLabel(target) {
  const name = target.name || target.vanityName;
  if (target.title) {
    return `${name} — ${target.title}`;
  }
  return name;
}

function isInboxCsv(csvPath) {
  if (!fs.existsSync(csvPath)) {
    return false;
  }
  const firstLine = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/, 1)[0] || '';
  const header = parseCsvRow(firstLine).map((cell) => cell.trim().toLowerCase());
  return header.includes('disconnected') &&
    header.includes('disconnected_on') &&
    (header.includes('last_activity') || header.includes('thread_id'));
}

function loadTargetsFromCsv(csvPath, args, inboxRows = null) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV file not found: ${csvPath}`);
  }

  const raw = fs.readFileSync(csvPath, 'utf8').trim();
  if (!raw) {
    return [];
  }

  const lines = raw.split('\n');
  const header = parseCsvRow(lines[0]).map((cell) => cell.trim().toLowerCase());
  const masterFormat = header.includes('vanity_name') || header.includes('connected_on');

  if (masterFormat) {
    let rows =
      header.includes('last_activity') || header.includes('thread_id')
        ? (inboxRows || loadInboxCsv(csvPath)).filter(isUnrequitedCandidate)
        : loadConnectionsCsv(csvPath);
    if (args.match) {
      const pattern = new RegExp(args.match, 'i');
      rows = rows.filter((row) => pattern.test(row.title || ''));
    }
    rows = rows.filter((row) => titleMatchesKeywords(row.title, args.keywords));
    const mapped = rows
      .filter((row) => row.profileUrl && row.vanityName)
      .map((row) => ({
        name: row.name || '',
        title: row.title || '',
        profileUrl: row.profileUrl,
        status: '',
        vanityName: row.vanityName,
        connectedOn: row.connectedOn || '',
        disconnected: row.disconnected,
        disconnectedOn: row.disconnectedOn || '',
      }));
    const deduped = [];
    const seen = new Set();
    for (const target of mapped) {
      if (seen.has(target.vanityName)) {
        continue;
      }
      seen.add(target.vanityName);
      deduped.push(target);
    }
    return deduped;
  }

  const targets = [];

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }

    const [name, title, profileUrl, status] = parseCsvRow(line);
    if (!profileUrl) {
      continue;
    }

    if (args.status && !matchesStatusFilter(status, args.status)) {
      continue;
    }

    if (args.match && !new RegExp(args.match, 'i').test(title || '')) {
      continue;
    }
    if (!titleMatchesKeywords(title, args.keywords)) {
      continue;
    }

    const vanityName = extractVanityName(profileUrl);
    if (!vanityName) {
      continue;
    }

    targets.push({
      name: name || '',
      title: title || '',
      profileUrl,
      status: status || '',
      vanityName,
      connectedOn: '',
      disconnected: false,
      disconnectedOn: '',
    });
  }

  const deduped = [];
  const seen = new Set();
  for (const target of targets) {
    if (seen.has(target.vanityName)) {
      continue;
    }
    seen.add(target.vanityName);
    deduped.push(target);
  }

  return deduped;
}

function persistDisconnectedOnInbox(inboxRows, inboxPath, target, at) {
  if (!inboxRows) {
    return 0;
  }
  const updated = markInboxDisconnected(inboxRows, target, at);
  if (updated > 0) {
    writeInboxCsv(inboxRows, inboxPath);
  }
  return updated;
}

function applyLimit(targets, limit) {
  if (limit && Number.isFinite(limit) && limit > 0) {
    return targets.slice(0, limit);
  }
  return targets;
}

function makeParentSpanId() {
  return encodeURIComponent(crypto.randomBytes(8).toString('base64'));
}

async function removeConnection(page, vanityName) {
  const endpoint =
    `${REMOVE_ENDPOINT_BASE}?sduiid=${REMOVE_ACTION_ID}&parentSpanId=${makeParentSpanId()}`;

  return page.evaluate(
    async ({ url, disconnectVanityName, actionId }) => {
      const jsessionCookie = document.cookie
        .split(';')
        .map((v) => v.trim())
        .find((v) => v.startsWith('JSESSIONID='));
      const csrfToken = jsessionCookie
        ? jsessionCookie.substring('JSESSIONID='.length).replace(/^"|"$/g, '')
        : '';

      const payload = {
        requestId: actionId,
        serverRequest: {
          requestId: actionId,
          requestedArguments: {
            $type: 'proto.sdui.actions.requests.RequestedArguments',
            payload: {
              disconnectVanityName,
              closeCurrentMenuOnCompletion: true,
            },
            requestedStateKeys: [],
            requestMetadata: {
              $type: 'proto.sdui.common.RequestMetadata',
            },
          },
          isApfcEnabled: false,
          isStreaming: false,
          rumPageKey: '',
        },
        states: [],
        requestedArguments: {
          $type: 'proto.sdui.actions.requests.RequestedArguments',
          payload: {
            disconnectVanityName,
            closeCurrentMenuOnCompletion: true,
          },
          requestedStateKeys: [],
          requestMetadata: {
            $type: 'proto.sdui.common.RequestMetadata',
          },
          states: [],
          screenId: '',
        },
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          accept: '*/*',
          'content-type': 'application/json',
          'csrf-token': csrfToken,
          'x-li-rsc-stream': 'true',
          'x-li-anchor-page-key': 'd_flagship3_people_connections',
        },
        credentials: 'include',
        body: JSON.stringify(payload),
      });

      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        body: text.slice(0, 2000),
      };
    },
    { url: endpoint, disconnectVanityName: vanityName, actionId: REMOVE_ACTION_ID }
  );
}

async function main() {
  if (!LINKEDIN_EMAIL) {
    console.error('Error: LINKEDIN_EMAIL environment variable is not set.');
    console.error('Copy .env.example to .env and add your LinkedIn email.');
    process.exit(1);
  }

  const args = parseArgs(process.argv);
  snapshotAll();

  let removeState = args.fresh ? buildEmptyRemoveState() : loadRemoveState();
  if (args.fresh && fs.existsSync(REMOVE_STATE_FILE)) {
    removeProtectedFile(REMOVE_STATE_FILE);
    console.log('Cleared removal state.');
  } else {
    removeState = migrateRemovedFromResults(removeState);
    saveRemoveState(removeState);
  }

  const synced = syncMasterCsvFromRemoveState(args.masterCsv, removeState);
  let masterRows = synced.rows;
  const prior = synced.tally;
  console.log(
    `Master CSV: ${prior.updated} newly marked from previous runs, ${prior.inserted} restored rows, ${prior.already} already marked.`
  );

  const inboxRows = isInboxCsv(args.csv) ? loadInboxCsv(args.csv) : null;
  const allTargets = loadTargetsFromCsv(args.csv, args, inboxRows);
  const protectedResult = applyUnrequitedSafeList(allTargets, inboxRows, args);
  const { pending: companyFiltered, skipped: ignoredByCompany } = filterIgnoredCompanies(
    protectedResult.pending,
    args.ignoreCompanies
  );
  const { pending, skipped } = filterAlreadyRemoved(companyFiltered, removeState);
  const targets = applyLimit(pending, args.limit);

  if (allTargets.length === 0) {
    console.log('No matching targets found in CSV.');
    return;
  }

  if (ignoredByCompany > 0) {
    console.log(
      `Skipping ${ignoredByCompany} connection(s) at ignored companies (${args.ignoreCompanies.join(', ')}).`
    );
  }

  if (inboxRows) {
    console.log(
      `Unrequited safe list: ${args.protectUnrequited ? 'on' : 'off'}${
        args.protectUnrequited
          ? ` (${DEFAULT_PROTECTED_TITLE_KEYWORDS.length} default, ${args.safeKeywords.length} extra)`
          : ''
      }.`
    );
    console.log(
      `Protected by safe list: ${protectedResult.protectedTargets.length} connection(s).`
    );
  }

  if (skipped > 0) {
    console.log(`Skipping ${skipped} already-disconnected connection(s) from previous runs.`);
  }

  if (!args.execute) {
    console.log('Dry run mode. Add --execute to actually remove connections.');
    console.log(`Would remove: ${targets.length} connection(s).`);
  }

  if (targets.length === 0) {
    console.log('No pending targets left to remove.');
    console.log(`Removal state: ${REMOVE_STATE_FILE}`);
    return;
  }

  console.log(`Loaded ${targets.length} pending target(s) from ${args.csv}`);
  if (args.keywords.length) {
    console.log(`Title keywords (match any): ${args.keywords.join(', ')}`);
  }
  if (!args.execute) {
    for (const target of targets.slice(0, 20)) {
      console.log(`- ${target.vanityName} (${formatTargetLabel(target)})`);
    }
    if (targets.length > 20) {
      console.log(`...and ${targets.length - 20} more`);
    }
    return;
  }

  const browser = await launchLinkedInBrowser({
    headless: process.env.HEADLESS === 'true',
  });

  const results = [];
  let alreadyDisconnectedThisRun = 0;
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(60000);
    console.log('Opening LinkedIn…');
    await ensureLoggedIn(
      page,
      'https://www.linkedin.com/mynetwork/invite-connect/connections/'
    );

    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i];
      console.log(
        `[${i + 1}/${targets.length}] Removing ${target.vanityName} (${formatTargetLabel(target)})`
      );

      try {
        const response = await removeConnection(page, target.vanityName);
        const interpreted = interpretRemoveResponse(response);
        const at = new Date().toISOString();
        const done =
          interpreted.outcome === 'removed' || interpreted.outcome === 'already_disconnected';
        results.push({
          ...target,
          removed: done,
          alreadyDisconnected: interpreted.outcome === 'already_disconnected',
          responseStatus: response.status,
          responseBody: response.body,
          at,
        });
        if (done) {
          recordRemovedConnection(removeState, target, response, at);
          persistDisconnectedOnMaster(masterRows, args.masterCsv, target, at);
          persistDisconnectedOnInbox(inboxRows, args.csv, target, at);
          if (interpreted.outcome === 'already_disconnected') {
            alreadyDisconnectedThisRun += 1;
            console.log(`  Already disconnected — marked in CSV, skipping retries.`);
          }
        } else {
          console.log(
            `  Failed (${response.status}) for ${target.vanityName}: ${response.body}`
          );
        }
      } catch (err) {
        console.error(err.stack || err.message);
        results.push({
          ...target,
          removed: false,
          alreadyDisconnected: false,
          responseStatus: null,
          responseBody: err.stack || err.message,
          at: new Date().toISOString(),
        });
      }

      writeProtectedFile(RESULT_FILE, `${JSON.stringify(results, null, 2)}\n`);
      await sleep(1200);
    }
  } finally {
    await browser.close();
  }

  const removedCount = results.filter(
    (result) => result.removed && !result.alreadyDisconnected
  ).length;
  console.log(
    `Completed. Removed ${removedCount}/${results.length} connections. Already disconnected this run: ${alreadyDisconnectedThisRun}. Skipped from previous runs: ${skipped}.`
  );
  console.log(`Result log: ${RESULT_FILE}`);
  console.log(`Removal state: ${REMOVE_STATE_FILE}`);
  console.log(`Master CSV: ${args.masterCsv}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = {
  applyUnrequitedSafeList,
  filterProtectedTitles,
  isInboxCsv,
  loadTargetsFromCsv,
  parseArgs,
  persistDisconnectedOnInbox,
};
