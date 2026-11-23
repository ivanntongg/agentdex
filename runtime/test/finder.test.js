import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkspace } from '../workspace.js';
import { createFinder, listArgs, channelArgs, videoArgs, heatmapPeaks, commentMoments, parseUsed, usedLine, momentsMarkdown } from '../finder.js';
import { parseStreamer, parseStreamers } from '../../server/streamers.js';

test('streamer links are read however people paste them', () => {
  assert.deepEqual(parseStreamer('twitch.tv/KaiCenat'), { platform: 'twitch', id: 'kaicenat', url: 'https://www.twitch.tv/kaicenat', label: 'kaicenat' });
  assert.deepEqual(parseStreamer('https://www.youtube.com/@IShowSpeed/streams'), { platform: 'youtube', id: '@IShowSpeed', url: 'https://www.youtube.com/@IShowSpeed', label: '@IShowSpeed' });
  assert.equal(parseStreamer('https://kick.com/xqc').url, 'https://kick.com/xqc');
  assert.equal(parseStreamer('youtube.com/channel/UCWsDFcIhY2DBi3GB5uykGXA').id, 'channel/UCWsDFcIhY2DBi3GB5uykGXA');
  for (const bad of ['tiktok.com/@x', 'twitch.tv/directory', 'youtube.com/watch?v=abc', 'hello', 'ftp://twitch.tv/x']) assert.equal(parseStreamer(bad), null, bad);
  const r = parseStreamers('twitch.tv/kaicenat, https://www.twitch.tv/KAICENAT\nkick.com/xqc\ntiktok.com/@x');
  assert.deepEqual(r.streamers.map((s) => s.url), ['https://www.twitch.tv/kaicenat', 'https://kick.com/xqc'], 'duplicates dropped');
  assert.deepEqual(r.bad, ['tiktok.com/@x']);
});

test('yt-dlp is only asked for lists and details, never a download', () => {
  assert.deepEqual(listArgs(parseStreamer('twitch.tv/kaicenat')).slice(0, 2), ['https://www.twitch.tv/kaicenat/clips?filter=clips&range=24hr', '--flat-playlist']);
  assert.equal(listArgs(parseStreamer('kick.com/xqc'))[0], 'https://kick.com/xqc/clips?sort=view&range=day');
  assert.equal(channelArgs(parseStreamer('youtube.com/@IShowSpeed'), 'streams')[0], 'https://www.youtube.com/@IShowSpeed/streams');
  const v = videoArgs('https://www.youtube.com/watch?v=abc');
  assert.ok(v.includes('--skip-download') && v.includes('--write-comments') && v.includes('-J'));
});

test('replay peaks: skips the intro, keeps peaks apart, and ignores long streams', () => {
  const heat = Array.from({ length: 100 }, (_, i) => ({ start_time: i * 30, end_time: i * 30 + 30, value: i === 0 ? 1 : i === 40 ? 0.9 : i === 41 ? 0.8 : i === 70 ? 0.6 : 0.1 }));
  const peaks = heatmapPeaks(heat, 3000);
  assert.deepEqual(peaks.map((p) => [p.start, p.end]), [[1195, 1240], [2095, 2140]], 'the intro bar and the neighbour of a peak are skipped');
  assert.deepEqual(heatmapPeaks(heat.map((h) => ({ ...h, start_time: h.start_time * 8, end_time: h.end_time * 8 })), 24000), [], 'a 6-hour stream has 4-minute bars: too vague');
});

test('timestamps in top comments become moments, most liked first', () => {
  const m = commentMoments([
    { text: 'bro at 1:02:03 i was crying', like_count: 900 },
    { text: '1:02:20 same moment', like_count: 50 },
    { text: '12:34 the plane 💀', like_count: 300 },
    { text: '99:99 not a time, 9:99:00 neither', like_count: 5000 },
  ], 4000);
  assert.deepEqual(m.map((x) => [x.start, x.end, x.likes]), [[3719, 3759, 900], [750, 790, 300]]);
  assert.match(m[0].text, /i was crying/);
});

test('used clips are remembered as "link start"', () => {
  assert.equal(usedLine('https://clips.twitch.tv/a', 0.4), 'https://clips.twitch.tv/a 0');
  assert.deepEqual(parseUsed('https://clips.twitch.tv/a 0\nnot a line\nhttps://youtu.be/b 600\n'), [{ url: 'https://clips.twitch.tv/a', start: 0 }, { url: 'https://youtu.be/b', start: 600 }]);
});

