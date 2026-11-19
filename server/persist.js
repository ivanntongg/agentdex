// Saves the town to a JSON file shortly after every change, and loads it on start.
// Writes go to a temporary file first and are then renamed, so a crash mid-write never leaves
// a half-written save. A save that cannot be read is moved aside, never deleted.
import { readFileSync, writeFileSync, renameSync, existsSync, chmodSync } from 'node:fs';

export function createPersistence({ store, path = 'agentdex.state.json', delayMs = 400, log = console.log }) {
  let timer = null;
  let dirty = false;

  function load() {
    if (!existsSync(path)) return { loaded: false, interrupted: [] };
    try {
      const interrupted = store.restore(JSON.parse(readFileSync(path, 'utf8')));
      const n = store.agents.size;
      store.note(`Welcome back. Your town was restored: ${n} agent${n === 1 ? '' : 's'}, names, levels, chats and the field log.`, 'ok');
      for (const t of interrupted) store.note(`${t.nick} was working on "${t.title}" when Agentdex closed. Give it again to restart it.`, 'need');
      return { loaded: true, interrupted };
    } catch (err) {
      const aside = `${path}.broken-${Date.now()}`;
      try { renameSync(path, aside); } catch { /* leave it */ }
      log(`Could not read the saved town (${err.message}). Kept it as ${aside} and started fresh.`);
      return { loaded: false, interrupted: [], error: err.message };
    }
  }

  function flush() {
    clearTimeout(timer); timer = null;
    if (!dirty) return;
    dirty = false;
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(store.serialize()), { mode: 0o600 });
      renameSync(tmp, path);
      try { chmodSync(path, 0o600); } catch { /* Windows */ }
    } catch (err) {
      dirty = true;
      log(`Could not save the town: ${err.message}`);
    }
  }

  const unsubscribe = store.subscribe(() => {
    dirty = true;
    if (!timer) timer = setTimeout(flush, delayMs);
  });

  return { load, flush, stop: () => { flush(); unsubscribe(); } };
}
