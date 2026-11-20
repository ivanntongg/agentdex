import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGuide, townBrief, GUIDE_SYSTEM } from '../guide.js';
import { createStore } from '../../server/store.js';
import { createCommands } from '../../server/commands.js';
import { createSimulator } from '../../server/simulator.js';
import { guideText } from '../../bridges/common.js';

const party = [
  { id: 1, nick: 'SCOUT', species: 'fennook', status: 'SLP', task: null, memory: [{ title: 'Compare 3 note apps' }] },
  { id: 2, nick: 'QUILL', species: 'quillow', status: 'OK', task: { title: 'Write release notes' } },
  { id: 3, nick: 'CHECKS', species: 'sentril', status: 'SLP', task: null },
  { id: 4, nick: 'OLD', species: 'bytle', status: 'SLP', boxed: true },
];

test('the Guide is told who is free, their jobs, recent work, skills and the conversation so far', () => {
  const b = townBrief({ agents: party, approvals: 1, skills: [{ name: 'youtube-titles', description: 'Titles that get clicks' }], recent: ['SCOUT finished "Compare 3 note apps".'], history: [{ from: 'you', text: 'I run a gaming channel' }] });
  assert.match(b, /SCOUT \(research, can search the web\): free\. Job: You are a research analyst/);
  assert.match(b, /Recently did: "Compare 3 note apps"/);
  assert.match(b, /QUILL \(write\/research, can search the web\): busy with "Write release notes"/);
  assert.match(b, /CHECKS \(qa, reviewer only/);
  assert.match(b, /In the box \(switched off\): OLD/);
  assert.match(b, /Installed skills: youtube-titles/);
  assert.match(b, /1 YES \/ NO question\(s\) are waiting/);
  assert.match(b, /User: I run a gaming channel/);
  assert.match(GUIDE_SYSTEM, /cannot do: run programs/);
});

test('ideas only go to real, non-reviewer agents in the party; a new role is suggested when nobody fits', async () => {
  const emitted = [];
  let asked = null;
  const guide = createGuide({
    agents: () => party, log: () => {},
    dex: { emit: async (type, agentId, data) => { emitted.push({ type, agentId, data }); } },
    ask: async (q) => { asked = q; return { reply: 'Here are two ideas.', suggestions: [{ agent: 'scout', task: 'Find 5 rising GTA 6 channels' }, { agent: 'CHECKS', task: 'Review stuff' }, { agent: 'NOBODY', task: 'x' }, { agent: '@OLD', task: 'boxed' }], newRole: { name: 'Video editor', job: 'Writes scripts, shot lists and captions for videos.' } }; },
  });
  guide.remember({ type: 'guide.asked', data: { text: 'what should my team do?' } });
  await guide.answer('what should my team do?');
  assert.equal(asked.agentId, null, 'nobody pays HP for the Guide');
  assert.equal(asked.effort, 'medium');
  assert.match(asked.prompt, /The user asks the Guide: what should my team do\?$/);
  const ev = emitted[0];
  assert.equal(ev.type, 'guide.answered');
  assert.deepEqual(ev.data.suggestions, [{ agentId: 1, task: 'Find 5 rising GTA 6 channels' }]);
  assert.equal(ev.data.newRole.name, 'Video editor');
});

test('when Claude is not connected, the Guide says so plainly', async () => {
  const emitted = [];
  const guide = createGuide({ agents: () => party, log: () => {}, dex: { emit: async (type, a, data) => emitted.push({ type, data }) }, ask: () => { throw new Error('Connect Claude on the SETUP screen so the Guide can answer.'); } });
  await guide.answer('hi');
  assert.equal(emitted[0].type, 'guide.failed');
  assert.match(emitted[0].data.reason, /Connect Claude on the SETUP screen/);
});

test('"? question" asks the Guide; the store keeps answers with checked ideas; practice mode answers too', async () => {
  const store = createStore();
  const sim = createSimulator({ tickMs: 0 });
  sim.start(store); // empty town, so no opening scene
  store.apply({ type: 'agent.spawned', data: { species: 'fennook', nick: 'SCOUT' } });
  store.apply({ type: 'agent.spawned', data: { species: 'sentril', nick: 'CHECKS' } });
  const cmd = createCommands({ store, actions: { ask: (text, via) => { const e = store.apply({ type: 'guide.asked', data: { text, via } }); sim.onGuide(e.data); return e; } } });
  const r = await cmd.run('? what should my team do today');
  assert.equal(r.chat, true);
  const log = store.snapshot().log;
  assert.match(log.find((e) => e.type === 'guide.asked').message, /You asked the Guide: "what should my team do today"/);
  const ans = log.find((e) => e.type === 'guide.answered');
  assert.ok(ans, 'the practice Guide answered');
  assert.deepEqual(ans.data.suggestions.map((x) => x.nick), ['SCOUT'], 'never the reviewer');
  assert.equal((await cmd.run('?')).reply.split('\n')[0], 'Tell your team what to do in one sentence.', 'a lone ? is still help');

  const bad = store.apply({ type: 'guide.answered', data: { text: 'ok', suggestions: [{ nick: 'GHOST', task: 'x' }] } });
  assert.deepEqual(bad.data.suggestions, [], 'ideas for agents that do not exist are dropped');
  assert.throws(() => store.apply({ type: 'guide.asked', data: { text: ' ' } }), /Ask the Guide something/);
});

test('on the phone, ideas come as messages you can send back', () => {
  const t = guideText({ type: 'guide.answered', data: { text: 'Try these.', suggestions: [{ nick: 'SCOUT', task: 'find 5 rising GTA 6 channels' }], newRole: { name: 'Video editor' } } });
  assert.equal(t, 'Guide: Try these.\n\nTo start one, send it as it is:\n• scout find 5 rising GTA 6 channels\n\nIdea for a new role: Video editor. Create it in the town\'s DEX.');
});
