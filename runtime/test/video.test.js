import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hookMarkup, creditLine, FONT_FILE, findTool, parseTime, checkSource, downloadArgs, filterGraph, renderArgs, parseVtt, parseSrt, assFile, toSrt, transcribeArgs, isClipLink, createVideo, VideoError, CAPTION_MODEL } from '../video.js';

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

test('the four layouts make a 1080x1920 picture, with the channel font', () => {
  assert.match(filterGraph({ layout: 'fit' }), /boxblur.*overlay=\(W-w\)\/2:\(H-h\)\/2,subtitles=clip\.ass:fontsdir=fonts\[v\]$/);
  assert.match(filterGraph({ layout: 'headline' }), /\[b\]scale=1080:608:force_original_aspect_ratio=increase,crop=1080:608,setsar=1\[fg\];\[bg\]\[fg\]overlay=0:640,subtitles=clip\.ass:fontsdir=fonts\[v\]$/, 'the whole 16:9 moment, facecam included');
  const split = filterGraph({ layout: 'split', corner: 'bottom-left', size: 0.3 });
  assert.match(split, /crop=iw\*0\.3:ih\*0\.3:0:ih-ih\*0\.3,scale=1080:608/);
  assert.match(split, /vstack=inputs=2,subtitles=clip\.ass:fontsdir=fonts\[v\]$/);
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
  assert.equal(toSrt([{ start: -1, end: 1.5, text: 'he did not' }, { start: 2, end: 3.25, text: 'expect that' }, { start: 20, end: 21, text: 'later' }], 10),
    '1\n00:00:00,000 --> 00:00:01,500\nhe did not\n\n2\n00:00:02,000 --> 00:00:03,250\nexpect that\n', 'an .srt CapCut can import, trimmed to the clip');
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
  for (const layout of ['headline', 'fit', 'split', 'center']) {
    const r = await video.makeClip({ source: 'inbox/stream.mp4', start: '0:02', end: '0:06', hook: 'He did *NOT* expect this', credit: 'KaiCenat', layout, corner: 'top-right', dir: out, name: `01-${layout}` });
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

test('Twitch and Kick clips download whole; Whisper runs inside ffmpeg with plain file names', () => {
  assert.ok(isClipLink('https://clips.twitch.tv/FunnyClip-abc'));
  assert.ok(isClipLink('https://www.twitch.tv/kaicenat/clip/FunnyClip-abc'));
  assert.ok(isClipLink('https://kick.com/xqc/clips/clip_01ABC'));
  assert.ok(!isClipLink('https://www.youtube.com/watch?v=abc'));
  const whole = downloadArgs({ url: 'https://clips.twitch.tv/x', start: 0, end: 30, whole: true });
  assert.ok(!whole.includes('--download-sections'), 'a short clip is not cut on download');
  const a = transcribeArgs({ input: 'C:\\Users\\me\\clip-raw.mp4', out: '.01-x-1.srt' });
  assert.deepEqual(a.slice(-6), ['-vn', '-af', `whisper=model=${CAPTION_MODEL.file}:language=en:queue=10:destination=.01-x-1.srt:format=srt`, '-f', 'null', '-']);
  assert.equal(a[a.indexOf('-i') + 1], 'C:\\Users\\me\\clip-raw.mp4', 'the input is an argument, never inside the filter, so Windows paths need no escaping');
  assert.deepEqual(parseSrt('1\n00:00:00,500 --> 00:00:02,000\nNO WAY\n\n2\n00:00:02,000 --> 00:00:03,250\nhe actually did it\n').map((c) => [c.start, c.end, c.text]), [[0.5, 2, 'NO WAY'], [2, 3.25, 'he actually did it']]);
  assert.equal(CAPTION_MODEL.url, 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin');
});

async function fakeVideo({ whisper = true, model = true, srt = '1\n00:00:00,000 --> 00:00:01,500\nCHAT HE DID IT\n\n2\n00:00:02,000 --> 00:00:03,000\n[Music]\n' } = {}) {
  const ws = await mkdtemp(path.join(os.tmpdir(), 'agentdex-cap-'));
  const models = path.join(ws, 'models');
  await mkdir(models, { recursive: true });
  if (model) await writeFile(path.join(models, CAPTION_MODEL.file), 'model');
  const calls = [];
  const runImpl = async (cmd, args, { cwd }) => {
    calls.push({ cmd, args, cwd });
    if (cmd === '/x/yt-dlp') return writeFile(path.join(cwd, 'src.mp4'), 'video');
    const af = args[args.indexOf('-af') + 1] || '';
    if (af.startsWith('whisper=')) { if (srt === null) throw new VideoError('ffmpeg failed: whisper'); return writeFile(path.join(cwd, /destination=([^:]+)/.exec(af)[1]), srt); }
    return writeFile(args[args.length - 1], 'mp4');
  };
  const video = createVideo({ workspaceRoot: ws, tools: { ffmpeg: '/x/ffmpeg', ytdlp: '/x/yt-dlp' }, runImpl, modelsDir: models, whisperCheck: async () => whisper });
  await video.checkWhisper();
  const dir = path.join(ws, 'clips');
  await mkdir(dir);
  return { video, calls, dir, models };
}

test('Whisper captions every clip, even Twitch clips with no subtitles', async () => {
  const t = await fakeVideo();
  assert.equal(t.video.tools().captions.ready, true);
  const r = await t.video.makeClip({ source: 'https://clips.twitch.tv/scream', start: 0, end: 28, hook: 'NO WAY', dir: t.dir, name: '01-scream' });
  assert.equal(r.captionSource, 'whisper');
  const dl = t.calls.find((c) => c.cmd === '/x/yt-dlp').args;
  assert.ok(!dl.includes('--download-sections'), 'the whole clip is downloaded');
  const w = t.calls.find((c) => (c.args[c.args.indexOf('-af') + 1] || '').startsWith('whisper='));
  assert.equal(w.cwd, t.models, 'runs in the models folder');
  assert.equal(w.args[w.args.indexOf('-i') + 1], path.join(t.dir, '01-scream-raw.mp4'), 'listens to the raw moment');
  assert.equal(await readFile(path.join(t.dir, '01-scream.srt'), 'utf8'), '1\n00:00:00,000 --> 00:00:01,500\nCHAT HE DID IT\n', '[Music] is not a caption');
  assert.deepEqual((await import('node:fs')).readdirSync(t.models), [CAPTION_MODEL.file], 'the temporary captions file is removed');
});

test('without the model or Whisper, clips still get made; a Whisper error is reported, not fatal', async () => {
  let t = await fakeVideo({ model: false });
  let r = await t.video.makeClip({ source: 'https://clips.twitch.tv/scream', start: 0, end: 28, dir: t.dir, name: '01-a' });
  assert.deepEqual([r.captions, r.captionSource, r.captionError], [false, null, null]);
  assert.ok(!t.calls.some((c) => (c.args[c.args.indexOf('-af') + 1] || '').startsWith('whisper=')));
  assert.equal(t.video.tools().captions.ready, false);
  t = await fakeVideo({ whisper: false });
  assert.deepEqual([t.video.tools().captions.whisper, t.video.tools().captions.model], [false, true]);
  t = await fakeVideo({ srt: null });
  r = await t.video.makeClip({ source: 'https://clips.twitch.tv/scream', start: 0, end: 28, dir: t.dir, name: '01-b' });
  assert.equal(r.captionSource, null);
  assert.match(r.captionError, /whisper/);
  assert.ok(existsSync(path.join(t.dir, '01-b-ready.mp4')));
});

test('the caption model is downloaded once and checked before it is used', async () => {
  const body = Buffer.from('pretend whisper model');
  const good = { file: 'm.bin', url: 'https://huggingface.co/m.bin', size: body.length, sha256: createHash('sha256').update(body).digest('hex') };
  const ws = await mkdtemp(path.join(os.tmpdir(), 'agentdex-model-'));
  const models = path.join(ws, 'models');
  const fetched = [];
  const fetchImpl = async (url) => { fetched.push(url); return new Response(body); };
  let video = createVideo({ workspaceRoot: ws, tools: { ffmpeg: '/x/ffmpeg', ytdlp: null }, modelsDir: models, whisperCheck: async () => true, fetchImpl, captionModel: good });
  const first = video.getCaptionModel();
  assert.ok(first.downloading, 'starts in the background');
  await first.done;
  assert.equal(await readFile(path.join(models, 'm.bin'), 'utf8'), 'pretend whisper model');
  await video.getCaptionModel().done;
  assert.equal(fetched.length, 1, 'not downloaded twice');

  video = createVideo({ workspaceRoot: ws, tools: { ffmpeg: '/x/ffmpeg', ytdlp: null }, modelsDir: path.join(ws, 'other'), whisperCheck: async () => true, fetchImpl, captionModel: { ...good, sha256: '0'.repeat(64) } });
  await video.getCaptionModel().done;
  assert.match(video.tools().captions.error, /did not match its checksum/);
  assert.ok(!existsSync(path.join(ws, 'other', 'm.bin')) && !existsSync(path.join(ws, 'other', 'm.bin.part')), 'a bad file is deleted');
  assert.throws(() => createVideo({ workspaceRoot: ws }).getCaptionModel(), /real agents/);
});

test('headline frame: the key word in the accent colour, the credit above, captions under the moment', () => {
  assert.equal(hookMarkup('Kai did *not* see {it} coming'), 'KAI DID {\\c&H000AD6FF&}NOT{\\c&H00FFFFFF&} SEE IT COMING', 'stars become the accent; typed braces never style anything');
  assert.equal(creditLine('@Kai Cenat', 'https://clips.twitch.tv/x'), '@KAICENAT ON TWITCH');
  assert.equal(creditLine('xQc', 'https://kick.com/xqc/clips/clip_1'), '@XQC ON KICK');
  assert.equal(creditLine(''), '');
  const ass = assFile({ hook: 'Kai did *NOT* see the cops coming', cues: [{ start: 0, end: 2, text: 'chat he really did' }], duration: 20, layout: 'headline', credit: 'KaiCenat', source: 'https://clips.twitch.tv/x' });
  assert.match(ass, /Dialogue: 1,0:00:00\.00,0:00:20\.00,Head,,0,0,0,,\{\\an2\\pos\(540,596\)\\fs150\}KAI DID \{\\c&H000AD6FF&\}NOT/, 'the headline stays the whole clip, just above the moment');
  assert.match(ass, /Credit,,0,0,0,,\{\\an2\\pos\(540,274\)\}@KAICENAT ON TWITCH/, 'two lines of headline, the credit above them');
  assert.match(ass, /Style: Cap,Anton,116,.*,8,60,60,1304,1/, 'captions start just under the moment, clear of the buttons and titles at the bottom');
  assert.match(assFile({ hook: 'x'.repeat(70), duration: 5, layout: 'headline' }), /\\fs118\}/, 'a long hook gets smaller instead of a third line');
  assert.ok(existsSync(FONT_FILE), 'the font ships with Agentdex');
});
