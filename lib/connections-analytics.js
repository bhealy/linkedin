const { parseConnectedDate } = require('./connected-date');
const { isDisconnected } = require('./connections-csv');

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'at', 'in', 'of', 'for', 'to', 'with', 'on', 'by',
  'is', 'are', 'as', 'be', 'from', 'your', 'our', 'their', 'my', 'i', 'we', 'you',
  'all', 'more', 'new', 'via', 'amp', 'lt', 'gt',
]);

const ROLE_RULES = [
  { id: 'engineering', label: 'Engineering', patterns: [/\bengineer/i, /\bdeveloper/i, /\bsoftware\b/i, /\barchitect\b/i, /\bdevops\b/i, /\bsre\b/i, /\bfirmware\b/i, /\belectronics\b/i, /\bdata scientist\b/i] },
  { id: 'executive', label: 'Executive', patterns: [/\bceo\b/i, /\bcto\b/i, /\bcfo\b/i, /\bcoo\b/i, /\bchief\b/i, /\bpresident\b/i, /\bfounder\b/i, /\bco-founder\b/i, /\bmanaging director\b/i] },
  { id: 'sales', label: 'Sales & BD', patterns: [/\bsales\b/i, /\bbusiness development\b/i, /\baccount executive\b/i, /\baccount manager\b/i, /\bbdr\b/i, /\bsdr\b/i, /\bpartnerships\b/i] },
  { id: 'marketing', label: 'Marketing', patterns: [/\bmarketing\b/i, /\bbrand\b/i, /\bcontent\b/i, /\bgrowth\b/i, /\bcommunications\b/i, /\bcmo\b/i] },
  { id: 'finance', label: 'Finance', patterns: [/\bfinance\b/i, /\bfinancial\b/i, /\binvest/i, /\baccounting\b/i, /\btreasury\b/i, /\banalyst\b/i, /\bprivate equity\b/i] },
  { id: 'product', label: 'Product', patterns: [/\bproduct manager\b/i, /\bproduct lead\b/i, /\bproduct owner\b/i, /\bproduct director\b/i, /\bcpo\b/i] },
  { id: 'design', label: 'Design', patterns: [/\bdesigner\b/i, /\bux\b/i, /\bui\b/i, /\bcreative\b/i] },
  { id: 'operations', label: 'Operations', patterns: [/\boperations\b/i, /\bsupply chain\b/i, /\blogistics\b/i, /\bprogram manager\b/i, /\bproject manager\b/i] },
  { id: 'hr', label: 'HR & People', patterns: [/\bhr\b/i, /\bhuman resources\b/i, /\brecruit/i, /\btalent\b/i, /\bpeople ops\b/i] },
  { id: 'legal', label: 'Legal & Compliance', patterns: [/\blawyer\b/i, /\blegal\b/i, /\bcompliance\b/i, /\bcounsel\b/i] },
  { id: 'student', label: 'Student', patterns: [/\bstudent\b/i, /\bgraduate\b/i, /\buniversity\b/i, /\bcollege\b/i, /\bphd\b/i, /\bmba candidate\b/i] },
  { id: 'consulting', label: 'Consulting', patterns: [/\bconsultant\b/i, /\badvisory\b/i, /\bconsulting\b/i] },
];

const SENIORITY_RULES = [
  { id: 'c_level', label: 'C-Level / Founder', patterns: [/\bceo\b/i, /\bcto\b/i, /\bcfo\b/i, /\bcoo\b/i, /\bchief\b/i, /\bfounder\b/i, /\bco-founder\b/i] },
  { id: 'vp', label: 'VP / SVP', patterns: [/\bvp\b/i, /\bvice president\b/i, /\bsvp\b/i, /\bevp\b/i] },
  { id: 'director', label: 'Director', patterns: [/\bdirector\b/i, /\bhead of\b/i] },
  { id: 'manager', label: 'Manager', patterns: [/\bmanager\b/i, /\blead\b/i, /\bprincipal\b/i] },
  { id: 'senior', label: 'Senior IC', patterns: [/\bsenior\b/i, /\bsr\.?\b/i, /\bstaff\b/i] },
  { id: 'associate', label: 'Associate / Entry', patterns: [/\bassociate\b/i, /\bjunior\b/i, /\bintern\b/i, /\bgraduate\b/i] },
  { id: 'student', label: 'Student', patterns: [/\bstudent\b/i] },
];

