import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../store.js';
import { createSimulator } from '../simulator.js';
import { createApp } from '../app.js';
import { seedParty } from '../seed.js';

async function boot({ token = null, sim = true } = {}) {
  const store = createStore();
  const adapter = sim ? createSimulator({ tickMs: 0, random: () => 0.99 }) : null;
  if (sim) seedParty(store);
  const app = createApp({ store, adapter, token });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  adapter?.start(store);
  const base = `http://127.0.0.1:${app.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { store, adapter, app, base, post, close: () => new Promise((r) => app.close(r)) };
}

test('state, approvals and actions over HTTP', async () => {
  const t = await boot();
  try {
    const state = await (await fetch(t.base + '/api/state')).json();
    assert.equal(state.adapter, 'simulator');
    assert.equal(state.agents.length, 6);
    const ap = state.approvals.find((x) => x.tool === 'DEPLOY');
    assert.ok(ap, 'opening scene asks to deploy');

    const r = await t.post(`/api/approvals/${ap.id}`, { decision: 'yes' });
    assert.equal(r.status, 200);
    const rollo = t.store.resolveAgent(ap.agentId);
    assert.equal(rollo.task, null, 'simulator finished the task after YES');
    assert.equal((await t.post(`/api/approvals/${ap.id}`, { decision: 'yes' })).status, 404);

    const pet = await (await t.post(`/api/agents/${rollo.id}/actions`, { action: 'pet' })).json();
    assert.equal(pet.agent.bond, 1);
    assert.equal((await t.post(`/api/agents/${rollo.id}/actions`, { action: 'dance' })).status, 400);

    const spawned = await t.post('/api/agents', { species: 'quillow' });
    assert.equal(spawned.status, 201);
    assert.equal((await t.post('/api/agents', { species: 'quillow' })).status, 409, 'party full');
  } finally { await t.close(); }
});

test('ingest accepts batches from a real runtime and the stream reports them', async () => {
  const t = await boot({ sim: false, token: 's3cret' });
  try {
    assert.equal((await t.post('/api/ingest', { type: 'agent.spawned', data: { species: 'gearbo', ref: 'ops-1' } })).status, 401);

    const ctrl = new AbortController();
    const stream = await fetch(t.base + '/api/events', { signal: ctrl.signal });
    const reader = stream.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const until = async (needle) => { while (!buf.includes(needle)) { const { value } = await reader.read(); buf += dec.decode(value); } };
    await until('event: snapshot');

    const auth = { authorization: 'Bearer s3cret' };
    const res = await t.post('/api/ingest', [
      { type: 'agent.spawned', data: { species: 'gearbo', nick: 'ROLLO', ref: 'ops-1' } },
      { type: 'task.started', agentId: 'ops-1', data: { title: 'Deploy api v2.3' } },
      { type: 'approval.requested', agentId: 'ops-1', data: { tool: 'DEPLOY', target: 'api-prod' } },
    ], auth);
    assert.equal(res.status, 200);
    await until('ROLLO needs you');
    ctrl.abort();

    const bad = await t.post('/api/ingest', { type: 'task.started', agentId: 'nope', data: { title: 'x' } }, auth);
    assert.equal(bad.status, 404);
  } finally { await t.close(); }
});

test('the simulator runs a full task cycle through events only', () => {
  const store = createStore();
  seedParty(store);
  let n = 0;
  const sim = createSimulator({ tickMs: 0, random: () => (n++ % 7) / 7 });
  sim.start(store);
  for (let i = 0; i < 300; i++) sim.tick();
  const types = new Set(store.snapshot().log.map((e) => e.type));
  assert.ok(types.has('task.started'));
  assert.ok(types.has('task.finished'));
});
