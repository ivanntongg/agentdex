import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { findNgrok, startTunnel, cleanDomain, friendlyTunnelError } from '../tunnel.js';

// A pretend ngrok process that prints the given JSON log lines.
function fakeSpawn(lines, { exitCode = null } = {}) {
  const calls = [];
  const fn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.killed = false; child.kill = () => { child.killed = true; };
    setTimeout(() => {
      for (const l of lines) child.stdout.write(JSON.stringify(l) + '\n');
      if (exitCode !== null) setTimeout(() => child.emit('exit', exitCode), 10);
    }, 5);
    fn.child = child;
    return child;
  };
  fn.calls = calls;
  return fn;
}

test('finds ngrok on PATH, then where the Windows and Mac installers put it', () => {
  assert.equal(findNgrok({ platform: 'linux', env: { PATH: '/usr/bin:/opt/x' }, exists: (f) => f === '/opt/x/ngrok' }), '/opt/x/ngrok');
  assert.equal(findNgrok({ platform: 'darwin', env: { PATH: '/usr/bin' }, exists: (f) => f === '/opt/homebrew/bin/ngrok' }), '/opt/homebrew/bin/ngrok');
  const local = 'C:\\Users\\Ivan Tong\\AppData\\Local';
  assert.equal(findNgrok({ platform: 'win32', env: { PATH: 'C:\\Windows', LOCALAPPDATA: local }, exists: (f) => f === `${local}\\Microsoft\\WindowsApps\\ngrok.exe` }), `${local}\\Microsoft\\WindowsApps\\ngrok.exe`);
  assert.equal(findNgrok({ platform: 'win32', env: { PATH: 'C:\\Windows' }, exists: () => false }), null);
});

test('starts ngrok on the static domain with the authtoken in the environment, not the arguments', async () => {
  const spawnImpl = fakeSpawn([{ lvl: 'info', msg: 'started tunnel', url: 'https://my-town.ngrok-free.app' }]);
  const t = await startTunnel({ bin: '/x/ngrok', port: 8788, authtoken: 'tok_123', domain: 'https://My-Town.ngrok-free.app/', spawnImpl });
  assert.equal(t.url, 'https://my-town.ngrok-free.app');
  const call = spawnImpl.calls[0];
  assert.deepEqual(call.args, ['http', '8788', '--log', 'stdout', '--log-format', 'json', '--url', 'https://my-town.ngrok-free.app']);
  assert.equal(call.opts.env.NGROK_AUTHTOKEN, 'tok_123');
  assert.ok(!call.args.join(' ').includes('tok_123'), 'the token never shows in the process list');
  t.stop();
  assert.equal(spawnImpl.child.killed, true);
});

test('ngrok problems come back as plain sentences', async () => {
  await assert.rejects(startTunnel({ bin: '/x/ngrok', port: 1, authtoken: 'bad', spawnImpl: fakeSpawn([{ lvl: 'eror', msg: 'failed', err: 'authentication failed: ERR_NGROK_105' }], { exitCode: 1 }) }), /rejected the authtoken/);
  await assert.rejects(startTunnel({ bin: '/x/ngrok', port: 1, authtoken: 't', spawnImpl: fakeSpawn([{ lvl: 'eror', err: 'ERR_NGROK_108 limited to 1 simultaneous session' }], { exitCode: 1 }) }), /already has a tunnel open/);
  await assert.rejects(startTunnel({ bin: null, port: 1, authtoken: 't' }), /not installed/);
  assert.match(friendlyTunnelError('ERR_NGROK_320 domain not reserved'), /not yours/);
  assert.equal(cleanDomain(' HTTPS://a.ngrok-free.app/path '), 'a.ngrok-free.app');
});
