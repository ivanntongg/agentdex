# Changelog

All notable changes to Agentdex. Newest first.

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
