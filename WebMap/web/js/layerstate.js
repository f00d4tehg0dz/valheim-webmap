// The layer toggles from the sidebar, shared by the 2D map and the 3D view so
// one set of checkboxes drives both. The UI writes here; each view subscribes.

export const layerState = {
  fog: true, fogOpacity: 1,     // fog of war is always on, fully black over unexplored ground
  buildings: true, buildingsOpacity: 1,
  players: true, pins: true, labels: true, grid: false,
  veg: true,            // the 2D tree/rock overlay (the 3D view has its own object chips)
  time3d: 'live',       // 3D lighting: 'live' follows the server's clock, or noon/morning/evening/night
  shadows: !matchMedia('(max-width: 720px)').matches,   // real shadows in 3D (off on phones by default)
  sets: new Map(),      // marker set id -> bool (missing = visible)
  cats: new Map(),      // location category -> bool (missing = visible)
  listeners: new Set(),
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  set(key, value) { this[key] = value; this.emit(key); },
  setSet(id, v) { this.sets.set(id, v); this.emit('sets'); },
  setCat(cat, v) { this.cats.set(cat, v); this.emit('cats'); },
  setVisible(id) { return this.sets.get(id) !== false; },
  catVisible(cat) { return this.cats.get(cat) !== false; },
  emit(key) { for (const fn of this.listeners) fn(key, this); },
};
