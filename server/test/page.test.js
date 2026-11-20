import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The town page has no build step, so a typo in its script would only show up in the browser.
// Compiling each inline script catches syntax errors and clashing names before they ship.
test('every script in index.html compiles', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 2);
  for (const code of scripts) assert.doesNotThrow(() => new Function(code));
});

test('the page has no em dashes', () => {
  assert.ok(!readFileSync(new URL('../../index.html', import.meta.url), 'utf8').includes('—'));
});
