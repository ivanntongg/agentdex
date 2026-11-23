// The finding step of a plan: real moments from your streamers, with real links and times.
//
// Agentdex itself runs yt-dlp (read only, nothing is downloaded) for each streamer in the project:
//   Twitch and Kick  the top clips of the last day, ranked by views. Viewers already cut these
//                    around the peak, so the start and end are exact.
//   YouTube          the latest streams and videos: the "Most replayed" peaks (for videos up to
//                    about an hour) and the top comments that give a timestamp ("2:14:07 he lost it").
// It writes moments.md in the run folder. The editing step then picks the funniest and cuts them.
// Clips already cut on earlier days (used-clips.txt in the project folder) are skipped.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { parseStreamers, PLATFORM_NAMES } from '../server/streamers.js';

export class FindError extends Error {}

// yt-dlp arguments: read the list or the details only, never download.
const READ = ['-J', '--no-warnings', '--ignore-no-formats-error'];
export function listArgs(st, { perList = 12 } = {}) {
  if (st.platform === 'twitch') return [`https://www.twitch.tv/${st.id}/clips?filter=clips&range=24hr`, '--flat-playlist', ...READ, '--playlist-end', String(perList)];
  if (st.platform === 'kick') return [`https://kick.com/${st.id}/clips?sort=view&range=day`, '--flat-playlist', ...READ, '--playlist-end', String(perList)];
  throw new FindError(`No clip list for ${st.platform}.`);
}
export const channelArgs = (st, tab, n = 2) => [`${st.url}/${tab}`, '--flat-playlist', ...READ, '--playlist-end', String(n)];
export const videoArgs = (url) => [url, '--skip-download', '--no-playlist', ...READ, '--write-comments', '--extractor-args', 'youtube:comment_sort=top;max_comments=150,150,0,0'];

const round = (n) => Math.round(n * 10) / 10;

// YouTube's "Most replayed" graph -> up to `count` peaks as { start, end, score }.
// Long streams are skipped: each bar then covers minutes, too vague to cut from.
export function heatmapPeaks(heatmap, duration, { count = 3, minGap = 120, before = 20, after = 25, maxBar = 45 } = {}) {
  if (!Array.isArray(heatmap) || heatmap.length < 10 || !(duration > 60)) return [];
  if (duration / heatmap.length > maxBar) return [];
  const skip = Math.max(15, duration * 0.03); // people always replay the first seconds
  const bars = heatmap.map((h) => ({ t: (Number(h.start_time) + Number(h.end_time)) / 2, v: Number(h.value) || 0 }));
  const local = bars.filter((b, i) => b.t > skip && b.t < duration - 5 && b.v >= 0.3 && b.v >= (bars[i - 1]?.v ?? 0) && b.v >= (bars[i + 1]?.v ?? 0));
  const picked = [];
  for (const b of local.sort((x, y) => y.v - x.v)) {
    if (picked.length >= count) break;
    if (picked.some((p) => Math.abs(p.t - b.t) < minGap)) continue;
    picked.push(b);
  }
  return picked.map((b) => ({ start: round(Math.max(0, b.t - before)), end: round(Math.min(duration, b.t + after)), score: round(b.v) }));
}

// "12:34" or "1:02:03" in top comments -> up to `count` moments as { start, end, likes, text }.
export function commentMoments(comments, duration, { count = 3, minGap = 60, before = 4, after = 36 } = {}) {
  if (!Array.isArray(comments) || !(duration > 30)) return [];
  const found = [];
  for (const c of comments) {
    const text = String(c?.text || '').replace(/\s+/g, ' ').trim();
    const likes = Number(c?.like_count) || 0;
    for (const m of text.matchAll(/(?<![\d:])(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?![\d:])/g)) {
      const t = Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      if (Number(m[3]) > 59 || (m[1] && Number(m[2]) > 59) || t < 5 || t > duration - 5) continue;
      found.push({ t, likes, text: text.slice(0, 160) });
    }
  }
  const picked = [];
  for (const f of found.sort((x, y) => y.likes - x.likes)) {
    if (picked.length >= count) break;
    if (picked.some((p) => Math.abs(p.t - f.t) < minGap)) continue;
    picked.push(f);
  }
  return picked.map((f) => ({ start: Math.max(0, f.t - before), end: Math.min(duration, f.t + after), likes: f.likes, text: f.text }));
}

