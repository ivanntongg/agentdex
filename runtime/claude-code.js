// "My Claude subscription" mode: each task runs the official Claude Code app (`claude -p`) on this
// computer, signed in with the user's own Claude plan. Agentdex never sees or stores that login;
// Claude Code handles it. For personal use on your own computer.
//
// Safety comes from Claude Code itself:
//   --restricted         no shell or code-running tools, file tools confined to the workspace,
//                        and the user's own Claude Code settings are not loaded
//   --strict-mcp-config  no MCP servers
//   a PreToolUse hook    (cc-hook.js) that turns writes outside drafts/ into a YES / NO in the town
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';

const HOOK = fileURLToPath(new URL('./cc-hook.js', import.meta.url));
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const MOVE_FOR_TOOL = { Read: 'READ', Glob: 'READ', Grep: 'READ', Write: 'EDIT', Edit: 'EDIT', MultiEdit: 'EDIT', WebSearch: 'SEARCH', WebFetch: 'FETCH' };

export class ClaudeCodeError extends Error {}

// Finds how to start Claude Code. On Windows, Node can only start .exe files directly, a window
// opened before an install does not see the new PATH, and npm installs a claude.cmd wrapper.
// So look for claude.exe on PATH and in the native installer's folder, then fall back to running
// the npm package's cli.js with Node. Checked on every run, so a fresh install is picked up
// without restarting Agentdex.
export function resolveClaude({ bin = 'claude', platform = process.platform, env = process.env, exists = existsSync, nodePath = process.execPath } = {}) {
  if (bin !== 'claude' || platform !== 'win32') return { command: bin, prefix: [] };
  const win = path.win32;
  const dirs = String(env.PATH || env.Path || '').split(';').map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean);
  const home = env.USERPROFILE || os.homedir();
  for (const d of [...dirs, win.join(home, '.local', 'bin')]) {
    const exe = win.join(d, 'claude.exe');
    if (exists(exe)) return { command: exe, prefix: [] };
  }
  const npmDirs = [...dirs, ...(env.APPDATA ? [win.join(env.APPDATA, 'npm')] : [])];
  for (const d of npmDirs) {
    const cli = win.join(d, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (exists(win.join(d, 'claude.cmd')) && exists(cli)) return { command: nodePath, prefix: [cli] };
  }
  return { command: bin, prefix: [] };
}
export class ClaudeCodeStopped extends Error {}

// Turns Claude Code's own error text into something a person can act on.
export function friendlyError(text) {
  const t = String(text || '');
  if (/not logged in|log ?in|\/login|authenticat|oauth|invalid api key/i.test(t)) return 'Claude Code is not signed in. Open a terminal, run claude, and sign in with your Claude account. Then try again.';
  if (/usage limit|limit reached|rate.?limit|too many requests|quota/i.test(t)) return 'Your Claude plan has hit its usage limit for now. It resets after a while; claude.ai shows when.';
  if (/ENOENT|not found|not recognized/i.test(t)) return 'Agentdex cannot find Claude Code. Open a new PowerShell or Terminal window and run claude --version. If that fails, install Claude Code; if it works, close Agentdex and start it again from that new window.';
  return `Claude Code stopped: ${t.slice(0, 180)}`;
}

