// HTTP API. No dependencies: node:http plus Server-Sent Events.
//
//   GET  /api/state                      full snapshot
//   GET  /api/events                     live stream (SSE): "snapshot" once, then "change" per event
//   POST /api/approvals/:id              { decision: "yes" | "no" }
//   POST /api/agents                     { species, nick? }            spawn into the party
//   POST /api/agents/:id/actions         { action: pet | poke | reset | box | unbox }
//   POST /api/agents/:id/tasks           { title, details?, review? }   give an agent work
//   POST /api/ingest                     one event or an array, from a real agent runtime
//   GET  /                               the town (index.html)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { StoreError } from './store.js';

const MAX_BODY = 64 * 1024;

export function createApp({ store, adapter = null, token = null, indexPath = null }) {
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
      const ap = store.approvals.get(Number(id));
      if (!ap) throw new StoreError(404, `No open approval ${id}`);
      const event = store.apply({ type: 'approval.resolved', agentId: ap.agentId, data: { approvalId: ap.id, decision } });
      adapter?.onApproval?.(ap, decision);
      send(res, 200, { event });
    }],

    ['POST', /^\/api\/agents$/, async (req, res) => {
      const { species, nick } = await readJSON(req);
      const event = store.apply({ type: 'agent.spawned', data: { species, nick } });
      send(res, 201, { event, agent: store.resolveAgent(event.agentId) });
    }],

    ['POST', /^\/api\/agents\/([^/]+)\/actions$/, async (req, res, [, id]) => {
      const { action } = await readJSON(req);
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
          if (a.boxed) throw new StoreError(409, `${a.nick} is in the box`);
          if (adapter?.onReset) adapter.onReset(a);
          else event = store.apply({ type: 'agent.reset', agentId: a.id });
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
          throw new StoreError(400, 'action must be one of pet, poke, reset, box, unbox');
      }
      send(res, 200, { event, agent: store.resolveAgent(a.id) });
    }],

    ['POST', /^\/api\/agents\/([^/]+)\/tasks$/, async (req, res, [, id]) => {
      const { title, details, review } = await readJSON(req);
      const a = store.resolveAgent(decodeURIComponent(id));
      const event = store.apply({ type: 'task.assigned', agentId: a.id, data: { title, details: details ? String(details).slice(0, 4000) : undefined, review: Boolean(review) } });
      adapter?.onAssigned?.(a, event.data);
      send(res, 200, { event });
    }],

    ['POST', /^\/api\/ingest$/, async (req, res) => {
      const body = await readJSON(req);
      const list = Array.isArray(body) ? body : [body];
      if (list.length > 100) throw new StoreError(413, 'Send at most 100 events per request');
      const events = list.map((e) => store.apply(e));
      send(res, 200, { events });
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
      if (req.method === 'POST' && !authorized(req)) return send(res, 401, { error: 'Missing or wrong bearer token' });
      for (const [method, re, handler] of routes) {
        const m = url.pathname.match(re);
        if (m && req.method === method) return await handler(req, res, m);
      }
      send(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
    } catch (err) {
      if (err instanceof StoreError) return send(res, err.status, { error: err.message });
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: 'Internal error' });
    }
  });

  server.on('close', () => { clearInterval(heartbeat); for (const r of clients) r.end(); });
  return server;
}
