const assert = require('assert');
const { parseProfileEntities } = require('../lib/parse-voyager-profile');
const { createEmptyProfile, mergeUniqueByKey } = require('../lib/profile-schema');
const { parseProfileInput } = require('../lib/scrape-linkedin-profile');
const { renderProfileHtml } = require('../lib/render-profile-html');
const fs = require('fs');
const path = require('path');

const samplePayload = {
  data: {
    elements: [
      {
        entityUrn: 'urn:li:fsd_profile:123',
        publicIdentifier: 'ada-lovelace',
      },
    ],
  },
  included: [
    {
      $type: 'com.linkedin.voyager.dash.identity.profile.Profile',
      entityUrn: 'urn:li:fsd_profile:123',
      publicIdentifier: 'ada-lovelace',
      firstName: 'Ada',
      lastName: 'Lovelace',
      headline: { text: 'Engineer' },
      summary: { text: 'Building things.' },
      locationName: 'Dublin, Ireland',
    },
    {
      $type: 'com.linkedin.voyager.dash.identity.profile.Position',
      title: 'CTO',
      companyName: 'Example Co',
      dateRange: {
        startDate: { year: 2020, month: 1 },
        endDate: { year: 2024, month: 6 },
      },
    },
    {
      $type: 'com.linkedin.voyager.dash.identity.profile.Skill',
      name: 'JavaScript',
      endorsementCount: 12,
    },
  ],
};

const parsed = parseProfileEntities([samplePayload]);
assert.strictEqual(parsed.identity.fullName, 'Ada Lovelace');
assert.strictEqual(parsed.identity.headline, 'Engineer');
assert.strictEqual(parsed.experience.length, 1);
assert.strictEqual(parsed.skills[0].name, 'JavaScript');

const input = parseProfileInput('https://www.linkedin.com/in/ada-lovelace/');
assert.strictEqual(input.vanityName, 'ada-lovelace');

const profile = createEmptyProfile('ada-lovelace', input.profileUrl);
profile.experience.push(parsed.experience[0], parsed.experience[0]);
profile.experience = mergeUniqueByKey(profile.experience, (row) => `${row.title}|${row.companyName}`);
assert.strictEqual(profile.experience.length, 1);

const sampleProfile = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-profile.json'), 'utf8')
);
const html = renderProfileHtml(sampleProfile);
assert.ok(html.includes('Ada Lovelace'));
assert.ok(html.includes('Experience'));
assert.ok(html.includes('skill-pill'));

console.log('profile-scraper unit checks passed');
