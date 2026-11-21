// The editing step of a plan: turns the moments your agents found into finished clips.
//
// 1. Reads the run folder's moments and clip notes (moments.md, clips.md).
// 2. Asks the model for an exact cut list: source link, start, end, hook, title, caption, layout.
// 3. Asks you once: "cut 10 clips into drafts/.../clips?"
// 4. For each clip, Agentdex itself downloads only those seconds and renders two files:
//    NN-name-raw.mp4 (the moment, for CapCut) and NN-name-ready.mp4 (9:16, hook and captions).
// 5. Writes posts.md with each clip's title and caption, ready to paste.
import { mkdir, writeFile } from 'node:fs/promises';
import { LAYOUTS, CORNERS, parseTime, checkSource, VideoError } from './video.js';

export const EDIT_SYSTEM = `You turn a list of stream moments into an exact cut list for an automatic video editor.
Use only moments that have a link to a YouTube, Twitch or Kick video or clip (or a file path in the workspace) and clear times. Never invent links or times.
For each clip: the source link exactly as written, start and end as h:mm:ss or seconds (20 to 60 seconds long, starting right at the peak), a hook of at most 7 words shown in the first seconds, a title under 60 characters, and a caption with the campaign's required hashtags or tags.
Layout: "split" when the streamer has a facecam (say which corner it is in, if the notes say), otherwise "fit". Follow any layout the instructions ask for.
Order clips from most to least likely to go viral. At most 12.`;

export const CUTLIST_SCHEMA = {
  type: 'object',
  properties: {
    clips: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' },
          hook: { type: 'string' }, title: { type: 'string' }, caption: { type: 'string' },
          layout: { type: 'string', enum: LAYOUTS }, corner: { type: 'string', enum: CORNERS },
        },
        required: ['source', 'start', 'end', 'hook', 'title', 'caption', 'layout', 'corner'],
        additionalProperties: false,
      },
    },
  },
  required: ['clips'],
  additionalProperties: false,
};

const slug = (s) => String(s || 'clip').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'clip';

// What to paste into the Claude desktop app (with Computer use on) to polish the raw clips in CapCut.
// The folder is this computer's real path, because Claude desktop works on the same computer.
export function capcutPrompt(dir, made) {
  const list = made.map((m) => `- ${m.name}-raw.mp4: hook "${m.hook}"${m.srt ? `, captions ${m.name}.srt` : ''}`).join('\n');
  return `# Polish these clips in CapCut with Claude

Open the Claude desktop app, make sure Computer use is on, and paste everything below the line.
Claude asks you to allow CapCut first. Stay nearby: it works one clip at a time and shows you each result.

---

Use computer use to edit these clips in CapCut. The folder is:
${dir}

${list}

For each clip, one at a time:
1. In CapCut, start a new project and import the -raw.mp4 file.
2. Set the canvas to 9:16. Use Auto reframe, or place the streamer's facecam on top and the gameplay below.
3. Captions: import the .srt file if there is one (Captions, Import); otherwise use Auto captions. Make them big, bold and centred.
4. Add the hook text in big letters for the first 2 seconds.
5. Cut any silent or boring gaps.
6. Export at 1080p, 30 fps, into the same folder, named like the clip but ending in -capcut.mp4.

Do the first clip, then stop and show me before doing the rest.
Do not post anything, open links, or log in to any account.
`;
}

