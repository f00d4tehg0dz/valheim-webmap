// Chunked world data shared by the 2D layers and the 3D view: player-built
// pieces and vegetation, 256 m squares fetched on demand and cached by the
// server's revision numbers.

import { getJSON, getBuffer, on, state } from './net.js';

export const VEG_KIND = ['none', 'deciduous', 'conifer', 'swamptree', 'misttree', 'deadtree', 'bush', 'rock', 'ore', 'stump', 'berry', 'ashtree'];

class ChunkStore {
  constructor() {
    this.index = new Map();      // "cx_cz" -> {rev, count}
    this.indexRev = -1;
    this.cache = new Map();      // "cx_cz" -> {rev, data}
    this.inflight = new Map();
    this.listeners = new Set();
    this.vegCache = new Map();   // "cx_cz" -> {worldRev, points}
    on('world', () => this.refreshIndex());
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  async refreshIndex() {
    try {
      const idx = await getJSON('data/structures/index.json');
      if (idx.rev === this.indexRev) return;
      this.indexRev = idx.rev;
      const next = new Map();
      for (const [cx, cz, rev, count] of idx.chunks) next.set(`${cx}_${cz}`, { rev, count });
      // drop cached chunks that changed or vanished
      for (const [k, c] of this.cache) {
        const n = next.get(k);
        if (!n || n.rev !== c.rev) this.cache.delete(k);
      }
      this.index = next;
      this.vegCache.clear();
      for (const fn of this.listeners) fn();
    } catch (e) { console.warn('structures index', e); }
  }

  has(cx, cz) { return this.index.has(`${cx}_${cz}`); }
  countIn(cx, cz) { const e = this.index.get(`${cx}_${cz}`); return e ? e.count : 0; }

  // Resolves to the chunk's piece list ([] when the chunk has none). Pieces are
  // arrays: [x, z, y, yaw, sx, sz, h, mat, prefabIdx]; `prefabs` names them.
  async get(cx, cz) {
    const k = `${cx}_${cz}`;
    const e = this.index.get(k);
    if (!e) return { pieces: [], prefabs: [], rev: 0 };
    const c = this.cache.get(k);
    if (c && c.rev === e.rev) return c.data;
    if (this.inflight.has(k)) return this.inflight.get(k);
    const p = getJSON(`data/structures/${k}.json`).then((data) => {
      this.cache.set(k, { rev: data.rev, data });
      this.inflight.delete(k);
      return data;
    }).catch((err) => { this.inflight.delete(k); throw err; });
    this.inflight.set(k, p);
    return p;
  }

  // Vegetation points in a chunk: Float32Array-ish records {x, y, z, kind, size}.
  async veg(cx, cz) {
    const k = `${cx}_${cz}`;
    const c = this.vegCache.get(k);
    if (c) return c;
    let pts = [];
    try {
      const buf = await getBuffer(`data/veg/${k}.bin`);
      const dv = new DataView(buf);
      if (buf.byteLength >= 8 && String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) === 'VEG1') {
        const n = dv.getUint32(4, true);
        const minX = -10240 + cx * 256, minZ = -10240 + cz * 256;
        let o = 8;
        for (let i = 0; i < n; i++) {
          const x = minX + dv.getInt16(o, true) / 4; o += 2;
          const z = minZ + dv.getInt16(o, true) / 4; o += 2;
          const y = dv.getInt16(o, true) / 4; o += 2;
          const kind = dv.getUint8(o); o += 1;
          const size = dv.getUint8(o) / 32; o += 1;
          pts.push({ x, y, z, kind, size });
        }
      }
    } catch (e) { /* unexplored or missing: no vegetation */ }
    this.vegCache.set(k, pts);
    return pts;
  }
}

export const chunks = new ChunkStore();

// Prefab model library index: hash -> {n: name, c: category, m: has model, t: triangles, x: textured, b: bounds[6]}
export const prefabs = {
  map: new Map(), rev: -1, listeners: new Set(), stats: {},
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  get(hash) { return this.map.get(hash); },
  async refresh() {
    if (state.config && state.config.enable_3d === false) return;   // 3D-only data
    try {
      const d = await getJSON('data/prefabs.json');
      if (d.rev === this.rev) return;
      this.rev = d.rev;
      this.stats = { exported: d.exported, readable: d.readable, unreadable: d.unreadable, queued: d.queued };
      this.map = new Map(Object.entries(d.prefabs || {}).map(([k, v]) => [+k, v]));
      for (const fn of this.listeners) fn(this);
    } catch (e) { console.warn('prefabs', e); }
  },
};
on('world', () => prefabs.refresh());

