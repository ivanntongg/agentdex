// End to end without spending money: a local stand-in for the Claude API, the real Agentdex
// server, the real runtime and a temporary workspace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { createStore } from '../../server/store.js';
import { createApp } from '../../server/app.js';
import { createAgentdexClient } from '../agentdex.js';
import { createWorkspace } from '../workspace.js';
import { createRuntime } from '../runtime.js';

// script(body, n) returns { content, stop_reason } for the n-th request.
async function mockClaude(script) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const json = JSON.parse(body);
    requests.push({ url: req.url, headers: req.headers, body: json });
    const out = script(json, requests.length - 1);
    if (out.status) { res.writeHead(out.status, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })); }
    const inputSize = JSON.stringify(json.messages).length;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: json.model,
      content: out.content, stop_reason: out.stop_reason, stop_sequence: null,
      usage: { input_tokens: 2000 + inputSize, output_tokens: 300 },
    }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r)) };
}

const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const text = (t) => ({ type: 'text', text: t });
const isReview = (body) => Boolean(body.output_config?.format);
const lastToolResult = (body) => {
  const last = body.messages.at(-1);
  return Array.isArray(last.content) ? last.content.find((b) => b.type === 'tool_result') : null;
};

async function setup(script) {
  const claude = await mockClaude(script);
  const store = createStore();
  const app = createApp({ store });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.address().port}`;
  const dex = createAgentdexClient({ url });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentdex-ws-'));
  const workspace = await createWorkspace(dir);
  const logs = [];
  const runtime = createRuntime({ anthropic: new Anthropic({ apiKey: 'test', baseURL: claude.url, maxRetries: 0 }), dex, workspace, log: (m) => logs.push(m) });
  const ctl = new AbortController();
  dex.subscribe({ onSnapshot: runtime.onSnapshot, onChange: runtime.onChange, signal: ctl.signal });
  await dex.post('/api/ingest', [
    { type: 'agent.spawned', data: { species: 'bytle', nick: 'PATCH', ref: 'patch' } },
    { type: 'agent.spawned', data: { species: 'sentril', nick: 'CHECKS', ref: 'checks' } },
  ]);
  const until = async (fn, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const s = await dex.state(); const v = fn(s); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
    throw new Error('timed out waiting');
  };
  await until((s) => runtime.agents.size === 2 && s);
  const close = async () => { ctl.abort(); await new Promise((r) => app.close(r)); await claude.close(); };
  return { claude, store, dex, dir, workspace, runtime, url, until, logs, close };
}

const post = (url, p, body) => fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

test('a real task: free draft, gated write approved, review, finish', async () => {
  const t = await setup((body) => {
    if (isReview(body)) return { content: [text(JSON.stringify({ verdict: 'approved', issues: [], summary: 'Looks right.' }))], stop_reason: 'end_turn' };
    const turn = body.messages.filter((m) => m.role === 'assistant').length;
    if (turn === 0) return { content: [text('Drafting first.'), toolUse('t1', 'write_file', { path: 'drafts/plan.md', content: '# Plan\n' })], stop_reason: 'tool_use' };
    if (turn === 1) return { content: [toolUse('t2', 'write_file', { path: 'README.md', content: '# Project\n' })], stop_reason: 'tool_use' };
    return { content: [text('Wrote a plan in drafts/plan.md and a README.')], stop_reason: 'end_turn' };
  });
  try {
    await post(t.url, '/api/agents/patch/tasks', { title: 'Write a README', review: true });
    const ap = await t.until((s) => s.approvals[0]);
    assert.equal(ap.tool, 'WRITE');
    assert.equal(ap.target, 'README.md');
    assert.ok(existsSync(path.join(t.dir, 'drafts/plan.md')), 'drafts/ is written without asking');
    assert.ok(!existsSync(path.join(t.dir, 'README.md')), 'nothing outside drafts/ before approval');

    await post(t.url, `/api/approvals/${ap.id}`, { decision: 'yes' });
    const s = await t.until((st) => st.log.some((e) => e.type === 'task.finished') && st);
    assert.equal(await readFile(path.join(t.dir, 'README.md'), 'utf8'), '# Project\n');
    const types = s.log.map((e) => e.type);
    for (const ty of ['task.assigned', 'task.started', 'approval.requested', 'approval.resolved', 'review.started', 'review.finished', 'task.finished']) assert.ok(types.includes(ty), ty);
    assert.match(s.log.find((e) => e.type === 'task.finished').message, /Wrote a plan/);
    const patch = s.agents.find((a) => a.ref === 'patch');
    assert.ok(patch.hp < patch.hpMax, 'HP went down with context');
    assert.equal(patch.status, 'SLP');

    const first = t.claude.requests[0];
    assert.equal(first.body.model, 'claude-opus-5-5');
    assert.equal(first.body.fallbacks, 'default');
    assert.match(first.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
    assert.equal(first.body.tools.find((x) => x.name === 'write_file').strict, true);
  } finally { await t.close(); }
});

test('declining a write tells the agent and leaves the file alone', async () => {
  let declinedText = null;
  const t = await setup((body) => {
    const turn = body.messages.filter((m) => m.role === 'assistant').length;
    if (turn === 0) return { content: [toolUse('t1', 'write_file', { path: 'config.json', content: '{}' })], stop_reason: 'tool_use' };
    declinedText = lastToolResult(body);
    return { content: [text('Left config.json alone.')], stop_reason: 'end_turn' };
  });
  try {
    await post(t.url, '/api/agents/patch/tasks', { title: 'Tidy config' });
    const ap = await t.until((s) => s.approvals[0]);
    await post(t.url, `/api/approvals/${ap.id}`, { decision: 'no' });
    await t.until((s) => s.log.some((e) => e.type === 'task.finished'));
    assert.ok(!existsSync(path.join(t.dir, 'config.json')));
    assert.equal(declinedText.is_error, true);
    assert.match(declinedText.content, /declined/);
  } finally { await t.close(); }
});

test('review asking for changes sends the agent back for one more round', async () => {
  let reviews = 0;
  const t = await setup((body) => {
    if (isReview(body)) {
      reviews++;
      return { content: [text(JSON.stringify({ verdict: 'changes', issues: ['The README has no install steps.'], summary: '' }))], stop_reason: 'end_turn' };
    }
    const last = body.messages.at(-1);
    if (typeof last.content === 'string' && last.content.includes('asked for changes')) return { content: [text('Added install steps.')], stop_reason: 'end_turn' };
    return { content: [text('Drafted it.')], stop_reason: 'end_turn' };
  });
  try {
    await post(t.url, '/api/agents/patch/tasks', { title: 'Write docs', review: true });
    const s = await t.until((st) => st.log.some((e) => e.type === 'task.finished') && st);
    assert.equal(reviews, 1, 'only one review round');
    assert.match(s.log.find((e) => e.type === 'review.finished').message, /found 1 issue/);
    assert.match(s.log.find((e) => e.type === 'task.finished').message, /Added install steps/);
  } finally { await t.close(); }
});

test('a bad API key faints the agent with a reason you can act on', async () => {
  const t = await setup(() => ({ status: 401 }));
  try {
    await post(t.url, '/api/agents/patch/tasks', { title: 'Anything' });
    const s = await t.until((st) => st.agents.find((a) => a.ref === 'patch').status === 'FNT' && st);
    assert.match(s.log.at(-1).message, /rejected the key/);
  } finally { await t.close(); }
});

test('reviewers refuse direct tasks', async () => {
  const t = await setup(() => ({ content: [text('x')], stop_reason: 'end_turn' }));
  try {
    await post(t.url, '/api/agents/checks/tasks', { title: 'Build a thing' });
    await t.until((s) => s.log.some((e) => /only reviews/.test(e.message || '')));
    assert.equal(t.claude.requests.length, 0);
  } finally { await t.close(); }
});

test('the workspace refuses paths that escape it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentdex-ws-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'agentdex-out-'));
  await writeFile(path.join(outside, 'secret.txt'), 'nope');
  await symlink(outside, path.join(dir, 'link'));
  const ws = await createWorkspace(dir);
  await assert.rejects(ws.tools.read_file({ path: '../etc/passwd' }), /outside the workspace/);
  await assert.rejects(ws.tools.read_file({ path: '/etc/passwd' }), /outside the workspace/);
  await assert.rejects(ws.tools.read_file({ path: 'link/secret.txt' }), /points outside/);
  await assert.rejects(ws.tools.write_file({ path: 'link/new.txt', content: 'x' }), /points outside/);
  assert.equal(await ws.needsApproval('drafts/a.md'), false);
  assert.equal(await ws.needsApproval('drafts'), false);
  assert.equal(await ws.needsApproval('draftsy/a.md'), true);
  assert.equal(await ws.needsApproval('src/a.js'), true);
});
