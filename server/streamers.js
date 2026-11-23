// The streamers a project clips: Twitch, Kick and YouTube channel links, written any way people
// paste them ("twitch.tv/kaicenat", "https://www.youtube.com/@IShowSpeed", one per line or with commas).

const TWITCH_RESERVED = new Set(['directory', 'videos', 'settings', 'p', 'search', 'downloads', 'jobs', 'turbo', 'store', 'subscriptions', 'inventory', 'wallet', 'drops']);
const KICK_RESERVED = new Set(['video', 'videos', 'categories', 'search', 'auth', 'browse', 'following', 'dashboard']);

// One link -> { platform, id, url, label } or null.
export function parseStreamer(input) {
  let s = String(input || '').trim().replace(/[),.;]+$/, '');
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www|m|go)\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  const first = parts[0] || '';
  if (host === 'twitch.tv' && /^[a-z0-9_]{2,25}$/i.test(first) && !TWITCH_RESERVED.has(first.toLowerCase())) {
    const id = first.toLowerCase();
    return { platform: 'twitch', id, url: `https://www.twitch.tv/${id}`, label: id };
  }
  if (host === 'kick.com' && /^[a-z0-9_-]{2,40}$/i.test(first) && !KICK_RESERVED.has(first.toLowerCase())) {
    const id = first.toLowerCase();
    return { platform: 'kick', id, url: `https://kick.com/${id}`, label: id };
  }
  if (host === 'youtube.com') {
    let id = null;
    if (/^@[\w.-]{2,60}$/.test(first)) id = first;
    else if (first === 'channel' && /^UC[\w-]{22}$/.test(parts[1] || '')) id = `channel/${parts[1]}`;
    else if ((first === 'c' || first === 'user') && /^[\w.-]{2,60}$/.test(parts[1] || '')) id = `${first}/${parts[1]}`;
    if (id) return { platform: 'youtube', id, url: `https://www.youtube.com/${id}`, label: id.startsWith('@') ? id : parts[1] };
  }
  return null;
}

export const PLATFORM_NAMES = { twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube' };
export const MAX_STREAMERS = 20;

// A list (array or text) -> { streamers: [{ platform, id, url, label }], bad: ['what could not be read'] }.
export function parseStreamers(list) {
  const items = (Array.isArray(list) ? list : String(list || '').split(/[\s,]+/)).map((x) => String(x || '').trim()).filter(Boolean);
  const seen = new Set();
  const streamers = [];
  const bad = [];
  for (const item of items) {
    const st = parseStreamer(item);
    if (!st) { bad.push(item); continue; }
    const key = `${st.platform}:${st.id.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    streamers.push(st);
  }
  return { streamers, bad };
}
