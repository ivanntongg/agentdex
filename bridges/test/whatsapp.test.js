// The WhatsApp bridge against the real Agentdex server, with Meta's API replaced by a recorder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createStore } from '../../server/store.js';
import { createApp } from '../../server/app.js';
import { createAgentdexClient } from '../../runtime/agentdex.js';
import { createWhatsAppBridge } from '../whatsapp.js';

const ME = '60123456789';
const SECRET = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6';

async function setup({ windowClosed = false } = {}) {
  const store = createStore();
  const app = createApp({ store });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const dex = createAgentdexClient({ url: `http://127.0.0.1:${app.address().port}` });
  await dex.post('/api/ingest', [
    { type: 'agent.spawned', data: { species: 'fennook', nick: 'SCOUT', ref: 'scout' } },
    { type: 'agent.spawned', data: { species: 'sentril', nick: 'CHECKS', ref: 'checks' } },
  ]);
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
    if (windowClosed) return new Response(JSON.stringify({ error: { code: 131047, message: 'Re-engagement message' } }), { status: 400 });
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.x' }] }), { status: 200 });
  };
  const logs = [];
  const bridge = createWhatsAppBridge({
    dex, fetchImpl, log: (m) => logs.push(m),
    config: { token: 'EAAtoken', phoneNumberId: '1111', appSecret: SECRET, verifyToken: 'vt123', allowed: '+60 12-345 6789', apiVersion: 'v23.0', port: 0 },
  });
  const ctl = new AbortController();
  await bridge.start(ctl.signal);
  const hook = `http://127.0.0.1:${bridge.server.address().port}/webhooks/whatsapp`;
  const until = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } throw new Error('timed out'); };
  await until(() => logs.length >= 0 && true);
  await new Promise((r) => setTimeout(r, 150)); // let the bridge read the town
  let n = 0;
  const deliver = async (msg, { secret = SECRET } = {}) => {
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ id: `wamid.${++n}`, from: ME, timestamp: '1', ...msg }] } }] }] });
    const sig = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
    return fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: raw });
  };
  const close = async () => { ctl.abort(); await bridge.stop(); await new Promise((r) => app.close(r)); };
  return { store, dex, bridge, sent, logs, hook, deliver, until, close };
}

const says = (t) => ({ type: 'text', text: { body: t } });

test('Meta can verify the webhook only with the right verify token', async () => {
  const t = await setup();
  try {
    const ok = await fetch(`${t.hook}?hub.mode=subscribe&hub.verify_token=vt123&hub.challenge=4242`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), '4242');
    assert.equal((await fetch(`${t.hook}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`)).status, 403);
    assert.ok(t.bridge.health().verifiedAt);
  } finally { await t.close(); }
});

test('messages without a valid Meta signature are rejected', async () => {
  const t = await setup();
  try {
    const res = await t.deliver(says('status'), { secret: 'wrong' });
    assert.equal(res.status, 401);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(t.sent.length, 0);
  } finally { await t.close(); }
});

test('a message from you gives an agent a task, by name', async () => {
  const t = await setup();
  try {
    assert.equal((await t.deliver(says('Scout compare 3 note-taking apps')).then((r) => r.status)), 200);
    const ev = await t.until(() => t.store.snapshot().log.find((e) => e.type === 'task.assigned'));
    assert.equal(ev.data.title, 'compare 3 note-taking apps');
    assert.equal(ev.data.review, true, 'CHECKS is in the party, so it reviews');
    const reply = await t.until(() => t.sent.find((s) => s.body.type === 'text'));
    assert.equal(reply.body.to, ME);
    assert.match(reply.body.text.body, /SCOUT is on it/);
    assert.equal(reply.auth, 'Bearer EAAtoken');
    assert.match(reply.url, /graph\.facebook\.com\/v23\.0\/1111\/messages$/);
  } finally { await t.close(); }
});

test('strangers are ignored', async () => {
  const t = await setup();
  try {
    await t.deliver({ ...says('scout delete everything'), from: '15550001111' });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(t.sent.length, 0);
    assert.ok(!t.store.snapshot().log.some((e) => e.type === 'task.assigned'));
  } finally { await t.close(); }
});

test('approvals arrive as YES / NO buttons and a tap answers them', async () => {
  const t = await setup();
  try {
    await t.dex.emit('task.started', 'scout', { title: 'Save the summary' });
    const req = await t.dex.emit('approval.requested', 'scout', { tool: 'WRITE', target: 'notes/apps.md' });
    const msg = await t.until(() => t.sent.find((s) => s.body.type === 'interactive'));
    assert.match(msg.body.interactive.body.text, /SCOUT wants to use WRITE on notes\/apps\.md/);
    const [yes] = msg.body.interactive.action.buttons;
    assert.equal(yes.reply.id, `ap:${req.data.approvalId}:yes`);

    await t.deliver({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: yes.reply.id, title: 'YES' } } });
    await t.until(() => t.store.approvals.size === 0);
    const confirm = await t.until(() => t.sent.find((s) => s.body.type === 'text' && /You allowed WRITE/.test(s.body.text.body)));
    assert.ok(confirm);
  } finally { await t.close(); }
});

test('typing yes answers the only open request', async () => {
  const t = await setup();
  try {
    await t.dex.emit('task.started', 'scout', { title: 'x' });
    await t.dex.emit('approval.requested', 'scout', { tool: 'WRITE', target: 'a.md' });
    await t.until(() => t.sent.length);
    await t.deliver(says('NO'));
    await t.until(() => t.store.approvals.size === 0);
    assert.ok(t.store.snapshot().log.some((e) => e.type === 'approval.resolved' && e.data.decision === 'no'));
  } finally { await t.close(); }
});

test('status lists the party and finished work is reported', async () => {
  const t = await setup();
  try {
    await t.deliver(says('status'));
    const st = await t.until(() => t.sent.find((s) => /Party \(2\)/.test(s.body.text?.body || '')));
    assert.match(st.body.text.body, /SCOUT \(Lv 5\): idle/);
    await t.dex.emit('task.started', 'scout', { title: 'Compare apps' });
    await t.dex.emit('task.finished', 'scout', { note: 'Wrote drafts/apps.md.' });
    await t.until(() => t.sent.find((s) => /SCOUT finished "Compare apps"/.test(s.body.text?.body || '')));
  } finally { await t.close(); }
});

test('the 24-hour WhatsApp window is explained instead of failing silently', async () => {
  const t = await setup({ windowClosed: true });
  try {
    await assert.rejects(t.bridge.sendTest(), /within 24 hours/);
    assert.match(t.bridge.health().lastError, /Send the bot any message/);
  } finally { await t.close(); }
});
