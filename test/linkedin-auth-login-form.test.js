const assert = require('assert');
const { forgetRememberedMember } = require('../lib/linkedin-auth');

function fakePage(cookies) {
  const jar = [...cookies];
  const deleted = [];
  return {
    jar,
    deleted,
    browser: () => ({
      cookies: async () => jar,
      deleteCookie: async (...removed) => {
        deleted.push(...removed);
      },
    }),
  };
}

async function run() {
  let page = fakePage([
    { name: 'bcookie', domain: '.linkedin.com' },
    { name: 'lidc', domain: '.linkedin.com' },
  ]);
  assert.strictEqual(await forgetRememberedMember(page), false);
  assert.strictEqual(page.deleted.length, 0);

  page = fakePage([
    { name: 'bcookie', domain: '.linkedin.com' },
    { name: 'li_rm', domain: '.www.linkedin.com' },
    { name: 'bscookie', domain: '.www.linkedin.com' },
  ]);
  assert.strictEqual(await forgetRememberedMember(page), true);
  assert.deepStrictEqual(page.deleted, [
    { name: 'li_rm', domain: '.www.linkedin.com' },
  ]);

  console.log('linkedin-auth login form tests passed');
}

run().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
