// Repairs rows whose public profile slug was overwritten by the opaque member
// id a message thread links to. The slug is taken from connections.csv by name,
// so the inbox scan no longer has to open a profile page to recover it.
// Ambiguous names are left alone: two connections with the same name cannot be
// told apart locally, and the removal step must not act on a guess.
const path = require('path');
const {
  isObfuscatedVanity,
  isUnrequitedCandidate,
  loadInboxCsv,
  prefersIncomingVanity,
  writeInboxCsv,
} = require('./lib/inbox-csv');
const { loadConnectionsCsv } = require('./lib/connections-csv');
const { buildConnectionIndex, matchConnection } = require('./lib/connection-index');
const { snapshotBeforeWrite } = require('./lib/rolling-backup');

const INBOX_CSV = path.join(__dirname, 'unrequited-love.csv');
const CONNECTIONS_CSV = path.join(__dirname, 'connections.csv');

function main() {
  const apply = process.argv.slice(2).includes('--apply');
  const rows = loadInboxCsv(INBOX_CSV);
  if (!rows.length) {
    console.error(`No rows in ${INBOX_CSV}.`);
    process.exit(1);
  }

  const index = buildConnectionIndex(loadConnectionsCsv(CONNECTIONS_CSV));
  if (!index.size) {
    console.error(`No connections in ${CONNECTIONS_CSV}.`);
    process.exit(1);
  }

  const pending = rows.filter(
    (row) =>
      isUnrequitedCandidate(row) &&
      (!row.vanityName || isObfuscatedVanity(row.vanityName))
  );

  let repaired = 0;
  let ambiguous = 0;
  let unmatched = 0;
  const samples = [];

  for (const row of pending) {
    const matched = matchConnection(index, row.name);
    if (matched.ambiguous) {
      ambiguous += 1;
      continue;
    }
    if (!matched.match || !prefersIncomingVanity(row.vanityName, matched.match.vanityName)) {
      unmatched += 1;
      continue;
    }
    if (samples.length < 5) {
      samples.push(`  ${row.name}: ${row.vanityName || '(empty)'} → ${matched.match.vanityName}`);
    }
    if (apply) {
      row.vanityName = matched.match.vanityName;
      if (matched.match.profileUrl) {
        row.profileUrl = matched.match.profileUrl;
      }
    }
    repaired += 1;
  }

  console.log(`Candidates awaiting a profile name: ${pending.length.toLocaleString()}`);
  console.log(`Slug available in connections.csv:  ${repaired.toLocaleString()}`);
  console.log(`Ambiguous name, left for a scan:    ${ambiguous.toLocaleString()}`);
  console.log(`No usable slug, left for a scan:    ${unmatched.toLocaleString()}`);
  if (samples.length) {
    console.log('');
    console.log(samples.join('\n'));
  }
  console.log('');

  if (!apply) {
    console.log('Dry run. Re-run with --apply to write the changes.');
    return;
  }

  snapshotBeforeWrite(INBOX_CSV);
  writeInboxCsv(rows, INBOX_CSV);
  console.log(`Wrote ${repaired.toLocaleString()} slug(s) to ${INBOX_CSV}.`);
  console.log(
    `${(ambiguous + unmatched).toLocaleString()} candidate(s) still need a profile page open.`
  );
}

main();
