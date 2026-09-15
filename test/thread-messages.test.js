const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  filterMessages,
  parseMessagesJson,
  serializeMessages,
  threadUrl,
} = require('../lib/thread-messages');
const {
  getSourceContactMessages,
  listSourceContacts,
  setSourceContactMessages,
} = require('../lib/source-protection');

assert.deepStrictEqual(parseMessagesJson(''), []);
assert.deepStrictEqual(parseMessagesJson('not-json'), []);
assert.strictEqual(
  serializeMessages([{ direction: 'in', text: 'hello', at: 'Mon', sender: 'Ada' }]),
  '[{"direction":"in","text":"hello","at":"Mon","sender":"Ada"}]'
);
assert.strictEqual(
  filterMessages(
    [
      { direction: 'in', text: 'hi' },
      { direction: 'out', text: 'hello' },
    ],
    'in'
  ).length,
  1
);
assert.strictEqual(threadUrl('abc'), 'https://www.linkedin.com/messaging/thread/abc/');
assert.strictEqual(threadUrl(''), '');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-messages-'));
const file = path.join(dir, 'unrequited-love.csv');
fs.writeFileSync(
  file,
  [
    'name,title,profile_url,vanity_name,snippet,thread_id,inbound_count,outbound_count,messages',
    'Ada,Engineer,https://www.linkedin.com/in/ada/,ada,Thanks for connecting,2-abc,2,1,',
    '',
  ].join('\n'),
  'utf8'
);

const listed = listSourceContacts(file, { pageSize: 10 });
assert.strictEqual(listed.inbox, true);
assert.strictEqual(listed.contacts[0].inbound, 2);
assert.strictEqual(listed.contacts[0].outbound, 1);
assert.strictEqual(listed.contacts[0].hasMessages, false);
assert.strictEqual(listed.contacts[0].snippet, 'Thanks for connecting');

const empty = getSourceContactMessages(file, 'ada', 'in');
assert.strictEqual(empty.cached, false);
assert.strictEqual(empty.messages.length, 0);
assert.strictEqual(empty.threadId, '2-abc');

const saved = setSourceContactMessages(file, 'ada', [
  { direction: 'in', text: 'Can we chat?', at: 'Mon', sender: 'Ada' },
  { direction: 'in', text: 'Following up', at: 'Tue', sender: 'Ada' },
  { direction: 'out', text: 'Sure', at: 'Tue', sender: 'Me' },
]);
assert.strictEqual(saved.inbound, 2);
assert.strictEqual(saved.outbound, 1);
assert.strictEqual(getSourceContactMessages(file, 'ada', 'in').messages.length, 2);
assert.strictEqual(getSourceContactMessages(file, 'ada', 'out').messages[0].text, 'Sure');
assert.strictEqual(listSourceContacts(file).contacts[0].hasMessages, true);

console.log('thread-messages tests passed');
