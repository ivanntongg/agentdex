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

## Connect a real agent runtime

Your runtime posts events (`task.started`, `task.progress`, `approval.requested`, ...) to `POST /api/ingest` and listens to `GET /api/events` for your answers. The full protocol, with a curl example, is in [docs/EVENTS.md](docs/EVENTS.md).

## Project layout

| Path | What it is |
|---|---|
| `index.html` | The town. Live mode when served by the server, demo mode otherwise |
| `server/store.js` | The world state. Every change is an event; this validates and applies it |
| `server/simulator.js` | Fake runtime that only speaks the public event API |
| `server/app.js` | HTTP API and the live event stream |
| `server/test/` | Store rules and HTTP tests |

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

Prototype. The server, event protocol and live town work end to end; agent activity comes from the built-in simulator until a real runtime posts events. All creatures, names and art are original.

## Roadmap

1. ~~Backend skeleton: state endpoint, event stream, ingest API.~~ Done. Next: a first real runtime adapter.
2. Commission creature art: 6 creatures at 32x32 with 2-frame walk cycles.
3. WhatsApp approvals: PAR, FNT and evolution requests as messages with YES / NO buttons, with a PIN step for high-risk moves.
4. Review "battle" view: work faces the reviewer, issues found land as hits.
5. Sound: short chimes for approvals and level-ups.
