// Marker sets (locations, portals, tombstones, vehicles, custom) and chat
// pins, each as a toggleable Leaflet layer group. Portals sharing a tag are
// joined by a dashed line.

import { toLatLng, fromLatLng } from '../crs.js';
import { markers as store } from '../data.js';
import { iconSvg, colors } from '../icons.js';
import { getJSON, on } from '../net.js';

export const LOCATION_CATS = ['spawn', 'boss', 'trader', 'dungeon', 'camp', 'village', 'ruin', 'runestone', 'poi'];

export function makeIcon(name, color, label, cls = 'mk') {
  return L.divIcon({
    className: '',
    html: `<div class="${cls}">${iconSvg(name, color)}${label ? `<div class="lbl">${escape(label)}</div>` : ''}</div>`,
    iconSize: cls === 'mk-pin' ? [18, 18] : [26, 26],
    iconAnchor: cls === 'mk-pin' ? [9, 18] : [13, 13],
    tooltipAnchor: [0, -12],
  });
}

// this browser's id: made up once, kept; the server keys web pins by it so only this browser can remove them
export function clientId() {
  let id = null;
  try { id = localStorage.getItem('webmap-client'); } catch (e) { /* storage blocked */ }
  if (!id) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
    try { localStorage.setItem('webmap-client', id); } catch (e) { /* fine, this visit only */ }
  }
  return id;
}

export const PIN_TYPES = ['dot', 'fire', 'mine', 'house', 'cave'];

