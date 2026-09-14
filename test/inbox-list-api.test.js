const assert = require('assert');
const {
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

const parsedUrl = parseMessagingListUrl(
  'https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.abc&variables=(query:(predicateUnions:List((conversationCategoryPredicate:(category:PRIMARY_INBOX)))),count:20,mailboxUrn:urn%3Ali%3Afsd_profile%3AACoAAATest,nextCursor:REVTQw==)'
);
assert.ok(parsedUrl.queryId.startsWith('messengerConversations'));
assert.ok(parsedUrl.mailboxUrn.includes('fsd_profile'));
assert.ok(parsedUrl.nextCursor);

const { conversations, nextCursor } = parseConversationElements({
  data: {
    messengerConversationsByCategoryQuery: {
      metadata: { nextCursor: 'NEXT' },
      elements: [
        {
          conversationUrl: 'https://www.linkedin.com/messaging/thread/2-abcxyz/',
          lastActivityAt: 1673568000000,
          conversationParticipants: [
            {
              participantType: {
                member: {
                  firstName: { text: 'Ada' },
                  lastName: { text: 'Lovelace' },
                },
              },
            },
          ],
          messages: {
            elements: [{ body: { text: 'Hello there from Ada' } }],
          },
        },
      ],
    },
  },
});
assert.strictEqual(nextCursor, 'NEXT');
assert.strictEqual(conversations.length, 1);
assert.strictEqual(conversations[0].name, 'Ada Lovelace');
assert.strictEqual(conversations[0].threadId, '2-abcxyz');
assert.ok(conversations[0].snippet.includes('Hello there'));
assert.ok(conversations[0].lastActivityMs === 1673568000000);

const fromCsv = cursorFromOldestCached(
  [
    { threadId: '2-newer', lastActivity: 'Jan 12, 2023' },
    { threadId: '2-older', lastActivity: 'Mar 1, 2022' },
  ],
  (value) => {
    if (value === 'Mar 1, 2022') return new Date(2022, 2, 1);
    if (value === 'Jan 12, 2023') return new Date(2023, 0, 12);
    return null;
  }
);
assert.ok(decodeListCursor(fromCsv).threadId === '2-older');

console.log('inbox-list-api tests passed');
