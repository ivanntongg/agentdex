// Fixed video tools for the editing step. Agents never run programs themselves: Agentdex runs
// ffmpeg (cut, crop, captions) and yt-dlp (download only the seconds needed) with arguments it
// builds here, from sources it allows, into the workspace. Nothing else.
//
//   findTool('ffmpeg')        where an installed tool is (PATH, WinGet, Homebrew)
//   parseTime('1:02:03')      seconds
//   checkSource(src, ws)      a YouTube / Twitch / Kick link, or a file inside the workspace
//   downloadArgs / renderArgs the exact arguments, testable without running anything
//   assFile(...)              the hook and captions, styled for 9:16
//   createVideo({ ... })      fetch(), render(), tools()
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export class VideoError extends Error {}

export const ALLOWED_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'twitch.tv', 'www.twitch.tv', 'm.twitch.tv', 'clips.twitch.tv', 'kick.com', 'www.kick.com'];
export const LAYOUTS = ['fit', 'split', 'center'];
export const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const W = 1080;
const H = 1920;

// Where a command-line tool is: PATH first, then where the Windows and Mac installers put it.
export function findTool(name, { platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const file = win ? `${name}.exe` : name;
  const dirs = String(env.PATH || env.Path || '').split(win ? ';' : ':').map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean);
  const extra = win
    ? [env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'), env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps'), 'C:\\ffmpeg\\bin']
    : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', p.join(env.HOME || os.homedir(), '.local', 'bin')];
  for (const d of [...dirs, ...extra.filter(Boolean)]) {
    const f = p.join(d, file);
    if (exists(f)) return f;
  }
  return null;
}

