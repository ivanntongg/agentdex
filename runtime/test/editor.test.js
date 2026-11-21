import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkspace } from '../workspace.js';
import { createEditor, EDIT_SYSTEM } from '../editor.js';

const FOLDER = 'drafts/gta-6-clipping/2026-11-21';

async function setup({ tools = { ffmpeg: '/x/ffmpeg', ytdlp: '/x/yt-dlp' }, cut = null, approval = 'yes', notes = true } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentdex-edit-'));
  const workspace = await createWorkspace(dir);
  if (notes) {
    await mkdir(path.join(workspace.root, FOLDER), { recursive: true });
    await writeFile(path.join(workspace.root, FOLDER, 'moments.md'), '1. Speed crashes a plane, https://www.youtube.com/watch?v=abc 1:02:03 to 1:02:40');
  }
  const made = [];
  const approvals = [];
  const asked = [];
  const video = {
    tools: () => tools,
    makeClip: async (o) => { made.push(o); if (o.name.endsWith('-boom')) throw new Error('download failed'); await writeFile(path.join(o.dir, `${o.name}-ready.mp4`), 'x'); return { file: '', raw: '', captions: o.source.includes('youtube') }; },
  };
  const editor = createEditor({
    video, workspace, log: () => {},
    dex: { emit: async () => ({}) },
    ask: async (q) => { asked.push(q); return cut ?? { clips: [
      { source: 'https://www.youtube.com/watch?v=abc', start: '1:02:03', end: '1:02:40', hook: 'He did NOT expect this', title: 'Speed vs the plane', caption: '#gta6 #speed', layout: 'split', corner: 'top-right' },
      { source: 'https://evil.example/x', start: '0', end: '30', hook: 'x', title: 'Bad host', caption: '', layout: 'fit', corner: 'top-right' },
      { source: 'https://www.twitch.tv/videos/1', start: '10:00', end: '9:00', hook: 'x', title: 'Backwards', caption: '', layout: 'fit', corner: 'top-right' },
    ] }; },
    waitForApproval: async (agentId, data) => { approvals.push(data); return approval; },
  });
  return { editor, workspace, made, approvals, asked };
}
const agent = { id: 7, nick: 'VIDEO' };
const task = { title: 'Cut and edit the clips', details: 'Make vertical clips.', edit: { folder: FOLDER } };

test('moments become finished clips after one YES: raw for CapCut, ready to post, and posts.md', async () => {
  const t = await setup();
  const r = await t.editor.run(agent, task);
  assert.equal(t.asked[0].system, EDIT_SYSTEM);
  assert.match(t.asked[0].prompt, /--- moments\.md ---\n1\. Speed crashes a plane/);
  assert.deepEqual(t.approvals[0], { tool: 'CUT', target: `1 clip into ${FOLDER}/clips (downloads from youtube.com)` }, 'one question for the batch; bad clips never reach it');
  assert.equal(t.made.length, 1);
  assert.deepEqual([t.made[0].name, t.made[0].layout, t.made[0].hook], ['01-speed-vs-the-plane', 'split', 'He did NOT expect this']);
  assert.deepEqual(r.files, [`${FOLDER}/clips/01-speed-vs-the-plane-ready.mp4`, `${FOLDER}/clips/01-speed-vs-the-plane-raw.mp4`, `${FOLDER}/clips/posts.md`]);
  assert.match(r.summary, /^Made 1 of 3 clips in .*clips: each has a -ready file to post and a -raw file for CapCut.*Skipped 2: .*only downloads from YouTube, Twitch and Kick.*must be 3 seconds/);
  const posts = await readFile(path.join(t.workspace.root, FOLDER, 'clips', 'posts.md'), 'utf8');
  assert.match(posts, /## 1\. Speed vs the plane\nFiles: 01-speed-vs-the-plane-ready\.mp4 \(post as is\) and 01-speed-vs-the-plane-raw\.mp4 \(edit in CapCut\)/);
  assert.match(posts, /Caption:\n#gta6 #speed/);
  assert.equal(r.failed, false);
});

test('NO means nothing is downloaded or cut', async () => {
  const t = await setup({ approval: 'no' });
  const r = await t.editor.run(agent, task);
  assert.equal(r.declined, true);
  assert.equal(t.made.length, 0);
});

test('missing tools, missing notes and unusable moments are explained plainly', async () => {
  let t = await setup({ tools: { ffmpeg: null, ytdlp: null } });
  assert.match((await t.editor.run(agent, task)).summary, /needs ffmpeg on this computer\. Open SETUP, Video tools/);
  t = await setup({ tools: { ffmpeg: '/x/ffmpeg', ytdlp: null } });
  assert.match((await t.editor.run(agent, task)).summary, /needs yt-dlp on this computer/);
  assert.equal(t.approvals.length, 0, 'never asks when it cannot do the work');
  t = await setup({ notes: false });
  assert.match((await t.editor.run(agent, task)).summary, /Nothing to cut yet: .* has no moments\.md or clips\.md/);
  t = await setup({ cut: { clips: [{ source: 'https://evil.example/x', start: '0', end: '30', hook: '', title: 'x', caption: '', layout: 'fit', corner: 'top-left' }] } });
  const r = await t.editor.run(agent, task);
  assert.equal(r.failed, true);
  assert.match(r.summary, /No moment had a usable link and times/);
});

test('one broken clip does not stop the rest', async () => {
  const t = await setup({ cut: { clips: [
    { source: 'https://www.youtube.com/watch?v=a', start: '0', end: '30', hook: 'a', title: 'boom', caption: '', layout: 'fit', corner: 'top-left' },
    { source: 'https://www.youtube.com/watch?v=b', start: '0', end: '30', hook: 'b', title: 'fine', caption: '', layout: 'fit', corner: 'top-left' },
  ] } });
  const r = await t.editor.run(agent, task);
  assert.match(r.summary, /^Made 1 of 2 clips.*Skipped 1: 01-boom: download failed/);
  assert.ok(r.files.includes(`${FOLDER}/clips/02-fine-ready.mp4`));
});
