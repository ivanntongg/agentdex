// A fake agent runtime. It only talks to the store through events, exactly like a real
// runtime adapter would, so the town cannot tell the difference.
import { SPECIES } from './species.js';
import { guessSkill } from './commands.js';

const POOL = {
  CODE: [
    { title: 'Fix flaky checkout test', review: true, approval: { tool: 'MERGE', target: 'PR #212 into main' } },
    { title: 'Refactor auth middleware', review: true },
    { title: 'Bump 14 dependencies', approval: { tool: 'MERGE', target: 'PR #219 (deps)' } },
    { title: 'Add retry to webhook sender', review: true },
  ],
  RESEARCH: [
    { title: 'Compare 4 vector databases' },
    { title: 'Summarize 12 support tickets' },
    { title: 'Price EU hosting options', approval: { tool: 'FETCH', target: '3 paid analyst reports ($24)' } },
  ],
  DESIGN: [
    { title: 'Redesign settings screen', review: true },
    { title: 'Draft empty states for inbox', review: true },
    { title: 'Export icon set v2' },
  ],
  OPS: [
    { title: 'Deploy api v2.3', approval: { tool: 'DEPLOY', target: 'api-prod' } },
    { title: 'Rotate staging keys', approval: { tool: 'ROTATE', target: 'staging secrets' } },
    { title: 'Scale workers for launch' },
    { title: 'Check error budget' },
  ],
  WRITE: [
    { title: 'Write release notes v2.3', review: true },
    { title: 'Reply to 6 support emails', approval: { tool: 'SEND', target: '6 customer emails' } },
  ],
};

const TRAVEL_TICKS = 4;

