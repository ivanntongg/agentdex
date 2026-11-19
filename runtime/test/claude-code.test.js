// "My Claude subscription" mode, end to end: the real Agentdex server and runtime, the real
// approval hook, and a stand-in for the claude command (fake-claude.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../../server/store.js';
import { createApp } from '../../server/app.js';
import { createAgentdexClient } from '../agentdex.js';
import { createWorkspace } from '../workspace.js';
import { createRuntime } from '../runtime.js';
import { createClaudeCode, ClaudeCodeError, resolveClaude, planUsageFrom } from '../claude-code.js';

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const HOOK = fileURLToPath(new URL('../cc-hook.js', import.meta.url));

async function setup(scenario = 'normal') {
  const store = createStore();
  const app = createApp({ store });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.address().port}`;
  const dex = createAgentdexClient({ url });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentdex-cc-'));
  const workspace = await createWorkspace(path.join(dir, 'ws'));
  const fakeLog = path.join(dir, 'fake.log');
  const env = { FAKE_SCENARIO: scenario, FAKE_LOG: fakeLog, AGENTDEX_HOOK_POLL_MS: '50' };
  const spawnImpl = (bin, args, opts) => spawn(process.execPath, [FAKE, ...args], { ...opts, env: { ...opts.env, ...env } });
  const plans = [];
  const claudeCode = createClaudeCode({ workspace, url, spawnImpl, onPlanUsage: (u) => plans.push(u) });
  const runtime = createRuntime({ dex, workspace, log: () => {}, settings: () => ({ engine: 'claude-code', claudeCode, model: 'claude-opus-5-5', effort: 'low' }) });
  const ctl = new AbortController();
  dex.subscribe({ onSnapshot: runtime.onSnapshot, onChange: runtime.onChange, signal: ctl.signal });
  await dex.post('/api/ingest', [
    { type: 'agent.spawned', data: { species: 'fennook', nick: 'SCOUT', ref: 'scout' } },
    { type: 'agent.spawned', data: { species: 'sentril', nick: 'CHECKS', ref: 'checks' } },
  ]);
  const until = async (fn, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = fn(await dex.state()); if (v) return v; await new Promise((r) => setTimeout(r, 30)); }
    throw new Error('timed out waiting');
  };
  await until(() => runtime.agents.size === 2);
  const fakeEntries = () => (existsSync(fakeLog) ? readFileSync(fakeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const close = async () => { ctl.abort(); await new Promise((r) => app.close(r)); };
  return { store, dex, url, workspace, claudeCode, until, fakeEntries, plans, close };
}
const post = (url, p, body) => fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

test('a task through Claude Code: drafts free, other writes wait for YES, escapes refused, then review', async () => {
  const t = await setup();
  try {
    await post(t.url, '/api/agents/scout/tasks', { title: 'Compare 3 note apps', review: true });
    const ap = await t.until((s) => s.approvals[0]);
    assert.equal(ap.tool, 'WRITE');
    assert.equal(ap.target, 'notes/final.md');
    assert.ok(existsSync(path.join(t.workspace.root, 'drafts/plan.md')), 'drafts written without asking');
    assert.ok(!existsSync(path.join(t.workspace.root, 'notes/final.md')), 'waits for the answer');

    await post(t.url, `/api/approvals/${ap.id}`, { decision: 'yes' });
    const s = await t.until((st) => st.log.some((e) => e.type === 'task.finished') && st);
    assert.ok(existsSync(path.join(t.workspace.root, 'notes/final.md')));
    assert.ok(!existsSync(path.join(t.workspace.root, '..', 'escape.txt')), 'nothing outside the workspace');

    const decisions = t.fakeEntries().filter((e) => e.hook).map((e) => e.decision);
    assert.deepEqual(decisions, ['allow', 'allow', 'deny']);
    assert.ok(s.log.some((e) => e.type === 'review.finished' && /approved/.test(e.message)));
    assert.match(s.log.find((e) => e.type === 'task.finished').message, /Wrote a plan in drafts/);
    const scout = s.agents.find((a) => a.ref === 'scout');
    assert.ok(scout.hp < scout.hpMax, 'HP follows the context Claude Code reports');

    const taskArgs = t.fakeEntries().find((e) => e.args && e.args.includes('--settings')).args;
    for (const f of ['--restricted', '--strict-mcp-config', '--no-session-persistence', '--permission-prompts']) assert.ok(taskArgs.includes(f), f);
    assert.equal(taskArgs[taskArgs.indexOf('--tools') + 1], 'Read,Write,Edit,Glob,Grep,WebSearch,WebFetch', 'research agents get web tools, never Bash');
    assert.equal(taskArgs[taskArgs.indexOf('--effort') + 1], 'low');
    const plan = t.plans.at(-1);
    assert.deepEqual(plan.windows.map((w) => [w.label, w.used]), [['5-hour window', 29], ['This week', 16]]);
    assert.equal(plan.windows[0].resetsAt, new Date(1795090200 * 1000).toISOString());
  } finally { await t.close(); }
});

test('declining in the town stops the write and tells Claude why', async () => {
  const t = await setup();
  try {
    await post(t.url, '/api/agents/scout/tasks', { title: 'Tidy notes' });
    const ap = await t.until((s) => s.approvals[0]);
    await post(t.url, `/api/approvals/${ap.id}`, { decision: 'no' });
    await t.until((s) => s.log.some((e) => e.type === 'task.finished'));
    assert.ok(!existsSync(path.join(t.workspace.root, 'notes/final.md')));
    const declined = t.fakeEntries().find((e) => e.hook && /notes/.test(e.hook));
    assert.equal(declined.decision, 'deny');
    assert.match(declined.reason, /declined writing notes\/final\.md/);
  } finally { await t.close(); }
});

test('a review asking for changes runs one more round', async () => {
  const t = await setup('review-changes');
  try {
    await post(t.url, '/api/agents/scout/tasks', { title: 'Compare apps', review: true });
    let last = 0;
    for (let i = 0; i < 2; i++) {
      const ap = await t.until((s) => s.approvals.find((a) => a.id > last));
      last = ap.id;
      await post(t.url, `/api/approvals/${ap.id}`, { decision: 'yes' });
    }
    const s = await t.until((st) => st.log.some((e) => e.type === 'task.finished') && st);
    assert.match(s.log.find((e) => e.type === 'review.finished').message, /found 1 issue/);
    assert.match(s.log.find((e) => e.type === 'task.finished').message, /Added the comparison table/);
  } finally { await t.close(); }
});

test('not signed in: the TEST button and the agent both say how to fix it', async () => {
  const t = await setup('not-logged-in');
  try {
    await assert.rejects(t.claudeCode.check(), (e) => e instanceof ClaudeCodeError && /run claude, and sign in/.test(e.message));
    await post(t.url, '/api/agents/scout/tasks', { title: 'Anything' });
    const s = await t.until((st) => st.agents.find((a) => a.ref === 'scout').status === 'FNT' && st);
    assert.match(s.log.at(-1).message, /not signed in/);
  } finally { await t.close(); }
});

test('running out of HP stops Claude Code and faints the agent', async () => {
  const t = await setup('huge');
  try {
    await post(t.url, '/api/agents/scout/tasks', { title: 'Read the internet' });
    await t.until((s) => s.agents.find((a) => a.ref === 'scout').status === 'FNT');
  } finally { await t.close(); }
});

test('a missing claude command gives an install hint', async () => {
  const workspace = await createWorkspace(await mkdtemp(path.join(os.tmpdir(), 'agentdex-cc-')));
  const cc = createClaudeCode({ bin: 'definitely-not-claude-xyz', workspace, url: 'http://127.0.0.1:1' });
  await assert.rejects(cc.check(), /cannot find Claude Code/);
});

test('the hook on its own: drafts allowed, outside and symlink escapes denied, no link denied', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentdex-hook-'));
  const ws = (await createWorkspace(path.join(dir, 'ws'))).root;
  const outside = await mkdtemp(path.join(os.tmpdir(), 'agentdex-out-'));
  await symlink(outside, path.join(ws, 'link'));
  await writeFile(path.join(outside, 'x.txt'), 'x');
  const run = (file, env = { AGENTDEX_URL: 'http://127.0.0.1:1', AGENTDEX_AGENT_ID: '1', AGENTDEX_WORKSPACE: ws }) => {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: ws, tool_name: 'Write', tool_input: { file_path: file } }), env: { PATH: process.env.PATH, ...env } });
    return JSON.parse(r.stdout.toString()).hookSpecificOutput;
  };
  assert.equal(run(path.join(ws, 'drafts/a.md')).permissionDecision, 'allow');
  assert.equal(run('drafts/b.md').permissionDecision, 'allow');
  assert.equal(run(path.join(ws, '../evil.md')).permissionDecision, 'deny');
  assert.equal(run('/etc/passwd').permissionDecision, 'deny');
  assert.equal(run(path.join(ws, 'link/x.txt')).permissionDecision, 'deny');
  assert.match(run(path.join(ws, 'notes/a.md')).permissionDecisionReason, /Could not reach Agentdex/);
  assert.equal(run(path.join(ws, 'drafts/c.md'), {}).permissionDecision, 'deny', 'no Agentdex link, no writes');
});

test('finding Claude Code on Windows: PATH, the native install folder, then npm', () => {
  const home = 'C:\\Users\\Ivan Tong';
  const has = (...files) => (f) => files.includes(f);
  const base = { platform: 'win32', nodePath: 'C:\\node\\node.exe' };

  // On PATH as claude.exe.
  let r = resolveClaude({ ...base, env: { PATH: 'C:\\Tools;C:\\bin', USERPROFILE: home }, exists: has('C:\\bin\\claude.exe') });
  assert.deepEqual(r, { command: 'C:\\bin\\claude.exe', prefix: [] });

  // Just installed with the native installer: not on this window's PATH yet, but in ~/.local/bin.
  r = resolveClaude({ ...base, env: { PATH: 'C:\\Tools', USERPROFILE: home }, exists: has(`${home}\\.local\\bin\\claude.exe`) });
  assert.equal(r.command, `${home}\\.local\\bin\\claude.exe`);

  // Installed with npm (claude.cmd cannot be started directly).
  const npmDir = `${home}\\AppData\\Roaming\\npm`;
  const pkg = `${npmDir}\\node_modules\\@anthropic-ai\\claude-code`;
  const npmEnv = { PATH: `C:\\Tools;${npmDir}`, USERPROFILE: home, APPDATA: `${home}\\AppData\\Roaming` };
  // Current versions (2.1.x): the real program is bin\\claude.exe inside the package.
  r = resolveClaude({ ...base, env: npmEnv, exists: has(`${npmDir}\\claude.cmd`, `${pkg}\\bin\\claude.exe`, `${pkg}\\cli-wrapper.cjs`), size: () => 200_000_000 });
  assert.deepEqual(r, { command: `${pkg}\\bin\\claude.exe`, prefix: [] });
  // npm's install step did not run: bin\\claude.exe is still the tiny placeholder, so use the wrapper.
  r = resolveClaude({ ...base, env: npmEnv, exists: has(`${npmDir}\\claude.cmd`, `${pkg}\\bin\\claude.exe`, `${pkg}\\cli-wrapper.cjs`), size: () => 500 });
  assert.deepEqual(r, { command: 'C:\\node\\node.exe', prefix: [`${pkg}\\cli-wrapper.cjs`] });
  // Older versions shipped cli.js.
  r = resolveClaude({ ...base, env: npmEnv, exists: has(`${npmDir}\\claude.cmd`, `${pkg}\\cli.js`) });
  assert.deepEqual(r, { command: 'C:\\node\\node.exe', prefix: [`${pkg}\\cli.js`] });

  // Nothing found: fall back to plain "claude" (the error then explains what to do).
  r = resolveClaude({ ...base, env: { PATH: 'C:\\Tools', USERPROFILE: home }, exists: () => false });
  assert.deepEqual(r, { command: 'claude', prefix: [] });

  // Mac and Linux, and an explicit AGENTDEX_CLAUDE_BIN, are used as given.
  assert.deepEqual(resolveClaude({ platform: 'darwin' }), { command: 'claude', prefix: [] });
  assert.deepEqual(resolveClaude({ bin: 'D:\\apps\\claude.exe', platform: 'win32' }), { command: 'D:\\apps\\claude.exe', prefix: [] });
});

test('plan usage is read from what Claude Code reports, and odd shapes are ignored', () => {
  const u = planUsageFrom({ status: 'allowed_warning', unifiedWindows: { five_hour: { utilization: 0.912, resetsAt: 1795090200 }, seven_day: { utilization: 1.4 } } });
  assert.equal(u.status, 'allowed_warning');
  assert.deepEqual(u.windows.map((w) => w.used), [91, 100]);
  assert.equal(u.windows[1].resetsAt, null);
  assert.deepEqual(planUsageFrom({ rateLimitType: 'seven_day', utilization: 0.5, status: 'allowed' }).windows.map((w) => w.label), ['This week']);
  assert.equal(planUsageFrom(null), null);
  assert.deepEqual(planUsageFrom({ unifiedWindows: { five_hour: {} } }).windows, []);
});
