const assert = require('assert');
const {
  buildListUrl,
  cursorFromOldestCached,
  decodeListCursor,
  encodeListCursor,
  parseConversationElements,
  parseMessagingListUrl,
} = require('../lib/inbox-list-api');

const cursor = encodeListCursor(1673568000000, '2-abc');
const decoded = decodeListCursor(cursor);
assert.strictEqual(decoded.lastActivityMs, 1673568000000);
assert.strictEqual(decoded.threadId, '2-abc');

// Rest.li punctuation stays literal; only the urn and cursor values are encoded.
const builtUrl = buildListUrl({
  queryId: 'messengerConversations.9501074288a12f3ae9e3c7ea243bccbf',
  mailboxUrn: 'urn:li:fsd_profile:ACoAAATest',
  nextCursor: 'REVTQ0VORElORyYxNjY1Mzkw==',
});
assert.ok(builtUrl.includes('queryId=messengerConversations.9501074288a12f3ae9e3c7ea243bccbf'));
assert.ok(builtUrl.includes('variables=(query:(predicateUnions:List((conversationCategoryPredicate:(category:PRIMARY_INBOX)))),count:20,'));
assert.ok(builtUrl.includes('mailboxUrn:urn%3Ali%3Afsd_profile%3AACoAAATest'));
assert.ok(builtUrl.includes('nextCursor:REVTQ0VORElORyYxNjY1Mzkw%3D%3D)'));
assert.ok(!builtUrl.includes('%28'));

const firstPageUrl = buildListUrl({
  queryId: 'messengerConversations.abc',
  mailboxUrn: 'urn:li:fsd_profile:ACoAAATest',
});
assert.ok(!firstPageUrl.includes('nextCursor'));

const roundTrip = parseMessagingListUrl(builtUrl);
assert.strictEqual(roundTrip.mailboxUrn, 'urn:li:fsd_profile:ACoAAATest');
assert.strictEqual(roundTrip.nextCursor, 'REVTQ0VORElORyYxNjY1Mzkw==');

const parsedUrl = parseMessagingListUrl(
  'https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.abc&variables=(query:(predicateUnions:List((conversationCategoryPredicate:(category:PRIMARY_INBOX)))),count:20,mailboxUrn:urn%3Ali%3Afsd_profile%3AACoAAATest,nextCursor:REVTQw==)'
);
assert.ok(parsedUrl.queryId.startsWith('messengerConversations'));
assert.ok(parsedUrl.mailboxUrn.includes('fsd_profile'));
assert.ok(parsedUrl.nextCursor);

// LinkedIn answers with a normalized payload: the collection holds urns and
// the conversations, participants and messages sit in `included`.
const SELF = 'urn:li:fsd_profile:ACoAAASelf';
const CONVERSATION_URN = `urn:li:msg_conversation:(${SELF},2-abcxyz==)`;
const MESSAGE_URN = `urn:li:msg_message:(${SELF},2-msg==)`;
const { conversations, nextCursor } = parseConversationElements({
  data: {
    data: {
      messengerConversationsByCategoryQuery: {
        metadata: { nextCursor: 'NEXT' },
        '*elements': [CONVERSATION_URN],
      },
    },
  },
  included: [
    {
      $type: 'com.linkedin.messenger.Conversation',
      entityUrn: CONVERSATION_URN,
      lastActivityAt: 1673568000000,
      groupChat: false,
      '*conversationParticipants': [
        `urn:li:msg_messagingParticipant:${SELF}`,
        'urn:li:msg_messagingParticipant:urn:li:fsd_profile:ACoAAAAda',
      ],
      messages: { '*elements': [MESSAGE_URN] },
    },
    {
      $type: 'com.linkedin.messenger.MessagingParticipant',
      entityUrn: `urn:li:msg_messagingParticipant:${SELF}`,
      participantType: {
        member: { firstName: { text: 'Bobby' }, lastName: { text: 'Healy' } },
      },
    },
    {
      $type: 'com.linkedin.messenger.MessagingParticipant',
      entityUrn: 'urn:li:msg_messagingParticipant:urn:li:fsd_profile:ACoAAAAda',
      participantType: {
        member: { firstName: { text: 'Ada' }, lastName: { text: 'Lovelace' } },
      },
    },
    {
      $type: 'com.linkedin.messenger.Message',
      entityUrn: MESSAGE_URN,
      body: { text: 'Hello there from Ada' },
    },
  ],
});
assert.strictEqual(nextCursor, 'NEXT');
assert.strictEqual(conversations.length, 1);
// The mailbox owner is dropped so the name is just the other participant.
assert.strictEqual(conversations[0].name, 'Ada Lovelace');
assert.strictEqual(conversations[0].threadId, '2-abcxyz==');
assert.ok(conversations[0].snippet.includes('Hello there'));
assert.strictEqual(conversations[0].lastActivityMs, 1673568000000);
assert.strictEqual(conversations[0].groupChat, false);

// The sync-token query shares the queryId prefix but cannot page backwards.
assert.strictEqual(
  parseMessagingListUrl(
    'https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.0d5e&variables=(mailboxUrn:urn%3Ali%3Afsd_profile%3AACoAAATest)'
  ),
  null
);

const fromCsv = cursorFromOldestCached([
  { threadId: '2-newer', lastActivity: 'Jan 12, 2023', lastActivityMs: '1673481600000' },
  { threadId: '2-older', lastActivity: 'Mar 1, 2022', lastActivityMs: '1646092800000' },
]);
const fromCsvDecoded = decodeListCursor(fromCsv);
assert.strictEqual(fromCsvDecoded.threadId, '2-older');
assert.strictEqual(fromCsvDecoded.lastActivityMs, 1646092800000);

// Date labels are too coarse to seed a cursor, so rows without an exact
// timestamp must not produce one.
assert.strictEqual(
  cursorFromOldestCached([{ threadId: '2-older', lastActivity: 'Mar 1, 2022' }]),
  ''
);

console.log('inbox-list-api tests passed');
