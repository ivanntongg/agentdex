// WhatsApp remote control for Agentdex, through Meta's official WhatsApp Business (Cloud) API.
//
// It runs its own small web server, separate from the town, so only this webhook is exposed to the
// internet (through a tunnel). Every request must carry Meta's signature, and only the phone numbers
// in WHATSAPP_ALLOWED can give orders. Everything else is ignored.
//
// From your phone:  "status", "help", "scout compare 3 note apps", "yes" / "no", "reset scout",
// and tap YES / NO on approval messages.
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_BODY = 1024 * 1024;
const NOTIFY = new Set(['approval.requested', 'task.finished', 'agent.fainted']);

export function whatsappConfigFromEnv(env = process.env) {
  if (!env.WHATSAPP_TOKEN) return null;
  const need = ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_ALLOWED'];
  const missing = need.filter((k) => !env[k]);
  if (missing.length) throw new Error(`WhatsApp is half set up. Also set: ${missing.join(', ')}`);
  return {
    token: env.WHATSAPP_TOKEN,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    appSecret: env.WHATSAPP_APP_SECRET,
    verifyToken: env.WHATSAPP_VERIFY_TOKEN,
    allowed: env.WHATSAPP_ALLOWED,
    apiVersion: env.WHATSAPP_API_VERSION || 'v23.0',
    port: Number(env.WHATSAPP_PORT || 8788),
  };
}

