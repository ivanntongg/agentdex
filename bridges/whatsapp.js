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
import { approvalText, statusTextFor, helpText, clip, NOTIFY } from './common.js';

const MAX_BODY = 1024 * 1024;

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
const HOUR = 3600_000;

// Meta's error codes, in words a person can act on.
export function graphError(e, status) {
  const code = e?.code;
  if (code === 190) return 'Your WhatsApp access token has expired or is wrong. Make a permanent token (step 2 in SETUP), paste it and save again.';
  if (code === 100 || code === 803) return 'The phone number ID is wrong, or this token cannot see it. Copy both again from API Setup in your Meta app.';
  if (code === 10 || code === 200) return 'The token is missing a permission. Give it whatsapp_business_messaging and whatsapp_business_management.';
  return `WhatsApp refused it (${status}${code ? `, code ${code}` : ''}): ${e?.message || 'no reason given'}`;
}

export function createWhatsAppBridge({ dex, config, fetchImpl = fetch, log = console.log }) {
  const allowed = new Set(String(config.allowed).split(',').map(digits).filter(Boolean));
  if (!allowed.size) throw new Error('WHATSAPP_ALLOWED must list at least one phone number, with country code');
  const graphUrl = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`;
  const agents = new Map();
  let approvals = [];
  const seen = new Set();
  let windowWarned = false;
  const health = { verifiedAt: null, lastMessageAt: null, lastSentAt: null, lastError: null, number: null, codesError: null };
  let reminded = null;
  let keepTimer = null;

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
    health.lastError = graphError(body?.error, res.status);
    log(health.lastError);
    throw new Error(health.lastError);
  }
  const text = (to, body) => send(to, { type: 'text', text: { body: clip(body, 4000) } });
  const buttons = (to, body, list) => send(to, {
    type: 'interactive',
    interactive: { type: 'button', body: { text: clip(body, 1000) }, action: { buttons: list.map(([id, title]) => ({ type: 'reply', reply: { id, title: clip(title, 20) } })) } },
  });
  const everyone = (fn) => Promise.all([...allowed].map((to) => fn(to).catch((err) => log(`WhatsApp: ${err.message}`))));

  const approvalPrompt = (ap) => approvalText(ap, agents);
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
    // Replies to chats that started on WhatsApp go back to WhatsApp.
    if ((event.type === 'chat.replied' || event.type === 'chat.failed') && event.data?.via === 'whatsapp') {
      const a = agents.get(event.agentId);
      const task = event.data.entry?.suggestedTask;
      const body = event.type === 'chat.replied'
        ? `${a ? a.nick : 'Agent'}: ${event.data.entry.text}${task && a ? `\n\nTo make it a task, send:\n${a.nick.toLowerCase()} ${task}` : ''}`
        : event.message;
      await everyone((to) => text(to, body));
      return;
    }
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
  const statusText = () => statusTextFor(party(), approvals);
  const HELP = helpText('WhatsApp');

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
    // Everything else (tasks with or without a name, reset, rename) goes through the same
    // command handler as the town's command bar.
    try {
      const r = await dex.post('/api/command', { text: body, via: 'whatsapp' });
      return text(from, r.reply || 'Done.');
    } catch (err) {
      return text(from, `Could not do that: ${err.message}`);
    }
  }

  async function handlePayload(payload) {
    for (const entry of payload?.entry || []) {
      for (const change of entry.changes || []) {
        for (const m of change.value?.messages || []) {
          if (seen.has(m.id)) continue; // Meta retries deliveries
          seen.add(m.id);
          if (seen.size > 1000) seen.delete(seen.values().next().value);
          if (!allowed.has(digits(m.from))) { log(`WhatsApp: ignored a message from a number that is not in WHATSAPP_ALLOWED`); continue; }
          health.lastMessageAt = new Date().toISOString(); // only your messages open WhatsApp's 24-hour window
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

  // Checks the token and phone number ID straight away, so a typo shows up in SETUP, not hours later.
  async function checkCodes() {
    try {
      const res = await fetchImpl(`https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}?fields=display_phone_number,verified_name`, { headers: { authorization: `Bearer ${config.token}` } });
      const body = await res.json().catch(() => ({}));
      if (res.ok) { health.number = { display: body.display_phone_number || null, name: body.verified_name || null }; health.codesError = null; return health.number; }
      health.number = null; health.codesError = graphError(body?.error, res.status); return null;
    } catch (err) {
      health.codesError = `Could not reach WhatsApp: ${err.message}`; return null;
    }
  }

  // WhatsApp lets the bot message you only within 24 hours of your last message. About an hour
  // before that closes, ask for a quick reply so alerts keep coming. Once per message from you.
  function keepAlive(now = Date.now()) {
    const last = health.lastMessageAt ? Date.parse(health.lastMessageAt) : null;
    if (!last || reminded === last) return false;
    const age = now - last;
    if (age < 22.5 * HOUR || age >= 23.9 * HOUR) return false;
    reminded = last;
    everyone((to) => text(to, 'Reply with anything (like "status") to keep getting Agentdex alerts here. WhatsApp only lets me message you for 24 hours after your last message.'));
    return true;
  }

  return {
    server,
    checkCodes,
    keepAlive,
    onSnapshot,
    onChange,
    handlePayload,
    start(signal) {
      dex.subscribe({ onSnapshot, onChange, signal, onError: (err) => log(`WhatsApp bridge lost the town (${err.message}); reconnecting.`) });
      keepTimer = setInterval(() => keepAlive(), 10 * 60_000);
      keepTimer.unref?.();
      return new Promise((r) => server.listen(config.port, '127.0.0.1', r));
    },
    stop: () => new Promise((r) => { clearInterval(keepTimer); server.closeAllConnections?.(); server.close(r); }),
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
