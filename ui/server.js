const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { snapshotAll } = require('../lib/rolling-backup');
const { normalizeKeywords } = require('../lib/keyword-filter');
const { loadInboxCsv, isUnrequitedCandidate } = require('../lib/inbox-csv');
const { loadConnectionsCsv } = require('../lib/connections-csv');
const {
  filterConversations,
  computeInboxAnalytics,
  paginateConversations,
} = require('../lib/inbox-analytics');
const {
  computeConnectionsAnalytics,
  filterConnectionsByConnectedOn,
} = require('../lib/connections-analytics');
const {
  getSourceContactMessages,
  listSourceContacts,
  setSourceContactMessages,
  setSourceContactProtected,
} = require('../lib/source-protection');
const { scrapeThreadMessages } = require('../lib/thread-messages');
const { createJobEtaTracker, formatEtaRemaining } = require('../lib/job-eta');
const { inspectPageOpens } = require('../lib/inbox-page-budget');

const ROOT = path.join(__dirname, '..');
const HOST = '127.0.0.1';
const PORT = Number(process.env.UI_PORT) || 3847;
const ENV_PATH = path.join(ROOT, '.env');
const CONNECTIONS_CSV = path.join(ROOT, 'connections.csv');
const SALES_CSV = path.join(ROOT, 'sales-connections.csv');
const UNREQUITED_CSV = path.join(ROOT, 'unrequited-love.csv');
const ANALYTICS_HTML = path.join(ROOT, 'connections-analytics.html');
const REMOVAL_SOURCE_FILES = {
  connections: CONNECTIONS_CSV,
  sales: SALES_CSV,
  unrequited: UNREQUITED_CSV,
};

const MAX_LOG_LINES = 4000;
const MAX_JOB_HISTORY = 10;
const sseClients = new Set();
let currentJob = null;
let scheduledInboxScan = null;
let scheduledInboxTimer = null;
const logLines = [];
const jobHistory = [];

function cleanLogChunk(chunk) {
  return String(chunk)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\r/g, '\n');
}

function isErrorHeadline(line) {
  return /^Error\b/.test(line) || /^[A-Za-z_$][\w$]*(?:Error|Exception)\b/.test(line);
}

function isStackFrame(line) {
  return /^\s+at\s/.test(line) || /^\s+\.\.\./.test(line);
}

function appendLog(text) {
  const pieces = cleanLogChunk(text).split('\n');
  let jobChanged = false;
  for (const piece of pieces) {
    const line = piece.replace(/\s+$/g, '');
    if (!line && logLines[logLines.length - 1] === '') {
      continue;
    }
    logLines.push(line);
    if (logLines.length > MAX_LOG_LINES) {
      logLines.splice(0, logLines.length - MAX_LOG_LINES);
    }
    if (currentJob) {
      currentJob.log.push(line);
      if (currentJob.log.length > 800) {
        currentJob.log.splice(0, currentJob.log.length - 800);
      }
    }
    process.stdout.write(`${line}\n`);
    broadcast({ type: 'log', line });
    if (currentJob && line.trim() && !line.startsWith('──')) {
      if (isErrorHeadline(line)) {
        currentJob.errorMessage = line.trim();
        currentJob.errorStack = [line.trim()];
        currentJob.statusLine = line.trim();
        jobChanged = true;
      } else if (isStackFrame(line)) {
        // Keep the message as the status; collect frames for the failure report.
        if (currentJob.errorStack && currentJob.errorStack.length < 40) {
          currentJob.errorStack.push(line);
        }
      } else {
        currentJob.statusLine = line.trim();
        if (currentJob.etaTracker) {
          currentJob.eta = currentJob.etaTracker.observe(line);
        }
        jobChanged = true;
      }
    }
  }
  if (jobChanged) {
    broadcast({ type: 'job', job: jobSnapshot() });
  }
}

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

function inboxCsvStats() {
  const rows = loadInboxCsv(UNREQUITED_CSV);
  let cacheComplete = false;
  let inboxCacheResumable = false;
  const statePath = path.join(ROOT, 'inbox-scan-state.json');
  if (fs.existsSync(statePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      cacheComplete = Boolean(state && state.cacheComplete);
      // Only a saved cursor can pick up mid-list; anything else starts again
      // from the newest conversation.
      inboxCacheResumable = Boolean(state && state.listCursor && !state.cacheComplete);
    } catch (err) {
      console.error(err.stack || err.message);
    }
  }
  return {
    conversationCount: rows.length,
    unrequitedCount: rows.filter(isUnrequitedCandidate).length,
    inboxCacheComplete: cacheComplete,
    inboxCacheResumable,
  };
}

