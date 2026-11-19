// Real agents for Agentdex.
//
//   npm run real        town + real agents in one process (simulator off)
//   npm run agents      agents only, against a server you started with AGENTDEX_SIM=0
//
//   ANTHROPIC_API_KEY   your Claude API key (or `ant auth login`)
//   AGENTDEX_URL        server to report to (agents-only mode), default http://127.0.0.1:8787
//   AGENTDEX_TOKEN      bearer token, if the server has one
//   AGENTDEX_WORKSPACE  folder the agents can read and write, default ./workspace
//   AGENTDEX_MODEL      default claude-opus-5-5
//   AGENTDEX_EFFORT     low | medium | high | xhigh | max, default medium
import Anthropic from '@anthropic-ai/sdk';
import { fileURLToPath } from 'node:url';
import { createAgentdexClient } from './agentdex.js';
import { createWorkspace } from './workspace.js';
import { createRuntime } from './runtime.js';

const STARTERS = [
  { ref: 'patch', species: 'bytle', nick: 'PATCH' },
  { ref: 'scout', species: 'fennook', nick: 'SCOUT' },
  { ref: 'quill', species: 'quillow', nick: 'QUILL' },
  { ref: 'checks', species: 'sentril', nick: 'CHECKS' },
];

async function main() {
  const withServer = process.argv.includes('--with-server');
  const token = process.env.AGENTDEX_TOKEN || null;
  let url = process.env.AGENTDEX_URL || 'http://127.0.0.1:8787';

  if (withServer) {
    const { createStore } = await import('../server/store.js');
    const { createApp } = await import('../server/app.js');
    const port = Number(process.env.PORT || 8787);
    const host = process.env.HOST || '127.0.0.1';
    const app = createApp({ store: createStore(), token, indexPath: fileURLToPath(new URL('../index.html', import.meta.url)) });
    await new Promise((r) => app.listen(port, host, r));
    url = `http://127.0.0.1:${port}`;
    console.log(`Agentdex town: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  }

  const dex = createAgentdexClient({ url, token });
  const workspace = await createWorkspace(process.env.AGENTDEX_WORKSPACE || 'workspace');
  const runtime = createRuntime({
    anthropic: new Anthropic(),
    dex,
    workspace,
    model: process.env.AGENTDEX_MODEL || 'claude-opus-5-5',
    effort: process.env.AGENTDEX_EFFORT || 'medium',
  });

  const state = await dex.state().catch((err) => { throw new Error(`Cannot reach Agentdex at ${url}: ${err.message}`); });
  if (state.adapter === 'simulator') console.warn('Warning: the server is running its simulator. Start it with AGENTDEX_SIM=0 so the fake agents stay out of the way.');
  const refs = new Set(state.agents.map((a) => a.ref));
  const room = 6 - state.agents.filter((a) => !a.boxed).length;
  const missing = STARTERS.filter((s) => !refs.has(s.ref)).slice(0, Math.max(0, room));
  if (missing.length) await dex.post('/api/ingest', missing.map((s) => ({ type: 'agent.spawned', data: s })));

  dex.subscribe({
    onSnapshot: runtime.onSnapshot,
    onChange: runtime.onChange,
    onError: (err) => console.error(`Lost the event stream (${err.message}); reconnecting.`),
  });

  console.log(`Workspace: ${workspace.root}`);
  console.log('Agents are ready. In the town, open an agent and use GIVE TASK.');
}

main().catch((err) => { console.error(err.message); process.exit(1); });
