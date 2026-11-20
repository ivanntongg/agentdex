import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../store.js';
import { createApp } from '../app.js';
import { createPipelines, lastSlot, isDue } from '../pipelines.js';

const tick = () => new Promise((r) => setImmediate(r));
const BRIEF = 'A YouTube channel with the funniest streamer moments each week, with my own commentary. Only streamers who allow clipping.';

function town() {
  const store = createStore();
  const scout = store.apply({ type: 'agent.spawned', data: { species: 'fennook', nick: 'SCOUT' } }).agentId;
  const quill = store.apply({ type: 'agent.spawned', data: { species: 'quillow', nick: 'QUILL' } }).agentId;
  const checks = store.apply({ type: 'agent.spawned', data: { species: 'sentril', nick: 'CHECKS' } }).agentId;
  store.apply({ type: 'project.saved', data: { project: { name: 'Streamer highlights', brief: BRIEF } } });
  const assigned = [];
  const assign = (a, title, review, details) => { assigned.push({ nick: a.nick, title, review, details }); return store.apply({ type: 'task.assigned', agentId: a.id, data: { title, details } }); };
  const plans = createPipelines({ store, assign, tickMs: 0, now: () => new Date('2026-11-23T10:00:00') });
  const plan = (extra = {}) => store.apply({ type: 'pipeline.saved', data: { pipeline: {
    name: 'Weekly streamer highlights', projectId: 'p-streamer-highlights', schedule: { day: 'mon', time: '09:00' },
    steps: [{ agentId: scout, title: 'Find this week\'s best moments', text: 'Save {folder}/moments.md.' }, { agentId: quill, title: 'Write the script', text: 'Use moments.md. Save script.md.' }], ...extra,
  } } }).data.pipeline;
  const finish = (id, data) => { const a = store.resolveAgent(id); store.apply({ type: 'task.started', agentId: id, data: { title: a.task?.title || assigned.at(-1).title } }); return store.apply({ type: 'task.finished', agentId: id, data }); };
  return { store, plans, plan, assigned, finish, scout, quill, checks };
}

test('schedules: the most recent slot, catching up once if the computer was off, never before the plan existed', () => {
  const mon = { day: 'mon', time: '09:00' };
  assert.equal(lastSlot(mon, new Date('2026-11-23T10:00:00')).toString(), new Date('2026-11-23T09:00:00').toString(), 'Monday 10:00: today at 09:00');
  assert.equal(lastSlot(mon, new Date('2026-11-23T08:00:00')).toString(), new Date('2026-11-16T09:00:00').toString(), 'Monday 08:00: last week');
  assert.equal(lastSlot(mon, new Date('2026-11-26T12:00:00')).toString(), new Date('2026-11-23T09:00:00').toString(), 'Thursday: this Monday');
  assert.equal(lastSlot({ day: 'daily', time: '18:30' }, new Date('2026-11-23T10:00:00')).toString(), new Date('2026-11-22T18:30:00').toString());
  assert.equal(lastSlot({ day: 'manual', time: '09:00' }), null);
  const pl = { enabled: true, running: null, schedule: mon, savedAt: '2026-11-20T00:00:00', lastRun: null };
  assert.equal(isDue(pl, new Date('2026-11-23T10:00:00')), true, 'computer was off at 09:00: runs when it is back');
  assert.equal(isDue({ ...pl, lastRun: { startedAt: '2026-11-23T09:00:30' } }, new Date('2026-11-23T10:00:00')), false, 'already ran this week');
  assert.equal(isDue({ ...pl, savedAt: '2026-11-23T09:30:00' }, new Date('2026-11-23T10:00:00')), false, 'made after this week\'s slot: waits for next week');
  assert.equal(isDue({ ...pl, enabled: false }, new Date('2026-11-23T10:00:00')), false, 'paused');
});