// Which object categories the 3D view draws (the server decides which it publishes at all: object_categories).
export const OBJECT_CATS = [['piece', 'Buildings'], ['other', 'Ruins & objects'], ['rock', 'Rocks'], ['bush', 'Bushes'], ['tree', 'Trees']];
export const objectFilter = {
  on: new Set(['piece', 'other', 'rock', 'bush', 'tree']), listeners: new Set(),
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  shows(cat) { return !cat || this.on.has(cat); },
  set(cat, v) {
    if (v) this.on.add(cat); else this.on.delete(cat);
    try { localStorage.setItem('webmap.objects2', [...this.on].join(',')); } catch { }
    for (const fn of this.listeners) fn();
  },
};
try { const v = localStorage.getItem('webmap.objects2'); if (v !== null) objectFilter.on = new Set(v.split(',').filter(Boolean)); } catch { }

// World objects per chunk (everything with a mesh: pieces, ruins, trees, rocks, boats ...)
class ObjectStore {
  constructor() {
    this.index = new Map();      // "cx_cz" -> {rev, count}
    this.indexRev = -1;
    this.cache = new Map();      // "cx_cz" -> {rev, objs}
    this.inflight = new Map();
    this.listeners = new Set();
    on('world', () => this.refreshIndex());
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  async refreshIndex() {
    if (state.config && state.config.enable_3d === false) return;   // 3D-only data
    try {
      const idx = await getJSON('data/objects/index.json');
      if (idx.rev === this.indexRev) return;
      this.indexRev = idx.rev;
      const next = new Map();
      for (const [cx, cz, rev, count] of idx.chunks) next.set(`${cx}_${cz}`, { rev, count });
      for (const [k, c] of this.cache) { const n = next.get(k); if (!n || n.rev !== c.rev) this.cache.delete(k); }
      this.index = next;
      for (const fn of this.listeners) fn();
    } catch (e) { console.warn('objects index', e); }
  }
  has(cx, cz) { return this.index.has(`${cx}_${cz}`); }
  countIn(cx, cz) { const e = this.index.get(`${cx}_${cz}`); return e ? e.count : 0; }
  // Resolves to {rev, objs: [{prefab, x, y, z, qx, qy, qz, qw, sx, sy, sz, creator}]}
  async get(cx, cz) {
    const k = `${cx}_${cz}`;
    const e = this.index.get(k);
    if (!e) return { rev: 0, objs: [] };
    const c = this.cache.get(k);
    if (c && c.rev === e.rev) return c;
    if (this.inflight.has(k)) return this.inflight.get(k);
    const p = getBuffer(`data/objects/${k}.bin`).then((buf) => {
      const dv = new DataView(buf);
      const objs = [];
      if (buf.byteLength >= 12 && String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) === 'OBJ1') {
        const n = dv.getUint32(4, true), np = dv.getUint32(8, true);
        const table = new Int32Array(np);
        let o = 12;
        for (let i = 0; i < np; i++) { table[i] = dv.getInt32(o, true); o += 4; }
        for (let i = 0; i < n; i++) {
          const pi = dv.getUint16(o, true), flags = dv.getUint8(o + 2); o += 4;
          const f = new Float32Array(buf.slice(o, o + 40)); o += 40;
          objs.push({ prefab: table[pi], creator: (flags & 1) !== 0, x: f[0], y: f[1], z: f[2], qx: f[3], qy: f[4], qz: f[5], qw: f[6], sx: f[7], sy: f[8], sz: f[9] });
        }
      }
      const res = { rev: e.rev, objs };
      this.cache.set(k, res);
      this.inflight.delete(k);
      return res;
    }).catch((err) => { this.inflight.delete(k); throw err; });
    this.inflight.set(k, p);
    return p;
  }
}
export const objects = new ObjectStore();

// Markers (locations, portals, tombstones, vehicles, custom sets)
export const markers = {
  sets: [], rev: -1, listeners: new Set(),
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  async refresh() {
    try {
      const m = await getJSON('data/markers.json');
      if (m.rev === this.rev) return;
      this.rev = m.rev; this.sets = m.sets || [];
      for (const fn of this.listeners) fn(this.sets);
    } catch (e) { console.warn('markers', e); }
  },
};
on('world', () => markers.refresh());

// Stats (server + players)
export const stats = {
  data: null, listeners: new Set(),
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  set(d) { this.data = d; for (const fn of this.listeners) fn(d); },
  async refresh() { try { this.set(await getJSON('data/stats.json')); } catch (e) { console.warn('stats', e); } },
};
on('world', (f) => { if (f.stats) stats.set(f.stats); });
