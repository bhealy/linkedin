const fs = require('fs');
const path = require('path');
require('dotenv').config();

const {
  ensureLoggedIn,
  launchLinkedInBrowser,
  sleep,
} = require('./lib/linkedin-auth');
const { cutoffForDays, parseThreadDate } = require('./lib/inbox-thread-date');
const { escapeCsv } = require('./lib/connections-csv');
const {
  removeProtectedFile,
  snapshotAll,
  writeProtectedFile,
} = require('./lib/rolling-backup');

const MESSAGING_URL = 'https://www.linkedin.com/messaging/';
const OUTPUT_FILE = path.join(__dirname, 'unrequited-love.csv');
const STATE_FILE = path.join(__dirname, 'inbox-scan-state.json');
const STATE_VERSION = 1;
const DEFAULT_DAYS = 30;
const DEFAULT_TABS = 4;
const THREAD_PAUSE_MS = 1500;
let activeBrowser = null;
const PROFILE_PAUSE_MS = 2500;
const CSV_FIELDS = [
  'name',
  'title',
  'profile_url',
  'vanity_name',
  'connected_on',
  'disconnected',
  'disconnected_on',
  'last_activity',
  'inbound_count',
  'scanned_at',
];

function parseArgs(argv) {
  const args = {
    days: DEFAULT_DAYS,
    limit: null,
    tabs: DEFAULT_TABS,
    fresh: false,
    status: false,
    csv: OUTPUT_FILE,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--fresh') {
      args.fresh = true;
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
    candidates: {},
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

function writeCandidatesCsv(state, filePath) {
  const rows = Object.values(state.candidates || {}).filter(
    (candidate) => candidate.vanityName && !isObfuscatedVanity(candidate.vanityName)
  );
  const lines = [
    CSV_FIELDS.join(','),
    ...rows.map((row) =>
      [
        row.name || '',
        row.title || '',
        row.profileUrl || '',
        row.vanityName,
        '',
        '',
        '',
        row.activityText || '',
        String(row.inbound ?? ''),
        row.scannedAt || '',
      ]
        .map(escapeCsv)
        .join(',')
    ),
  ];
  writeProtectedFile(filePath, `${lines.join('\n')}\n`);
  return rows.length;
}

const CONNECTIONS_FILTER_STATE = () => {
  const element = [...document.querySelectorAll('button, [role="button"]')].find(
    (candidate) => candidate.textContent.trim() === 'Connections'
  );
  if (!element) {
    return 'missing';
  }
  const selected =
    element.getAttribute('aria-pressed') === 'true' ||
    element.getAttribute('aria-checked') === 'true' ||
    element.getAttribute('aria-selected') === 'true' ||
    /\bactive\b|\bselected\b/.test(element.className);
  return selected ? 'selected' : 'available';
};

async function selectConnectionsFilter(page) {
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('button, [role="button"]')].some(
        (candidate) => candidate.textContent.trim() === 'Connections'
      ),
    { timeout: 30000 }
  );

  if ((await page.evaluate(CONNECTIONS_FILTER_STATE)) === 'available') {
    await page.evaluate(() => {
      [...document.querySelectorAll('button, [role="button"]')]
        .find((candidate) => candidate.textContent.trim() === 'Connections')
        ?.click();
    });
    await sleep(2000);
  }

  if ((await page.evaluate(CONNECTIONS_FILTER_STATE)) !== 'selected') {
    throw new Error('LinkedIn did not apply the Connections inbox filter.');
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
    const before = list.scrollTop;
    list.scrollTop = list.scrollHeight;
    return list.scrollTop > before;
  });
}

