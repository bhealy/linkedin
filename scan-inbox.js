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

const MESSAGING_URL = 'https://www.linkedin.com/messaging/';
const OUTPUT_FILE = path.join(__dirname, 'unrequited-love.csv');
const CONNECTIONS_FILE = path.join(__dirname, 'connections.csv');
const STATE_FILE = path.join(__dirname, 'inbox-scan-state.json');
const STATE_VERSION = 2;
const DEFAULT_DAYS = 30;
const DEFAULT_TABS = 4;
const MAX_LIST_ROUNDS = 1500;
const LIST_PAUSE_MS = 900;
const LIST_STALL_PAUSE_MS = 2500;
const LIST_STALL_LIMIT = 10;
const CACHE_PERSIST_EVERY = 25;
const LIST_RECOVERY_LIMIT = 3;
const THREAD_PAUSE_MS = 1500;
let activeBrowser = null;
const PROFILE_PAUSE_MS = 2500;

function parseArgs(argv) {
  const args = {
    days: DEFAULT_DAYS,
    limit: null,
    tabs: DEFAULT_TABS,
    cache: false,
    fresh: false,
    status: false,
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

function isLostContext(err) {
  return /Execution context was destroyed|Target closed|detached Frame|Session closed|Navigating frame/i.test(
    String(err && err.message)
  );
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

async function openConversation(page, entry) {
  const previousUrl = page.url();
  const clicked = await page.evaluate((key) => {
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
    return { opened: false, reason: 'conversation did not open' };
  }

  const threadId =
    page.url().match(/\/messaging\/thread\/([^/?#]+)/)?.[1] || '';

  try {
    await page.waitForSelector('.msg-s-event-listitem', { timeout: 15000 });
  } catch (err) {
    console.error(err.stack || err.message);
    return { opened: false, reason: 'no message history in this conversation', threadId };
  }

  return { opened: true, threadId };
}

function threadUrl(threadId) {
  return `https://www.linkedin.com/messaging/thread/${threadId}/`;
}

async function openThreadById(page, threadId) {
  if (!threadId) {
    return { opened: false, reason: 'no thread id' };
  }
  try {
    await page.goto(threadUrl(threadId), {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForSelector('.msg-s-event-listitem', { timeout: 15000 });
    return { opened: true, threadId };
  } catch (err) {
    console.error(err.stack || err.message);
    return { opened: false, reason: 'conversation did not open', threadId };
  }
}

async function runPool(items, concurrency, workerFn) {
  let next = 0;
  const width = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: width }, (_, workerIndex) =>
      (async () => {
        while (true) {
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
  return page.evaluate(
    (selfName) => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const same = (a, b) => clean(a).toLowerCase() === clean(b).toLowerCase();
      const events = [...document.querySelectorAll('.msg-s-event-listitem')];

      let inbound = 0;
      let outbound = 0;
      let conflicts = 0;

      for (const event of events) {
        const fromOther = event.classList.contains('msg-s-event-listitem--other');
        const sender = clean(
          event.querySelector('[class*="message-group__name"]')?.textContent ||
            event.querySelector('img')?.getAttribute('alt')
        );
        if (sender && selfName) {
          const senderIsSelf = same(sender, selfName);
          if (senderIsSelf === fromOther) {
            conflicts += 1;
            continue;
          }
        }
        if (fromOther) {
          inbound += 1;
        } else {
          outbound += 1;
        }
      }

      const lockup = document.querySelector('.msg-entity-lockup');
      const profileLink =
        lockup?.querySelector('a[href*="/in/"]') ||
        document.querySelector('main a[href*="/in/"]');
      const title = clean(
        lockup?.querySelector('[class*="entity-info"], [class*="entity-subtitle"]')
          ?.textContent
      ).replace(/^Status is (?:offline|online|reachable)\s*/i, '');

      return {
        events: events.length,
        inbound,
        outbound,
        conflicts,
        profileUrl: profileLink?.href || '',
        title,
      };
    },
    selfName
  );
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
  console.log(`Matching conversations against ${connectionIndex.size} connection name(s).`);
  let browser;

  try {
    browser = await launchLinkedInBrowser();
    activeBrowser = browser;
    const page = await browser.newPage();
    await ensureLoggedIn(page, MESSAGING_URL);
    await page.waitForSelector('main', { timeout: 30000 });

    const selfName = await readSelfName(page);
    console.log(`Signed in as ${selfName}`);

    await page.waitForSelector('li.msg-conversation-listitem', { timeout: 30000 });

    if (args.cache) {
      console.log('Caching the full conversation list…');
      state.cacheComplete = false;
      state.cacheCompletedAt = '';
      saveState(state);
    } else if (state.cacheComplete) {
      console.log(
        `Loading latest messages (cache has ${rows.length} conversation(s))…`
      );
    } else {
      console.log(`Loading conversations active in the last ${args.days} day(s)…`);
    }

    let persistedAt = rows.length;
    const { inWindow, total, listed, skipped, undated, caughtUp, stopReason, oldest } =
      await collectConversations(page, {
        cutoff,
        fullList: args.cache,
        cacheComplete: state.cacheComplete,
        cacheRows: rows,
        connectionIndex,
        onProgress: args.cache
          ? (entries) => {
              for (const entry of entries) {
                upsertListedConversation(rows, entry);
              }
              if (rows.length - persistedAt >= CACHE_PERSIST_EVERY) {
                persistCsv(rows, args.csv);
                persistedAt = rows.length;
              }
            }
          : null,
      });
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
      // Only a list that ran out of conversations is a complete cache; a reload
      // or the round limit means there is more history still to walk.
      const reachedEnd = /no new conversations/.test(stopReason);
      state.cacheComplete = reachedEnd;
      state.cacheCompletedAt = reachedEnd ? new Date().toISOString() : '';
      saveState(state);
      if (!reachedEnd) {
        console.log('Cache is partial — run it again to continue from the newest messages.');
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
      const opened = await openConversation(page, entry);
      if (!opened.opened) {
        console.log(`${entry.name} (${entry.activityText}) — skipped: ${opened.reason}`);
        applyExamineOutcome(row, { status: 'skipped' }, { activityText: entry.activityText });
        persistCsv(rows, args.csv);
        continue;
      }
      row.threadId = opened.threadId;
      persistCsv(rows, args.csv);
      toScan.push({ ...entry, threadId: opened.threadId });
    }

    const workers = await openWorkerPages(browser, args.tabs);
    console.log(`Opened ${workers.length} scan tab(s).`);

    let found = 0;
    if (toScan.length) {
      await runPool(toScan, workers.length, async (entry, index, workerIndex) => {
        const label = `[${index + 1}/${toScan.length}] ${entry.name} (${entry.activityText})`;
        const worker = workers[workerIndex];
        const row = entry.row;

        try {
          const opened = await openThreadById(worker, entry.threadId);
          if (!opened.opened) {
            console.log(`${label} — skipped: ${opened.reason}`);
            applyExamineOutcome(row, { status: 'skipped' }, {
              activityText: entry.activityText,
              threadId: opened.threadId || entry.threadId,
            });
          } else {
            await scrollWholeThread(worker);
            const result = await classifyThread(worker, selfName);
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
              activityText: entry.activityText,
              threadId: opened.threadId,
            });
          }
        } catch (err) {
          console.error(err.stack || err.message);
          applyExamineOutcome(row, { status: 'error' }, { activityText: entry.activityText });
        }

        persistCsv(rows, args.csv);
        await sleep(THREAD_PAUSE_MS);
      });
    }

    let written = 0;
    try {
      await resolveVanityNames(workers.length ? workers : [page], rows, args.csv);
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
  try {
    await browser.close();
  } catch (err) {
    console.error(err.stack || err.message);
  }
}

// A cancelled run must not leave Chrome holding the session profile — the next
// run cannot reuse it while another instance is open.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\nReceived ${signal} — closing the LinkedIn browser…`);
    closeActiveBrowser().finally(() => process.exit(1));
  });
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
