# Agentdex

A GBA-style pixel town for managing AI agents. Your agents are original creatures you spawn from a dex, they walk between buildings when real work happens, and they ask for your approval in a classic dialog box.

You play the Professor: walk around town, pet and poke your agents, and answer their requests.

## Run it

Needs Node 20 or newer. No dependencies to install.

```bash
npm start
```

Open http://localhost:8787. The header shows **LIVE**: the server owns the agents and a built-in simulator drives them.

Opening `index.html` straight from disk still works. The header then shows **DEMO** and everything runs in the browser.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Port to listen on |
| `HOST` | `127.0.0.1` | Set `0.0.0.0` to reach it from your phone on the same network |
| `AGENTDEX_SIM` | on | `0` turns the simulator off so a real runtime can drive the town |
| `AGENTDEX_TOKEN` | none | If set, every POST needs `Authorization: Bearer <token>`. Set it whenever `HOST` is not localhost |

```bash
npm test
```

## Run real Claude agents

```bash
npm install
```

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

```bash
npm run real
```

Open http://localhost:8787. Four agents arrive at the CENTER: PATCH (code), SCOUT (research), QUILL (writing) and CHECKS (reviewer). Open one, type a job into **GIVE TASK** and press SEND.

What happens next is real:

- The agent walks to its building and runs a Claude tool-use loop (`claude-opus-5-5`, effort `medium`).
- It works in the `workspace/` folder. Files under `workspace/drafts/` are written freely; **any other write stops and asks you YES / NO in the dialog box**.
- HP is the agent's context: it drops as the conversation grows. At 0 the agent faints; RESET SESSION brings it back.
- With "Ask a reviewer" ticked, the agent walks to the GYM and CHECKS reviews the files it wrote. If CHECKS asks for changes, the agent gets one round to fix them.
- SCOUT and QUILL can search the web (up to 5 searches per request).
- Every request asks the API to retry on a fallback model if Claude declines it (`fallbacks: "default"`).

Each task costs real API tokens. Lower `AGENTDEX_EFFORT` to `low` for cheaper, quicker runs.

| Variable | Default | Purpose |
|---|---|---|
| `AGENTDEX_WORKSPACE` | `./workspace` | The only folder agents can touch. Paths that escape it, including through symlinks, are refused |
| `AGENTDEX_MODEL` | `claude-opus-5-5` | Model for every agent |
| `AGENTDEX_EFFORT` | `medium` | `low`, `medium`, `high`, `xhigh` or `max` |

To keep the server and the agents as two processes, start the server with `AGENTDEX_SIM=0 npm start`, then run `npm run agents` (set `AGENTDEX_URL` if the server is elsewhere).

## Connect your own agent runtime

Your runtime posts events (`task.started`, `task.progress`, `approval.requested`, ...) to `POST /api/ingest` and listens to `GET /api/events` for your answers. The full protocol, with a curl example, is in [docs/EVENTS.md](docs/EVENTS.md).

## Project layout

| Path | What it is |
|---|---|
| `index.html` | The town. Live mode when served by the server, demo mode otherwise |
| `server/store.js` | The world state. Every change is an event; this validates and applies it |
| `server/simulator.js` | Fake runtime that only speaks the public event API |
| `server/app.js` | HTTP API and the live event stream |
| `server/test/` | Store rules and HTTP tests |
| `runtime/runtime.js` | Real agents: the Claude tool-use loop, approvals, review, HP reporting |
| `runtime/workspace.js` | Sandboxed file tools |
| `runtime/test/` | End-to-end tests against a stand-in for the Claude API (no key, no cost) |

## Controls

| Input | Action |
|---|---|
| Arrow keys / WASD, or tap the map | Walk |
| Z / Enter / Space next to an agent, or tap it | Open PET / POKE / CHECK |
| Z or Enter | YES in a dialog |
| X or Esc | NO / BACK |

## How the game maps to agents

| Game | Agent meaning |
|---|---|
| Dex | Catalog of agent templates. Seen = available, owned = spawned |
| Types | Specialty: CODE, RESEARCH, DESIGN, OPS, QA, WRITE |
| Party (max 6) | Agents running at once. A hard cost cap |
| Box | Stored agents. Not running, cost nothing |
| HP | Context window left (k tokens) |
| PP | Rate limit left on each tool |
| Level / XP | Tasks completed and reviews passed |
| Evolution | Upgrade to a bigger model or more permissions. Needs your approval |
| Bond (hearts) | Raised by petting |

### Status conditions

| Status | Meaning | What fixes it |
|---|---|---|
| SLP | Idle | Poke it to start a task |
| PAR | Waiting for your approval | Answer YES or NO |
| CNF | Looping on one step | Pet it, or wait |
| PSN | Spending tokens fast | Poke it to cap its budget |
| FNT | Ran out of context | Reset at the CENTER |

### Town

| Building | Workflow stage |
|---|---|
| LAB | Research |
| WORKSHOP | Build |
| GYM | Review |
| CENTER | Session reset |
| MART | Skills |

Design rule: every movement on the map is a real event (a task taken, a handoff, a review, a failure). Nothing animates for decoration.

## Status

Prototype. `npm start` runs the town with simulated agents; `npm run real` runs it with real Claude agents working in a local folder. All creatures, names and art are original.

## Roadmap

1. ~~Backend skeleton: state endpoint, event stream, ingest API.~~ Done.
1. ~~First real runtime: Claude agents with approvals and review.~~ Done. Next: let agents hand work to each other.
2. Commission creature art: 6 creatures at 32x32 with 2-frame walk cycles.
3. WhatsApp approvals: PAR, FNT and evolution requests as messages with YES / NO buttons, with a PIN step for high-risk moves.
4. Review "battle" view: work faces the reviewer, issues found land as hits.
5. Sound: short chimes for approvals and level-ups.
