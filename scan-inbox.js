const fs = require('fs');
const path = require('path');
require('dotenv').config();

const {
  ensureLoggedIn,
  launchLinkedInBrowser,
  sleep,
} = require('./lib/linkedin-auth');
const { cutoffForDays, parseThreadDate } = require('./lib/inbox-thread-date');
const { escapeCsv, parseCsvRow } = require('./lib/connections-csv');
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
  return args;
}

function emptyState(days) {
  return {
    version: STATE_VERSION,
    days,
    scanned: {},
    updatedAt: new Date().toISOString(),
  };
}

function loadState(days) {
  if (!fs.existsSync(STATE_FILE)) {
    return emptyState(days);
  }
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!state || typeof state.scanned !== 'object') {
      return emptyState(days);
    }
    return {
      ...state,
      version: STATE_VERSION,
      days,
      scanned: state.scanned || {},
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

function loadCandidates(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const lines = fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (lines.length < 2) {
    return [];
  }
  const header = parseCsvRow(lines[0]).map((field) => field.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const fields = parseCsvRow(line);
    const value = (name) => fields[header.indexOf(name)] || '';
    return {
      name: value('name'),
      title: value('title'),
      profileUrl: value('profile_url'),
      vanityName: value('vanity_name'),
      connectedOn: value('connected_on'),
      disconnected: value('disconnected'),
      disconnectedOn: value('disconnected_on'),
      lastActivity: value('last_activity'),
      inboundCount: value('inbound_count'),
      scannedAt: value('scanned_at'),
    };
  });
}

function writeCandidates(rows, filePath) {
  const lines = [
    CSV_FIELDS.join(','),
    ...rows.map((row) =>
      [
        row.name,
        row.title,
        row.profileUrl,
        row.vanityName,
        row.connectedOn,
        row.disconnected,
        row.disconnectedOn,
        row.lastActivity,
        row.inboundCount,
        row.scannedAt,
      ]
        .map(escapeCsv)
        .join(',')
    ),
  ];
  writeProtectedFile(filePath, `${lines.join('\n')}\n`);
}

async function clickConnectionsFilter(page) {
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('button, [role="button"]')].some(
        (element) => element.textContent.trim() === 'Connections'
      ),
    { timeout: 30000 }
  );
  const clicked = await page.evaluate(() => {
    const element = [...document.querySelectorAll('button, [role="button"]')].find(
      (candidate) => candidate.textContent.trim() === 'Connections'
    );
    if (!element) {
      return false;
    }
    element.click();
    return true;
  });
  if (!clicked) {
    throw new Error('Could not find the Connections inbox filter.');
  }
  await sleep(1200);
  const selected = await page.evaluate(() => {
    const element = [...document.querySelectorAll('button, [role="button"]')].find(
      (candidate) => candidate.textContent.trim() === 'Connections'
    );
    if (!element) {
      return false;
    }
    return (
      element.getAttribute('aria-pressed') === 'true' ||
      element.getAttribute('aria-selected') === 'true' ||
      /\bactive\b|\bselected\b/.test(element.className)
    );
  });
  if (!selected) {
    throw new Error('LinkedIn did not select the Connections inbox filter.');
  }
}

