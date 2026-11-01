// World-generated structures on the 2D map -- abandoned houses, fuling villages, shipwrecks,
// mountain and castle ruins -- drawn as weathered footprints from the server's data/ruins feed
// (same compact format as the player-built structures, explored chunks only). Player builds stay
// on the Buildings layer; spawners, pickables, loot and boss altars are never in the feed.

import { TILE, WORLD_HALF, chunkOf, metersPerPixel } from '../crs.js';
import { getJSON, on } from '../net.js';

const MIN_ZOOM = 2;          // same range as the Buildings layer: a small square per piece, footprints from DETAIL_ZOOM
const DETAIL_ZOOM = 5;
const COLOR = '#4a3f33';     // dark weathered wood: reads on snow, sand and grass
const COLOR_STONE = '#3d4654';
const STONE_MATS = new Set([3, 4, 10]);   // Stone, Black marble, Grausten (icons.js materialNames)

class RuinStore {
  constructor() {
    this.index = new Map();   // "cx_cz" -> {rev, count}
    this.indexRev = -1;
    this.cache = new Map();   // "cx_cz" -> {rev, pieces}
    this.inflight = new Map();
    this.listeners = new Set();
    on('world', () => this.refreshIndex());
  }
  onChange(fn) { this.listeners.add(fn); }
  async refreshIndex() {
    try {
      const idx = await getJSON('data/ruins/index.json');
      if (idx.rev === this.indexRev) return;
      this.indexRev = idx.rev;
      const next = new Map();
      for (const [cx, cz, rev, count] of idx.chunks) next.set(`${cx}_${cz}`, { rev, count });
      for (const [k, c] of this.cache) { const n = next.get(k); if (!n || n.rev !== c.rev) this.cache.delete(k); }
      this.index = next;
      for (const fn of this.listeners) fn();
    } catch (e) { console.warn('ruins index', e); }
  }
  has(cx, cz) { return this.index.has(`${cx}_${cz}`); }
  async get(cx, cz) {
    const k = `${cx}_${cz}`, e = this.index.get(k);
    if (!e) return [];
    const c = this.cache.get(k);
    if (c && c.rev === e.rev) return c.pieces;
    if (this.inflight.has(k)) return this.inflight.get(k);
    const p = getJSON(`data/ruins/${k}.json`).then((d) => { this.cache.set(k, { rev: d.rev, pieces: d.pieces }); this.inflight.delete(k); return d.pieces; })
      .catch(() => { this.inflight.delete(k); return []; });
    this.inflight.set(k, p);
    return p;
  }
}
const ruins = new RuinStore();

export class RuinsLayer extends L.GridLayer {
  constructor(options) {
    super(Object.assign({ tileSize: TILE, minZoom: MIN_ZOOM, maxZoom: 10, updateWhenIdle: true, updateWhenZooming: false, keepBuffer: 2, className: 'ruins-tile', zIndex: 240 }, options));
    // Repaint the existing tiles in place when the data changes, instead of redraw(), which removes
    // every tile first and makes the whole layer blink.
    ruins.onChange(() => { if (!this._map) return; for (const t of Object.values(this._tiles)) this.draw(t.el, t.coords).catch(() => {}); });
    if (ruins.indexRev < 0) ruins.refreshIndex();
  }

  createTile(coords, done) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = TILE;   // 1x: simple shapes
    this.draw(canvas, coords).then(() => done(null, canvas)).catch((e) => { console.warn(e); done(null, canvas); });
    return canvas;
  }

  async draw(canvas, coords) {
    const z = coords.z;
    if (z < MIN_ZOOM) return;   // Leaflet still asks for tiles below minZoom
    const mpp = metersPerPixel(z), ppm = 1 / mpp, span = TILE * mpp;
    const minX = -WORLD_HALF + coords.x * span, maxZ = WORLD_HALF - coords.y * span;
    const maxX = minX + span, minZ = maxZ - span;
    const M = 16;
    const lists = [];
    for (let cz = chunkOf(minZ - M); cz <= chunkOf(maxZ + M); cz++)
      for (let cx = chunkOf(minX - M); cx <= chunkOf(maxX + M); cx++)
        if (cx >= 0 && cz >= 0 && cx < 80 && cz < 80 && ruins.has(cx, cz)) lists.push(ruins.get(cx, cz));
    const chunksData = lists.length ? await Promise.all(lists) : [];
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);   // in-place repaints start from a clean tile
    const detailed = z >= DETAIL_ZOOM;
    for (const pieces of chunksData) {
      for (const [x, zz, , yaw, sx, sz, , mat] of pieces) {
        if (x < minX - M || x > maxX + M || zz < minZ - M || zz > maxZ + M) continue;
        const px = (x - minX) * ppm, py = (maxZ - zz) * ppm;
        ctx.fillStyle = STONE_MATS.has(mat) ? COLOR_STONE : COLOR;
        if (!detailed) {   // same dots as the Buildings layer zoomed out
          const r = z >= 4 ? 0.9 : 0.7;   // a bit smaller than Buildings: ruins pack many pieces close together
          ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 0.9; ctx.fillRect(px - r, py - r, r * 2, r * 2);
          continue;
        }
        const w = Math.max(sx * ppm, 1.2), d = Math.max(sz * ppm, 1.2);
        const a = yaw * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
        ctx.setTransform(c, s, -s, c, px, py);   // same rotation convention as the Buildings layer
        ctx.globalAlpha = 0.9;
        ctx.fillRect(-w / 2, -d / 2, w, d);
        if (w > 3 || d > 3) {
          ctx.globalAlpha = 0.75; ctx.strokeStyle = '#e8dcc4'; ctx.lineWidth = 0.75;   // light edge so dark shapes pop on dark forest too
          ctx.strokeRect(-w / 2 + .4, -d / 2 + .4, w - .8, d - .8);
        }
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}
