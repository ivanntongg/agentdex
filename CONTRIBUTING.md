# Contributing to Agentdex

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting

- **Bugs and ideas:** open an [issue](https://github.com/ivanntongg/agentdex/issues/new/choose). The forms ask for what is needed.
- **Security problems** (a way around approvals, out of the workspace, or at someone's keys): follow [SECURITY.md](SECURITY.md) and report privately. Please do not open a public issue.

Never paste API keys, WhatsApp tokens or app secrets into an issue, a pull request or a screenshot.

## Getting set up

You need Node.js 20 or newer and Git.

```bash
git clone https://github.com/ivanntongg/agentdex.git
```

```bash
cd agentdex && npm install
```

```bash
npm test
```

Then run the town:

| Command | What it runs |
|---|---|
| `npm start` | Pretend agents. Free, no key. Best for working on the town and UI |
| `npm run real` | Real Claude agents, SETUP screen and WhatsApp bridge. Needs a Claude API key and costs a little per task |
| `npm run dev` | `npm start` that restarts when server files change |

Open http://localhost:8787. `index.html` has no build step: edit it and reload.

## Making a change

1. Branch from `main`.
2. Keep each pull request to one topic. Large or architectural changes: open an issue first so we can agree on the approach.
3. Add or update tests. Real-agent tests run against a stand-in for the Claude API in `runtime/test/`, so they need no key and cost nothing. Please keep it that way.
4. Run `npm test`. GitHub runs it again on Node 20 and 22 for every pull request.
5. Update the README or [docs/EVENTS.md](docs/EVENTS.md) if behaviour or the event API changed.

## The rules of the town

These keep Agentdex trustworthy. Pull requests that break them will be asked to change.

1. **Every movement on the map is a real event.** Agents walk, show a bubble or change status only because the server applied an event. No decorative animation that looks like work.
2. **The player approves anything that matters.** Writing outside `workspace/drafts`, spending money or reaching the outside world must stop at a YES / NO request. Never add a way around it.
3. **The server is the single source of truth.** The town and the runtime only send events and follow the stream. Rules about agents live in `server/store.js`.
4. **Secrets stay local.** Keys are read from the SETUP settings file or environment variables, are only ever shown masked, and never appear in logs, events or tests.
5. **Everything is original.** Creatures, names, sprites, maps and music must be your own work. No characters or assets from existing games.

## Code style

- Plain modern JavaScript (ES modules), Node 20+, no build step, no dependencies beyond the Anthropic SDK unless there is a strong reason.
- Messages the player reads (field log, SETUP, WhatsApp) are short, plain sentences that say what happened and what to do.
- Model-supplied paths and inputs are untrusted: resolve and check them before use (see `runtime/workspace.js`).

## Where things live

| Path | What it is |
|---|---|
| `index.html` | The town and the SETUP screen |
| `server/` | Event store, HTTP API, settings, simulator |
| `runtime/` | Real Claude agents and sandboxed file tools |
| `bridges/` | WhatsApp remote control |
| `docs/` | Event protocol and images |
| `bin/` | The `npx agentdex-town` command |

By contributing, you agree that your contributions are released under the [MIT license](LICENSE).
