const {
  DEFAULT_PROTECTED_TITLE_KEYWORDS,
  titleMatchesProtectedKeywords,
} = require('./keyword-filter');
const { parseThreadDate } = require('./inbox-thread-date');

const TITLE_BUCKETS = [
  { label: 'Leadership', pattern: /\b(founder|co-?founder|chief|ceo|cto|cfo|coo|president|director|head of|owner)\b/i },
  { label: 'Engineering', pattern: /\b(engineer|developer|software|data|devops|architect|technical|technology)\b/i },
  { label: 'Sales & growth', pattern: /\b(sales|business development|account executive|growth|partnership|commercial)\b/i },
  { label: 'Recruiting & people', pattern: /\b(recruit|talent|people|human resources|\bhr\b)\b/i },
  { label: 'Product & design', pattern: /\b(product|design|ux|ui|creative)\b/i },
  { label: 'Operations', pattern: /\b(operations|logistics|supply chain|project manager|program manager)\b/i },
  { label: 'Finance & investing', pattern: /\b(finance|financial|invest|venture|capital|accounting)\b/i },
];

function isTruthy(value) {
  return value === true || ['yes', 'true', '1', 'disconnected'].includes(
    String(value || '').trim().toLowerCase()
  );
}

function activityMs(row) {
  const numeric = Number(row && row.lastActivityMs);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }
  // Labels such as "Feb 20" carry no year, and Date.parse resolves those to
  // 2001. parseThreadDate picks the most recent matching day instead.
  const parsed = parseThreadDate(row && row.lastActivity);
  return parsed ? parsed.getTime() : null;
}

function enrichConversation(row) {
  const ms = activityMs(row);
  const disconnected = isTruthy(row.disconnected) || Boolean(row.disconnectedOn);
  const status = String(row.status || 'listed').toLowerCase();
  const protectedTitle = titleMatchesProtectedKeywords(
    row.title,
    DEFAULT_PROTECTED_TITLE_KEYWORDS
  );
  return {
    ...row,
    status,
    lastActivityMs: ms,
    lastActivityIso: ms ? new Date(ms).toISOString() : '',
    disconnected,
    unrequited: status === 'candidate' && !disconnected,
    examined: Boolean(row.examinedActivity || row.scannedAt) && status !== 'listed',
    profileLinked: Boolean(row.profileUrl || row.vanityName),
    protectedTitle,
  };
}

function normalizeBooleanFilter(value) {
  if (value === true || String(value).toLowerCase() === 'true') return true;
  if (value === false || String(value).toLowerCase() === 'false') return false;
  return null;
}

function filterConversations(rows, filters = {}) {
  const query = String(filters.q || '').trim().toLowerCase();
  const statuses = String(filters.status || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const fromMs = filters.from ? Date.parse(`${filters.from}T00:00:00.000Z`) : null;
  const toMs = filters.to ? Date.parse(`${filters.to}T23:59:59.999Z`) : null;
  const booleans = {
    unrequited: normalizeBooleanFilter(filters.unrequited),
    disconnected: normalizeBooleanFilter(filters.disconnected),
    protectedTitle: normalizeBooleanFilter(filters.protected),
    examined: normalizeBooleanFilter(filters.examined),
    profileLinked: normalizeBooleanFilter(filters.connected),
  };

  return rows
    .map(enrichConversation)
    .filter((row) => {
      if (query) {
        const haystack = [row.name, row.title, row.snippet, row.status, row.vanityName]
          .join('\n')
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      if (statuses.length && !statuses.includes(row.status)) return false;
      if (Number.isFinite(fromMs) && (!row.lastActivityMs || row.lastActivityMs < fromMs)) return false;
      if (Number.isFinite(toMs) && (!row.lastActivityMs || row.lastActivityMs > toMs)) return false;
      for (const [key, expected] of Object.entries(booleans)) {
        if (expected !== null && row[key] !== expected) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const timeDiff = (b.lastActivityMs || 0) - (a.lastActivityMs || 0);
      return timeDiff || a.name.localeCompare(b.name);
    });
}

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function entries(map, limit = Infinity) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

function computeInboxAnalytics(rows, options = {}) {
  const conversations = rows.map(enrichConversation);
  const byMonth = new Map();
  const byYear = new Map();
  const statuses = new Map();
  const titles = new Map();
  let dated = 0;

  for (const row of conversations) {
    increment(statuses, row.status || 'unknown');
    if (row.lastActivityMs) {
      dated += 1;
      const date = new Date(row.lastActivityMs);
      increment(byMonth, date.toISOString().slice(0, 7));
      increment(byYear, String(date.getUTCFullYear()));
    }
    const titleBucket = TITLE_BUCKETS.find((bucket) => bucket.pattern.test(row.title || ''));
    increment(titles, titleBucket ? titleBucket.label : row.title ? 'Other titles' : 'No title');
  }

  const sortedDates = conversations
    .filter((row) => row.lastActivityMs)
    .sort((a, b) => a.lastActivityMs - b.lastActivityMs);
  const examined = conversations.filter((row) => row.examined).length;
  const profileLinked = conversations.filter((row) => row.profileLinked).length;

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      total: conversations.length,
      unrequited: conversations.filter((row) => row.unrequited).length,
      replied: conversations.filter((row) => row.status === 'replied').length,
      disconnected: conversations.filter((row) => row.disconnected).length,
      protectedTitles: conversations.filter((row) => row.protectedTitle).length,
      examined,
      listedOnly: conversations.length - examined,
      profileLinked,
      profileUnlinked: conversations.length - profileLinked,
      dated,
      undated: conversations.length - dated,
      oldestActivity: sortedDates[0]?.lastActivityIso || null,
      newestActivity: sortedDates[sortedDates.length - 1]?.lastActivityIso || null,
      cacheComplete: Boolean(options.cacheComplete),
    },
    charts: {
      activityByMonth: entries(byMonth).sort((a, b) => a.label.localeCompare(b.label)),
      activityByYear: entries(byYear).sort((a, b) => a.label.localeCompare(b.label)),
      statuses: entries(statuses),
      titleBuckets: entries(titles),
      scanCoverage: [
        { label: 'Examined', count: examined },
        { label: 'Listed only', count: conversations.length - examined },
      ],
      connectionCoverage: [
        { label: 'Profile linked', count: profileLinked },
        { label: 'No linked profile', count: conversations.length - profileLinked },
      ],
    },
    capabilities: {
      groupConversationFlag: false,
    },
  };
}

function paginateConversations(rows, filters = {}) {
  const page = Math.max(1, Math.floor(Number(filters.page) || 1));
  const limit = Math.min(100, Math.max(1, Math.floor(Number(filters.limit) || 50)));
  const filtered = filterConversations(rows, filters);
  const pageCount = Math.max(1, Math.ceil(filtered.length / limit));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * limit;
  return {
    rows: filtered.slice(start, start + limit),
    pagination: {
      page: safePage,
      limit,
      total: filtered.length,
      pageCount,
    },
  };
}

module.exports = {
  activityMs,
  enrichConversation,
  filterConversations,
  computeInboxAnalytics,
  paginateConversations,
};