function csvRowCount(filePath) {
  if (!fs.existsSync(filePath)) {
    return 0;
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  return Math.max(0, lines.length - 1);
}

function readEmailFromEnv() {
  if (!fs.existsSync(ENV_PATH)) {
    return process.env.LINKEDIN_EMAIL || '';
  }
  const match = fs.readFileSync(ENV_PATH, 'utf8').match(/^LINKEDIN_EMAIL=(.*)$/m);
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
}

function upsertEmail(email) {
  const value = String(email || '').trim();
  if (!value || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new Error('Enter a valid email address.');
  }

  let text = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  if (/^LINKEDIN_EMAIL=/m.test(text)) {
    text = text.replace(/^LINKEDIN_EMAIL=.*$/m, `LINKEDIN_EMAIL=${value}`);
  } else {
    const prefix = text && !text.endsWith('\n') ? '\n' : '';
    text = `${text}${prefix}LINKEDIN_EMAIL=${value}\n`;
  }
  fs.writeFileSync(ENV_PATH, text, 'utf8');
  process.env.LINKEDIN_EMAIL = value;
  return value;
}

function pickLog(log, pattern) {
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const match = log[i].match(pattern);
    if (match) {
      return match;
    }
  }
  return null;
}

function summariseJob(job) {
  const summary = summariseJobOutput(job);
  if (job.errorMessage) {
    summary.rows.unshift({ label: 'Error', value: job.errorMessage.replace(/^Error:\s*/, '') });
  }
  return summary;
}

