// Runs weekly plans: a project, a time, and steps that each give one agent a job.
//
// A run gets its own folder (drafts/<project>/<date>). Step 1 starts; when that agent finishes,
// step 2 starts with step 1's summary and files, and so on. If an agent faints, is reset or boxed,
// or you say NO and it stands down, the run stops and the field log says why.
//
// Scheduling is simple and survives the computer being off: a plan is due when its most recent
// time slot has passed and it has not started since then. So a Monday 09:00 plan whose computer
// was off at 09:00 runs as soon as Agentdex starts again that week, once.
import { DAYS } from './store.js';
import { SPECIES } from './species.js';

const pad = (n) => String(n).padStart(2, '0');
export const dateStamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// The most recent moment this schedule should have run, on or before now (local time). null for manual plans.
export function lastSlot(schedule, now = new Date()) {
  if (!schedule || schedule.day === 'manual') return null;
  const [h, m] = String(schedule.time || '09:00').split(':').map(Number);
  const slot = new Date(now);
  slot.setHours(h, m, 0, 0);
  if (schedule.day === 'daily') { if (slot > now) slot.setDate(slot.getDate() - 1); return slot; }
  const want = DAYS.indexOf(schedule.day);
  let back = (slot.getDay() - want + 7) % 7;
  if (back === 0 && slot > now) back = 7;
  slot.setDate(slot.getDate() - back);
  return slot;
}

export function isDue(pl, now = new Date()) {
  if (!pl.enabled || pl.running) return false;
  const slot = lastSlot(pl.schedule, now);
  if (!slot || slot <= new Date(pl.savedAt)) return false; // never for a time before the plan existed
  return !pl.lastRun || new Date(pl.lastRun.startedAt || pl.lastRun.at) < slot;
}

