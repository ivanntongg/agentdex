import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../store.js';
import { createApp } from '../app.js';
import { SPECIES } from '../species.js';
import { loadRoles, roleFor, ROLE_DEFAULTS, applyRoleEvent } from '../roles.js';
import { guessCustomRole, createCommands } from '../commands.js';
import { systemPrompt, chatPrompt, usesWeb, reviewerSystem, REVIEWER_SYSTEM } from '../../runtime/roles.js';

const VIDEO = { name: 'Video editor', job: 'You plan videos: scripts, shot lists, captions as .srt files and chapters. You cannot cut video yourself.', web: true, home: 'WORKSHOP', look: { base: 'chromoth', hue: 200 } };
beforeEach(() => loadRoles({})); // the role registry is shared; start every test clean

test('a custom role becomes a new kind of agent you can spawn, and survives a restart', () => {
  const s = createStore();
  const ev = s.apply({ type: 'role.saved', data: { role: VIDEO } });
  assert.equal(ev.data.role.id, 'c-video-editor');
  assert.equal(ev.message, 'New role: Video editor. Spawn one from the Dex.');
  const sp = SPECIES['c-video-editor'];
  assert.deepEqual([sp.name, sp.title, sp.types[0], sp.home, sp.web, sp.look.base], ['VIDEO EDITOR', 'Video editor', 'VIDEO', 'WORKSHOP', true, 'chromoth']);
  const v1 = s.apply({ type: 'agent.spawned', data: { species: 'c-video-editor' } });
  const v2 = s.apply({ type: 'agent.spawned', data: { species: 'c-video-editor' } });
  assert.deepEqual([s.resolveAgent(v1.agentId).nick, s.resolveAgent(v2.agentId).nick], ['VIDEO', 'VIDEO-2'], 'named so @video works');
  assert.match(v1.message, /VIDEO the Video editor appeared/);
  s.apply({ type: 'agent.boxed', agentId: v1.agentId }); s.apply({ type: 'agent.boxed', agentId: v2.agentId });
  const a = s.apply({ type: 'agent.spawned', data: { species: 'c-video-editor', nick: 'REEL' } });
  assert.equal(s.resolveAgent(a.agentId).moves.find((m) => m.n === 'SEARCH').pp, 20);
  assert.equal(s.snapshot().roles.custom[0].title, 'Video editor');
  assert.ok(s.snapshot().roles.defaults.CODE.job);

  const saved = JSON.parse(JSON.stringify(s.serialize()));
  loadRoles({}); // a fresh process knows nothing
  const b = createStore();
  b.restore(saved);
  const back = [...b.agents.values()].find((x) => x.nick === 'REEL');
  assert.equal(back.species, 'c-video-editor', 'the agent came back with its custom role');
  assert.equal(SPECIES['c-video-editor'].job, VIDEO.job);
});

test('roles are checked: a clear name, a real job, no clashes', () => {
  const s = createStore();
  assert.throws(() => s.apply({ type: 'role.saved', data: { role: { ...VIDEO, job: 'edit stuff' } } }), /Describe the job/);
  assert.throws(() => s.apply({ type: 'role.saved', data: { role: { ...VIDEO, name: '!' } } }), /name of 2 to 24 letters/);
  assert.throws(() => s.apply({ type: 'role.saved', data: { role: { ...VIDEO, name: 'Bytle' } } }), /already a kind of agent called BYTLE/);
  s.apply({ type: 'role.saved', data: { role: VIDEO } });
  assert.throws(() => s.apply({ type: 'role.saved', data: { role: VIDEO } }), /already exists/);
});

test('editing keeps the id; a role in use cannot be deleted, an unused one can', () => {
  const s = createStore();
  s.apply({ type: 'role.saved', data: { role: VIDEO } });
  const up = s.apply({ type: 'role.saved', data: { role: { ...VIDEO, id: 'c-video-editor', name: 'Video producer', web: false } } });
  assert.equal(up.data.role.id, 'c-video-editor');
  assert.equal(SPECIES['c-video-editor'].title, 'Video producer');
  assert.equal(SPECIES['c-video-editor'].web, false);
  s.apply({ type: 'agent.spawned', data: { species: 'c-video-editor', nick: 'REEL' } });
  assert.throws(() => s.apply({ type: 'role.deleted', data: { id: 'c-video-editor' } }), /REEL is Video producer\. A role cannot be deleted while agents have it/);
  s.apply({ type: 'role.saved', data: { role: { ...VIDEO, name: 'Tutor' } } });
  s.apply({ type: 'role.deleted', data: { id: 'c-tutor' } });
  assert.equal(SPECIES['c-tutor'], undefined);
  assert.throws(() => s.apply({ type: 'role.deleted', data: { id: 'bytle' } }), /no longer exists/, 'built-in creatures cannot be deleted');
});

