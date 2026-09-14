const MAX_KEYWORDS = 50;
const MAX_KEYWORD_LENGTH = 100;
const DEFAULT_PROTECTED_TITLE_KEYWORDS = [
  'founder',
  'co-founder',
  'cofounder',
  'chief executive officer',
  'ceo',
  'chief technology officer',
  'cto',
  'chief financial officer',
  'cfo',
  'chief operating officer',
  'coo',
  'chief information officer',
  'cio',
  'chief product officer',
  'cpo',
  'chief marketing officer',
  'cmo',
  'chief revenue officer',
  'cro',
  'president',
  'chairman',
  'chairwoman',
  'chairperson',
  'executive chair',
  'board',
  'board member',
  'board director',
  'non-executive director',
  'non executive director',
  'investor',
  'angel',
  'venture',
  'venture capitalist',
  'vc',
  'managing partner',
  'general partner',
  'venture partner',
  'managing director',
  'head of',
  'owner',
  'proprietor',
  'family office',
];

function normalizeKeywords(input) {
  const values = Array.isArray(input) ? input : [input];
  const keywords = [];
  const seen = new Set();

  for (const value of values) {
    for (const part of String(value || '').split(/[,\n]/)) {
      const keyword = part.trim().replace(/\s+/g, ' ');
      const key = keyword.toLocaleLowerCase();
      if (!keyword || seen.has(key)) {
        continue;
      }
      if (keyword.length > MAX_KEYWORD_LENGTH) {
        throw new Error(
          `Keyword "${keyword.slice(0, 30)}…" is too long (maximum ${MAX_KEYWORD_LENGTH} characters).`
        );
      }
      keywords.push(keyword);
      seen.add(key);
      if (keywords.length > MAX_KEYWORDS) {
        throw new Error(`Use no more than ${MAX_KEYWORDS} keywords.`);
      }
    }
  }

  return keywords;
}

function titleMatchesKeywords(title, keywords) {
  if (!keywords || keywords.length === 0) {
    return true;
  }
  const haystack = String(title || '').toLocaleLowerCase();
  return keywords.some((keyword) =>
    haystack.includes(String(keyword).toLocaleLowerCase())
  );
}

function normalizeForProtectedMatch(value) {
  return String(value || '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function titleMatchesProtectedKeywords(title, keywords) {
  const haystack = normalizeForProtectedMatch(title);
  if (!haystack || !keywords || keywords.length === 0) {
    return false;
  }
  const padded = ` ${haystack} `;
  return keywords.some((keyword) => {
    const needle = normalizeForProtectedMatch(keyword);
    return needle && padded.includes(` ${needle} `);
  });
}

module.exports = {
  DEFAULT_PROTECTED_TITLE_KEYWORDS,
  normalizeKeywords,
  titleMatchesKeywords,
  titleMatchesProtectedKeywords,
};
