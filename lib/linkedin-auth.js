const path = require('path');
require('dotenv').config();

const LINKEDIN_EMAIL = process.env.LINKEDIN_EMAIL;
const SESSION_DIR = path.join(__dirname, '..', '.linkedin-session');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function promptPassword() {
  const fromEnv = process.env.LINKEDIN_PASSWORD;
  if (fromEnv) {
    return String(fromEnv);
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      'Password is required. Set LINKEDIN_PASSWORD for this run, or run from a terminal.'
    );
  }

  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    stdout.write(`Password for ${LINKEDIN_EMAIL}: `);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let password = '';

    const onData = (char) => {
      if (char === '\n' || char === '\r' || char === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        stdout.write('\n');
        resolve(password);
        return;
      }

      if (char === '\u0003') {
        process.exit(1);
      }

      if (char === '\u007f' || char === '\b') {
        password = password.slice(0, -1);
        return;
      }

      password += char;
    };

    stdin.on('data', onData);
  });
}

async function hasLinkedInSession(page) {
  const cookies = await page.cookies();
  return cookies.some((cookie) => cookie.name === 'li_at');
}

async function loginToLinkedIn(page, password) {
  await page.goto('https://www.linkedin.com/login', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  await page.waitForSelector('#username', { timeout: 30000 });
  await page.click('#username', { clickCount: 3 });
  await page.type('#username', LINKEDIN_EMAIL, { delay: 20 });
  await page.type('#password', password, { delay: 20 });

  await Promise.all([
    page
      .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 })
      .catch(() => {}),
    page.click('button[type="submit"]'),
  ]);

  if (await hasLinkedInSession(page)) {
    return;
  }

  const currentUrl = page.url();
  if (
    currentUrl.includes('/checkpoint/') ||
    currentUrl.includes('/challenge/')
  ) {
    console.log('\nComplete LinkedIn verification in the browser window…');
  }

  await page.waitForFunction(() => document.cookie.includes('li_at='), {
    timeout: 300000,
  });
}

async function ensureLoggedIn(page, landingUrl, visitLog) {
  await page.goto(landingUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  visitLog?.record('login-check', landingUrl);

  if (await hasLinkedInSession(page)) {
    visitLog?.record('session', page.url());
    return;
  }

  const password = await promptPassword();
  if (!password) {
    throw new Error('Password is required.');
  }

  await loginToLinkedIn(page, password);
  await page.goto(landingUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  visitLog?.record('login-complete', page.url());
}

async function navigateLinkedIn(page, url, options = {}) {
  const timeout = options.timeout ?? 60000;
  const waitSelectors = options.waitSelectors ?? ['main h1', 'main'];

  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout,
  });

  options.visitLog?.record('navigate', url);

  for (const selector of waitSelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 20000 });
      options.visitLog?.record('ready', page.url(), { selector });
      return;
    } catch (err) {
      // Try the next selector — LinkedIn DOM varies by page type.
    }
  }

  options.visitLog?.record('ready-partial', page.url());

  if (page.url().includes('/authwall')) {
    throw new Error(
      'LinkedIn auth wall — log in with npm run connections:download first.'
    );
  }
}

async function waitForProfileContent(page) {
  for (const selector of ['main h1', 'main', '[componentkey*="profile"]']) {
    try {
      await page.waitForSelector(selector, { timeout: 20000 });
      return;
    } catch (err) {
      // Try the next selector — LinkedIn DOM varies by page type.
    }
  }
}

async function launchLinkedInBrowser(options = {}) {
  const puppeteer = require('puppeteer');
  try {
    const browser = await puppeteer.launch({
      headless: options.headless === true ? 'new' : false,
      userDataDir: SESSION_DIR,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: { width: 1280, height: 900 },
    });
    await closeRestoredTabs(browser);
    return browser;
  } catch (err) {
    if (/already running/i.test(err.message)) {
      throw new Error(
        'LinkedIn browser session is already open. Close the Chrome window from a previous npm run, then retry.'
      );
    }
    throw err;
  }
}

async function closeRestoredTabs(browser) {
  const pages = await browser.pages();
  if (!pages.length) {
    return;
  }
  console.log(`Closing ${pages.length} restored tab(s)…`);
  await Promise.all(
    pages.map(async (page) => {
      try {
        await page.close();
      } catch (err) {
        console.error(err.stack || err.message);
      }
    })
  );
}

module.exports = {
  LINKEDIN_EMAIL,
  SESSION_DIR,
  sleep,
  promptPassword,
  hasLinkedInSession,
  loginToLinkedIn,
  ensureLoggedIn,
  navigateLinkedIn,
  waitForProfileContent,
  launchLinkedInBrowser,
};