const digits = (s) => String(s || '').replace(/\D/g, '');
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function createWhatsAppBridge({ dex, config, fetchImpl = fetch, log = console.log }) {
  const allowed = new Set(String(config.allowed).split(',').map(digits).filter(Boolean));
  if (!allowed.size) throw new Error('WHATSAPP_ALLOWED must list at least one phone number, with country code');
  const graphUrl = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`;
  const agents = new Map();
  let approvals = [];
  const seen = new Set();
  let windowWarned = false;
  const health = { verifiedAt: null, lastMessageAt: null, lastSentAt: null, lastError: null };

  // ---------- sending ----------
  async function send(to, payload) {
    const res = await fetchImpl(graphUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload }),
    });
    if (res.ok) { windowWarned = false; health.lastSentAt = new Date().toISOString(); health.lastError = null; return; }
    const body = await res.json().catch(() => ({}));
    const code = body?.error?.code;
    if (code === 131047) {
      // WhatsApp only lets a business message you first within 24 hours of your last message.
      if (!windowWarned) log('WhatsApp: could not message you because you have not written to the bot in 24 hours. Send it any message (like "status") to reopen the window.');
      windowWarned = true;
      health.lastError = 'WhatsApp only lets the bot message you within 24 hours of your last message. Send the bot any message, like "status".';
      return;
    }
    health.lastError = `WhatsApp refused the message (${res.status}${code ? `, code ${code}` : ''}): ${body?.error?.message || res.statusText}`;
    log(health.lastError);
    throw new Error(health.lastError);
  }
  const text = (to, body) => send(to, { type: 'text', text: { body: clip(body, 4000) } });
  const buttons = (to, body, list) => send(to, {
    type: 'interactive',
    interactive: { type: 'button', body: { text: clip(body, 1000) }, action: { buttons: list.map(([id, title]) => ({ type: 'reply', reply: { id, title: clip(title, 20) } })) } },
  });
  const everyone = (fn) => Promise.all([...allowed].map((to) => fn(to).catch((err) => log(`WhatsApp: ${err.message}`))));

  const approvalPrompt = (ap) => {
    const a = agents.get(ap.agentId);
    const who = a ? a.nick : 'An agent';
    return ap.kind === 'evolve'
      ? `${who} is ready to evolve into ${ap.toName}: a bigger model with more permissions. Allow it?`
      : `${who} wants to use ${ap.tool} on ${ap.target}.${ap.taskTitle ? `\nTask: ${ap.taskTitle}` : ''}`;
  };
  const askApproval = (to, ap) => buttons(to, approvalPrompt(ap), [[`ap:${ap.id}:yes`, 'YES'], [`ap:${ap.id}:no`, 'NO']]);

  // ---------- following the town ----------
  function onSnapshot(s) {
    agents.clear();
    for (const a of s.agents) agents.set(a.id, a);
    approvals = s.approvals;
  }
  async function onChange({ event, agents: touched, approvals: open }) {
    for (const a of touched) agents.set(a.id, a);
    approvals = open;
    if (!NOTIFY.has(event.type)) return;
    if (event.type === 'approval.requested') {
      const ap = open.find((x) => x.id === event.data.approvalId);
      if (ap) await everyone((to) => askApproval(to, ap));
      return;
    }
    if (event.message) await everyone((to) => text(to, event.message));
  }

  // ---------- understanding your messages ----------
  const party = () => [...agents.values()].filter((a) => !a.boxed);
  const findAgent = (word) => {
    const w = word.replace(/^@/, '').replace(/[:,]$/, '').toUpperCase();
    return w ? party().find((a) => a.nick.toUpperCase() === w) : null;
  };
  const statusText = () => {
    const lines = party().map((a) => {
      const now = a.status === 'PAR' ? 'waiting for your OK'
        : a.status === 'FNT' ? 'fainted, needs a reset'
        : a.reviewingId ? 'reviewing'
        : a.task ? `working on "${clip(a.task.title, 60)}"` : 'idle';
      return `${a.nick} (Lv ${a.lv}): ${now}. HP ${Math.round(a.hp)}/${a.hpMax}`;
    });
    return [`Party (${lines.length})`, ...lines, approvals.length ? `${approvals.length} request(s) need you. Sending them now.` : 'Nothing needs you.'].join('\n');
  };
  const HELP = [
    'Agentdex remote control',
    '• status: what everyone is doing',
    '• scout compare 3 note apps: give SCOUT a task (any agent name works)',
    '• yes / no: answer the open request (or tap the buttons)',
    '• reset scout: clear an agent that fainted or got stuck',
  ].join('\n');

  async function resolve(from, approvalId, decision) {
    try {
      const r = await dex.post(`/api/approvals/${approvalId}`, { decision });
      await text(from, r.event.message || 'Done.');
    } catch (err) {
      await text(from, /No open approval/.test(err.message) ? 'That request was already answered.' : `Could not answer it: ${err.message}`);
    }
  }

  async function handleMessage(m) {
    const from = m.from;
    if (m.type === 'interactive' && m.interactive?.type === 'button_reply') {
      const match = /^ap:(\d+):(yes|no)$/.exec(m.interactive.button_reply.id || '');
      if (match) return resolve(from, Number(match[1]), match[2]);
      return;
    }
    if (m.type === 'button' && m.button?.payload) {
      const match = /^ap:(\d+):(yes|no)$/.exec(m.button.payload);
      if (match) return resolve(from, Number(match[1]), match[2]);
      return;
    }
    if (m.type !== 'text') return text(from, 'I can only read text messages for now.\n\n' + HELP);

    const body = (m.text?.body || '').trim();
    const lower = body.toLowerCase();
    if (!body || ['help', 'hi', 'hello', 'menu', '?'].includes(lower)) return text(from, HELP);
    if (lower === 'status') {
      await text(from, statusText());
      for (const ap of approvals) await askApproval(from, ap);
      return;
    }
    if (lower === 'yes' || lower === 'no') {
      if (approvals.length === 1) return resolve(from, approvals[0].id, lower);
      if (!approvals.length) return text(from, 'Nothing is waiting for an answer.');
      await text(from, `${approvals.length} requests are open. Tap YES or NO on the one you mean:`);
      for (const ap of approvals) await askApproval(from, ap);
      return;
    }
    const [first, ...rest] = body.split(/\s+/);
    if (first.toLowerCase() === 'reset' && rest.length) {
      const a = findAgent(rest[0]);
      if (!a) return text(from, `No agent called ${rest[0]} in your party. Send "status" to see names.`);
      try { await dex.post(`/api/agents/${a.id}/actions`, { action: 'reset' }); return text(from, `Resetting ${a.nick}.`); }
      catch (err) { return text(from, `Could not reset ${a.nick}: ${err.message}`); }
    }
    const a = findAgent(first);
    if (a) {
      const title = rest.join(' ').trim();
      if (!title) return text(from, `What should ${a.nick} do? For example: ${a.nick.toLowerCase()} write 5 title ideas for my GTA 6 video`);
      const review = party().some((r) => r.species === 'sentril' && r.status !== 'FNT');
      try {
        await dex.post(`/api/agents/${a.id}/tasks`, { title: clip(title, 200), review });
        return text(from, `${a.nick} is on it${review ? ', and CHECKS will review it' : ''}. I'll message you when it needs you or finishes.`);
      } catch (err) { return text(from, `${a.nick} could not take it: ${err.message}`); }
    }
    return text(from, `I didn't catch that. Start with an agent's name (${party().map((x) => x.nick).join(', ') || 'none yet'}).\n\n${HELP}`);
  }

  async function handlePayload(payload) {
    for (const entry of payload?.entry || []) {
      for (const change of entry.changes || []) {
        for (const m of change.value?.messages || []) {
          if (seen.has(m.id)) continue; // Meta retries deliveries
          health.lastMessageAt = new Date().toISOString();
          seen.add(m.id);
          if (seen.size > 1000) seen.delete(seen.values().next().value);
          if (!allowed.has(digits(m.from))) { log(`WhatsApp: ignored a message from a number that is not in WHATSAPP_ALLOWED`); continue; }
          try { await handleMessage(m); } catch (err) { log(`WhatsApp: ${err.message}`); }
        }
      }
    }
  }

  // ---------- webhook server ----------
  function validSignature(raw, header) {
    if (!header || !header.startsWith('sha256=')) return false;
    const want = Buffer.from('sha256=' + createHmac('sha256', config.appSecret).update(raw).digest('hex'));
    const got = Buffer.from(header);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/webhooks/whatsapp') { res.writeHead(404).end(); return; }
    if (req.method === 'GET') {
      // Meta's one-time check when you save the webhook URL.
      const ok = url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === config.verifyToken;
      res.writeHead(ok ? 200 : 403, { 'content-type': 'text/plain' }).end(ok ? url.searchParams.get('hub.challenge') || '' : 'Forbidden');
      if (ok) { health.verifiedAt = new Date().toISOString(); log('WhatsApp: webhook verified by Meta.'); }
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const chunks = [];
    let size = 0;
    for await (const c of req) { size += c.length; if (size > MAX_BODY) { res.writeHead(413).end(); return; } chunks.push(c); }
    const raw = Buffer.concat(chunks);
    if (!validSignature(raw, req.headers['x-hub-signature-256'])) { res.writeHead(401).end(); return; }
    res.writeHead(200).end(); // answer Meta at once; work after
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { return; }
    await handlePayload(payload);
  });

  return {
    server,
    onSnapshot,
    onChange,
    handlePayload,
    start(signal) {
      dex.subscribe({ onSnapshot, onChange, signal, onError: (err) => log(`WhatsApp bridge lost the town (${err.message}); reconnecting.`) });
      return new Promise((r) => server.listen(config.port, '127.0.0.1', r));
    },
    stop: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    health: () => ({ ...health }),
    // Sends a hello to every allowed number. Throws with WhatsApp's reason if it fails.
    async sendTest() {
      for (const to of allowed) {
        await text(to, 'Agentdex is connected. Send "help" to see what I can do.');
        if (windowWarned) throw new Error(health.lastError);
      }
    },
  };
}
