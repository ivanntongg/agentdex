// One sentence in, the right thing done. Used by the town's command bar and by WhatsApp.
//
//   "quill write 5 video titles"   -> QUILL gets that task (any agent's name, optional @ or :)
//   "compare 3 note-taking apps"   -> no name: the best-suited free agent gets it
//   status | help | yes | no | reset scout
import { SPECIES } from './species.js';

// Words that point at a kind of job. Checked as whole words, case-insensitive.
const SKILLS = {
  RESEARCH: ['research', 'compare', 'comparison', 'find', 'search', 'look', 'investigate', 'analyse', 'analyze', 'analysis', 'which', 'best', 'price', 'prices', 'pricing', 'trend', 'trends', 'review', 'reviews', 'competitor', 'competitors', 'market', 'sources', 'outlier', 'outliers'],
  WRITE: ['write', 'draft', 'email', 'emails', 'reply', 'rewrite', 'edit', 'proofread', 'summary', 'summarize', 'summarise', 'title', 'titles', 'caption', 'captions', 'script', 'scripts', 'blog', 'post', 'posts', 'tweet', 'thread', 'description', 'descriptions', 'outline', 'newsletter', 'copy'],
  CODE: ['code', 'bug', 'bugs', 'fix', 'function', 'program', 'website', 'html', 'css', 'javascript', 'typescript', 'python', 'api', 'refactor', 'test', 'tests', 'json', 'regex', 'sql', 'automate', 'app'],
  DESIGN: ['design', 'layout', 'ui', 'ux', 'mockup', 'wireframe', 'colour', 'color', 'colors', 'palette', 'logo', 'thumbnail', 'thumbnails', 'brand', 'icon', 'icons'],
  OPS: ['deploy', 'server', 'servers', 'monitor', 'backup', 'backups', 'uptime', 'logs', 'scale', 'rotate', 'cron'],
};
const LABEL = { RESEARCH: 'research', WRITE: 'writing', CODE: 'code', DESIGN: 'design', OPS: 'operations' };

export const HELP = [
  'Tell your team what to do in one sentence.',
  '• compare 3 note-taking apps: the best-suited free agent takes it',
  '• quill write 5 video titles: start with a name to choose the agent',
  '• @scout how is it going?: talk to an agent without giving it a task',
  '• ? what should my team do today: ask the Guide for ideas',
  '• status: what everyone is doing',
  '• yes / no: answer the open request',
  '• reset scout: clear an agent that fainted or got stuck',
  '• rename scout to max: give an agent a new name',
].join('\n');

export function guessSkill(text) {
  const words = String(text).toLowerCase().match(/[a-z]+/g) || [];
  let best = null;
  let bestScore = 0;
  for (const [skill, list] of Object.entries(SKILLS)) {
    const score = words.filter((w) => list.includes(w)).length;
    if (score > bestScore) { best = skill; bestScore = score; }
  }
  return best;
}

// A custom role whose name appears in the text ("make captions for my video" -> Video editor).
const FILLER = new Set(['the', 'and', 'for', 'manager', 'assistant', 'helper', 'agent', 'expert', 'specialist', 'pro']);
export function guessCustomRole(text, party) {
  const words = new Set(String(text).toLowerCase().match(/[a-z0-9]+/g) || []);
  let best = null;
  let bestScore = 0;
  for (const a of party) {
    const s = SPECIES[a.species];
    if (!s?.custom) continue;
    const score = (s.title.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length >= 3 && !FILLER.has(w) && words.has(w)).length;
    if (score > bestScore) { best = s; bestScore = score; }
  }
  return best;
}

// Picks the agent for a job: right skill first, then free before busy, then healthier.
export function pickAgent(party, skill) {
  const workers = party.filter((a) => !SPECIES[a.species].reviewer && a.status !== 'FNT');
  if (!workers.length) return null;
  const fit = (a) => {
    const types = SPECIES[a.species].types;
    return skill && types[0] === skill ? 2 : skill && types.includes(skill) ? 1 : 0;
  };
  const free = (a) => (a.phase === 'idle' && a.status !== 'PAR' ? 1 : 0);
  return [...workers].sort((x, y) => fit(y) - fit(x) || free(y) - free(x) || (y.hp / y.hpMax) - (x.hp / x.hpMax))[0];
}

