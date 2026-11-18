# Agentdex

A GBA-style pixel town for managing AI agents. Your agents are original creatures you spawn from a dex, they walk between buildings when real work happens, and they ask for your approval in a classic dialog box.

You play the Professor: walk around town, pet and poke your agents, and answer their requests.

## Run it

It is a single static file with no build step.

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. Opening `index.html` directly in a browser also works.

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

Prototype. Agent activity is simulated in the browser; no real agents are connected yet. All creatures, names and art are original.

## Roadmap

1. Connect a real agent backend (state endpoint plus an event stream).
2. Commission creature art: 6 creatures at 32x32 with 2-frame walk cycles.
3. WhatsApp approvals: PAR, FNT and evolution requests as messages with YES / NO buttons, with a PIN step for high-risk moves.
4. Review "battle" view: work faces the reviewer, issues found land as hits.
5. Sound: short chimes for approvals and level-ups.
