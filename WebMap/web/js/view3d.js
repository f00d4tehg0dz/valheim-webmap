// The 3D view: terrain rebuilt from the server's height tiles and textured
// with the same map tiles the 2D view shows, player-built pieces as boxes in
// their material colours, trees and rocks as instanced shapes, live players
// and markers as labelled sprites. Loaded on demand the first time the 3D
// button is pressed.
//
// World -> scene: X = x, Y = height, Z = -z (Valheim's north is -Z here).
// Terrain is a quadtree of tiles: the finest zoom near the camera target,
// coarser rings further out, a coarse tile hidden once all four of its
// children are loaded.

import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { chunks, objects, prefabs, objectFilter, markers as markerStore, stats as statsStore } from './data.js';
import { Lighting } from './sky.js';
import { materialColors, colors as iconColors } from './icons.js';
import { layerState } from './layerstate.js';
import { WORLD_HALF, MAX_ZOOM, TILE, metersPerPixel, chunkOf } from './crs.js';

const RINGS = [                   // zoom -> load within this distance of the target (metres)
  { z: 7, dist: 640, segs: 128 },
  { z: 6, dist: 1600, segs: 64 },
  { z: 5, dist: 3600, segs: 64 },
  { z: 4, dist: 9000, segs: 32 },
];
const STRUCT_DIST = 900, VEG_DIST = 700, MARKER_DIST = 2500, OBJ_DIST = 850;

const VEG = {   // kind -> [crownRadius, height, color, shape]  (mirrors Palette.cs)
  1: [4.5, 12, '#568a3a', 'sphere'], 2: [3.0, 16, '#2c5234', 'cone'], 3: [3.0, 10, '#383e28', 'sphere'], 4: [4.0, 14, '#4a6870', 'sphere'],
  5: [2.5, 7, '#46382e', 'cone'], 6: [1.3, 1.5, '#466e32', 'sphere'], 7: [2.5, 3, '#767670', 'rock'], 8: [2.5, 3, '#86684a', 'rock'],
  9: [0.7, 0.6, '#60462c', 'stump'], 10: [1.0, 1.0, '#5a783c', 'sphere'], 11: [3.0, 9, '#3c2822', 'cone'],
};

export class View3D {
  constructor(canvas, config) {
    this.canvas = canvas;
    this.config = config || {};
    this.waterLevel = this.config.water_level ?? 30;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 1, 1, 30000);
    this.controls = new MapControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 15;
    this.controls.maxDistance = 7000;
    this.controls.screenSpacePanning = false;
    this.controls.addEventListener('change', () => this.scheduleUpdate());

    // sky dome, sun, moon, fog colour and an environment map, all from the game's time of day
    this.lighting = new Lighting(this.scene, this.renderer);
    this.lighting.setShadows(layerState.shadows);
    this.lastDayFraction = null;