// "1:02:03", "62:03", "3723", "1h2m3s", "45s", 12.5 -> seconds
export function parseTime(t) {
  if (typeof t === 'number' && Number.isFinite(t)) return t;
  const s = String(t ?? '').trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  let m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
  if (m) return (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]);
  m = /^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+(?:\.\d+)?)s)?$/.exec(s);
  if (m && (m[1] || m[2] || m[3])) return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  throw new VideoError(`"${t}" is not a time. Use seconds or 1:02:03.`);
}
const hms = (sec) => { const s = Math.max(0, sec); return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}`; };

// A link from an allowed site, or a file inside the workspace (footage a campaign gave you).
export function checkSource(src, workspaceRoot) {
  const s = String(src || '').trim();
  if (/^https?:\/\//i.test(s)) {
    let u;
    try { u = new URL(s); } catch { throw new VideoError(`${s} is not a valid link.`); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new VideoError('Only web links are allowed.');
    if (!ALLOWED_HOSTS.includes(u.hostname.toLowerCase())) throw new VideoError(`Agentdex only downloads from YouTube, Twitch and Kick, not ${u.hostname}. Put other footage in the workspace inbox.`);
    return { kind: 'url', url: u.toString() };
  }
  if (/^[a-z][a-z0-9+.-]+:/i.test(s)) throw new VideoError('Only YouTube, Twitch and Kick links, or files in the workspace, can be used.');
  const abs = path.resolve(workspaceRoot, s);
  const rel = path.relative(workspaceRoot, abs);
  if (!s || rel.startsWith('..') || path.isAbsolute(rel)) throw new VideoError(`${s || 'That'} is not a link or a file in the workspace.`);
  return { kind: 'file', file: abs, rel: rel.split(path.sep).join('/') };
}

// yt-dlp: only the moment, best quality up to 1080p, plus the video's own subtitles if it has any.
export function downloadArgs({ url, start, end, ffmpegDir = null }) {
  return [
    url, '--no-playlist', '--no-warnings', '--quiet', '--no-progress',
    '--download-sections', `*${hms(start)}-${hms(end)}`, '--force-keyframes-at-cuts',
    '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b', '--merge-output-format', 'mp4',
    '--write-subs', '--write-auto-subs', '--sub-langs', 'en.*,en', '--sub-format', 'vtt',
    ...(ffmpegDir ? ['--ffmpeg-location', ffmpegDir] : []),
    '-o', 'src.%(ext)s',
  ];
}

// The picture: 9:16, 1080x1920.
//   fit    the whole frame in the middle over a blurred, zoomed copy (works for any stream)
//   split  the streamer's facecam on top, the middle of the gameplay below
//   center the middle of the frame, zoomed to fill
export function filterGraph({ layout = 'fit', corner = 'top-right', size = 0.28, captions = 'clip.ass' }) {
  const sub = captions ? `,subtitles=${captions}` : '';
  if (layout === 'center') return `[0:v]crop=ih*9/16:ih,scale=${W}:${H},setsar=1${sub}[v]`;
  if (layout === 'split') {
    const f = Math.min(0.6, Math.max(0.12, Number(size) || 0.28));
    const x = corner.endsWith('left') ? '0' : `iw-iw*${f}`;
    const y = corner.startsWith('top') ? '0' : `ih-ih*${f}`;
    const camH = 608;            // 1080x608 is 16:9
    const gameH = H - camH;      // 1312
    return `[0:v]split=2[a][b];[a]crop=iw*${f}:ih*${f}:${x}:${y},scale=${W}:${camH},setsar=1[cam];`
      + `[b]crop=ih*${W}/${gameH}:ih:(iw-ow)/2:0,scale=${W}:${gameH},setsar=1[game];[cam][game]vstack=inputs=2${sub}[v]`;
  }
  return `[0:v]split=2[a][b];[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:4,setsar=1[bg];`
    + `[b]scale=${W}:-2,setsar=1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2${sub}[v]`;
}

export function renderArgs({ input, out, layout, corner, size, seek = null, duration, captions = 'clip.ass' }) {
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    ...(seek != null ? ['-ss', String(seek)] : []), '-i', input, '-t', String(duration),
    '-filter_complex', filterGraph({ layout, corner, size, captions }),
    '-map', '[v]', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out,
  ];
}

// The moment as it was, re-encoded only so every editor opens it cleanly.
export function rawArgs({ input, out, seek = null, duration }) {
  return ['-y', '-hide_banner', '-loglevel', 'error', ...(seek != null ? ['-ss', String(seek)] : []), '-i', input, '-t', String(duration),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out];
}

// WebVTT cues -> [{ start, end, text }] in seconds, auto-caption duplicates removed.
export function parseVtt(text) {
  const cues = [];
  const blocks = String(text || '').replace(/\r/g, '').split(/\n\n+/);
  for (const b of blocks) {
    const lines = b.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, z] = lines[i].split('-->').map((x) => x.trim().split(/\s+/)[0]);
    const words = lines.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    if (!words) continue;
    const prev = cues[cues.length - 1];
    if (prev && prev.text === words) continue;
    cues.push({ start: parseTime(a), end: parseTime(z), text: words });
  }
  // YouTube's rolling captions repeat the previous line; keep only the new words.
  const out = [];
  for (const c of cues) {
    const prev = out[out.length - 1];
    if (prev && c.text.startsWith(prev.text)) {
      const rest = c.text.slice(prev.text.length).trim();
      if (rest) out.push({ ...c, text: rest });
      continue;
    }
    out.push(c);
  }
  return out;
}

const assTime = (s) => { const t = Math.max(0, s); const cs = Math.round(t * 100); return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`; };
const assText = (t) => String(t).replace(/[{}\\]/g, '').replace(/\n/g, ' ').trim();