test('built-in roles can be rewritten, switched off the web, and reset', () => {
  const s = createStore();
  s.apply({ type: 'role.saved', data: { type: 'RESEARCH', job: 'You research for a YouTube gaming channel. Always give three sources per claim.', web: false } });
  assert.match(systemPrompt(SPECIES.fennook, 'SCOUT'), /YouTube gaming channel/);
  assert.equal(usesWeb(SPECIES.fennook), false);
  assert.equal(usesWeb(SPECIES.quillow), true, 'QUILL still writes with the web (its WRITE role)');
  assert.deepEqual(s.snapshot().roles.edits.RESEARCH.web, false);
  s.apply({ type: 'role.deleted', data: { type: 'RESEARCH' } });
  assert.equal(roleFor(SPECIES.fennook).job, ROLE_DEFAULTS.RESEARCH.job);
  assert.equal(usesWeb(SPECIES.fennook), true);

  assert.equal(reviewerSystem(), REVIEWER_SYSTEM);
  s.apply({ type: 'role.saved', data: { type: 'QA', job: 'Always check that every claim has a link to a source.' } });
  assert.match(reviewerSystem(), /The user's own review rules, which come first:\nAlways check that every claim has a link/);
  assert.throws(() => s.apply({ type: 'role.saved', data: { type: 'NOPE', job: 'x'.repeat(30) } }), /no built-in role NOPE/);
});

test('custom agents get their own job in prompts, and jobs that mention the role go to them', async () => {
  const s = createStore();
  s.apply({ type: 'role.saved', data: { role: VIDEO } });
  s.apply({ type: 'agent.spawned', data: { species: 'quillow', nick: 'QUILL' } });
  const reel = s.apply({ type: 'agent.spawned', data: { species: 'c-video-editor', nick: 'REEL' } }).agentId;
  assert.match(systemPrompt(SPECIES['c-video-editor'], 'REEL'), /^Your name is REEL\. You are the team's Video editor\. You plan videos/);
  assert.match(chatPrompt(SPECIES['c-video-editor'], 'REEL'), /team's Video editor/);
  assert.equal(guessCustomRole('make captions for my video', s.party()).title, 'Video editor');
  assert.equal(guessCustomRole('write 5 blog titles', s.party()), null);
  const assigned = [];
  const cmd = createCommands({ store: s, actions: { assign: async (a, title) => { assigned.push([a.nick, title]); return {}; } } });
  const r = await cmd.run('make captions for my video');
  assert.deepEqual(assigned[0], ['REEL', 'make captions for my video']);
  assert.match(r.reply, /Sent to REEL \(video editor job\)/);
  assert.equal(r.agentId, reel);
});

test('a runtime in another process follows role events', () => {
  applyRoleEvent({ type: 'role.saved', data: { role: { id: 'c-tutor', name: 'Tutor', job: 'You explain topics simply, with one example each.', web: false, home: 'LAB', look: { base: 'quillow', hue: 90 } } } });
  assert.equal(SPECIES['c-tutor'].title, 'Tutor');
  applyRoleEvent({ type: 'role.deleted', data: { id: 'c-tutor' } });
  assert.equal(SPECIES['c-tutor'], undefined);
});

test('the roles API saves, explains mistakes and deletes', async () => {
  const store = createStore();
  const app = createApp({ store });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.address().port}`;
  const post = (p, body) => fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const ok = await post('/api/roles', { role: VIDEO });
    assert.equal(ok.status, 200);
    const bad = await post('/api/roles', { role: { ...VIDEO, name: 'Tutor', job: 'short' } });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /Describe the job/);
    assert.equal((await post('/api/roles', { type: 'CODE', job: 'You write small Python scripts and explain each line.', web: false })).status, 200);
    assert.equal((await post('/api/roles/delete', { type: 'CODE' })).status, 200);
    assert.equal((await post('/api/roles/delete', { id: 'c-video-editor' })).status, 200);
    const state = await (await fetch(url + '/api/state')).json();
    assert.deepEqual(state.roles.custom, []);
  } finally { await new Promise((r) => app.close(r)); }
});
