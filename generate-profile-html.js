#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { generateProfileHtmlFromJson } = require('./lib/profile-html');

function parseArgs(argv) {
  const args = {
    input: path.join(__dirname, 'profiles', 'your-profile', 'profile.json'),
    output: null,
    open: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input' && argv[i + 1]) {
      args.input = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--output' && argv[i + 1]) {
      args.output = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--open') {
      args.open = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      args.input = path.resolve(arg);
    }
  }

  return args;
}

async function maybeOpen(filePath) {
  const { execFile } = require('child_process');
  const platform = process.platform;
  let command;
  let commandArgs;

  if (platform === 'darwin') {
    command = 'open';
    commandArgs = [filePath];
  } else if (platform === 'win32') {
    command = 'cmd';
    commandArgs = ['/c', 'start', '', filePath];
  } else {
    command = 'xdg-open';
    commandArgs = [filePath];
  }

  await new Promise((resolve, reject) => {
    execFile(command, commandArgs, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function printHelp() {
  console.log(`Usage:
  node generate-profile-html.js [profile.json]
  node generate-profile-html.js --input profiles/your-profile/profile.json --open

Options:
  --input <path>   Path to profile.json (default: profiles/your-profile/profile.json)
  --output <path>  Output HTML path (default: beside profile.json)
  --open           Open the generated page in your browser
  --help           Show this help
`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const result = generateProfileHtmlFromJson(args.input, args.output);
  console.log(`Generated: ${result.htmlPath}`);

  if (args.open) {
    await maybeOpen(result.htmlPath);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