function summariseJobOutput(job) {
  const log = job.log || [];
  const summary = { title: job.label || job.name, rows: [] };

  if (job.name === 'download') {
    const saved = pickLog(log, /Saved in CSV:\s+([0-9,]+)/i);
    const added = pickLog(log, /New this run:\s+([0-9,]+)/i);
    const window = pickLog(log, /Date window:\s+(.+)/i);
    const output = pickLog(log, /Output file:\s+(.+)/i);
    if (saved) summary.rows.push({ label: 'Saved in CSV', value: `${saved[1]} connections` });
    if (added) summary.rows.push({ label: 'New this run', value: `${added[1]} connections` });
    if (window) summary.rows.push({ label: 'Date window', value: window[1].trim() });
    if (output) summary.rows.push({ label: 'Output file', value: output[1].trim() });
    if (log.some((line) => /Finished the last-/.test(line))) {
      summary.rows.push({ label: 'Result', value: 'Reached the date window cutoff' });
    } else if (log.some((line) => /All connections have been downloaded/.test(line))) {
      summary.rows.push({ label: 'Result', value: 'Full connections list downloaded' });
    } else if (log.some((line) => /reached the .+new limit/.test(line))) {
      summary.rows.push({ label: 'Result', value: 'Stopped at the per-run limit — run again to continue' });
    }
    return summary;
  }

  if (job.name === 'analytics') {
    const analysed = pickLog(log, /Analysed ([0-9,]+) connection/i);
    const written = pickLog(log, /Analytics page written to:\s+(.+)/i);
    if (analysed) summary.rows.push({ label: 'Connections analysed', value: analysed[1] });
    if (written) summary.rows.push({ label: 'Report', value: written[1].trim() });
    return summary;
  }

  if (job.name === 'inbox-scan' || job.name === 'inbox-cache') {
    const listed = pickLog(
      log,
      /Listed ([0-9,]+) (?:connection )?conversation\(s\)(?: of [0-9,]+)?; ([0-9,]+) in the latest window, ([0-9,]+) need a thread read/i
    );
    const listedLegacy = pickLog(
      log,
      /Listed ([0-9,]+) conversation\(s\); ([0-9,]+) in window, ([0-9,]+) unscanned/i
    );
    const threadsListed = pickLog(log, /Threads listed:\s+([0-9,]+)/i);
    const notConnected = pickLog(
      log,
      /Skipped ([0-9,]+) conversation\(s\) not in connections\.csv and ([0-9,]+) group thread\(s\)/i
    );
    const paused = pickLog(log, /Pause requested|Paused — conversation cache saved/i);
    const cacheListed = pickLog(log, /Listed this run:\s+([0-9,]+)/i);
    const cacheSize = pickLog(log, /Conversation cache:\s+([0-9,]+)/i);
    const scanned = pickLog(log, /Scanned this run:\s+([0-9,]+)/i);
    const found = pickLog(log, /New candidates:\s+([0-9,]+)/i);
    const ready = pickLog(log, /Ready to remove:\s+([0-9,]+)/i);
    const rows = pickLog(log, /Rows in CSV:\s+([0-9,]+)/i);
    const output = pickLog(log, /Output file:\s+(.+)/i);
    const undated = pickLog(log, /Skipped ([0-9,]+) conversation\(s\) with an unreadable date/i);
    const caught = log.some((line) => /Caught up with the saved conversation cache/.test(line));
    const match = listed || listedLegacy;
    if (match) {
      summary.rows.push({ label: 'Latest window', value: `${match[2]} of ${match[1]} listed` });
      summary.rows.push({ label: 'Need a thread read', value: match[3] });
    }
    if (threadsListed) summary.rows.push({ label: 'Threads listed', value: threadsListed[1] });
    if (notConnected) {
      summary.rows.push({
        label: 'Not connections',
        value: `${notConnected[1]} skipped · ${notConnected[2]} group thread(s)`,
      });
    }
    if (cacheListed) summary.rows.push({ label: 'Listed this run', value: cacheListed[1] });
    if (cacheSize) summary.rows.push({ label: 'Conversation cache', value: cacheSize[1] });
    if (scanned) summary.rows.push({ label: 'Conversations read', value: scanned[1] });
    if (found) summary.rows.push({ label: 'New candidates', value: found[1] });
    if (ready) summary.rows.push({ label: 'Ready to remove', value: `${ready[1]} candidates` });
    if (rows && !cacheSize) summary.rows.push({ label: 'Rows in CSV', value: rows[1] });
    const awaiting = pickLog(log, /Awaiting profile name:\s+([0-9,]+)/i);
    if (awaiting) {
      summary.rows.push({
        label: 'Awaiting profile name',
        value: `${awaiting[1]} — search again to finish them`,
      });
    }
    if (undated) summary.rows.push({ label: 'Skipped', value: `${undated[1]} with an unreadable date` });
    if (output) summary.rows.push({ label: 'Output file', value: output[1].trim() });
    const oldest = pickLog(log, /Oldest conversation:\s+(.+)/i);
    if (oldest) summary.rows.push({ label: 'Oldest conversation', value: oldest[1].trim() });
    if (paused && job.name === 'inbox-cache') {
      summary.rows.push({
        label: 'Paused',
        value: 'Progress saved — run cache again to resume older pages',
      });
    }
    const budgetPaused = pickLog(
      log,
      /Paused — opened (.+)\. LinkedIn may block you/i
    );
    if (budgetPaused) {
      summary.rows.push({
        label: 'Paused',
        value: `${budgetPaused[1]} — come back later to resume, or override the page-open limit`,
      });
    } else if (paused && job.name === 'inbox-scan') {
      summary.rows.push({
        label: 'Paused',
        value: 'Progress saved — search again to resume unread conversations',
      });
    }
    const throttled = pickLog(
      log,
      /LinkedIn rate limited the search \(HTTP ([0-9]+)\) after .*?\. ([0-9,]+) conversation\(s\) were left unread/i
    );
    if (throttled) {
      summary.rows.push({
        label: 'Rate limited',
        value: `HTTP ${throttled[1]} — ${throttled[2]} left unread; wait, then run again`,
      });
    }
    if (caught) {
      summary.rows.push({ label: 'List', value: 'Stopped at the saved conversation cache' });
    } else {
      const stopped = pickLog(log, /List stopped: (.+)/i);
      if (stopped) {
        summary.rows.push({ label: 'List stopped', value: stopped[1].replace(/\.$/, '') });
      }
    }
    if (match && match[3] === '0') {
      summary.rows.push({
        label: 'Result',
        value: 'Nothing new to read in this window',
      });
    }
    return summary;
  }

  if (job.name === 'remove-dry-run' || job.name === 'remove-execute') {
    const loaded = pickLog(log, /Loaded ([0-9,]+) pending target/i);
    const removed = pickLog(log, /Removed ([0-9,/]+) connections/i);
    const keywords = pickLog(log, /Title keywords \(match any\):\s+(.+)/i);
    const sourceProtected = pickLog(log, /Protected in source CSV:\s+([0-9,]+)/i);
    const protectedCount = pickLog(log, /Protected by safe list:\s+([0-9,]+)/i);
    const wouldRemove = pickLog(log, /Would remove:\s+([0-9,]+)/i);
    if (loaded) summary.rows.push({ label: 'Pending targets', value: loaded[1] });
    if (keywords) summary.rows.push({ label: 'Keywords', value: keywords[1].trim() });
    if (sourceProtected) {
      summary.rows.push({ label: 'Protected in CSV', value: sourceProtected[1] });
    }
    if (protectedCount) {
      summary.rows.push({ label: 'Protected by safe list', value: protectedCount[1] });
    }
    const oneMessage = pickLog(
      log,
      /Skipped ([0-9,]+) connection\(s\) with only one inbound message/i
    );
    if (oneMessage) {
      summary.rows.push({
        label: 'One-message threads',
        value: `${oneMessage[1]} skipped (default is 2+ inbound)`,
      });
    }
    const inboundFilter = pickLog(log, /Unrequited inbound filter:\s+(.+)/i);
    if (inboundFilter && !oneMessage) {
      summary.rows.push({ label: 'Inbound filter', value: inboundFilter[1].trim() });
    }
    if (wouldRemove) summary.rows.push({ label: 'Would remove', value: wouldRemove[1] });
    if (removed) summary.rows.push({ label: 'Removed', value: removed[1] });
    if (job.name === 'remove-dry-run') {
      summary.rows.push({ label: 'Mode', value: 'Dry run — nothing was removed' });
    }
    return summary;
  }

  if (job.statusLine) {
    summary.rows.push({ label: 'Last update', value: job.statusLine });
  }
  return summary;
}

