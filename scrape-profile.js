#!/usr/bin/env node
require('dotenv').config();

const path = require('path');
const {
  scrapeLinkedInProfileWithBrowser,
  DEFAULT_OUTPUT_ROOT,
} = require('./lib/scrape-linkedin-profile');

function parseArgs(argv) {
  const args = {
    profile: 'https://www.linkedin.com/in/your-profile/',
    output: DEFAULT_OUTPUT_ROOT,
    headless: process.env.HEADLESS === 'true',
    skipDetails: false,
    fullDetails: false,
    fullApi: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--output' && argv[i + 1]) {
      args.output = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--vanity' && argv[i + 1]) {
      args.profile = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--headless') {
      args.headless = true;
      continue;
    }
    if (arg === '--skip-details') {
      args.skipDetails = true;
      continue;
    }
    if (arg === '--full-details') {
      args.fullDetails = true;
      continue;
    }
    if (arg === '--full-api') {
      args.fullApi = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      args.profile = arg;
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node scrape-profile.js [profile-url-or-vanity]
  node scrape-profile.js --vanity your-profile
  node scrape-profile.js https://www.linkedin.com/in/your-profile/

Options:
  --output <dir>     Output root directory (default: ./profiles)
  --headless         Run browser headless
  --skip-details     Skip detail sub-pages (fastest; API + main page only)
  --full-details     Visit all 12 detail sub-pages (slowest; was the old default)
  --full-api         Fetch extra Voyager API decoration variants
  --help             Show this help

Speed: default visits 3 detail pages (experience, education, skills).
       Your ~154s run was visiting 12 pages with 1.5s delays each.

Examples:
  npm run profile:scrape
  npm run profile:scrape -- https://www.linkedin.com/in/your-profile/
  node scrape-profile.js --vanity your-profile --output ./profiles
`);
}

function printSummary(result) {
  const { profile, saved, timings, detailPagesMode, visitedUrls } = result;
  console.log('');
  console.log('Profile scrape complete');
  console.log('─'.repeat(50));
  console.log(`Name:        ${profile.identity.fullName || '(unknown)'}`);
  console.log(`Vanity:      ${profile.source.vanityName}`);
  console.log(`Headline:    ${profile.identity.headline || '(none)'}`);
  console.log(`Location:    ${profile.identity.location || '(none)'}`);
  console.log(`Experience:  ${profile.experience.length}`);
  console.log(`Education:   ${profile.education.length}`);
  console.log(`Skills:      ${profile.skills.length}`);
  console.log(`Detail mode: ${detailPagesMode}`);
  console.log(`Saved to:    ${saved.profileDir}/profile.json`);
  console.log(`Web page:    ${saved.htmlPath || `${saved.profileDir}/profile.html`}`);
  console.log(`Raw API:     ${saved.profileDir}/raw/`);
  console.log(`DOM dumps:   ${saved.profileDir}/dom/`);

  const profilePhoto = profile.media?.profilePhoto;
  const backgroundPhoto = profile.media?.backgroundPhoto;
  if (profilePhoto?.localPath || backgroundPhoto?.localPath) {
    console.log(`Media:       ${saved.profileDir}/media/`);
    if (profilePhoto?.localPath) {
      console.log(`  Profile:   ${profilePhoto.localPath}`);
    }
    if (backgroundPhoto?.localPath) {
      console.log(`  Cover:     ${backgroundPhoto.localPath}`);
    }
  }

  const companyLogos = new Set(
    (profile.experience || [])
      .map((row) => row.companyLogoLocalPath)
      .filter(Boolean)
  );
  if (companyLogos.size > 0) {
    console.log(`Companies:   ${saved.profileDir}/media/companies/ (${companyLogos.size} logos)`);
  }

  console.log(`Duration:    ${(profile.source.scrapeDurationMs / 1000).toFixed(1)}s`);

  if (timings?.length) {
    console.log('');
    console.log('Time breakdown:');
    for (const row of timings) {
      console.log(`  ${row.label.padEnd(32)} ${(row.ms / 1000).toFixed(1)}s`);
    }
  }

  const urls = visitedUrls || profile.provenance?.visitedUrls || [];
  if (urls.length > 0) {
    console.log('');
    console.log(`URLs visited (${urls.length}):`);
    for (const entry of urls) {
      const label = entry.type ? `[${entry.type}] ` : '';
      console.log(`  ${label}${entry.url}`);
    }
    console.log(`Full log:    ${saved.profileDir}/urls-visited.json`);
  }
  console.log('');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const result = await scrapeLinkedInProfileWithBrowser({
    profile: args.profile,
    outputRoot: args.output,
    headless: args.headless,
    detailPagesMode: args.skipDetails ? 'none' : args.fullDetails ? 'full' : 'core',
    fullApi: args.fullApi,
  });

  printSummary(result);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