export function createSimulator({ tickMs = 1300, random = Math.random } = {}) {
  let store = null;
  let timer = null;
  const sims = new Map(); // agentId -> { wait, then, workLeft, cnf, faintT }

  const pick = (arr) => arr[Math.floor(random() * arr.length)];
  const sim = (a) => { if (!sims.has(a.id)) sims.set(a.id, { wait: 0, then: null, workLeft: 0, cnf: 0, faintT: 0, queue: [] }); return sims.get(a.id); };
  const emit = (type, agentId, data) => store.apply({ type, agentId, data });
  const later = (a, ticks, fn) => { const s = sim(a); s.wait = ticks; s.then = fn; };
  const reviewer = () => store.party().find((a) => SPECIES[a.species].reviewer && a.status !== 'FNT' && !a.reviewingId);

  function travel(a, to, then) {
    if (a.loc === to) return then();
    emit('agent.moved', a.id, { to });
    later(a, TRAVEL_TICKS, then);
  }

  function startTask(a, task) {
    const t = task || pick(POOL[SPECIES[a.species].types[0]] || POOL.WRITE);
    travel(a, SPECIES[a.species].home, () => {
      emit('task.started', a.id, t);
      sim(a).workLeft = 5 + Math.floor(random() * 5);
    });
  }

  function workDone(a) {
    const r = reviewer();
    if (a.task.review && r && r.id !== a.id) {
      emit('task.handoff', a.id, { reviewerId: r.id });
      travel(a, 'GYM', () => {
        const rv = store.resolveAgent(r.id, { required: false });
        if (!rv || rv.boxed || rv.status === 'FNT' || rv.reviewingId) { emit('review.finished', a.id, { result: 'approved' }); return afterReview(a); }
        emit('review.started', a.id, { reviewerId: r.id });
        later(a, 3, () => {
          const changes = random() < 0.3;
          emit('review.finished', a.id, { reviewerId: r.id, result: changes ? 'changes' : 'approved', issues: 2 });
          if (changes) travel(a, SPECIES[a.species].home, () => { sim(a).workLeft = 4; });
          else afterReview(a);
        });
      });
      return;
    }
    afterReview(a);
  }

  function afterReview(a) {
    if (!a.task) return;
    if (a.task.approval) emit('approval.requested', a.id, { tool: a.task.approval.tool, target: a.task.approval.target });
    else emit('task.finished', a.id, { xp: 60 });
  }

  function tickAgent(a) {
    const s = sim(a);
    if (s.wait > 0) {
      s.wait--;
      if (s.wait === 0 && s.then) { const fn = s.then; s.then = null; fn(); }
      return;
    }
    if (a.status === 'FNT') {
      s.faintT++;
      if (s.faintT === 2) { emit('agent.moved', a.id, { to: 'CENTER', reason: 'is being carried to the CENTER.' }); later(a, TRAVEL_TICKS, () => { s.faintT = 0; emit('agent.reset', a.id); }); }
      return;
    }
    if (a.status === 'CNF') { if (--s.cnf <= 0) emit('agent.status', a.id, { status: 'OK' }); return; }
    if (a.phase === 'idle') {
      if (SPECIES[a.species].reviewer) return;
      if (s.queue.length) return startTask(a, s.queue.shift()); // your jobs first, like real agents
      if (random() < 0.2) startTask(a);
      else if (random() < 0.015 && a.loc !== 'MART') travel(a, 'MART', () => emit('agent.moved', a.id, { to: 'MART', reason: 'browsed the MART for new skills.' }));
      return;
    }
    if (a.phase === 'work' && a.task) {
      const tool = pick(a.moves.slice(0, 3)).n;
      emit('task.progress', a.id, { tokens: (3 + random() * 5) * (a.status === 'PSN' ? 2.6 : 1), tool });
      if (a.status === 'FNT') return;
      if (a.status === 'OK' && random() < 0.035) { s.cnf = 4; emit('agent.status', a.id, { status: 'CNF', reason: `It ran the same ${tool.toLowerCase()} 3 times in a row.` }); return; }
      if (a.status === 'OK' && random() < 0.03) emit('agent.status', a.id, { status: 'PSN', reason: "It's spending tokens 2.6x faster than usual." });
      if (--s.workLeft <= 0) workDone(a);
    }
  }

  function tick() {
    for (const a of store.party()) {
      try { tickAgent(a); } catch (err) { console.error(`simulator: ${a.nick}:`, err.message); }
    }
  }

  return {
    name: 'simulator',
    start(s) {
      store = s;
      // Opening scene, same as the offline demo.
      const [patch, scout, , rollo] = store.party();
      if (patch) { emit('task.started', patch.id, POOL.CODE[0]); sim(patch).workLeft = 3; }
      if (scout) startTask(scout, POOL.RESEARCH[0]);
      if (rollo) { emit('task.started', rollo.id, POOL.OPS[0]); emit('approval.requested', rollo.id, POOL.OPS[0].approval); }
      if (tickMs > 0) timer = setInterval(tick, tickMs);
    },
    stop() { clearInterval(timer); },
    tick,
    onApproval(ap, decision) {
      if (ap.kind !== 'tool') return;
      const a = store.resolveAgent(ap.agentId, { required: false });
      if (a && a.task) emit('task.finished', a.id, decision === 'yes' ? { xp: 60 } : { outcome: 'declined' });
    },
    onPoke(a) {
      const say = (message, tone = 'info') => emit('agent.interacted', a.id, { action: 'poke', message, tone });
      if (a.status === 'FNT') { say(`${a.nick} didn't respond. You sent it to the CENTER.`, 'bad'); sim(a).faintT = 1; return; }
      if (a.status === 'PSN') { say(`You poked ${a.nick} and capped its budget.`, 'ok'); emit('agent.status', a.id, { status: 'OK' }); return; }
      if (a.status === 'CNF') return say(`${a.nick} jumped, then kept looping. Try petting it instead.`);
      if (a.status === 'PAR') return say(`${a.nick} pointed at its request. It needs your YES or NO.`, 'need');
      if (a.phase === 'work' && a.task) return say(`${a.nick}: "Working on ${a.task.title}. About ${sim(a).workLeft} steps left."`);
      if (a.phase === 'idle' && sim(a).wait === 0) {
        if (SPECIES[a.species].reviewer) return say(`${a.nick} has nothing to review yet. It went back to sleep.`);
        say(`You poked ${a.nick} awake. It grabbed the next task.`, 'ok');
        return startTask(a);
      }
      say(`${a.nick} is on the move. It waved at you.`);
    },
    onReset(a) {
      const s = sim(a); s.then = null; s.wait = 0;
      emit('agent.moved', a.id, { to: 'CENTER', reason: 'is walking to the CENTER for a reset.' });
      later(a, TRAVEL_TICKS, () => emit('agent.reset', a.id));
    },
    onAssigned(a, task) {
      if (SPECIES[a.species].reviewer) return;
      const job = { title: task.title, review: task.review };
      if (a.phase === 'idle' && sim(a).wait === 0) startTask(a, job);
      else sim(a).queue.push(job); // busy: it starts when the current task is done
    },
    onChat(a, entry) {
      const s = sim(a);
      const reply = () => {
        const now = store.resolveAgent(a.id, { required: false });
        if (!now || !now.chatting) return;
        const job = guessSkill(entry.text) ? entry.text : null;
        const text = now.task
          ? `I'm on "${now.task.title}", about ${Math.max(1, s.workLeft)} steps left. I'm a practice agent, so my answers are canned; real agents answer properly.`
          : job ? "I can do that. Press DO IT AS A TASK and I'll start." : "I'm free right now. Ask me something, or give me a task. (I'm a practice agent; real agents answer properly.)";
        emit('chat.replied', a.id, { text, suggestedTask: job, via: entry.via });
      };
      if (tickMs > 0) setTimeout(reply, tickMs * 2); else reply();
    },
    // Practice Guide: canned ideas, one per free agent, from the practice task list.
    onGuide(asked) {
      const answer = () => {
        const free = store.party().filter((a) => !SPECIES[a.species].reviewer && a.status !== 'FNT').slice(0, 3);
        const suggestions = free.map((a) => ({ agentId: a.id, task: pick(POOL[SPECIES[a.species].types[0]] || POOL.WRITE).title }));
        emit('guide.answered', null, { text: 'Here are a few ideas for your team right now. This is the practice Guide, so the ideas are examples. With Claude connected, the Guide looks at your real agents, skills and recent work.', suggestions, via: asked.via });
      };
      if (tickMs > 0) setTimeout(answer, tickMs * 2); else answer();
    },
    onRemoved(a) { sims.delete(a.id); },
  };
}