export function createClaudeCode({ bin = 'claude', workspace, url, token = null, maxTurns = 30, spawnImpl = spawn }) {
  const hookSettings = JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: `"${process.execPath}" "${HOOK}"`, timeout: 3600 }] }] },
  });

  // Runs claude -p with stream-json output. Calls onEvent for each event; resolves with the result event.
  function run(args, { env = {}, signal, onEvent = () => {} } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        const { command, prefix } = resolveClaude({ bin });
        child = spawnImpl(command, [...prefix, ...args], { cwd: workspace.root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch (err) { reject(new ClaudeCodeError(friendlyError(err.code || err.message))); return; }
      let result = null;
      let stopped = false;
      let stderr = '';
      const stop = () => { stopped = true; child.kill(); };
      if (signal) { if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true }); }
      createInterface({ input: child.stdout }).on('line', (line) => {
        let ev;
        try { ev = JSON.parse(line); } catch { return; }
        if (ev.type === 'result') result = ev;
        try { onEvent(ev, stop); } catch { /* a reporting hiccup must not end the task */ }
      });
      child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
      child.on('error', (err) => reject(new ClaudeCodeError(friendlyError(err.code === 'ENOENT' ? 'ENOENT' : err.message))));
      child.on('close', (code) => {
        signal?.removeEventListener?.('abort', stop);
        if (stopped) return reject(new ClaudeCodeStopped());
        if (result) return resolve(result);
        reject(new ClaudeCodeError(friendlyError(stderr.trim() || `exited with code ${code}`)));
      });
    });
  }

  const baseArgs = (prompt, { model, effort }) => [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--restricted', '--strict-mcp-config', '--no-session-persistence',
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
  ];

  // One agent task. Returns { summary, written: Set<relPath> } or { fainted: true } when the
  // agent's context passed its HP.
  async function runTask({ agentId, prompt, systemPrompt, web, model, effort, hpBudget, signal, onProgress = () => {} }) {
    const tools = ['Read', 'Write', 'Edit', 'Glob', 'Grep', ...(web ? ['WebSearch', 'WebFetch'] : [])];
    const args = [
      ...baseArgs(prompt, { model, effort }),
      '--tools', tools.join(','),
      '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
      '--max-turns', String(maxTurns),
      '--settings', hookSettings,
      '--append-system-prompt', systemPrompt,
      ...(web ? ['--allowedTools', 'WebSearch,WebFetch'] : []),
    ];
    const env = { AGENTDEX_URL: url, AGENTDEX_AGENT_ID: String(agentId), AGENTDEX_WORKSPACE: workspace.root, ...(token ? { AGENTDEX_TOKEN: token } : {}) };
    let context = 0;
    let fainted = false;
    const written = new Set();
    const result = await run(args, {
      env,
      signal,
      onEvent: (ev, stop) => {
        if (ev.type !== 'assistant' || ev.parent_tool_use_id) return;
        const content = ev.message?.content || [];
        for (const b of content) {
          if (b.type === 'tool_use' && WRITE_TOOLS.has(b.name) && b.input?.file_path) {
            const rel = path.relative(workspace.root, path.resolve(workspace.root, b.input.file_path)).split(path.sep).join('/');
            if (rel && !rel.startsWith('..')) written.add(rel);
          }
        }
        const u = ev.message?.usage;
        if (!u) return;
        const now = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
        const added = Math.max(0, now - context);
        context = Math.max(context, now);
        const tool = content.find((b) => b.type === 'tool_use')?.name;
        onProgress(added / 1000, MOVE_FOR_TOOL[tool] || 'READ');
        if (hpBudget && context / 1000 >= hpBudget) { fainted = true; stop(); }
      },
    }).catch((err) => { if (fainted && err instanceof ClaudeCodeStopped) return null; throw err; });
    if (fainted) return { fainted: true };
    if (result.subtype === 'error_max_turns') return { summary: `Stopped after ${maxTurns} steps without finishing.`, written };
    if (result.is_error || (result.subtype && result.subtype !== 'success')) throw new ClaudeCodeError(friendlyError(result.result || result.subtype));
    return { summary: String(result.result || '').replace(/\s+/g, ' ').trim() || 'Done.', written };
  }

  // A tool-less call that must answer in the given JSON schema. Returns { output, tokens }.
  async function structured({ prompt, systemPrompt, schema, model, effort, signal }) {
    const args = [
      ...baseArgs(prompt, { model, effort }),
      '--tools', '', '--max-turns', '3',
      '--json-schema', JSON.stringify(schema),
      ...(systemPrompt ? ['--append-system-prompt', systemPrompt] : []),
    ];
    const result = await run(args, { signal });
    if (result.is_error) throw new ClaudeCodeError(friendlyError(result.result || result.subtype));
    let output = result.structured_output ?? null;
    if (!output && typeof result.result === 'string') { try { output = JSON.parse(result.result); } catch { /* leave null */ } }
    const u = result.usage || {};
    return { output, tokens: ((u.input_tokens || 0) + (u.output_tokens || 0)) / 1000 };
  }

  // A short real call, used by SETUP's TEST button.
  async function check({ model } = {}) {
    const result = await run([...baseArgs('Reply with the single word OK.', { model }), '--tools', '', '--max-turns', '1']);
    if (result.is_error) throw new ClaudeCodeError(friendlyError(result.result || result.subtype));
    return result;
  }

  return { runTask, structured, check };
}
