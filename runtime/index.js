// Real agents for Agentdex.
//
//   npm run real        town + real agents + SETUP screen in one process
//   npm run agents      agents only, against a server you started with AGENTDEX_SIM=0
//
// Everything can be set on the SETUP screen. Environment variables still work as a fallback:
//   ANTHROPIC_API_KEY, AGENTDEX_MODEL, AGENTDEX_EFFORT, WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID,
//   WHATSAPP_APP_SECRET, WHATSAPP_ALLOWED
// and these only as variables:
//   PORT (8787), HOST (127.0.0.1), AGENTDEX_TOKEN, AGENTDEX_URL, AGENTDEX_WORKSPACE (./workspace),
//   AGENTDEX_CONFIG (./agentdex.config.json), AGENTDEX_STATE (./agentdex.state.json, the saved town), WHATSAPP_PORT (8788),
//   AGENTDEX_BRAIN (api | claude-code), AGENTDEX_CLAUDE_BIN (path to the claude command, default "claude"),
//   AGENTDEX_SKILLS_DIR (./skills, installed community skills), AGENTDEX_SKILL_SCOUT (on | off)
import Anthropic from '@anthropic-ai/sdk';
import { fileURLToPath } from 'node:url';
import { createAgentdexClient } from './agentdex.js';
import { createWorkspace } from './workspace.js';
import { createRuntime } from './runtime.js';
import { createClaudeCode, ClaudeCodeError } from './claude-code.js';
import { createConfig, ConfigError } from '../server/config.js';
import { StoreError } from '../server/store.js';
import { createWhatsAppBridge } from '../bridges/whatsapp.js';
import { findNgrok, startTunnel } from '../bridges/tunnel.js';
import { createSkills, parseRef, SkillError } from './skills.js';
import { SPECIES } from '../server/species.js';

const STARTERS = [
  { ref: 'patch', species: 'bytle', nick: 'PATCH' },
  { ref: 'scout', species: 'fennook', nick: 'SCOUT' },
  { ref: 'quill', species: 'quillow', nick: 'QUILL' },
  { ref: 'checks', species: 'sentril', nick: 'CHECKS' },
];

function claudeError(err, model) {
  if (err instanceof Anthropic.AuthenticationError) return 'Claude rejected this key. Copy it again from the Claude Console and paste it here.';
  if (err instanceof Anthropic.PermissionDeniedError) return `This key is not allowed to use ${model}. Pick another model or check your Console settings.`;
  if (err instanceof Anthropic.NotFoundError) return `${model} is not available on this key. Pick another model.`;
  if (err instanceof Anthropic.RateLimitError) return 'Claude is busy or your credit is used up. Check billing in the Claude Console.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach Claude. Check your internet connection.';
  return `Claude said: ${err.message}`;
}

