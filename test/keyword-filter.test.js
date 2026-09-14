const assert = require('assert');
const {
  DEFAULT_PROTECTED_TITLE_KEYWORDS,
  normalizeKeywords,
  titleMatchesKeywords,
  titleMatchesProtectedKeywords,
} = require('../lib/keyword-filter');

assert.deepStrictEqual(
  normalizeKeywords(' recruiter, Sales Director\nbusiness   development,RECRUITER '),
  ['recruiter', 'Sales Director', 'business development']
);
assert.strictEqual(
  titleMatchesKeywords('Senior Technical Recruiter', ['recruiter', 'sales']),
  true
);
assert.strictEqual(
  titleMatchesKeywords('VP of Business Development', ['business development']),
  true
);
assert.strictEqual(
  titleMatchesKeywords('Software Engineer', ['recruiter', 'sales']),
  false
);
assert.strictEqual(titleMatchesKeywords('', []), true);
assert.strictEqual(
  titleMatchesProtectedKeywords(
    'Co-Founder & CEO',
    DEFAULT_PROTECTED_TITLE_KEYWORDS
  ),
  true
);
assert.strictEqual(
  titleMatchesProtectedKeywords(
    'General Partner at Early Stage Fund',
    DEFAULT_PROTECTED_TITLE_KEYWORDS
  ),
  true
);
assert.strictEqual(
  titleMatchesProtectedKeywords(
    'Director of Software Engineering',
    DEFAULT_PROTECTED_TITLE_KEYWORDS
  ),
  false
);
assert.strictEqual(
  titleMatchesProtectedKeywords(
    'Partner Success Manager',
    DEFAULT_PROTECTED_TITLE_KEYWORDS
  ),
  false
);
assert.strictEqual(
  titleMatchesProtectedKeywords('Advisor', ['advisor']),
  true
);
assert.strictEqual(
  titleMatchesProtectedKeywords('Advisory Board Specialist', ['advisor']),
  false
);

assert.throws(
  () => normalizeKeywords('x'.repeat(101)),
  /too long/
);

console.log('keyword-filter tests passed');