// used-clips.txt: one "link start" per line.
export function parseUsed(text) {
  return String(text || '').split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => /^https?:/.test(p[0] || '')).map(([url, start]) => ({ url, start: Number(start) || 0 }));
}
export const usedLine = (url, start) => `${url} ${Math.round(Number(start) || 0)}`;
const isUsed = (used, m) => used.some((u) => u.url === m.url && (m.kind === 'clip' || Math.abs(u.start - m.start) < 60));

const hms = (s) => { const t = Math.max(0, Math.round(s)); return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
const num = (n) => Number(n || 0).toLocaleString('en-US');
const oneLine = (s, n = 140) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// The moments as markdown the editing step reads.
export function momentsMarkdown(moments, { date, problems = [], hours = 24 }) {
  const body = moments.map((m, i) => {
    const why = m.kind === 'clip'
      ? `A top ${PLATFORM_NAMES[m.platform]} clip of the last ${hours} hours${m.views ? `, ${num(m.views)} views` : ''}. Use the whole clip.`
      : m.kind === 'peak'
        ? `The most replayed part of "${oneLine(m.video, 90)}" (replay score ${m.score}).`
        : `A top comment (${num(m.likes)} likes) on "${oneLine(m.video, 90)}" points here: "${oneLine(m.comment)}"`;
    return `## ${i + 1}. ${oneLine(m.title, 100) || 'Untitled'}\nStreamer: ${m.streamer} on ${PLATFORM_NAMES[m.platform]}\nLink: ${m.url}\nStart: ${hms(m.start)}\nEnd: ${hms(m.end)} (${Math.round(m.end - m.start)} seconds)\nWhy: ${why}\n`;
  }).join('\n');
  return `# Moments found ${date}\n\nAgentdex found these itself: every link and time below is real. Pick the funniest, most shocking or most wholesome.\n\n${body || 'No new moments today.\n'}${problems.length ? `\n## Could not check\n${problems.map((p) => `- ${p}`).join('\n')}\n` : ''}`;
}

// Runs a program and returns what it printed (yt-dlp -J prints one JSON document).
function capture(cmd, args, { timeoutMs = 120_000, signal, max = 40_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); } catch (err) { return reject(new FindError(err.message)); }
    const out = [];
    let size = 0;
    let err = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const stop = () => child.kill();
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (d) => { size += d.length; if (size <= max) out.push(d); });
    child.stderr.on('data', (d) => { err = (err + d).slice(-1200); });
    child.on('error', (e) => { clearTimeout(timer); reject(new FindError(e.code === 'ENOENT' ? `${path.basename(cmd)} is not installed.` : e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer); signal?.removeEventListener?.('abort', stop);
      if (code === 0) return resolve(Buffer.concat(out).toString('utf8'));
      const last = err.trim().split('\n').filter(Boolean).pop() || `exit ${code}`;
      reject(new FindError(last.replace(/^ERROR:\s*/, '').slice(0, 200)));
    });
  });
}

