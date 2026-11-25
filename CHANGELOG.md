# Changelog

All notable changes to Agentdex. Newest first.

## 0.18.0 · The channel frame

- **New default layout, headline:** a big headline on top for the whole clip, its key word in yellow, the streamer's credit above it (`@KAICENAT ON TWITCH`), the whole moment in the middle with the facecam, and captions on clean space below. Everything sits clear of the buttons and titles Shorts and TikTok draw on top.
- **One font everywhere:** Anton (SIL Open Font License) ships with Agentdex, so clips look the same on every computer.
- The editor writes a credit for every clip and marks the hook's key word.

## 0.17.0 · Daily streamer clips

- **Streamers in a project:** paste Twitch, Kick or YouTube channel links into a project (PLANS, edit project).
- **Finding steps in plans:** Agentdex itself checks every streamer each day: the top Twitch and Kick clips of the last 24 hours (ranked by views), and the most replayed moments and timestamped top comments of their latest YouTube streams. Every link and time in `moments.md` is real, not guessed. Moments already cut on earlier days are skipped (`used-clips.txt`).
- **New ready-made plan, Daily streamer clips:** find the top moments, then cut the 10 funniest. Starts with IShowSpeed, Kai Cenat, xQc, Adin Ross and Jynxzi; edit the list to taste.
- **Whisper captions:** with the full ffmpeg build (version 8 or newer) and a one-time 488 MB model download from SETUP, every clip gets captions, including Twitch and Kick clips that have none. Runs on your computer, free. The model is checked against its published SHA-256 before use.
- Captions now show 3 words at a time, and short Twitch and Kick clips download whole for better quality.
- A plan step is now one of three kinds: the agent does the job, Agentdex finds clips, or Agentdex cuts clips.

## 0.16.1 · CapCut-ready clips

- Each clip also gets an `.srt` captions file that CapCut can import.
- Each batch gets `capcut-prompt.md`: paste it into the Claude desktop app with Computer use on, and Claude polishes the raw clips in CapCut one at a time while you watch, without posting or logging in anywhere.

## 0.16.0 · Agents cut and edit your clips

- **Editing steps in plans:** after one YES, Agentdex downloads only the moments your agents found and makes each clip twice: a ready 9:16 version with the hook and captions, and the raw moment for CapCut, plus posts.md with titles and captions.
- **Layouts:** facecam on top with gameplay below, the whole frame over a blurred background, or a centre crop.
- **Daily GTA 6 clipping** now ends with a cut-and-edit step.
- **SETUP, Video tools:** shows whether ffmpeg and yt-dlp are installed, with one-line installs for Windows and Mac.
- Safe by design: Agentdex runs the two tools with fixed settings, downloads only from YouTube, Twitch and Kick or the workspace, asks once per batch, and never posts for you. A failed editing step stops the plan with the reason.

## 0.15.1 · Daily GTA 6 clipping plan

- New ready-made plan and project: **Daily GTA 6 clipping**. Every morning SCOUT lists open clipping campaigns (pay per 1,000 views, budget left, rules), finds yesterday's best GTA 6 moments from streamers who allow clipping, and QUILL writes each clip's hook, title and caption as a checklist for CapCut.

## 0.15.0 · Projects and weekly plans

- **Projects:** a brief and a folder per channel or goal. Pick one above the team chat and every job gets the brief and saves into its folder.
- **Weekly plans** in the new PLANS tab: a schedule and a chain of steps, each handing its work to the next, with a dated folder per run. Ready-made plans for weekly streamer highlights and a weekly GTA 6 video. RUN NOW, STOP, PAUSE, and `run <plan>` from the command box or WhatsApp.
- Plans catch up once if the computer was off, retry a step once after a faint or reset, and announce the finished pack with a chime and on WhatsApp.
- The Guide knows your projects and plans.
- Fixed: in practice mode, a job given to a busy agent was dropped; it now waits its turn.

## 0.14.0 · The Guide, and a friendlier first screen

- **Ask the Guide:** start a message with ? (or press the Guide button) to ask what your team could do. It reads your town and answers in plain words with up to three ready-made jobs, each with a GIVE TO button, and suggests a new role when nobody fits. Works in practice mode, the demo and on WhatsApp.
- **New here? Try one:** the empty team chat shows three examples to tap.
- Clearer hint in the message box.

## 0.13.0 · Your own roles

