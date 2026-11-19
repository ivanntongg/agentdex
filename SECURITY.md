# Security

Agentdex lets AI agents act on your computer, so its safety rules matter more than most features.

## Reporting a problem

Please report security problems **privately**, not in a public issue:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Describe what you found, how to reproduce it, and what an attacker could do with it.

You will get a reply within a week. Please give a reasonable time for a fix before sharing details publicly.

## What counts

Anything that breaks one of these promises:

| Promise | Where it is enforced |
|---|---|
| Agents can only read and write inside the workspace folder, including through `..`, absolute paths and symlinks | `runtime/workspace.js` |
| Nothing outside `workspace/drafts` is written without the player's YES | `runtime/runtime.js` |
| The SETUP screen only answers requests from the same computer | `server/app.js` |
| Keys and secrets are never returned in full, logged, or put in events | `server/config.js` |
| The WhatsApp webhook rejects requests without a valid Meta signature, and ignores numbers that are not allowed | `bridges/whatsapp.js` |
| With `AGENTDEX_TOKEN` set, every POST needs the token | `server/app.js` |

Also in scope: ways for a web page, a tool result or a message to trick an agent into skipping an approval.

## Not in scope

- Anything that needs someone who already controls your computer or your user account.
- Exposing the town to a network on purpose (`HOST=0.0.0.0`) without setting `AGENTDEX_TOKEN`. Agentdex warns about this when it starts.
- What Claude writes inside the workspace drafts folder. That folder is meant for unreviewed work.

## Keeping your setup safe

- Treat your Claude API key and WhatsApp tokens like passwords. Never paste them into issues, chats or screenshots.
- Keep Agentdex on `localhost` unless you need otherwise, and set `AGENTDEX_TOKEN` if you open it up.
- Point the workspace at a folder that holds nothing you would mind an agent reading.
- Only say YES to requests you understand.
