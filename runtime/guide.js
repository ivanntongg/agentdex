// The Guide: you ask "? what should my team do today?" and it answers with a few concrete ideas,
// each a ready-made job for a named agent, using what it knows about your town: who is free,
// each agent's role and recent work, installed skills and what you asked it before.
// It can also suggest a new role when nobody on the team fits.
//
// It never starts work. Every idea comes back as a button you press yourself.
import { SPECIES } from '../server/species.js';
import { roleFor } from '../server/roles.js';

export const GUIDE_SYSTEM = `You are the Guide in Agentdex, a pixel town where the user's AI agents live and work. The user is often not technical. Help them get real value from their team.

What agents can do: read and write files in one workspace folder on the user's computer, search the web if their role allows it, use installed skills, remember their past tasks, and ask the user YES / NO before anything risky. What they cannot do: run programs, post online, send email, or use apps on the computer. So suggest work that ends in text or files: research, writing, plans, scripts, checklists, comparisons, summaries.

How to answer:
- Plain, warm, short: 2 to 5 sentences. No jargon, no headings, no markdown.
- Answer the question first. If they ask how something works, explain it simply.
- When it helps, suggest up to 3 concrete jobs. Each names one agent from the party (exact name) whose role fits, and is one clear sentence that agent could start on straight away, specific to what the user seems to care about. Prefer free agents. Never give jobs to the reviewer.
- If the user wants something no agent's role covers, suggest a new role: a short name and its job in 2 sentences. Otherwise leave newRole empty.
- Do not invent agents, skills or past work that are not listed.`;

export const GUIDE_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    suggestions: {
      type: 'array',
      items: { type: 'object', properties: { agent: { type: 'string' }, task: { type: 'string' } }, required: ['agent', 'task'], additionalProperties: false },
    },
    newRole: {
      type: 'object',
      properties: { name: { type: 'string' }, job: { type: 'string' } },
      required: ['name', 'job'],
      additionalProperties: false,
    },
  },
  required: ['reply', 'suggestions', 'newRole'],
  additionalProperties: false,
};

const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

// What the Guide is told about the town.
export function townBrief({ agents, approvals = 0, skills = [], recent = [], history = [] }) {
  const party = agents.filter((a) => !a.boxed);
  const lines = party.map((a) => {
    const sp = SPECIES[a.species];
    const role = sp?.custom ? sp.title : (sp?.types || []).join('/').toLowerCase();
    const r = roleFor(sp);
    const now = a.status === 'FNT' ? 'fainted' : a.status === 'PAR' ? 'waiting for the user' : a.task ? `busy with "${clip(a.task.title, 60)}"` : 'free';
    const mem = (a.memory || []).slice(-3).map((m) => `"${clip(m.title, 50)}"`).join(', ');
    return `- ${a.nick} (${role}${sp?.reviewer ? ', reviewer only' : ''}, ${r.web ? 'can search the web' : 'no web'}): ${now}. Job: ${clip(r.job, 160)}${mem ? ` Recently did: ${mem}.` : ''}`;
  });
  const boxed = agents.filter((a) => a.boxed).map((a) => a.nick);
  return [
    `Party:\n${lines.join('\n') || '(nobody)'}`,
    boxed.length ? `In the box (switched off): ${boxed.join(', ')}` : '',
    `Installed skills: ${skills.length ? skills.map((s) => `${s.name} (${clip(s.description || '', 80)})`).join('; ') : 'none'}`,
    approvals ? `${approvals} YES / NO question(s) are waiting for the user.` : '',
    recent.length ? `Recent events:\n${recent.map((m) => `- ${clip(m, 140)}`).join('\n')}` : '',
    history.length ? `Earlier in this conversation with the Guide:\n${history.map((h) => `${h.from === 'you' ? 'User' : 'Guide'}: ${clip(h.text, 300)}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

// ask({ system, prompt, schema, agentId, signal, effort }) -> parsed object or null
export function createGuide({ dex, ask, agents, skills = null, approvals = () => 0, log = console.log }) {
  const history = []; // last few exchanges, so follow-up questions make sense
  const recent = [];  // last field log lines

  function remember(event) {
    if (event.type === 'guide.asked') history.push({ from: 'you', text: event.data.text });
    else if (event.type === 'guide.answered') history.push({ from: 'guide', text: event.data.text });
    if (history.length > 8) history.splice(0, history.length - 8);
    if (event.message && !event.type.startsWith('guide.')) { recent.push(event.message); if (recent.length > 15) recent.shift(); }
  }

  async function answer(question, via = null) {
    try {
      const list = [...agents()];
      const brief = townBrief({
        agents: list,
        approvals: approvals(),
        skills: skills ? await skills.list().catch(() => []) : [],
        recent: recent.slice(-12),
        history: history.slice(0, -1), // the question itself is sent below
      });
      const out = await ask({ system: GUIDE_SYSTEM, schema: GUIDE_SCHEMA, agentId: null, effort: 'medium', prompt: `${brief}\n\nThe user asks the Guide: ${question}` });
      if (!out || !String(out.reply || '').trim()) throw new Error('Claude did not answer. Check SETUP, then ask again.');
      const party = list.filter((a) => !a.boxed);
      const suggestions = (out.suggestions || []).slice(0, 3).flatMap((s) => {
        const a = party.find((x) => x.nick.toUpperCase() === String(s.agent || '').replace(/^@/, '').trim().toUpperCase());
        return a && !SPECIES[a.species]?.reviewer && String(s.task || '').trim() ? [{ agentId: a.id, task: String(s.task).trim() }] : [];
      });
      const nr = out.newRole && String(out.newRole.name || '').trim() && String(out.newRole.job || '').trim().length >= 20 ? out.newRole : null;
      await dex.emit('guide.answered', null, { text: String(out.reply).trim(), suggestions, newRole: nr, via });
    } catch (err) {
      log(`[Guide] ${err.message}`);
      await dex.emit('guide.failed', null, { reason: err.message, via }).catch(() => {});
    }
  }

  return { answer, remember, history };
}
