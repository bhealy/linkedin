const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const PROFILE_URL = 'https://www.linkedin.com/in/your-profile/';
const OUT_DIR = path.join(__dirname, 'output');

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: process.env.HEADLESS === 'true' ? 'new' : false,
    userDataDir: path.join(__dirname, '..', '.linkedin-session'),
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 900 },
  });

  const page = await browser.newPage();
  const apiCalls = [];

  page.on('response', async (response) => {
    const url = response.url();
    if (!url.includes('linkedin.com')) {
      return;
    }
    if (!/(voyager|graphql|flagship-web|rsc-action)/.test(url)) {
      return;
    }

    try {
      const contentType = response.headers()['content-type'] || '';
      if (!/json|octet-stream|text\/plain/.test(contentType)) {
        return;
      }
      const text = await response.text();
      if (text.length < 80) {
        return;
      }
      apiCalls.push({
        url,
        status: response.status(),
        contentType,
        length: text.length,
        body: text,
      });
    } catch (err) {
      // response body may be unavailable
    }
  });

  await page.goto(PROFILE_URL, { waitUntil: 'networkidle2', timeout: 90000 });
  await sleep(3000);

  await autoScroll(page);
  await sleep(3000);

  const snapshot = await page.evaluate(collectDomSnapshot);
  fs.writeFileSync(path.join(OUT_DIR, 'dom-snapshot.json'), JSON.stringify(snapshot, null, 2));

  const saved = apiCalls.map((call, index) => {
    const safeName = `${String(index).padStart(3, '0')}-${call.url
      .replace(/https:\/\/www\.linkedin\.com/, '')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .slice(0, 80)}.json`;
    fs.writeFileSync(path.join(OUT_DIR, safeName), call.body);
    return {
      file: safeName,
      url: call.url,
      status: call.status,
      contentType: call.contentType,
      length: call.length,
    };
  });

  fs.writeFileSync(path.join(OUT_DIR, 'api-index.json'), JSON.stringify(saved, null, 2));
  console.log(JSON.stringify({ snapshot, apiCount: saved.length }, null, 2));

  await browser.close();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    for (let i = 0; i < 12; i += 1) {
      window.scrollBy(0, window.innerHeight * 0.85);
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    window.scrollTo(0, 0);
  });
}

function collectDomSnapshot() {
  const text = (selector) => document.querySelector(selector)?.innerText?.trim() || null;
  const sectionText = (id) => document.getElementById(id)?.innerText?.trim() || null;

  return {
    title: document.title,
    url: location.href,
    loggedIn: document.cookie.includes('li_at='),
    h1: text('h1'),
    headline: text('.text-body-medium'),
    location: text('.text-body-small.inline.t-black--light.break-words'),
    about: sectionText('about'),
    topSkills: sectionText('skills'),
    experience: sectionText('experience'),
    education: sectionText('education'),
    licenses: sectionText('licenses_and_certifications'),
    projects: sectionText('projects'),
    languages: sectionText('languages'),
    ldJson: [...document.querySelectorAll('script[type="application/ld+json"]')].map(
      (node) => node.textContent
    ),
    meta: [...document.querySelectorAll('meta[name], meta[property]')]
      .map((node) => ({
        key: node.getAttribute('name') || node.getAttribute('property'),
        content: node.getAttribute('content'),
      }))
      .filter((row) => row.key && row.content),
  };
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
