// The demo party, matching the offline demo in index.html.
export function seedParty(store) {
  const spawn = (data) => store.apply({ type: 'agent.spawned', data: { silent: true, ...data } });
  spawn({ species: 'bytle', nick: 'PATCH', lv: 12, xp: 430, hp: 142, loc: 'WORKSHOP' });
  spawn({ species: 'fennook', nick: 'SCOUT', lv: 9, loc: 'LAB' });
  spawn({ species: 'chromoth', nick: 'PIXIE', lv: 7, hp: 66, loc: 'WORKSHOP' });
  spawn({ species: 'gearbo', nick: 'ROLLO', lv: 14, loc: 'WORKSHOP' });
  spawn({ species: 'sentril', nick: 'CHECKS', lv: 11, loc: 'GYM' });
  spawn({ species: 'bytle', nick: 'BYTLE-2', lv: 6, boxed: true });
}
