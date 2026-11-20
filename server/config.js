// Settings entered on the SETUP screen, saved to agentdex.config.json next to the app.
// The file never leaves your computer and is git-ignored. Secrets are only ever sent back to the
// page masked (last 4 characters).
import { readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export const SECRET_FIELDS = ['anthropicKey', 'whatsappToken', 'whatsappAppSecret', 'ngrokAuthtoken'];
export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
export const EFFORTS = ['low', 'medium', 'high'];
export const BRAINS = ['api', 'claude-code'];

const FIELDS = {
  brain: (v) => (BRAINS.includes(v) ? null : `Brain must be one of ${BRAINS.join(', ')}`),
  anthropicKey: (v) => (v.startsWith('sk-ant-') ? null : 'A Claude API key starts with sk-ant-'),
  model: (v) => (MODELS.includes(v) ? null : `Model must be one of ${MODELS.join(', ')}`),
  effort: (v) => (EFFORTS.includes(v) ? null : `Effort must be one of ${EFFORTS.join(', ')}`),
  whatsappToken: () => null,
  whatsappPhoneNumberId: (v) => (/^\d{5,20}$/.test(v) ? null : 'Phone number ID is the long number from Meta, digits only'),
  whatsappAppSecret: (v) => (/^[a-f0-9]{16,64}$/i.test(v) ? null : 'App secret is the code under App settings, Basic (letters a-f and digits)'),
  ngrokAuthtoken: (v) => (/^[A-Za-z0-9_-]{20,120}$/.test(v) ? null : 'The ngrok authtoken is the long code under Your Authtoken on dashboard.ngrok.com'),
  ngrokDomain: (v) => (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase()) ? null : 'The static domain looks like your-name.ngrok-free.app'),
  skillScout: (v) => (['on', 'off'].includes(v) ? null : 'skillScout must be on or off'),
  whatsappAllowed: (v) => (v.split(',').every((p) => /^\+?[\d\s-]{8,20}$/.test(p.trim())) ? null : 'Your number with country code, like +60 12 345 6789'),
};

export class ConfigError extends Error {}

export function createConfig({ path = 'agentdex.config.json', env = process.env } = {}) {
  let data = {};
  try { data = JSON.parse(readFileSync(path, 'utf8')); } catch { /* first run */ }
  if (!data.whatsappVerifyToken) data.whatsappVerifyToken = randomBytes(12).toString('hex');
  const listeners = new Set();

  // Saved value first, then the matching environment variable.
  const ENV = {
    brain: 'AGENTDEX_BRAIN', anthropicKey: 'ANTHROPIC_API_KEY', model: 'AGENTDEX_MODEL', effort: 'AGENTDEX_EFFORT',
    whatsappToken: 'WHATSAPP_TOKEN', whatsappPhoneNumberId: 'WHATSAPP_PHONE_NUMBER_ID',
    whatsappAppSecret: 'WHATSAPP_APP_SECRET', whatsappAllowed: 'WHATSAPP_ALLOWED', skillScout: 'AGENTDEX_SKILL_SCOUT', ngrokAuthtoken: 'NGROK_AUTHTOKEN', ngrokDomain: 'AGENTDEX_NGROK_DOMAIN',
  };
  const get = (k) => data[k] || (ENV[k] && env[ENV[k]]) || null;

  function save(patch) {
    const next = { ...data };
    for (const [k, raw] of Object.entries(patch || {})) {
      if (!(k in FIELDS)) continue;
      const v = typeof raw === 'string' ? raw.trim() : '';
      if (v === '') { if (raw === null || raw === '') delete next[k]; continue; }
      const err = FIELDS[k](v);
      if (err) throw new ConfigError(err);
      next[k] = v;
    }
    data = next;
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
    try { chmodSync(path, 0o600); } catch { /* Windows */ }
    for (const fn of listeners) fn();
  }

  const mask = (v) => (v ? `••••${v.slice(-4)}` : null);

  return {
    get,
    save,
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    brain: () => (BRAINS.includes(get('brain')) ? get('brain') : 'api'),
    model: () => get('model') || 'claude-opus-5-5',
    effort: () => get('effort') || 'medium',
    skillScout: () => get('skillScout') !== 'off', // agents may look for community skills on their own
    verifyToken: () => data.whatsappVerifyToken,
    whatsapp() {
      const c = {
        token: get('whatsappToken'), phoneNumberId: get('whatsappPhoneNumberId'), appSecret: get('whatsappAppSecret'),
        allowed: get('whatsappAllowed'), verifyToken: data.whatsappVerifyToken,
        apiVersion: env.WHATSAPP_API_VERSION || 'v23.0', port: Number(env.WHATSAPP_PORT || 8788),
      };
      return c.token && c.phoneNumberId && c.appSecret && c.allowed ? c : null;
    },
    // The built-in tunnel for WhatsApp: needs your ngrok authtoken; the static domain keeps the address fixed.
    tunnel() {
      const authtoken = get('ngrokAuthtoken');
      const domain = String(get('ngrokDomain') || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase() || null;
      return authtoken ? { authtoken, domain } : null;
    },
    // What the SETUP screen may see.
    publicView() {
      const view = { brain: this.brain(), model: this.model(), effort: this.effort(), whatsappVerifyToken: data.whatsappVerifyToken,
        whatsappPhoneNumberId: get('whatsappPhoneNumberId'), whatsappAllowed: get('whatsappAllowed'), ngrokDomain: this.tunnel()?.domain || null };
      for (const k of SECRET_FIELDS) view[k] = mask(get(k));
      return view;
    },
  };
}
