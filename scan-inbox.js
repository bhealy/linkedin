const fs = require('fs');
const path = require('path');
require('dotenv').config();

const {
  ensureLoggedIn,
  launchLinkedInBrowser,
  sleep,
} = require('./lib/linkedin-auth');
const { cutoffForDays, parseThreadDate } = require('./lib/inbox-thread-date');
const { loadConnectionsCsv } = require('./lib/connections-csv');
const {
  classifyEmptyListPage,
  cursorFromOldestCached,
  discoverMessagingListApi,
  fetchConversationPage,
  parseConversationElements,
  watchMessagingListApi,
} = require('./lib/inbox-list-api');
const { buildConnectionIndex, matchConnection } = require('./lib/connection-index');
const {
  applyExamineOutcome,
  isUnrequitedCandidate,
  loadInboxCsv,
  listCaughtUp,
  needsExamineWithParser,
  upsertListedConversation,
  writeInboxCsv,
} = require('./lib/inbox-csv');
const {
  removeProtectedFile,
  snapshotAll,
  writeProtectedFile,
} = require('./lib/rolling-backup');
const {
  RATE_LIMIT_RETRY_LIMIT,
  SCAN_BROWSER_RESTART_LIMIT,
  describeRateLimit,
  describeThreadOpenFailure,
  isLostContext,
  rateLimitBackoffMs,
  unreadAfterLostContext,
} = require('./lib/inbox-scan-recovery');
const {
  inspectPageOpens,
  claimPageOpen,
  formatWait,
} = require('./lib/inbox-page-budget');
const { extractThreadMessages } = require('./lib/thread-messages');

const MESSAGING_URL = 'https://www.linkedin.com/messaging/';
const OUTPUT_FILE = path.join(__dirname, 'unrequited-love.csv');
const CONNECTIONS_FILE = path.join(__dirname, 'connections.csv');
const STATE_FILE = path.join(__dirname, 'inbox-scan-state.json');
const STATE_VERSION = 3;
const DEFAULT_DAYS = 30;
const DEFAULT_TABS = 4;
const MAX_LIST_ROUNDS = 1500;
const LIST_PAUSE_MS = 900;
const LIST_STALL_PAUSE_MS = 2500;
const LIST_STALL_LIMIT = 10;
const CACHE_PERSIST_EVERY = 25;
const LIST_RECOVERY_LIMIT = 3;
const BROWSER_CLOSE_TIMEOUT_MS = 8000;
const BROWSER_KILL_GRACE_MS = 5000;
const BROWSER_RESTART_PAUSE_MS = 2000;
const THREAD_PAUSE_MS = 1500;
let activeBrowser = null;
let pauseRequested = false;
let persistPause = () => {};
let pageBudgetOverride = false;
let pageBudgetPace = false;
let pageBudgetWarned = false;
const PROFILE_PAUSE_MS = 2500;

function parseArgs(argv) {
  const args = {
    days: DEFAULT_DAYS,
    limit: null,
    tabs: DEFAULT_TABS,
    cache: false,
    fresh: false,
    status: false,
    overridePageBudget: false,
    pacePageBudget: false,
    csv: OUTPUT_FILE,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--fresh') {
      args.fresh = true;
    } else if (arg === '--cache') {
      args.cache = true;
    } else if (arg === '--status') {
      args.status = true;
    } else if (arg === '--days' && argv[i + 1]) {
      args.days = Number(argv[++i]);
    } else if (arg === '--limit' && argv[i + 1]) {
      args.limit = Number(argv[++i]);
    } else if (arg === '--tabs' && argv[i + 1]) {
      args.tabs = Number(argv[++i]);
    } else if (arg === '--csv' && argv[i + 1]) {
      args.csv = path.resolve(argv[++i]);
    } else if (arg === '--override-page-budget') {
      args.overridePageBudget = true;
    } else if (arg === '--pace-page-budget') {
      args.pacePageBudget = true;
    }
  }
  if (!Number.isInteger(args.days) || args.days < 1) {
    throw new Error('--days must be a positive integer.');
  }
  if (args.limit != null && (!Number.isInteger(args.limit) || args.limit < 1)) {
    throw new Error('--limit must be a positive integer.');
  }
  if (!Number.isInteger(args.tabs) || args.tabs < 1) {
    throw new Error('--tabs must be a positive integer.');
  }
  return args;
}

function emptyState(days) {
  return {
    version: STATE_VERSION,
    days,
    scanned: {},
    cacheComplete: false,
    cacheCompletedAt: '',
    listQueryId: '',
    mailboxUrn: '',
    listCursor: '',
    updatedAt: new Date().toISOString(),
  };
}

function loadState(days) {
  if (!fs.existsSync(STATE_FILE)) {
    return emptyState(days);
  }
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!state || typeof state !== 'object') {
      return emptyState(days);
    }
    return {
      ...state,
      version: STATE_VERSION,
      days,
      scanned: state.scanned || {},
      candidates: state.candidates || {},
      cacheComplete: Boolean(state.cacheComplete),
      cacheCompletedAt: state.cacheCompletedAt || '',
      listQueryId: state.listQueryId || '',
      mailboxUrn: state.mailboxUrn || '',
      listCursor: state.listCursor || '',
    };
  } catch (err) {
    console.error(err.stack || err.message);
    return emptyState(days);
  }
}