async function collectThreads(page, cutoff) {
  const collected = new Map();
  let stableRounds = 0;
  let passedCutoff = false;

  for (let round = 0; round < 250 && stableRounds < 6 && !passedCutoff; round += 1) {
    const batch = await page.evaluate(() => {
      const itemSelector = [
        'li.msg-conversation-listitem',
        'li[class*="conversation-listitem"]',
        '[data-view-name="message-list-item"]',
      ].join(',');
      return [...document.querySelectorAll(itemSelector)].map((item, index) => {
        const link = item.querySelector('a[href*="/messaging/thread/"]');
        const time = item.querySelector(
          'time, .msg-conversation-listitem__time-stamp, [class*="time-stamp"]'
        );
        const name = item.querySelector(
          '.msg-conversation-listitem__participant-names, [class*="participant-names"], h3'
        );
        const title = item.querySelector(
          '.msg-conversation-listitem__message-snippet, [class*="message-snippet"]'
        );
        const href = link ? new URL(link.href, location.href).href : '';
        const id =
          item.getAttribute('data-conversation-id') ||
          href.match(/\/messaging\/thread\/([^/?#]+)/)?.[1] ||
          `${name?.textContent.trim() || 'thread'}-${time?.textContent.trim() || index}`;
        return {
          id,
          href,
          name: name?.textContent.trim() || '',
          title: title?.textContent.trim() || '',
          activityText:
            time?.getAttribute('datetime') ||
            time?.getAttribute('aria-label') ||
            time?.textContent.trim() ||
            '',
        };
      });
    });

    const before = collected.size;
    for (const thread of batch) {
      if (thread.id && thread.href) {
        collected.set(thread.id, thread);
      }
      const activity = parseThreadDate(thread.activityText);
      if (activity && activity.getTime() < cutoff.getTime()) {
        passedCutoff = true;
      }
    }
    stableRounds = collected.size === before ? stableRounds + 1 : 0;
    await page.evaluate(() => {
      const selectors = [
        '.msg-conversations-container__conversations-list',
        '.msg-conversations-container__convo-list',
        '[class*="conversations-list"]',
      ];
      const container = selectors
        .map((selector) => document.querySelector(selector))
        .find((element) => element && element.scrollHeight > element.clientHeight);
      if (!container) {
        throw new Error('Could not find the scrollable inbox conversation list.');
      }
      container.scrollTop = container.scrollHeight;
    });
    await sleep(800);
  }

  return [...collected.values()].filter((thread) => {
    const activity = parseThreadDate(thread.activityText);
    return activity && activity.getTime() >= cutoff.getTime();
  });
}

async function getSelfName(page) {
  return page.evaluate(() => {
    const candidates = [
      document.querySelector('.global-nav__me-photo'),
      document.querySelector('button[aria-label*="Me"] img'),
      document.querySelector('img.global-nav__me-photo'),
    ];
    for (const element of candidates) {
      const text = element?.getAttribute('alt')?.trim();
      if (text) {
        return text.replace(/^Photo of\s+/i, '');
      }
    }
    return '';
  });
}

async function scrollWholeThread(page) {
  let stableRounds = 0;
  let previousSignature = '';
  for (let round = 0; round < 250 && stableRounds < 6; round += 1) {
    const signature = await page.evaluate(() => {
      const selectors = [
        '.msg-s-message-list-container',
        '.msg-s-message-list',
        '[class*="message-list-container"]',
      ];
      const container = selectors
        .map((selector) => document.querySelector(selector))
        .find((element) => element && element.scrollHeight >= element.clientHeight);
      if (!container) {
        throw new Error('Could not find the conversation message pane.');
      }
      const olderButton = [...container.querySelectorAll('button')].find((button) =>
        /load more|see older|show previous/i.test(button.textContent)
      );
      olderButton?.click();
      container.scrollTop = 0;
      const bodyCount = container.querySelectorAll(
        '.msg-s-event-listitem__body'
      ).length;
      const count =
        bodyCount ||
        container.querySelectorAll('[class*="message-bubble"]').length;
      return `${container.scrollHeight}:${count}:${Math.round(container.scrollTop)}`;
    });
    stableRounds = signature === previousSignature ? stableRounds + 1 : 0;
    previousSignature = signature;
    await sleep(800);
  }
}

async function inspectThread(page, selfName, fallbackName, activityText) {
  return page.evaluate(
    ({ selfName, fallbackName, activityText }) => {
      const normal = (value) =>
        String(value || '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
      const messageBodies = [
        ...document.querySelectorAll('.msg-s-event-listitem__body'),
      ];
      const bodies = (
        messageBodies.length
          ? messageBodies
          : [...document.querySelectorAll('[class*="message-bubble"]')]
      ).filter((body) => normal(body.textContent));
      let inbound = 0;
      let outbound = 0;
      let unknown = 0;
      for (const body of bodies) {
        const event = body.closest(
          '.msg-s-event-listitem, .msg-s-message-list__event, li'
        );
        const group = body.closest(
          '.msg-s-message-group, [class*="message-group"]'
        );
        const classText = `${event?.className || ''} ${group?.className || ''}`;
        const sender = group?.querySelector(
          '.msg-s-message-group__name, [class*="message-group__name"]'
        )?.textContent;
        if (/from-me|is-own|outgoing|--self/.test(classText)) {
          outbound += 1;
        } else if (/--other|incoming|from-other/.test(classText)) {
          inbound += 1;
        } else if (sender && selfName && normal(sender) === normal(selfName)) {
          outbound += 1;
        } else if (sender) {
          inbound += 1;
        } else {
          unknown += 1;
        }
      }

      const header =
        document.querySelector('.msg-thread, .msg-overlay-conversation-bubble') ||
        document.querySelector('main') ||
        document;
      const profileLink = header.querySelector('a[href*="/in/"]');
      const name =
        header.querySelector(
          '.msg-entity-lockup__entity-title, [class*="entity-title"], h2'
        )?.textContent.trim() ||
        profileLink?.textContent.trim() ||
        fallbackName;
      const title =
        header.querySelector(
          '.msg-entity-lockup__entity-subtitle, [class*="entity-subtitle"]'
        )?.textContent.trim() || '';
      return {
        name,
        title,
        profileUrl: profileLink?.href || '',
        activityText,
        inbound,
        outbound,
        unknown,
      };
    },
    { selfName, fallbackName, activityText }
  );
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.status) {
    const state = loadState(args.days);
    console.log(`Scanned threads: ${Object.keys(state.scanned).length}`);
    console.log(`Candidates: ${loadCandidates(args.csv).length}`);
    console.log(`Output file: ${args.csv}`);
    return;
  }

  snapshotAll();
  if (args.fresh) {
    removeProtectedFile(STATE_FILE);
    removeProtectedFile(args.csv);
  }
  const state = loadState(args.days);
  const candidates = loadCandidates(args.csv);
  const candidateVanities = new Set(
    candidates.map((row) => row.vanityName.toLowerCase()).filter(Boolean)
  );
  const cutoff = cutoffForDays(args.days);
  let browser;

  try {
    browser = await launchLinkedInBrowser();
    const page = await browser.newPage();
    await ensureLoggedIn(page, MESSAGING_URL);
    await page.waitForSelector('main', { timeout: 30000 });
    console.log('Selecting Connections inbox filter…');
    await clickConnectionsFilter(page);
    console.log(`Loading conversations from the last ${args.days} day(s)…`);
    const threads = await collectThreads(page, cutoff);
    const pending = threads.filter((thread) => !state.scanned[thread.id]);
    const selected = args.limit ? pending.slice(0, args.limit) : pending;
    const selfName = await getSelfName(page);
    console.log(`Found ${threads.length} in-window conversation(s); scanning ${selected.length}.`);

    for (let index = 0; index < selected.length; index += 1) {
      const thread = selected[index];
      console.log(`[${index + 1}/${selected.length}] ${thread.name || thread.id}`);
      let result;
      try {
        await page.goto(thread.href, {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
        await page.waitForSelector(
          '.msg-s-message-list-container, .msg-s-message-list, [class*="message-list-container"]',
          { timeout: 30000 }
        );
        await scrollWholeThread(page);
        result = await inspectThread(
          page,
          selfName,
          thread.name,
          thread.activityText
        );
      } catch (err) {
        console.error(err.stack || err.message);
        state.scanned[thread.id] = {
          status: 'error',
          error: err.message,
          scannedAt: new Date().toISOString(),
        };
        saveState(state);
        continue;
      }

      const vanityName = vanityFromUrl(result.profileUrl);
      let status = 'not-candidate';
      if (!vanityName) {
        status = 'skipped-no-profile';
      } else if (result.unknown > 0) {
        status = 'skipped-unknown-sender';
      } else if (result.inbound > 0 && result.outbound === 0) {
        status = 'candidate';
        if (!candidateVanities.has(vanityName.toLowerCase())) {
          candidates.push({
            name: result.name,
            title: result.title,
            profileUrl: result.profileUrl,
            vanityName,
            connectedOn: '',
            disconnected: '',
            disconnectedOn: '',
            lastActivity: result.activityText,
            inboundCount: String(result.inbound),
            scannedAt: new Date().toISOString(),
          });
          candidateVanities.add(vanityName.toLowerCase());
          writeCandidates(candidates, args.csv);
        }
      }
      state.scanned[thread.id] = {
        status,
        vanityName,
        inbound: result.inbound,
        outbound: result.outbound,
        unknown: result.unknown,
        scannedAt: new Date().toISOString(),
      };
      saveState(state);
    }

    if (!fs.existsSync(args.csv)) {
      writeCandidates(candidates, args.csv);
    }
    console.log(`Scanned this run: ${selected.length}`);
    console.log(`Candidates in CSV: ${candidates.length}`);
    console.log(`Output file: ${args.csv}`);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
