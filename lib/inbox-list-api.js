const VOYAGER_GRAPHQL = 'https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql';
const LIST_QUERY_MARKER = 'messengerConversations';
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

function parseConversationElements(payload) {
  const collection =
    payload?.data?.messengerConversationsByCategoryQuery ||
    payload?.data?.messengerConversations ||
    payload;
  const elements = Array.isArray(collection?.elements) ? collection.elements : [];
  const nextCursor = collection?.metadata?.nextCursor || '';
  const conversations = elements.map((element) => {
    const participants = Array.isArray(element.conversationParticipants)
      ? element.conversationParticipants
      : [];
    const uniqueNames = [
      ...new Set(
        participants
          .map((participant) => participantName(participant))
          .filter((name) => name && !/^you$/i.test(name))
      ),
    ];
    const lastActivityMs = conversationLastActivityMs(element);
    const threadId = conversationThreadId(element);
    const name = uniqueNames.join(', ');
    const activityText = lastActivityMs ? formatActivityLabel(lastActivityMs) : '';
    const snippet = conversationSnippet(element);
    return {
      key: `${name}|${activityText}|${snippet}`,
      name,
      activityText,
      snippet,
      threadId,
      lastActivityMs,
    };
  });
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

function cursorFromOldestCached(rows, parseActivity) {
  let oldest = null;
  for (const row of rows || []) {
    if (!row.threadId || !row.lastActivity) {
      continue;
    }
    const parsed = parseActivity ? parseActivity(row.lastActivity) : null;
    const ms = parsed ? parsed.getTime() : 0;
    if (!ms) {
      continue;
    }
    if (!oldest || ms < oldest.ms) {
      oldest = { ms, threadId: row.threadId };
    }
  }
  return oldest ? encodeListCursor(oldest.ms, oldest.threadId) : '';
}

async function discoverMessagingListApi(page) {
  const fromPerformance = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => name.includes('messengerConversations'))
  );
  for (const url of fromPerformance) {
    const parsed = parseMessagingListUrl(url);
    if (parsed && parsed.queryId && parsed.mailboxUrn) {
      return parsed;
    }
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      page.off('request', onRequest);
      reject(new Error('LinkedIn did not request the messaging conversation list.'));
    }, 25000);

    function onRequest(request) {
      const parsed = parseMessagingListUrl(request.url());
      if (!parsed || !parsed.queryId || !parsed.mailboxUrn) {
        return;
      }
      clearTimeout(timeout);
      page.off('request', onRequest);
      resolve(parsed);
    }

    page.on('request', onRequest);
    page.evaluate(() => {
      const items = document.querySelectorAll('li.msg-conversation-listitem');
      items[items.length - 1]?.scrollIntoView({ block: 'end' });
    }).catch((err) => {
      console.error(err.stack || err.message);
    });
  });
}

async function fetchConversationPage(page, { queryId, mailboxUrn, nextCursor, count = DEFAULT_PAGE_SIZE }) {
  return page.evaluate(
    async ({ graphqlUrl, queryId, mailboxUrn, nextCursor, count }) => {
      const jsessionCookie = document.cookie
        .split(';')
        .map((value) => value.trim())
        .find((value) => value.startsWith('JSESSIONID='));
      const csrfToken = jsessionCookie
        ? jsessionCookie.substring('JSESSIONID='.length).replace(/^"|"$/g, '')
        : '';

      const parts = [
        'query:(predicateUnions:List((conversationCategoryPredicate:(category:PRIMARY_INBOX))))',
        `count:${count}`,
        `mailboxUrn:${mailboxUrn}`,
      ];
      if (nextCursor) {
        parts.push(`nextCursor:${nextCursor}`);
      }
      const url = `${graphqlUrl}?queryId=${encodeURIComponent(queryId)}&variables=${encodeURIComponent(
        `(${parts.join(',')})`
      )}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/vnd.linkedin.normalized+json+2.1',
          'csrf-token': csrfToken,
          'x-restli-protocol-version': '2.0.0',
        },
        credentials: 'include',
      });
      const text = await response.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch (err) {
        body = { parseError: err.message, rawText: text.slice(0, 4000) };
      }
      return { ok: response.ok, status: response.status, body };
    },
    {
      graphqlUrl: VOYAGER_GRAPHQL,
      queryId,
      mailboxUrn,
      nextCursor: nextCursor || '',
      count,
    }
  );
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  encodeListCursor,
  decodeListCursor,
  parseMessagingListUrl,
  parseConversationElements,
  formatActivityLabel,
  cursorFromOldestCached,
  discoverMessagingListApi,
  fetchConversationPage,
};
