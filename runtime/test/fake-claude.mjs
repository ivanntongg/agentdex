// A stand-in for `claude -p --output-format stream-json`, for tests. It reads the same flags,
// runs the PreToolUse hook from --settings exactly like Claude Code would before each write,
// and prints stream-json events. Behaviour is picked with FAKE_SCENARIO.
import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const prompt = flag('-p');
const settings = JSON.parse(flag('--settings') || '{}');
const scenario = process.env.FAKE_SCENARIO || 'normal';
const out = (ev) => process.stdout.write(JSON.stringify(ev) + '\n');
const log = (entry) => { if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + '\n'); };
log({ args });

out({ type: 'system', subtype: 'init', model: flag('--model') || 'default', tools: (flag('--tools') || '').split(',') });

if (scenario === 'not-logged-in') {
  out({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login' });
  process.exit(1);
}

if (flag('--json-schema') !== undefined) {
  const marker = `${process.env.FAKE_LOG}.reviewed`;
  const first = !existsSync(marker);
  if (first) writeFileSync(marker, '1');
  const verdict = scenario === 'review-changes' && first
    ? { verdict: 'changes', issues: ['Add a short comparison table.'], summary: '' }
    : { verdict: 'approved', issues: [], summary: 'Looks right.' };
  out({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(verdict), structured_output: verdict, usage: { input_tokens: 800, output_tokens: 60 } });
  process.exit(0);
}

if (prompt === 'Reply with the single word OK.') {
  out({ type: 'result', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 10, output_tokens: 1 } });
  process.exit(0);
}

// Runs the configured PreToolUse hook the way Claude Code does and returns its decision.
function hook(toolName, filePath) {
  const h = settings.hooks?.PreToolUse?.[0]?.hooks?.[0];
  if (!h) return 'allow';
  const stdout = execSync(h.command, { input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: process.cwd(), tool_name: toolName, tool_input: { file_path: filePath, content: 'x' } }), env: process.env, timeout: (h.timeout || 600) * 1000 }).toString();
  const decision = JSON.parse(stdout).hookSpecificOutput;
  log({ hook: filePath, decision: decision.permissionDecision, reason: decision.permissionDecisionReason });
  return decision.permissionDecision;
}

let used = 4000;
const step = (toolName, rel, extra = 0) => {
  used += 3000 + extra;
  const abs = path.resolve(process.cwd(), rel);
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: `t${used}`, name: toolName, input: { file_path: abs, content: 'x' } }], usage: { input_tokens: used, output_tokens: 200 } } });
  if (hook(toolName, abs) === 'allow') { mkdirSync(path.dirname(abs), { recursive: true }); writeFileSync(abs, `written by fake claude: ${rel}\n`); }
};

if (scenario === 'huge') {
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Reading everything.' }], usage: { input_tokens: 990000, output_tokens: 100 } } });
  setTimeout(() => out({ type: 'result', subtype: 'success', is_error: false, result: 'never reached' }), 3000);
} else {
  step('Write', 'drafts/plan.md');
  step('Write', 'notes/final.md');
  step('Write', '../escape.txt');
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: used + 1000, output_tokens: 150 } } });
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: 4, result: prompt.includes('asked for changes') ? 'Added the comparison table to notes/final.md.' : 'Wrote a plan in drafts and the summary in notes/final.md.', usage: { input_tokens: used, output_tokens: 600 } });
}
