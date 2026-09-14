const VOYAGER_GRAPHQL = 'https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql';
const LIST_QUERY_MARKER = 'messengerConversations';
const LIST_PREDICATE_MARKER = 'conversationCategoryPredicate';
const LIST_COLLECTION_KEY = 'messengerConversationsByCategoryQuery';
const DISCOVERY_TIMEOUT_MS = 45000;
const DISCOVERY_SCROLL_PAUSE_MS = 1500;
const DEFAULT_PAGE_SIZE = 20;

function encodeListCursor(lastActivityMs, threadId) {
  if (!lastActivityMs || !threadId) {
    return '';
  }
  return Buffer.from(`DESCENDING&${lastActivityMs}&${threadId}`).toString('base64');
}

function decodeListCursor(cursor) {
  if (!cursor) {
    return null;
  }
  try {
    const decoded = Buffer.from(String(cursor), 'base64').toString('utf8');
    const [order, stamp, threadId] = decoded.split('&');
    if (order !== 'DESCENDING' || !stamp || !threadId) {
      return null;
    }
    return { order, lastActivityMs: Number(stamp), threadId };
  } catch (err) {
    console.error(err.stack || err.message);
    return null;
  }
}

function parseMessagingListUrl(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.includes('voyagerMessagingGraphQL')) {
      return null;
    }
    const queryId = parsed.searchParams.get('queryId') || '';
    if (!queryId.includes(LIST_QUERY_MARKER)) {
      return null;
    }
    const variables = parsed.searchParams.get('variables') || '';
    // Messaging also loads the list through a sync-token query that shares this
    // queryId prefix but cannot page backwards, so only take the cursor one.
    if (!variables.includes(LIST_PREDICATE_MARKER)) {
      return null;
    }
    const mailbox = variables.match(/mailboxUrn:([^,)]+)/);
    const cursor = variables.match(/nextCursor:([^,)]+)/);
    return {
      queryId,
      mailboxUrn: mailbox ? decodeURIComponent(mailbox[1]) : '',
      nextCursor: cursor ? decodeURIComponent(cursor[1]) : '',
    };
  } catch (err) {
    console.error(err.stack || err.message);
    return null;
  }
}

function parseMailboxUrnFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.includes('voyagerMessagingGraphQL')) {
      return '';
    }
    const variables = parsed.searchParams.get('variables') || '';
    const mailbox = variables.match(/mailboxUrn:([^,)]+)/);
    return mailbox ? decodeURIComponent(mailbox[1]) : '';
  } catch (err) {
    console.error(err.stack || err.message);
    return '';
  }
}

function walk(value, visit) {
  if (!value || typeof value !== 'object') {
    return;
  }
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, visit);
    }
    return;
  }
  for (const child of Object.values(value)) {
    walk(child, visit);
  }
}

function firstString(value, keys) {
  for (const key of keys) {
    if (typeof value[key] === 'string' && value[key].trim()) {
      return value[key].trim();
    }
    if (value[key] && typeof value[key].text === 'string' && value[key].text.trim()) {
      return value[key].text.trim();
    }
  }
  return '';
}

function participantName(participant) {
  let name = '';
  walk(participant, (node) => {
    if (name) {
      return;
    }
    const first = firstString(node, ['firstName', 'first_name']);
    const last = firstString(node, ['lastName', 'last_name']);
    if (first || last) {
      name = `${first} ${last}`.trim();
    }
  });
  if (name) {
    return name;
  }
  return firstString(participant, ['name', 'title', 'displayName']) || '';
}

function conversationSnippet(element) {
  const snippets = [];
  walk(element, (node) => {
    if (node.firstName || node.lastName) {
      return;
    }
    const text =
      firstString(node, ['snippet', 'previewText', 'attributedBody', 'body']) ||
      (typeof node.text === 'string' ? node.text.trim() : '');
    if (text && text.length > 1 && !/^https?:\/\//.test(text) && !/^urn:/.test(text)) {
      snippets.push(text);
    }
  });
  const chosen =
    snippets.find((text) => text.length > 8 && !/^\d+$/.test(text)) || snippets[0] || '';
  return String(chosen).replace(/\s+/g, ' ').trim().slice(0, 80);
}

