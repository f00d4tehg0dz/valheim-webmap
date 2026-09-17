// Live players: an arrow that points where they are facing, name, health
// bar, follow mode, and map pings.

import { toLatLng } from '../crs.js';
import { iconSvg } from '../icons.js';
import { escape } from './markers.js';
import { on } from '../net.js';

const PALETTE = ['#6fb7ff', '#f2c14e', '#58c27d', '#ff8fa3', '#c9a5ff', '#ffb04d', '#5ce0e6', '#e0e0e0'];

export class PlayersLayer {
  constructor(map) {
    this.map = map;
    this.group = L.layerGroup().addTo(map);
    this.markers = new Map();     // id -> marker
    this.players = [];
    this.following = null;        // player id
    this.listeners = new Set();
    this.colorOf = new Map();
    on('players', (f) => this.update(f.data));
    on('ping', (f) => this.ping(f));
  }

  onChange(fn) { this.listeners.add(fn); }

  color(name) {
    if (!this.colorOf.has(name)) this.colorOf.set(name, PALETTE[this.colorOf.size % PALETTE.length]);
    return this.colorOf.get(name);
  }

  update(data) {
    this.players = data.players || [];
    const seen = new Set();
    for (const p of this.players) {
      seen.add(p.id);
      if (p.x === undefined) { this.remove(p.id); continue; }
      const ll = toLatLng(p.x, p.z);
      let mk = this.markers.get(p.id);
      if (!mk) {
        mk = L.marker(ll, { icon: this.icon(p), zIndexOffset: 1000, keyboard: false });
        mk.bindTooltip('', { direction: 'top', offset: [0, -14] });
        mk.on('click', (e) => { const q = this.players.find((r) => r.id === p.id) || p; const oe = e.originalEvent; if (this.onClick) this.onClick(q, oe ? oe.clientX : 0, oe ? oe.clientY : 0); });
        this.markers.set(p.id, mk);
        this.group.addLayer(mk);
      } else {
        mk.setLatLng(ll);
        mk.setIcon(this.icon(p));
      }
      mk.setTooltipContent(`<b>${escape(p.name)}</b><br>${p.health}/${p.maxHealth} hp · ${escape(p.biome || '')}<br>${p.x}, ${p.z}${p.dead ? ' · dead' : ''}${p.pvp ? ' · PvP' : ''}${p.inBed ? ' · sleeping' : ''}`);
      if (this.following === p.id) this.map.panTo(ll, { animate: true, duration: 0.5, noMoveStart: true });
    }
    for (const id of [...this.markers.keys()]) if (!seen.has(id)) this.remove(id);
    if (this.following && !seen.has(this.following)) this.follow(null);
    for (const fn of this.listeners) fn(this.players);
  }

  remove(id) {
    const mk = this.markers.get(id);
    if (mk) { this.group.removeLayer(mk); this.markers.delete(id); }
  }

  icon(p) {
    const col = this.color(p.name);
    const hp = p.maxHealth > 0 ? Math.max(0, Math.min(1, p.health / p.maxHealth)) : 1;
    return L.divIcon({
      className: '',
      html: `<div class="mk mk-player${p.dead ? ' dead' : ''}${this.following === p.id ? ' following' : ''}">
        <div class="arrow" style="transform:rotate(${Math.round(p.yaw || 0)}deg)">${iconSvg('player', col)}</div>
        <div class="lbl">${escape(p.name)}</div>
        <div class="hp"><i class="${hp < 0.3 ? 'low' : ''}" style="width:${Math.round(hp * 100)}%"></i></div></div>`,
      iconSize: [30, 30], iconAnchor: [15, 15],
    });
  }

  follow(id) {
    this.following = id;
    if (this.onFollow) this.onFollow(id);
    for (const p of this.players) { const mk = this.markers.get(p.id); if (mk) mk.setIcon(this.icon(p)); }
    const p = this.players.find((q) => q.id === id);
    if (p && p.x !== undefined) this.map.setView(toLatLng(p.x, p.z), Math.max(this.map.getZoom(), 6));
    for (const fn of this.listeners) fn(this.players);
  }

  ping(f) {
    const ll = toLatLng(f.x, f.z);
    const mk = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="ping"></div>', iconSize: [40, 40], iconAnchor: [20, 20] }), interactive: false, zIndexOffset: 2000 });
    mk.addTo(this.map);
    const lbl = L.tooltip({ permanent: true, direction: 'top', offset: [0, -20], className: 'ping-label' }).setContent(`${escape(f.name)} pinged`).setLatLng(ll).addTo(this.map);
    setTimeout(() => { mk.remove(); lbl.remove(); }, 8000);
  }

  setVisible(v) { if (v) this.group.addTo(this.map); else this.group.remove(); }
}
