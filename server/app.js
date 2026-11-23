// HTTP API. No dependencies: node:http plus Server-Sent Events.
//
//   GET  /api/state                      full snapshot
//   GET  /api/events                     live stream (SSE): "snapshot" once, then "change" per event
//   POST /api/approvals/:id              { decision: "yes" | "no" }
//   POST /api/agents                     { species, nick? }            spawn into the party
//   POST /api/agents/:id/actions         { action: pet | poke | reset | box | unbox }
//   POST /api/agents/:id/tasks           { title, details?, review? }   give an agent work
//   POST /api/command                    { text }   one sentence from the command bar or WhatsApp
//   POST /api/agents/:id/chat            { text, files? }   talk to an agent (no task); the reply arrives as chat.replied
//   POST /api/files?name=report.pdf      raw file body   saved to <workspace>/inbox (real mode)
//   POST /api/ingest                     one event or an array, from a real agent runtime
//   GET  /                               the town (index.html)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { StoreError } from './store.js';
import { createCommands } from './commands.js';
import { createPipelines } from './pipelines.js';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_BODY = 64 * 1024;
const MAX_UPLOAD = 25 * 1024 * 1024;

// A safe file name: no folders, no hidden files, no odd characters.
export function safeName(raw) {
  const base = path.basename(String(raw || '').replace(/\\/g, '/')).normalize('NFC');
  const clean = base.replace(/[^\p{L}\p{N} ._()\-]/gu, '_').replace(/^[.\s]+/, '').replace(/\s+/g, ' ').trim().slice(0, 100);
  return clean || 'file';
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// setup (optional): { status(), save(body), testClaude(), testWhatsApp() } for the SETUP screen.
// workspaceRoot (optional): enables uploads into <workspace>/inbox.
// skills (optional): { state(), search(q), request({ id, agentId }), remove(slug), setEnabled(bool) } for the MART.
export function createApp({ store, adapter = null, token = null, indexPath = null, setup = null, workspaceRoot = null, skills = null }) {
  const clients = new Set();

  store.subscribe((payload) => {
    const msg = `event: change\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) res.write(msg);
  });
  const heartbeat = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);
  heartbeat.unref();

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  function authorized(req) {
    if (!token) return true;
    const got = Buffer.from(String(req.headers.authorization || ''));
    const want = Buffer.from(`Bearer ${token}`);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  async function readJSON(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) throw new StoreError(413, 'Request body is too large');
      chunks.push(c);
    }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new StoreError(400, 'Body must be valid JSON'); }
  }

  function resolve(approvalId, decision) {
    const ap = store.approvals.get(Number(approvalId));
    if (!ap) throw new StoreError(404, `No open approval ${approvalId}`);
    const event = store.apply({ type: 'approval.resolved', agentId: ap.agentId, data: { approvalId: ap.id, decision } });
    adapter?.onApproval?.(ap, decision);
    return event;
  }
  function filesDetails(details, files) {
    const list = (Array.isArray(files) ? files : []).map(String).filter((f) => /^inbox\//.test(f)).slice(0, 10);
    return list.length ? `${details ? `${details}\n\n` : ''}Use these files the user added: ${list.join(', ')}` : details;
  }
  // A project's brief and folder, added to jobs given while that project is picked.
  function withProject(details, projectId) {
    const pj = projectId ? store.projects.get(String(projectId)) : null;
    if (!pj) return details;
    return `Project: ${pj.name}\n${pj.brief}\nSave your files in ${pj.folder}/ (no permission needed there).${details ? `\n\n${details}` : ''}`;
  }
  function assign(a, title, review, details, project = null, extra = null) {
    const event = store.apply({ type: 'task.assigned', agentId: a.id, data: { title, details: details ? String(details).slice(0, 6000) : undefined, review: Boolean(review), project, ...(extra || {}) } });
    adapter?.onAssigned?.(a, event.data);
    return event;
  }
  function withFiles(text, files) {
    const list = (Array.isArray(files) ? files : []).map(String).filter((f) => /^inbox\//.test(f)).slice(0, 10);
    return list.length ? `${String(text || '').trim()}\n\n(Files I added: ${list.join(', ')})` : text;
  }
  function chat(a, text, via) {
    const event = store.apply({ type: 'chat.sent', agentId: a.id, data: { text, via } });
    adapter?.onChat?.(a, event.data.entry);
    return event;
  }
  function reset(a) {
    if (a.boxed) throw new StoreError(409, `${a.nick} is in the box`);
    if (adapter?.onReset) { adapter.onReset(a); return null; }
    return store.apply({ type: 'agent.reset', agentId: a.id });
  }
  function ask(text, via) {
    const event = store.apply({ type: 'guide.asked', data: { text, via } });
    adapter?.onGuide?.(event.data);
    return event;
  }
  const plans = createPipelines({ store, assign, log: (m) => console.error(m) });
  function runPlan(name) {
    const pl = plans.findByName(name);
    if (!pl) return { reply: `No plan called "${name}". Your plans: ${[...store.pipelines.values()].map((p) => p.name).join(', ') || 'none yet (make one in the PLANS tab)'}.` };
    try { plans.start(pl.id); return { reply: `${pl.name} started. Each step hands its work to the next.` }; } catch (err) { return { reply: err.message }; }
  }
  const commands = createCommands({ store, actions: { resolve, assign, reset, chat, ask, runPlan, withFiles, filesDetails, withProject, rename: (a, nick) => store.apply({ type: 'agent.renamed', agentId: a.id, data: { nick } }) } });

  const routes = [
    ['GET', /^\/api\/state$/, (req, res) => send(res, 200, { ...store.snapshot(), adapter: adapter ? adapter.name : null })],

    ['GET', /^\/api\/events$/, (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`retry: 2000\nevent: snapshot\ndata: ${JSON.stringify({ ...store.snapshot(), adapter: adapter ? adapter.name : null })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
    }],

    ['POST', /^\/api\/approvals\/(\d+)$/, async (req, res, [, id]) => {
      const { decision } = await readJSON(req);
      send(res, 200, { event: resolve(Number(id), decision) });
    }],

    ['POST', /^\/api\/agents\/([^/]+)\/chat$/, async (req, res, [, id]) => {
      const { text, via, files } = await readJSON(req);
      send(res, 200, { event: chat(store.resolveAgent(decodeURIComponent(id)), withFiles(text, files), via) });
    }],

    ['POST', /^\/api\/files$/, async (req, res, m, url) => {
      if (!workspaceRoot) throw new StoreError(404, 'Adding files works when Agentdex runs with real agents (npm run real).');
      const name = safeName(url.searchParams.get('name'));
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > MAX_UPLOAD) throw new StoreError(413, `${name} is over ${MAX_UPLOAD / 1024 / 1024} MB.`);
        chunks.push(c);
      }
      const dir = path.join(workspaceRoot, 'inbox');
      await mkdir(dir, { recursive: true });
      const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
      let final = name;
      for (let i = 2; await stat(path.join(dir, final)).then(() => true, () => false); i++) final = `${stem} (${i})${ext}`;
      await writeFile(path.join(dir, final), Buffer.concat(chunks), { flag: 'wx' });
      const rel = `inbox/${final}`;
      store.apply({ type: 'files.added', data: { files: [rel] } });
      send(res, 201, { path: rel, size });
    }],

    ['POST', /^\/api\/command$/, async (req, res) => {
      const { text, review, via, files, project } = await readJSON(req);
      send(res, 200, await commands.run(text, { review, via, files, project }));
    }],

    ['POST', /^\/api\/agents$/, async (req, res) => {
      const { species, nick } = await readJSON(req);
      const event = store.apply({ type: 'agent.spawned', data: { species, nick } });
      send(res, 201, { event, agent: store.resolveAgent(event.agentId) });
    }],

    ['POST', /^\/api\/agents\/([^/]+)\/actions$/, async (req, res, [, id]) => {
      const body = await readJSON(req);
      const { action } = body;
      const a = store.resolveAgent(decodeURIComponent(id));
      let event = null;
      switch (action) {
        case 'pet': {
          const msg = a.status === 'FNT' ? `${a.nick} is out cold. A pet won't fix this; try a reset.`
            : a.status === 'CNF' ? `You pet ${a.nick}. It calmed down and tried a different approach.`
            : a.phase === 'work' || a.phase === 'review' ? `${a.nick} leaned into it without looking up from the work.`
            : a.status === 'PAR' ? `${a.nick} nudged your hand toward the YES button.`
            : `${a.nick} nuzzled your hand. It looks happy!`;
          event = store.apply({ type: 'agent.interacted', agentId: a.id, data: { action: 'pet', message: msg, tone: a.status === 'FNT' ? 'info' : 'ok' } });
          break;
        }
        case 'poke':
          if (adapter?.onPoke) adapter.onPoke(a);
          else event = store.apply({ type: 'agent.interacted', agentId: a.id, data: { action: 'poke', message: `${a.nick} looked up at you.` } });
          break;
        case 'reset':
          event = reset(a);
          break;
        case 'rename':
          event = store.apply({ type: 'agent.renamed', agentId: a.id, data: { nick: body.nick } });
          break;
        case 'box':
          if (a.status === 'PAR') throw new StoreError(409, `${a.nick} is waiting on your approval. Answer it first.`);
          event = store.apply({ type: 'agent.boxed', agentId: a.id });
          adapter?.onRemoved?.(a);
          break;
        case 'unbox':
          event = store.apply({ type: 'agent.unboxed', agentId: a.id });
          break;
        default:
          throw new StoreError(400, 'action must be one of pet, poke, reset, rename, box, unbox');
      }
      send(res, 200, { event, agent: store.resolveAgent(a.id) });
    }],

    ['POST', /^\/api\/agents\/([^/]+)\/tasks$/, async (req, res, [, id]) => {
      const { title, details, review, files, project } = await readJSON(req);
      const a = store.resolveAgent(decodeURIComponent(id));
      send(res, 200, { event: assign(a, title, review, withProject(filesDetails(details, files), project), project) });
    }],

    ['POST', /^\/api\/ingest$/, async (req, res) => {
      const body = await readJSON(req);
      const list = Array.isArray(body) ? body : [body];
      if (list.length > 100) throw new StoreError(413, 'Send at most 100 events per request');
      const events = list.map((e) => store.apply(e));
      send(res, 200, { events });
    }],

    // Projects and weekly plans.
    ['POST', /^\/api\/projects$/, async (req, res) => {
      const { project } = await readJSON(req);
      send(res, 200, { event: store.apply({ type: 'project.saved', data: { project } }) });
    }],
    ['POST', /^\/api\/projects\/delete$/, async (req, res) => {
      const { id } = await readJSON(req);
      send(res, 200, { event: store.apply({ type: 'project.deleted', data: { id: String(id || '') } }) });
    }],
    ['POST', /^\/api\/plans$/, async (req, res) => {
      const { pipeline } = await readJSON(req);
      send(res, 200, { event: store.apply({ type: 'pipeline.saved', data: { pipeline } }) });
    }],
    ['POST', /^\/api\/plans\/(delete|run|stop)$/, async (req, res, [, what]) => {
      const { id } = await readJSON(req);
      if (what === 'delete') return send(res, 200, { event: store.apply({ type: 'pipeline.deleted', data: { id: String(id || '') } }) });
      try { if (what === 'run') plans.start(String(id || '')); else plans.stop(String(id || '')); }
      catch (err) { throw new StoreError(409, err.message); }
      send(res, 200, { ok: true });
    }],

    // Roles: { role: { id?, name, job, web, home, look } } for a custom role, or { type, job, web } to rewrite a built-in one.
    ['POST', /^\/api\/roles$/, async (req, res) => {
      const body = await readJSON(req);
      send(res, 200, { event: store.apply({ type: 'role.saved', data: body.type ? { type: String(body.type), job: body.job, web: body.web } : { role: body.role } }) });
    }],
    // { id } deletes a custom role; { type } puts a built-in role back as it came.
    ['POST', /^\/api\/roles\/delete$/, async (req, res) => {
      const body = await readJSON(req);
      send(res, 200, { event: store.apply({ type: 'role.deleted', data: body.type ? { type: String(body.type) } : { id: String(body.id || '') } }) });
    }],

    ['GET', /^\/api\/skills$/, async (req, res) => {
      if (!skills) return send(res, 200, { available: false, enabled: false, skills: [] });
      send(res, 200, { available: true, ...(await skills.state()) });
    }],
    ['POST', /^\/api\/skills\/(search|request|remove|settings)$/, async (req, res, [, what]) => {
      if (!skills) throw new StoreError(404, 'Skills work when Agentdex runs with real agents (npm run real).');
      const body = await readJSON(req);
      if (what === 'search') return send(res, 200, { results: await skills.search(String(body.q || '')) });
      if (what === 'request') return send(res, 202, await skills.request({ id: String(body.id || ''), agentId: body.agentId ?? null }));
      if (what === 'remove') { await skills.remove(String(body.slug || '')); return send(res, 200, await skills.state()); }
      await skills.setEnabled(Boolean(body.enabled));
      send(res, 200, await skills.state());
    }],

    ['GET', /^\/api\/setup$/, async (req, res) => {
      if (!setup) return send(res, 404, { error: 'Setup is available when Agentdex runs with real agents (npm run real).' });
      send(res, 200, await setup.status());
    }],
    ['POST', /^\/api\/setup$/, async (req, res) => {
      if (!setup) throw new StoreError(404, 'Setup is available when Agentdex runs with real agents (npm run real).');
      await setup.save(await readJSON(req));
      send(res, 200, await setup.status());
    }],
    ['POST', /^\/api\/setup\/captions$/, async (req, res) => {
      if (!setup?.getCaptions) throw new StoreError(404, 'Captions work when Agentdex runs with real agents (npm run real).');
      send(res, 200, await setup.getCaptions());
    }],
    ['POST', /^\/api\/setup\/test-(claude|whatsapp)$/, async (req, res, [, what]) => {
      if (!setup) throw new StoreError(404, 'Setup is available when Agentdex runs with real agents (npm run real).');
      send(res, 200, what === 'claude' ? await setup.testClaude() : await setup.testWhatsApp());
    }],

    ['GET', /^\/(index\.html)?$/, async (req, res) => {
      if (!indexPath) return send(res, 404, { error: 'No page configured' });
      const html = await readFile(indexPath);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    }],
  ];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/setup') && !LOOPBACK.has(req.socket.remoteAddress)) return send(res, 403, { error: 'Setup only works from the computer Agentdex runs on.' });
      if (req.method === 'POST' && !authorized(req)) return send(res, 401, { error: 'Missing or wrong bearer token' });
      for (const [method, re, handler] of routes) {
        const m = url.pathname.match(re);
        if (m && req.method === method) return await handler(req, res, m, url);
      }
      send(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
    } catch (err) {
      if (err instanceof StoreError) return send(res, err.status, { error: err.message });
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: 'Internal error' });
    }
  });

  server.on('close', () => { clearInterval(heartbeat); plans.close(); for (const r of clients) r.end(); });
  return server;
}
