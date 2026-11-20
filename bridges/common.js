// What the phone bridges (WhatsApp, Telegram) say. Shared so both read the same.

export const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

// The text of a YES / NO request.
export function approvalText(ap, agents) {
  const a = agents.get(ap.agentId);
  const who = a ? a.nick : 'An agent';
  if (ap.kind === 'skill') {
    const k = ap.skill;
    const notes = (k.flags || []).filter((f) => f.level !== 'info').map((f) => `! ${f.text}`).join('\n');
    return `${who} wants to learn the skill "${k.name}" from ${k.source}${k.installs ? ` (${k.installs} installs)` : ''}.\n${k.description || ''}${k.review ? `\n${k.review.by || 'Review'}: ${k.review.summary || k.review.verdict}` : '\nNobody reviewed it, so read it before you say YES.'}${notes ? `\n${notes}` : ''}\n${k.url}`;
  }
  return ap.kind === 'evolve'
    ? `${who} is ready to evolve into ${ap.toName}: a bigger model with more permissions. Allow it?`
    : `${who} wants to use ${ap.tool} on ${ap.target}.${ap.taskTitle ? `\nTask: ${ap.taskTitle}` : ''}`;
}

// "status": what everyone in the party is doing.
export function statusTextFor(party, approvals) {
  const lines = party.map((a) => {
    const now = a.status === 'PAR' ? 'waiting for your OK'
      : a.status === 'FNT' ? 'fainted, needs a reset'
      : a.reviewingId ? 'reviewing'
      : a.task ? `working on "${clip(a.task.title, 60)}"` : 'idle';
    return `${a.nick} (Lv ${a.lv}): ${now}. HP ${Math.round(a.hp)}/${a.hpMax}`;
  });
  return [`Party (${lines.length})`, ...lines, approvals.length ? `${approvals.length} request(s) need you. Sending them now.` : 'Nothing needs you.'].join('\n');
}

export function helpText(app = 'WhatsApp') {
  return [
    'Agentdex remote control',
    '• status: what everyone is doing',
    '• compare 3 note apps: the best-suited free agent takes it',
    '• scout compare 3 note apps: start with a name to choose the agent',
    '• @scout how is it going?: talk to an agent without giving it a task',
    `• yes / no: answer the open request (or tap the buttons${app === 'Telegram' ? ' under it' : ''})`,
    '• reset scout: clear an agent that fainted or got stuck',
    '• rename scout to max: give an agent a new name',
  ].join('\n');
}

// Events that are worth a message on your phone.
export const NOTIFY = new Set(['approval.requested', 'task.finished', 'agent.fainted']);
