// Entry point: `npm start`.
//   PORT            default 8787
//   HOST            default 127.0.0.1 (set 0.0.0.0 to reach it from other devices)
//   AGENTDEX_SIM    "0" turns the simulator off, for when a real runtime posts to /api/ingest
//   AGENTDEX_TOKEN  if set, every POST must send "Authorization: Bearer <token>"
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { createSimulator } from './simulator.js';
import { createApp } from './app.js';
import { seedParty } from './seed.js';

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const simOn = process.env.AGENTDEX_SIM !== '0';
const token = process.env.AGENTDEX_TOKEN || null;

if (host !== '127.0.0.1' && host !== 'localhost' && !token) {
  console.warn('Warning: listening beyond localhost without AGENTDEX_TOKEN. Anyone on the network can approve actions.');
}

const store = createStore();
const adapter = simOn ? createSimulator() : null;
if (simOn) seedParty(store);

const app = createApp({ store, adapter, token, indexPath: fileURLToPath(new URL('../index.html', import.meta.url)) });
app.listen(port, host, () => {
  console.log(`Agentdex running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  console.log(simOn ? 'Simulator: on (set AGENTDEX_SIM=0 to drive it from a real runtime)' : 'Simulator: off. Waiting for events on POST /api/ingest');
  adapter?.start(store);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { adapter?.stop(); app.close(); process.exit(0); });