const FOLDER = 'drafts/streamer-clips/2026-11-23';
const NOW = new Date('2026-11-23T08:00:00Z');
const outputs = {
  'https://www.twitch.tv/kaicenat/clips?filter=clips&range=24hr': { entries: [
    { url: 'https://clips.twitch.tv/old-one', title: 'Already posted', duration: 30, view_count: 99999 },
    { url: 'https://clips.twitch.tv/scream', title: 'KAI SCREAMS AT THE JUMPSCARE', duration: 28.4, view_count: 51234 },
    { url: 'https://clips.twitch.tv/tiny', title: 'too short', duration: 3, view_count: 10 },
  ] },
  'https://kick.com/xqc/clips?sort=view&range=day': 'ERROR',
  'https://www.youtube.com/@IShowSpeed/streams': { entries: [{ id: 'abc' }, { id: 'live1', live_status: 'is_live' }] },
  'https://www.youtube.com/@IShowSpeed/videos': { entries: [{ id: 'abc' }] },
  'https://www.youtube.com/watch?v=abc': {
    title: 'SPEED PLAYS GTA 6', duration: 3000, view_count: 2_000_000, timestamp: NOW / 1000 - 3600,
    heatmap: Array.from({ length: 100 }, (_, i) => ({ start_time: i * 30, end_time: i * 30 + 30, value: i === 40 ? 0.9 : 0.1 })),
    comments: [{ text: '20:05 he really did that', like_count: 400 }, { text: '35:00 the police chase 😭', like_count: 120 }],
  },
};

async function setup({ streamers = ['twitch.tv/kaicenat', 'kick.com/xqc', 'youtube.com/@IShowSpeed'], ytdlp = '/x/yt-dlp' } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentdex-find-'));
  const workspace = await createWorkspace(dir);
  await mkdir(path.join(workspace.root, 'drafts/streamer-clips'), { recursive: true });
  await writeFile(path.join(workspace.root, 'drafts/streamer-clips/used-clips.txt'), 'https://clips.twitch.tv/old-one 0\n');
  const calls = [];
  const finder = createFinder({
    workspace, now: () => NOW, log: () => {},
    video: { tools: () => ({ ffmpeg: '/x/ffmpeg', ytdlp }) },
    dex: { emit: async () => ({}) },
    runImpl: async (cmd, args) => {
      calls.push(args);
      const out = outputs[args[0]];
      if (out === 'ERROR' || !out) throw new Error('Unable to download JSON metadata');
      return JSON.stringify(out);
    },
  });
  return { finder, workspace, calls, task: { title: 'Find moments', find: { folder: FOLDER, streamers } } };
}
const agent = { id: 3, nick: 'SCOUT' };

test('finds real moments from every streamer and writes moments.md', async () => {
  const t = await setup();
  const r = await t.finder.run(agent, t.task);
  assert.equal(r.failed, undefined);
  assert.deepEqual(r.files, [`${FOLDER}/moments.md`]);
  assert.match(r.summary, /^Found 3 real moments from 2 streamers.*Could not check 1: xqc on Kick: Unable to download JSON metadata/);
  const md = await readFile(path.join(t.workspace.root, FOLDER, 'moments.md'), 'utf8');
  assert.match(md, /^# Moments found 2026-11-23\n\nAgentdex found these itself/);
  // Streamers take turns: the top Twitch clip, then Speed's best YouTube moment, and so on.
  assert.match(md, /## 1\. KAI SCREAMS AT THE JUMPSCARE\nStreamer: kaicenat on Twitch\nLink: https:\/\/clips\.twitch\.tv\/scream\nStart: 0:00:00\nEnd: 0:00:28 \(28 seconds\)\nWhy: A top Twitch clip of the last 24 hours, 51,234 views\. Use the whole clip\./);
  assert.match(md, /## 2\. SPEED PLAYS GTA 6 \(most replayed\)\nStreamer: @IShowSpeed on YouTube\nLink: https:\/\/www\.youtube\.com\/watch\?v=abc\nStart: 0:19:55/);
  assert.match(md, /top comment \(120 likes\).*"35:00 the police chase/);
  assert.doesNotMatch(md, /Already posted|too short|live1/, 'used, too short and live videos are skipped');
  assert.doesNotMatch(md, /20:05 he really did that/, 'a comment at the same spot as a replay peak is not a second moment');
  assert.ok(!t.calls.some((a) => a[0].includes('live1')));
  assert.match(md, /## Could not check\n- xqc on Kick/);
});

test('clear messages when there is nothing to check', async () => {
  let t = await setup({ streamers: [] });
  assert.match((await t.finder.run(agent, t.task)).summary, /no streamers yet\. Open PLANS, edit the project/);
  t = await setup({ ytdlp: null });
  assert.match((await t.finder.run(agent, t.task)).summary, /needs yt-dlp/);
  t = await setup({ streamers: ['kick.com/xqc'] });
  const r = await t.finder.run(agent, t.task);
  assert.equal(r.failed, true);
  assert.match(r.summary, /^Could not check any streamer: xqc on Kick/);
});

test('moments.md says so when a day is quiet', () => {
  assert.match(momentsMarkdown([], { date: '2026-11-23' }), /No new moments today\./);
});
