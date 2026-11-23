# Agentdex event protocol

The server owns the world. Everything that happens to an agent is an **event**. The town never guesses: an agent walks because an `agent.moved` event arrived, an exclamation bubble appears because an `approval.requested` event arrived.

There are two sources of events:

- **The built-in simulator** (on by default) sends random but plausible events, so the town is alive without a real runtime.
- **Your agent runtime** posts events to `POST /api/ingest`. Turn the simulator off with `AGENTDEX_SIM=0` when you do this.

The simulator only uses the public event API, so anything it does, your runtime can do too. `server/simulator.js` is the reference implementation.

## Endpoints

| Method | Path | Body | What it does |
|---|---|---|---|
| GET | `/api/state` | | Full snapshot: agents, open approvals, recent log |
| GET | `/api/events` | | Server-Sent Events. One `snapshot`, then a `change` for every event |
| POST | `/api/ingest` | an event, or an array of up to 100 | Apply events from your runtime |
| POST | `/api/approvals/:id` | `{"decision":"yes"\|"no"}` | Answer an approval |
| POST | `/api/agents/:id/tasks` | `{"title":"...","review":true}` | Give an agent a task |
| POST | `/api/agents/:id/chat` | `{"text":"how is it going?"}` | Talk to an agent. Your runtime answers with `chat.replied` |
| POST | `/api/files?name=report.pdf` | the file's bytes | Saves into `workspace/inbox` (real mode, up to 25 MB). Returns `{ path }`. Pass paths as `files: [...]` to `/api/command`, `/api/agents/:id/chat` or `/tasks` |
| POST | `/api/command` | `{"text":"compare 3 note apps"}` | One sentence from the command bar: routes a task to the best agent, or runs status / yes / no / reset / rename. Returns `{ reply }` |
| POST | `/api/agents` | `{"species":"fennook","nick":"SCOUT"}` | Spawn into the party |
| POST | `/api/projects` | `{"project":{"id?","name","brief","streamers?":["twitch.tv/kaicenat"]}}` | Creates or edits a project (folder `drafts/<name>`). `streamers` are Twitch, Kick or YouTube channel links, up to 20 |
| POST | `/api/projects/delete` | `{"id"}` | Deletes a project with no plans; its files stay |
| POST | `/api/plans` | `{"pipeline":{"id?","name","projectId","schedule":{"day","time"},"steps":[{"agentId","title","text","find?","edit?"}],"review","enabled"}}` | Creates or edits a weekly plan. `day` is `mon`..`sun`, `daily` or `manual` |
| POST | `/api/plans/run`, `/api/plans/stop`, `/api/plans/delete` | `{"id"}` | Runs, stops or deletes a plan |
| POST | `/api/roles` | `{"role":{"name","job","web","home","look":{"base","hue"}}}` or `{"type":"CODE","job","web"}` | Creates or edits a custom role (add `id` to edit), or rewrites a built-in role |
| POST | `/api/roles/delete` | `{"id":"c-video-editor"}` or `{"type":"CODE"}` | Deletes an unused custom role, or resets a built-in role |
| GET | `/api/skills` | | Installed skills, and whether agents may look for skills on their own (real mode) |
| POST | `/api/skills/search` | `{"q":"youtube titles"}` | Searches skills.sh. Returns `{ results }` |
| POST | `/api/skills/request` | `{"id":"owner/repo/skill"}` | A free agent fetches it, CHECKS reviews it, then the player gets a YES / NO |
| POST | `/api/skills/remove` | `{"slug":"youtube-titles"}` | Uninstalls a skill |
| POST | `/api/skills/settings` | `{"enabled":false}` | Lets agents look for skills on their own, or not |
| POST | `/api/agents/:id/actions` | `{"action":"pet"\|"poke"\|"reset"\|"rename"\|"box"\|"unbox"}` (rename also takes `nick`) | Player actions |

If `AGENTDEX_TOKEN` is set, every POST needs `Authorization: Bearer <token>`. To give the page the token, open it once with `?token=<token>`; it is kept in that browser.

## Event shape

```json
{ "type": "task.started", "agentId": "ops-1", "data": { "title": "Deploy api v2.3" } }
```

`agentId` is the server's numeric id or the `ref` you gave the agent when you spawned it. Use `ref` so your runtime can keep its own ids.

The server adds `id` (sequence number), `ts`, a human `message` for the field log and a `tone` (`info`, `ok`, `bad`, `need`, `lvl`).

## Event types

