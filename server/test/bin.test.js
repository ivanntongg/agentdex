import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../../bin/agentdex.js', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

test('npx agentdex-town --version prints the package version', () => {
  assert.equal(execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim(), pkg.version);
});

test('npx agentdex-town --help explains practice mode and where files live', () => {
  const out = execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
  assert.match(out, /--practice/);
  assert.match(out, /Agentdex/);
});

test('the published package ships everything the app imports, and no tests', () => {
  assert.equal(pkg.bin['agentdex-town'], 'bin/agentdex.js');
  assert.equal(pkg.license, 'MIT');
  for (const f of ['bin/', 'index.html', 'server/*.js', 'runtime/*.js', 'bridges/*.js']) assert.ok(pkg.files.includes(f), f);
  assert.ok(!pkg.private, 'must be publishable');
});
