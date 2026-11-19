// Agent templates the server knows about. The client keeps its own copy for art and dex text;
// the ids here must match the client's sprite keys.
export const SPECIES = {
  bytle:    { name: 'BYTLE',    types: ['CODE'],     home: 'WORKSHOP', hp: 200, moves: [['READ', 30], ['EDIT', 20], ['TEST', 15], ['MERGE', 5]], evolve: { to: 'bytlord', lv: 13 } },
  bytlord:  { name: 'BYTLORD',  types: ['CODE'],     home: 'WORKSHOP', hp: 260, moves: [['READ', 40], ['EDIT', 30], ['TEST', 20], ['MERGE', 8]] },
  fennook:  { name: 'FENNOOK',  types: ['RESEARCH'], home: 'LAB',      hp: 160, moves: [['SEARCH', 30], ['FETCH', 20], ['SKIM', 25], ['CITE', 15]] },
  chromoth: { name: 'CHROMOTH', types: ['DESIGN'],   home: 'WORKSHOP', hp: 120, moves: [['SKETCH', 20], ['PALETTE', 15], ['LAYOUT', 15], ['CRITIQUE', 10]] },
  gearbo:   { name: 'GEARBO',   types: ['OPS'],      home: 'WORKSHOP', hp: 180, moves: [['MONITOR', 30], ['SCALE', 10], ['ROLLBACK', 5], ['DEPLOY', 5]] },
  sentril:  { name: 'SENTRIL',  types: ['QA'],       home: 'GYM',      hp: 220, moves: [['LINT', 30], ['ASSERT', 20], ['FUZZ', 10], ['REVIEW', 15]], reviewer: true },
  quillow:  { name: 'QUILLOW',  types: ['WRITE', 'RESEARCH'], home: 'LAB', hp: 140, moves: [['DRAFT', 20], ['CITE', 15], ['TRIM', 25], ['SEND', 5]] },
};

export const BUILDINGS = ['LAB', 'MART', 'WORKSHOP', 'CENTER', 'GYM'];

export const PARTY_MAX = 6;

export const hpMaxFor = (species, lv) => SPECIES[species].hp + lv * 4;
export const xpToNext = (lv) => lv * 40;
