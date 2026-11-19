#!/bin/zsh -l
# Starts Agentdex and opens the town in your browser (Mac).
# Easiest: drag this file to your Dock while holding Cmd+Option to make an alias, or double-click it here.

for dir in "${0:A:h}" "${0:A:h:h}" "$HOME/agentdex" "$HOME/Documents/agentdex" "$HOME/Desktop/agentdex"; do
  if [[ -f "$dir/package.json" && -f "$dir/runtime/index.js" ]]; then AGENTDEX_DIR="$dir"; break; fi
done
if [[ -z "$AGENTDEX_DIR" ]]; then
  echo "Could not find the agentdex folder."
  echo "Keep this file inside the agentdex folder, or download Agentdex into $HOME/agentdex."
  read -r "?Press Enter to close."; exit 1
fi
cd "$AGENTDEX_DIR" || exit 1

if curl -fsS -m 2 http://127.0.0.1:8787/api/state >/dev/null 2>&1; then
  echo "Agentdex is already running. Opening the town."
  open http://localhost:8787; exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Download the LTS version from https://nodejs.org, install it, then try again."
  read -r "?Press Enter to close."; exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "First start: installing Agentdex. This takes a minute."
  npm install || { echo "Install failed. Check your internet connection and try again."; read -r "?Press Enter to close."; exit 1; }
fi

echo "Starting Agentdex from $AGENTDEX_DIR"
echo "Your browser will open in a few seconds. Keep this window open while you play."
echo "To stop Agentdex, close this window."
(sleep 3; open http://localhost:8787) &
npm run real