test('a run hands each step\'s work to the next, in its own dated folder, then says where the pack is', async () => {
  const t = town();
  const pl = t.plan();
  t.plans.start(pl.id);
  assert.equal(t.assigned.length, 1);
  assert.equal(t.assigned[0].nick, 'SCOUT');
  assert.match(t.assigned[0].details, /^Project: Streamer highlights\nA YouTube channel/);
  assert.match(t.assigned[0].details, /step 1 of 2 of the plan "Weekly streamer highlights", run on 2026-11-23\. Save everything in drafts\/streamer-highlights\/2026-11-23\//);
  assert.match(t.assigned[0].details, /Save drafts\/streamer-highlights\/2026-11-23\/moments\.md\./, '{folder} is filled in');
  assert.equal(t.store.pipelines.get(pl.id).running.step, 0);

  t.finish(t.scout, { note: 'Found 8 moments.', files: ['drafts/streamer-highlights/2026-11-23/moments.md'] });
  await tick();
  assert.equal(t.assigned[1].nick, 'QUILL');
  assert.match(t.assigned[1].details, /Step 1, SCOUT, "Find this week's best moments": Found 8 moments\. Files: drafts\/streamer-highlights\/2026-11-23\/moments\.md\./);

  t.finish(t.quill, { note: 'Script and 10 titles.', files: ['drafts/streamer-highlights/2026-11-23/script.md'] });
  await tick();
  const p = t.store.pipelines.get(pl.id);
  assert.equal(p.running, null);
  assert.deepEqual([p.lastRun.status, p.lastRun.folder], ['done', 'drafts/streamer-highlights/2026-11-23']);
  assert.ok(t.store.snapshot().log.some((e) => e.message === 'Weekly streamer highlights is done. Open drafts/streamer-highlights/2026-11-23 for this week\'s pack.'));
  t.plans.close();
});

test('the schedule starts a due plan; a fainted agent, a NO or STOP ends the run with the reason', async () => {
  let t = town();
  const pl = t.plan();
  t.store.pipelines.get(pl.id).savedAt = '2026-11-20T00:00:00';
  t.plans.tick();
  assert.equal(t.store.pipelines.get(pl.id).running.by, 'schedule');
  assert.throws(() => t.plans.start(pl.id), /already running/);
  t.store.apply({ type: 'agent.fainted', agentId: t.scout, data: { reason: 'out of context' } });
  await tick();
  assert.ok(t.store.pipelines.get(pl.id).running, 'a faint does not end the run');
  assert.ok(t.store.snapshot().log.some((e) => /SCOUT fainted during step 1\. The step starts again once SCOUT is reset/.test(e.message || '')));
  t.store.apply({ type: 'agent.reset', agentId: t.scout });
  await tick();
  assert.equal(t.assigned.length, 2, 'the step was given again');
  assert.equal(t.assigned[1].title, t.assigned[0].title);
  t.store.apply({ type: 'agent.fainted', agentId: t.scout, data: { reason: 'again' } });
  await tick();
  assert.match(t.store.pipelines.get(pl.id).lastRun.reason, /SCOUT fainted again during step 1/);

  t = town();
  const p2 = t.plan();
  t.plans.start(p2.id);
  t.finish(t.scout, { outcome: 'declined' });
  await tick();
  assert.match(t.store.pipelines.get(p2.id).lastRun.reason, /SCOUT stood down at step 1 after you said NO/);

  t = town();
  const p3 = t.plan();
  t.plans.start(p3.id);
  t.plans.stop(p3.id);
  assert.equal(t.store.pipelines.get(p3.id).lastRun.status, 'stopped');
  t.finish(t.scout, { note: 'late' });
  await tick();
  assert.equal(t.assigned.length, 1, 'nothing else starts after STOP');
});

test('plans and projects are checked, saved with the town, and a run cut short by closing is explained', () => {
  const t = town();
  assert.throws(() => t.store.apply({ type: 'project.saved', data: { project: { name: 'X', brief: 'short' } } }), /name of 2 to 40|Describe the project/);
  assert.throws(() => t.plan({ steps: [{ agentId: t.checks, title: 'Review', text: 'review everything' }] }), /CHECKS only reviews/);
  assert.throws(() => t.plan({ projectId: 'p-nope' }), /Pick a project/);
  const pl = t.plan();
  assert.throws(() => t.store.apply({ type: 'project.deleted', data: { id: 'p-streamer-highlights' } }), /Delete or move its weekly plan first: Weekly streamer highlights/);
  t.plans.start(pl.id);
  const saved = JSON.parse(JSON.stringify(t.store.serialize()));
  const b = createStore();
  b.restore(saved);
  const back = b.pipelines.get(pl.id);
  assert.equal(back.running, null);
  assert.match(back.lastRun.reason, /Agentdex closed while it ran/);
  assert.equal(b.projects.get('p-streamer-highlights').folder, 'drafts/streamer-highlights');
  t.plans.close();
});

test('the API: jobs in a project carry its brief; "run <plan>" starts a plan from the command box or phone', async () => {
  const store = createStore();
  const app = createApp({ store });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.address().port}`;
  const post = (p, body) => fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const scout = store.apply({ type: 'agent.spawned', data: { species: 'fennook', nick: 'SCOUT' } }).agentId;
    assert.equal((await post('/api/projects', { project: { name: 'GTA 6 channel', brief: 'News, map guides and theories about GTA 6 for fans.' } })).status, 200);
    await post('/api/command', { text: 'scout find 3 GTA 6 map rumours', project: 'p-gta-6-channel' });
    const ev = store.snapshot().log.find((e) => e.type === 'task.assigned');
    assert.match(ev.data.details, /^Project: GTA 6 channel\nNews, map guides/);
    assert.match(ev.message, /\(GTA 6 channel\)\.$/);
    store.apply({ type: 'task.finished', agentId: scout, data: {} });
    const saved = await post('/api/plans', { pipeline: { name: 'Weekly GTA 6 video', projectId: 'p-gta-6-channel', schedule: { day: 'manual' }, steps: [{ agentId: scout, title: 'This week in GTA 6', text: 'Collect the news.' }] } });
    assert.equal(saved.status, 200);
    const r = await post('/api/command', { text: 'run weekly gta' });
    assert.equal(r.body.reply, 'Weekly GTA 6 video started. Each step hands its work to the next.');
    assert.equal((await post('/api/plans/run', { id: saved.body.event.data.pipeline.id })).status, 409, 'already running');
    assert.match((await post('/api/command', { text: 'run nothing like this' })).body.reply, /No plan called "nothing like this"/);
  } finally { await new Promise((r) => app.close(r)); }
});

test('practice agents queue jobs given while they are busy, so practice plans finish', async () => {
  const { createSimulator } = await import('../simulator.js');
  const store = createStore();
  const sim = createSimulator({ tickMs: 0, random: () => 0.99 });
  sim.start(store);
  const a = store.apply({ type: 'agent.spawned', data: { species: 'fennook', nick: 'SCOUT' } }).agentId;
  store.apply({ type: 'task.started', agentId: a, data: { title: 'Busy already' } });
  sim.onAssigned(store.resolveAgent(a), { title: 'Your job' });
  for (let i = 0; i < 40 && !store.snapshot().log.some((e) => e.type === 'task.started' && e.data.title === 'Your job'); i++) sim.tick();
  assert.ok(store.snapshot().log.some((e) => e.type === 'task.started' && e.data.title === 'Your job'), 'the queued job started after the first one');
});
