#!/usr/bin/env node
// Claude Code PreToolUse hook used by Agentdex's "My Claude subscription" mode.
//
// Claude Code runs this before every file write or edit. Writes inside workspace/drafts go
// through; writes anywhere else in the workspace become a YES / NO request in the town, and this
// script waits for the player's answer. Anything outside the workspace is refused.
//
// Reads the PreToolUse JSON on stdin and prints a permission decision on stdout.
// Settings come from the environment Agentdex starts Claude Code with:
//   AGENTDEX_URL, AGENTDEX_TOKEN, AGENTDEX_AGENT_ID, AGENTDEX_WORKSPACE
import { realpathSync } from 'node:fs';
import path from 'node:path';

const POLL_MS = Number(process.env.AGENTDEX_HOOK_POLL_MS || 1000);

function decide(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
  }));
  process.exit(0);
}

async function readStdin() {
  let raw = '';
  for await (const c of process.stdin) raw += c;
  return JSON.parse(raw || '{}');
}

// The deepest part of the path that exists, with symlinks resolved, then the rest appended.
function realish(p) {
  let head = p;
  const tail = [];
  while (true) {
    try { return path.join(realpathSync(head), ...tail.reverse()); } catch {
      const up = path.dirname(head);
      if (up === head) return p;
      tail.push(path.basename(head));
      head = up;
    }
  }
}

async function main() {
  const { AGENTDEX_URL: url, AGENTDEX_TOKEN: token, AGENTDEX_AGENT_ID: agentId, AGENTDEX_WORKSPACE: ws } = process.env;
  if (!url || !agentId || !ws) decide('deny', 'Agentdex is not connected, so this write cannot be approved.');

  let input;
  try { input = await readStdin(); } catch { decide('deny', 'Could not read the tool call.'); }
  const target = input.tool_input?.file_path || input.tool_input?.notebook_path;
  if (!target) decide('deny', 'This tool call has no file path.');

  const root = realish(ws);
  const abs = realish(path.resolve(input.cwd || ws, target));
  const rel = path.relative(root, abs);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    decide('deny', `${target} is outside the workspace. Only files inside the workspace folder can be written.`);
  }
  const shown = rel.split(path.sep).join('/');
  if (shown === '.agentdex' || shown.startsWith('.agentdex/')) decide('deny', `${shown} belongs to Agentdex (installed skills). You can read it but not change it.`);
  if (shown === 'drafts' || shown.startsWith('drafts/')) decide('allow', 'Files in drafts/ need no permission.');

  const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  let approvalId;
  try {
    const res = await fetch(`${url}/api/ingest`, { method: 'POST', headers, body: JSON.stringify({ type: 'approval.requested', agentId, data: { tool: 'WRITE', target: shown } }) });
    if (!res.ok) throw new Error(String(res.status));
    approvalId = (await res.json()).events[0].data.approvalId;
  } catch {
    decide('deny', 'Could not reach Agentdex to ask the user, so the write was not made.');
  }

  while (true) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let state;
    try { state = await (await fetch(`${url}/api/state`)).json(); } catch { continue; }
    if (state.approvals.some((a) => a.id === approvalId)) continue;
    const answer = state.log.find((e) => e.type === 'approval.resolved' && e.data?.approvalId === approvalId);
    if (answer?.data?.decision === 'yes') decide('allow', 'The user approved this write.');
    if (answer?.data?.decision === 'no') decide('deny', `The user declined writing ${shown}. Do not retry it; put the work in drafts/ or explain what you would have changed.`);
    decide('deny', 'The request was cancelled before the user answered.');
  }
}

main().catch(() => decide('deny', 'The approval check failed, so the write was not made.'));