    // fog of war is drawn by the ground itself: every terrain (and water) material is patched to
    // sample the explored mask in world space
    this.fogSize = config.texture_size || 2048; this.fogPx = config.pixel_size || 12;
    this.ground = {
      uFog: { value: null }, uFogOn: { value: layerState.fog ? 1 : 0 }, uFogOpacity: { value: layerState.fogOpacity },
      uFogScale: { value: new THREE.Vector2(1 / (this.fogSize * this.fogPx), 1 / (this.fogSize * this.fogPx)) },
      uFogOffset: { value: (this.fogSize / 2 + 0.5) / this.fogSize },
      uDetail: { value: this.detailTexture() },
    };
    // water: a big plane with a scrolling procedural normal map; the sky's environment map gives
    // it its reflections, so it goes gold at sunset and black at night like the sea does
    this.waterNormals = this.waterNormalTexture();
    const waterMat = this.groundMaterial({ color: 0x1b4668, transparent: true, opacity: 0.8, roughness: 0.12, metalness: 0.0, normalMap: this.waterNormals, normalScale: new THREE.Vector2(0.35, 0.35), envMapIntensity: 1.2 }, false);
    const water = new THREE.Mesh(new THREE.PlaneGeometry(26000, 26000), waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.y = this.waterLevel;
    water.receiveShadow = true;
    this.water = water;
    this.scene.add(water);

    this.terrain = new Map();     // key -> {mesh, ready, z, x, y, heights}
    this.structures = new Map();  // chunk key -> group   (fallback path: footprint boxes)
    this.veg = new Map();         // chunk key -> group   (fallback path: shapes)
    this.objChunks = new Map();   // chunk key -> group   (model path: every world object, real meshes)
    this.models = new Map();      // prefab hash -> Promise<parts[] | null>
    this.gltf = new GLTFLoader();
    this.markerSprites = new THREE.Group();
    this.scene.add(this.markerSprites);
    this.pinSprites = new THREE.Group();
    this.pinSprites.visible = layerState.pins;
    this.scene.add(this.pinSprites);
    this.playerGroup = new THREE.Group();
    this.playerGroup.visible = layerState.players;
    this.scene.add(this.playerGroup);
    this.pins = [];
    layerState.onChange((key) => this.applyLayerState(key));
    this.players = new Map();
    this.loader = new THREE.TextureLoader();
    this.running = false;
    this.updateTimer = null;
    this.maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    this.box = new THREE.BoxGeometry(1, 1, 1);
    this.geoms = {
      trunk: new THREE.CylinderGeometry(0.35, 0.5, 1, 6),
      sphere: new THREE.IcosahedronGeometry(1, 1),
      cone: new THREE.ConeGeometry(1, 1, 7),
      rock: new THREE.DodecahedronGeometry(1, 0),
      stump: new THREE.CylinderGeometry(1, 1.1, 1, 6),
    };
    this.matCache = new Map();
    chunks.onChange(() => { for (const k of this.structures.keys()) this.dropStructures(k); for (const k of this.veg.keys()) this.dropVeg(k); this.scheduleUpdate(); });
    objects.onChange(() => { for (const k of this.objChunks.keys()) this.dropObjects(k); this.scheduleUpdate(); });
    prefabs.onChange(() => { this.models.clear(); for (const k of this.objChunks.keys()) this.dropObjects(k); this.scheduleUpdate(); });
    objectFilter.onChange(() => { for (const k of this.objChunks.keys()) this.dropObjects(k); this.scheduleUpdate(); });
    markerStore.onChange(() => this.rebuildMarkers());
    window.addEventListener('resize', () => this.resize());
    // a click (not a drag) on a player's figure reports it
    this.raycaster = new THREE.Raycaster();
    let down = null;
    canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    canvas.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) { down = null; return; }
      down = null;
      if (!this.onPlayerClick || this.players.size === 0) return;
      const r = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.raycaster.setFromCamera(ndc, this.camera);
      const bodies = [];
      for (const [id, en] of this.players) for (const m of en.group.children) { m.userData.playerId = id; bodies.push(m); }   // figure and name label
      const hit = this.raycaster.intersectObjects(bodies, false)[0];
      if (hit) this.onPlayerClick(hit.object.userData.playerId, e.clientX, e.clientY);
    });
  }

  // ---------------------------------------------------------------- lifecycle
  show(x, z, zoom2d) {
    this.resize();
    const dist = Math.min(5000, Math.max(80, 3200 / Math.pow(2, (zoom2d ?? 4) - 3)));
    this.controls.target.set(x, this.heightAt(x, z) ?? this.waterLevel + 10, -z);
    this.camera.position.set(x + dist * 0.35, this.controls.target.y + dist * 0.75, -z + dist * 0.6);
    this.controls.update();
    this.running = true;
    this.rebuildMarkers();
    this.rebuildPins();
    this.refreshFog();
    clearInterval(this.fogTimer);
    this.fogTimer = setInterval(() => this.refreshFog(), 20000);
    this.update();
    this.loop();
  }

  hide() { this.running = false; clearInterval(this.fogTimer); }

  // ---------------------------------------------------------------- layer toggles (shared with the 2D map)
  applyLayerState(key) {
    const S = layerState;
    this.ground.uFogOn.value = S.fog ? 1 : 0;
    this.ground.uFogOpacity.value = S.fogOpacity;
    this.playerGroup.visible = S.players;
    this.pinSprites.visible = S.pins;
    if (key === 'buildings' || key === 'buildingsOpacity' || key === 'all') this.applyBuildings();
    if (key === 'shadows') this.lighting.setShadows(S.shadows);
    if (key === 'time3d') this.lastDayFraction = null;
    if (key === 'labels') { this.rebuildMarkers(); this.rebuildPins(); }
    if (key === 'sets' || key === 'cats') this.applyMarkerVisibility();
  }

  // buildings: player-built pieces in the model path, the footprint boxes in the fallback path
  applyBuildings() {
    const on = layerState.buildings, op = layerState.buildingsOpacity;
    const apply = (o) => {
      if (!o.isInstancedMesh || o.userData.cat !== 'piece') return;
      o.visible = on;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) { m.transparent = op < 0.999; m.opacity = op; m.depthWrite = op >= 0.5; m.needsUpdate = true; }
    };
    for (const g of this.objChunks.values()) g.traverse(apply);
    for (const g of this.structures.values()) g.traverse(apply);
  }

  applyMarkerVisibility() {
    const tx = this.controls.target.x, tz = -this.controls.target.z;
    for (const s of this.markerSprites.children) {
      const m = s.userData;
      s.visible = layerState.setVisible(m.set) && (m.set !== 'locations' || layerState.catVisible(m.cat || 'custom'))
        && Math.hypot(s.position.x - tx, -s.position.z - tz) <= MARKER_DIST;
    }
  }

  // The explored mask as a texture the ground shader darkens with (north = top row, like /data/fog.png).
  refreshFog() {
    this.loader.load(`data/fog.png?t=${Date.now()}`, (t) => {
      t.colorSpace = THREE.NoColorSpace; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      const old = this.ground.uFog.value;
      this.ground.uFog.value = t;
      if (old) old.dispose();
    });
  }

  // A MeshStandardMaterial that also darkens unexplored ground (fog of war), in world space.
  groundMaterial(params, detail = true) {
    const mat = new THREE.MeshStandardMaterial(params);
    const u = this.ground;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGroundPos;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGroundPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec3 vGroundPos;
uniform sampler2D uFog; uniform float uFogOn; uniform float uFogOpacity; uniform vec2 uFogScale; uniform float uFogOffset; uniform sampler2D uDetail;`)
        // the map tile is 1 m per texel; up close, tiled fine grain keeps the ground from turning into a blur
        .replace('#include <map_fragment>', detail ? `#include <map_fragment>
{
  vec2 dp = vec2(vGroundPos.x, -vGroundPos.z);
  float d1 = texture2D(uDetail, dp / 24.0).r, d2 = texture2D(uDetail, dp / 7.0).g;
  float grain = (d1 - 0.5) * 0.26 + (d2 - 0.5) * 0.14;
  diffuseColor.rgb *= 1.0 + grain;
}` : '#include <map_fragment>')
        .replace('#include <dithering_fragment>', `#include <dithering_fragment>
{
  float wx = vGroundPos.x, wz = -vGroundPos.z;   // world x, z (scene Z is -z)
  if (uFogOn > 0.5) {
    vec2 fuv = vec2(wx * uFogScale.x + uFogOffset, wz * uFogScale.y + uFogOffset);
    float explored = texture2D(uFog, fuv).r;
    float veil = uFogOpacity * (1.0 - smoothstep(0.35, 0.65, explored));
    gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.0), veil);
  }
}`);
    };
    mat.customProgramCacheKey = () => detail ? 'ground' : 'ground-plain';
    return mat;
  }

  // Tileable grain for the ground: red = soft blotches (metres), green = finer mottling. Built once.
  detailTexture() {
    if (this._detail) return this._detail;
    const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(S, S), d = img.data;
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    // value noise on a coarse lattice (wraps), bilinear, two octaves for red; white noise blurred once for green
    const N = 16, lat = new Float32Array(N * N); for (let i = 0; i < lat.length; i++) lat[i] = rnd();
    const N2 = 64, lat2 = new Float32Array(N2 * N2); for (let i = 0; i < lat2.length; i++) lat2[i] = rnd();
    const smooth = (lat, n, u, v) => {
      const x = u * n, y = v * n, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const a = lat[(y0 % n) * n + (x0 % n)], b = lat[(y0 % n) * n + ((x0 + 1) % n)], cc = lat[((y0 + 1) % n) * n + (x0 % n)], dd = lat[((y0 + 1) % n) * n + ((x0 + 1) % n)];
      return (a * (1 - sx) + b * sx) * (1 - sy) + (cc * (1 - sx) + dd * sx) * sy;
    };
    const N3 = 32, lat3 = new Float32Array(N3 * N3); for (let i = 0; i < lat3.length; i++) lat3[i] = rnd();
    const N4 = 128, lat4 = new Float32Array(N4 * N4); for (let i = 0; i < lat4.length; i++) lat4[i] = rnd();
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S;
        const r = 0.65 * smooth(lat, N, u, v) + 0.35 * smooth(lat2, N2, u, v);
        const g = 0.6 * smooth(lat3, N3, u, v) + 0.4 * smooth(lat4, N4, u, v);
        const o = (y * S + x) * 4;
        d[o] = Math.round(r * 255); d[o + 1] = Math.round(g * 255); d[o + 2] = 128; d[o + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; t.minFilter = THREE.LinearMipmapLinearFilter;
    this._detail = t;
    return t;
  }

  center() { return { x: this.controls.target.x, z: -this.controls.target.z }; }

  lookAt(x, z) {
    const dx = this.camera.position.x - this.controls.target.x, dy = this.camera.position.y - this.controls.target.y, dz = this.camera.position.z - this.controls.target.z;
    this.controls.target.set(x, this.heightAt(x, z) ?? this.controls.target.y, -z);
    this.camera.position.set(x + dx, this.controls.target.y + dy, -z + dz);
    this.controls.update();
    this.scheduleUpdate();
  }

  resize() {
    const w = this.canvas.clientWidth || innerWidth, h = this.canvas.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  loop() {
    if (!this.running) return;
    requestAnimationFrame(() => this.loop());
    this.controls.update();
    // keep the target on the ground so orbiting feels anchored
    const h = this.heightAt(this.controls.target.x, -this.controls.target.z);
    if (h !== null && Math.abs(h - this.controls.target.y) > 0.5) {
      const d = h - this.controls.target.y;
      this.controls.target.y += d * 0.2; this.camera.position.y += d * 0.2;
    }
    for (const p of this.players.values()) p.label.quaternion.copy(this.camera.quaternion);
    this.fitLabels();
    this.tickLighting();
    this.renderer.render(this.scene, this.camera);
  }

  // time of day: the server's (from stats) or a fixed one the visitor picked
  tickLighting() {
    const pick = layerState.time3d;
    let frac = { noon: 0.5, morning: 0.3, evening: 0.72, night: 0.02 }[pick];
    if (frac === undefined) frac = statsStore.data?.server?.dayFraction ?? 0.5;
    if (this.lastDayFraction === null || Math.abs(frac - this.lastDayFraction) > 0.002) { this.lastDayFraction = frac; this.lighting.setTime(frac); }
    this.lighting.update(this.camera, this.controls.target);
    const t = performance.now() / 1000;
    this.waterNormals.offset.set((t * 0.012) % 1, (t * 0.009) % 1);
  }

  // Tileable normal map for the water: a few summed sine ripples, encoded as a tangent-space normal.
  waterNormalTexture() {
    const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
    const ctx = c.getContext('2d'), img = ctx.createImageData(S, S), d = img.data;
    const waves = [[3, 1, 1.0], [-2, 4, 0.7], [5, -3, 0.5], [1, 7, 0.35], [-6, -2, 0.3]];
    const h = (x, y) => { let v = 0; for (const [a, b, w] of waves) v += w * Math.sin(2 * Math.PI * (a * x + b * y) / S); return v; };
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const dx = (h(x + 1, y) - h(x - 1, y)) * 0.5, dy = (h(x, y + 1) - h(x, y - 1)) * 0.5;
        const nx = -dx * 0.9, ny = -dy * 0.9, nz = 1, len = Math.hypot(nx, ny, nz);
        const o = (y * S + x) * 4;
        d[o] = Math.round((nx / len * 0.5 + 0.5) * 255); d[o + 1] = Math.round((ny / len * 0.5 + 0.5) * 255); d[o + 2] = Math.round((nz / len * 0.5 + 0.5) * 255); d[o + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(26000 / 40, 26000 / 40); t.anisotropy = 4;
    return t;
  }

  // Labels keep a readable on-screen size (about 26 px tall) whatever the camera distance.
  fitLabels() {
    const h = this.canvas.clientHeight || innerHeight;
    const perM = 2 * Math.tan(this.camera.fov * Math.PI / 360) / h;   // world metres per pixel at 1 m
    const fit = (s, px) => {
      if (!s.visible) return;
      const d = s.getWorldPosition(_v).distanceTo(this.camera.position);
      const height = Math.max(0.8, d * perM * px);
      s.scale.set(height * s.aspect, height, 1);
    };
    for (const s of this.markerSprites.children) fit(s, 26);
    for (const p of this.players.values()) fit(p.label, 32);
  }

  scheduleUpdate() {
    clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => this.update(), 200);
  }

  // ---------------------------------------------------------------- terrain LOD
  update() {
    if (!this.running) return;
    const tx = this.controls.target.x, tz = -this.controls.target.z;
    const wanted = new Set();
    for (const ring of RINGS) {
      const span = TILE * metersPerPixel(ring.z);
      const n = Math.ceil(20480 / span);
      const x0 = Math.max(0, Math.floor((tx - ring.dist + WORLD_HALF) / span)), x1 = Math.min(n - 1, Math.floor((tx + ring.dist + WORLD_HALF) / span));
      const y0 = Math.max(0, Math.floor((WORLD_HALF - (tz + ring.dist)) / span)), y1 = Math.min(n - 1, Math.floor((WORLD_HALF - (tz - ring.dist)) / span));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const cx = -WORLD_HALF + (x + 0.5) * span, cz = WORLD_HALF - (y + 0.5) * span;
          if (Math.hypot(cx - tx, cz - tz) > ring.dist + span * 0.7) continue;
          const key = `${ring.z}/${x}/${y}`;
          wanted.add(key);
          if (!this.terrain.has(key)) this.loadTile(ring.z, x, y, ring.segs);
        }
    }
    for (const [key, t] of this.terrain) {
      if (!wanted.has(key)) { this.dropTile(key); continue; }
    }
    // hide coarse tiles fully covered by ready children
    for (const [key, t] of this.terrain) {
      if (!t.mesh) continue;
      let covered = t.z < MAX_ZOOM;
      if (covered) for (let dy = 0; dy < 2 && covered; dy++) for (let dx = 0; dx < 2 && covered; dx++) {
        const c = this.terrain.get(`${t.z + 1}/${t.x * 2 + dx}/${t.y * 2 + dy}`);
        if (!c || !c.ready) covered = false;
      }
      t.mesh.visible = !covered;
    }
    // world objects by chunk: real meshes when the server publishes object chunks, else the footprint/shape fallback
    const useModels = objects.index.size > 0;
    const reach = Math.max(STRUCT_DIST, OBJ_DIST);
    const c0x = Math.max(0, chunkOf(tx - reach)), c1x = Math.min(79, chunkOf(tx + reach));
    const c0z = Math.max(0, chunkOf(tz - reach)), c1z = Math.min(79, chunkOf(tz + reach));
    const wantS = new Set(), wantV = new Set(), wantO = new Set();
    for (let cz = c0z; cz <= c1z; cz++)
      for (let cx = c0x; cx <= c1x; cx++) {
        const mx = -WORLD_HALF + (cx + 0.5) * 256, mz = -WORLD_HALF + (cz + 0.5) * 256;
        const d = Math.hypot(mx - tx, mz - tz);
        const key = `${cx}_${cz}`;
        if (useModels) {
          if (d <= OBJ_DIST && objects.has(cx, cz)) { wantO.add(key); if (!this.objChunks.has(key)) this.loadObjects(cx, cz); }
        } else {
          if (d <= STRUCT_DIST && chunks.has(cx, cz)) { wantS.add(key); if (!this.structures.has(key)) this.loadStructures(cx, cz); }
          if (d <= VEG_DIST) { wantV.add(key); if (!this.veg.has(key)) this.loadVeg(cx, cz); }
        }
      }
    for (const k of [...this.structures.keys()]) if (!wantS.has(k)) this.dropStructures(k);
    for (const k of [...this.veg.keys()]) if (!wantV.has(k)) this.dropVeg(k);
    for (const k of [...this.objChunks.keys()]) if (!wantO.has(k)) this.dropObjects(k);
    this.applyMarkerVisibility();
    for (const s of this.pinSprites.children) s.visible = Math.hypot(s.position.x - tx, -s.position.z - tz) <= MARKER_DIST;
  }

  // chat pins (from the markers layer, live over the websocket)
  setPins(list) { this.pins = list || []; if (this.running) this.rebuildPins(); }
  rebuildPins() {
    for (const s of [...this.pinSprites.children]) { this.pinSprites.remove(s); s.material.map?.dispose(); s.material.dispose(); }
    for (const p of this.pins) {
      const icon = ['dot', 'fire', 'mine', 'house', 'cave'].includes(p.type) ? p.type : 'pin';
      const sprite = makeLabel(layerState.labels ? (p.text || p.name || 'pin') : '', iconColors[icon] || '#ffd166');
      sprite.position.set(p.x, (this.heightAt(p.x, p.z) ?? this.waterLevel) + 4, -p.z);
      this.pinSprites.add(sprite);
    }
  }

  async loadTile(z, x, y, segs) {
    const key = `${z}/${x}/${y}`;
    const entry = { z, x, y, mesh: null, ready: false, heights: null, segs };
    this.terrain.set(key, entry);
    let heightImg, tex;
    try {
      [heightImg, tex] = await Promise.all([loadImg(`tiles/height/${z}/${x}/${y}.png`), this.loadTexture(`tiles/map/${z}/${x}/${y}.png`)]);
    } catch { return; }                       // not rendered (yet): the coarser ring covers it
    if (!this.terrain.has(key)) return;        // dropped while loading
    const heights = decodeTerrarium(heightImg);
    entry.heights = heights;
    const span = TILE * metersPerPixel(z);
    const minX = -WORLD_HALF + x * span, maxZ = WORLD_HALF - y * span;
    // segs x segs surface plus a one-cell skirt ring: the outer vertex ring sits exactly under the
    // edge (same x/z, a few metres lower), so the surface itself runs edge to edge and neighbouring
    // tiles meet without a trench. Heights come from the tile's own pixels; the outer half-pixel
    // is extrapolated from the edge slope so the seam heights agree with the neighbour's.
    const W = segs + 2;
    const geo = new THREE.PlaneGeometry(span, span, W, W);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position, uvs = geo.attributes.uv;
    const nrm = new Float32Array(pos.count * 3);
    const skirt = Math.max(2, metersPerPixel(z) * 3);
    const mpp = metersPerPixel(z);
    const heightAt = (u, v) => sampleExtrap(heights, u, v);
    for (let i = 0; i < pos.count; i++) {
      const ix = i % (W + 1), iy = Math.floor(i / (W + 1));
      const inner = ix >= 1 && ix <= W - 1 && iy >= 1 && iy <= W - 1;
      const cx = Math.min(Math.max(ix - 1, 0), segs), cy = Math.min(Math.max(iy - 1, 0), segs);
      const lx = cx / segs * span, lz = cy / segs * span;   // 0..span from west / from north
      const u = lx / mpp - 0.5, v = lz / mpp - 0.5;           // pixel-centre coordinates
      let h = heightAt(u, v);
      if (!inner) h -= skirt;
      pos.setXYZ(i, lx - span / 2, h, lz - span / 2);
      uvs.setXY(i, lx / span, 1 - lz / span);
      // normal from the height field, so lighting is continuous across tile edges
      const d = 0.5;
      const dx = (heightAt(u + d, v) - heightAt(u - d, v)) / (2 * d * mpp);
      const dz = (heightAt(u, v + d) - heightAt(u, v - d)) / (2 * d * mpp);
      const len = Math.hypot(dx, 1, dz);
      nrm[i * 3] = -dx / len; nrm[i * 3 + 1] = 1 / len; nrm[i * 3 + 2] = -dz / len;
    }
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    const mat = this.groundMaterial({ map: tex, roughness: 0.95, metalness: 0 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true; mesh.castShadow = true;
    mesh.position.set(minX + span / 2, 0, -(maxZ - span / 2));
    mesh.renderOrder = z;
    entry.mesh = mesh; entry.ready = true;
    this.scene.add(mesh);
    this.scheduleUpdate();
  }

  dropTile(key) {
    const t = this.terrain.get(key);
    if (!t) return;
    this.terrain.delete(key);
    if (t.mesh) { this.scene.remove(t.mesh); t.mesh.geometry.dispose(); t.mesh.material.map?.dispose(); t.mesh.material.dispose(); }
  }

  loadTexture(url) {
    return new Promise((resolve, reject) => this.loader.load(url, (t) => {
      t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = this.maxAniso; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
      resolve(t);
    }, undefined, reject));
  }

  // ground height from the finest loaded tile under a point
  heightAt(x, z) {
    for (const ring of RINGS) {
      const span = TILE * metersPerPixel(ring.z);
      const tx = Math.floor((x + WORLD_HALF) / span), ty = Math.floor((WORLD_HALF - z) / span);
      const t = this.terrain.get(`${ring.z}/${tx}/${ty}`);
      if (!t || !t.heights) continue;
      const u = ((x + WORLD_HALF) - tx * span) / span * TILE - 0.5;
      const v = ((WORLD_HALF - z) - ty * span) / span * TILE - 0.5;
      return Math.max(this.waterLevel, sampleBilinear(t.heights, u, v));
    }
    return null;
  }

  // ---------------------------------------------------------------- world objects (real meshes)
  // Loads a prefab's glTF once; resolves to [{geometry, material}] or null when the server has no model for it.
  model(hash) {
    if (this.models.has(hash)) return this.models.get(hash);
    const info = prefabs.get(hash);
    if (!info || !info.m) { const p = Promise.resolve(null); this.models.set(hash, p); return p; }
    const file = (hash >>> 0).toString(16).padStart(8, '0');
    const p = this.gltf.loadAsync(`models/${file}.glb`).then((g) => {
      const parts = [];
      g.scene.updateMatrixWorld(true);
      g.scene.traverse((o) => {
        if (!o.isMesh) return;
        const geo = o.geometry;
        if (!o.matrixWorld.equals(IDENTITY)) geo.applyMatrix4(o.matrixWorld);
        if (!geo.attributes.normal) geo.computeVertexNormals();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) { m.side = THREE.DoubleSide; if (m.map) { m.map.anisotropy = Math.min(4, this.maxAniso); } m.metalness = 0; m.roughness = Math.max(0.7, m.roughness); }
        parts.push({ geometry: geo, material: o.material });
      });
      return parts.length ? parts : null;
    }).catch((e) => { console.warn('model', file, e.message || e); return null; });
    this.models.set(hash, p);
    return p;
  }

  async loadObjects(cx, cz) {
    const key = `${cx}_${cz}`;
    const group = new THREE.Group();
    this.objChunks.set(key, group);
    let data;
    try { data = await objects.get(cx, cz); } catch { return; }
    if (this.objChunks.get(key) !== group) return;
    const byPrefab = new Map();
    for (const o of data.objs) {
      const info = prefabs.get(o.prefab);
      if (info && !objectFilter.shows(info.c)) continue;
      if (!byPrefab.has(o.prefab)) byPrefab.set(o.prefab, []);
      byPrefab.get(o.prefab).push(o);
    }
    const q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3(), mtx = new THREE.Matrix4(), off = new THREE.Matrix4(), out = new THREE.Matrix4();
    const place = (o) => { pos.set(o.x, o.y, -o.z); q.set(-o.qx, -o.qy, o.qz, o.qw); scl.set(o.sx, o.sy, o.sz); mtx.compose(pos, q, scl); return mtx; };
    this.scene.add(group);
    // every prefab's model loads in parallel and shows up as soon as it arrives
    await Promise.all([...byPrefab].map(async ([hash, list]) => {
      const info = prefabs.get(hash);
      const parts = await this.model(hash);
      if (this.objChunks.get(key) !== group) return;
      const cat = info ? info.c : 'other';
      if (parts) {
        for (const part of parts) {
          const im = new THREE.InstancedMesh(part.geometry, cat === 'piece' ? part.material.clone() : part.material, list.length);
          im.castShadow = true; im.receiveShadow = true;
          im.userData.cat = cat;
          list.forEach((o, i) => im.setMatrixAt(i, place(o)));
          im.instanceMatrix.needsUpdate = true;
          im.computeBoundingSphere();
          group.add(im);
        }
      }
      // canopy: billboard leaves over the foliage bounds (the model itself carries only trunk and branches)
      if (info && info.k && info.k.length === 6 && info.k[3] > info.k[0]) {
        // the crown: the foliage bounds, trimmed. Trees carry low branches in their bounds, so the
        // billboard starts a third of the way up (trunk stays visible) and is a little narrower
        // than the outermost leaf; bushes keep their full bounds.
        const k = info.k, tree = cat === 'tree';
        const h = k[4] - k[1], y0 = tree ? k[1] + h * 0.3 : k[1];
        const shrink = tree ? 0.8 : 1;
        const b = [k[0] * shrink, y0, k[2] * shrink, k[3] * shrink, k[4], k[5] * shrink];
        const size = [Math.max(0.3, b[3] - b[0]), Math.max(0.3, b[4] - b[1]), Math.max(0.3, b[5] - b[2])];
        const center = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
        off.compose(new THREE.Vector3(center[0], center[1], center[2]), new THREE.Quaternion(), new THREE.Vector3(size[0], size[1], size[2]));
        const im = new THREE.InstancedMesh(this.canopyGeometry(), this.canopyMaterial(info), list.length);
        im.castShadow = true; im.receiveShadow = true;
        im.userData.cat = cat;
        list.forEach((o, i) => { out.multiplyMatrices(place(o), off); im.setMatrixAt(i, out); });
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        group.add(im);
      }
    }));
    if (!layerState.buildings || layerState.buildingsOpacity < 0.999) this.applyBuildings();
  }

  dropObjects(key) {
    const g = this.objChunks.get(key);
    if (!g) return;
    this.objChunks.delete(key);
    this.scene.remove(g);
    g.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
  }

  // ---------------------------------------------------------------- structures (fallback path)
  async loadStructures(cx, cz) {
    const key = `${cx}_${cz}`;
    const group = new THREE.Group();
    this.structures.set(key, group);
    let data;
    try { data = await chunks.get(cx, cz); } catch { return; }
    if (this.structures.get(key) !== group) return;
    const byMat = new Map();
    for (const p of data.pieces) { const m = p[7]; if (!byMat.has(m)) byMat.set(m, []); byMat.get(m).push(p); }
    const q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3(), mtx = new THREE.Matrix4();
    for (const [m, list] of byMat) {
      const mesh = new THREE.InstancedMesh(this.box, this.material(materialColors[m] || '#a07446', 0.85).clone(), list.length);
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.userData.cat = 'piece';
      list.forEach((p, i) => {
        const [x, z, y, yaw, sx, sz, h] = p;
        pos.set(x, y + h / 2, -z);
        q.setFromAxisAngle(AXIS_Y, -yaw * Math.PI / 180);
        scl.set(Math.max(sx, 0.15), Math.max(h, 0.1), Math.max(sz, 0.15));
        mtx.compose(pos, q, scl);
        mesh.setMatrixAt(i, mtx);
      });
      mesh.instanceMatrix.needsUpdate = true;
      group.add(mesh);
    }
    this.scene.add(group);
    if (!layerState.buildings || layerState.buildingsOpacity < 0.999) this.applyBuildings();
  }

  dropStructures(key) {
    const g = this.structures.get(key);
    if (!g) return;
    this.structures.delete(key);
    this.scene.remove(g);
    g.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
  }

  // ---------------------------------------------------------------- vegetation
  async loadVeg(cx, cz) {
    const key = `${cx}_${cz}`;
    const group = new THREE.Group();
    this.veg.set(key, group);
    const pts = await chunks.veg(cx, cz);
    if (this.veg.get(key) !== group || pts.length === 0) return;
    const byShape = new Map();
    for (const p of pts) {
      const v = VEG[p.kind]; if (!v) continue;
      const shape = v[3];
      if (!byShape.has(shape)) byShape.set(shape, []);
      byShape.get(shape).push(p);
    }
    const q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3(), mtx = new THREE.Matrix4(), col = new THREE.Color();
    const trunks = [];
    for (const [shape, list] of byShape) {
      const geo = this.geoms[shape];
      const mesh = new THREE.InstancedMesh(geo, this.material('#ffffff', 0.9, true), list.length);
      mesh.castShadow = true; mesh.receiveShadow = true;
      list.forEach((p, i) => {
        const [r, hgt, color] = VEG[p.kind];
        const rr = r * p.size, hh = hgt * p.size;
        q.setFromAxisAngle(AXIS_Y, (p.x * 7 + p.z * 3) % 6.28);
        if (shape === 'cone') { pos.set(p.x, p.y + hh * 0.2 + hh * 0.4, -p.z); scl.set(rr, hh * 0.8, rr); trunks.push([p, hh * 0.25, rr]); }
        else if (shape === 'sphere') { pos.set(p.x, p.y + hh - rr * 0.9, -p.z); scl.set(rr, rr * 0.9, rr); if (hh > 3) trunks.push([p, hh - rr * 0.9, rr]); }
        else if (shape === 'rock') { pos.set(p.x, p.y + hh * 0.35, -p.z); scl.set(rr, hh * 0.6, rr * 0.85); }
        else { pos.set(p.x, p.y + hh / 2, -p.z); scl.set(rr, hh, rr); }
        mtx.compose(pos, q, scl);
        mesh.setMatrixAt(i, mtx);
        mesh.setColorAt(i, col.set(color));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      group.add(mesh);
    }
    if (trunks.length) {
      const mesh = new THREE.InstancedMesh(this.geoms.trunk, this.material('#5a4030', 0.95), trunks.length);
      mesh.castShadow = true;
      trunks.forEach(([p, h, r], i) => {
        pos.set(p.x, p.y + h / 2, -p.z); scl.set(Math.max(0.3, r * 0.22), h, Math.max(0.3, r * 0.22)); q.identity();
        mtx.compose(pos, q, scl); mesh.setMatrixAt(i, mtx);
      });
      mesh.instanceMatrix.needsUpdate = true;
      group.add(mesh);
    }
    this.scene.add(group);
  }

  dropVeg(key) {
    const g = this.veg.get(key);
    if (!g) return;
    this.veg.delete(key);
    this.scene.remove(g);
    g.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
  }

  // A unit canopy: three vertical quads 60 degrees apart, textured with the tree's own leaf
  // texture (tiled) or a soft procedural leaf mask. Three quads per tree instead of the
  // game's few hundred leaf cards.
  canopyGeometry() {
    if (this._canopyGeo) return this._canopyGeo;
    const pos = [], nrm = [], uv = [], idx = [];
    const quad = (fn, n) => {
      const s = pos.length / 3;
      for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) { const p = fn(u - 0.5, v - 0.5); pos.push(p[0], p[1], p[2]); nrm.push(n[0], n[1], n[2]); uv.push(u, v); }
      idx.push(s, s + 1, s + 2, s, s + 2, s + 3);
    };
    for (let k = 0; k < 3; k++) {
      const a = k * Math.PI / 3, c = Math.cos(a), sn = Math.sin(a);
      quad((u, v) => [u * c, v, u * sn], [-sn, 0, c]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    this._canopyGeo = g;
    return g;
  }

  canopyMaterial(info) {
    const key = 'canopy:' + (info.kt || '') + ':' + (info.kc || []).join(',');
    if (this.matCache.has(key)) return this.matCache.get(key);
    const tint = info.kc && info.kc.length === 3 ? new THREE.Color(info.kc[0], info.kc[1], info.kc[2]) : new THREE.Color(0.35, 0.55, 0.25);
    // colour/detail from the leaf texture (tiled 3x3 over the quad), silhouette from the crown mask:
    // an ellipse with a ragged, fading edge, so a quad reads as a rounded crown rather than a rectangle
    const mat = new THREE.MeshStandardMaterial({ color: info.kt ? 0xffffff : tint, roughness: 0.95, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.5, transparent: false });
    mat.map = this.leafMask();   // stand-in until the real leaf texture arrives (or for good, when there is none)
    mat.alphaMap = this.crownMask();
    if (info.kt) {
      this.loader.load(`models/${info.kt}`, (t) => {
        t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 3); t.anisotropy = Math.min(4, this.maxAniso);
        mat.map = t; mat.needsUpdate = true;
      });
    }
    this.matCache.set(key, mat);
    return mat;
  }

  // Procedural leaf detail: grey blobs with gaps, tileable. The material tints it green.
  leafMask() {
    if (this._leafMask) return this._leafMask;
    const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
    const ctx = c.getContext('2d');
    let seed = 11;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 70; i++) {
      const x = rnd() * S, y = rnd() * S, rad = 5 + rnd() * 9, g = 150 + rnd() * 105;
      ctx.fillStyle = `rgb(${g},${g},${g})`;
      for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) { ctx.beginPath(); ctx.ellipse(x + dx, y + dy, rad, rad * 0.65, rnd() * 3, 0, Math.PI * 2); ctx.fill(); }
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 3);
    this._leafMask = t;
    return t;
  }

  // Crown silhouette (alphaMap): an ellipse filling the quad, opaque inside, fading out over the
  // last fifth, with the edge eaten into by holes so no two trees look the same straight line.
  crownMask() {
    if (this._crownMask) return this._crownMask;
    const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, S, S);
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, '#fff'); g.addColorStop(0.72, '#fff'); g.addColorStop(1, '#000');
    ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(S / 2, S / 2, S / 2, S / 2, 0, 0, Math.PI * 2); ctx.fill();
    let seed = 5;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    ctx.fillStyle = '#000';
    for (let i = 0; i < 40; i++) {   // bites out of the rim
      const a = rnd() * Math.PI * 2, r = S * (0.42 + rnd() * 0.1);
      ctx.beginPath(); ctx.arc(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r, 8 + rnd() * 14, 0, Math.PI * 2); ctx.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    this._crownMask = t;
    return t;
  }

  material(hex, roughness, vertexColors) {
    const k = hex + roughness + (vertexColors ? 'v' : '');
    if (!this.matCache.has(k)) this.matCache.set(k, new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness, metalness: 0.02, flatShading: true }));
    return this.matCache.get(k);
  }

  // ---------------------------------------------------------------- markers & players
  rebuildMarkers() {
    for (const s of [...this.markerSprites.children]) { this.markerSprites.remove(s); s.material.map?.dispose(); s.material.dispose(); }
    for (const set of markerStore.sets) {
      for (const m of set.markers || []) {
        const color = iconColors[m.icon] || iconColors[m.cat] || '#9aa5b5';
        const sprite = makeLabel(layerState.labels ? m.label : '', color);
        const y = (m.y ?? this.heightAt(m.x, m.z) ?? this.waterLevel) + 6;
        sprite.position.set(m.x, y, -m.z);
        sprite.userData = Object.assign({}, m, { set: set.id });
        this.markerSprites.add(sprite);
      }
    }
    this.scheduleUpdate();
  }

  setPlayers(list) {
    const seen = new Set();
    for (const p of list || []) {
      if (p.x === undefined) continue;
      seen.add(p.id);
      let e = this.players.get(p.id);
      if (!e) {
        const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.45, 1.0, 4, 8), this.material('#6fb7ff', 0.6));
        body.castShadow = true;
        const label = makeLabel(p.name, '#ffffff', 1.4);
        label.position.y = 2.6;
        const g = new THREE.Group(); g.add(body); g.add(label);
        body.position.y = 1;
        e = { group: g, label };
        this.players.set(p.id, e);
        this.playerGroup.add(g);
      }
      const y = p.y ?? this.heightAt(p.x, p.z) ?? this.waterLevel;
      e.group.position.set(p.x, y, -p.z);
      e.group.rotation.y = -(p.yaw || 0) * Math.PI / 180;
    }
    for (const [id, e] of this.players) if (!seen.has(id)) { this.playerGroup.remove(e.group); this.players.delete(id); }
  }
}

const AXIS_Y = new THREE.Vector3(0, 1, 0);
const IDENTITY = new THREE.Matrix4();
const _v = new THREE.Vector3();

// Colour for a prefab without a mesh, from what the server says it is and what its name says it's made of.
function fallbackColor(info) {
  if (!info) return '#9a8c78';
  const n = (info.n || '').toLowerCase();
  switch (info.c) {
    case 'tree': return n.includes('fir') || n.includes('pine') ? '#2c5234' : '#568a3a';
    case 'bush': return '#466e32';
    case 'rock': return n.includes('copper') || n.includes('silver') || n.includes('tin') ? '#86684a' : '#767670';
    case 'piece':
      if (n.includes('portal')) return '#5ac8d2';
      if (n.includes('blackmarble')) return '#424252';
      if (n.includes('stone') || n.includes('grausten')) return '#9a9892';
      if (n.includes('iron') || n.includes('metal')) return '#767e8c';
      if (n.includes('darkwood')) return '#5c422e';
      if (n.includes('roof') || n.includes('thatch')) return '#c6a258';
      if (n.includes('fire') || n.includes('hearth') || n.includes('forge')) return '#e68232';
      return '#a07446';
    default: return '#9a8c78';
  }
}

function loadImg(src) {
  return new Promise((resolve, reject) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => resolve(i); i.onerror = reject; i.src = src; });
}

// Terrarium RGB -> Float32Array of heights (row-major, north first)
function decodeTerrarium(img) {
  const c = document.createElement('canvas'); c.width = TILE; c.height = TILE;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, TILE, TILE);
  const d = ctx.getImageData(0, 0, TILE, TILE).data;
  const out = new Float32Array(TILE * TILE);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) out[j] = (d[i] * 256 + d[i + 1] + d[i + 2] / 256) - 32768;
  return out;
}

// bilinear with linear extrapolation past the outer pixel centres (the half-pixel rim of a tile)
function sampleExtrap(h, u, v) {
  const cu = Math.min(Math.max(u, 0), TILE - 1), cv = Math.min(Math.max(v, 0), TILE - 1);
  let val = sampleBilinear(h, cu, cv);
  if (u !== cu) { const dir = u > cu ? 1 : -1; val += (u - cu) * (sampleBilinear(h, cu, cv) - sampleBilinear(h, cu - dir, cv)) * dir; }
  if (v !== cv) { const dir = v > cv ? 1 : -1; val += (v - cv) * (sampleBilinear(h, cu, cv) - sampleBilinear(h, cu, cv - dir)) * dir; }
  return val;
}

function sampleBilinear(h, u, v) {
  const x0 = Math.max(0, Math.min(TILE - 2, Math.floor(u))), y0 = Math.max(0, Math.min(TILE - 2, Math.floor(v)));
  const tx = Math.min(1, Math.max(0, u - x0)), ty = Math.min(1, Math.max(0, v - y0));
  const a = h[y0 * TILE + x0], b = h[y0 * TILE + x0 + 1], c = h[(y0 + 1) * TILE + x0], d = h[(y0 + 1) * TILE + x0 + 1];
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

function makeLabel(text, color, scale = 1) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = '600 28px system-ui, sans-serif';
  const w = Math.ceil(ctx.measureText(text).width) + 36;
  c.width = w; c.height = 48;
  ctx.font = '600 28px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(10,12,18,.7)';
  roundRect(ctx, 0, 0, w, 48, 12); ctx.fill();
  ctx.fillStyle = color; ctx.beginPath(); ctx.arc(18, 24, 8, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(text, 32, 25);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: true, transparent: true, toneMapped: false }));
  sprite.aspect = w / 48;
  sprite.scale.set(sprite.aspect * 6 * scale, 6 * scale, 1);
  sprite.renderOrder = 999;
  return sprite;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}
