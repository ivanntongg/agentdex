// The single source of truth. Every change to the world is an event passed to apply().
// apply() validates it, updates state, writes a human-readable log line and notifies subscribers.
// See docs/EVENTS.md for the protocol.
import { SPECIES, BUILDINGS, PARTY_MAX, hpMaxFor, xpToNext } from './species.js';
import { normalizeRole, defineRole, removeRole, editBuiltin, resetBuiltin, rolesState, loadRoles, customIdFor, RoleError } from './roles.js';

export const EVENT_TYPES = [
  'agent.spawned', 'agent.moved', 'agent.status', 'agent.fainted', 'agent.reset',
  'agent.boxed', 'agent.unboxed', 'agent.interacted', 'agent.leveled', 'agent.renamed',
  'chat.sent', 'chat.replied', 'chat.failed', 'files.added',
  'task.assigned', 'task.started', 'task.progress', 'task.handoff', 'task.finished',
  'review.started', 'review.finished',
  'approval.requested', 'approval.resolved',
  'skills.updated',
  'role.saved', 'role.deleted',
  'guide.asked', 'guide.answered', 'guide.failed',
];

export class StoreError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const LOG_LIMIT = 200;
const clone = (o) => structuredClone(o);

export function createStore() {
  const agents = new Map();
  const approvals = new Map();
  const chats = new Map(); // agentId -> [{ id, from: 'you' | 'agent', text, ts, via, suggestedTask }]
  let nextChatId = 1;
  const CHAT_LIMIT = 60;
  const MEMORY_LIMIT = 20;
  let skills = []; // installed community skills, mirrored from the runtime (the files on disk are the truth)
  const log = [];
  const subscribers = new Set();
  let seq = 0;
  let nextAgentId = 1;
  let nextApprovalId = 1;

  const party = () => [...agents.values()].filter((a) => !a.boxed);

  function resolveAgent(idOrRef, { required = true } = {}) {
    if (idOrRef === undefined || idOrRef === null) {
      if (required) throw new StoreError(400, 'agentId is required');
      return null;
    }
    const byId = agents.get(Number(idOrRef));
    if (byId) return byId;
    const byRef = [...agents.values()].find((a) => a.ref && a.ref === String(idOrRef));
    if (byRef) return byRef;
    if (required) throw new StoreError(404, `No agent with id or ref "${idOrRef}"`);
    return null;
  }

  function snapshot() {
    return {
      seq,
      agents: [...agents.values()].map(clone),
      approvals: [...approvals.values()].map(clone),
      log: log.slice(-100).map(clone),
      chats: Object.fromEntries([...chats].map(([id, list]) => [id, list.map(clone)])),
      skills: skills.map(clone),
      roles: rolesState(),
    };
  }

  function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  function pushChat(agentId, entry) {
    if (!chats.has(agentId)) chats.set(agentId, []);
    const list = chats.get(agentId);
    list.push(entry);
    if (list.length > CHAT_LIMIT) list.splice(0, list.length - CHAT_LIMIT);
  }

  // A custom role's agents are named after its first word (VIDEO, VIDEO-2), so @video works.
  function defaultNick(sp) {
    const s = SPECIES[sp];
    if (!s.custom) return s.name;
    const base = s.types[0].slice(0, 9);
    const taken = new Set([...agents.values()].map((x) => x.nick));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }

  function dropApprovalsFor(agentId) {
    for (const [id, ap] of approvals) if (ap.agentId === agentId) approvals.delete(id);
  }

  function releaseReviewer(agent, touched) {
    for (const r of agents.values()) {
      if (r.reviewingId === agent.id) { r.reviewingId = null; r.status = 'SLP'; touched.add(r); }
    }
  }

  // Applies one event. Returns the stored event. Follow-up events (level ups, evolution requests)
  // are applied after it and get their own sequence numbers.
  function apply(input) {
    const { type, data = {} } = input || {};
    if (!EVENT_TYPES.includes(type)) throw new StoreError(400, `Unknown event type "${type}"`);

    const event = { id: 0, ts: new Date().toISOString(), type, agentId: null, data: clone(data), message: null, tone: 'info' };
    const touched = new Set();
    const followUps = [];
    let a = null;

    if (!['agent.spawned', 'files.added', 'skills.updated', 'role.saved', 'role.deleted', 'guide.asked', 'guide.answered', 'guide.failed'].includes(type)) {
      a = resolveAgent(input.agentId);
      event.agentId = a.id;
      touched.add(a);
    }

    switch (type) {
      case 'agent.spawned': {
        const sp = data.species;
        if (!SPECIES[sp]) throw new StoreError(400, `Unknown species "${sp}"`);
        const boxed = Boolean(data.boxed);
        if (!boxed && party().length >= PARTY_MAX) throw new StoreError(409, 'Party is full. Send an agent to the box first.');
        if (data.ref && resolveAgent(data.ref, { required: false })) throw new StoreError(409, `An agent with ref "${data.ref}" already exists`);
        const lv = Number.isInteger(data.lv) ? data.lv : 5;
        const hpMax = hpMaxFor(sp, lv);
        a = {
          id: nextAgentId++, ref: data.ref || null, species: sp, nick: data.nick || defaultNick(sp),
          lv, xp: data.xp || 0, hp: Math.min(hpMax, data.hp ?? hpMax), hpMax,
          status: 'SLP', phase: 'idle', loc: BUILDINGS.includes(data.loc) ? data.loc : (boxed ? SPECIES[sp].home : 'CENTER'),
          task: null, moves: SPECIES[sp].moves.map(([n, pp]) => ({ n, pp, max: pp })),
          boxed, bond: 0, reviewingId: null, evolveAsked: false, chatting: false, memory: [],
        };
        agents.set(a.id, a);
        event.agentId = a.id;
        touched.add(a);
        if (!data.silent) {
          const kind = SPECIES[sp].title || SPECIES[sp].name;
          const who = a.nick === SPECIES[sp].name ? a.nick : `${a.nick} the ${kind}`;
          event.message = boxed ? `${a.nick} was stored in the BOX.` : `${who} appeared at the CENTER and joined your party at Lv ${lv}!`;
          event.tone = 'ok';
        }
        break;
      }

      case 'agent.moved': {
        if (!BUILDINGS.includes(data.to)) throw new StoreError(400, `Unknown building "${data.to}"`);
        a.loc = data.to;
        if (data.reason) event.message = `${a.nick} ${data.reason}`;
        break;
      }

      case 'task.assigned': {
        if (!data.title) throw new StoreError(400, 'task.assigned needs data.title');
        if (a.boxed) throw new StoreError(409, `${a.nick} is in the box. Move it to the party first.`);
        event.data.title = String(data.title).slice(0, 200);
        event.message = `You gave ${a.nick} a task: "${event.data.title}".`;
        break;
      }

      case 'task.started': {
        if (!data.title) throw new StoreError(400, 'task.started needs data.title');
        a.task = {
          title: String(data.title),
          review: Boolean(data.review),
          approval: data.approval ? { tool: String(data.approval.tool), target: String(data.approval.target) } : null,
        };
        a.phase = 'work';
        if (a.status !== 'PSN') a.status = 'OK';
        event.message = `${a.nick} took a task: "${a.task.title}".`;
        break;
      }

      case 'task.progress': {
        const tokens = Math.max(0, Number(data.tokens) || 0);
        a.hp = Math.max(0, Math.round((a.hp - tokens) * 10) / 10);
        if (data.tool) { const mv = a.moves.find((m) => m.n === data.tool); if (mv && mv.pp > 0) mv.pp--; }
        if (a.hp === 0 && a.status !== 'FNT') faint(a, event, touched);
        break;
      }

      case 'task.handoff': {
        if (!a.task) throw new StoreError(409, `${a.nick} has no task to hand off`);
        const r = data.reviewerId ? resolveAgent(data.reviewerId) : null;
        a.phase = 'handoff';
        event.message = `${a.nick} handed "${a.task.title}" to ${r ? r.nick : 'review'}.`;
        break;
      }

      case 'review.started': {
        if (!a.task) throw new StoreError(409, `${a.nick} has no task to review`);
        const r = resolveAgent(data.reviewerId);
        r.reviewingId = a.id; r.status = 'OK'; touched.add(r);
        a.phase = 'review';
        event.message = `${r.nick} is reviewing "${a.task.title}".`;
        break;
      }

      case 'review.finished': {
        if (!a.task) throw new StoreError(409, `${a.nick} has no task under review`);
        const r = data.reviewerId ? resolveAgent(data.reviewerId) : null;
        if (r) { r.reviewingId = null; r.status = 'SLP'; touched.add(r); gainXP(r, 25, followUps); }
        if (data.result === 'changes') {
          a.task.review = false;
          a.phase = 'work';
          const n = data.issues || 2;
          event.message = `${r ? r.nick : 'Review'} found ${n} issue${n === 1 ? '' : 's'}. ${a.nick} is heading back to fix them.`;
          event.tone = 'bad';
        } else {
          a.phase = 'work';
          event.message = `${r ? r.nick : 'Review'} approved "${a.task.title}".`;
          event.tone = 'ok';
        }
        break;
      }

      case 'role.saved': {
        try {
          if (data.type) {
            editBuiltin(data.type, data);
            event.data = { type: data.type, job: data.job, web: data.type === 'QA' ? false : Boolean(data.web) };
            event.message = `You rewrote the ${data.type} role. Agents use it from their next task.`;
          } else {
            const r = data.role || {};
            const editing = r.id && SPECIES[r.id]?.custom;
            if (r.id && !editing) throw new StoreError(404, 'That role no longer exists.');
            const id = editing ? r.id : customIdFor(r.name);
            if (!editing && SPECIES[id]) throw new StoreError(409, 'A role with that name already exists. Pick another name.');
            const { species } = normalizeRole(r, { id });
            defineRole(id, species);
            event.data = { role: { id, name: species.title, job: species.job, web: species.web, home: species.home, look: species.look, label: species.types[0] } };
            event.message = editing ? `You updated the ${species.title} role.` : `New role: ${species.title}. Spawn one from the Dex.`;
          }
        } catch (err) {
          if (err instanceof RoleError) throw new StoreError(400, err.message);
          throw err;
        }
        event.tone = 'ok';
        break;
      }

      // The Guide: ask it what your team could do. It answers with ideas and ready-made jobs.
      case 'guide.asked': {
        const text = String(data.text || '').trim().slice(0, 1000);
        if (!text) throw new StoreError(400, 'Ask the Guide something, like: what should my team do today?');
        event.data = { text, via: data.via || null };
        event.message = `You asked the Guide: "${text.length > 80 ? text.slice(0, 79) + '…' : text}"`;
        break;
      }
      case 'guide.answered': {
        const text = String(data.text || '').trim().slice(0, 3000);
        if (!text) throw new StoreError(400, 'guide.answered needs data.text');
        const suggestions = (Array.isArray(data.suggestions) ? data.suggestions : []).slice(0, 4).flatMap((x) => {
          const who = resolveAgent(x.agentId ?? x.nick, { required: false });
          const task = String(x.task || '').trim().slice(0, 200);
          return who && task ? [{ agentId: who.id, nick: who.nick, task }] : [];
        });
        const nr = data.newRole && String(data.newRole.name || '').trim() ? { name: String(data.newRole.name).trim().slice(0, 24), job: String(data.newRole.job || '').trim().slice(0, 2000) } : null;
        event.data = { text, suggestions, newRole: nr, via: data.via || null };
        event.message = `Guide: ${text.length > 120 ? text.slice(0, 119) + '…' : text}`;
        break;
      }
      case 'guide.failed': {
        event.data = { reason: String(data.reason || 'something went wrong').slice(0, 300), via: data.via || null };
        event.message = `The Guide couldn't answer: ${event.data.reason}`;
        event.tone = 'bad';
        break;
      }

      case 'role.deleted': {
        if (data.type) {
          resetBuiltin(data.type);
          event.data = { type: data.type };
          event.message = `The ${data.type} role is back to how it came.`;
          break;
        }
        const s = SPECIES[data.id];
        if (!s?.custom) throw new StoreError(404, 'That role no longer exists.');
        const users = [...agents.values()].filter((x) => x.species === data.id);
        if (users.length) throw new StoreError(409, `${users.map((x) => x.nick).join(', ')} ${users.length === 1 ? 'is' : 'are'} ${s.title}. A role cannot be deleted while agents have it; edit it instead.`);
        removeRole(data.id);
        event.data = { id: data.id };
        event.message = `You deleted the ${s.title} role.`;
        break;
      }

      case 'skills.updated': {
        if (!Array.isArray(data.skills)) throw new StoreError(400, 'skills.updated needs data.skills');
        const str = (v, n) => String(v ?? '').slice(0, n);
        skills = data.skills.slice(0, 100).map((x) => ({
          slug: str(x.slug, 40), name: str(x.name, 64), description: str(x.description, 400), source: str(x.source, 120),
          url: str(x.url, 300), by: x.by ? str(x.by, 12) : null, installedAt: str(x.installedAt, 40),
          review: x.review ? { by: str(x.review.by, 12), verdict: str(x.review.verdict, 12), summary: str(x.review.summary, 300) } : null,
        }));
        event.data = { count: skills.length };
        event.message = data.note ? str(data.note, 300) : null;
        if (data.tone) event.tone = ['ok', 'bad', 'need', 'info'].includes(data.tone) ? data.tone : 'info';
        break;
      }

      case 'approval.requested': {
        const kind = ['evolve', 'skill'].includes(data.kind) ? data.kind : 'tool';
        const ap = { id: nextApprovalId++, agentId: a.id, kind, createdAt: event.ts };
        if (kind === 'tool') {
          const tool = data.tool || a.task?.approval?.tool;
          const target = data.target || a.task?.approval?.target;
          if (!tool || !target) throw new StoreError(400, 'approval.requested needs data.tool and data.target');
          Object.assign(ap, { tool, target, taskTitle: a.task?.title || null });
          a.status = 'PAR'; a.phase = 'wait';
          event.message = `${a.nick} needs you: it wants to use ${tool} on ${target}.`;
        } else if (kind === 'skill') {
          const s = data.skill || {};
          if (!s.id || !s.name || !s.source) throw new StoreError(400, 'A skill request needs data.skill with id, name and source');
          const str = (v, n) => String(v ?? '').slice(0, n);
          ap.skill = {
            id: str(s.id, 200), name: str(s.name, 64), description: str(s.description, 400), source: str(s.source, 120), url: str(s.url, 300),
            installs: Number(s.installs) || 0,
            flags: (Array.isArray(s.flags) ? s.flags : []).slice(0, 8).map((f) => ({ level: str(f.level, 8), text: str(f.text, 160) })),
            review: s.review ? { by: str(s.review.by, 12), verdict: str(s.review.verdict, 12), summary: str(s.review.summary, 300) } : null,
          };
          ap.taskTitle = a.task?.title || null;
          a.status = 'PAR'; a.phase = 'wait';
          const r = ap.skill.review;
          event.data.skill = clone(ap.skill);
          event.message = `${a.nick} wants to learn the skill "${ap.skill.name}" from ${ap.skill.source}.${r ? ` ${r.by || 'Review'}: ${r.summary || r.verdict}` : ' Nobody reviewed it, so read it before you say YES.'}`;
        } else {
          const evo = SPECIES[a.species].evolve;
          if (!evo) throw new StoreError(409, `${a.nick} cannot evolve`);
          Object.assign(ap, { to: evo.to, toName: SPECIES[evo.to].name });
          a.evolveAsked = true;
          event.message = `${a.nick} is ready to evolve into ${SPECIES[evo.to].name}. It needs your OK.`;
        }
        approvals.set(ap.id, ap);
        event.data.approvalId = ap.id;
        event.tone = 'need';
        break;
      }

      case 'approval.resolved': {
        const ap = approvals.get(Number(data.approvalId));
        if (!ap || ap.agentId !== a.id) throw new StoreError(404, `No open approval ${data.approvalId} for ${a.nick}`);
        if (!['yes', 'no'].includes(data.decision)) throw new StoreError(400, 'decision must be "yes" or "no"');
        approvals.delete(ap.id);
        event.data.kind = ap.kind;
        const yes = data.decision === 'yes';
        if (ap.kind === 'tool') {
          const mv = a.moves.find((m) => m.n === ap.tool);
          if (yes && mv && mv.pp > 0) mv.pp--;
          a.status = 'OK'; a.phase = 'work';
          event.message = yes ? `You allowed ${ap.tool}. ${a.nick} used ${ap.tool} on ${ap.target}!` : `You declined ${ap.tool}.`;
          event.tone = yes ? 'ok' : 'info';
          Object.assign(event.data, { tool: ap.tool, target: ap.target });
        } else if (ap.kind === 'skill') {
          if (a.task) { a.status = 'OK'; a.phase = 'work'; } else { a.status = 'SLP'; a.phase = 'idle'; }
          event.data.skill = { id: ap.skill.id, name: ap.skill.name };
          event.message = yes ? `${a.nick} is learning "${ap.skill.name}".` : `You said no to "${ap.skill.name}". ${a.nick} carries on without it.`;
          event.tone = yes ? 'ok' : 'info';
        } else if (yes) {
          const from = SPECIES[a.species].name;
          a.species = ap.to;
          a.hpMax = hpMaxFor(a.species, a.lv); a.hp = a.hpMax;
          a.moves = SPECIES[a.species].moves.map(([n, pp]) => ({ n, pp, max: pp }));
          event.message = `Congratulations! ${a.nick} evolved from ${from} into ${SPECIES[a.species].name}!`;
          event.tone = 'lvl';
          event.data.to = a.species;
        } else {
          event.message = `${a.nick} stopped evolving. It stays on its current model.`;
        }
        break;
      }

      case 'task.finished': {
        const t = a.task;
        a.task = null; a.phase = 'idle'; a.status = 'SLP';
        if (data.outcome === 'declined') {
          event.message = `${a.nick} stood down and left a note instead.`;
        } else {
          const xp = Number.isInteger(data.xp) ? data.xp : 60;
          // What the agent remembers about its own work, used in later tasks and chats.
          if (!Array.isArray(a.memory)) a.memory = [];
          a.memory.push({
            title: t ? t.title : 'a task', note: data.note ? String(data.note).replace(/\s+/g, ' ').slice(0, 400) : '',
            files: Array.isArray(data.files) ? data.files.slice(0, 12).map(String) : [], ts: event.ts,
          });
          if (a.memory.length > MEMORY_LIMIT) a.memory.splice(0, a.memory.length - MEMORY_LIMIT);
          const note = data.note ? ` ${String(data.note).replace(/\s+/g, ' ').slice(0, 160)}` : '';
          event.message = `${a.nick} finished "${t ? t.title : 'its task'}". +${xp} XP${note}`;
          event.tone = 'ok';
          gainXP(a, xp, followUps);
        }
        break;
      }

      case 'agent.status': {
        const allowed = ['OK', 'SLP', 'CNF', 'PSN'];
        if (!allowed.includes(data.status)) throw new StoreError(400, `status must be one of ${allowed.join(', ')}`);
        const prev = a.status;
        a.status = data.status;
        if (data.status === 'CNF') { event.message = `${a.nick} is confused! ${data.reason || 'It is repeating the same step.'}`; event.tone = 'bad'; }
        else if (data.status === 'PSN') { event.message = `${a.nick} is poisoned! ${data.reason || 'It is spending tokens much faster than usual.'}`; event.tone = 'bad'; }
        else if (prev === 'CNF') { event.message = `${a.nick} snapped out of it and tried a different approach.`; event.tone = 'ok'; }
        else if (prev === 'PSN') { event.message = `${a.nick}'s budget is back to normal.`; event.tone = 'ok'; }
        break;
      }

      case 'agent.fainted':
        faint(a, event, touched, data.reason);
        break;

      case 'agent.reset': {
        releaseReviewer(a, touched);
        dropApprovalsFor(a.id);
        a.hp = a.hpMax; a.status = 'SLP'; a.phase = 'idle'; a.task = null; a.loc = 'CENTER'; a.reviewingId = null; a.chatting = false;
        a.moves.forEach((m) => { m.pp = m.max; });
        event.message = `${a.nick}'s session was reset at the CENTER. Context cleared, HP restored.`;
        event.tone = 'ok';
        break;
      }

      case 'agent.boxed': {
        if (a.boxed) throw new StoreError(409, `${a.nick} is already in the box`);
        releaseReviewer(a, touched);
        dropApprovalsFor(a.id);
        Object.assign(a, { boxed: true, task: null, phase: 'idle', status: 'SLP', reviewingId: null, chatting: false });
        event.message = `${a.nick} went into the BOX. It stops running and costs nothing.`;
        break;
      }

      case 'agent.unboxed': {
        if (!a.boxed) throw new StoreError(409, `${a.nick} is not in the box`);
        if (party().length >= PARTY_MAX) throw new StoreError(409, 'Party is full. Send an agent to the box first.');
        Object.assign(a, { boxed: false, loc: 'CENTER', status: 'SLP', phase: 'idle' });
        event.message = `${a.nick} left the box and joined your party.`;
        break;
      }

      case 'agent.interacted': {
        if (!['pet', 'poke'].includes(data.action)) throw new StoreError(400, 'action must be "pet" or "poke"');
        if (data.action === 'pet' && a.status !== 'FNT') {
          a.bond = Math.min(5, a.bond + 1);
          if (a.status === 'CNF') a.status = 'OK';
        }
        event.message = data.message || null;
        event.tone = data.tone || 'info';
        break;
      }

      case 'chat.sent': {
        const text = String(data.text || '').trim().slice(0, 2000);
        if (!text) throw new StoreError(400, 'Say something first.');
        if (a.boxed) throw new StoreError(409, `${a.nick} is in the box. Move it to the party to talk.`);
        if (a.chatting) throw new StoreError(409, `${a.nick} is still answering your last message.`);
        const entry = { id: nextChatId++, from: 'you', text, ts: event.ts, via: data.via === 'whatsapp' ? 'whatsapp' : 'town' };
        pushChat(a.id, entry);
        a.chatting = true;
        event.data = { entry, via: entry.via };
        event.message = `You to ${a.nick}: "${text.length > 120 ? text.slice(0, 119) + '…' : text}"`;
        break;
      }

      case 'chat.replied': {
        const text = String(data.text || '').trim().slice(0, 4000) || '...';
        const task = data.suggestedTask ? String(data.suggestedTask).trim().slice(0, 200) : null;
        const entry = { id: nextChatId++, from: 'agent', text, ts: event.ts, via: data.via === 'whatsapp' ? 'whatsapp' : 'town', suggestedTask: task || null };
        pushChat(a.id, entry);
        a.chatting = false;
        event.data = { entry, via: entry.via };
        event.message = `${a.nick}: "${text.length > 160 ? text.slice(0, 159) + '…' : text}"`;
        break;
      }

      case 'chat.failed': {
        a.chatting = false;
        event.message = `${a.nick} couldn't reply. ${data.reason || ''}`.trim();
        event.tone = 'bad';
        event.data = { reason: data.reason || null, via: data.via === 'whatsapp' ? 'whatsapp' : 'town' };
        break;
      }

      case 'files.added': {
        const names = (Array.isArray(data.files) ? data.files : []).map(String).slice(0, 20);
        if (!names.length) throw new StoreError(400, 'files.added needs data.files');
        event.data = { files: names };
        event.message = names.length === 1 ? `You added ${names[0]} for your agents.` : `You added ${names.length} files for your agents: ${names.join(', ')}.`;
        event.tone = 'ok';
        break;
      }

      case 'agent.renamed': {
        const nick = String(data.nick || '').trim().toUpperCase();
        if (!/^[A-Z0-9][A-Z0-9_-]{1,11}$/.test(nick)) throw new StoreError(400, 'A name is one word of 2 to 12 letters or numbers (dashes and underscores are fine).');
        if ([...agents.values()].some((x) => x.id !== a.id && x.nick.toUpperCase() === nick)) throw new StoreError(409, `Another agent is already called ${nick}.`);
        const old = a.nick;
        a.nick = nick;
        event.data = { from: old, nick };
        event.message = old === nick ? null : `${old} is now called ${nick}.`;
        break;
      }

      case 'agent.leveled':
        event.message = `${a.nick} grew to Lv. ${a.lv}!`;
        event.tone = 'lvl';
        break;
    }

    event.id = ++seq;
    if (event.message) {
      log.push(event);
      if (log.length > LOG_LIMIT) log.shift();
    }
    const payload = { event: clone(event), agents: [...touched].map(clone), approvals: [...approvals.values()].map(clone) };
    for (const fn of subscribers) {
      try { fn(payload); } catch (err) { console.error('subscriber failed', err); }
    }
    for (const f of followUps) apply(f);
    return clone(event);
  }

  function faint(a, event, touched, reason) {
    releaseReviewer(a, touched);
    a.status = 'FNT'; a.phase = 'fainted';
    event.message = `${a.nick} fainted! ${reason || `It ran out of context mid-task on "${a.task ? a.task.title : 'work'}".`}`;
    event.tone = 'bad';
  }

  function gainXP(a, n, followUps) {
    a.xp += n;
    while (a.xp >= xpToNext(a.lv)) {
      a.xp -= xpToNext(a.lv);
      a.lv++;
      a.hpMax += 4;
      followUps.push({ type: 'agent.leveled', agentId: a.id });
    }
    const evo = SPECIES[a.species].evolve;
    if (evo && a.lv >= evo.lv && !a.evolveAsked) {
      a.evolveAsked = true;
      followUps.push({ type: 'approval.requested', agentId: a.id, data: { kind: 'evolve' } });
    }
  }

  // Everything needed to bring the town back after a restart.
  function serialize() {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      counters: { seq, nextAgentId, nextApprovalId, nextChatId },
      agents: [...agents.values()].map(clone),
      chats: Object.fromEntries([...chats].map(([id, list]) => [id, list.map(clone)])),
      log: log.map(clone),
      roles: rolesState({ withDefaults: false }),
    };
  }

  // Loads a saved town. Work that was running cannot continue (its process is gone), so agents
  // come back free and the log says what was interrupted. Open approvals are dropped with it.
  // Returns the titles of interrupted tasks.
  function restore(saved) {
    if (!saved || saved.version !== 1 || !Array.isArray(saved.agents)) throw new Error('Not an Agentdex save file');
    agents.clear(); approvals.clear(); chats.clear(); log.length = 0;
    loadRoles(saved.roles); // before agents, so agents of a custom role come back
    const interrupted = [];
    for (const raw of saved.agents) {
      if (!raw || !SPECIES[raw.species] || !Number.isInteger(raw.id)) continue;
      const a = clone(raw);
      if (a.task) interrupted.push({ nick: a.nick, title: a.task.title });
      if (a.chatting) interrupted.push({ nick: a.nick, chat: true });
      Object.assign(a, { task: null, phase: 'idle', status: a.status === 'FNT' ? 'FNT' : 'SLP', reviewingId: null, chatting: false });
      agents.set(a.id, a);
    }
    for (const [id, list] of Object.entries(saved.chats || {})) {
      if (agents.has(Number(id)) && Array.isArray(list)) chats.set(Number(id), list.slice(-CHAT_LIMIT));
    }
    for (const e of (saved.log || []).slice(-LOG_LIMIT)) log.push(e);
    const c = saved.counters || {};
    const maxId = Math.max(0, ...agents.keys());
    seq = Math.max(Number(c.seq) || 0, ...log.map((e) => e.id || 0));
    nextAgentId = Math.max(Number(c.nextAgentId) || 1, maxId + 1);
    nextApprovalId = Number(c.nextApprovalId) || 1;
    nextChatId = Number(c.nextChatId) || 1;
    return interrupted;
  }

  // Adds a line to the field log without changing any agent (used after a restore).
  function note(message, tone = 'info') {
    const event = { id: ++seq, ts: new Date().toISOString(), type: 'town.note', agentId: null, data: {}, message, tone };
    log.push(event);
    if (log.length > LOG_LIMIT) log.shift();
    for (const fn of subscribers) { try { fn({ event: clone(event), agents: [], approvals: [...approvals.values()].map(clone) }); } catch { /* ignore */ } }
  }

  return { apply, snapshot, subscribe, resolveAgent, party, agents, approvals, chats, serialize, restore, note };
}
