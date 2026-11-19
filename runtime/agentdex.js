// Talks to the Agentdex server: posts events, reads state, follows the live stream.
export function createAgentdexClient({ url, token = null }) {
  const base = url.replace(/\/$/, '');
  const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };

  async function post(pathname, body) {
    const res = await fetch(base + pathname, { method: 'POST', headers, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${pathname} failed (${res.status}): ${json.error || res.statusText}`);
    return json;
  }

  const emit = async (type, agentId, data = {}) => (await post('/api/ingest', { type, agentId, data })).events[0];

  async function state() {
    const res = await fetch(base + '/api/state');
    if (!res.ok) throw new Error(`Could not read state (${res.status})`);
    return res.json();
  }

  // Calls onSnapshot(state) on every (re)connect and onChange(payload) for every event.
  function subscribe({ onSnapshot, onChange, onError = () => {}, signal }) {
    (async () => {
      while (!signal?.aborted) {
        try {
          const res = await fetch(base + '/api/events', { signal });
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const chunk = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              let event = 'message';
              const data = [];
              for (const line of chunk.split('\n')) {
                if (line.startsWith('event:')) event = line.slice(6).trim();
                else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
              }
              if (!data.length) continue;
              const payload = JSON.parse(data.join('\n'));
              if (event === 'snapshot') await onSnapshot?.(payload);
              else if (event === 'change') await onChange?.(payload);
            }
          }
        } catch (err) {
          if (signal?.aborted) return;
          onError(err);
        }
        if (!signal?.aborted) await new Promise((r) => setTimeout(r, 2000));
      }
    })();
  }

  return { post, emit, state, subscribe };
}
