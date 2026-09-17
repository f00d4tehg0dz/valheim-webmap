// The sidebar: layers, players, markers, stats, events.

import { escape } from './layers/markers.js';
import { iconSvg, colors, materialColors, materialNames } from './icons.js';
import { stats as statsStore, prefabs, objectFilter, OBJECT_CATS } from './data.js';
import { layerState } from './layerstate.js';
import { on } from './net.js';

const $ = (s, r = document) => r.querySelector(s);
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

export function fmtDuration(sec) {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
export function fmtDist(m) { return m >= 10000 ? `${Math.round(m / 1000)} km` : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`; }
export function fmtAgo(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
function fmtTime(iso) { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

export class Sidebar {
  constructor(app) {
    this.app = app;
    this.root = $('#sidebar');
    this.tabs = this.root.querySelectorAll('.tabs button[data-tab]');
    for (const b of this.tabs) b.addEventListener('click', () => this.show(b.dataset.tab));
    $('#btn-close-sidebar').addEventListener('click', () => app.toggleSidebar(false));
    this.eventFilters = new Set(['join', 'leave', 'death', 'chat', 'shout', 'server', 'ping', 'pin']);
    this.unread = 0;
    this.active = 'layers';
    this.buildLayers();
    this.buildEvents();
    on('events', (f) => this.addEvents(f.data, f.initial));
    statsStore.onChange((d) => this.renderStats(d));
  }

  show(tab) {
    this.active = tab;
    for (const b of this.tabs) b.classList.toggle('active', b.dataset.tab === tab);
    for (const p of this.root.querySelectorAll('.panel')) p.classList.toggle('active', p.dataset.panel === tab);
    if (tab === 'events') { this.unread = 0; this.badge(); }
    if (tab === 'stats') statsStore.refresh();
    this.app.toggleSidebar(true);
  }

  badge() {
    const b = $('#events-badge');
    b.hidden = this.unread === 0;
    b.textContent = this.unread > 99 ? '99+' : this.unread;
  }

  // ---------------------------------------------------------------- layers
  buildLayers() {
    const p = $('#panel-layers');
    const L = this.app.layers;
    const row = (label, checked, onToggle, extra = '') => {
      const r = el(`<label class="row"><input type="checkbox" ${checked ? 'checked' : ''}><span class="grow name">${label}</span>${extra}</label>`);
      r.querySelector('input[type=checkbox]').addEventListener('change', (e) => onToggle(e.target.checked));
      return r;
    };
    const slider = (value, onInput) => {
      const s = el(`<input type="range" min="0" max="100" value="${Math.round(value * 100)}" title="Opacity">`);
      s.addEventListener('input', () => onInput(s.value / 100));
      s.addEventListener('click', (e) => e.preventDefault());
      return s;
    };
    p.append(el('<h3>Map</h3>'));
    // every toggle drives the 2D layer directly and records itself in layerState, which the 3D view follows
    const S = layerState;
    const stRow = row('Buildings', S.buildings, (v) => { if (v) L.structures.addTo(this.app.map); else L.structures.remove(); S.set('buildings', v); });
    stRow.append(slider(L.structures.opacity, (v) => { L.structures.setOpacity(v); S.set('buildingsOpacity', v); }));
    p.append(stRow);
    p.append(row('Players', S.players, (v) => { L.players.setVisible(v); S.set('players', v); }));
    p.append(row('Pins', S.pins, (v) => { L.markers.setVisible('pins', v); S.set('pins', v); }));
    p.append(row('Marker labels', S.labels, (v) => { document.body.classList.toggle('no-labels', !v); S.set('labels', v); }));
    p.append(row('Grid (256 m, 2D)', S.grid, (v) => { this.app.setGrid(v); S.set('grid', v); }));
    p.append(row('Trees & rocks (2D)', S.veg, (v) => { if (v) L.veg.addTo(this.app.map); else L.veg.remove(); S.set('veg', v); }));

    p.append(el('<h3>3D objects</h3>'));
    const objs = el('<div class="filters"></div>');
    for (const [cat, label] of OBJECT_CATS) {
      const on = objectFilter.shows(cat);
      const lab = el(`<label class="${on ? '' : 'off'}"><input type="checkbox" ${on ? 'checked' : ''}> ${label}</label>`);
      lab.querySelector('input').addEventListener('change', (e) => { lab.classList.toggle('off', !e.target.checked); objectFilter.set(cat, e.target.checked); });
      objs.append(lab);
    }
    p.append(objs);

    p.append(el('<h3>Lighting (3D)</h3>'));
    const light = el(`<div class="row"><span class="grow name">Time of day</span><select class="sel" id="time3d">
      <option value="live">Live, like in game</option><option value="morning">Morning</option><option value="noon">Noon</option><option value="evening">Evening</option><option value="night">Night</option></select></div>`);
    const sel = light.querySelector('select'); sel.value = S.time3d;
    sel.addEventListener('change', () => S.set('time3d', sel.value));
    p.append(light);
    p.append(row('Shadows', S.shadows, (v) => S.set('shadows', v)));

    p.append(el('<h3>Markers</h3>'));
    this.markerSetRows = el('<div></div>');
    p.append(this.markerSetRows);
    p.append(el('<h3>Building materials</h3>'));
    const legend = el('<div class="legend"></div>');
    materialNames.forEach((n, i) => legend.append(el(`<span><i style="background:${materialColors[i]}"></i>${n}</span>`)));
    p.append(legend);

    L.markers.onChange((sets) => {
      this.markerSetRows.replaceChildren();
      for (const s of sets) {
        const n = (s.markers || []).length;
        this.markerSetRows.append(row(`${escape(s.label)} <span class="meta">${n}</span>`, L.markers.visible.get(s.id) !== false, (v) => { L.markers.setVisible(s.id, v); S.setSet(s.id, v); }));
      }
      this.renderMarkers(sets);
    });
  }

  // ---------------------------------------------------------------- players
  renderPlayers(players) {
    const p = $('#panel-players');
    p.replaceChildren(el(`<h3>Online <span class="count">${players.length}</span></h3>`));
    if (players.length === 0) { p.append(el('<div class="empty">Nobody is online right now.</div>')); }
    const PL = this.app.layers.players;
    for (const pl of players) {
      const hp = pl.maxHealth ? Math.round(100 * pl.health / pl.maxHealth) : 100;
      const r = el(`<div class="row clickable ${PL.following === pl.id ? 'on' : ''}">
        <span class="ico" style="color:${PL.color(pl.name)}">${iconSvg('player', PL.color(pl.name))}</span>
        <div class="grow"><div class="name">${escape(pl.name)} ${pl.dead ? '💀' : ''}${pl.inBed ? ' 💤' : ''}${pl.pvp ? ' ⚔️' : ''}</div>
          <div class="meta">${pl.x !== undefined ? `${escape(pl.biome || '')} · ${pl.x}, ${pl.z}` : 'position hidden'}</div>
          <div class="hp"><i class="${hp < 30 ? 'low' : ''}" style="width:${hp}%"></i></div></div>
        <button class="btn small ${PL.following === pl.id ? 'on' : ''}" ${pl.x === undefined ? 'disabled' : ''}>${PL.following === pl.id ? 'Unfollow' : 'Follow'}</button></div>`);
      r.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); PL.follow(PL.following === pl.id ? null : pl.id); });
      r.addEventListener('click', (e) => { const rect = r.getBoundingClientRect(); this.app.playerCard.show(pl, rect.right, rect.top + rect.height / 2); });
      p.append(r);
    }
    $('#online-pill').textContent = `${players.length} online`;
    $('#online-pill').classList.toggle('on', players.length > 0);
  }

  // ---------------------------------------------------------------- markers
  renderMarkers(sets) {
    const p = $('#panel-markers');
    p.replaceChildren();
    for (const s of sets) {
      const ms = (s.markers || []).slice().sort((a, b) => (a.label || '').localeCompare(b.label || ''));
      const h = el(`<h3>${escape(s.label)} <span class="count">${ms.length}</span></h3>`);
      p.append(h);
      if (ms.length === 0) { p.append(el('<div class="empty">Nothing found yet.</div>')); continue; }
      const list = el('<div></div>');
      const max = 200;
      ms.slice(0, max).forEach((m) => {
        const r = el(`<div class="row clickable"><span class="ico">${iconSvg(m.icon || m.cat, colors[m.icon] || colors[m.cat])}</span>
          <div class="grow"><div class="name">${escape(m.label)}</div><div class="meta">${m.x}, ${m.z}${m.cat && m.cat !== m.label ? ' · ' + escape(m.cat) : ''}</div></div></div>`);
        r.addEventListener('click', () => this.app.goTo(m.x, m.z, Math.max(this.app.map.getZoom(), 6)));
        list.append(r);
      });
      if (ms.length > max) list.append(el(`<div class="empty">…and ${ms.length - max} more (use search)</div>`));
      p.append(list);
    }
  }

  // ---------------------------------------------------------------- stats
  renderStats(d) {
    const p = $('#panel-stats');
    if (!d || !d.server) { p.replaceChildren(el('<div class="empty">No stats yet.</div>')); return; }
    const s = d.server;
    const tiles = s.tiles || {};
    p.replaceChildren();
    p.append(el('<h3>World</h3>'));
    p.append(el(`<div class="stat-tiles">
      <div class="stat-tile"><b>${s.day ?? '–'}</b><span>day${s.night ? ' · night' : ''}</span></div>
      <div class="stat-tile"><b>${(s.exploredPercent ?? 0).toFixed(1)}%</b><span>explored</span></div>
      <div class="stat-tile"><b>${(s.structures ?? 0).toLocaleString()}</b><span>pieces built</span></div>
      <div class="stat-tile"><b>${(s.trees ?? 0).toLocaleString()}</b><span>trees standing</span></div>
      <div class="stat-tile"><b>${(s.terraformedZones ?? 0).toLocaleString()}</b><span>terraformed zones</span></div>
      <div class="stat-tile"><b>${(s.objects ?? 0).toLocaleString()}</b><span>world objects</span></div>
    </div>`));
    p.append(el('<h3>Players online, last 24 h</h3>'));
    p.append(sparkline(d.onlineHistory || []));
    p.append(el('<h3>Players</h3>'));
    const rows = (d.players || []).map((pl) => `<tr class="${pl.online ? 'on' : ''}" data-x="${pl.lastX ?? ''}" data-z="${pl.lastZ ?? ''}">
      <td>${escape(pl.name)}</td><td class="num">${fmtDuration(pl.playtime)}</td><td class="num">${pl.deaths}</td>
      <td class="num">${fmtDist(pl.distance)}</td><td class="num">${pl.sessions}</td><td class="num" title="${escape(pl.lastSeen)}">${pl.online ? 'now' : fmtAgo(pl.lastSeen).replace(' ago', '').replace('just now', 'now')}</td></tr>`).join('');
    const table = el(`<div style="overflow:auto"><table class="stats"><thead><tr><th>Name</th><th class="num" title="Play time">Played</th><th class="num" title="Deaths">Died</th><th class="num" title="Distance walked">Walked</th><th class="num" title="Sessions">Visits</th><th class="num" title="Last seen">Seen</th></tr></thead><tbody>${rows}</tbody></table></div>`);
    for (const tr of table.querySelectorAll('tbody tr')) {
      if (tr.dataset.x) { tr.style.cursor = 'pointer'; tr.addEventListener('click', () => this.app.goTo(+tr.dataset.x, +tr.dataset.z, 6)); }
    }
    p.append(table);
    p.append(el('<h3>Server</h3>'));
    p.append(el(`<dl class="kv">
      <dt>Up since</dt><dd>${s.startedUtc ? new Date(s.startedUtc).toLocaleString() : '–'}</dd>
      <dt>Last world sweep</dt><dd>${s.lastSweepUtc ? fmtAgo(s.lastSweepUtc) + ` (${(s.lastSweepSeconds || 0).toFixed(1)} s)` : 'pending'}</dd>
      <dt>Map tiles rendered</dt><dd>${tiles.onDisk ?? 0}${tiles.queued ? ` (+${tiles.queued} queued)` : ''}</dd>
      <dt>Render time / tile</dt><dd>${tiles.avgMs ? tiles.avgMs.toFixed(0) + ' ms' : '–'}${tiles.mainThreadSampling ? ' · main-thread' : ''}</dd>
      <dt>Max detail</dt><dd>${Math.pow(2, 7 - (tiles.maxRenderZoom ?? 7))} m / px</dd>
      <dt>3D models</dt><dd>${prefabs.stats.exported ?? 0} prefabs${prefabs.stats.unreadable ? ` (${prefabs.stats.unreadable} unreadable)` : ''}${prefabs.stats.queued ? ` +${prefabs.stats.queued} queued` : ''}</dd>
      <dt>WebMap</dt><dd>${escape(this.app.config?.version || '')}</dd>
    </dl>`));
  }

  // ---------------------------------------------------------------- events
  buildEvents() {
    const p = $('#panel-events');
    const filters = el('<div class="filters"></div>');
    for (const t of ['join', 'leave', 'death', 'chat', 'shout', 'server', 'ping', 'pin']) {
      const lab = el(`<label><input type="checkbox" checked>${t}</label>`);
      lab.querySelector('input').addEventListener('change', (e) => {
        lab.classList.toggle('off', !e.target.checked);
        if (e.target.checked) this.eventFilters.add(t); else this.eventFilters.delete(t);
        this.applyEventFilter();
      });
      filters.append(lab);
    }
    p.append(filters);
    this.eventList = el('<div id="event-list"></div>');
    p.append(this.eventList);
  }

  applyEventFilter() {
    for (const e of this.eventList.children) e.hidden = !this.eventFilters.has(e.dataset.type);
  }

  addEvents(list, initial) {
    if (!list) return;
    for (const e of list) {
      const row = el(`<div class="event${e.x !== undefined ? ' clickable' : ''}" data-type="${escape(e.type)}"><time>${fmtTime(e.ts)}</time><div class="t"><b>${escape(e.name)}</b> <span class="msg">${escape(e.text)}</span></div></div>`);
      if (e.x !== undefined) row.addEventListener('click', () => this.app.goTo(e.x, e.z, 6));
      row.hidden = !this.eventFilters.has(e.type);
      this.eventList.prepend(row);
      if (!initial && this.active !== 'events') this.unread++;
    }
    while (this.eventList.children.length > 300) this.eventList.lastElementChild.remove();
    this.badge();
    if (!initial) for (const e of list) if (e.type === 'death' || e.type === 'join' || e.type === 'leave' || e.type === 'server') this.app.toast(`${e.name} ${e.text}`);
  }
}

function sparkline(hist) {
  const w = 300, h = 44, pad = 2;
  if (!hist.length) return el('<div class="empty">No history yet.</div>');
  const max = Math.max(1, ...hist.map((p) => p[1]));
  const t0 = hist[0][0], t1 = hist[hist.length - 1][0] || t0 + 1;
  const pts = hist.map(([t, n]) => [pad + (w - 2 * pad) * (t - t0) / Math.max(1, t1 - t0), h - pad - (h - 2 * pad) * n / max]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = line + ` L${pts[pts.length - 1][0].toFixed(1)} ${h - pad} L${pts[0][0].toFixed(1)} ${h - pad} Z`;
  return el(`<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><line class="axis" x1="0" y1="${h - pad}" x2="${w}" y2="${h - pad}"/><path class="area" d="${area}"/><path d="${line}"/><title>peak ${max}</title></svg>`);
}