function monthKey(date) {
  if (!date) {
    return null;
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function monthLabel(key) {
  const [year, month] = key.split('-');
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function classifyFirst(title, rules, fallbackId, fallbackLabel) {
  const text = title || '';
  for (const rule of rules) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      return { id: rule.id, label: rule.label };
    }
  }
  return { id: fallbackId, label: fallbackLabel };
}

function extractCompanies(title) {
  if (!title) {
    return [];
  }

  const companies = new Set();
  for (const match of title.matchAll(/@\s*([^|,@]+)/gi)) {
    const name = match[1].trim().replace(/\s+/g, ' ');
    if (name.length >= 2 && name.length <= 80) {
      companies.add(name);
    }
  }

  const atMatch = title.match(/\bat\s+([^|,@]+?)(?:\s*[|,]|$)/i);
  if (atMatch) {
    const name = atMatch[1].trim().replace(/\s+/g, ' ');
    if (name.length >= 2 && name.length <= 80) {
      companies.add(name);
    }
  }

  const pipeParts = title.split('|').map((part) => part.trim()).filter(Boolean);
  if (pipeParts.length > 1) {
    const last = pipeParts[pipeParts.length - 1];
    if (last.length >= 2 && last.length <= 80 && !/\bstudent\b/i.test(last)) {
      companies.add(last);
    }
  }

  return [...companies];
}

function tokenizeTitle(title) {
  return (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s+#]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount);
}

function topEntries(map, limit = 15) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

function sortedTimeline(map) {
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, count]) => ({ key, label: monthLabel(key), count }));
}

function connectedOnMs(row) {
  const date = parseConnectedDate(row && row.connectedOn);
  return date ? date.getTime() : null;
}

function filterConnectionsByConnectedOn(rows, filters = {}) {
  const fromMs = filters.from ? Date.parse(`${filters.from}T00:00:00`) : NaN;
  const toMs = filters.to ? Date.parse(`${filters.to}T23:59:59.999`) : NaN;
  const hasFrom = Number.isFinite(fromMs);
  const hasTo = Number.isFinite(toMs);
  if (!hasFrom && !hasTo) {
    return rows;
  }
  return (rows || []).filter((row) => {
    const ms = connectedOnMs(row);
    if (ms == null) {
      return false;
    }
    if (hasFrom && ms < fromMs) {
      return false;
    }
    if (hasTo && ms > toMs) {
      return false;
    }
    return true;
  });
}