async function collectConversations(page, cutoff) {
  const collected = new Map();
  let stableRounds = 0;
  let reachedCutoff = false;

  for (let round = 0; round < 200 && stableRounds < 4 && !reachedCutoff; round += 1) {
    const batch = await readConversationList(page);
    const before = collected.size;
    for (const entry of batch) {
      if (!entry.name) {
        continue;
      }
      const existing = collected.get(entry.key);
      if (!existing || (!existing.threadId && entry.threadId)) {
        collected.set(entry.key, entry);
      }
      const activity = parseThreadDate(entry.activityText);
      if (activity && activity.getTime() < cutoff.getTime()) {
        reachedCutoff = true;
      }
    }
    stableRounds = collected.size === before ? stableRounds + 1 : 0;
    if (reachedCutoff) {
      break;
    }
    await scrollConversationList(page);
    await sleep(900);
  }

  const inWindow = [];
  let undated = 0;
  for (const entry of collected.values()) {
    const activity = parseThreadDate(entry.activityText);
    if (!activity) {
      undated += 1;
      continue;
    }
    if (activity.getTime() >= cutoff.getTime()) {
      inWindow.push(entry);
    }
  }
  return { inWindow, total: collected.size, undated };
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

async function resolveVanityNames(pages, state) {
  const pending = Object.entries(state.candidates || {}).filter(
    ([, candidate]) =>
      !candidate.vanityName || isObfuscatedVanity(candidate.vanityName)
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

  await runPool(pending, workers.length, async ([threadId, candidate], _index, workerIndex) => {
    if (!candidate.profileUrl) {
      return;
    }
    const page = workers[workerIndex];
    try {
      await page.goto(candidate.profileUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await sleep(PROFILE_PAUSE_MS);
      const vanityName = vanityFromUrl(page.url());
      if (!vanityName || isObfuscatedVanity(vanityName)) {
        console.log(`  ${candidate.name}: could not resolve a profile name`);
        return;
      }
      state.candidates[threadId] = {
        ...state.candidates[threadId],
        vanityName,
        profileUrl: `https://www.linkedin.com/in/${vanityName}/`,
      };
      saveState(state);
      resolved += 1;
      console.log(`  ${candidate.name} → ${vanityName}`);
    } catch (err) {
      console.error(err.stack || err.message);
    }
  });

  return resolved;
}

function countUnresolvedCandidates(state) {
  return Object.values(state.candidates || {}).filter(
    (candidate) => !candidate.vanityName || isObfuscatedVanity(candidate.vanityName)
  ).length;
}

function printStatus(state, csvPath) {
  const scanned = Object.keys(state.scanned || {}).length;
  const candidates = Object.values(state.candidates || {});
  const unresolved = countUnresolvedCandidates(state);
  console.log(`Scanned conversations: ${scanned}`);
  console.log(`Candidates found:      ${candidates.length}`);
  console.log(`Ready to remove:       ${candidates.length - unresolved}`);
  console.log(`Awaiting profile name: ${unresolved}`);
  console.log(`Output file:           ${csvPath}`);
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.status) {
    printStatus(loadState(args.days), args.csv);
    return;
  }

  snapshotAll();
  if (args.fresh) {
    removeProtectedFile(STATE_FILE);
    removeProtectedFile(args.csv);
  }

  const state = loadState(args.days);
  const cutoff = cutoffForDays(args.days);
  let browser;

  try {
    browser = await launchLinkedInBrowser();
    activeBrowser = browser;
    const page = await browser.newPage();
    await ensureLoggedIn(page, MESSAGING_URL);
    await page.waitForSelector('main', { timeout: 30000 });

    const selfName = await readSelfName(page);
    console.log(`Signed in as ${selfName}`);

    console.log('Applying the Connections inbox filter…');
    await selectConnectionsFilter(page);
    await page.waitForSelector('li.msg-conversation-listitem', { timeout: 30000 });

    console.log(`Loading conversations active in the last ${args.days} day(s)…`);
    const { inWindow, total, undated } = await collectConversations(page, cutoff);
    if (undated) {
      console.log(`Skipped ${undated} conversation(s) with an unreadable date.`);
    }

    const pending = inWindow.filter((entry) => !state.scanned[entry.key]);
    const selected = args.limit ? pending.slice(0, args.limit) : pending;
    console.log(
      `Listed ${total} conversation(s); ${inWindow.length} in window, ${pending.length} unscanned, scanning ${selected.length} with ${args.tabs} tab(s).`
    );

    const toScan = [];
    for (const entry of selected) {
      if (entry.threadId) {
        toScan.push(entry);
        continue;
      }
      const opened = await openConversation(page, entry);
      if (!opened.opened) {
        console.log(`${entry.name} (${entry.activityText}) — skipped: ${opened.reason}`);
        state.scanned[entry.key] = {
          status: 'skipped',
          reason: opened.reason,
          name: entry.name,
          activityText: entry.activityText,
          scannedAt: new Date().toISOString(),
        };
        saveState(state);
        continue;
      }
      toScan.push({ ...entry, threadId: opened.threadId });
    }

    const workers = await openWorkerPages(browser, args.tabs);
    console.log(`Opened ${workers.length} scan tab(s).`);

    let found = 0;
    if (toScan.length) {
      await runPool(toScan, workers.length, async (entry, index, workerIndex) => {
        const label = `[${index + 1}/${toScan.length}] ${entry.name} (${entry.activityText})`;
        const worker = workers[workerIndex];
        let outcome;

        try {
          const opened = await openThreadById(worker, entry.threadId);
          if (!opened.opened) {
            console.log(`${label} — skipped: ${opened.reason}`);
            outcome = { status: 'skipped', reason: opened.reason };
          } else {
            await scrollWholeThread(worker);
            const result = await classifyThread(worker, selfName);
            const vanityName = vanityFromUrl(result.profileUrl);

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
              state.candidates[opened.threadId] = {
                name: entry.name,
                title: result.title,
                profileUrl: result.profileUrl,
                vanityName,
                activityText: entry.activityText,
                inbound: result.inbound,
                scannedAt: new Date().toISOString(),
              };
              console.log(
                `${label} — candidate: ${result.inbound} message(s) in, no reply`
              );
              outcome = { status: 'candidate', threadId: opened.threadId };
            } else {
              console.log(
                `${label} — keeping: ${result.inbound} in, ${result.outbound} out`
              );
              outcome = { status: 'replied' };
            }
            outcome = {
              ...outcome,
              inbound: result.inbound,
              outbound: result.outbound,
              messages: result.events,
            };
          }
        } catch (err) {
          console.error(err.stack || err.message);
          outcome = { status: 'error', reason: err.message };
        }

        state.scanned[entry.key] = {
          ...outcome,
          name: entry.name,
          activityText: entry.activityText,
          scannedAt: new Date().toISOString(),
        };
        saveState(state);
        await sleep(THREAD_PAUSE_MS);
      });
    }

    // A candidate only reaches the CSV once its profile name is resolved, so
    // always write what we have even if resolving some of them fails.
    let written = 0;
    try {
      await resolveVanityNames(workers.length ? workers : [page], state);
    } finally {
      written = writeCandidatesCsv(state, args.csv);
    }

    const unresolved = countUnresolvedCandidates(state);
    console.log('');
    console.log(`Scanned this run:  ${selected.length}`);
    console.log(`New candidates:    ${found}`);
    console.log(`Rows in CSV:       ${written}`);
    if (unresolved) {
      console.log(`Awaiting profile name: ${unresolved} — run the scan again to finish them`);
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
