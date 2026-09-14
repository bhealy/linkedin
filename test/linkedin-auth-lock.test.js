const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  classifyBrowserLock,
  acquireBrowserLock,
  clearStaleChromiumSingleton,
} = require('../lib/linkedin-auth');

assert.deepStrictEqual(
  classifyBrowserLock({ pid: 1234 }, (pid) => pid === 1234),
  { state: 'held', pid: 1234 }
);
assert.deepStrictEqual(
  classifyBrowserLock({ pid: 1234 }, () => false),
  { state: 'stale', pid: 1234 }
);
assert.deepStrictEqual(
  classifyBrowserLock({ pid: 'invalid' }, () => true),
  { state: 'stale', pid: null }
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linkedin-browser-lock-'));
const lockPath = path.join(tmp, 'browser.lock');

fs.writeFileSync(lockPath, '{"pid":111}\n', 'utf8');
const release = acquireBrowserLock({
  lockPath,
  pid: 222,
  checkPid: () => false,
});
assert.strictEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, 222);

assert.throws(
  () =>
    acquireBrowserLock({
      lockPath,
      pid: 333,
      checkPid: (pid) => pid === 222,
    }),
  /already running \(pid 222\)/
);

release();
assert.strictEqual(fs.existsSync(lockPath), false);
fs.rmSync(tmp, { recursive: true, force: true });

const singletonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkedin-singleton-'));
const singletonLock = path.join(singletonDir, 'SingletonLock');
const singletonSocket = path.join(singletonDir, 'SingletonSocket');
fs.symlinkSync('host-99999', singletonLock);
fs.writeFileSync(singletonSocket, 'stale', 'utf8');

assert.throws(
  () => clearStaleChromiumSingleton(singletonDir, (pid) => pid === 99999),
  /already running \(pid 99999\)/
);
assert.strictEqual(fs.lstatSync(singletonLock).isSymbolicLink(), true);

const cleared = clearStaleChromiumSingleton(singletonDir, () => false);
assert.strictEqual(cleared.state, 'stale');
assert.strictEqual(cleared.pid, 99999);
assert.strictEqual(fs.existsSync(singletonLock), false);
assert.strictEqual(fs.existsSync(singletonSocket), false);

const absent = clearStaleChromiumSingleton(singletonDir, () => true);
assert.strictEqual(absent.state, 'absent');
fs.rmSync(singletonDir, { recursive: true, force: true });

console.log('linkedin auth lock tests passed');
