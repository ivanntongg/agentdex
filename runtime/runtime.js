// Runs real Claude agents for the town. Each task is a tool-use loop on the Messages API.
// Everything the town shows comes from events this file posts; answers come back on the stream.
import Anthropic from '@anthropic-ai/sdk';
import { SPECIES } from '../server/species.js';
import { FILE_TOOLS, WorkspaceError } from './workspace.js';
import { REVIEWER_SYSTEM, REVIEW_SCHEMA, systemPrompt, usesWeb, chatPrompt, splitTask } from './roles.js';
import { ClaudeCodeError, ClaudeCodeStopped } from './claude-code.js';

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
  const chats = new Map();       // id -> recent chat entries

  // Only the server's fallbacks setting differs from a plain request; see README for why it is on.
  const request = (params, signal) => {
    const cfg = current();
    return cfg.anthropic.beta.messages.create(
      { model: cfg.model, max_tokens: 16000, output_config: { effort: cfg.effort, ...(params.output_config || {}) }, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', ...omit(params, 'output_config') },
      { signal },
    );
  };

  function onSnapshot(s) {
    for (const a of s.agents) agents.set(a.id, a);
    for (const [id, list] of Object.entries(s.chats || {})) chats.set(Number(id), list);
  }
  const remember = (agentId, entry) => { if (!entry) return; if (!chats.has(agentId)) chats.set(agentId, []); const l = chats.get(agentId); if (!l.some((e) => e.id === entry.id)) l.push(entry); if (l.length > 60) l.shift(); };

  function onChange({ event, agents: touched }) {
    for (const a of touched) agents.set(a.id, a);
    switch (event.type) {
      case 'task.assigned': enqueue(event.agentId, event.data); break;
      case 'chat.sent': remember(event.agentId, event.data.entry); replyTo(event.agentId, event.data.entry); break;
      case 'chat.replied': remember(event.agentId, event.data.entry); break;
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

  function errorReason(err) {
    if (err instanceof ClaudeCodeError) return err.message;
    if (err instanceof Anthropic.AuthenticationError) return 'The Claude API rejected the key. Check it on the SETUP screen.';
    if (err instanceof Anthropic.RateLimitError) return 'The Claude API is rate limiting us. Try again in a minute.';
    if (err instanceof Anthropic.APIError) return `Claude API error ${err.status ?? ''}: ${err.message}`.slice(0, 200);
    return `Runtime error: ${err?.message || err}`.slice(0, 200);
  }

  async function reportFailure(agentId, err) {
    if (err instanceof Stopped || err instanceof ClaudeCodeStopped || err?.name === 'AbortError' || err instanceof Anthropic.APIUserAbortError) return;
    const reason = errorReason(err);
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
    const prompt = `Task given to ${agent.nick}: ${task.title}\n${task.details || ''}\n\nTheir summary: ${summary}\n\nFiles they wrote:\n${files.join('\n\n') || '(none)'}`;
    let v = null;
    const cfg = current();
    if (cfg.engine === 'claude-code') {
      const r = await cfg.claudeCode.structured({ prompt, systemPrompt: REVIEWER_SYSTEM, schema: REVIEW_SCHEMA, model: cfg.model, effort: cfg.effort, signal });
      await dex.emit('task.progress', reviewer.id, { tokens: r.tokens, tool: 'REVIEW' });
      v = r.output;
    } else {
      const res = await request({ system: REVIEWER_SYSTEM, messages: [{ role: 'user', content: prompt }], output_config: { format: { type: 'json_schema', schema: REVIEW_SCHEMA } } }, signal);
      await dex.emit('task.progress', reviewer.id, { tokens: (res.usage.input_tokens + res.usage.output_tokens) / 1000, tool: 'REVIEW' });
      if (res.stop_reason !== 'refusal') {
        try { v = JSON.parse(res.content.filter((b) => b.type === 'text').map((b) => b.text).join('')); } catch { /* unreadable */ }
      }
    }
    // Unreadable output counts as approved rather than blocking the task.
    const verdict = v && ['approved', 'changes'].includes(v.verdict) && Array.isArray(v.issues) ? v : { verdict: 'approved', issues: [], summary: '' };
    await dex.emit('review.finished', agent.id, { reviewerId: reviewer.id, result: verdict.verdict, issues: verdict.issues.length || 1 });
    return verdict;
  }

  async function runTask(agentId, task, signal) {
    const agent = agents.get(agentId);
    if (!agent || agent.boxed) return;
    const species = SPECIES[agent.species];
    const cfg = current();
    if (cfg.engine === 'claude-code') return runWithClaudeCode(agent, task, species, cfg, signal);
    if (!cfg.anthropic) {
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

  // ---------- talking (no task) ----------
  async function chatContext(agent) {
    let recent = [];
    try { recent = (await dex.state()).log.filter((e) => e.type === 'task.finished' && e.agentId === agent.id).slice(-3).map((e) => `- ${e.message}`); } catch { /* context is optional */ }
    const now = agent.status === 'PAR' ? 'waiting for the user to answer a YES / NO request'
      : agent.status === 'FNT' ? 'fainted and waiting for a reset'
      : agent.task ? `working on the task "${agent.task.title}"` : 'free, with no task';
    return `About you right now: you are ${now}. HP (context left for tasks) ${Math.round(agent.hp)} of ${agent.hpMax}.${recent.length ? `\nYour recent finished work:\n${recent.join('\n')}` : ''}`;
  }

  async function replyTo(agentId, entry) {
    const agent = agents.get(agentId);
    if (!agent || !entry) return;
    const via = entry.via;
    try {
      const cfg = current();
      const system = `${chatPrompt(SPECIES[agent.species], agent.nick)}\n\n${await chatContext(agent)}`;
      const history = (chats.get(agentId) || []).slice(-20);
      let text;
      if (cfg.engine === 'claude-code') {
        const transcript = history.map((e) => `${e.from === 'you' ? 'User' : agent.nick}: ${e.text}`).join('\n\n');
        text = await cfg.claudeCode.chat({ prompt: `Conversation so far:\n\n${transcript}\n\nReply to the user's last message.`, systemPrompt: system, model: cfg.model, effort: cfg.effort });
      } else {
        if (!cfg.anthropic) throw new Error('Add your Claude API key on the SETUP screen to talk to agents.');
        const messages = history.map((e) => ({ role: e.from === 'you' ? 'user' : 'assistant', content: e.text }));
        while (messages.length && messages[0].role !== 'user') messages.shift();
        text = await chatLoop(system, messages);
      }
      const { reply, task } = splitTask(text);
      await dex.emit('chat.replied', agentId, { text: reply, suggestedTask: task, via });
    } catch (err) {
      log(`[${agent.nick}] chat failed: ${err.message}`);
      await dex.emit('chat.failed', agentId, { reason: errorReason(err).replace(/^Runtime error: /, ''), via }).catch(() => {});
    }
  }

  // Messages API conversation with read-only file tools. Nothing here can write.
  async function chatLoop(system, messages) {
    const tools = FILE_TOOLS.filter((t) => t.name !== 'write_file');
    for (let turn = 0; turn < 8; turn++) {
      const res = await request({ system, tools, messages });
      messages.push({ role: 'assistant', content: res.content });
      const uses = res.content.filter((b) => b.type === 'tool_use');
      if (res.stop_reason === 'pause_turn') continue;
      if (!uses.length || res.stop_reason === 'refusal') return res.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
      const results = [];
      for (const b of uses) {
        try { results.push({ type: 'tool_result', tool_use_id: b.id, content: await workspace.tools[b.name](b.input || {}) }); }
        catch (err) { results.push({ type: 'tool_result', tool_use_id: b.id, content: err.message, is_error: true }); }
      }
      messages.push({ role: 'user', content: results });
    }
    return 'I looked around but ran out of steps. Ask me something more specific?';
  }

  // Same flow as runTask, but each round of work is one `claude -p` run (see claude-code.js).
  async function runWithClaudeCode(agent, task, species, cfg, signal) {
    const agentId = agent.id;
    if (agent.loc !== species.home) await dex.emit('agent.moved', agentId, { to: species.home });
    await dex.emit('task.started', agentId, { title: task.title, review: task.review });
    log(`[${agent.nick}] started with Claude Code: ${task.title}`);
    const ask = `Task: ${task.title}${task.details ? `\n\nDetails: ${task.details}` : ''}`;
    const work = (prompt) => cfg.claudeCode.runTask({
      agentId, prompt, signal,
      systemPrompt: systemPrompt(species, agent.nick),
      web: usesWeb(species), model: cfg.model, effort: cfg.effort,
      hpBudget: agents.get(agentId)?.hp ?? agent.hp,
      onProgress: (tokens, tool) => { dex.emit('task.progress', agentId, { tokens, tool }).catch(() => {}); },
    });
    let r = await work(ask);
    if (r.fainted) return;
    let { summary } = r;
    const written = new Set(r.written);
    const reviewer = task.review && [...agents.values()].find((x) => !x.boxed && SPECIES[x.species].reviewer && x.status !== 'FNT' && !x.reviewingId);
    if (reviewer) {
      const v = await review(agent, reviewer, task, summary, written, signal);
      if (v.verdict === 'changes') {
        await dex.emit('agent.moved', agentId, { to: species.home });
        r = await work(`${ask}\n\nYou already worked on this task; your files are in the workspace. Your summary was: ${summary}\n\n${reviewer.nick} reviewed it and asked for changes:\n${v.issues.map((i) => `- ${i}`).join('\n')}\n\nFix these, then reply with your one or two sentence summary again.`);
        if (r.fainted) return;
        summary = r.summary;
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