function etaSnapshot(job, at = Date.now()) {
  if (!job) {
    return null;
  }
  const eta =
    job.eta && typeof job.eta === 'object'
      ? job.eta
      : job.etaTracker
        ? job.etaTracker.snapshot(at)
        : null;
  if (!eta) {
    return null;
  }
  // Recompute remaining from the last estimate so idle gaps between log lines
  // still count down in the UI.
  let etaMs = eta.etaMs;
  let etaLabel = eta.etaLabel;
  if (etaMs != null && eta.progress && eta.progress.total != null) {
    const age = Math.max(0, at - (eta.computedAt || at));
    etaMs = Math.max(0, etaMs - age);
    etaLabel = etaMs === 0 && eta.progress.current >= eta.progress.total
      ? 'finishing…'
      : formatEtaRemaining(etaMs);
  }
  return {
    progress: eta.progress || null,
    etaMs: etaMs == null ? null : etaMs,
    etaLabel: etaLabel || null,
    paceLabel: eta.paceLabel || null,
    computedAt: at,
  };
}

function jobSnapshot() {
  if (!currentJob) {
    return null;
  }
  return {
    id: currentJob.id,
    name: currentJob.name,
    label: currentJob.label,
    detail: currentJob.detail,
    startedAt: currentJob.startedAt,
    elapsedMs: Date.now() - new Date(currentJob.startedAt).getTime(),
    statusLine: currentJob.statusLine,
    state: currentJob.state,
    eta: etaSnapshot(currentJob),
    running: true,
  };
}

function statusPayload() {
  return {
    email: readEmailFromEnv(),
    connectionsCount: csvRowCount(CONNECTIONS_CSV),
    salesCount: csvRowCount(SALES_CSV),
    ...inboxCsvStats(),
    analyticsExists: fs.existsSync(ANALYTICS_HTML),
    job: jobSnapshot(),
    history: jobHistory,
    inboxPageBudget: inspectPageOpens(),
    scheduledInboxScan,
  };
}

function stopJob(signal = 'SIGTERM') {
  if (!currentJob || !currentJob.child) {
    return false;
  }
  currentJob.state = signal === 'SIGKILL' ? 'stopping' : 'pausing';
  currentJob.statusLine =
    signal === 'SIGKILL' ? 'Force-stopping process…' : 'Pause requested — saving progress…';
  broadcast({ type: 'job', job: jobSnapshot() });
  currentJob.child.kill(signal);
  return true;
}

