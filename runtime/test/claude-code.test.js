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
import { createClaudeCode, ClaudeCodeError } from '../claude-code.js';

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
  const claudeCode = createClaudeCode({ workspace, url, spawnImpl });
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
  return { store, dex, url, workspace, claudeCode, until, fakeEntries, close };
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
  await assert.rejects(cc.check(), /not installed/);
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
