import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../store.js';
import { createApp } from '../app.js';
import { guessSkill, pickAgent } from '../commands.js';
import { createSimulator } from '../simulator.js';

async function boot() {
  const store = createStore();
  for (const [species, nick] of [['bytle', 'PATCH'], ['fennook', 'SCOUT'], ['quillow', 'QUILL'], ['sentril', 'CHECKS']]) {
    store.apply({ type: 'agent.spawned', data: { species, nick, ref: nick.toLowerCase(), silent: true } });
  }
  const app = createApp({ store });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const say = (text) => post('/api/command', { text });
  const assigned = () => store.snapshot().log.filter((e) => e.type === 'task.assigned');
  return { store, post, say, assigned, close: () => new Promise((r) => app.close(r)) };
}

test('guessing the kind of job from plain words', () => {
  assert.equal(guessSkill('Compare 3 note-taking apps for a student'), 'RESEARCH');
  assert.equal(guessSkill('write 5 YouTube titles for my GTA 6 map video'), 'WRITE');
  assert.equal(guessSkill('fix the bug in my python script'), 'CODE');
  assert.equal(guessSkill('design a thumbnail'), 'DESIGN');
  assert.equal(guessSkill('hello there'), null);
});

test('picking an agent: right skill, then free, then healthier', () => {
  const party = [
    { species: 'fennook', nick: 'A', phase: 'work', status: 'OK', hp: 100, hpMax: 200 },
    { species: 'fennook', nick: 'B', phase: 'idle', status: 'SLP', hp: 50, hpMax: 200 },
    { species: 'quillow', nick: 'Q', phase: 'idle', status: 'SLP', hp: 200, hpMax: 200 },
    { species: 'sentril', nick: 'C', phase: 'idle', status: 'SLP', hp: 200, hpMax: 200 },
    { species: 'bytle', nick: 'F', phase: 'idle', status: 'FNT', hp: 0, hpMax: 200 },
  ];
  assert.equal(pickAgent(party, 'RESEARCH').nick, 'B');
  assert.equal(pickAgent(party, 'WRITE').nick, 'Q');
  assert.equal(pickAgent(party, 'CODE').nick, 'Q', 'no free coder: falls back to a free worker, never the reviewer or a fainted agent');
  assert.equal(pickAgent([party[3]], 'RESEARCH'), null);
});

test('the command bar routes jobs, by name or by kind', async () => {
  const t = await boot();
  try {
    let r = await t.say('compare 3 note-taking apps');
    assert.match(r.reply, /Sent to SCOUT \(research job\)\. The reviewer will check it\./);
    assert.equal(t.assigned().at(-1).data.review, true);
    r = await t.say('Quill: write 5 video titles');
    assert.match(r.reply, /QUILL is on it/);
    assert.equal(t.assigned().at(-1).data.title, 'write 5 video titles');
    r = await t.say('checks look at this');
    assert.match(r.reply, /only reviews/);
    r = await t.say('patch');
    assert.match(r.reply, /What should PATCH do/);
    r = await t.say('   ');
    assert.match(r.reply, /Type what you want done/);
    assert.match((await t.say('status')).reply, /Party \(4\)/);
    assert.match((await t.say('help')).reply, /rename scout to max/);
  } finally { await t.close(); }
});

test('yes and no answer the only open request', async () => {
  const t = await boot();
  try {
    assert.match((await t.say('yes')).reply, /Nothing is waiting/);
    t.store.apply({ type: 'task.started', agentId: 'scout', data: { title: 'x' } });
    t.store.apply({ type: 'approval.requested', agentId: 'scout', data: { tool: 'WRITE', target: 'a.md' } });
    assert.match((await t.say('YES')).reply, /You allowed WRITE/);
    assert.equal(t.store.approvals.size, 0);
  } finally { await t.close(); }
});

test('renaming, from the summary or the command bar', async () => {
  const t = await boot();
  try {
    let r = await t.post('/api/agents/scout/actions', { action: 'rename', nick: 'max' });
    assert.equal(r.status, 200);
    assert.equal(r.agent.nick, 'MAX');
    assert.match(t.store.snapshot().log.at(-1).message, /SCOUT is now called MAX/);
    assert.match((await t.say('max compare 2 apps')).reply, /MAX is on it/, 'the new name works as a command');

    r = await t.post('/api/agents/quill/actions', { action: 'rename', nick: 'max' });
    assert.equal(r.status, 409);
    r = await t.post('/api/agents/quill/actions', { action: 'rename', nick: 'two words' });
    assert.equal(r.status, 400);

    assert.match((await t.say('rename quill to Ink')).reply, /QUILL is now called INK/);
    assert.match((await t.say('rename ink patch')).reply, /already called PATCH/);
    assert.match((await t.say('rename nobody to x1')).reply, /No agent called nobody/);
  } finally { await t.close(); }
});

test('talking: @mentions start a chat, not a task, with clear limits', async () => {
  const t = await boot();
  try {
    const r = await t.say('@scout how is the research going?');
    assert.match(r.reply, /SCOUT is thinking about it/);
    assert.equal(r.chat, true);
    assert.equal(t.assigned().length, 0, 'talking never creates a task');
    const sent = t.store.snapshot().log.find((e) => e.type === 'chat.sent');
    assert.equal(sent.data.entry.text, 'how is the research going?');
    assert.equal(t.store.resolveAgent('scout').chatting, true);
    assert.match((await t.say('@scout hello?')).reply, /still answering/);
    t.store.apply({ type: 'chat.replied', agentId: 'scout', data: { text: 'Halfway there.', suggestedTask: 'Finish the comparison' } });
    const scout = t.store.resolveAgent('scout');
    assert.equal(scout.chatting, false);
    const thread = t.store.snapshot().chats[scout.id];
    assert.deepEqual(thread.map((e) => [e.from, e.text]), [['you', 'how is the research going?'], ['agent', 'Halfway there.']]);
    assert.equal(thread[1].suggestedTask, 'Finish the comparison');
    assert.match((await t.say('@nobody hi')).reply, /No agent called nobody/);
    assert.match((await t.say('@quill')).reply, /What do you want to say to QUILL/);
    const direct = await t.post('/api/agents/quill/chat', { text: '' });
    assert.equal(direct.status, 400);
  } finally { await t.close(); }
});

test('practice agents answer chats too, and spot a job in what you said', () => {
  const store = createStore();
  store.apply({ type: 'agent.spawned', data: { species: 'fennook', nick: 'SCOUT', ref: 'scout', silent: true } });
  const sim = createSimulator({ tickMs: 0, random: () => 0.99 });
  sim.start(store);
  const sent = store.apply({ type: 'chat.sent', agentId: 'scout', data: { text: 'compare 3 note apps please' } });
  sim.onChat(store.resolveAgent('scout'), sent.data.entry);
  const reply = store.snapshot().log.find((e) => e.type === 'chat.replied');
  assert.match(reply.data.entry.text, /DO IT AS A TASK|practice agent/);
  sim.stop();
});
