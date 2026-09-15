const fs = require('fs');
const path = require('path');
require('dotenv').config();

const LINKEDIN_EMAIL = process.env.LINKEDIN_EMAIL;
const SESSION_DIR = path.join(__dirname, '..', '.linkedin-session');
const BROWSER_LOCK_PATH = path.join(SESSION_DIR, '.linkedin-browser.lock');

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

const SIGNED_OUT_URL = /\/(login|authwall|checkpoint|challenge|uas\/login)/;

// A rejected li_at still sits in the cookie jar, so presence alone proves
// nothing. LinkedIn redirects an unauthenticated request to login/authwall,
// which is what actually tells us the cookie was accepted.
function looksSignedOut(url) {
  return SIGNED_OUT_URL.test(String(url || ''));
}

// Injected only when the saved profile has no session, so a stale LI_AT in
// .env can never displace a working login.
async function applyLiAtCookie(page) {
  const raw = process.env.LI_AT;
  if (!raw) {
    return false;
  }
  const value = String(raw).trim().replace(/^"|"$/g, '');
  if (!value) {
    return false;
  }

  await page.browser().setCookie({
    name: 'li_at',
    value,
    domain: '.www.linkedin.com',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'None',
  });
  return true;
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

  if (await applyLiAtCookie(page)) {
    await page.goto(landingUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    if (!looksSignedOut(page.url()) && (await hasLinkedInSession(page))) {
      console.log('Signed in with the LI_AT cookie from .env.');
      visitLog?.record('session-li-at', page.url());
      return;
    }
    console.log('LI_AT cookie was rejected — sign in below to refresh it.');
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

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'EPERM') {
      return true;
    }
    if (err.code === 'ESRCH') {
      return false;
    }
    throw err;
  }
}

function classifyBrowserLock(lock, checkPid = isPidAlive) {
  const pid = Number(lock?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { state: 'stale', pid: null };
  }
  return { state: checkPid(pid) ? 'held' : 'stale', pid };
}

function browserAlreadyRunningError(pid) {
  return new Error(
    `A LinkedIn browser session is already running (pid ${pid}). Stop it first.`
  );
}

function acquireBrowserLock(options = {}) {
  const lockPath = options.lockPath || BROWSER_LOCK_PATH;
  const pid = options.pid || process.pid;
  const checkPid = options.checkPid || isPidAlive;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.writeFileSync(
        lockPath,
        `${JSON.stringify({ pid, startedAt: new Date().toISOString() })}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 }
      );
      let released = false;
      const release = () => {
        if (released) {
          return;
        }
        released = true;
        process.removeListener('exit', release);
        try {
          const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          if (Number(current.pid) === pid) {
            fs.unlinkSync(lockPath);
          }
        } catch (err) {
          if (err.code !== 'ENOENT') {
            console.error(err.stack || err.message);
          }
        }
      };
      process.once('exit', release);
      return release;
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw err;
      }

      let lock = null;
      try {
        lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      } catch (readErr) {
        if (readErr.code !== 'ENOENT' && readErr.name !== 'SyntaxError') {
          throw readErr;
        }
      }
      const status = classifyBrowserLock(lock, checkPid);
      if (status.state === 'held') {
        throw browserAlreadyRunningError(status.pid);
      }
      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkErr) {
        if (unlinkErr.code !== 'ENOENT') {
          throw unlinkErr;
        }
      }
    }
  }
  throw new Error(`Could not acquire the LinkedIn browser lock at ${lockPath}.`);
}

function chromiumSingletonPid(sessionDir = SESSION_DIR) {
  const singletonLock = path.join(sessionDir, 'SingletonLock');
  try {
    const target = fs.readlinkSync(singletonLock);
    const match = target.match(/-(\d+)$/);
    return match ? Number(match[1]) : null;
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EINVAL') {
      return null;
    }
    throw err;
  }
}

function chromiumSingletonPaths(sessionDir = SESSION_DIR) {
  return ['SingletonLock', 'SingletonSocket', 'SingletonCookie'].map((name) =>
    path.join(sessionDir, name)
  );
}

function unlinkIfPresent(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(err.stack || err.message);
      throw err;
    }
  }
}

// Chrome leaves SingletonLock behind after a crash. A dead pid is stale and
// must be removed so the next launch is not refused.
function clearStaleChromiumSingleton(sessionDir = SESSION_DIR, checkPid = isPidAlive) {
  const lockPath = path.join(sessionDir, 'SingletonLock');
  try {
    fs.lstatSync(lockPath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { state: 'absent', pid: null };
    }
    throw err;
  }

  const pid = chromiumSingletonPid(sessionDir);
  if (pid && checkPid(pid)) {
    throw browserAlreadyRunningError(pid);
  }

  for (const filePath of chromiumSingletonPaths(sessionDir)) {
    unlinkIfPresent(filePath);
  }
  return { state: 'stale', pid: pid || null };
}

// LinkedIn challenges sessions that advertise automation. The installed Google
// Chrome is used instead of Puppeteer's unbranded Chrome for Testing build, and
// the automation switches are dropped so navigator.webdriver reports false.
// defaultViewport is null so the page size comes from the real window rather
// than a CDP metrics override, which would leave screen and viewport mismatched.
// Every entry point must share these options: opening SESSION_DIR with a
// different Chrome build upgrades the profile and locks the other build out.
function browserLaunchOptions(options = {}) {
  return {
    headless: options.headless === true ? 'new' : false,
    channel: 'chrome',
    userDataDir: SESSION_DIR,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    defaultViewport: null,
    dumpio: options.dumpio === true,
  };
}

async function launchLinkedInBrowser(options = {}) {
  const puppeteer = require('puppeteer');
  const releaseLock = acquireBrowserLock();
  let browser = null;
  try {
    clearStaleChromiumSingleton();

    browser = await puppeteer.launch(browserLaunchOptions(options));
    browser.once('disconnected', releaseLock);
    await closeRestoredTabs(browser);
    return browser;
  } catch (err) {
    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        console.error(closeErr.stack || closeErr.message);
      }
    }
    releaseLock();
    if (/already running/i.test(err.message)) {
      const singletonPid = chromiumSingletonPid();
      if (singletonPid && isPidAlive(singletonPid)) {
        throw browserAlreadyRunningError(singletonPid);
      }
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
  looksSignedOut,
  applyLiAtCookie,
  loginToLinkedIn,
  ensureLoggedIn,
  navigateLinkedIn,
  waitForProfileContent,
  isPidAlive,
  classifyBrowserLock,
  acquireBrowserLock,
  chromiumSingletonPid,
  clearStaleChromiumSingleton,
  browserLaunchOptions,
  launchLinkedInBrowser,
};
