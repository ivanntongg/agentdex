#!/usr/bin/env node
// Start Agentdex from anywhere:  npx agentdex-town
//
//   npx agentdex-town              real agents, town at http://localhost:8787
//   npx agentdex-town --practice   pretend agents, free, no Claude needed
//   npx agentdex-town --no-open    don't open the browser
//   npx agentdex-town --home DIR   keep the town, settings and workspace in DIR (default: ~/Agentdex)
//
// Your saved town, settings and the agents' workspace live in one folder you can find:
// ~/Agentdex on Mac and Linux, C:\Users\<you>\Agentdex on Windows. Updating the app never touches it.
import { mkdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

if (has('--version') || has('-v')) { console.log(pkg.version); process.exit(0); }
if (has('--help') || has('-h')) {
  console.log(`Agentdex ${pkg.version}: a pixel town where your AI agents live, work, and ask before they act.

  npx agentdex-town              start with real agents (connect Claude in SETUP)
  npx agentdex-town --practice   pretend agents: free, no Claude needed
  npx agentdex-town --no-open    don't open the browser
  npx agentdex-town --home DIR   where to keep your town, settings and workspace (default: ~/Agentdex)

Stop it with Ctrl + C, or close this window. Your town is saved.`);
  process.exit(0);
}

const env = process.env;
const home = path.resolve(valueOf('--home') || env.AGENTDEX_HOME || path.join(os.homedir(), 'Agentdex'));
const port = Number(env.PORT || 8787);
const townUrl = `http://localhost:${port}`;

function openBrowser(url) {
  if (has('--no-open') || env.CI) return;
  const cmd = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* open it by hand */ }
}

async function alreadyRunning() {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

if (await alreadyRunning()) {
  console.log(`Agentdex is already running. Opening ${townUrl}`);
  openBrowser(townUrl);
  process.exit(0);
}

mkdirSync(home, { recursive: true });
process.chdir(home); // config, saved town and workspace are created here

if (has('--practice')) {
  console.log('Practice mode: pretend agents, nothing real happens.');
  await import('../server/index.js');
  setTimeout(() => openBrowser(townUrl), 600);
} else {
  const { main } = await import('../runtime/index.js');
  try {
    await main({ argv: ['node', 'agentdex', '--with-server'], env });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  console.log(`Your town, settings and files are kept in ${home}`);
  console.log('Keep this window open while you play. Press Ctrl + C to stop.');
  openBrowser(townUrl);
}
