// The rendered map tiles, with two things a plain L.TileLayer lacks:
//  * fallback: a tile the server has not rendered yet (or never will, under
//    the fog) shows the nearest zoomed-out ancestor scaled up, so the map is
//    never blank while close-zoom tiles are still rendering;
//  * refresh: when the server says a tile was (re)rendered, just that tile
//    is reloaded in place.

import { MAX_ZOOM, OVER_ZOOM, TILE, WORLD_HALF, worldBounds } from '../crs.js';
import { on } from '../net.js';

const MAX_FALLBACK = 4;   // how many ancestor levels to try

export class FallbackTileLayer extends L.GridLayer {
  constructor(urlTemplate, options) {
    super(Object.assign({ tileSize: TILE, minZoom: 0, maxZoom: OVER_ZOOM, maxNativeZoom: MAX_ZOOM, noWrap: true, bounds: worldBounds, keepBuffer: 2, updateWhenIdle: false, className: 'maptiles' }, options));
    this.template = urlTemplate;
    this.pending = new Set();   // "z/x/y" keys we were told are missing
    on('tiles', (f) => this.onRendered(f.keys));
  }

  url(z, x, y, bust) {
    return this.template.replace('{z}', z).replace('{x}', x).replace('{y}', y) + (bust ? `?r=${bust}` : '');
  }

  // Also load options.edgeBufferTiles rings of tiles beyond the viewport, so a short drag lands on
  // tiles that are already there instead of black squares.
  _getTiledPixelBounds(center) {
    const b = super._getTiledPixelBounds(center);
    const pad = (this.options.edgeBufferTiles || 0) * TILE;
    return pad ? L.bounds(b.min.subtract([pad, pad]), b.max.add([pad, pad])) : b;
  }

  createTile(coords, done) {
    const wrap = document.createElement('div');
    wrap.className = 'tile-wrap';
    const z = Math.min(coords.z, MAX_ZOOM);
    // a layer that only exists from some zoom up (the vegetation overlay) stays empty below it
    if (z < (this.options.minNative || 0)) { setTimeout(() => done(null, wrap), 0); return wrap; }
    // above native zoom Leaflet asks for native tiles scaled, via the coordinate math below
    const scaleUp = Math.pow(2, coords.z - z);
    const nx = Math.floor(coords.x / scaleUp), ny = Math.floor(coords.y / scaleUp);
    wrap.dataset.key = `${z}/${nx}/${ny}`;
    this.load(wrap, z, nx, ny, coords, scaleUp, 0, done);
    return wrap;
  }

  load(wrap, z, x, y, coords, scaleUp, level, done, bust) {
    const az = z - level;
    if (az < (this.options.minNative || 0)) { if (done) done(null, wrap); return; }
    const ax = Math.floor(x / Math.pow(2, level)), ay = Math.floor(y / Math.pow(2, level));
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      // the ancestor covers 2^level tiles per side at zoom z; and coords.z may be above native
      const f = Math.pow(2, level) * scaleUp;
      const size = TILE * f;
      img.style.width = size + 'px';
      img.style.height = size + 'px';
      const offX = ((coords.x % f) + f) % f, offY = ((coords.y % f) + f) % f;
      img.style.left = -(offX * TILE) + 'px';
      img.style.top = -(offY * TILE) + 'px';
      wrap.replaceChildren(img);
      wrap.dataset.level = level;
      if (done) { done(null, wrap); done = null; }
    };
    img.onerror = () => {
      if (level === 0) this.pending.add(`${z}/${x}/${y}`);
      if (level < MAX_FALLBACK) this.load(wrap, z, x, y, coords, scaleUp, level + 1, done);
      else if (done) { done(null, wrap); done = null; }
    };
    img.src = this.url(az, ax, ay, bust);
  }

  // Server pushed "these tiles changed": refresh matching tiles that are on screen,
  // and any tile currently showing a fallback whose real tile is one of them.
  onRendered(keys) {
    if (!keys || !this._tiles) return;
    const set = new Set(keys);
    const bust = Date.now();
    for (const id in this._tiles) {
      const t = this._tiles[id];
      const wrap = t.el;
      if (!wrap || !wrap.dataset) continue;
      const key = wrap.dataset.key;
      const level = +(wrap.dataset.level || 0);
      let hit = set.has(key);
      if (!hit && level > 0) {
        // showing an ancestor: does any rendered key sit on the path down to us?
        const [z, x, y] = key.split('/').map(Number);
        for (let l = 0; l <= level && !hit; l++) hit = set.has(`${z - l}/${x >> l}/${y >> l}`);
      }
      if (hit) {
        const [z, x, y] = key.split('/').map(Number);
        const coords = t.coords;
        const scaleUp = Math.pow(2, coords.z - z);
        this.pending.delete(key);
        this.load(wrap, z, x, y, coords, scaleUp, 0, null, bust);
      }
    }
  }
}

// Blurry whole-world base under the map, like the old single-image WebMap: the zoom-BASE_ZOOM
// tiles are stitched into ONE picture once, shortly after load, and laid under the tile layers.
// Panning anywhere then shows the land straight away while the sharp tiles load on top, and one
// picture is cheap to scale while zooming (a tiled underlay redraws dozens of stretched squares).
const BASE_ZOOM = 3;
export class BaseWorldImage {
  constructor(map, template) {
    this.map = map;
    this.template = template;
    map.createPane('basePane').style.zIndex = 150;   // under tilePane (200)
    setTimeout(() => this.build(), 1500);
  }

  async build() {
    const span = TILE * Math.pow(2, MAX_ZOOM - BASE_ZOOM);   // metres per base tile
    const n = Math.ceil((2 * WORLD_HALF) / span);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = n * TILE;
    const ctx = canvas.getContext('2d');
    const jobs = [];
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const url = this.template.replace('{z}', BASE_ZOOM).replace('{x}', x).replace('{y}', y);
        jobs.push(fetch(url, { priority: 'low' }).then((r) => (r.ok ? r.blob() : null)).then((b) => (b ? createImageBitmap(b) : null))
          .then((img) => { if (img) ctx.drawImage(img, x * TILE, y * TILE); }).catch(() => {}));
      }
    await Promise.all(jobs);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) return;
    this.overlay = L.imageOverlay(URL.createObjectURL(blob), worldBounds, { pane: 'basePane', interactive: false, className: 'base-world' }).addTo(this.map);
  }
}