function startJob({ name, label, detail, args, password }) {
  if (currentJob) {
    const err = new Error('A job is already running. Pause it first.');
    err.statusCode = 409;
    throw err;
  }

  const env = { ...process.env };
  if (password) {
    env.LINKEDIN_PASSWORD = String(password);
  } else {
    delete env.LINKEDIN_PASSWORD;
  }
  env.FORCE_COLOR = '0';

  const copied = snapshotAll();
  if (copied.length) {
    appendLog(`Backup: saved ${copied.length} file(s) under .backups/`);
  }

  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const startedAt = new Date().toISOString();
  const job = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    label: label || name,
    detail: detail || '',
    startedAt,
    statusLine: 'Starting process…',
    state: 'running',
    log: [],
    etaTracker: createJobEtaTracker({ startedAt: Date.parse(startedAt) }),
    eta: null,
    child,
  };
  currentJob = job;
  appendLog(`\n── Started ${name} ──`);
  broadcast({ type: 'job', job: jobSnapshot() });

  child.stdout.on('data', (buf) => appendLog(buf.toString('utf8')));
  child.stderr.on('data', (buf) => appendLog(buf.toString('utf8')));

  child.on('error', (err) => {
    job.statusLine = err.message;
    job.errorMessage = err.message;
    job.errorStack = String(err.stack || err.message).split('\n');
    appendLog(err.stack || err.message);
  });

  child.on('close', (code, signal) => {
    const endedAt = new Date().toISOString();
    const paused = job.state === 'pausing' || job.state === 'cancelling' || job.state === 'stopping';
    const outcome = paused ? 'paused' : code === 0 ? 'succeeded' : 'failed';
    const completed = {
      id: job.id,
      name: job.name,
      label: job.label,
      detail: job.detail,
      startedAt: job.startedAt,
      endedAt,
      durationMs: new Date(endedAt).getTime() - new Date(job.startedAt).getTime(),
      statusLine: job.statusLine,
      outcome,
      exitCode: code,
      signal: signal || null,
      errorMessage: job.errorMessage || null,
      errorStack: job.errorStack || null,
      summary: summariseJob(job),
    };
    jobHistory.unshift(completed);
    jobHistory.splice(MAX_JOB_HISTORY);
    if (currentJob === job) {
      currentJob = null;
    }
    appendLog(`── ${name} finished (code ${code}${signal ? `, ${signal}` : ''}) ──`);
    broadcast({ type: 'job', job: null, completed });
    broadcast({ type: 'status', status: statusPayload() });
  });

  return jobSnapshot();
}

function parsePositiveInt(value, label) {
  if (value == null || value === '') {
    return null;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`${label} must be a positive number.`);
  }
  return Math.floor(n);
}

function clearScheduledInboxScan(reason) {
  if (scheduledInboxTimer) {
    clearTimeout(scheduledInboxTimer);
  }
  scheduledInboxTimer = null;
  const previous = scheduledInboxScan;
  scheduledInboxScan = null;
  if (previous && reason) {
    appendLog(reason);
  }
  broadcast({ type: 'status', status: statusPayload() });
  return Boolean(previous);
}

function buildInboxScanJob(body) {
  const cacheState = inboxCsvStats();
  if (!cacheState.inboxCacheComplete) {
    const err = new Error(
      'Cache the conversation list first before searching for unrequited messages.'
    );
    err.statusCode = 400;
    throw err;
  }
  const days = parsePositiveInt(body.days, '--days') || 30;
  const args = [path.join(ROOT, 'scan-inbox.js'), '--days', String(days)];
  const detailParts = [`last ${days} day${days === 1 ? '' : 's'}`];
  const tabs = parsePositiveInt(body.tabs, '--tabs') || 4;
  args.push('--tabs', String(tabs));
  detailParts.push(`${tabs} tab${tabs === 1 ? '' : 's'}`);
  const limit = parsePositiveInt(body.limit, '--limit');
  if (limit) {
    args.push('--limit', String(limit));
    detailParts.push(`limit ${limit.toLocaleString()} threads`);
  }
  if (body.fresh) {
    args.push('--fresh');
    detailParts.push('fresh CSV and state');
  }
  if (body.overridePageBudget) {
    args.push('--override-page-budget');
    detailParts.push('page-open limit overridden');
  }
  if (body.pacePageBudget) {
    args.push('--pace-page-budget');
    detailParts.push('pacing page opens');
  }
  return {
    args,
    detail: detailParts.join(' · '),
    password: body.password,
    tabs,
  };
}

function startInboxScanJob(body) {
  const built = buildInboxScanJob(body);
  return startJob({
    name: 'inbox-scan',
    label: 'Search for unrequited love',
    detail: built.detail,
    args: built.args,
    password: built.password,
  });
}