function conversationLastActivityMs(element) {
  const stamps = [];
  walk(element, (node) => {
    for (const key of ['lastActivityAt', 'lastUpdatedAt', 'latestActivityAt', 'deliveredAt']) {
      const value = node[key];
      if (typeof value === 'number' && value > 1e12) {
        stamps.push(value);
      } else if (typeof value === 'string' && /^\d{13}$/.test(value)) {
        stamps.push(Number(value));
      }
    }
  });
  return stamps.length ? Math.max(...stamps) : 0;
}

function conversationThreadId(element) {
  const url = firstString(element, ['conversationUrl']) || '';
  const fromUrl = url.match(/\/messaging\/thread\/([^/?#]+)/);
  if (fromUrl) {
    return fromUrl[1];
  }
  let threadId = '';
  walk(element, (node) => {
    if (threadId) {
      return;
    }
    const urn = firstString(node, ['entityUrn', 'backendUrn']);
    const match = urn.match(/2-[A-Za-z0-9=]+/);
    if (match) {
      threadId = match[0];
    }
  });
  return threadId;
}

function findCollection(payload) {
  let collection = null;
  walk(payload, (node) => {
    if (!collection && node[LIST_COLLECTION_KEY]) {
      collection = node[LIST_COLLECTION_KEY];
    }
  });
  return collection;
}

// The list comes back normalized: the collection holds conversation urns and
// the conversations, participants and messages all live in `included`.
function indexIncluded(payload) {
  const index = new Map();
  for (const entity of payload?.included || []) {
    if (entity?.entityUrn) {
      index.set(entity.entityUrn, entity);
    }
  }
  return index;
}

function selfProfileUrn(conversationUrn) {
  const match = String(conversationUrn || '').match(/\(([^,]+),/);
  return match ? match[1] : '';
}

function threadIdFromUrn(conversationUrn) {
  const match = String(conversationUrn || '').match(/,(2-[^)]+)\)/);
  return match ? match[1] : '';
}

function messagingParticipantName(participant) {
  const member = participant?.participantType?.member;
  if (member) {
    const first = member.firstName?.text || '';
    const last = member.lastName?.text || '';
    const name = `${first} ${last}`.trim();
    if (name) {
      return name;
    }
  }
  return participantName(participant || {});
}

function latestMessageText(conversation, included) {
  const urns = conversation?.messages?.['*elements'] || [];
  for (const urn of urns) {
    const text = included.get(urn)?.body?.text;
    if (text) {
      return String(text).replace(/\s+/g, ' ').trim().slice(0, 80);
    }
  }
  return '';
}

function parseConversationElements(payload) {
  const collection = findCollection(payload);
  const included = indexIncluded(payload);
  const urns = collection?.['*elements'] || [];
  const nextCursor = collection?.metadata?.nextCursor || '';

  const conversations = [];
  for (const urn of urns) {
    const conversation = included.get(urn);
    if (!conversation) {
      continue;
    }
    const self = selfProfileUrn(urn);
    const names = [];
    for (const participantUrn of conversation['*conversationParticipants'] || []) {
      if (self && participantUrn.includes(self)) {
        continue;
      }
      const name = messagingParticipantName(included.get(participantUrn));
      if (name && !names.includes(name)) {
        names.push(name);
      }
    }
    const lastActivityMs = conversation.lastActivityAt || 0;
    const name = names.join(', ');
    const activityText = lastActivityMs ? formatActivityLabel(lastActivityMs) : '';
    const snippet = latestMessageText(conversation, included);
    conversations.push({
      key: `${name}|${activityText}|${snippet}`,
      name,
      activityText,
      snippet,
      threadId: threadIdFromUrn(urn),
      lastActivityMs,
      groupChat: Boolean(conversation.groupChat),
    });
  }

  return { conversations, nextCursor };
}

function formatActivityLabel(ms, now = new Date()) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  });
}

// A cursor is only valid with the exact activity timestamp LinkedIn sent, so
// rows cached before that timestamp was stored cannot seed a resume.
function cursorFromOldestCached(rows) {
  let oldest = null;
  for (const row of rows || []) {
    if (!row.threadId) {
      continue;
    }
    const ms = Number(row.lastActivityMs);
    if (!ms) {
      continue;
    }
    if (!oldest || ms < oldest.ms) {
      oldest = { ms, threadId: row.threadId };
    }
  }
  return oldest ? encodeListCursor(oldest.ms, oldest.threadId) : '';
}

function isMessagingListSession(parsed) {
  return Boolean(parsed && parsed.queryId && parsed.mailboxUrn);
}

