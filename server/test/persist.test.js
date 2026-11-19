import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../store.js';
import { createPersistence } from '../persist.js';

const tmp = async () => path.join(await mkdtemp(path.join(os.tmpdir(), 'agentdex-save-')), 'agentdex.state.json');

test('closing and reopening keeps names, levels, bond, chats and the log', async () => {
  const file = await tmp();
  const a = createStore();
  const save = createPersistence({ store: a, path: file, delayMs: 10 });
  save.load();
  a.apply({ type: 'agent.spawned', data: { species: 'fennook', nick: 'SCOUT', ref: 'scout' } });
  a.apply({ type: 'agent.spawned', data: { species: 'bytle', nick: 'PATCH', ref: 'patch' } });
  a.apply({ type: 'agent.renamed', agentId: 'scout', data: { nick: 'max' } });
  a.apply({ type: 'agent.interacted', agentId: 'scout', data: { action: 'pet', message: 'MAX nuzzled your hand.' } });
  a.apply({ type: 'task.started', agentId: 'patch', data: { title: 'Fix flaky test' } });
  a.apply({ type: 'task.finished', agentId: 'patch', data: { xp: 60 } });
  a.apply({ type: 'chat.sent', agentId: 'scout', data: { text: 'hi there' } });
  a.apply({ type: 'chat.replied', agentId: 'scout', data: { text: 'Hello!' } });
  a.apply({ type: 'task.started', agentId: 'scout', data: { title: 'Compare 3 note apps' } });
  a.apply({ type: 'approval.requested', agentId: 'scout', data: { tool: 'WRITE', target: 'notes/a.md' } });
  save.stop(); // what Ctrl+C or closing the window does

  const b = createStore();
  const restored = createPersistence({ store: b, path: file }).load();
  assert.equal(restored.loaded, true);
  const max = b.resolveAgent('scout');
  assert.equal(max.nick, 'MAX');
  assert.equal(max.bond, 1);
  const patch = b.resolveAgent('patch');
  assert.equal(patch.xp, 60);
  assert.deepEqual(b.snapshot().chats[max.id].map((e) => e.text), ['hi there', 'Hello!']);

  // The interrupted task cannot continue: the agent is free, its request is gone, and the log says so.
  assert.equal(max.task, null);
  assert.equal(max.status, 'SLP');
  assert.equal(b.approvals.size, 0);
  assert.deepEqual(restored.interrupted, [{ nick: 'MAX', title: 'Compare 3 note apps' }]);
  const log = b.snapshot().log.map((e) => e.message);
  assert.ok(log.some((m) => /SCOUT is now called MAX/.test(m)), 'old log lines are kept');
  assert.ok(log.some((m) => /Welcome back/.test(m)));
  assert.ok(log.some((m) => /MAX was working on "Compare 3 note apps"/.test(m)));

  // New things carry on from where the save left off.
  const e = b.apply({ type: 'agent.spawned', data: { species: 'quillow', nick: 'QUILL' } });
  assert.ok(e.agentId > patch.id);
  assert.ok(e.id > Math.max(...b.snapshot().log.slice(0, -1).map((x) => x.id)));
  const c = b.apply({ type: 'chat.sent', agentId: e.agentId, data: { text: 'yo' } });
  assert.ok(c.data.entry.id > 2);
});

test('a damaged save is kept aside and the town starts fresh', async () => {
  const file = await tmp();
  await writeFile(file, '{ not json');
  const logs = [];
  const r = createPersistence({ store: createStore(), path: file, log: (m) => logs.push(m) }).load();
  assert.equal(r.loaded, false);
  const files = await readdir(path.dirname(file));
  assert.ok(files.some((f) => f.startsWith('agentdex.state.json.broken-')), 'the old file is kept, not deleted');
  assert.match(logs[0], /started fresh/);
});

test('saves only after something changed, and the file is private', async () => {
  const file = await tmp();
  const store = createStore();
  const p = createPersistence({ store, path: file, delayMs: 10 });
  p.load();
  p.flush();
  assert.equal((await readdir(path.dirname(file))).length, 0, 'nothing to save yet');
  store.apply({ type: 'agent.spawned', data: { species: 'gearbo', nick: 'ROLLO' } });
  await new Promise((r) => setTimeout(r, 50));
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.agents[0].nick, 'ROLLO');
  if (process.platform !== 'win32') {
    const { statSync } = await import('node:fs');
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
  p.stop();
});