| Type | data | Effect |
|---|---|---|
| `task.assigned` | `title`, `details?`, `review?`, `project?`, `edit?: { folder }` (a plan's editing step), `find?: { folder, streamers }` (a plan's finding step) | The player gave this agent work (`POST /api/agents/:id/tasks`). Your runtime should start it |
| `agent.spawned` | `species`, `nick?`, `ref?`, `lv?`, `boxed?` | New agent. Fails with 409 when the party has 6 |
| `agent.moved` | `to` (LAB, MART, WORKSHOP, CENTER, GYM), `reason?` | The agent walks there. Logged only with a `reason` |
| `task.started` | `title`, `review?`, `approval?: {tool, target}` | Status OK, phase work |
| `task.progress` | `tokens`, `tool?` | HP drops by `tokens` (thousands). At 0 the agent faints |
| `task.handoff` | `reviewerId?` | Logged handoff before a review |
| `review.started` | `reviewerId` | The reviewer is busy with this agent |
| `review.finished` | `reviewerId?`, `result: approved\|changes`, `issues?` | Frees the reviewer, +25 XP to it |
| `approval.requested` | `tool`, `target`, or `kind: "evolve"`, or `kind: "skill"` with `skill: { id, name, description, source, url, installs?, flags?, review? }` | Status PAR. Shows the YES / NO dialog |
| `approval.resolved` | `approvalId`, `decision` | Normally sent by the page, not by you |
| `task.finished` | `xp?` (default 60), `note?` (shown in the log), `files?` (written files, kept in the agent's memory), or `outcome: "declined"` | Back to idle. May trigger level ups and an evolution request |
| `agent.status` | `status: OK\|SLP\|CNF\|PSN`, `reason?` | Confused (looping) or poisoned (spending fast) |
| `agent.fainted` | `reason?` | Status FNT |
| `agent.reset` | | Full HP and PP, back at the CENTER |
| `agent.boxed` / `agent.unboxed` | | Move between party and box |
| `chat.sent` | `text`, `via?` | The player talked to the agent. The agent is `chatting` until a reply |
| `chat.replied` | `text`, `suggestedTask?`, `via?` | The agent's answer. `suggestedTask` shows a DO IT AS A TASK button |
| `chat.failed` | `reason?`, `via?` | The agent could not answer |
| `files.added` | `files` | The player added files to the inbox. No `agentId` |
| `agent.renamed` | `nick` | New name: one word, 2 to 12 letters, digits, `-` or `_`; unique |
| `project.saved` / `project.deleted` | `project` / `id` | No `agentId` |
| `pipeline.saved` / `pipeline.deleted` | `pipeline` / `id` | No `agentId` |
| `pipeline.started` | `id`, `runId`, `folder`, `by` | A run began (`by` is `you` or `schedule`) |
| `pipeline.stepped` | `id`, `step`, `title`, `result?` | The step's agent got its job; `result` is the previous step's summary and files |
| `pipeline.finished` | `id`, `status: done\|failed\|stopped`, `folder`, `reason?` | The run ended |
| `guide.asked` | `text`, `via?` | The player asked the Guide (`? question` in the command bar). No `agentId` |
| `guide.answered` | `text`, `suggestions: [{ agentId, task }]`, `newRole?: { name, job }`, `via?` | The Guide's answer. Ideas for agents that are not in the town are dropped |
| `guide.failed` | `reason`, `via?` | The Guide could not answer |
| `role.saved` | `role` (a custom role) or `type`, `job`, `web` (a rewritten built-in role) | No `agentId`. Custom roles become species with ids starting `c-` |
| `role.deleted` | `id` or `type` | Removes a custom role nobody uses, or resets a built-in one |
| `skills.updated` | `skills` (the installed list), `note?`, `tone?` | The MART changed. No `agentId`. The log keeps only a count |
| `agent.interacted` | `action: pet\|poke`, `message?` | Pet raises the bond. Poke is up to your runtime |

## Hearing the player's answers

When the player answers an approval, the server applies `approval.resolved` and tells the active adapter (`onApproval`). With a real runtime, watch `GET /api/events` for `approval.resolved` events and continue or cancel the work in your runtime. Then send `task.finished`.

## Try it with curl

```bash
AGENTDEX_SIM=0 npm start
```

```bash
curl -s localhost:8787/api/ingest -H 'content-type: application/json' -d '[
  {"type":"agent.spawned","data":{"species":"gearbo","nick":"ROLLO","ref":"ops-1"}},
  {"type":"agent.moved","agentId":"ops-1","data":{"to":"WORKSHOP"}},
  {"type":"task.started","agentId":"ops-1","data":{"title":"Deploy api v2.3"}},
  {"type":"task.progress","agentId":"ops-1","data":{"tokens":12,"tool":"MONITOR"}},
  {"type":"approval.requested","agentId":"ops-1","data":{"tool":"DEPLOY","target":"api-prod"}}
]'
```

ROLLO appears at the CENTER, walks to the WORKSHOP and asks you to deploy.