// Attach before navigating to messaging. The list GraphQL request fires during
// page load; waiting until after the list renders misses it (resource timing
// only keeps ~250 entries) and then a 45s scroll wait often times out.
function watchMessagingListApi(page) {
  let settled = false;
  let value = null;
  let resolveFound;
  const found = new Promise((resolve) => {
    resolveFound = resolve;
  });

  function accept(parsed) {
    if (settled || !isMessagingListSession(parsed)) {
      return false;
    }
    settled = true;
    value = parsed;
    page.off('request', onRequest);
    resolveFound(parsed);
    return true;
  }

  function onRequest(request) {
    accept(parseMessagingListUrl(request.url()));
  }

  page.on('request', onRequest);

  return {
    found,
    accept,
    isSettled: () => settled,
    value: () => value,
    stop() {
      page.off('request', onRequest);
    },
  };
}

async function discoverMessagingListApi(page, watch) {
  const ownedWatch = !watch;
  const sessionWatch = watch || watchMessagingListApi(page);

  try {
    const fromPerformance = await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => name.includes('messengerConversations'))
    );
    for (const url of fromPerformance) {
      sessionWatch.accept(parseMessagingListUrl(url));
    }
    if (sessionWatch.isSettled()) {
      return sessionWatch.value();
    }

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        sessionWatch.stop();
        reject(new Error('LinkedIn did not request the messaging conversation list.'));
      }, DISCOVERY_TIMEOUT_MS);

      sessionWatch.found.then((parsed) => {
        clearTimeout(timeout);
        resolve(parsed);
      });

      // Only a scroll towards older threads triggers the cursor query, and the
      // list is virtualised, so keep nudging its scroll container until it fires.
      const nudge = async () => {
        while (!sessionWatch.isSettled()) {
          await page
            .evaluate(() => {
              const list = document.querySelector(
                'ul.msg-conversations-container__conversations-list'
              );
              let node = list;
              while (node && node !== document.body) {
                const style = getComputedStyle(node);
                if (
                  /(auto|scroll)/.test(style.overflowY) &&
                  node.scrollHeight > node.clientHeight + 40
                ) {
                  node.scrollTop = node.scrollHeight;
                  return;
                }
                node = node.parentElement;
              }
              const items = document.querySelectorAll('li.msg-conversation-listitem');
              items[items.length - 1]?.scrollIntoView({ block: 'end' });
            })
            .catch((err) => {
              console.error(err.stack || err.message);
            });
          await new Promise((resolveNudge) =>
            setTimeout(resolveNudge, DISCOVERY_SCROLL_PAUSE_MS)
          );
        }
      };

      nudge();
    });
  } finally {
    if (ownedWatch) {
      sessionWatch.stop();
    }
  }
}

// Rest.li keeps its own punctuation literal in the query string and only
// percent-encodes the values, so the whole string must not be encoded.
function buildListUrl({ queryId, mailboxUrn, nextCursor, count = DEFAULT_PAGE_SIZE }) {
  const parts = [
    'query:(predicateUnions:List((conversationCategoryPredicate:(category:PRIMARY_INBOX))))',
    `count:${count}`,
    `mailboxUrn:${encodeURIComponent(mailboxUrn)}`,
  ];
  if (nextCursor) {
    parts.push(`nextCursor:${encodeURIComponent(nextCursor)}`);
  }
  return `${VOYAGER_GRAPHQL}?queryId=${queryId}&variables=(${parts.join(',')})`;
}

async function fetchConversationPage(page, options) {
  const url = buildListUrl(options);
  const cookies = await page.cookies('https://www.linkedin.com');
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  const jsession = cookies.find((cookie) => cookie.name === 'JSESSIONID');
  const csrfToken = (jsession?.value || '').replace(/^"|"$/g, '');
  const userAgent = await page.browser().userAgent();

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/vnd.linkedin.normalized+json+2.1',
      'csrf-token': csrfToken,
      'x-restli-protocol-version': '2.0.0',
      cookie: cookieHeader,
      'user-agent': userAgent,
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch (err) {
    console.error(err.stack || err.message);
    body = { parseError: err.message, rawText: text.slice(0, 4000) };
  }
  return { ok: response.ok, status: response.status, body };
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  buildListUrl,
  encodeListCursor,
  decodeListCursor,
  parseMessagingListUrl,
  parseMailboxUrnFromUrl,
  parseConversationElements,
  formatActivityLabel,
  cursorFromOldestCached,
  watchMessagingListApi,
  discoverMessagingListApi,
  fetchConversationPage,
};