- **NEW ROLE in the Dex:** describe a new kind of agent in your own words, pick a creature and colour, a home and web access, or start from Video editor, Social media, Tutor or Bookkeeper. Spawn it like any other agent.
- **Jobs find it:** custom-role agents are named after the role (VIDEO, VIDEO-2), and a job that mentions the role goes to them.
- **EDIT ROLE on every creature:** rewrite a built-in role's job, switch its web search, or reset it. The reviewer's text is added as your own review rules.
- Roles are saved with the town and work in both connection modes and in the demo.

## 0.12.0 · Alerts, and an easier WhatsApp setup

- **Bell in the top bar:** a chiptune chime when an agent needs you, finishes or faints, pop-ups when the Agentdex tab is hidden, and a count in the tab title like "(1) Agentdex". TRY IT plays one.
- **WhatsApp without a second window:** paste your ngrok authtoken and free static domain in SETUP and Agentdex runs the tunnel itself, starting and stopping with Agentdex. The address stays the same, so Meta needs it only once.
- **Your codes are checked when you save:** SETUP shows your WhatsApp number when the token and phone number ID work, and says in plain words when a token expired or an ID is wrong.
- **Permanent token guide** in SETUP, step 2.
- **Live checklist** at the top of the WhatsApp section: codes, tunnel, Meta link, your first message.
- **Alerts keep coming:** about an hour before WhatsApp's 24-hour window closes, the bot asks you to reply with anything.
- Only messages from your own number count toward that window.

## 0.11.0 · Agents learn community skills

