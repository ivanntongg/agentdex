# Agentdex

[![Tests](https://github.com/ivanntongg/agentdex/actions/workflows/test.yml/badge.svg)](https://github.com/ivanntongg/agentdex/actions/workflows/test.yml)
![Node 20+](https://img.shields.io/badge/node-20%2B-3c873a)
![Version 0.5.2](https://img.shields.io/badge/version-0.5.2-5462a6)
![Powered by Claude](https://img.shields.io/badge/agents-Claude-d97757)

**A pixel town where your AI agents live, work, and ask before they do anything that matters.**

![The Agentdex town: agents walking between buildings, a party list with HP bars, and an agent asking "ROLLO wants to use DEPLOY on api-prod!" with YES / NO](docs/town.png)

- Your AI agents are creatures in a handheld-style town. When one **walks to a building**, it really started or handed over work.
- Before anything risky, an agent stops and asks you in a **YES / NO dialog box**. A second agent can review the work first.
- You walk around as the Professor: give agents jobs, pet them, poke them, and watch everything in the field log.
- Optional: **control it from WhatsApp** while your computer runs at home.

Real agents are powered by [Claude](https://www.anthropic.com/claude) and work only inside one folder on your computer. A free practice mode with pretend agents needs no account.

---

## Install

You need about 15 minutes. You will type a few commands into a **terminal**: on a Mac open the **Terminal** app, on Windows open **PowerShell** from the Start menu. Paste each command, press Enter, and wait for it to finish before the next one.

### 1. Install the two free tools

| Tool | Get it | Check it worked |
|---|---|---|
| **Node.js** (version 20 or newer) | Download the **LTS** version from [nodejs.org](https://nodejs.org) and run the installer | `node -v` shows `v20` or higher |
| **Git** | **Mac:** run `git --version` and click Install if asked. **Windows:** install from [git-scm.com](https://git-scm.com/download/win) with the default options | `git --version` shows a version |

Close and reopen the terminal after installing, so it finds them.

### 2. Download Agentdex

```bash
git clone https://github.com/ivanntongg/agentdex.git
```

```bash
cd agentdex
```

```bash
npm ci
```

### 3. Start it

```bash
npm run real
```

Open **http://localhost:8787** in your browser. Keep the terminal open while you use it; press **Ctrl + C** in the terminal to stop.

### 4. Connect Claude (first time only)

The **SETUP** screen opens by itself. Pick how your agents connect:

**Option A: API key** (pay as you go, works for everyone)

1. Sign in to the [Claude Console](https://platform.claude.com), add some credit, open **API keys** and create a key (it starts with `sk-ant-`).
2. In SETUP choose **API key**, paste it, choose how hard the agents should think (Medium is a good start) and press **SAVE & TEST**.

Your key is saved only on your computer, in `agentdex.config.json`. Treat it like a password: never share it or commit it.

**Option B: your Claude plan** (Pro or Max, through Claude Code)

1. [Install Claude Code](https://code.claude.com/docs/en/setup) on the same computer (on Windows, use the native installer).
2. Open a terminal, run `claude` and sign in with your Claude account. Close it afterwards.
3. In SETUP choose **My Claude plan** and press **SAVE & TEST**.

Agentdex starts the official Claude Code app for each task; it never sees or stores your login. Tasks count toward your plan's usage limits, which are meant for ordinary personal use, so use an API key for heavy or shared use.

When SETUP says **CONNECTED**, close it. Four agents are waiting at the CENTER.

**Just want to look around first?** Run `npm start` instead of `npm run real`. It starts practice mode with pretend agents: free, and no key needed.

### Update later

Stop Agentdex first (close its window), then in the agentdex folder:

```bash
git pull
```

```bash
npm ci
```

If `git pull` says your local changes to `package-lock.json` would be overwritten, run `git restore package-lock.json` and pull again. That file only lists package versions.

### Desktop shortcut

Agentdex comes with a launcher that starts everything and opens your browser. It finds the agentdex folder by itself, installs on first run, and if Agentdex is already running it just opens the town.

- **Windows:** open the `agentdex\launchers` folder, right-click **Agentdex.bat**, choose **Send to**, then **Desktop (create shortcut)**. Double-click the new shortcut on your Desktop. If Windows says it "protected your PC", choose **More info**, then **Run anyway**.
- **Mac:** open the `agentdex/launchers` folder in Finder and double-click **Agentdex.command**. To keep it handy, drag it to your Dock while holding **Cmd + Option**.

Close the window it opens to stop Agentdex. Because the shortcut points into the agentdex folder, it keeps working after updates.

---

## Your first task

1. In **PARTY** on the right, click **SCOUT**.
2. In **GIVE TASK**, type something small and specific, for example *Compare 3 free note-taking apps for a student and save a one-page summary to notes/apps.md*. Leave **Ask a reviewer** ticked and press **SEND**.
3. SCOUT walks to the LAB and starts working. Its **HP** drops as the job gets longer.
4. Saving outside the `drafts` folder needs your permission, so SCOUT asks: *"SCOUT wants to use WRITE on notes/apps.md!"* Press **YES** or **NO**.
5. SCOUT walks to the GYM, where **CHECKS** reviews the work. If CHECKS asks for changes, SCOUT gets one round to fix them.
6. The field log shows a one-line summary. The files are in the `workspace` folder inside `agentdex`.

| Agent | Good at |
|---|---|
| **PATCH** | Code and technical fixes |
| **SCOUT** | Research, with web search |
| **QUILL** | Writing and editing, with web search |
| **CHECKS** | Reviews other agents' work (tick "Ask a reviewer" instead of giving it tasks) |

Every real task uses a little API credit. For cheaper, quicker runs, open SETUP and choose **Low**, or pick the **Haiku** model.

## Playing

| Input | Action |
|---|---|
| Arrow keys / WASD, or tap the map | Walk |
| Z / Enter / Space next to an agent, or tap it | Open PET / POKE / CHECK |
| Z or Enter | YES in a dialog |
| X or Esc | NO / BACK |

| Badge | Means | What you do |
|---|---|---|
| **HP** | Memory left for the current job (thousands of tokens) | Nothing, unless it gets very low |
| **SLP** | Idle | Give it a task |
| **PAR** | Waiting for your permission | Answer YES or NO |
| **CNF** | Stuck repeating itself | Pet it |
| **PSN** | Spending much faster than usual | Poke it to cap its spending |
| **FNT** | The job failed; the field log says why | Open it and press RESET SESSION |

| Building | What happens there |
|---|---|
| **LAB** | Research and writing |
| **WORKSHOP** | Building: code, designs, operations |
| **GYM** | Reviews |
| **CENTER** | New agents arrive; tired agents get reset |
| **MART** | Skills |

The menu has **PARTY** (agents switched on, up to 6), **DEX** (the catalog of agent types: spawn new ones here) and **BOX** (switched-off agents that cost nothing).

<details>
<summary>How the game maps to agents</summary>

| Game | Agent meaning |
|---|---|
| Dex | Catalog of agent templates. Seen = available, owned = spawned |
| Types | Specialty: CODE, RESEARCH, DESIGN, OPS, QA, WRITE |
| Party (max 6) | Agents running at once. A hard cost cap |
| Box | Stored agents. Not running, cost nothing |
| HP | Context window left |
| PP | How many more times each tool can be used before a reset |
| Level / XP | Tasks completed and reviews passed |
| Evolution | Upgrade to a bigger model or more permissions. Needs your approval |
| Bond (hearts) | Raised by petting |

Design rule: every movement on the map is a real event (a task taken, a handoff, a review, a failure). Nothing animates for decoration.

</details>

## Control it from WhatsApp

Leave your computer running Agentdex at home and message your agents from your phone:

| You send | What happens |
|---|---|
| `scout compare 3 note apps` | SCOUT gets that task (start with any agent's name) |
| `status` | What everyone is doing, plus questions waiting for you |
| Tap **YES** / **NO** | Answers an agent's question (typing `yes` or `no` works too) |
| `reset scout` | Clears an agent that fainted or got stuck |
| `help` | The list of commands |

You also get a message when a job finishes or an agent faints.

It uses Meta's official WhatsApp Business API (its free test number allows up to 5 recipients) and the free [ngrok](https://ngrok.com) tunnel so WhatsApp can reach your computer. **Open SETUP, part 3**: it walks you through five steps with copy buttons and a test message. Plan for about 30 minutes the first time.

Your computer, the Agentdex window and the ngrok window must stay on. WhatsApp only lets the bot message you within 24 hours of your last message to it, so send `status` once a day if you want alerts.

## Safety

- **Agents only touch the workspace folder.** Paths that try to escape it, including through symlinks, are refused.
- **With your Claude plan, Claude Code runs in its restricted mode:** no shell or code-running tools, no MCP servers, your own Claude Code settings are not loaded, and an Agentdex hook asks you before every write outside drafts.
- **Nothing outside `workspace/drafts` is written without your YES.** If you say NO, the agent is told and works around it.
- **Your settings stay on your computer.** `agentdex.config.json` is readable only by your user account, is ignored by Git, and keys are never shown in full again.
- **The town is private.** It only listens on your own computer (`localhost`), and the SETUP screen only answers requests from that computer.
- **WhatsApp exposes only its own webhook**, on a separate port (8788). Every request must carry Meta's signature, and only the phone number you entered can give orders.

## Troubleshooting

| You see | Fix |
|---|---|
| `command not found: node` or `'node' is not recognized` | Install Node.js, then close and reopen the terminal |
| `Port 8787 is already in use` | Agentdex is already running in another window. Close it, or restart your computer |
| The top bar says **DEMO** | You opened the file directly. Start it from the terminal and open http://localhost:8787 |
| SETUP says the key was rejected | Copy the key again from the Claude Console and paste it, then SAVE & TEST |
| An agent "can't start yet" | Open SETUP and add your Claude key, or switch to **My Claude plan** |
| "Claude Code is not signed in" | Open a terminal, run `claude`, sign in, then press SAVE & TEST again |
| "Agentdex cannot find Claude Code" | Open a **new** terminal and run `claude --version`. If it fails, [install Claude Code](https://code.claude.com/docs/en/setup). If it works, close Agentdex and start it again from that new window |
| "Your Claude plan has hit its usage limit" | Wait for it to reset (claude.ai shows when), or switch to an API key in SETUP |
| An agent faints with "rate limiting" or a credit message | Wait a minute or add credit in the Claude Console, then RESET SESSION |
| The agent "works" but no files appear | You started with `npm start` (pretend agents). Use `npm run real` |

---

## For developers

<details>
<summary>Configuration, architecture, API and tests</summary>

### Commands

| Command | What it runs |
|---|---|
| `npm run real` | Town, real Claude agents, SETUP screen and (if configured) the WhatsApp bridge, in one process |
| `npm start` | Town with the built-in simulator (pretend agents) |
| `npm run agents` | Agents only, against a server started with `AGENTDEX_SIM=0 npm start` |
| `npm test` | All tests. Real agents are tested against a stand-in for the Claude API: no key, no cost |

Opening `index.html` straight from disk runs an offline demo in the browser.

### Configuration

Everything a user needs is on the SETUP screen. Environment variables also work; saved SETUP values win over them.

| Variable | Default | Purpose |
|---|---|---|
| `AGENTDEX_BRAIN` | `api` | `api` (API key) or `claude-code` (your Claude plan through Claude Code) |
| `AGENTDEX_CLAUDE_BIN` | `claude` | Path to the Claude Code command, if it is not on your PATH |
| `ANTHROPIC_API_KEY` | none | Claude API key |
| `AGENTDEX_MODEL` | `claude-opus-5-5` | Model for every agent (SETUP offers Opus, Sonnet and Haiku 5.5) |
| `AGENTDEX_EFFORT` | `medium` | Effort level (SETUP offers low, medium, high) |
| `AGENTDEX_WORKSPACE` | `./workspace` | The only folder agents can touch |
| `AGENTDEX_CONFIG` | `./agentdex.config.json` | Where SETUP saves settings |
| `PORT` | `8787` | Town port |
| `HOST` | `127.0.0.1` | Set `0.0.0.0` to reach the town from other devices on your network |
| `AGENTDEX_TOKEN` | none | If set, every POST needs `Authorization: Bearer <token>`. Set it whenever `HOST` is not localhost |
| `AGENTDEX_SIM` | on | `0` turns the simulator off for `npm start` |
| `AGENTDEX_URL` | `http://127.0.0.1:8787` | Server for `npm run agents` |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_ALLOWED` | none | WhatsApp settings (also on SETUP) |
| `WHATSAPP_PORT` | `8788` | WhatsApp webhook port |

### How it fits together

```
Town (index.html)  ◀── live event stream ──  Server (server/)  ◀── events ──  Agents (runtime/)
your actions       ── HTTP ──────────────▶   one source of truth  ── events ──▶  Claude tool-use loops
                                                    ▲
                                       WhatsApp bridge (bridges/)
```

Every change to an agent is an **event** (`task.started`, `task.progress`, `approval.requested`, ...). The server validates and applies it, logs it, and streams it to every open town and to the runtime. Real agents run a Claude tool-use loop with sandboxed file tools; risky writes wait for an `approval.resolved` event from you.

### Connect your own agent runtime

Any agent can live in the town: post events to `POST /api/ingest` and listen to `GET /api/events` for the player's answers. The full protocol, with a working curl example, is in [docs/EVENTS.md](docs/EVENTS.md). `runtime/runtime.js` is a complete example.

### Project layout

| Path | What it is |
|---|---|
| `index.html` | The town and the SETUP screen. Live when served, offline demo when opened as a file |
| `server/store.js` | World state. Validates and applies every event |
| `server/app.js` | HTTP API, live event stream, setup routes |
| `server/config.js` | Settings saved from SETUP |
| `server/simulator.js` | Pretend agents that use only the public event API |
| `runtime/runtime.js` | Real agents: Claude tool-use loop, approvals, review, HP reporting |
| `runtime/workspace.js` | Sandboxed file tools |
| `runtime/claude-code.js` | "My Claude plan" mode: runs tasks through the official Claude Code app |
| `runtime/cc-hook.js` | Claude Code hook that turns writes outside drafts into YES / NO requests |
| `runtime/index.js` | `npm run real`: wires the server, agents, SETUP and WhatsApp together |
| `bridges/whatsapp.js` | WhatsApp remote control (official Cloud API) |
| `*/test/` | Tests |

</details>

## Roadmap

Done: the town, server and event protocol · real Claude agents with approvals and review · the SETUP screen · WhatsApp remote control · run agents on your Claude plan through Claude Code.

Next:

1. Agents hand work to each other (SCOUT researches, QUILL writes it up).
2. A second step (PIN) before high-risk approvals from WhatsApp.
3. Creature art: 6 creatures at 32×32 with walk cycles.
4. Review "battle" view: the work faces the reviewer, issues land as hits.
5. Sound: short chimes for approvals and level-ups.

## Contributing

Bug reports, ideas and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Found a security problem? Please report it privately as described in [SECURITY.md](SECURITY.md). What changed in each version is in [CHANGELOG.md](CHANGELOG.md).

## Status

Early prototype, built in the open. All creatures, names and art are original.