export function escape(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

export class MarkerLayers {
  constructor(map) {
    this.map = map;
    this.groups = new Map();      // set id -> L.layerGroup
    this.visible = new Map();     // set id -> bool
    this.catVisible = new Map(LOCATION_CATS.map((c) => [c, c !== 'poi']));
    this.sets = [];
    this.pins = new Map();        // pin id -> marker
    this.pinGroup = L.layerGroup().addTo(map);
    this.portalLines = L.layerGroup().addTo(map);
    this.listeners = new Set();
    store.onChange((sets) => this.render(sets));
    on('pin', (f) => this.addPin(f));
    on('rmpin', (f) => this.removePin(f.id));
    this.loadPins();
  }

  onChange(fn) { this.listeners.add(fn); }
  onPins(fn) { (this.pinListeners ??= new Set()).add(fn); }
  pinList() { return [...this.pins.values()].map((mk) => mk.data); }
  emitPins() { for (const fn of this.pinListeners || []) fn(this.pinList()); }

  render(sets) {
    this.sets = sets;
    for (const g of this.groups.values()) g.remove();
    this.groups.clear();
    this.portalLines.clearLayers();
    const byTag = new Map();
    for (const set of sets) {
      const g = L.layerGroup();
      for (const m of set.markers || []) {
        const cat = m.cat || 'custom';
        if (set.id === 'locations' && this.catVisible.get(cat) === false) continue;
        const color = colors[m.icon] || colors[cat] || '#9aa5b5';
        const mk = L.marker(toLatLng(m.x, m.z), { icon: makeIcon(m.icon || cat, color, m.label), riseOnHover: true, keyboard: false });
        mk.bindPopup(popupHtml(m, set));
        mk.data = m;
        g.addLayer(mk);
        if (cat === 'portal' && m.tag) {
          if (!byTag.has(m.tag)) byTag.set(m.tag, []);
          byTag.get(m.tag).push(m);
        }
      }
      this.groups.set(set.id, g);
      if (this.visible.get(set.id) !== false) g.addTo(this.map);
    }
    for (const [tag, list] of byTag) {
      if (list.length < 2) continue;
      for (let i = 1; i < list.length; i++)
        this.portalLines.addLayer(L.polyline([toLatLng(list[0].x, list[0].z), toLatLng(list[i].x, list[i].z)],
          { color: colors.portal, weight: 1.5, dashArray: '4 6', opacity: 0.6, interactive: false }));
    }
    if (this.visible.get('portals') === false) this.portalLines.remove();
    for (const fn of this.listeners) fn(sets);
  }

  setVisible(id, v) {
    this.visible.set(id, v);
    const g = this.groups.get(id);
    if (g) { if (v) g.addTo(this.map); else g.remove(); }
    if (id === 'portals') { if (v) this.portalLines.addTo(this.map); else this.portalLines.remove(); }
    if (id === 'pins') { if (v) this.pinGroup.addTo(this.map); else this.pinGroup.remove(); }
  }

  setCategory(cat, v) { this.catVisible.set(cat, v); this.render(this.sets); }

  // Every marker with a position, for search.
  all() {
    const out = [];
    for (const set of this.sets) for (const m of set.markers || []) out.push({ kind: set.label, label: m.label, x: m.x, z: m.z, icon: m.icon || m.cat });
    for (const [, mk] of this.pins) out.push({ kind: 'Pin', label: mk.data.text || mk.data.name, x: mk.data.x, z: mk.data.z, icon: mk.data.type });
    return out;
  }

  async loadPins() {
    try {
      const pins = await getJSON('data/pins.json');
      for (const p of pins) this.addPin(p);
    } catch (e) { console.warn('pins', e); }
  }

  addPin(p) {
    if (this.pins.has(p.id)) this.removePin(p.id);
    const icon = ['dot', 'fire', 'mine', 'house', 'cave'].includes(p.type) ? p.type : 'pin';
    const mk = L.marker(toLatLng(p.x, p.z), { icon: makeIcon(icon, colors[icon], p.text, 'mk-pin'), keyboard: false });
    mk.data = p;
    const mine = p.owner === 'web:' + clientId();
    mk.bindPopup(() => {
      const el = document.createElement('div');
      el.innerHTML = `<b>${escape(p.text || 'Pin')}</b><small>by ${escape(p.name)} · ${p.x}, ${p.z}</small>` +
        (mine ? `<div class="pin-actions"><button class="btn small" type="button">Remove pin</button></div>` : '');
      el.querySelector('button')?.addEventListener('click', async () => {
        try { await fetch('api/unpin?id=' + encodeURIComponent(p.id), { method: 'POST', headers: { 'X-WebMap-Client': clientId() } }); } catch (e) { console.warn('unpin', e); }
        this.map.closePopup();
      });
      return el;
    });
    this.pins.set(p.id, mk);
    this.pinGroup.addLayer(mk);
    this.emitPins();
  }

  removePin(id) {
    const mk = this.pins.get(id);
    if (mk) { this.pinGroup.removeLayer(mk); this.pins.delete(id); this.emitPins(); }
  }

  // right click / long press on the map: a small form, then POST /api/pin
  openPinEditor(latlng) {
    const { x, z } = fromLatLng(latlng);
    let name = '';
    try { name = localStorage.getItem('webmap-pin-name') || ''; } catch (e) { /* no storage */ }
    const el = document.createElement('form');
    el.className = 'pin-form';
    el.innerHTML = `<b>New pin</b><small>${Math.round(x)}, ${Math.round(z)}</small>
      <div class="row"><select name="type">${PIN_TYPES.map((t) => `<option value="${t}">${t}</option>`).join('')}</select>
      <input name="text" maxlength="20" placeholder="Label (letters, numbers)" autocomplete="off"></div>
      <div class="row"><input name="name" maxlength="16" placeholder="Your name" value="${escape(name)}" autocomplete="off"><button class="btn small" type="submit">Add pin</button></div>
      <small class="err" hidden></small>`;
    const popup = L.popup({ closeButton: true, autoPan: true, className: 'pin-form-popup' }).setLatLng(latlng).setContent(el).openOn(this.map);
    setTimeout(() => el.querySelector('[name=text]').focus(), 50);
    el.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fd = new FormData(el);
      const who = String(fd.get('name') || '').trim();
      try { localStorage.setItem('webmap-pin-name', who); } catch (e) { /* no storage */ }
      const err = el.querySelector('.err');
      try {
        const r = await fetch('api/pin', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WebMap-Client': clientId() },
          body: JSON.stringify({ x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10, type: fd.get('type'), text: fd.get('text'), name: who, client: clientId() }) });
        if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || r.status); }
        this.map.closePopup(popup);
      } catch (e) { err.textContent = 'Could not add pin: ' + e.message; err.hidden = false; }
    });
  }
}

function popupHtml(m, set) {
  let extra = '';
  if (m.cat === 'portal') extra = `<small>Portal tag: ${escape(m.tag || '(none)')}</small>`;
  else if (m.cat === 'base') extra = `<small>${m.pieces} pieces</small>`;
  else if (m.cat === 'tombstone') extra = `<small>${m.when ? new Date(m.when / 10000 - 62135596800000).toLocaleString() : ''}</small>`;
  else if (m.prefab) extra = `<small>${escape(m.prefab)}${m.placed === false ? ' · not yet generated' : ''}</small>`;
  else if (m.description) extra = `<small>${escape(m.description)}</small>`;
  return `<b>${escape(m.label)}</b><small>${escape(set.label)} · ${m.x}, ${m.z}</small>${extra ? '<br>' + extra : ''}`;
}
