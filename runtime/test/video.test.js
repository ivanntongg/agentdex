import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findTool, parseTime, checkSource, downloadArgs, filterGraph, renderArgs, parseVtt, assFile, createVideo, VideoError } from '../video.js';

test('times in every shape people write them', () => {
  assert.equal(parseTime('1:02:03'), 3723);
  assert.equal(parseTime('62:03'), 3723);
  assert.equal(parseTime('3723'), 3723);
  assert.equal(parseTime('1h2m3s'), 3723);
  assert.equal(parseTime('45s'), 45);
  assert.equal(parseTime(12.5), 12.5);
  assert.throws(() => parseTime('soon'), VideoError);
});

test('only YouTube, Twitch and Kick links, or files inside the workspace', () => {
  assert.equal(checkSource('https://www.youtube.com/watch?v=abc', '/ws').kind, 'url');
  assert.equal(checkSource('https://clips.twitch.tv/SomeClip', '/ws').kind, 'url');
  assert.throws(() => checkSource('https://evil.example/x.mp4', '/ws'), /only downloads from YouTube, Twitch and Kick/);
  assert.throws(() => checkSource('file:///etc/passwd', '/ws'), VideoError);
  assert.deepEqual(checkSource('inbox/footage.mp4', '/ws'), { kind: 'file', file: path.resolve('/ws', 'inbox/footage.mp4'), rel: 'inbox/footage.mp4' });
  assert.throws(() => checkSource('../secret.mp4', '/ws'), /not a link or a file in the workspace/);
});

test('yt-dlp downloads only the moment, with subtitles; the arguments never come from a shell', () => {
  const a = downloadArgs({ url: 'https://www.youtube.com/watch?v=abc', start: 3723, end: 3753.5, ffmpegDir: '/opt/ff' });
  assert.equal(a[0], 'https://www.youtube.com/watch?v=abc');
  assert.equal(a[a.indexOf('--download-sections') + 1], '*1:02:03.00-1:02:33.50');
  assert.ok(a.includes('--write-auto-subs'));
  assert.equal(a[a.indexOf('--ffmpeg-location') + 1], '/opt/ff');
});

test('the three layouts make a 1080x1920 picture', () => {
  assert.match(filterGraph({ layout: 'fit' }), /boxblur.*overlay=\(W-w\)\/2:\(H-h\)\/2,subtitles=clip\.ass\[v\]$/);
  const split = filterGraph({ layout: 'split', corner: 'bottom-left', size: 0.3 });
  assert.match(split, /crop=iw\*0\.3:ih\*0\.3:0:ih-ih\*0\.3,scale=1080:608/);
  assert.match(split, /vstack=inputs=2,subtitles=clip\.ass\[v\]$/);
  assert.match(filterGraph({ layout: 'center', captions: null }), /^\[0:v\]crop=ih\*9\/16:ih,scale=1080:1920,setsar=1\[v\]$/);
  const r = renderArgs({ input: 'src.mp4', out: '/d/01-ready.mp4', layout: 'fit', seek: 12, duration: 30 });
  assert.deepEqual(r.slice(r.indexOf('-ss'), r.indexOf('-ss') + 6), ['-ss', '12', '-i', 'src.mp4', '-t', '30']);
});

test('YouTube auto-captions are cleaned, and the hook and captions fit the frame', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhe did not\n\n00:00:02.000 --> 00:00:03.500\nhe did not <c>expect</c> that\n\n00:00:03.500 --> 00:00:04.000\nhe did not expect that\n';
  const cues = parseVtt(vtt);
  assert.deepEqual(cues.map((c) => c.text), ['he did not', 'expect that']);
  const ass = assFile({ hook: 'He did NOT {expect} this', cues, duration: 10, layout: 'fit' });
  assert.match(ass, /PlayResX: 1080\nPlayResY: 1920/);
  assert.match(ass, /Dialogue: 1,0:00:00\.00,0:00:03\.00,Hook,,0,0,0,,HE DID NOT EXPECT THIS/, 'braces are stripped so captions cannot inject styling');
  assert.match(ass, /,Cap,,0,0,0,,HE DID NOT\n/);
});

test('finds tools where the Windows and Mac installers put them', () => {
  const local = 'C:\\Users\\me\\AppData\\Local';
  assert.equal(findTool('ffmpeg', { platform: 'win32', env: { PATH: 'C:\\Windows', LOCALAPPDATA: local }, exists: (f) => f === `${local}\\Microsoft\\WinGet\\Links\\ffmpeg.exe` }), `${local}\\Microsoft\\WinGet\\Links\\ffmpeg.exe`);
  assert.equal(findTool('yt-dlp', { platform: 'darwin', env: { PATH: '/usr/bin' }, exists: (f) => f === '/opt/homebrew/bin/yt-dlp' }), '/opt/homebrew/bin/yt-dlp');
});

// A real render with the ffmpeg on this machine, when there is one.
const ffmpeg = findTool('ffmpeg');
const ffprobe = findTool('ffprobe');
test('a real clip from workspace footage: a raw moment for CapCut and a ready 9:16 version', { skip: !ffmpeg || !ffprobe ? 'ffmpeg is not installed here' : false }, async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), 'agentdex-video-'));
  await mkdir(path.join(ws, 'inbox'));
  execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', path.join(ws, 'inbox', 'stream.mp4')]);
  const out = path.join(ws, 'drafts', 'clips');
  await mkdir(out, { recursive: true });
  const video = createVideo({ workspaceRoot: ws, tools: { ffmpeg, ytdlp: null } });
  for (const layout of ['fit', 'split', 'center']) {
    const r = await video.makeClip({ source: 'inbox/stream.mp4', start: '0:02', end: '0:06', hook: 'He did not expect this', layout, corner: 'top-right', dir: out, name: `01-${layout}` });
    const dims = execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', r.file], { encoding: 'utf8' }).trim();
    assert.equal(dims, '1080,1920', `${layout} is 9:16`);
    const rawDims = execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', r.raw], { encoding: 'utf8' }).trim();
    assert.equal(rawDims, '1280,720', 'the raw moment keeps its original shape for CapCut');
    const dur = Number(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', r.file], { encoding: 'utf8' }));
    assert.ok(Math.abs(dur - 4) < 0.3, `about 4 seconds, got ${dur}`);
  }
  assert.ok(!existsSync(path.join(out, '.work-01-fit')), 'scratch files are cleaned up');
  await assert.rejects(video.makeClip({ source: 'https://www.youtube.com/watch?v=x', start: 0, end: 10, dir: out, name: 'x' }), /yt-dlp is not installed/);
});