// assign(agent, title, review, details) gives an agent a task (the server's own assign, so the
// practice simulator and real runtimes both pick it up).
export function createPipelines({ store, assign, now = () => new Date(), tickMs = 30_000, log = () => {} }) {
  const soon = (fn) => setImmediate(() => { try { fn(); } catch (err) { log(`Plans: ${err.message}`); } });
  const unsubscribe = store.subscribe(({ event }) => soon(() => onEvent(event)));
  const timer = tickMs > 0 ? setInterval(() => soon(tick), tickMs) : null;
  timer?.unref?.();

  const plan = (id) => store.pipelines.get(id);
  const reviewerFree = () => store.party().some((r) => SPECIES[r.species].reviewer && r.status !== 'FNT');

  function details(pl, i) {
    const proj = store.projects.get(pl.projectId);
    const r = pl.running;
    const date = r.runId.slice(0, 10);
    const fill = (t) => t.replaceAll('{folder}', r.folder).replaceAll('{date}', date).replaceAll('{project}', proj?.name || '');
    const earlier = r.results.map((x, k) => `- Step ${k + 1}, ${x.nick}, "${x.title}": ${x.note || 'done'}${x.files.length ? ` Files: ${x.files.join(', ')}.` : ''}`).join('\n');
    return [
      proj ? `Project: ${proj.name}\n${proj.brief}` : '',
      `This is step ${i + 1} of ${pl.steps.length} of the plan "${pl.name}", run on ${date}. Save everything in ${r.folder}/ (no permission needed there).`,
      earlier ? `Earlier steps in this run (read their files first and build on them):\n${earlier}` : '',
      fill(pl.steps[i].text),
    ].filter(Boolean).join('\n\n');
  }

  // The step's agent, or a free agent of the same kind if it is boxed or fainted.
  function agentFor(step) {
    const a = store.resolveAgent(step.agentId, { required: false });
    if (a && !a.boxed && a.status !== 'FNT') return a;
    const sp = a?.species;
    return store.party().find((x) => x.species === sp && x.status !== 'FNT') || null;
  }

  function runStep(pl, i, result = null) {
    const step = pl.steps[i];
    const a = agentFor(step);
    if (!a) return finish(pl, 'failed', `Nobody can do step ${i + 1}: the agent is in the box or fainted. Move it to the party or edit the plan.`);
    store.apply({ type: 'pipeline.stepped', agentId: a.id, data: { id: pl.id, step: i, title: step.title, result } });
    assign(a, step.title, step.edit ? false : pl.review && reviewerFree(), details(pl, i), null, step.edit ? { edit: { folder: pl.running.folder } } : null);
  }

  function finish(pl, status, reason = null) {
    if (plan(pl.id)?.running) store.apply({ type: 'pipeline.finished', data: { id: pl.id, status, reason } });
  }

  function start(id, by = 'you') {
    const pl = plan(id);
    if (!pl) throw new Error('That plan no longer exists.');
    if (pl.running) throw new Error(`${pl.name} is already running.`);
    const proj = store.projects.get(pl.projectId);
    let runId = dateStamp(now());
    if (pl.lastRun?.runId?.startsWith(runId)) runId = `${runId}-${now().getHours()}${pad(now().getMinutes())}`;
    store.apply({ type: 'pipeline.started', data: { id, runId, folder: `${proj ? proj.folder : 'drafts'}/${runId}`, by } });
    runStep(plan(id), 0);
    return plan(id);
  }

  function stop(id) {
    const pl = plan(id);
    if (!pl?.running) throw new Error('That plan is not running.');
    const a = store.resolveAgent(pl.running.agentId, { required: false });
    finish(pl, 'stopped', a ? `${a.nick} finishes its current step, but nothing else starts.` : null);
  }

  function onEvent(ev) {
    const running = [...store.pipelines.values()].filter((p) => p.running && p.running.agentId === ev.agentId);
    for (const pl of running) {
      if (ev.type === 'task.finished' && ev.data?.title === pl.running.title) {
        const a = store.resolveAgent(ev.agentId, { required: false });
        if (ev.data.outcome === 'declined') { finish(pl, 'failed', `${a?.nick || 'The agent'} stood down at step ${pl.running.step + 1} after you said NO.`); continue; }
        if (ev.data.failed) { finish(pl, 'failed', `Step ${pl.running.step + 1}: ${ev.data.note || 'it did not work'}`); continue; }
        const result = { nick: a?.nick || '', title: pl.running.title, note: ev.data.note || '', files: ev.data.files || [] };
        const next = pl.running.step + 1;
        if (next >= pl.steps.length) { pl.running.results.push(result); finish(pl, 'done'); } else runStep(pl, next, result);
      } else if (['agent.fainted', 'agent.reset', 'agent.boxed'].includes(ev.type)) {
        // One retry: a fainted or reset agent gets the step again once it is back. A second time, or the box, ends the run.
        const a = store.resolveAgent(ev.agentId, { required: false });
        const r = pl.running;
        const nick = a?.nick || 'The agent';
        if (ev.type === 'agent.boxed' || (r.retried && !r.waiting)) {
          const what = ev.type === 'agent.fainted' ? 'fainted again' : ev.type === 'agent.reset' ? 'was reset again' : 'went to the box';
          finish(pl, 'failed', `${nick} ${what} during step ${r.step + 1}. Press RUN NOW to try again.`);
        } else if (ev.type === 'agent.fainted') {
          r.waiting = true;
          store.note(`${pl.name}: ${nick} fainted during step ${r.step + 1}. The step starts again once ${nick} is reset.`, 'need');
        } else {
          r.retried = true; r.waiting = false;
          store.note(`${pl.name}: ${nick} is back, so step ${r.step + 1} starts again.`);
          const st = pl.steps[r.step];
          assign(a, st.title, st.edit ? false : pl.review && reviewerFree(), details(pl, r.step), null, st.edit ? { edit: { folder: r.folder } } : null);
        }
      }
    }
  }

  function tick() {
    for (const pl of store.pipelines.values()) {
      if (isDue(pl, now())) { try { start(pl.id, 'schedule'); } catch (err) { log(`Plans: ${err.message}`); } }
    }
  }

  // The plan named in "run weekly streamer", forgiving about case and partial names.
  function findByName(name) {
    const q = String(name || '').trim().toLowerCase();
    const all = [...store.pipelines.values()];
    return all.find((p) => p.name.toLowerCase() === q) || all.find((p) => p.name.toLowerCase().startsWith(q)) || all.find((p) => p.name.toLowerCase().includes(q)) || null;
  }

  return { start, stop, tick, findByName, close: () => { clearInterval(timer); unsubscribe(); } };
}