// The hook (big, top, first seconds) and captions (bold, 3 to 4 words at a time), styled for 9:16.
export function assFile({ hook = '', cues = [], duration, layout = 'fit' }) {
  const capY = layout === 'split' ? 700 : 520; // above the bottom for fit/center; under the facecam for split
  const events = [];
  if (hook) events.push(`Dialogue: 1,${assTime(0)},${assTime(Math.min(3, duration))},Hook,,0,0,0,,${assText(hook).toUpperCase()}`);
  for (const c of cues) {
    const words = c.text.split(' ');
    const span = Math.max(0.3, c.end - c.start);
    for (let i = 0; i < words.length; i += 4) {
      const a = c.start + (span * i) / words.length;
      const z = c.start + (span * Math.min(words.length, i + 4)) / words.length;
      if (z <= 0 || a >= duration) continue;
      events.push(`Dialogue: 0,${assTime(Math.max(0, a))},${assTime(Math.min(duration, z))},Cap,,0,0,0,,${assText(words.slice(i, i + 4).join(' ')).toUpperCase()}`);
    }
  }
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hook,Arial,78,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,7,3,8,60,60,170,1
Style: Cap,Arial,70,&H0000F0FF,&H0000F0FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,6,2,2,60,60,${capY},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join('\n')}
`;
}

function run(cmd, args, { cwd, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }); } catch (err) { return reject(new VideoError(err.message)); }
    let err = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const stop = () => child.kill();
    signal?.addEventListener('abort', stop, { once: true });
    child.stderr.on('data', (d) => { err = (err + d).slice(-1500); });
    child.on('error', (e) => { clearTimeout(timer); reject(new VideoError(e.code === 'ENOENT' ? `${path.basename(cmd)} is not installed.` : e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer); signal?.removeEventListener?.('abort', stop);
      if (code === 0) resolve(); else reject(new VideoError(`${path.basename(cmd)} failed: ${err.trim().split('\n').slice(-2).join(' ').slice(0, 300) || `exit ${code}`}`));
    });
  });
}

// tools: { ffmpeg, ytdlp } paths (found automatically by default).
export function createVideo({ workspaceRoot, tools = null, runImpl = run }) {
  const found = () => tools || { ffmpeg: findTool('ffmpeg'), ytdlp: findTool('yt-dlp') };

  // One finished clip: download (or read) the moment, write captions, render 9:16 into dir/name.mp4.
  async function makeClip({ source, start, end, hook, layout = 'fit', corner = 'top-right', size = 0.28, dir, name, signal }) {
    const t = found();
    if (!t.ffmpeg) throw new VideoError('ffmpeg is not installed. See SETUP, Video tools.');
    const a = parseTime(start);
    const z = parseTime(end);
    const duration = Math.round((z - a) * 100) / 100;
    if (!(duration >= 3 && duration <= 180)) throw new VideoError('A clip must be 3 seconds to 3 minutes long.');
    const src = checkSource(source, workspaceRoot);
    const work = path.join(dir, `.work-${name}`);
    await mkdir(work, { recursive: true });
    try {
      let input;
      let seek = null;
      let cues = [];
      if (src.kind === 'url') {
        if (!t.ytdlp) throw new VideoError('yt-dlp is not installed. See SETUP, Video tools.');
        await runImpl(t.ytdlp, downloadArgs({ url: src.url, start: a, end: z, ffmpegDir: path.dirname(t.ffmpeg) }), { cwd: work, timeoutMs: 10 * 60_000, signal });
        const files = await readdir(work);
        const vid = files.find((f) => /^src\.(mp4|mkv|webm)$/.test(f));
        if (!vid) throw new VideoError('The download did not produce a video.');
        input = vid;
        const vtt = files.find((f) => /^src\..*\.vtt$/.test(f));
        // Subtitles cover the whole video; keep this moment's, shifted to start at 0.
        if (vtt) cues = parseVtt(await readFile(path.join(work, vtt), 'utf8')).map((c) => ({ ...c, start: c.start - a, end: c.end - a })).filter((c) => c.end > 0 && c.start < duration);
      } else {
        if (!existsSync(src.file)) throw new VideoError(`${src.rel} does not exist.`);
        input = src.file;
        seek = a;
      }
      // The raw moment, untouched, for editing in CapCut.
      const raw = path.join(dir, `${name}-raw.mp4`);
      await runImpl(t.ffmpeg, rawArgs({ input, out: raw, seek, duration }), { cwd: work, timeoutMs: 5 * 60_000, signal });
      // The ready version: 9:16 with the hook and captions burned in.
      await writeFile(path.join(work, 'clip.ass'), assFile({ hook, cues, duration, layout }), 'utf8');
      const out = path.join(dir, `${name}-ready.mp4`);
      await runImpl(t.ffmpeg, renderArgs({ input, out, layout: LAYOUTS.includes(layout) ? layout : 'fit', corner: CORNERS.includes(corner) ? corner : 'top-right', size, seek, duration }), { cwd: work, timeoutMs: 5 * 60_000, signal });
      return { file: out, raw, captions: cues.length > 0, duration };
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  return { makeClip, tools: found };
}
