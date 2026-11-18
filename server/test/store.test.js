import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, StoreError } from '../store.js';

const spawn = (store, data) => store.apply({ type: 'agent.spawned', data: { silent: true, ...data } });

test('spawning fills the party and refuses a seventh agent', () => {
  const store = createStore();
  for (let i = 0; i < 6; i++) spawn(store, { species: 'fennook' });
  assert.throws(() => spawn(store, { species: 'fennook' }), (e) => e instanceof StoreError && e.status === 409);
  spawn(store, { species: 'fennook', boxed: true });
  assert.equal(store.party().length, 6);
  assert.equal(store.agents.size, 7);
});

test('unknown event types and species are rejected', () => {
  const store = createStore();
  assert.throws(() => store.apply({ type: 'agent.teleported' }), /Unknown event type/);
  assert.throws(() => spawn(store, { species: 'pikachu' }), /Unknown species/);
});

test('agents can be addressed by external ref', () => {
  const store = createStore();
  spawn(store, { species: 'gearbo', ref: 'runtime-42' });
  const e = store.apply({ type: 'task.started', agentId: 'runtime-42', data: { title: 'Check error budget' } });
  assert.equal(store.resolveAgent(e.agentId).task.title, 'Check error budget');
  assert.throws(() => spawn(store, { species: 'gearbo', ref: 'runtime-42' }), /already exists/);
});

test('tool approval paralyzes the agent until resolved', () => {
  const store = createStore();
  const { agentId } = spawn(store, { species: 'gearbo', nick: 'ROLLO' });
  store.apply({ type: 'task.started', agentId, data: { title: 'Deploy api v2.3', approval: { tool: 'DEPLOY', target: 'api-prod' } } });
  const req = store.apply({ type: 'approval.requested', agentId, data: {} });
  assert.equal(store.resolveAgent(agentId).status, 'PAR');
  assert.equal(req.tone, 'need');
  assert.match(req.message, /ROLLO needs you: it wants to use DEPLOY on api-prod/);

  assert.throws(() => store.apply({ type: 'approval.resolved', agentId, data: { approvalId: req.data.approvalId, decision: 'maybe' } }), /decision/);
  store.apply({ type: 'approval.resolved', agentId, data: { approvalId: req.data.approvalId, decision: 'yes' } });
  const a = store.resolveAgent(agentId);
  assert.equal(a.status, 'OK');
  assert.equal(store.approvals.size, 0);
  assert.equal(a.moves.find((m) => m.n === 'DEPLOY').pp, 4);
});

test('running out of tokens faints the agent', () => {
  const store = createStore();
  const { agentId } = spawn(store, { species: 'chromoth', hp: 10 });
  store.apply({ type: 'task.started', agentId, data: { title: 'Redesign settings screen' } });
  const e = store.apply({ type: 'task.progress', agentId, data: { tokens: 25, tool: 'SKETCH' } });
  const a = store.resolveAgent(agentId);
  assert.equal(a.hp, 0);
  assert.equal(a.status, 'FNT');
  assert.equal(e.tone, 'bad');
  store.apply({ type: 'agent.reset', agentId });
  assert.equal(store.resolveAgent(agentId).hp, a.hpMax);
  assert.equal(store.resolveAgent(agentId).status, 'SLP');
});

test('levelling past the threshold asks to evolve, and yes changes species', () => {
  const store = createStore();
  const { agentId } = spawn(store, { species: 'bytle', lv: 12, xp: 470 });
  store.apply({ type: 'task.started', agentId, data: { title: 'Fix flaky checkout test' } });
  store.apply({ type: 'task.finished', agentId, data: { xp: 60 } });
  const a = store.resolveAgent(agentId);
  assert.equal(a.lv, 13);
  const [ap] = store.approvals.values();
  assert.equal(ap.kind, 'evolve');
  store.apply({ type: 'approval.resolved', agentId, data: { approvalId: ap.id, decision: 'yes' } });
  assert.equal(store.resolveAgent(agentId).species, 'bytlord');
  // It never asks twice.
  store.apply({ type: 'task.started', agentId, data: { title: 'Another' } });
  store.apply({ type: 'task.finished', agentId, data: { xp: 600 } });
  assert.equal(store.approvals.size, 0);
});

test('review frees the reviewer and changes send the work back', () => {
  const store = createStore();
  const { agentId } = spawn(store, { species: 'bytle', nick: 'PATCH' });
  const { agentId: rid } = spawn(store, { species: 'sentril', nick: 'CHECKS' });
  store.apply({ type: 'task.started', agentId, data: { title: 'Refactor auth', review: true } });
  store.apply({ type: 'review.started', agentId, data: { reviewerId: rid } });
  assert.equal(store.resolveAgent(rid).reviewingId, agentId);
  const e = store.apply({ type: 'review.finished', agentId, data: { reviewerId: rid, result: 'changes', issues: 2 } });
  assert.match(e.message, /CHECKS found 2 issues/);
  assert.equal(store.resolveAgent(rid).reviewingId, null);
  assert.equal(store.resolveAgent(agentId).task.review, false);
});

test('boxing an agent drops its approvals and frees a slot', () => {
  const store = createStore();
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(spawn(store, { species: 'fennook' }).agentId);
  store.apply({ type: 'approval.requested', agentId: ids[0], data: { tool: 'FETCH', target: 'reports' } });
  store.apply({ type: 'agent.boxed', agentId: ids[0] });
  assert.equal(store.approvals.size, 0);
  spawn(store, { species: 'quillow' });
  assert.throws(() => store.apply({ type: 'agent.unboxed', agentId: ids[0] }), /Party is full/);
});

test('subscribers get the event, touched agents and open approvals', () => {
  const store = createStore();
  const seen = [];
  store.subscribe((p) => seen.push(p));
  const { agentId } = spawn(store, { species: 'gearbo' });
  store.apply({ type: 'approval.requested', agentId, data: { tool: 'DEPLOY', target: 'api-prod' } });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].agents[0].status, 'PAR');
  assert.equal(seen[1].approvals.length, 1);
});
