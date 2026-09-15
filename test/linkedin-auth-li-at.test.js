const assert = require('assert');
const { looksSignedOut, applyLiAtCookie } = require('../lib/linkedin-auth');

function fakePage() {
  const cookies = [];
  return {
    cookies,
    browser: () => ({
      setCookie: async (...added) => {
        cookies.push(...added);
      },
    }),
  };
}

async function run() {
  const original = process.env.LI_AT;

  assert.strictEqual(looksSignedOut('https://www.linkedin.com/login'), true);
  assert.strictEqual(looksSignedOut('https://www.linkedin.com/authwall'), true);
  assert.strictEqual(
    looksSignedOut('https://www.linkedin.com/checkpoint/challenge/x'),
    true
  );
  assert.strictEqual(looksSignedOut('https://www.linkedin.com/feed/'), false);
  assert.strictEqual(
    looksSignedOut('https://www.linkedin.com/messaging/'),
    false
  );
  assert.strictEqual(looksSignedOut(''), false);
  assert.strictEqual(looksSignedOut(null), false);

  delete process.env.LI_AT;
  let page = fakePage();
  assert.strictEqual(await applyLiAtCookie(page), false);
  assert.strictEqual(page.cookies.length, 0);

  process.env.LI_AT = '   ';
  page = fakePage();
  assert.strictEqual(await applyLiAtCookie(page), false);
  assert.strictEqual(page.cookies.length, 0);

  process.env.LI_AT = '  "example-li-at-value"  ';
  page = fakePage();
  assert.strictEqual(await applyLiAtCookie(page), true);
  assert.strictEqual(page.cookies.length, 1);
  assert.deepStrictEqual(page.cookies[0], {
    name: 'li_at',
    value: 'example-li-at-value',
    domain: '.www.linkedin.com',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'None',
  });

  if (original === undefined) {
    delete process.env.LI_AT;
  } else {
    process.env.LI_AT = original;
  }

  console.log('linkedin-auth li_at tests passed');
}

run().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
