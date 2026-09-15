function parseMessagesJson(raw) {
  if (Array.isArray(raw)) {
    return raw;
  }
  const text = String(raw || '').trim();
  if (!text) {
    return [];
  }
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error(err.stack || err.message);
    return [];
  }
}

function serializeMessages(messages) {
  return JSON.stringify(Array.isArray(messages) ? messages : []);
}

function filterMessages(messages, direction) {
  const rows = parseMessagesJson(messages);
  if (!direction || direction === 'all') {
    return rows;
  }
  return rows.filter((message) => message.direction === direction);
}

// Passed into page.evaluate, so it must stay self-contained.
function extractThreadMessages(selfName) {
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const same = (a, b) => clean(a).toLowerCase() === clean(b).toLowerCase();
  const events = [...document.querySelectorAll('.msg-s-event-listitem')];
  const messages = [];
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
    const direction = fromOther ? 'in' : 'out';
    if (direction === 'in') {
      inbound += 1;
    } else {
      outbound += 1;
    }
    const text = clean(
      event.querySelector('.msg-s-event-listitem__body')?.textContent ||
        event.querySelector('.msg-s-event-listitem__message-bubble')?.textContent ||
        event.querySelector('p')?.textContent
    );
    const timeEl = event.querySelector('time');
    const at = clean(
      timeEl?.getAttribute('datetime') ||
        timeEl?.textContent ||
        event.querySelector('[class*="time-ago"], [class*="timestamp"], [class*="time-stamp"]')
          ?.textContent
    );
    messages.push({
      direction,
      text: text || '(attachment or sticker)',
      at,
      sender,
    });
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
    messages,
    profileUrl: profileLink?.href || '',
    title,
  };
}

async function scrapeThreadMessages(threadId, password) {
  if (!threadId) {
    throw new Error('This conversation has no LinkedIn thread id yet.');
  }
  const {
    ensureLoggedIn,
    launchLinkedInBrowser,
    sleep,
  } = require('./linkedin-auth');
  const previousPassword = process.env.LINKEDIN_PASSWORD;
  if (password) {
    process.env.LINKEDIN_PASSWORD = String(password);
  }
  let browser;
  try {
    browser = await launchLinkedInBrowser();
    const page = await browser.newPage();
    const url = `https://www.linkedin.com/messaging/thread/${threadId}/`;
    await ensureLoggedIn(page, url);
    await page.waitForSelector('.msg-s-event-listitem', { timeout: 20000 });
    let previous = '';
    let stable = 0;
    for (let round = 0; round < 40 && stable < 3; round += 1) {
      const signature = await page.evaluate(() => {
        const pane =
          document.querySelector('.msg-s-message-list') ||
          document.querySelector('.msg-s-message-list-container');
        if (!pane) {
          return '';
        }
        pane.scrollTop = 0;
        return `${pane.scrollHeight}:${document.querySelectorAll('.msg-s-event-listitem').length}`;
      });
      stable = signature && signature === previous ? stable + 1 : 0;
      previous = signature;
      await sleep(400);
    }
    const selfName = await page.evaluate(() => {
      const alt =
        document.querySelector('.global-nav__me-photo')?.getAttribute('alt') ||
        document.querySelector('img[class*="me-photo"]')?.getAttribute('alt') ||
        '';
      return alt.replace(/^Photo of\s+/i, '').trim();
    });
    return page.evaluate(extractThreadMessages, selfName);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (err) {
        console.error(err.stack || err.message);
      }
    }
    if (password) {
      if (previousPassword === undefined) {
        delete process.env.LINKEDIN_PASSWORD;
      } else {
        process.env.LINKEDIN_PASSWORD = previousPassword;
      }
    }
  }
}

function threadUrl(threadId) {
  return threadId ? `https://www.linkedin.com/messaging/thread/${threadId}/` : '';
}

module.exports = {
  parseMessagesJson,
  serializeMessages,
  filterMessages,
  extractThreadMessages,
  scrapeThreadMessages,
  threadUrl,
};
