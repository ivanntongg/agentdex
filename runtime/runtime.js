// Runs real Claude agents for the town. Each task is a tool-use loop on the Messages API.
// Everything the town shows comes from events this file posts; answers come back on the stream.
import Anthropic from '@anthropic-ai/sdk';
import { SPECIES } from '../server/species.js';
import { FILE_TOOLS, WorkspaceError } from './workspace.js';
import { REVIEWER_SYSTEM, REVIEW_SCHEMA, systemPrompt, usesWeb } from './roles.js';

const WEB_SEARCH = { type: 'web_search_20260209', name: 'web_search', max_uses: 5 };
const MOVE_FOR_TOOL = { list_files: 'READ', read_file: 'READ', write_file: 'EDIT' };

class Stopped extends Error {}

// Pass either a fixed client (anthropic, model, effort) or settings(): { anthropic, model, effort },
// read before every request so changes on the SETUP screen apply straight away.
export function createRuntime({ anthropic, dex, workspace, model = 'claude-opus-5-5', effort = 'medium', settings = null, maxTurns = 30, log = console.log }) {
  const current = settings || (() => ({ anthropic, model, effort }));
  const agents = new Map();      // id -> latest agent snapshot from the server
  const queues = new Map();      // id -> [task]
  const running = new Map();     // id -> AbortController
  const waiters = new Map();     // approvalId -> resolve(decision)
  const early = new Map();       // approvalId -> decision that arrived before we waited
  const idle = new Set();        // resolvers for whenIdle()

  // Only the server's fallbacks setting differs from a plain request; see README for why it is on.
  const request = (params, signal) => {
    const cfg = current();
    return cfg.anthropic.beta.messages.create(
      { model: cfg.model, max_tokens: 16000, output_config: { effort: cfg.effort, ...(params.output_config || {}) }, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', ...omit(params, 'output_config') },
      { signal },
    );
  };

  function onSnapshot(s) { for (const a of s.agents) agents.set(a.id, a); }

  function onChange({ event, agents: touched }) {
    for (const a of touched) agents.set(a.id, a);
    switch (event.type) {
      case 'task.assigned': enqueue(event.agentId, event.data); break;
      case 'approval.resolved': {
        const resolve = waiters.get(event.data.approvalId);
        if (resolve) { waiters.delete(event.data.approvalId); resolve(event.data.decision); }
        else early.set(event.data.approvalId, event.data.decision);
        break;
      }
      case 'agent.reset': case 'agent.boxed': case 'agent.fainted':
        running.get(event.agentId)?.abort();
        queues.delete(event.agentId);
        break;
    }
  }

  function enqueue(agentId, task) {
    const a = agents.get(agentId);
    if (a && SPECIES[a.species].reviewer) {
      dex.emit('agent.interacted', agentId, { action: 'poke', message: `${a.nick} only reviews other agents' work. Give the task to someone else.` }).catch(() => {});
      return;
    }
    if (!queues.has(agentId)) queues.set(agentId, []);
    queues.get(agentId).push(task);
    pump(agentId);
  }

  async function pump(agentId) {
    if (running.has(agentId)) return;
    const task = queues.get(agentId)?.shift();
    if (!task) { if (!running.size) idle.forEach((r) => r()), idle.clear(); return; }
    const ctl = new AbortController();
    running.set(agentId, ctl);
    try { await runTask(agentId, task, ctl.signal); }
    catch (err) { await reportFailure(agentId, err); }
    finally { running.delete(agentId); pump(agentId); }
  }

  async function reportFailure(agentId, err) {
    if (err instanceof Stopped || err?.name === 'AbortError' || err instanceof Anthropic.APIUserAbortError) return;
    let reason;
    if (err instanceof Anthropic.AuthenticationError) reason = 'The Claude API rejected the key. Check ANTHROPIC_API_KEY.';
    else if (err instanceof Anthropic.RateLimitError) reason = 'The Claude API is rate limiting us. Try again in a minute.';
    else if (err instanceof Anthropic.APIError) reason = `Claude API error ${err.status ?? ''}: ${err.message}`.slice(0, 200);
    else reason = `Runtime error: ${err?.message || err}`.slice(0, 200);
    log(`[${agents.get(agentId)?.nick || agentId}] ${reason}`);
    await dex.emit('agent.fainted', agentId, { reason }).catch(() => {});
  }

  async function waitForApproval(agentId, tool, target, signal) {
    const ev = await dex.emit('approval.requested', agentId, { tool, target });
    const id = ev.data.approvalId;
    if (early.has(id)) { const d = early.get(id); early.delete(id); return d; }
    return new Promise((resolve, reject) => {
      waiters.set(id, resolve);
      signal.addEventListener('abort', () => { waiters.delete(id); reject(new Stopped()); }, { once: true });
    });
  }

  async function runTool(agent, block, signal, written) {
    const input = block.input || {};
    const fn = workspace.tools[block.name];
    if (!fn) return { content: `Unknown tool ${block.name}`, is_error: true };
    try {
      if (block.name === 'write_file' && await workspace.needsApproval(input.path)) {
        const { rel } = await workspace.resolve(input.path);
        const decision = await waitForApproval(agent.id, 'WRITE', rel, signal);
        if (decision !== 'yes') return { content: `The user declined writing ${rel}. Do not retry it; put the work in drafts/ or explain what you would have changed.`, is_error: true };
      }
      const out = await fn(input);
      if (block.name === 'write_file') written.add((await workspace.resolve(input.path)).rel);
      return { content: out };
    } catch (err) {
      if (err instanceof Stopped) throw err;
      if (err instanceof WorkspaceError) return { content: err.message, is_error: true };
      return { content: `Tool failed: ${err.message}`, is_error: true };
    }
  }

  // One full tool-use loop. Returns the final text, or null if the agent ran out of context.
  async function loop(agent, ctx, signal) {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (signal.aborted) throw new Stopped();
      const res = await request({ system: ctx.system, tools: ctx.tools, messages: ctx.messages }, signal);

      // HP is context: report how much this turn added to it.
      const u = res.usage;
      const context = u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + u.output_tokens;
      const added = Math.max(0, context - ctx.context);
      ctx.context = context;
      const toolUses = res.content.filter((b) => b.type === 'tool_use');
      await dex.emit('task.progress', agent.id, { tokens: added / 1000, tool: MOVE_FOR_TOOL[toolUses[0]?.name] || 'READ' });
      if (ctx.context / 1000 >= ctx.hpAtStart) return null;

      ctx.messages.push({ role: 'assistant', content: res.content });
      if (res.stop_reason === 'refusal') return 'Declined this task.';
      if (res.stop_reason === 'pause_turn') continue;
      if (!toolUses.length || res.stop_reason === 'max_tokens') {
        return res.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim() || 'Done.';
      }
      const results = [];
      for (const block of toolUses) {
        const r = await runTool(agent, block, signal, ctx.written);
        results.push({ type: 'tool_result', tool_use_id: block.id, content: r.content, ...(r.is_error ? { is_error: true } : {}) });
      }
      ctx.messages.push({ role: 'user', content: results });
    }
    return `Stopped after ${maxTurns} steps without finishing.`;
  }

  async function review(agent, reviewer, task, summary, written, signal) {
    await dex.emit('task.handoff', agent.id, { reviewerId: reviewer.id });
    await dex.emit('agent.moved', agent.id, { to: 'GYM' });
    await dex.emit('review.started', agent.id, { reviewerId: reviewer.id });
    const files = [];
    for (const rel of [...written].slice(0, 10)) {
      try { files.push(`--- ${rel} ---\n${(await workspace.tools.read_file({ path: rel })).slice(0, 20000)}`); } catch { /* deleted or too big */ }
    }
    const res = await request({
      system: REVIEWER_SYSTEM,
      messages: [{ role: 'user', content: `Task given to ${agent.nick}: ${task.title}\n${task.details || ''}\n\nTheir summary: ${summary}\n\nFiles they wrote:\n${files.join('\n\n') || '(none)'}` }],
      output_config: { format: { type: 'json_schema', schema: REVIEW_SCHEMA } },
    }, signal);
    await dex.emit('task.progress', reviewer.id, { tokens: (res.usage.input_tokens + res.usage.output_tokens) / 1000, tool: 'REVIEW' });
    let verdict = { verdict: 'approved', issues: [], summary: '' };
    if (res.stop_reason !== 'refusal') {
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      try {
        const v = JSON.parse(text);
        if (['approved', 'changes'].includes(v.verdict) && Array.isArray(v.issues)) verdict = v;
      } catch { /* treat unreadable output as approved rather than blocking the task */ }
    }
    await dex.emit('review.finished', agent.id, { reviewerId: reviewer.id, result: verdict.verdict, issues: verdict.issues.length || 1 });
    return verdict;
  }

  async function runTask(agentId, task, signal) {
    const agent = agents.get(agentId);
    if (!agent || agent.boxed) return;
    const species = SPECIES[agent.species];
    if (!current().anthropic) {
      await dex.emit('agent.interacted', agentId, { action: 'poke', tone: 'bad', message: `${agent.nick} can't start "${task.title}" yet: add your Claude API key on the SETUP screen, then give the task again.` });
      return;
    }
    if (agent.loc !== species.home) await dex.emit('agent.moved', agentId, { to: species.home });
    await dex.emit('task.started', agentId, { title: task.title, review: task.review });
    log(`[${agent.nick}] started: ${task.title}`);

    const ctx = {
      system: systemPrompt(species, agent.nick),
      tools: usesWeb(species) ? [...FILE_TOOLS, WEB_SEARCH] : FILE_TOOLS,
      messages: [{ role: 'user', content: `Task: ${task.title}${task.details ? `\n\nDetails: ${task.details}` : ''}` }],
      context: 0,
      hpAtStart: agent.hp,
      written: new Set(),
    };

    let summary = await loop(agent, ctx, signal);
    if (summary === null) return; // the server fainted the agent when HP hit 0

    const reviewer = task.review && [...agents.values()].find((r) => !r.boxed && SPECIES[r.species].reviewer && r.status !== 'FNT' && !r.reviewingId);
    if (reviewer) {
      const v = await review(agent, reviewer, task, summary, ctx.written, signal);
      if (v.verdict === 'changes') {
        await dex.emit('agent.moved', agentId, { to: species.home });
        ctx.messages.push({ role: 'user', content: `${reviewer.nick} reviewed your work and asked for changes:\n${v.issues.map((i) => `- ${i}`).join('\n')}\n\nFix these, then reply with your one or two sentence summary again.` });
        summary = await loop(agent, ctx, signal);
        if (summary === null) return;
      }
    }
    await dex.emit('task.finished', agentId, { xp: 60, note: summary });
    log(`[${agent.nick}] finished: ${summary}`);
  }

  return {
    onSnapshot,
    onChange,
    enqueue,
    agents,
    whenIdle: () => new Promise((r) => { if (!running.size) r(); else idle.add(r); }),
  };
}

function omit(o, key) { const { [key]: _, ...rest } = o; return rest; }
