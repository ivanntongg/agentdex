import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../store.js';
import { createApp, safeName } from '../app.js';

async function boot({ workspace = true } = {}) {
  const store = createStore();
  store.apply({ type: 'agent.spawned', data: { species: 'fennook', nick: 'SCOUT', ref: 'scout', silent: true } });
  const root = workspace ? await mkdtemp(path.join(os.tmpdir(), 'agentdex-ws-')) : null;
  const app = createApp({ store, workspaceRoot: root });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const upload = (name, body) => fetch(`${base}/api/files?name=${encodeURIComponent(name)}`, { method: 'POST', body }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
  return { store, root, upload, post, close: () => new Promise((r) => app.close(r)) };
}

test('file names are made safe: no folders, no hidden files, no odd characters', () => {
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('C:\\Users\\me\\report final.pdf'), 'report final.pdf');
  assert.equal(safeName('.env'), 'env');
  assert.equal(safeName('notes<>|?.md'), 'notes____.md');
  assert.equal(safeName('Lagu Rakyat — ç.txt'), 'Lagu Rakyat _ ç.txt');
  assert.equal(safeName(''), 'file');
});

test('uploads land in the inbox, never overwrite, and are announced', async () => {
  const t = await boot();
  try {
    let r = await t.upload('../brief.md', '# Brief\nMake it short.');
    assert.equal(r.status, 201);
    assert.equal(r.path, 'inbox/brief.md');
    r = await t.upload('brief.md', 'second');
    assert.equal(r.path, 'inbox/brief (2).md');
    assert.equal(await readFile(path.join(t.root, 'inbox', 'brief.md'), 'utf8'), '# Brief\nMake it short.');
    assert.deepEqual((await readdir(t.root)).sort(), ['inbox'], 'nothing written outside the inbox');
    assert.match(t.store.snapshot().log.at(-1).message, /You added inbox\/brief \(2\)\.md/);
  } finally { await t.close(); }
});

test('attached files are named in the task and the chat', async () => {
  const t = await boot();
  try {
    await t.post('/api/command', { text: 'scout summarise the brief', files: ['inbox/brief.md', '../secret.txt'] });
    const task = t.store.snapshot().log.find((e) => e.type === 'task.assigned');
    assert.match(task.data.details, /Use these files the user added: inbox\/brief\.md$/, 'only inbox files are passed on');
    t.store.apply({ type: 'task.started', agentId: 'scout', data: { title: 'x' } });
    t.store.apply({ type: 'task.finished', agentId: 'scout', data: { note: 'Done.', files: ['notes/summary.md'] } });
    await t.post('/api/command', { text: '@scout what does it say?', files: ['inbox/brief.md'] });
    const chat = t.store.snapshot().log.find((e) => e.type === 'chat.sent');
    assert.match(chat.data.entry.text, /what does it say\?\n\n\(Files I added: inbox\/brief\.md\)/);
  } finally { await t.close(); }
});

test('without real agents, uploads are refused with a clear reason', async () => {
  const t = await boot({ workspace: false });
  try {
    const r = await t.upload('a.txt', 'x');
    assert.equal(r.status, 404);
    assert.match(r.error, /real agents/);
  } finally { await t.close(); }
});

test('agents remember finished work, with the files they made', () => {
  const store = createStore();
  store.apply({ type: 'agent.spawned', data: { species: 'bytle', nick: 'PATCH', ref: 'patch', silent: true } });
  for (let i = 1; i <= 23; i++) {
    store.apply({ type: 'task.started', agentId: 'patch', data: { title: `Task ${i}` } });
    store.apply({ type: 'task.finished', agentId: 'patch', data: { note: `Did ${i}.`, files: [`notes/${i}.md`] } });
  }
  store.apply({ type: 'task.started', agentId: 'patch', data: { title: 'Declined one' } });
  store.apply({ type: 'task.finished', agentId: 'patch', data: { outcome: 'declined' } });
  const mem = store.resolveAgent('patch').memory;
  assert.equal(mem.length, 20, 'keeps the last 20');
  assert.deepEqual(mem.at(-1), { ...mem.at(-1), title: 'Task 23', note: 'Did 23.', files: ['notes/23.md'] });
  assert.equal(mem[0].title, 'Task 4');
});
