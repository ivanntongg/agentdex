// Roles: what each kind of agent does.
//
// Built-in roles belong to the original creatures (CODE for BYTLE, RESEARCH for FENNOOK, ...).
// You can rewrite a built-in role's job, and switch its web search on or off, or reset it.
// Custom roles are new kinds of agent you describe yourself ("Video editor"): they get their own
// creature (an existing one, recoloured), a home building and your job description.
//
// Custom roles are added to SPECIES, so everything that looks up a species works unchanged.
// This registry is shared by the store, the commands and the runtime in the same process;
// a runtime in another process loads it from the town's snapshot and events.
import { SPECIES } from './species.js';

export const ROLE_DEFAULTS = {
  CODE: { job: 'You are a careful software engineer. Read the relevant files before changing anything, keep changes small, and say what you could not verify.', web: false },
  RESEARCH: { job: 'You are a research analyst. Find sources, compare them, and write findings with links. Separate what sources say from your own judgement.', web: true },
  DESIGN: { job: 'You are a product designer. Produce concrete, buildable design specs: layout, states, copy, and the reasoning behind each choice.', web: false },
  OPS: { job: 'You are an operations engineer. Write runbooks and checks that someone tired at 3am can follow. Flag anything risky instead of doing it.', web: false },
  WRITE: { job: 'You are an editor and writer. Write plainly and briefly for the stated reader. Cut anything that does not earn its place.', web: true },
  QA: { job: 'You are a reviewer. You check other agents\' work against the task they were given.', web: false },
};
export const LOOKS = ['bytle', 'fennook', 'chromoth', 'gearbo', 'quillow', 'sentril'];
export const HOMES = ['LAB', 'WORKSHOP'];

export class RoleError extends Error {}

const edits = new Map(); // built-in type -> { job, web }
const BUILTIN_IDS = new Set(Object.keys(SPECIES));

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
export const customIdFor = (name) => `c-${slug(name) || 'role'}`;
const isCustom = (id) => typeof id === 'string' && id.startsWith('c-') && !BUILTIN_IDS.has(id);

// The job text and web switch an agent of this species works with.
export function roleFor(species) {
  if (species?.custom) return { job: species.job, web: Boolean(species.web) };
  const type = species?.types?.[0] || 'CODE';
  const base = ROLE_DEFAULTS[type] || ROLE_DEFAULTS.CODE;
  const e = edits.get(type);
  return { job: e?.job || base.job, web: e && typeof e.web === 'boolean' ? e.web : base.web, edited: Boolean(e) };
}

// Checks a custom role from the page and turns it into a species. Throws RoleError with a reason.
export function normalizeRole(input, { id = null } = {}) {
  const r = input || {};
  const name = String(r.name || '').trim().replace(/\s+/g, ' ');
  if (!/^[A-Za-z0-9][A-Za-z0-9 '&-]{1,23}$/.test(name)) throw new RoleError('Give the role a name of 2 to 24 letters, like "Video editor".');
  const job = String(r.job || '').trim();
  if (job.length < 20) throw new RoleError('Describe the job in a sentence or two: what it does and what it hands back.');
  if (job.length > 2000) throw new RoleError('Keep the job description under 2000 characters.');
  const base = LOOKS.includes(r.look?.base) ? r.look.base : 'bytle';
  const hue = Math.round(Number(r.look?.hue) || 0) % 360;
  const home = HOMES.includes(r.home) ? r.home : 'LAB';
  const web = Boolean(r.web);
  const newId = id || customIdFor(name);
  const upper = name.toUpperCase();
  const clash = Object.entries(SPECIES).find(([k, s]) => k !== newId && s.name === upper);
  if (clash) throw new RoleError(`There is already a kind of agent called ${upper}. Pick another name.`);
  const label = (name.split(' ')[0].toUpperCase().replace(/[^A-Z0-9]/g, '') || 'CUSTOM').slice(0, 9);
  return {
    id: newId,
    species: {
      name: upper, title: name, types: [label], home, hp: 180, custom: true, job, web, look: { base, hue },
      moves: web ? [['READ', 30], ['SEARCH', 20], ['DRAFT', 20], ['EDIT', 10]] : [['READ', 30], ['DRAFT', 20], ['EDIT', 15], ['CHECK', 10]],
    },
  };
}

export function defineRole(id, species) {
  if (!isCustom(id)) throw new RoleError('Custom role ids start with c-.');
  SPECIES[id] = species;
}
export function removeRole(id) { if (isCustom(id)) delete SPECIES[id]; }

export function editBuiltin(type, { job, web } = {}) {
  if (!ROLE_DEFAULTS[type]) throw new RoleError(`There is no built-in role ${type}.`);
  const text = String(job || '').trim();
  if (text.length < 20) throw new RoleError('Describe the job in a sentence or two.');
  if (text.length > 2000) throw new RoleError('Keep the job description under 2000 characters.');
  edits.set(type, { job: text, web: type === 'QA' ? false : Boolean(web) });
}
export const resetBuiltin = (type) => { edits.delete(type); };

// Everything about roles the town shows and saves.
export function rolesState({ withDefaults = true } = {}) {
  const custom = Object.entries(SPECIES).filter(([id]) => isCustom(id)).map(([id, s]) => ({ id, ...structuredClone(s) }));
  return { custom, edits: Object.fromEntries([...edits].map(([k, v]) => [k, { ...v }])), ...(withDefaults ? { defaults: ROLE_DEFAULTS } : {}) };
}

// Replaces all custom roles and edits (from a save file or a snapshot).
export function loadRoles(state) {
  for (const id of Object.keys(SPECIES)) if (isCustom(id)) delete SPECIES[id];
  edits.clear();
  for (const r of state?.custom || []) {
    if (!isCustom(r?.id)) continue;
    try { const { species } = normalizeRole({ name: r.title || r.name, job: r.job, web: r.web, home: r.home, look: r.look }, { id: r.id }); defineRole(r.id, species); } catch { /* skip a damaged role */ }
  }
  for (const [type, e] of Object.entries(state?.edits || {})) { try { editBuiltin(type, e); } catch { /* skip */ } }
}

// A role.saved or role.deleted event, as seen by a runtime in another process.
export function applyRoleEvent(event) {
  const d = event?.data || {};
  if (event?.type === 'role.saved') {
    if (d.role?.id) defineRole(d.role.id, normalizeRole(d.role, { id: d.role.id }).species);
    else if (d.type) editBuiltin(d.type, d);
  } else if (event?.type === 'role.deleted') {
    if (d.id) removeRole(d.id);
    else if (d.type) resetBuiltin(d.type);
  }
}