// video: createVideo(); workspace: createWorkspace(); ask/waitForApproval as in the runtime.
export function createEditor({ video, workspace, ask, waitForApproval, dex, log = console.log }) {
  async function readIf(rel) {
    try { return (await workspace.tools.read_file({ path: rel })).slice(0, 40_000); } catch { return ''; }
  }

  // Returns { summary, files, failed?, declined? }.
  async function run(agent, task, signal) {
    const folder = String(task.edit?.folder || '').replace(/\/+$/, '');
    if (!folder) return { failed: true, summary: 'This editing step has no run folder. Run it from a plan.', files: [] };
    const tools = video.tools();
    if (!tools.ffmpeg) return { failed: true, summary: 'Cutting clips needs ffmpeg on this computer. Open SETUP, Video tools, install it, then run the plan again.', files: [] };

    const notes = [['moments.md', await readIf(`${folder}/moments.md`)], ['clips.md', await readIf(`${folder}/clips.md`)]].filter(([, t]) => t);
    if (!notes.length) return { failed: true, summary: `Nothing to cut yet: ${folder} has no moments.md or clips.md. The research steps write those first.`, files: [] };

    const out = await ask({
      system: EDIT_SYSTEM, schema: CUTLIST_SCHEMA, agentId: agent.id, signal, effort: 'medium',
      prompt: `Instructions for this step:\n${task.details || task.title}\n\n${notes.map(([n, t]) => `--- ${n} ---\n${t}`).join('\n\n')}`,
    });
    if (!out) return { failed: true, summary: 'Claude could not make a cut list. Check SETUP, then run the plan again.', files: [] };

    // Keep only clips that can really be cut.
    const skipped = [];
    const clips = (out.clips || []).slice(0, 12).filter((c, i) => {
      try {
        const a = parseTime(c.start); const z = parseTime(c.end);
        if (!(z - a >= 3 && z - a <= 180)) throw new VideoError('must be 3 seconds to 3 minutes');
        checkSource(c.source, workspace.root);
        return true;
      } catch (err) { skipped.push(`#${i + 1} ${c.title || ''}: ${err.message}`); return false; }
    });
    if (!clips.length) return { failed: true, summary: `No moment had a usable link and times, so nothing was cut.${skipped.length ? ` ${skipped.slice(0, 3).join('; ')}` : ''}`, files: [] };
    const needsDownload = clips.some((c) => /^https?:/i.test(c.source));
    if (needsDownload && !tools.ytdlp) return { failed: true, summary: 'These clips come from links, which needs yt-dlp on this computer. Open SETUP, Video tools, install it, then run the plan again.', files: [] };

    const hosts = [...new Set(clips.filter((c) => /^https?:/i.test(c.source)).map((c) => new URL(c.source).hostname.replace(/^www\./, '')))];
    const decision = await waitForApproval(agent.id, { tool: 'CUT', target: `${clips.length} clip${clips.length === 1 ? '' : 's'} into ${folder}/clips${hosts.length ? ` (downloads from ${hosts.join(', ')})` : ''}` }, signal);
    if (decision !== 'yes') return { declined: true, summary: 'You said no, so nothing was cut.', files: [] };

    const dirRel = `${folder}/clips`;
    const dir = (await workspace.resolve(dirRel)).abs;
    await mkdir(dir, { recursive: true });
    const files = [];
    const posts = [];
    const failed = [];
    const made = [];
    for (let i = 0; i < clips.length; i++) {
      if (signal?.aborted) break;
      const c = clips[i];
      const name = `${String(i + 1).padStart(2, '0')}-${slug(c.title)}`;
      try {
        const r = await video.makeClip({ source: c.source, start: c.start, end: c.end, hook: c.hook, layout: c.layout, corner: c.corner, dir, name, signal });
        files.push(`${dirRel}/${name}-ready.mp4`, `${dirRel}/${name}-raw.mp4`, ...(r.srt ? [`${dirRel}/${name}.srt`] : []));
        posts.push(`## ${i + 1}. ${c.title}\nFiles: ${name}-ready.mp4 (post as is) and ${name}-raw.mp4 (edit in CapCut)${r.srt ? `, captions in ${name}.srt (CapCut: Captions, Import)` : ''}\nSource: ${c.source} from ${c.start} to ${c.end}${r.captions ? '' : '\nNo captions came with this video: turn on Auto captions in CapCut.'}\n\nHook: ${c.hook}\nTitle: ${c.title}\n\nCaption:\n${c.caption}\n`);
        made.push({ name, hook: c.hook, srt: Boolean(r.srt) });
        await dex.emit('task.progress', agent.id, { tokens: 0.5, tool: 'EDIT' }).catch(() => {});
      } catch (err) {
        if (signal?.aborted) break;
        failed.push(`${name}: ${err.message}`);
        log(`[${agent.nick}] clip ${name} failed: ${err.message}`);
      }
    }
    if (posts.length) {
      await writeFile((await workspace.resolve(`${dirRel}/posts.md`)).abs, `# Clips ready to post\n\nEach clip has a -ready file (9:16, hook and captions) and a -raw file for CapCut.\n\n${posts.join('\n')}`, 'utf8');
      files.push(`${dirRel}/posts.md`);
      await writeFile((await workspace.resolve(`${dirRel}/capcut-prompt.md`)).abs, capcutPrompt(dir, made), 'utf8');
      files.push(`${dirRel}/capcut-prompt.md`);
    }
    const problems = [...failed, ...skipped];
    return {
      failed: made.length === 0,
      files,
      summary: made.length
        ? `Made ${made.length} of ${clips.length + skipped.length} clips in ${dirRel}: each has a -ready file to post and a -raw file for CapCut, and posts.md has the titles and captions.${problems.length ? ` Skipped ${problems.length}: ${problems.slice(0, 3).join('; ')}.` : ''}`
        : `No clip could be made. ${problems.slice(0, 3).join('; ')}`,
    };
  }

  return { run };
}