function computeConnectionsAnalytics(connections) {
  const byMonth = new Map();
  const byYear = new Map();
  const byWeekday = new Map(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => [d, 0]));
  const roles = new Map();
  const seniority = new Map();
  const companies = new Map();
  const keywords = new Map();
  const titleLengths = [];

  let dated = 0;
  let withTitle = 0;
  let withCompany = 0;
  let multiRole = 0;

  const enriched = connections.map((row) => {
    const title = row.title || '';
    const connectedDate = parseConnectedDate(row.connectedOn);
    const role = classifyFirst(title, ROLE_RULES, 'other', 'Other');
    const level = classifyFirst(title, SENIORITY_RULES, 'unspecified', 'Unspecified');
    const companyList = extractCompanies(title);

    const stillConnected = !isDisconnected(row);

    if (stillConnected && title.trim()) {
      withTitle += 1;
    }
    if (stillConnected && connectedDate) {
      dated += 1;
      increment(byMonth, monthKey(connectedDate));
      increment(byYear, String(connectedDate.getFullYear()));
      const weekday = connectedDate.toLocaleDateString('en-US', { weekday: 'short' });
      increment(byWeekday, weekday);
    }
    if (stillConnected && companyList.length > 0) {
      withCompany += 1;
    }

    if (stillConnected) {
      increment(roles, role.label);
      increment(seniority, level.label);
      for (const company of companyList) {
        increment(companies, company);
      }
      for (const word of tokenizeTitle(title)) {
        increment(keywords, word);
      }

      const matchedRoles = ROLE_RULES.filter((rule) =>
        rule.patterns.some((pattern) => pattern.test(title))
      );
      if (matchedRoles.length > 1) {
        multiRole += 1;
      }

      if (title.length > 0) {
        titleLengths.push(title.length);
      }
    }

    return {
      ...row,
      disconnected: isDisconnected(row),
      disconnectedOn: row.disconnectedOn || '',
      connectedDate: connectedDate ? connectedDate.toISOString().slice(0, 10) : null,
      role: role.label,
      seniority: level.label,
      companies: companyList,
      titleLength: title.length,
    };
  });

  titleLengths.sort((a, b) => a - b);
  const disconnectedCount = connections.filter(isDisconnected).length;
  const connectedCount = connections.length - disconnectedCount;
  const total = connections.length;
  const avgTitleLength = titleLengths.length
    ? Math.round(titleLengths.reduce((sum, n) => sum + n, 0) / titleLengths.length)
    : 0;
  const medianTitleLength = titleLengths.length
    ? titleLengths[Math.floor(titleLengths.length / 2)]
    : 0;

  const timeline = sortedTimeline(byMonth);
  const peakMonth = timeline.reduce(
    (best, item) => (item.count > (best?.count || 0) ? item : best),
    null
  );

  const datedSorted = enriched
    .filter((row) => row.connectedDate && !row.disconnected)
    .sort((a, b) => b.connectedDate.localeCompare(a.connectedDate));

  const recent = datedSorted.slice(0, 12);
  const longestTitles = [...enriched]
    .filter((row) => !row.disconnected)
    .sort((a, b) => b.titleLength - a.titleLength)
    .slice(0, 8);

  const now = new Date();
  const last30 = datedSorted.filter((row) => {
    const d = new Date(row.connectedDate);
    const diff = now - d;
    return diff >= 0 && diff <= 30 * 24 * 60 * 60 * 1000;
  }).length;

  const last365 = datedSorted.filter((row) => {
    const d = new Date(row.connectedDate);
    const diff = now - d;
    return diff >= 0 && diff <= 365 * 24 * 60 * 60 * 1000;
  }).length;

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      total,
      connected: connectedCount,
      disconnected: disconnectedCount,
      withTitle,
      withTitlePct: connectedCount ? Math.round((withTitle / connectedCount) * 100) : 0,
      dated,
      datedPct: connectedCount ? Math.round((dated / connectedCount) * 100) : 0,
      withCompany,
      withCompanyPct: connectedCount ? Math.round((withCompany / connectedCount) * 100) : 0,
      uniqueCompanies: companies.size,
      uniqueKeywords: keywords.size,
      avgTitleLength,
      medianTitleLength,
      multiRole,
      last30Days: last30,
      last365Days: last365,
      peakMonth: peakMonth ? { label: peakMonth.label, count: peakMonth.count } : null,
    },
    charts: {
      timeline,
      activityByYear: [...byYear.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([label, count]) => ({ label, count })),
      byYear: topEntries(byYear, 20),
      byWeekday: [...byWeekday.entries()].map(([label, count]) => ({ label, count })),
      roles: topEntries(roles, 20),
      seniority: topEntries(seniority, 20),
      companies: topEntries(companies, 20),
      keywords: topEntries(keywords, 30),
      titleLengthBuckets: buildTitleLengthBuckets(titleLengths),
    },
    highlights: {
      recent,
      longestTitles,
    },
    contacts: enriched,
  };
}

function buildTitleLengthBuckets(lengths) {
  const buckets = [
    { label: '0–40', min: 0, max: 40, count: 0 },
    { label: '41–80', min: 41, max: 80, count: 0 },
    { label: '81–120', min: 81, max: 120, count: 0 },
    { label: '121–160', min: 121, max: 160, count: 0 },
    { label: '161+', min: 161, max: Infinity, count: 0 },
  ];

  for (const length of lengths) {
    const bucket = buckets.find((item) => length >= item.min && length <= item.max);
    if (bucket) {
      bucket.count += 1;
    }
  }

  return buckets.map(({ label, count }) => ({ label, count }));
}

module.exports = {
  computeConnectionsAnalytics,
  filterConnectionsByConnectedOn,
  connectedOnMs,
  parseConnectedDate,
};
