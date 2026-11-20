import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSkillScout, SAFETY_SYSTEM } from '../skill-scout.js';
import { SkillError } from '../skills.js';

const skill = (id, extra = {}) => ({ id, name: id.split('/').pop(), description: `About ${id}`, source: id.split('/').slice(0, 2).join('/'), url: `https://github.com/${id}`, sha256: id, text: `# ${id}\nDo it well.`, flags: [], ...extra });

// Everything the scout talks to, faked and recorded.
function setup({ answers = {}, approval = 'yes', reviewer = { id: 9, nick: 'CHECKS' }, search = null, enabled = true } = {}) {
  const emitted = [];
  const asked = [];
  const approvals = [];
  const installed = [];
  const store = [
    skill('a/b/youtube-titles'),
    skill('c/d/evil', { flags: [{ level: 'danger', text: 'Talks about sending keys.' }] }),
    skill('e/f/title-formulas'),
  ];
  const skills = {
    list: async () => installed.map((s) => ({ ...s, slug: s.name })),
    search: search || (async () => store.map((s, i) => ({ id: s.id, name: s.name, source: s.source, installs: 100 - i }))),
    fetchSkill: async (id) => ({ ...store.find((s) => s.id === id) }),
    install: async (s, meta) => { const x = { ...s, ...meta, slug: s.name }; installed.push(x); return x; },
    mirror: async () => installed,
    remove: async () => {},
  };
  const ask = async ({ system, prompt, agentId }) => {
    asked.push({ system, prompt, agentId });
    if (system === SAFETY_SYSTEM) return answers.safety ?? { verdict: 'safe', summary: 'Plain writing advice.' };
    if (/Pick the one/.test(system)) return answers.pick ?? { pick: 'a/b/youtube-titles', why: 'fits' };
    return answers.decide ?? { lookFor: true, query: 'youtube titles' };
  };
  const scout = createSkillScout({
    skills, ask, enabled: () => enabled, workspaceRoot: '/ws', log: () => {},
    dex: { emit: async (type, agentId, data) => { emitted.push({ type, agentId, data }); return { data: {} }; } },
    waitForApproval: async (agentId, data) => { approvals.push({ agentId, data }); return approval; },
    reviewer: () => reviewer,
  });
  return { scout, emitted, asked, approvals, installed };
}
const quill = { id: 3, nick: 'QUILL' };
const task = { title: 'Write 5 YouTube titles for a GTA 6 map guide' };

test('an agent finds a skill, CHECKS reads it, you say YES, and it is installed', async () => {
  const t = setup();
  const got = await t.scout.forTask(quill, task, new AbortController().signal);
  assert.equal(got.name, 'youtube-titles');
  assert.deepEqual(t.emitted[0], { type: 'agent.moved', agentId: 3, data: { to: 'MART', reason: 'looking for a skill: "youtube titles"' } });
  assert.ok(!t.asked.find((a) => /Pick the one/.test(a.system)).prompt.includes('c/d/evil'), 'a dangerous skill is never even offered');
  const safety = t.asked.find((a) => a.system === SAFETY_SYSTEM);
  assert.equal(safety.agentId, 9, 'CHECKS pays for its own review');
  assert.equal(t.approvals.length, 1);
  const ap = t.approvals[0].data;
  assert.equal(ap.kind, 'skill');
  assert.equal(ap.skill.installs, 100);
  assert.deepEqual(ap.skill.review, { by: 'CHECKS', verdict: 'safe', summary: 'Plain writing advice.' });
  assert.equal(t.installed[0].by, 'QUILL');
  const up = t.emitted.find((e) => e.type === 'skills.updated');
  assert.match(up.data.note, /QUILL learned "youtube-titles"\. It's in the MART now\./);
});

test('NO is remembered: the same skill is not offered again', async () => {
  const t = setup({ approval: 'no' });
  assert.equal(await t.scout.forTask(quill, task, new AbortController().signal), null);
  assert.equal(t.installed.length, 0);
  assert.ok(t.scout.declined.has('a/b/youtube-titles'));
  await t.scout.forTask(quill, task, new AbortController().signal);
  const pick = t.asked.filter((a) => /Pick the one/.test(a.system)).pop();
  assert.ok(!pick.prompt.includes('### a/b/youtube-titles'));
});

test('CHECKS can turn a skill down before you are ever asked', async () => {
  const t = setup({ answers: { safety: { verdict: 'unsafe', summary: 'It asks the agent to upload your files.' } } });
  assert.equal(await t.scout.forTask(quill, task, new AbortController().signal), null);
  assert.equal(t.approvals.length, 0);
  assert.ok(t.emitted.some((e) => /CHECKS turned down "youtube-titles"/.test(e.data?.message || '')));
});

test('without a free reviewer the quick checks still apply and you are asked', async () => {
  const t = setup({ reviewer: null });
  await t.scout.forTask(quill, task, new AbortController().signal);
  assert.equal(t.approvals[0].data.skill.review, null);
});

test('most tasks need no skill, the switch turns it off, and search problems never stop a task', async () => {
  let t = setup({ answers: { decide: { lookFor: false, query: '' } } });
  assert.equal(await t.scout.forTask(quill, task, new AbortController().signal), null);
  assert.equal(t.emitted.length, 0, 'no walk to the MART');

  t = setup({ enabled: false });
  assert.equal(await t.scout.forTask(quill, task, new AbortController().signal), null);
  assert.equal(t.asked.length, 0, 'no model calls at all');

  t = setup({ search: async () => { throw new SkillError('Could not reach skills.sh: offline'); } });
  assert.equal(await t.scout.forTask(quill, task, new AbortController().signal), null);
  assert.ok(t.emitted.some((e) => /couldn't look for skills/.test(e.data?.message || '')));

  t = setup({ answers: { pick: { pick: 'none', why: 'nothing fits' } } });
  assert.equal(await t.scout.forTask(quill, task, new AbortController().signal), null);
  assert.ok(t.emitted.some((e) => /none fit/.test(e.data?.message || '')));
});

test('a skill you pick in the MART goes through the same review and YES / NO', async () => {
  const t = setup();
  const got = await t.scout.request({ id: 1, nick: 'SCOUT' }, 'e/f/title-formulas', new AbortController().signal);
  assert.equal(got.name, 'title-formulas');
  assert.equal(t.approvals[0].agentId, 1);
  assert.ok(t.asked.some((a) => a.system === SAFETY_SYSTEM));
  await assert.rejects(t.scout.request({ id: 1, nick: 'SCOUT' }, 'c/d/evil', new AbortController().signal).then((r) => { if (r === null) throw new Error('skipped'); }), /skipped/);
});
