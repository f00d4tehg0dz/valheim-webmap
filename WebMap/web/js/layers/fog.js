// Fog of war: the server's explored mask drawn as a dark veil over
// everything nobody has walked to yet, softened at the edges.

import { loadImage } from '../net.js';

export class FogLayer {
  constructor(map, cfg) {
    this.map = map;
    this.size = cfg.texture_size || 2048;
    this.px = cfg.pixel_size || 12;
    const half = this.size / 2;
    // the mask's pixel (i, j) is centred on world ((i - half) * px, (j - half) * px)
    const w = -(half + 0.5) * this.px, e = (half - 0.5) * this.px;
    this.bounds = L.latLngBounds([w, w], [e, e]);
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.size; this.canvas.height = this.size;
    this.src = document.createElement('canvas');
    this.src.width = this.size; this.src.height = this.size;
    this.opacity = 1;   // unexplored ground is black until someone walks there
    this.visible = true;
    const black = document.createElement('canvas');
    black.width = black.height = 1;
    black.getContext('2d').fillRect(0, 0, 1, 1);
    this.overlay = L.imageOverlay(black.toDataURL(), this.bounds, { opacity: this.opacity, className: 'fog-layer', zIndex: 300, interactive: false }).addTo(this.map);
    this.timer = null;
    this.exploredPct = 0;
  }

  async refresh() {
    try {
      const img = await loadImage(`data/fog.png?t=${Date.now()}`);
      const sctx = this.src.getContext('2d', { willReadFrequently: true });
      sctx.drawImage(img, 0, 0, this.size, this.size);
      const id = sctx.getImageData(0, 0, this.size, this.size);
      const d = id.data;
      let explored = 0;
      for (let i = 0; i < d.length; i += 4) {
        const e = d[i] > 127;
        if (e) explored++;
        d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = e ? 0 : 255;
      }
      this.exploredPct = 100 * explored / (Math.PI * Math.pow(10000 / this.px, 2));
      sctx.putImageData(id, 0, 0);
      const ctx = this.canvas.getContext('2d');
      ctx.clearRect(0, 0, this.size, this.size);
      ctx.filter = 'blur(1.2px)';
      ctx.drawImage(this.src, 0, 0);
      ctx.filter = 'none';
      const url = this.canvas.toDataURL('image/png');
      if (!this.overlay) {
        this.overlay = L.imageOverlay(url, this.bounds, { opacity: this.opacity, className: 'fog-layer', zIndex: 300, interactive: false });
        if (this.visible) this.overlay.addTo(this.map);
      } else {
        this.overlay.setUrl(url);
      }
    } catch (e) {
      console.warn('fog', e);
    }
  }

  start(intervalMs = 20000) {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), intervalMs);
  }

  setVisible(v) {
    this.visible = v;
    if (!this.overlay) return;
    if (v) this.overlay.addTo(this.map); else this.overlay.remove();
  }

  setOpacity(o) {
    this.opacity = o;
    if (this.overlay) this.overlay.setOpacity(o);
  }

  // is a world position explored? (from the last fetched mask)
  isExplored(x, z) {
    const half = this.size / 2;
    const i = Math.round(x / this.px + half), j = Math.round(z / this.px + half);
    if (i < 0 || j < 0 || i >= this.size || j >= this.size) return false;
    const ctx = this.src.getContext('2d', { willReadFrequently: true });
    // src rows run north (top) to south, mask row j is south-based
    const p = ctx.getImageData(i, this.size - 1 - j, 1, 1).data;
    return p[3] === 0;
  }
}