// video: createVideo() (for the yt-dlp path); runImpl(cmd, args, opts) -> stdout, replaceable in tests.
export function createFinder({ video, workspace, dex, runImpl = capture, now = () => new Date(), log = console.log }) {
  async function readIf(rel) {
    try { return await workspace.tools.read_file({ path: rel }); } catch { return ''; }
  }
  const json = async (ytdlp, args, signal) => {
    const text = await runImpl(ytdlp, args, { signal, timeoutMs: 3 * 60_000 });
    try { return JSON.parse(text); } catch { throw new FindError('yt-dlp gave an answer Agentdex could not read.'); }
  };

  async function clipsOf(ytdlp, st, signal) {
    const list = await json(ytdlp, listArgs(st), signal);
    return (list.entries || []).filter((e) => e && /^https?:/.test(e.url || '') && Number(e.duration) >= 5 && Number(e.duration) <= 90)
      .map((e) => ({ kind: 'clip', platform: st.platform, streamer: st.label, url: e.url, title: e.title, views: Number(e.view_count) || 0, start: 0, end: Math.round(Number(e.duration)), rank: Number(e.view_count) || 0 }));
  }

  async function youtubeOf(ytdlp, st, signal, maxAgeHours) {
    const ids = [];
    for (const tab of ['streams', 'videos']) {
      try {
        const list = await json(ytdlp, channelArgs(st, tab), signal);
        for (const e of list.entries || []) if (e?.id && !ids.includes(e.id) && e.live_status !== 'is_live' && e.live_status !== 'is_upcoming') ids.push(e.id);
      } catch (err) { if (tab === 'videos' && !ids.length) throw err; }
    }
    const out = [];
    for (const id of ids.slice(0, 3)) {
      if (signal?.aborted) break;
      const url = `https://www.youtube.com/watch?v=${id}`;
      const v = await json(ytdlp, videoArgs(url), signal).catch(() => null);
      if (!v || v.is_live || !(Number(v.duration) > 60)) continue;
      const ts = v.timestamp ? v.timestamp * 1000 : v.upload_date ? Date.parse(`${v.upload_date.slice(0, 4)}-${v.upload_date.slice(4, 6)}-${v.upload_date.slice(6, 8)}T12:00:00Z`) : null;
      if (ts && now() - ts > maxAgeHours * 3_600_000) continue;
      const views = Number(v.view_count) || 0;
      const base = { platform: 'youtube', streamer: st.label, url, video: v.title, views };
      for (const p of heatmapPeaks(v.heatmap, v.duration)) out.push({ ...base, kind: 'peak', title: `${v.title} (most replayed)`, start: p.start, end: p.end, score: p.score, rank: views * p.score * 0.002 });
      for (const c of commentMoments(v.comments, v.duration)) {
        if (out.some((o) => o.url === url && Math.abs(o.start - c.start) < 45)) continue;
        out.push({ ...base, kind: 'comment', title: v.title, start: c.start, end: c.end, likes: c.likes, comment: c.text, rank: c.likes * 20 });
      }
    }
    return out;
  }

  // task.find = { folder, streamers: [links] }. Returns { summary, files, failed? }.
  async function run(agent, task, signal, { hours = 24, total = 24 } = {}) {
    const folder = String(task.find?.folder || '').replace(/\/+$/, '');
    if (!folder) return { failed: true, summary: 'This finding step has no run folder. Run it from a plan.', files: [] };
    const { streamers } = parseStreamers(task.find?.streamers || []);
    if (!streamers.length) return { failed: true, summary: 'This project has no streamers yet. Open PLANS, edit the project, and paste their Twitch, Kick or YouTube links.', files: [] };
    const ytdlp = video.tools().ytdlp;
    if (!ytdlp) return { failed: true, summary: 'Finding clips needs yt-dlp on this computer. Open SETUP, Video tools, install it, then run the plan again.', files: [] };

    const projectFolder = folder.split('/').slice(0, -1).join('/') || folder;
    const used = parseUsed(await readIf(`${projectFolder}/used-clips.txt`));
    const per = [];
    const problems = [];
    for (const st of streamers) {
      if (signal?.aborted) break;
      try {
        const found = st.platform === 'youtube' ? await youtubeOf(ytdlp, st, signal, Math.max(hours, 72)) : await clipsOf(ytdlp, st, signal);
        const fresh = found.filter((m) => !isUsed(used, m)).sort((a, b) => b.rank - a.rank);
        per.push(fresh);
        log(`[${agent.nick}] ${st.label} (${PLATFORM_NAMES[st.platform]}): ${fresh.length} moment${fresh.length === 1 ? '' : 's'}`);
        await dex.emit('task.progress', agent.id, { tokens: 0.2, tool: 'FIND' }).catch(() => {});
      } catch (err) {
        if (signal?.aborted) break;
        problems.push(`${st.label} on ${PLATFORM_NAMES[st.platform]}: ${err.message}`);
      }
    }
    // Take turns between streamers so one big channel does not fill the list.
    const moments = [];
    for (let i = 0; moments.length < total && per.some((l) => l[i]); i++) for (const l of per) if (l[i] && moments.length < total) moments.push(l[i]);

    const date = now().toISOString().slice(0, 10);
    const rel = `${folder}/moments.md`;
    await workspace.tools.write_file({ path: rel, content: momentsMarkdown(moments, { date, problems, hours }) });
    if (!moments.length) {
      return {
        failed: true, files: [rel],
        summary: problems.length === streamers.length
          ? `Could not check any streamer: ${problems.slice(0, 2).join('; ')}`
          : `No new clips from your ${streamers.length} streamer${streamers.length === 1 ? '' : 's'} in the last ${hours} hours. Add more streamers to the project, or run it again later.`,
      };
    }
    const from = new Set(moments.map((m) => m.streamer)).size;
    return {
      files: [rel],
      summary: `Found ${moments.length} real moments from ${from} streamer${from === 1 ? '' : 's'} and saved them in ${rel}.${problems.length ? ` Could not check ${problems.length}: ${problems.slice(0, 2).join('; ')}.` : ''}`,
    };
  }

  return { run };
}
