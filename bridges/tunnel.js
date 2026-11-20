// Keeps the WhatsApp webhook reachable from the internet by running ngrok for you, inside Agentdex.
// You install ngrok once and paste your authtoken and free static domain in SETUP; after that there
// is no second window to keep open, and the address never changes, so Meta only needs it once.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export class TunnelError extends Error {}

// Where ngrok usually is: PATH first, then the places the Windows and Mac installers use,
// so a fresh install works without restarting the terminal.
export function findNgrok({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const name = win ? 'ngrok.exe' : 'ngrok';
  const dirs = String(env.PATH || env.Path || '').split(win ? ';' : ':').map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean);
  const extra = win
    ? [env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps'), env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'), env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, 'ngrok')]
    : ['/opt/homebrew/bin', '/usr/local/bin', '/snap/bin', p.join(env.HOME || os.homedir(), 'bin')];
  for (const d of [...dirs, ...extra.filter(Boolean)]) {
    const f = p.join(d, name);
    if (exists(f)) return f;
  }
  return null;
}

// "https://x.ngrok-free.app/" or "x.ngrok-free.app" -> "x.ngrok-free.app"
export const cleanDomain = (d) => String(d || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();

export function friendlyTunnelError(text) {
  const t = String(text || '');
  if (/ENOENT|not found|not recognized/i.test(t)) return 'ngrok is not installed on this computer. Install it (step 3), then press SAVE WHATSAPP again.';
  if (/ERR_NGROK_105|ERR_NGROK_107|authentication failed|authtoken/i.test(t)) return 'ngrok rejected the authtoken. Copy it again from dashboard.ngrok.com, under Your Authtoken.';
  if (/ERR_NGROK_108|ERR_NGROK_334|already online|simultaneous/i.test(t)) return 'Your ngrok account already has a tunnel open somewhere else, maybe an ngrok window. Close it, then press SAVE WHATSAPP again.';
  if (/ERR_NGROK_3(19|20|13)|not bound|reserved|domain/i.test(t)) return 'That address is not yours in ngrok. Copy your free static domain from dashboard.ngrok.com, under Domains.';
  if (/unknown flag|flag provided but not defined/i.test(t)) return 'Your ngrok is too old. Run "ngrok update" in a terminal, then press SAVE WHATSAPP again.';
  return `ngrok stopped: ${t.slice(0, 160)}`;
}

// Starts `ngrok http <port>` and resolves with { url, stop } once the tunnel is up.
export function startTunnel({ bin, port, authtoken, domain, spawnImpl = spawn, timeoutMs = 20_000, onExit = () => {} }) {
  return new Promise((resolve, reject) => {
    if (!bin) return reject(new TunnelError(friendlyTunnelError('ENOENT')));
    const host = cleanDomain(domain);
    const args = ['http', String(port), '--log', 'stdout', '--log-format', 'json', ...(host ? ['--url', `https://${host}`] : [])];
    let child;
    try {
      child = spawnImpl(bin, args, { env: { ...process.env, NGROK_AUTHTOKEN: authtoken }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) { return reject(new TunnelError(friendlyTunnelError(err.code || err.message))); }
    let done = false;
    let lastErr = '';
    const timer = setTimeout(() => fail(lastErr || 'it did not start within 20 seconds'), timeoutMs);
    function fail(why) {
      if (done) return;
      done = true; clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      reject(new TunnelError(friendlyTunnelError(why)));
    }
    let exited = false;
    // Stops ngrok and waits (up to 3 seconds) until it is gone, so a restart doesn't collide with it.
    const stop = () => new Promise((r) => {
      if (exited) return r();
      const t = setTimeout(r, 3000);
      child.once('exit', () => { clearTimeout(t); r(); });
      try { child.kill(); } catch { clearTimeout(t); r(); }
    });
    createInterface({ input: child.stdout }).on('line', (line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.err && ev.err !== '<nil>') lastErr = String(ev.err);
      if (!done && ev.msg === 'started tunnel' && /^https:\/\//.test(ev.url || '')) {
        done = true; clearTimeout(timer);
        resolve({ url: ev.url, stop });
      }
    });
    child.stderr?.on('data', (d) => { lastErr = (lastErr + d).slice(-400); });
    child.on('error', (err) => fail(err.code === 'ENOENT' ? 'ENOENT' : err.message));
    child.on('exit', (code) => {
      exited = true;
      if (!done) return fail(lastErr || `exited with code ${code}`);
      onExit(friendlyTunnelError(lastErr || `exited with code ${code}`));
    });
  });
}