// actions: { assign(agent, title, review), resolve(approvalId, decision), reset(agent) } -> event
export function createCommands({ store, actions }) {
  const party = () => store.party();
  const byName = (word) => {
    const w = String(word || '').replace(/^@/, '').replace(/[:,.!]$/, '').toUpperCase();
    return w ? party().find((a) => a.nick.toUpperCase() === w) : null;
  };
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  function status() {
    const lines = party().map((a) => {
      const now = a.status === 'PAR' ? 'waiting for your OK'
        : a.status === 'FNT' ? 'fainted, needs a reset'
        : a.reviewingId ? 'reviewing'
        : a.task ? `working on "${clip(a.task.title, 60)}"` : 'free';
      return `${a.nick} (Lv ${a.lv}): ${now}. HP ${Math.round(a.hp)}/${a.hpMax}`;
    });
    const open = store.approvals.size;
    return [`Party (${lines.length})`, ...lines, open ? `${open} request(s) need your YES or NO.` : 'Nothing needs you.'].join('\n');
  }

  async function run(input, { review, via, files } = {}) {
    const text = String(input || '').trim();
    if (!text) return { reply: 'Type what you want done, for example: compare 3 note-taking apps.' };
    const lower = text.toLowerCase();
    if (['help', '?', 'menu', 'hi', 'hello'].includes(lower)) return { reply: HELP };
    if (lower === 'status') return { reply: status() };

    if (lower === 'yes' || lower === 'no') {
      const open = [...store.approvals.values()];
      if (!open.length) return { reply: 'Nothing is waiting for an answer.' };
      if (open.length > 1) return { reply: `${open.length} requests are open. Answer each one in its YES / NO box.` };
      const ev = await actions.resolve(open[0].id, lower);
      return { reply: ev.message || 'Done.', agentId: open[0].agentId };
    }

    // ? what should my team do today  -> the Guide answers with ideas and ready-made jobs
    if (text.startsWith('?') && text.length > 1) {
      const q = text.slice(1).trim();
      if (!actions.ask) return { reply: 'The Guide is not available here.' };
      await actions.ask(q, via);
      return { reply: 'The Guide is thinking. Its ideas appear in the team chat.', chat: true };
    }

    const [first, ...rest] = text.split(/\s+/);
    // @scout how is it going?  -> talk, not a task
    if (first.startsWith('@')) {
      const a = byName(first);
      if (!a) return { reply: `No agent called ${first.slice(1) || '?'} in your party. Send "status" to see names.` };
      const said = rest.join(' ').trim();
      if (!said) return { reply: `What do you want to say to ${a.nick}? For example: @${a.nick.toLowerCase()} what did you find?` };
      try { await actions.chat(a, actions.withFiles ? actions.withFiles(said, files) : said, via); } catch (err) { return { reply: err.message }; }
      return { reply: `${a.nick} is thinking about it. The answer appears in its chat${via === 'whatsapp' ? ' and here' : ''}.`, agentId: a.id, chat: true };
    }
    // rename scout to max  |  rename scout max
    if (first.toLowerCase() === 'rename' && rest.length >= 2) {
      const a = byName(rest[0]);
      if (!a) return { reply: `No agent called ${rest[0]} in your party. Send "status" to see names.` };
      const nick = rest[1].toLowerCase() === 'to' ? rest[2] : rest[1];
      if (!nick) return { reply: `What should ${a.nick} be called? For example: rename ${a.nick.toLowerCase()} to max` };
      try { const ev = await actions.rename(a, nick); return { reply: ev.message || `${a.nick} keeps its name.`, agentId: a.id }; }
      catch (err) { return { reply: err.message }; }
    }
    if (first.toLowerCase() === 'reset' && rest.length) {
      const a = byName(rest[0]);
      if (!a) return { reply: `No agent called ${rest[0]} in your party. Send "status" to see names.` };
      await actions.reset(a);
      return { reply: `Resetting ${a.nick}.`, agentId: a.id };
    }

    const named = byName(first);
    const reviewer = party().some((r) => SPECIES[r.species].reviewer && r.status !== 'FNT');
    const withReview = review === undefined ? reviewer : Boolean(review) && reviewer;
    if (named) {
      const title = rest.join(' ').trim();
      if (!title) return { reply: `What should ${named.nick} do? For example: ${named.nick.toLowerCase()} write 5 title ideas for my video.` };
      if (SPECIES[named.species].reviewer) return { reply: `${named.nick} only reviews other agents' work. Leave the name out and Agentdex picks someone.` };
      await actions.assign(named, clip(title, 200), withReview, actions.filesDetails?.(undefined, files));
      return { reply: `${named.nick} is on it${withReview ? ', and the reviewer will check it' : ''}.`, agentId: named.id };
    }

    const custom = guessCustomRole(text, party());
    const skill = custom ? custom.types[0] : guessSkill(text);
    const a = pickAgent(party(), skill);
    if (!a) return { reply: 'No agent can take this right now. Spawn one from the Dex, or reset a fainted one.' };
    await actions.assign(a, clip(text, 200), withReview, actions.filesDetails?.(undefined, files));
    const why = custom ? ` (${custom.title.toLowerCase()} job)` : skill ? ` (${LABEL[skill]} job)` : '';
    const busy = a.phase !== 'idle' ? ' It will start after its current task.' : '';
    return { reply: `Sent to ${a.nick}${why}.${busy}${withReview ? ' The reviewer will check it.' : ''}`, agentId: a.id };
  }

  return { run, status };
}