- **Skills in the MART:** agents can use shared instruction packs (`SKILL.md`) from the community, found through [skills.sh](https://skills.sh).
- **Agents shop for themselves:** before a task, an agent decides whether a skill would clearly help. If so it walks to the MART, searches, reads the best few and picks one.
- **Safe by design:** quick checks drop skills that try to override rules, hide text or send secrets anywhere; CHECKS reads the chosen skill; nothing installs without your YES (in the town, the team chat with a VIEW SKILL link, or WhatsApp). Only the text is used, never scripts. Installed skills are frozen and agents can read but not edit them.
- **MART tab:** see installed skills, search and GET one yourself, remove skills, and switch off "Agents may look for skills on their own".
- Agents mention installed skills when you chat with them.
- New test that the page's script compiles, so a typo can't ship.

## 0.10.0 · One-command install, MIT license and a browser demo

- **Run it with one command:** `npx agentdex-town`. Only Node.js is needed: no Git, no download folder. Your town, settings and workspace live in an `Agentdex` folder in your home folder, so updates never touch them. `--practice` starts pretend agents, `--help` lists the options. If Agentdex is already running, the command just opens the town.
- **Open source under the MIT license.**
- **Try it in the browser:** the town in demo mode is published to GitHub Pages on every change.
- The README opens with a short animation of the town.
- Releases on GitHub publish the npm package automatically.

## 0.9.1 · Favicon

- The browser tab now shows a pixel BYTLE on a yellow tile, so Agentdex is easy to find among your tabs. Built into the page, so it also works offline. The source is `docs/icon.svg`.

## 0.9.0 · Light mode and a rounder town

- **Light mode**, now the default. Dark mode follows your system setting, and the sun / moon button in the top bar switches between them. Your choice is remembered.
- **Rounder, softer look** that still feels like a handheld: panels with rounded borders and solid shadows, buttons that press down when clicked, pill-shaped tabs and chips, and a rounded screen bezel. The pixel town, sprites and pixel signs are unchanged.
- **Calmer colors:** every color is defined once, yellow is used only for things you can press, and headings are plain text instead of yellow.
- The paperclip and the theme button are small pixel icons, so they look the same on Windows, Mac and phones.
- The working and idle counts share one chip in the top bar.

## 0.8.0 · Team chat, files and memory

- **Team chat** under the map: your jobs, agents' answers, results and YES / NO questions (with buttons) in one conversation, saved with the town. The **field log** moved to the right, under the menu.
- **Pick agents instead of typing:** type @ for a list with each agent's job and status, or click an agent button above the box.
- **Give agents files:** drag them onto the town or use the paperclip. They go into `workspace/inbox` and are named in your next message or task.
- **Agents remember:** each keeps its last 20 finished tasks (summary and files) and uses them in later tasks and chats. Shown under Remembers on its summary.
- After a restart, the log says when an agent was answering you as Agentdex closed.
- Fixed: after a restart the field log showed oldest lines first.

## 0.7.1 · Your town is saved

- Closing Agentdex no longer resets the town. Names, levels, XP, bond, HP, party and box, chat threads and the field log are saved to `agentdex.state.json` shortly after every change, and again on Ctrl+C or when the window closes.
- On restart a "Welcome back" line confirms the restore. Tasks that were running when Agentdex closed are listed so you can give them again.
- A save file that cannot be read is kept aside, and the town starts fresh instead of failing.

## 0.7.0 · Talk to your agents

- **Talk, don't task:** each agent's summary has a chat thread, and `@scout ...` works in the command bar and on WhatsApp. Agents answer in their own voice, know their current and recent work, and can read workspace files, but cannot change anything in a chat.
- **DO IT AS A TASK:** when you ask for work in a chat, the agent suggests a task; nothing starts until you press the button.
- A speech bubble shows on the map while an agent is answering. Practice and demo agents reply too, with canned answers.

## 0.6.0 · Command bar, renaming and plan usage

- **Tell your team:** one box under the map. Type a job and the best-suited free agent takes it, or start with a name to choose. Also `status`, `yes`, `no`, `reset`, `rename`. Press **/** to jump to it. WhatsApp uses the same commands, so jobs without a name work from your phone too.
- **Rename agents** with RENAME on their summary or `rename scout to max`.
- **Plan usage meter:** with My Claude plan, the top bar shows how much of your 5-hour and weekly limits are used, with reset times in SETUP, straight from Claude Code.

## 0.5.2 · Claude Code installed with npm on Windows

- Finds Claude Code 2.1 and later installed with `npm install -g`: the real program now lives at `node_modules\@anthropic-ai\claude-code\bin\claude.exe` inside npm's folder. Falls back to the package's `cli-wrapper.cjs` (or `cli.js` on older versions) when needed.

## 0.5.1 · Windows fixes

- Agentdex now finds Claude Code on Windows even when it was installed after Agentdex started (native installer folder), or installed through npm.
- Clearer message when Claude Code cannot be found, with the exact check to run.
- Installs and updates use `npm ci`, so `git pull` no longer stops on a changed `package-lock.json`.

## 0.5.0 · Use your Claude plan

- **My Claude plan** option in SETUP: agents run through the official Claude Code app on your computer, signed in with your own Pro or Max plan. No API key needed. Agentdex never sees or stores your login.
- Claude Code runs in restricted mode (no shell or code-running tools, files only inside the workspace, no MCP servers, your own settings not loaded).
- An Agentdex hook asks you YES / NO before every write outside `drafts/`, exactly like API-key mode. Writes outside the workspace are refused.
- HP follows Claude Code's real token counts; reviews use Claude Code too.
- Clear messages when Claude Code is missing, not signed in, or at its usage limit.
- Desktop launchers in `launchers/` for Windows (`Agentdex.bat`) and Mac (`Agentdex.command`): find the folder, install on first run, open the browser, and reuse a running Agentdex.
- Easier to read: the town uses Atkinson Hyperlegible Next for all text, keeping the pixel font only for the logo, map signs, creature names and status codes. Labels are in sentence case and filler lines are gone.

## 0.4.0 · SETUP screen and WhatsApp

- **SETUP screen** in the town: paste your Claude key, pick a model and how hard agents think, test the connection, and connect WhatsApp in five guided steps. Opens by itself on first run.
- **WhatsApp remote control** through Meta's official API: give tasks by agent name, ask for `status`, answer approvals with YES / NO buttons, and get told when work finishes or an agent faints.
- Settings are saved locally in `agentdex.config.json`, readable only by your user and ignored by Git. Keys are only ever shown masked.
- Without a key, agents tell you to open SETUP instead of failing.
- README rewritten for first-time visitors, with install steps for Mac and Windows.

## 0.3.0 · Real Claude agents

- `npm run real` starts four real agents: PATCH (code), SCOUT (research), QUILL (writing) and CHECKS (reviewer).
- **GIVE TASK** on an agent's summary. Each task runs a Claude tool-use loop in a sandboxed `workspace` folder.
- Writes outside `workspace/drafts` stop for your YES / NO in the dialog box.
- HP shows the agent's real context use; it faints when it runs out.
- Optional review: CHECKS returns a structured verdict, with one round of fixes.
- Research and writing agents can search the web.

## 0.2.0 · Server and event protocol

- The server becomes the single source of truth. Every change is an event, streamed live to the town.
- `POST /api/ingest` lets any agent runtime live in the town. Protocol in [docs/EVENTS.md](docs/EVENTS.md).
- The built-in simulator moves to the server and uses only the public event API.

## 0.1.0 · Prototype

- The pixel town, dex, party and box, with simulated agents.
- Status conditions, approvals in a dialog box, evolution.
- The Professor: walk around, pet and poke agents.
