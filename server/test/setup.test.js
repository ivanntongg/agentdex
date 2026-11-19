import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConfig, ConfigError } from '../config.js';
import { createStore, StoreError } from '../store.js';
import { createApp } from '../app.js';

const tmpFile = async () => path.join(await mkdtemp(path.join(os.tmpdir(), 'agentdex-cfg-')), 'agentdex.config.json');

test('settings are saved privately, validated, and never shown in full', async () => {
  const file = await tmpFile();
  const cfg = createConfig({ path: file, env: {} });
  assert.equal(cfg.model(), 'claude-opus-5-5');
  assert.equal(cfg.effort(), 'medium');
  assert.throws(() => cfg.save({ anthropicKey: 'not-a-key' }), ConfigError);
  assert.throws(() => cfg.save({ model: 'gpt-5' }), /Model must be one of/);
  cfg.save({ anthropicKey: 'sk-ant-api03-secretvalueABCD', effort: 'low', whatsappAllowed: '+60 12 345 6789' });
  const view = cfg.publicView();
  assert.equal(view.anthropicKey, '••••ABCD');
  assert.ok(!JSON.stringify(view).includes('secretvalue'));
  assert.equal(view.effort, 'low');
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  const reloaded = createConfig({ path: file, env: {} });
  assert.equal(reloaded.get('anthropicKey'), 'sk-ant-api03-secretvalueABCD');
  assert.equal(reloaded.verifyToken(), cfg.verifyToken(), 'verify token is stable across restarts');
  assert.ok(JSON.parse(await readFile(file, 'utf8')).whatsappVerifyToken);
});

test('environment variables are the fallback; saved settings win; empty clears', async () => {
  const cfg = createConfig({ path: await tmpFile(), env: { ANTHROPIC_API_KEY: 'sk-ant-from-env', AGENTDEX_EFFORT: 'high' } });
  assert.equal(cfg.get('anthropicKey'), 'sk-ant-from-env');
  assert.equal(cfg.effort(), 'high');
  cfg.save({ effort: 'low' });
  assert.equal(cfg.effort(), 'low');
  cfg.save({ effort: '' });
  assert.equal(cfg.effort(), 'high');
});

test('WhatsApp counts as set up only when all four values are present', async () => {
  const cfg = createConfig({ path: await tmpFile(), env: {} });
  cfg.save({ whatsappToken: 'EAAx', whatsappPhoneNumberId: '123456789', whatsappAllowed: '+6012 3456789' });
  assert.equal(cfg.whatsapp(), null);
  assert.throws(() => cfg.save({ whatsappAppSecret: 'zzz' }), /App secret/);
  cfg.save({ whatsappAppSecret: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6' });
  assert.equal(cfg.whatsapp().phoneNumberId, '123456789');
});

test('setup routes answer, report validation errors, and are off without real mode', async () => {
  const calls = [];
  const setup = {
    status: async () => ({ ok: true }),
    save: async (b) => { calls.push(b); if (b.bad) throw new StoreError(400, 'A Claude API key starts with sk-ant-'); },
    testClaude: async () => ({ ok: true, message: 'Connected.' }),
    testWhatsApp: async () => ({ ok: false, message: 'Fill in all four WhatsApp boxes and save first.' }),
  };
  for (const [withSetup, expectGet] of [[setup, 200], [null, 404]]) {
    const app = createApp({ store: createStore(), setup: withSetup });
    await new Promise((r) => app.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.address().port}`;
    const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) });
    try {
      assert.equal((await fetch(base + '/api/setup')).status, expectGet);
      if (withSetup) {
        assert.equal((await post('/api/setup', { effort: 'low' })).status, 200);
        const bad = await post('/api/setup', { bad: true });
        assert.equal(bad.status, 400);
        assert.match((await bad.json()).error, /sk-ant-/);
        assert.equal((await (await post('/api/setup/test-claude')).json()).message, 'Connected.');
        assert.equal((await (await post('/api/setup/test-whatsapp')).json()).ok, false);
      }
    } finally { await new Promise((r) => app.close(r)); }
  }
  assert.equal(calls.length, 2);
});
