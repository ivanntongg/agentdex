// What each species is for, as a system prompt. The job text comes from its role (server/roles.js):
// a built-in role (maybe rewritten by the user) or a custom role the user described.
import { roleFor, ROLE_DEFAULTS } from '../server/roles.js';

const SHARED = `You work inside a sandboxed workspace folder on the user's computer. Use the file tools to look around, read and write.
Put new work in the drafts/ folder: writing there needs no permission. Writing anywhere else asks the user first, so only do that when the task clearly needs it, and expect that they may say no.
When you are done, reply with one or two plain sentences: what you did and which files to open. No headings, no lists.`;

const roleText = (species) => {
  const { job } = roleFor(species);
  return species?.custom ? `You are the team's ${species.title}. ${job}` : job;
};

export function systemPrompt(species, nick) {
  const role = roleText(species);
  return `Your name is ${nick}. ${role}\n\n${SHARED}`;
}

// For talking, not working: in character, short, read-only, and a clear hand-off to a task.
export function chatPrompt(species, nick) {
  const role = roleText(species);
  return `Your name is ${nick}. ${role}

Right now the user is chatting with you, not giving you a task. Answer in a few plain sentences, in your own voice. No headings or lists unless they ask.
You can look at files in the workspace with the read-only tools to answer questions about your work. In a chat you cannot create or change files.
If the user asks you to do a piece of work, say in a sentence how you would do it, then end your reply with one last line in exactly this form:
TASK: <the job in one short sentence>
They can then turn it into a task with one button.`;
}

// Splits a chat reply into the text to show and an optional suggested task.
export function splitTask(text) {
  const lines = String(text || '').trim().split('\n');
  let task = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*\**TASK:\**\s*(.+?)\s*$/i.exec(lines[i]);
    if (m) { task = m[1].replace(/^<|>$/g, '').trim(); lines.splice(i, 1); break; }
  }
  return { reply: lines.join('\n').trim() || 'OK.', task: task || null };
}

export const usesWeb = (species) => (species?.custom ? Boolean(species.web) : species.types.some((t) => roleFor({ types: [t] }).web));

// The user's own review rules, if they rewrote the QA role.
export function reviewerSystem() {
  const r = roleFor({ types: ['QA'] });
  return r.edited && r.job !== ROLE_DEFAULTS.QA.job ? `${REVIEWER_SYSTEM}\n\nThe user's own review rules, which come first:\n${r.job}` : REVIEWER_SYSTEM;
}

export const REVIEWER_SYSTEM = `You review work another agent did for the user. Judge it only against the task it was given.
Approve work that does what was asked, even if you would have done it differently. Ask for changes only for real problems: missing parts of the task, factual errors, broken code, or files the task needed that are not there.
Each issue must be one concrete sentence the author can act on.`;

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approved', 'changes'] },
    issues: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['verdict', 'issues', 'summary'],
  additionalProperties: false,
};