function scheduleInboxScanJob(body) {
  if (currentJob) {
    const err = new Error('A job is already running. Pause it first.');
    err.statusCode = 409;
    throw err;
  }
  clearScheduledInboxScan();
  const built = buildInboxScanJob(body);
  const budget = inspectPageOpens();
  const delayMs = body.overridePageBudget ? 0 : budget.waitMs;
  if (delayMs <= 0) {
    return { ok: true, job: startInboxScanJob(body), scheduled: false };
  }
  const startAt = Date.now() + delayMs;
  clearScheduledInboxScan();
  scheduledInboxScan = {
    startAt,
    waitMs: delayMs,
    waitLabel: budget.waitLabel,
    tabs: built.tabs,
    detail: built.detail,
    label: 'Search for unrequited love',
  };
  scheduledInboxTimer = setTimeout(() => {
    scheduledInboxTimer = null;
    scheduledInboxScan = null;
    try {
      startInboxScanJob(body);
    } catch (err) {
      console.error(err.stack || err.message);
      appendLog(err.stack || err.message);
      broadcast({ type: 'status', status: statusPayload() });
    }
  }, delayMs);
  appendLog(
    `Scheduled a slower unrequited search (${built.tabs} tab${built.tabs === 1 ? '' : 's'}) to start in ${budget.waitLabel}. Progress already saved will resume.`
  );
  broadcast({ type: 'status', status: statusPayload() });
  return { ok: true, scheduled: true, scan: scheduledInboxScan };
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use('/docs', express.static(path.join(ROOT, 'docs')));

app.get('/api/status', (_req, res) => {
  res.json(statusPayload());
});

app.get('/api/removal-source', (req, res) => {
  try {
    const source = String(req.query.source || '');
    const filePath = REMOVAL_SOURCE_FILES[source];
    if (!filePath) {
      throw new Error('Choose a valid source CSV.');
    }
    res.json(
      listSourceContacts(filePath, {
        query: req.query.q,
        page: req.query.page,
        pageSize: req.query.pageSize,
      })
    );
  } catch (err) {
    console.error(err.stack || err.message);
    res.status(400).json({ error: err.message });
  }
});

function removalSourceFile(source) {
  const filePath = REMOVAL_SOURCE_FILES[String(source || '')];
  if (!filePath) {
    throw new Error('Choose a valid source CSV.');
  }
  return filePath;
}

function messageDirection(value) {
  const direction = String(value || 'all').trim().toLowerCase();
  if (!['in', 'out', 'all'].includes(direction)) {
    throw new Error('Choose in, out, or all messages.');
  }
  return direction;
}

app.get('/api/removal-source/messages', (req, res) => {
  try {
    const filePath = removalSourceFile(req.query.source);
    if (!req.query.key) {
      throw new Error('Choose a contact to inspect.');
    }
    res.json(getSourceContactMessages(filePath, req.query.key, messageDirection(req.query.direction)));
  } catch (err) {
    console.error(err.stack || err.message);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/removal-source/messages', async (req, res) => {
  try {
    if (currentJob) {
      throw new Error('Wait for the running job to finish before opening LinkedIn messages.');
    }
    const body = req.body || {};
    const filePath = removalSourceFile(body.source);
    if (!body.key) {
      throw new Error('Choose a contact to inspect.');
    }
    const direction = messageDirection(body.direction);
    const cached = getSourceContactMessages(filePath, body.key, 'all');
    if (cached.cached) {
      res.json({
        ...cached,
        messages: cached.messages.filter((message) => direction === 'all' || message.direction === direction),
        scraped: false,
      });
      return;
    }
    if (!cached.threadId) {
      throw new Error('This conversation has no LinkedIn thread id yet. Run an inbox scan first.');
    }
    const scraped = await scrapeThreadMessages(cached.threadId, body.password);
    const saved = setSourceContactMessages(filePath, body.key, scraped.messages);
    res.json({
      ...getSourceContactMessages(filePath, body.key, direction),
      inbound: saved.inbound,
      outbound: saved.outbound,
      scraped: true,
    });
  } catch (err) {
    console.error(err.stack || err.message);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/removal-source/protection', (req, res) => {
  try {
    if (currentJob) {
      throw new Error('Wait for the running job to finish before changing protection.');
    }
    const body = req.body || {};
    const filePath = REMOVAL_SOURCE_FILES[String(body.source || '')];
    if (!filePath) {
      throw new Error('Choose a valid source CSV.');
    }
    if (!body.key) {
      throw new Error('Choose a contact to protect.');
    }
    res.json({
      ok: true,
      contact: setSourceContactProtected(filePath, body.key, body.protected === true),
    });
  } catch (err) {
    console.error(err.stack || err.message);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/inbox/conversations', (req, res) => {
  try {
    const rows = loadInboxCsv(UNREQUITED_CSV);
    res.json(paginateConversations(rows, req.query));
  } catch (err) {
    console.error(err.stack || err.message);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/inbox/analytics', (req, res) => {
  try {
    const rows = loadInboxCsv(UNREQUITED_CSV);
    const filtered = filterConversations(rows, req.query);
    const cacheState = inboxCsvStats();
    res.json(
      computeInboxAnalytics(filtered, {
        cacheComplete: cacheState.inboxCacheComplete,
      })
    );
  } catch (err) {
    console.error(err.stack || err.message);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/connections/analytics', (req, res) => {
  try {
    const rows = fs.existsSync(CONNECTIONS_CSV) ? loadConnectionsCsv(CONNECTIONS_CSV) : [];
    const filtered = filterConnectionsByConnectedOn(rows, req.query);
    const analytics = computeConnectionsAnalytics(filtered);
    delete analytics.contacts;
    analytics.summary.sourceTotal = rows.length;
    analytics.summary.matched = filtered.length;
    res.json(analytics);
  } catch (err) {
    console.error(err.stack || err.message);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'hello', status: statusPayload(), log: logLines.slice(-400) })}\n\n`);
  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.post('/api/setup', (req, res) => {
  try {
    const email = upsertEmail(req.body && req.body.email);
    broadcast({ type: 'status', status: statusPayload() });
    res.json({ ok: true, email });
  } catch (err) {
    console.error(err.stack || err.message);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/jobs/download', (req, res) => {
  try {
    const body = req.body || {};
    const args = [path.join(ROOT, 'download-connections.js')];
    const detailParts = [];
    if (body.fresh) {
      args.push('--fresh');
      detailParts.push('fresh CSV');
    }
    const months = parsePositiveInt(body.months, '--months');
    if (months) {
      args.push('--months', String(months));
      detailParts.push(`last ${months} month${months === 1 ? '' : 's'}`);
    }
    const limit = parsePositiveInt(body.limit, '--limit');
    if (limit) {
      args.push('--limit', String(limit));
      detailParts.push(`limit ${limit.toLocaleString()}`);
    }
    const job = startJob({
      name: 'download',
      label: 'Download connections',
      detail: detailParts.join(' · ') || 'Resume full connection download',
      args,
      password: body.password,
    });
    res.json({ ok: true, job });
  } catch (err) {
    console.error(err.stack || err.message);
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

app.post('/api/jobs/analytics', (req, res) => {
  try {
    const job = startJob({
      name: 'analytics',
      label: 'Generate analytics',
      detail: `Build report from ${path.basename(CONNECTIONS_CSV)}`,
      args: [path.join(ROOT, 'generate-connections-analytics.js'), '--open'],
      password: req.body && req.body.password,
    });
    res.json({ ok: true, job });
  } catch (err) {
    console.error(err.stack || err.message);
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

app.post('/api/jobs/inbox-scan', (req, res) => {
  try {
    const body = req.body || {};
    if (body.scheduleWhenClear) {
      res.json(scheduleInboxScanJob(body));
      return;
    }
    if (scheduledInboxScan) {
      clearScheduledInboxScan('Cancelled the scheduled slower scan because a search started now.');
    }
    const job = startInboxScanJob(body);
    res.json({ ok: true, job });
  } catch (err) {
    console.error(err.stack || err.message);
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

app.post('/api/jobs/inbox-cache', (req, res) => {
  try {
    const body = req.body || {};
    const args = [path.join(ROOT, 'scan-inbox.js'), '--cache'];
    const detailParts = ['full conversation list'];
    if (body.fresh) {
      args.push('--fresh');
      detailParts.push('fresh CSV and state');
    }
    const job = startJob({
      name: 'inbox-cache',
      label: 'Cache conversation list',
      detail: detailParts.join(' · '),
      args,
      password: body.password,
    });
    res.json({ ok: true, job });
  } catch (err) {
    console.error(err.stack || err.message);
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

app.post('/api/jobs/remove', (req, res) => {
  try {
    const body = req.body || {};
    if (body.execute && body.confirm !== true) {
      throw new Error('Set confirm: true to execute removals.');
    }
    const args = [path.join(ROOT, 'remove-connections.js')];
    const csvChoice = REMOVAL_SOURCE_FILES[body.csv] || CONNECTIONS_CSV;
    args.push('--csv', csvChoice);
    if (body.execute) {
      args.push('--execute');
    }
    if (body.status) {
      args.push('--status', String(body.status));
    }
    const keywords = normalizeKeywords(body.keywords);
    if (keywords.length) {
      args.push('--keywords', keywords.join(','));
    }
    const protectUnrequited = body.protectUnrequited !== false;
    const includeSingleMessage = body.includeSingleMessage === true;
    const safeKeywords = normalizeKeywords(body.safeKeywords);
    if (!protectUnrequited) {
      args.push('--no-unrequited-safe-list');
    }
    if (includeSingleMessage) {
      args.push('--include-single-message');
    }
    if (safeKeywords.length) {
      args.push('--safe-keywords', safeKeywords.join(','));
    }
    const limit = parsePositiveInt(body.limit, '--limit');
    if (limit) {
      args.push('--limit', String(limit));
    }
    const job = startJob({
      name: body.execute ? 'remove-execute' : 'remove-dry-run',
      label: body.execute ? 'Remove connections' : 'Preview removals',
      detail: [
        path.basename(csvChoice),
        body.status ? `status: ${body.status}` : 'all statuses',
        keywords.length ? `title: ${keywords.join(' OR ')}` : null,
        csvChoice === UNREQUITED_CSV
          ? `safe list ${protectUnrequited ? 'on' : 'off'}`
          : null,
        csvChoice === UNREQUITED_CSV
          ? includeSingleMessage
            ? 'including one-message threads'
            : '2+ inbound messages'
          : null,
        csvChoice === UNREQUITED_CSV && safeKeywords.length
          ? `extra protected: ${safeKeywords.join(' OR ')}`
          : null,
        limit ? `limit ${limit}` : null,
      ]
        .filter(Boolean)
        .join(' · '),
      args,
      password: body.password,
    });
    res.json({ ok: true, job });
  } catch (err) {
    console.error(err.stack || err.message);
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

app.post('/api/jobs/cancel', (_req, res) => {
  if (scheduledInboxScan && !currentJob) {
    clearScheduledInboxScan('Cancelled the scheduled slower scan.');
    res.json({ ok: true, scheduled: false });
    return;
  }
  if (!currentJob) {
    res.status(409).json({ error: 'No job is running.' });
    return;
  }
  if (scheduledInboxScan) {
    clearScheduledInboxScan('Cancelled the scheduled slower scan.');
  }
  appendLog('Pause requested…');
  stopJob('SIGTERM');
  setTimeout(() => {
    if (currentJob) {
      stopJob('SIGKILL');
    }
  }, 15000);
  res.json({ ok: true });
});

app.get('/analytics', (_req, res) => {
  if (!fs.existsSync(ANALYTICS_HTML)) {
    res.status(404).type('html').send(
      '<p>No analytics file yet. Generate it from the dashboard first.</p>'
    );
    return;
  }
  res.sendFile(ANALYTICS_HTML);
});

app.get('/connections.csv', (_req, res) => {
  if (!fs.existsSync(CONNECTIONS_CSV)) {
    res.status(404).type('text').send('No connections yet. Download them first.');
    return;
  }
  res.type('text/csv').sendFile(CONNECTIONS_CSV);
});

app.get('/sales-connections.csv', (_req, res) => {
  if (!fs.existsSync(SALES_CSV)) {
    res.status(404).type('text').send('No sales search results yet.');
    return;
  }
  res.type('text/csv').sendFile(SALES_CSV);
});

app.get('/unrequited-love.csv', (_req, res) => {
  if (!fs.existsSync(UNREQUITED_CSV)) {
    res
      .status(404)
      .type('text')
      .send('No candidates yet. Search for unrequited love from the dashboard first.');
    return;
  }
  res.type('text').send(fs.readFileSync(UNREQUITED_CSV, 'utf8'));
});

app.use((err, _req, res, _next) => {
  console.error(err.stack || err.message);
  res.status(500).json({ error: err.message || 'Server error' });
});

const url = `http://${HOST}:${PORT}/`;

const server = app.listen(PORT, HOST, () => {
  console.log(`Dashboard listening on ${url} (localhost only)`);
  openBrowser(url);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Dashboard already running on ${url}`);
    openBrowser(url);
    process.exit(0);
    return;
  }
  console.error(err.stack || err.message);
  process.exit(1);
});

function openBrowser(url) {
  if (process.env.UI_NO_OPEN === '1') {
    return;
  }
  const { spawn: spawnOpen } = require('child_process');
  try {
    if (process.platform === 'darwin') {
      spawnOpen('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else if (process.platform === 'win32') {
      spawnOpen('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawnOpen('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
  } catch (err) {
    console.error(err.stack || err.message);
  }
}

function shutdown() {
  stopJob('SIGTERM');
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