export async function main({ argv = process.argv, env = process.env } = {}) {
  const withServer = argv.includes('--with-server');
  const token = env.AGENTDEX_TOKEN || null;
  let url = env.AGENTDEX_URL || 'http://127.0.0.1:8787';
  const config = createConfig({ path: env.AGENTDEX_CONFIG || 'agentdex.config.json', env });
  const workspace = await createWorkspace(env.AGENTDEX_WORKSPACE || 'workspace');
  const skillLib = createSkills({ dir: env.AGENTDEX_SKILLS_DIR || 'skills' });
  let runtime = null;

  // One Claude client, rebuilt when the key changes.
  let client = null;
  let clientKey = null;
  const claude = () => {
    const key = config.get('anthropicKey');
    if (key !== clientKey) { clientKey = key; client = key ? new Anthropic({ apiKey: key }) : null; }
    return client;
  };
  let lastClaudeCheck = null;
  let claudeCode = null;
  let planUsage = null; // latest plan usage Claude Code reported

  let dex = null;
  let bridge = null;
  let bridgeCtl = null;
  let bridgeError = null;
  let tunnel = null;
  let tunnelState = { url: null, error: null };
  let appliedKey = null;
  process.once('exit', () => tunnel?.stop());
  // Starts (or restarts) the WhatsApp bridge and its built-in ngrok tunnel. Other settings changes leave them alone.
  let applying = Promise.resolve();
  let forceWhatsApp = false; // set when SETUP saves WhatsApp, so SAVE always retries
  const applyWhatsApp = (opts) => (applying = applying.then(() => doApplyWhatsApp(opts)).catch((err) => console.error(`WhatsApp: ${err.message}`)));
  async function doApplyWhatsApp({ force = false } = {}) {
    const c = config.whatsapp();
    const t = config.tunnel();
    const key = JSON.stringify([c, t]);
    if (!force && key === appliedKey && (bridge || !c)) return;
    appliedKey = key;
    if (bridge) { bridgeCtl.abort(); await bridge.stop(); bridge = null; }
    if (tunnel) { const old = tunnel; tunnel = null; await old.stop(); }
    bridgeError = null;
    tunnelState = { url: null, error: null };
    if (!c || !dex) return;
    try {
      bridgeCtl = new AbortController();
      bridge = createWhatsAppBridge({ dex, config: c });
      await bridge.start(bridgeCtl.signal);
      console.log(`WhatsApp bridge listening on http://127.0.0.1:${c.port}/webhooks/whatsapp`);
      await bridge.checkCodes();
    } catch (err) {
      bridge = null;
      bridgeError = err.code === 'EADDRINUSE' ? `Port ${c.port} is busy. Close the other program using it, or set WHATSAPP_PORT.` : err.message;
      console.error(`WhatsApp bridge: ${bridgeError}`);
      return;
    }
    if (!t) return;
    try {
      const me = await startTunnel({ bin: env.AGENTDEX_NGROK_BIN || findNgrok(), port: c.port, authtoken: t.authtoken, domain: t.domain, onExit: (why) => { if (tunnel === me) { tunnel = null; tunnelState = { url: null, error: why }; } } });
      tunnel = me;
      tunnelState = { url: tunnel.url, error: null };
      console.log(`WhatsApp tunnel open: ${tunnel.url}`);
    } catch (err) {
      tunnelState = { url: null, error: err.message };
      console.error(`WhatsApp tunnel: ${err.message}`);
    }
  }

  const setup = {
    async status() {
      const wa = config.whatsapp();
      return {
        settings: config.publicView(),
        workspace: workspace.root,
        claude: { brain: config.brain(), hasKey: Boolean(config.get('anthropicKey')), lastCheck: lastClaudeCheck },
        plan: config.brain() === 'claude-code' ? planUsage : null,
        whatsapp: {
          complete: Boolean(wa), running: Boolean(bridge), error: bridgeError,
          port: wa?.port || Number(env.WHATSAPP_PORT || 8788), path: '/webhooks/whatsapp',
          health: bridge ? bridge.health() : null,
          tunnel: { ...tunnelState, configured: Boolean(config.tunnel()), installed: Boolean(env.AGENTDEX_NGROK_BIN || findNgrok()) },
        },
      };
    },
    async save(body) {
      forceWhatsApp = Object.keys(body || {}).some((k) => /^(whatsapp|ngrok)/.test(k));
      const wa = forceWhatsApp;
      try { config.save(body); } catch (err) {
        forceWhatsApp = false;
        throw err instanceof ConfigError ? new StoreError(400, err.message) : err;
      }
      // Wait for WhatsApp and its tunnel to come up, so SETUP shows the real result.
      if (wa) await Promise.race([applying, new Promise((r) => setTimeout(r, 25_000))]);
    },
    async testClaude() {
      if (config.brain() === 'claude-code') {
        try {
          await claudeCode.check({ model: config.model() });
          lastClaudeCheck = { ok: true, message: 'Connected through Claude Code. Tasks will use your Claude plan.', at: new Date().toISOString() };
        } catch (err) {
          lastClaudeCheck = { ok: false, message: err instanceof ClaudeCodeError ? err.message : `Claude Code check failed: ${err.message}`, at: new Date().toISOString() };
        }
        return lastClaudeCheck;
      }
      const c = claude();
      if (!c) return (lastClaudeCheck = { ok: false, message: 'Paste your Claude API key first.', at: new Date().toISOString() });
      try {
        const m = await c.models.retrieve(config.model());
        lastClaudeCheck = { ok: true, message: `Connected. ${m.display_name || config.model()} is ready.`, at: new Date().toISOString() };
      } catch (err) {
        lastClaudeCheck = { ok: false, message: claudeError(err, config.model()), at: new Date().toISOString() };
      }
      return lastClaudeCheck;
    },
    async testWhatsApp() {
      if (!config.whatsapp()) return { ok: false, message: 'Fill in all four WhatsApp boxes and save first.' };
      if (!bridge) return { ok: false, message: bridgeError || 'The WhatsApp bridge is not running.' };
      try { await bridge.sendTest(); return { ok: true, message: 'Test message sent. Check WhatsApp on your phone.' }; }
      catch (err) { return { ok: false, message: err.message }; }
    },
  };

  // The MART: installed skills, search, and asking for one. Installing always needs a YES in the town.
  const asStoreError = (err) => (err instanceof SkillError ? new StoreError(400, err.message) : err);
  const skillsApi = {
    async state() { return { enabled: config.skillScout(), skills: await skillLib.list() }; },
    async search(q) {
      try {
        const have = new Set((await skillLib.list()).map((s) => s.id));
        return (await skillLib.search(q)).map((r) => ({ ...r, installed: have.has(r.id) }));
      } catch (err) { throw asStoreError(err); }
    },
    async request({ id, agentId }) {
      try { parseRef(id); } catch (err) { throw asStoreError(err); }
      const free = (a) => a && !a.boxed && !a.task && !a.chatting && a.status !== 'FNT' && a.status !== 'PAR';
      const all = [...runtime.agents.values()];
      const agent = agentId != null ? all.find((a) => String(a.id) === String(agentId) || a.ref === agentId) : all.find((a) => free(a) && !a.reviewingId && !SPECIES[a.species]?.reviewer);
      if (!free(agent)) throw new StoreError(409, agentId != null ? 'That agent is busy. Pick a free one, or try again in a moment.' : 'Everyone is busy right now. Try again when an agent is free.');
      runtime.scout.request(agent, id, AbortSignal.timeout(30 * 60_000)).catch((err) => {
        dex.emit('agent.interacted', agent.id, { action: 'poke', tone: 'bad', message: `${agent.nick} couldn't get that skill: ${err.message}` }).catch(() => {});
      });
      return { message: `${agent.nick} went to the MART to get it. You'll get a YES / NO in a moment.` };
    },
    async remove(slug) { try { await runtime.scout.remove(slug); } catch (err) { throw asStoreError(err); } },
    async setEnabled(on) { config.save({ skillScout: on ? 'on' : 'off' }); },
  };

  if (withServer) {
    const { createStore } = await import('../server/store.js');
    const { createApp } = await import('../server/app.js');
    const port = Number(env.PORT || 8787);
    const host = env.HOST || '127.0.0.1';
    const { createPersistence } = await import('../server/persist.js');
    const store = createStore();
    // The town is saved next to the app, so closing Agentdex keeps names, levels, chats and the log.
    const persistence = createPersistence({ store, path: env.AGENTDEX_STATE || 'agentdex.state.json' });
    const restored = persistence.load();
    if (restored.loaded) console.log(`Restored your town (${store.agents.size} agents).`);
    const save = () => { persistence.flush(); };
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.once(sig, () => { save(); process.exit(0); });
    process.once('exit', save);
    const app = createApp({ store, token, setup, skills: skillsApi, workspaceRoot: workspace.root, indexPath: fileURLToPath(new URL('../index.html', import.meta.url)) });
    await new Promise((resolve, reject) => { app.once('error', reject); app.listen(port, host, resolve); }).catch((err) => {
      throw new Error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use. Agentdex may already be running in another window.` : err.message);
    });
    url = `http://127.0.0.1:${port}`;
    console.log(`Agentdex town: http://localhost:${port}`);
  }

  dex = createAgentdexClient({ url, token });
  claudeCode = createClaudeCode({ bin: env.AGENTDEX_CLAUDE_BIN || 'claude', workspace, url, token, onPlanUsage: (u) => { planUsage = u; } });
  runtime = createRuntime({ dex, workspace, skills: skillLib, settings: () => ({ engine: config.brain(), claudeCode, anthropic: claude(), model: config.model(), effort: config.effort(), skillScout: config.skillScout() }) });

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

  await runtime.scout.sync().catch((err) => console.error(`Could not load installed skills: ${err.message}`));
  config.onChange(() => { const force = forceWhatsApp; forceWhatsApp = false; applyWhatsApp({ force }); });
  await applyWhatsApp();

  console.log(`Workspace: ${workspace.root}`);
  const ready = config.brain() === 'claude-code' || config.get('anthropicKey');
  console.log(ready ? `Agents are ready (${config.brain() === 'claude-code' ? 'using Claude Code and your Claude plan' : 'using your Claude API key'}). Open an agent and use GIVE TASK.` : 'Open the town and press SETUP to connect Claude.');
  return { setup, config };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