function saveState(state) {
  state.updatedAt = new Date().toISOString();
  writeProtectedFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function vanityFromUrl(url) {
  const match = String(url || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!match) {
    return '';
  }
  try {
    return decodeURIComponent(match[1]).trim();
  } catch (err) {
    console.error(err.stack || err.message);
    return String(match[1]).trim();
  }
}

function isObfuscatedVanity(vanityName) {
  return /^ACoAA/i.test(String(vanityName || ''));
}

function persistCsv(rows, filePath) {
  writeInboxCsv(rows, filePath);
  return rows.filter(
    (row) =>
      isUnrequitedCandidate(row) &&
      row.vanityName &&
      !isObfuscatedVanity(row.vanityName)
  ).length;
}

function hydrateRowsFromState(rows, state) {
  for (const [key, scanned] of Object.entries(state.scanned || {})) {
    const [name, activityText, snippet] = String(key).split('|');
    const entry = {
      name,
      activityText,
      snippet: snippet || '',
      threadId: scanned.threadId || '',
    };
    const { row } = upsertListedConversation(rows, entry);
    if (scanned.status && scanned.status !== 'listed') {
      applyExamineOutcome(
        row,
        { status: scanned.status === 'candidate' ? 'candidate' : scanned.status },
        {
          inbound: scanned.inbound,
          outbound: scanned.outbound,
          activityText,
          threadId: scanned.threadId,
          scannedAt: scanned.scannedAt,
        }
      );
    }
  }
  for (const [threadId, candidate] of Object.entries(state.candidates || {})) {
    const entry = {
      name: candidate.name,
      activityText: candidate.activityText,
      snippet: '',
      threadId,
    };
    const { row } = upsertListedConversation(rows, entry);
    applyExamineOutcome(
      row,
      { status: 'candidate' },
      {
        title: candidate.title,
        profileUrl: candidate.profileUrl,
        vanityName: candidate.vanityName,
        inbound: candidate.inbound,
        activityText: candidate.activityText,
        threadId,
        scannedAt: candidate.scannedAt,
      }
    );
  }
}

async function readConversationList(page) {
  return page.evaluate(() => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('li.msg-conversation-listitem')].map(
      (item) => {
        const name = clean(
          item.querySelector('h3, [class*="participant-names"]')?.textContent
        );
        const activityText = clean(
          item.querySelector('time, [class*="time-stamp"]')?.textContent
        );
        const snippet = clean(
          item.querySelector('[class*="message-snippet"]')?.textContent
        ).slice(0, 80);
        const href =
          item.querySelector('a[href*="/messaging/thread/"]')?.href ||
          item.querySelector('.msg-conversation-listitem__link')?.href ||
          '';
        const fromHtml = (item.innerHTML.match(/\/messaging\/thread\/([^"'/?#]+)/) ||
          [])[1];
        const threadId = (href.match(/\/messaging\/thread\/([^/?#]+)/) ||
          [])[1] || fromHtml || '';
        return {
          key: `${name}|${activityText}|${snippet}`,
          name,
          activityText,
          snippet,
          threadId,
        };
      }
    );
  });
}

async function scrollConversationList(page) {
  return page.evaluate(() => {
    const list = document.querySelector(
      'ul.msg-conversations-container__conversations-list'
    );
    if (!list) {
      throw new Error('Could not find the inbox conversation list.');
    }

    // The scrollable element is sometimes the list and sometimes an ancestor.
    let pane = list;
    while (pane && pane !== document.body && pane.scrollHeight <= pane.clientHeight + 4) {
      pane = pane.parentElement;
    }
    if (!pane || pane === document.body) {
      pane = list;
    }

    const items = list.querySelectorAll('li.msg-conversation-listitem');
    const last = items[items.length - 1];
    const before = pane.scrollTop;
    last?.scrollIntoView({ block: 'end' });
    pane.scrollTop = pane.scrollHeight;

    const container =
      list.closest('[class*="msg-conversations-container"]') || list;
    [...container.querySelectorAll('button')]
      .find((button) =>
        /load more|show more|older conversations/i.test(button.textContent)
      )
      ?.click();

    const busy = Boolean(
      document.querySelector(
        '.msg-conversations-container__loader, [class*="conversations-list"] [class*="loader"], [class*="conversations"] [aria-busy="true"]'
      )
    );

    return { moved: pane.scrollTop > before, count: items.length, busy };
  });
}

function oldestActivityLabel(entries) {
  let oldest = null;
  let label = '';
  for (const entry of entries) {
    const activity = parseThreadDate(entry.activityText);
    if (!activity) {
      continue;
    }
    if (!oldest || activity.getTime() < oldest.getTime()) {
      oldest = activity;
      label = entry.activityText;
    }
  }
  return label;
}

function classifyListedEntry(entry, connectionIndex, skipped) {
  if (entry.groupChat) {
    skipped.group += 1;
    return null;
  }
  const { match, ambiguous, reason } = matchConnection(connectionIndex, entry.name);
  if (reason === 'group') {
    skipped.group += 1;
    return null;
  }
  if (reason !== 'connection') {
    skipped.notConnected += 1;
    return null;
  }
  return { ...entry, connection: ambiguous ? null : match };
}

async function collectConversationsFromApi(
  page,
  { session, startCursor, savedCursor, connectionIndex, onProgress, onCursor }
) {
  const collected = new Map();
  const skipped = { group: 0, notConnected: 0 };
  let listed = 0;
  let cursor = startCursor || '';
  let stopReason = 'reached the end of the inbox';
  let pageNumber = 0;
  let staleCursor = false;

  let recoveries = 0;

  while (!pauseRequested) {
    let result;
    try {
      result = await fetchConversationPage(page, {
        queryId: session.queryId,
        mailboxUrn: session.mailboxUrn,
        nextCursor: cursor,
      });
    } catch (err) {
      console.error(err.stack || err.message);
      if (pauseRequested) {
        stopReason = 'paused by user';
        break;
      }
      if (!isLostContext(err) || recoveries >= LIST_RECOVERY_LIMIT) {
        throw err;
      }
      recoveries += 1;
      console.log(`Messaging page reloaded (${recoveries}/${LIST_RECOVERY_LIMIT}); continuing the list…`);
      await page.goto(MESSAGING_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(1500);
      continue;
    }
    if (!result.ok) {
      throw new Error(
        `Messaging list request failed (${result.status}) on page ${pageNumber + 1}: ${JSON.stringify(
          result.body
        ).slice(0, 240)}`
      );
    }
    const parsed = parseConversationElements(result.body);
    pageNumber += 1;
    // A LinkedIn-issued resume cursor that is no longer recognised returns an
    // empty page. A cursor derived from the oldest cached thread is different:
    // empty means the list is already complete.
    if (startCursor && pageNumber === 1 && !parsed.conversations.length) {
      const classified = classifyEmptyListPage({ startCursor, savedCursor });
      staleCursor = classified.staleCursor;
      stopReason = classified.stopReason;
      break;
    }
    const before = collected.size;
    for (const entry of parsed.conversations) {
      if (!entry.name) {
        continue;
      }
      listed += 1;
      const classified = classifyListedEntry(entry, connectionIndex, skipped);
      if (!classified) {
        continue;
      }
      const key = classified.threadId || classified.key;
      if (!collected.has(key) || (!collected.get(key).threadId && classified.threadId)) {
        collected.set(key, classified);
      }
    }
    if (parsed.nextCursor) {
      onCursor?.(parsed.nextCursor, session);
    }
    if (collected.size > before) {
      const label = oldestActivityLabel(collected.values());
      console.log(
        `Listing… ${collected.size} connection conversation(s) of ${listed} listed${
          label ? `, back to ${label}` : ''
        }`
      );
      onProgress?.([...collected.values()]);
    }
    if (!parsed.nextCursor) {
      stopReason = 'reached the end of the inbox';
      break;
    }
    if (parsed.nextCursor === cursor) {
      stopReason = 'reached the end of the inbox';
      break;
    }
    cursor = parsed.nextCursor;
    await sleep(400);
  }

  if (pauseRequested) {
    stopReason = 'paused by user';
  }

  return {
    inWindow: [...collected.values()],
    total: collected.size,
    listed,
    skipped,
    undated: 0,
    caughtUp: false,
    stopReason,
    oldest: oldestActivityLabel(collected.values()),
    staleCursor,
    pages: pageNumber,
  };
}

async function collectConversations(
  page,
  { cutoff, fullList, cacheComplete, cacheRows, connectionIndex, onProgress }
) {
  const collected = new Map();
  const classified = new Map();
  const skipped = { group: 0, notConnected: 0 };
  let stalls = 0;
  let recoveries = 0;
  let reachedCutoff = false;
  let caughtUp = false;
  let stopReason = `hit the ${MAX_LIST_ROUNDS}-round scroll limit`;

  const attempt = async (fn) => {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      return { ok: false, err };
    }
  };

  // Messaging sometimes navigates under us on a long list; reload and carry on
  // rather than losing the walk. Already-seen threads are deduped on the way back.
  const recover = async (err) => {
    console.error(err.stack || err.message);
    if (!isLostContext(err) || recoveries >= LIST_RECOVERY_LIMIT) {
      stopReason = isLostContext(err)
        ? `the messaging page reloaded more than ${LIST_RECOVERY_LIMIT} time(s)`
        : `the conversation list could not be read (${err.message})`;
      return false;
    }
    recoveries += 1;
    console.log(
      `Messaging page navigated away — reopening and resuming (recovery ${recoveries}/${LIST_RECOVERY_LIMIT})…`
    );
    await page.goto(MESSAGING_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('li.msg-conversation-listitem', { timeout: 30000 });
    await sleep(2000);
    stalls = 0;
    return true;
  };

  for (let round = 0; round < MAX_LIST_ROUNDS; round += 1) {
    const read = await attempt(() => readConversationList(page));
    if (!read.ok) {
      if (!(await recover(read.err))) {
        break;
      }
      continue;
    }

    const batch = [];
    for (const entry of read.value) {
      if (!entry.name) {
        continue;
      }
      if (!classified.has(entry.key)) {
        const { match, ambiguous, reason } = matchConnection(connectionIndex, entry.name);
        if (reason === 'group') {
          skipped.group += 1;
        } else if (reason !== 'connection') {
          skipped.notConnected += 1;
        }
        classified.set(
          entry.key,
          reason === 'connection' ? { ...entry, connection: ambiguous ? null : match } : null
        );
      }
      const known = classified.get(entry.key);
      if (known) {
        batch.push(entry.threadId && !known.threadId ? { ...known, threadId: entry.threadId } : known);
      }
    }

    const before = collected.size;
    for (const entry of batch) {
      const existing = collected.get(entry.key);
      if (!existing || (!existing.threadId && entry.threadId)) {
        collected.set(entry.key, entry);
      }
      const activity = parseThreadDate(entry.activityText);
      if (!fullList && activity && activity.getTime() < cutoff.getTime()) {
        reachedCutoff = true;
      }
    }

    const grew = collected.size > before;
    stalls = grew ? 0 : stalls + 1;
    if (grew) {
      const label = oldestActivityLabel(collected.values());
      console.log(
        `Listing… ${collected.size} connection conversation(s) of ${classified.size} listed${
          label ? `, back to ${label}` : ''
        }`
      );
      onProgress?.([...collected.values()]);
    }

    if (
      !fullList &&
      cacheComplete &&
      cacheRows &&
      cacheRows.length &&
      listCaughtUp(batch, cacheRows)
    ) {
      caughtUp = true;
      stopReason = 'caught up with the saved conversation cache';
      break;
    }
    if (!fullList && reachedCutoff) {
      stopReason = 'reached the date window cutoff';
      break;
    }

    if (pauseRequested) {
      stopReason = 'paused by user';
      break;
    }

    const scroll = await attempt(() => scrollConversationList(page));
    if (!scroll.ok) {
      if (!(await recover(scroll.err))) {
        break;
      }
      continue;
    }
    const scrolled = scroll.value;
    // LinkedIn fetches the next page only after the list bottom is reached, so
    // give a stalled list progressively longer to answer before giving up.
    if (stalls >= LIST_STALL_LIMIT && !scrolled.busy) {
      stopReason = `no new conversations after ${LIST_STALL_LIMIT} attempts`;
      break;
    }
    await sleep(stalls || scrolled.busy ? LIST_STALL_PAUSE_MS : LIST_PAUSE_MS);
  }

  const inWindow = [];
  let undated = 0;
  for (const entry of collected.values()) {
    if (fullList) {
      inWindow.push(entry);
      continue;
    }
    const activity = parseThreadDate(entry.activityText);
    if (!activity) {
      undated += 1;
      continue;
    }
    if (activity.getTime() >= cutoff.getTime()) {
      inWindow.push(entry);
    }
  }
  return {
    inWindow,
    total: collected.size,
    listed: classified.size,
    skipped,
    undated,
    caughtUp,
    stopReason,
    oldest: oldestActivityLabel(collected.values()),
  };
}

async function claimConversationPage(label) {
  while (!pauseRequested) {
    const claim = claimPageOpen({
      override: pageBudgetOverride,
    });
    if (claim.allowed) {
      if (claim.overBudget && !pageBudgetWarned) {
        pageBudgetWarned = true;
        console.log(
          'Page-open limit exceeded; continuing because override is on. LinkedIn may block this account if you keep going.'
        );
      }
      return { allowed: true };
    }
    const waitLabel = claim.snapshot.waitLabel || formatWait(claim.waitMs);
    if (!pageBudgetPace) {
      console.log(
        `Paused — opened ${claim.reason}. LinkedIn may block you if you keep opening conversation pages. Come back later to resume this search, or rerun with --override-page-budget.`
      );
      if (waitLabel) {
        console.log(`The limit eases in ${waitLabel}.`);
      }
      pauseRequested = true;
      return { allowed: false, paused: true };
    }
    console.log(
      `${label || 'Search'} — page-open limit reached (${claim.reason}). Waiting ${waitLabel} before opening the next conversation…`
    );
    await sleep(Math.max(claim.waitMs, 1000));
  }
  return { allowed: false, paused: true };
}

async function openConversation(page, entry) {
  const claimed = await claimConversationPage(entry.name);
  if (!claimed.allowed) {
    return { opened: false, budgetPaused: true, reason: 'page-open limit reached' };
  }
  const previousUrl = page.url();
  let clicked;
  try {
    clicked = await page.evaluate((key) => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const item = [...document.querySelectorAll('li.msg-conversation-listitem')].find(
      (candidate) => {
        const name = clean(
          candidate.querySelector('h3, [class*="participant-names"]')?.textContent
        );
        const activityText = clean(
          candidate.querySelector('time, [class*="time-stamp"]')?.textContent
        );
        const snippet = clean(
          candidate.querySelector('[class*="message-snippet"]')?.textContent
        ).slice(0, 80);
        return `${name}|${activityText}|${snippet}` === key;
      }
    );
    if (!item) {
      return false;
    }
    const link = item.querySelector('.msg-conversation-listitem__link') || item;
    link.scrollIntoView({ block: 'center' });
    link.click();
    return true;
  }, entry.key);
  } catch (err) {
    console.error(err.stack || err.message);
    return describeThreadOpenFailure(err, '');
  }

  if (!clicked) {
    return { opened: false, reason: 'conversation no longer in the list' };
  }

  try {
    await page.waitForFunction(
      (seenUrl) =>
        location.href.includes('/messaging/thread/') && location.href !== seenUrl,
      { timeout: 20000 },
      previousUrl
    );
  } catch (err) {
    console.error(err.stack || err.message);
    return describeThreadOpenFailure(err, '');
  }

  const threadId =
    page.url().match(/\/messaging\/thread\/([^/?#]+)/)?.[1] || '';

  try {
    await page.waitForSelector('.msg-s-event-listitem', { timeout: 15000 });
  } catch (err) {
    console.error(err.stack || err.message);
    return describeThreadOpenFailure(err, threadId, {
      messagingUiRendered: await messagingUiRendered(page),
    });
  }

  return { opened: true, threadId };
}

function threadUrl(threadId) {
  return `https://www.linkedin.com/messaging/thread/${threadId}/`;
}

// A throttled page still fires domcontentloaded, so the only reliable signal
// is the response status. Without this check the missing message selector
// looks identical to an empty conversation.
function rateLimitFromResponse(response, threadId) {
  if (!response) {
    return null;
  }
  const headers = response.headers() || {};
  return describeRateLimit(
    response.status(),
    headers['retry-after'],
    threadId
  );
}

async function messagingUiRendered(page) {
  try {
    return await page.evaluate(() =>
      Boolean(
        document.querySelector(
          '.msg-s-message-list, .msg-s-message-list-container, .msg-thread'
        )
      )
    );
  } catch (err) {
    console.error(err.stack || err.message);
    return false;
  }
}

async function openThreadById(page, threadId) {
  if (!threadId) {
    return { opened: false, reason: 'no thread id' };
  }
  const claimed = await claimConversationPage(threadId);
  if (!claimed.allowed) {
    return { opened: false, budgetPaused: true, reason: 'page-open limit reached' };
  }
  try {
    const response = await page.goto(threadUrl(threadId), {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    const rateLimited = rateLimitFromResponse(response, threadId);
    if (rateLimited) {
      return rateLimited;
    }
    await page.waitForSelector('.msg-s-event-listitem', { timeout: 15000 });
    return { opened: true, threadId };
  } catch (err) {
    console.error(err.stack || err.message);
    return describeThreadOpenFailure(err, threadId, {
      messagingUiRendered: await messagingUiRendered(page),
    });
  }
}

async function openThreadWithBackoff(page, threadId, label) {
  for (let attempt = 1; ; attempt += 1) {
    const opened = await openThreadById(page, threadId);
    if (!opened.rateLimited || attempt > RATE_LIMIT_RETRY_LIMIT || pauseRequested) {
      return opened;
    }
    const waitMs = rateLimitBackoffMs(attempt, opened.retryAfterMs);
    console.log(
      `${label} — ${opened.reason}; waiting ${Math.round(waitMs / 1000)}s before retry ${attempt}/${RATE_LIMIT_RETRY_LIMIT}…`
    );
    await sleep(waitMs);
  }
}

async function runPool(items, concurrency, workerFn, shouldStop = () => pauseRequested) {
  let next = 0;
  const width = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: width }, (_, workerIndex) =>
      (async () => {
        while (true) {
          if (shouldStop()) {
            return;
          }
          const index = next;
          next += 1;
          if (index >= items.length) {
            return;
          }
          await workerFn(items[index], index, workerIndex);
        }
      })()
    )
  );
}

async function openWorkerPages(browser, count) {
  const pages = [];
  for (let i = 0; i < count; i += 1) {
    pages.push(await browser.newPage());
  }
  return pages;
}

async function relaunchMessagingSession(tabCount) {
  await closeActiveBrowser();
  await sleep(BROWSER_RESTART_PAUSE_MS);
  const browser = await launchLinkedInBrowser();
  activeBrowser = browser;
  const page = await browser.newPage();
  await ensureLoggedIn(page, MESSAGING_URL);
  await page.waitForSelector('main', { timeout: 30000 });
  const selfName = await readSelfName(page);
  console.log(`Signed in as ${selfName}`);
  const workers = tabCount > 0 ? await openWorkerPages(browser, tabCount) : [];
  return { browser, page, selfName, workers };
}

async function examineQueuedThreads(toScan, { tabs, selfName, csvPath, rows }) {
  let remaining = toScan.filter(unreadAfterLostContext);
  let restarts = 0;
  let workers = await openWorkerPages(activeBrowser, tabs);
  let currentSelfName = selfName;
  let found = 0;

  while (remaining.length && !pauseRequested) {
    console.log(`Opened ${workers.length} scan tab(s).`);
    let lostError = null;
    let rateLimited = null;
    const shouldStop = () =>
      pauseRequested || Boolean(lostError) || Boolean(rateLimited);

    await runPool(
      remaining,
      workers.length,
      async (entry, _batchIndex, workerIndex) => {
        if (shouldStop()) {
          return;
        }
        const label = `[${entry.scanIndex}/${toScan.length}] ${entry.name} (${entry.activityText})`;
        const worker = workers[workerIndex];
        const row = entry.row;
        try {
          const opened = await openThreadWithBackoff(worker, entry.threadId, label);
          if (!opened.opened) {
            if (opened.lostContext) {
              lostError = opened.error || new Error(opened.reason);
              return;
            }
            if (opened.budgetPaused) {
              pauseRequested = true;
              return;
            }
            if (opened.rateLimited) {
              rateLimited = opened;
              return;
            }
            // The thread was never read, so leave the row alone for a later
            // run instead of recording a verdict we did not observe.
            if (opened.retryable) {
              console.log(`${label} — left unread: ${opened.reason}`);
              return;
            }
            console.log(`${label} — skipped: ${opened.reason}`);
            applyExamineOutcome(
              row,
              { status: 'skipped' },
              {
                activityText: entry.activityText,
                threadId: opened.threadId || entry.threadId,
              }
            );
          } else {
            await scrollWholeThread(worker);
            const result = await classifyThread(worker, currentSelfName);
            const vanityName = vanityFromUrl(result.profileUrl);
            let outcome;

            if (!vanityName) {
              console.log(`${label} — skipped: no member profile link`);
              outcome = { status: 'skipped', reason: 'no profile link' };
            } else if (result.conflicts > 0) {
              console.log(
                `${label} — skipped: ${result.conflicts} message(s) with an unclear sender`
              );
              outcome = { status: 'skipped', reason: 'unclear sender' };
            } else if (result.inbound > 0 && result.outbound === 0) {
              found += 1;
              outcome = { status: 'candidate' };
              console.log(
                `${label} — candidate: ${result.inbound} message(s) in, no reply`
              );
            } else {
              console.log(
                `${label} — keeping: ${result.inbound} in, ${result.outbound} out`
              );
              outcome = { status: 'replied' };
            }
            applyExamineOutcome(row, outcome, {
              title: result.title,
              profileUrl: result.profileUrl,
              vanityName,
              inbound: result.inbound,
              outbound: result.outbound,
              messages: result.messages,
              activityText: entry.activityText,
              threadId: opened.threadId,
            });
          }
        } catch (err) {
          console.error(err.stack || err.message);
          if (isLostContext(err)) {
            lostError = err;
            return;
          }
          applyExamineOutcome(row, { status: 'error' }, { activityText: entry.activityText });
        }

        persistCsv(rows, csvPath);
        await sleep(THREAD_PAUSE_MS);
      },
      shouldStop
    );

    remaining = remaining.filter(unreadAfterLostContext);
    // Retrying into a live rate limit only deepens it, so save and stop.
    if (rateLimited && !pauseRequested) {
      console.log(
        `LinkedIn rate limited the search (HTTP ${rateLimited.status}) after ${RATE_LIMIT_RETRY_LIMIT} retries. ${remaining.length} conversation(s) were left unread so a later run can retry them.`
      );
      pauseRequested = true;
      try {
        persistPause();
      } catch (err) {
        console.error(err.stack || err.message);
      }
      break;
    }
    if (!lostError || pauseRequested || !remaining.length) {
      break;
    }
    restarts += 1;
    if (restarts > SCAN_BROWSER_RESTART_LIMIT) {
      throw new Error(
        `The LinkedIn browser closed ${SCAN_BROWSER_RESTART_LIMIT} time(s) during the search. ${remaining.length} conversation(s) were left unread so a later run can retry them.`
      );
    }
    console.log(
      `Browser session closed. Restarting (${restarts}/${SCAN_BROWSER_RESTART_LIMIT}) with ${remaining.length} conversation(s) still to read…`
    );
    const session = await relaunchMessagingSession(tabs);
    workers = session.workers;
    currentSelfName = session.selfName;
  }

  return { found, workers };
}

async function scrollWholeThread(page) {
  let previousSignature = '';
  let stableRounds = 0;

  for (let round = 0; round < 250 && stableRounds < 4; round += 1) {
    const signature = await page.evaluate(() => {
      const candidates = [
        '.msg-s-message-list',
        '.msg-s-message-list-container',
      ]
        .map((selector) => document.querySelector(selector))
        .filter(Boolean);
      const pane =
        candidates.find((element) => element.scrollHeight > element.clientHeight) ||
        candidates[0];
      if (!pane) {
        throw new Error('Could not find the conversation message pane.');
      }
      const olderButton = [...pane.querySelectorAll('button')].find((button) =>
        /load more|see older|show previous|load previous/i.test(button.textContent)
      );
      olderButton?.click();
      pane.scrollTop = 0;
      const count = pane.querySelectorAll('.msg-s-event-listitem').length;
      return `${pane.scrollHeight}:${count}`;
    });

    stableRounds = signature === previousSignature ? stableRounds + 1 : 0;
    previousSignature = signature;
    await sleep(700);
  }
}

async function classifyThread(page, selfName) {
  return page.evaluate(extractThreadMessages, selfName);
}

async function readSelfName(page) {
  const name = await page.evaluate(() => {
    const alt =
      document.querySelector('.global-nav__me-photo')?.getAttribute('alt') ||
      document.querySelector('img[class*="me-photo"]')?.getAttribute('alt') ||
      '';
    return alt.replace(/^Photo of\s+/i, '').trim();
  });
  if (!name) {
    throw new Error(
      'Could not read the signed-in LinkedIn name needed to tell your messages apart.'
    );
  }
  return name;
}

async function resolveVanityNames(pages, rows, csvPath) {
  const pending = rows.filter(
    (row) =>
      isUnrequitedCandidate(row) &&
      (!row.vanityName || isObfuscatedVanity(row.vanityName)) &&
      row.profileUrl
  );
  if (!pending.length) {
    return 0;
  }

  const workers = pages.filter(Boolean);
  if (!workers.length) {
    throw new Error('No browser tabs available to resolve profile names.');
  }

  console.log(
    `Resolving profile names for ${pending.length} candidate(s) across ${workers.length} tab(s)…`
  );
  let resolved = 0;

  await runPool(pending, workers.length, async (row, _index, workerIndex) => {
    const page = workers[workerIndex];
    try {
      await page.goto(row.profileUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await sleep(PROFILE_PAUSE_MS);
      const vanityName = vanityFromUrl(page.url());
      if (!vanityName || isObfuscatedVanity(vanityName)) {
        console.log(`  ${row.name}: could not resolve a profile name`);
        return;
      }
      row.vanityName = vanityName;
      row.profileUrl = `https://www.linkedin.com/in/${vanityName}/`;
      persistCsv(rows, csvPath);
      resolved += 1;
      console.log(`  ${row.name} → ${vanityName}`);
    } catch (err) {
      console.error(err.stack || err.message);
    }
  });

  return resolved;
}

function countUnresolvedCandidates(rows) {
  return rows.filter(
    (row) =>
      isUnrequitedCandidate(row) &&
      (!row.vanityName || isObfuscatedVanity(row.vanityName))
  ).length;
}

function printStatus(rows, csvPath, state) {
  const candidates = rows.filter(isUnrequitedCandidate);
  const unresolved = countUnresolvedCandidates(rows);
  const examined = rows.filter(
    (row) => row.status && row.status !== 'listed'
  ).length;
  console.log(`Conversation cache:    ${rows.length}`);
  console.log(`Threads examined:      ${examined}`);
  console.log(`Unrequited candidates: ${candidates.length}`);
  console.log(`Ready to remove:       ${candidates.length - unresolved}`);
  console.log(`Awaiting profile name: ${unresolved}`);
  console.log(`List cache complete:   ${state.cacheComplete ? 'yes' : 'no'}`);
  console.log(`Output file:           ${csvPath}`);
  const budget = inspectPageOpens();
  console.log(
    `Conversation pages:    ${budget.lastHour.toLocaleString()}/${budget.hourLimit.toLocaleString()} last hour · ${budget.lastFourHours.toLocaleString()}/${budget.fourHourLimit.toLocaleString()} last 4 hours`
  );
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.status) {
    const statusRows = loadInboxCsv(args.csv);
    const statusState = loadState(args.days);
    hydrateRowsFromState(statusRows, statusState);
    printStatus(statusRows, args.csv, statusState);
    return;
  }

  pageBudgetOverride = Boolean(args.overridePageBudget);
  pageBudgetPace = Boolean(args.pacePageBudget);
  snapshotAll();
  if (args.fresh) {
    removeProtectedFile(STATE_FILE);
    removeProtectedFile(args.csv);
  }

  const state = loadState(args.days);
  const rows = loadInboxCsv(args.csv);
  hydrateRowsFromState(rows, state);
  const cutoff = cutoffForDays(args.days);
  const connectionIndex = buildConnectionIndex(loadConnectionsCsv(CONNECTIONS_FILE));
  if (!connectionIndex.size) {
    throw new Error(
      `No connections found in ${CONNECTIONS_FILE}. Download your connections first — the inbox scan matches conversation names against that list.`
    );
  }
  if (!args.cache && !state.cacheComplete) {
    throw new Error(
      'Cache the conversation list first with --cache before searching for unrequited messages.'
    );
  }
  console.log(`Matching conversations against ${connectionIndex.size} connection name(s).`);
  let browser;

  try {
    browser = await launchLinkedInBrowser();
    activeBrowser = browser;
    let page = await browser.newPage();
    const listWatch = watchMessagingListApi(page);
    await ensureLoggedIn(page, MESSAGING_URL);
    await page.waitForSelector('main', { timeout: 30000 });

    let selfName = await readSelfName(page);
    console.log(`Signed in as ${selfName}`);

    await page.waitForSelector('li.msg-conversation-listitem', { timeout: 30000 });

    if (args.cache) {
      if (state.listCursor) {
        console.log('Resuming the conversation cache from the last saved page…');
      } else {
        console.log('Caching the full conversation list…');
      }
    } else if (state.cacheComplete) {
      console.log(
        `Loading latest messages (cache has ${rows.length} conversation(s))…`
      );
    } else {
      console.log(`Loading conversations active in the last ${args.days} day(s)…`);
    }

    let persistedAt = rows.length;
    persistPause = () => {
      persistCsv(rows, args.csv);
      saveState(state);
    };

    let listResult;
    if (args.cache) {
      // The queryId is a LinkedIn build hash, so read it from the live page
      // rather than trusting the one saved by an earlier run.
      const session = await discoverMessagingListApi(page, listWatch);
      state.listQueryId = session.queryId;
      state.mailboxUrn = session.mailboxUrn;
      const startCursor = state.listCursor || cursorFromOldestCached(rows);
      if (state.listCursor) {
        console.log('Resuming from the saved conversation-list page…');
      } else if (startCursor) {
        console.log('Resuming from the oldest cached thread…');
      } else if (rows.length) {
        console.log('No resume point saved; re-listing from the newest conversation.');
      }
      listResult = await collectConversationsFromApi(page, {
        session,
        startCursor,
        savedCursor: state.listCursor,
        connectionIndex,
        onProgress: (entries) => {
          for (const entry of entries) {
            upsertListedConversation(rows, entry);
          }
          if (rows.length - persistedAt >= CACHE_PERSIST_EVERY) {
            persistCsv(rows, args.csv);
            persistedAt = rows.length;
          }
        },
        onCursor: (cursor, apiSession) => {
          state.listCursor = cursor;
          state.listQueryId = apiSession.queryId;
          state.mailboxUrn = apiSession.mailboxUrn;
          saveState(state);
        },
      });
    } else {
      listResult = await collectConversations(page, {
        cutoff,
        fullList: false,
        cacheComplete: state.cacheComplete,
        cacheRows: rows,
        connectionIndex,
        onProgress: null,
      });
    }
    const { inWindow, total, listed, skipped, undated, caughtUp, stopReason, oldest } =
      listResult;
    if (skipped.notConnected || skipped.group) {
      console.log(
        `Skipped ${skipped.notConnected} conversation(s) not in connections.csv and ${skipped.group} group thread(s).`
      );
    }
    if (undated) {
      console.log(`Skipped ${undated} conversation(s) with an unreadable date.`);
    }
    if (caughtUp) {
      console.log('Caught up with the saved conversation cache.');
    }
    console.log(
      `List stopped: ${stopReason}${oldest ? ` (oldest listed ${oldest})` : ''}.`
    );

    for (const entry of inWindow) {
      upsertListedConversation(rows, entry);
    }
    persistCsv(rows, args.csv);

    if (args.cache) {
      // Only a list that ran out of conversations is a complete cache.
      const reachedEnd = /reached the end of the inbox/.test(stopReason);
      state.cacheComplete = reachedEnd && !pauseRequested;
      state.cacheCompletedAt = state.cacheComplete ? new Date().toISOString() : '';
      // Cursors are only ever the ones LinkedIn handed back, so a finished or
      // invalid run leaves nothing to resume from.
      if (reachedEnd || listResult.staleCursor) {
        state.listCursor = '';
      }
      saveState(state);
      if (listResult.staleCursor) {
        throw new Error(
          'The saved resume position is no longer valid. Run the cache again to list from the newest conversation.'
        );
      }
      if (pauseRequested) {
        console.log('Paused — conversation cache saved. Run cache again to resume older pages.');
      } else if (!reachedEnd) {
        console.log('Cache is partial — run it again to continue from the last saved page.');
      }
      console.log('');
      console.log(`Threads listed:      ${listed}`);
      console.log(`Listed this run:     ${inWindow.length}`);
      console.log(`Conversation cache:  ${rows.length}`);
      if (oldest) {
        console.log(`Oldest conversation: ${oldest}`);
      }
      console.log(`Output file:         ${args.csv}`);
      return;
    }

    const pending = rows.filter((row) =>
      needsExamineWithParser(row, cutoff, parseThreadDate)
    );
    const selected = args.limit ? pending.slice(0, args.limit) : pending;
    console.log(
      `Listed ${total} connection conversation(s) of ${listed}; ${inWindow.length} in the latest window, ${pending.length} need a thread read, reading ${selected.length} with ${args.tabs} tab(s).`
    );

    const toScan = [];
    let listPageRestarts = 0;
    for (const row of selected) {
      const entry = {
        key: `${row.name}|${row.lastActivity}|${row.snippet || ''}`,
        name: row.name,
        activityText: row.lastActivity,
        snippet: row.snippet || '',
        threadId: row.threadId,
        row,
      };
      if (entry.threadId) {
        toScan.push(entry);
        continue;
      }
      while (!pauseRequested) {
        const opened = await openConversation(page, entry);
        if (opened.opened) {
          row.threadId = opened.threadId;
          persistCsv(rows, args.csv);
          toScan.push({ ...entry, threadId: opened.threadId });
          break;
        }
        if (opened.lostContext) {
          listPageRestarts += 1;
          if (listPageRestarts > SCAN_BROWSER_RESTART_LIMIT) {
            throw new Error(
              `The LinkedIn browser closed ${SCAN_BROWSER_RESTART_LIMIT} time(s) before conversations could be opened.`
            );
          }
          console.log(
            `Browser session closed while opening ${entry.name}. Restarting (${listPageRestarts}/${SCAN_BROWSER_RESTART_LIMIT})…`
          );
          const session = await relaunchMessagingSession(0);
          page = session.page;
          selfName = session.selfName;
          continue;
        }
        if (opened.budgetPaused) {
          break;
        }
        console.log(`${entry.name} (${entry.activityText}) — skipped: ${opened.reason}`);
        applyExamineOutcome(row, { status: 'skipped' }, { activityText: entry.activityText });
        persistCsv(rows, args.csv);
        break;
      }
    }

    toScan.forEach((entry, index) => {
      entry.scanIndex = index + 1;
    });

    let found = 0;
    let workers = [];
    if (toScan.length) {
      const examined = await examineQueuedThreads(toScan, {
        tabs: args.tabs,
        selfName,
        csvPath: args.csv,
        rows,
      });
      found = examined.found;
      workers = examined.workers;
    }

    let written = 0;
    try {
      if (!pauseRequested && workers.length) {
        await resolveVanityNames(workers, rows, args.csv);
      }
    } finally {
      written = persistCsv(rows, args.csv);
    }

    const unresolved = countUnresolvedCandidates(rows);
    console.log('');
    console.log(`Scanned this run:  ${selected.length}`);
    console.log(`New candidates:    ${found}`);
    console.log(`Rows in CSV:       ${rows.length}`);
    console.log(`Ready to remove:   ${written}`);
    if (unresolved) {
      console.log(`Awaiting profile name: ${unresolved} — run the search again to finish them`);
    }
    console.log(`Output file:       ${args.csv}`);
    console.log('');
    console.log('Review the CSV, then preview removals with:');
    console.log(`  npm run connections:remove -- --csv ${args.csv} --limit 20`);
  } finally {
    await closeActiveBrowser();
  }
}

async function closeActiveBrowser() {
  const browser = activeBrowser;
  activeBrowser = null;
  if (!browser) {
    return;
  }
  // An orphaned Chromium keeps the profile locked, which stops the next run
  // from launching at all. SIGTERM still lets it flush its preferences, so
  // only fall back to SIGKILL if it ignores that too.
  const child = browser.process();
  const timers = [
    setTimeout(() => child?.kill('SIGTERM'), BROWSER_CLOSE_TIMEOUT_MS),
    setTimeout(() => child?.kill('SIGKILL'), BROWSER_CLOSE_TIMEOUT_MS + BROWSER_KILL_GRACE_MS),
  ];
  try {
    await browser.close();
  } catch (err) {
    console.error(err.stack || err.message);
    child?.kill('SIGTERM');
  } finally {
    for (const timer of timers) {
      clearTimeout(timer);
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (pauseRequested) {
      return;
    }
    pauseRequested = true;
    console.log(`\nPause requested (${signal}) — saving progress…`);
    try {
      persistPause();
    } catch (err) {
      console.error(err.stack || err.message);
    }
    // Chromium outlives this process unless it is closed here, and the orphan
    // holds the profile lock that the resume run needs.
    closeActiveBrowser()
      .catch((err) => console.error(err.stack || err.message))
      .finally(() => {
        console.log('Paused — run the cache again to resume from here.');
        process.exit(0);
      });
  });
}

main()
  .then(() => {
    if (pauseRequested) {
      process.exitCode = 0;
    }
  })
  .catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = pauseRequested ? 0 : 1;
  });
