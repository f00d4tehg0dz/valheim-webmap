// Export an area of the map as a 3D scene: terrain from the height tiles, water, every
// building and world object as an instance of its prefab mesh, tree crowns as leaf
// billboards, markers as named empties. Written straight to glTF binary (.glb) by the
// small writer below, no library. Two flavours plus an Unreal pack:
//
//   instanced  one node per prefab with EXT_mesh_gpu_instancing (Blender, Godot, three.js)
//   flat       one node per object (Unreal, Unity, anything that lacks the extension)
//   unreal     zip: flat scene.glb, 16-bit heightmap PNG for a Landscape, instances.csv
//              in Unreal units, markers.csv, an editor Python helper, README
//
// Everything comes from the data the map already publishes, so only explored ground and
// what the server shows can leave it. The prefab meshes and textures are the game's own
// assets from the server owner's installation: fine to use, not to redistribute.

import * as THREE from 'three';
import { objects, prefabs, markers } from './data.js';
import { WORLD_HALF, TILE, MAX_ZOOM, metersPerPixel, chunkOf } from './crs.js';
import { fetchTerrarium } from './png.js';

const CHUNK = 256;
const MAX_CHUNKS = 36;   // 6 x 6 = 1.5 km on a side

// ---------------------------------------------------------------- terrain data

async function loadImage(url) {
  return new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = () => reject(new Error('missing ' + url)); im.src = url; });
}

// Heights straight from the PNG bytes (see png.js), canvas only as the fallback.
async function loadHeights(url) {
  try { return await fetchTerrarium(url); }
  catch (e) {
    if (String(e.message).startsWith('missing')) throw e;
    return decodeTerrarium(await loadImage(url));
  }
}

function decodeTerrarium(img) {
  const c = document.createElement('canvas'); c.width = TILE; c.height = TILE;
  const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, TILE, TILE).data;
  const h = new Float32Array(TILE * TILE);
  for (let i = 0, j = 0; i < h.length; i++, j += 4) h[i] = d[j] * 256 + d[j + 1] + d[j + 2] / 256 - 32768;
  return h;
}

// bilinear sample of a tile's height grid in pixel-centre coordinates, clamped at the rim
function sampleH(h, u, v) {
  u = Math.min(Math.max(u, 0), TILE - 1); v = Math.min(Math.max(v, 0), TILE - 1);
  const x0 = Math.min(TILE - 2, Math.floor(u)), y0 = Math.min(TILE - 2, Math.floor(v));
  const tx = u - x0, ty = v - y0;
  const a = h[y0 * TILE + x0], b = h[y0 * TILE + x0 + 1], c = h[(y0 + 1) * TILE + x0], d = h[(y0 + 1) * TILE + x0 + 1];
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

// One 256 m chunk of terrain: the zoom-7 height and colour tiles share the chunk grid.
async function loadChunkTerrain(cx, cz) {
  const tx = cx, ty = 79 - cz;   // chunk (cx, cz) counts from the south-west; tiles count from the north-west
  const [heights, colour] = await Promise.all([
    loadHeights(`tiles/height/${MAX_ZOOM}/${tx}/${ty}.png`),
    fetch(`tiles/map/${MAX_ZOOM}/${tx}/${ty}.png`).then((r) => r.ok ? r.arrayBuffer() : null).catch(() => null),
  ]);
  return { heights, colour, minX: -WORLD_HALF + cx * CHUNK, minZ: -WORLD_HALF + cz * CHUNK };
}

// ---------------------------------------------------------------- glb writer

class GlbWriter {
  constructor() {
    this.json = { asset: { version: '2.0', generator: 'Valheim WebMap' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }], images: [], textures: [], samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }], extensionsUsed: [] };
    this.chunks = []; this.length = 0;
    this.imageIndex = new Map();   // url -> texture index
    this.materialIndex = new Map();
  }
  pad(n) { return (n + 3) & ~3; }
  bufferView(bytes, target) {
    const view = { buffer: 0, byteOffset: this.length, byteLength: bytes.byteLength };
    if (target) view.target = target;
    this.chunks.push(bytes);
    const padded = this.pad(bytes.byteLength);
    if (padded > bytes.byteLength) this.chunks.push(new Uint8Array(padded - bytes.byteLength));
    this.length += padded;
    this.json.bufferViews.push(view);
    return this.json.bufferViews.length - 1;
  }
  accessor(array, type, componentType, target, withBounds) {
    const n = { VEC3: 3, VEC4: 4, VEC2: 2, SCALAR: 1 }[type];
    const acc = { bufferView: this.bufferView(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), target), componentType, count: array.length / n, type };
    if (withBounds) {
      const min = new Array(n).fill(Infinity), max = new Array(n).fill(-Infinity);
      for (let i = 0; i < array.length; i += n) for (let k = 0; k < n; k++) { const v = array[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
      acc.min = min; acc.max = max;
    }
    this.json.accessors.push(acc);
    return this.json.accessors.length - 1;
  }
  texture(bytes, key, mime = 'image/png') {
    if (this.imageIndex.has(key)) return this.imageIndex.get(key);
    this.json.images.push({ bufferView: this.bufferView(new Uint8Array(bytes)), mimeType: mime, name: key });
    this.json.textures.push({ source: this.json.images.length - 1, sampler: 0 });
    const idx = this.json.textures.length - 1;
    this.imageIndex.set(key, idx);
    return idx;
  }
  material(m) {
    const key = JSON.stringify(m);
    if (this.materialIndex.has(key)) return this.materialIndex.get(key);
    this.json.materials.push(m);
    const idx = this.json.materials.length - 1;
    this.materialIndex.set(key, idx);
    return idx;
  }
  // primitive: {positions, normals?, uvs?, indices, material}
  mesh(name, prims) {
    const primitives = prims.map((p) => {
      const attributes = { POSITION: this.accessor(p.positions, 'VEC3', 5126, 34962, true) };
      if (p.normals) attributes.NORMAL = this.accessor(p.normals, 'VEC3', 5126, 34962);
      if (p.uvs) attributes.TEXCOORD_0 = this.accessor(p.uvs, 'VEC2', 5126, 34962);
      const idx = p.indices instanceof Uint32Array ? p.indices : (p.positions.length / 3 > 65535 ? Uint32Array.from(p.indices) : Uint16Array.from(p.indices));
      const prim = { attributes, indices: this.accessor(idx, 'SCALAR', idx instanceof Uint32Array ? 5125 : 5123, 34963), mode: 4 };
      if (p.material !== undefined) prim.material = p.material;
      return prim;
    });
    this.json.meshes.push({ name, primitives });
    return this.json.meshes.length - 1;
  }
  node(n, parent) {
    this.json.nodes.push(n);
    const idx = this.json.nodes.length - 1;
    if (parent === undefined) this.json.scenes[0].nodes.push(idx);
    else (this.json.nodes[parent].children || (this.json.nodes[parent].children = [])).push(idx);
    return idx;
  }
  instanced(node, list) {
    // EXT_mesh_gpu_instancing: parallel TRS accessors
    const t = new Float32Array(list.length * 3), r = new Float32Array(list.length * 4), s = new Float32Array(list.length * 3);
    list.forEach((o, i) => { t.set(o.t, i * 3); r.set(o.r, i * 4); s.set(o.s, i * 3); });
    this.json.nodes[node].extensions = { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: this.accessor(t, 'VEC3', 5126), ROTATION: this.accessor(r, 'VEC4', 5126), SCALE: this.accessor(s, 'VEC3', 5126) } } };
    if (!this.json.extensionsUsed.includes('EXT_mesh_gpu_instancing')) this.json.extensionsUsed.push('EXT_mesh_gpu_instancing');
  }
  finish() {
    this.json.buffers[0].byteLength = this.length;
    if (this.json.extensionsUsed.length === 0) delete this.json.extensionsUsed;
    if (this.json.images.length === 0) { delete this.json.images; delete this.json.textures; delete this.json.samplers; }
    let jsonBytes = new TextEncoder().encode(JSON.stringify(this.json));
    const jsonPad = this.pad(jsonBytes.length);
    if (jsonPad > jsonBytes.length) { const p = new Uint8Array(jsonPad); p.fill(0x20); p.set(jsonBytes); jsonBytes = p; }
    const total = 12 + 8 + jsonBytes.length + 8 + this.length;
    const out = new Uint8Array(total); const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546C67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
    dv.setUint32(12, jsonBytes.length, true); dv.setUint32(16, 0x4E4F534A, true); out.set(jsonBytes, 20);
    let o = 20 + jsonBytes.length;
    dv.setUint32(o, this.length, true); dv.setUint32(o + 4, 0x004E4942, true); o += 8;
    for (const c of this.chunks) { out.set(c, o); o += c.byteLength; }
    return out;
  }
}

// ---------------------------------------------------------------- helpers

function textureBytes(url) { return fetch(url).then((r) => r.ok ? r.arrayBuffer() : null).catch(() => null); }

// the prefab's own glb names its textures by file; read them back so the export can embed the same files
async function modelTextureUris(hash) {
  try {
    const buf = await fetch(`models/${(hash >>> 0).toString(16).padStart(8, '0')}.glb`).then((r) => r.ok ? r.arrayBuffer() : null);
    if (!buf) return [];
    const dv = new DataView(buf);
    const len = dv.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, len)));
    const prims = json.meshes?.[0]?.primitives || [];
    return prims.map((p) => {
      const m = p.material !== undefined ? json.materials?.[p.material] : null;
      const ti = m?.pbrMetallicRoughness?.baseColorTexture?.index;
      if (ti === undefined) return null;
      const img = json.images?.[json.textures?.[ti]?.source];
      return img?.uri ? `models/${img.uri}` : null;
    });
  } catch { return []; }
}

// the crown mask the 3D view uses, as a PNG: an ellipse with a ragged rim, green
function crownPng(tint) {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  const col = `rgb(${Math.round(tint[0] * 255)},${Math.round(tint[1] * 255)},${Math.round(tint[2] * 255)})`;
  g.addColorStop(0, col); g.addColorStop(0.72, col); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(S / 2, S / 2, S / 2, S / 2, 0, 0, Math.PI * 2); ctx.fill();
  let seed = 5; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 40; i++) { const a = rnd() * Math.PI * 2, r = S * (0.42 + rnd() * 0.1); ctx.beginPath(); ctx.arc(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r, 8 + rnd() * 14, 0, Math.PI * 2); ctx.fill(); }
  return new Promise((resolve) => c.toBlob((b) => b.arrayBuffer().then(resolve), 'image/png'));
}

function canopyGeometry() {
  // three crossed unit quads, 60 degrees apart (same as the viewer)
  const pos = [], nrm = [], uv = [], idx = [];
  for (let k = 0; k < 3; k++) {
    const a = k * Math.PI / 3, c = Math.cos(a), sn = Math.sin(a), s = pos.length / 3;
    for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) { pos.push((u - 0.5) * c, v - 0.5, (u - 0.5) * sn); nrm.push(-sn, 0, c); uv.push(u, 1 - v); }
    idx.push(s, s + 1, s + 2, s, s + 2, s + 3);
  }
  return { positions: Float32Array.from(pos), normals: Float32Array.from(nrm), uvs: Float32Array.from(uv), indices: Uint16Array.from(idx) };
}

const _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Vector3();

// object transform in glTF space (x, y, -z; quaternion mirrored to match), as TRS
function objTRS(o) { return { t: [o.x, o.y, -o.z], r: [-o.qx, -o.qy, o.qz, o.qw], s: [o.sx, o.sy, o.sz] }; }

function composeTRS(trs, extra) {
  _p.set(trs.t[0], trs.t[1], trs.t[2]); _q.set(trs.r[0], trs.r[1], trs.r[2], trs.r[3]); _s.set(trs.s[0], trs.s[1], trs.s[2]);
  _m.compose(_p, _q, _s);
  if (extra) _m.multiply(extra);
  _m.decompose(_p, _q, _s);
  return { t: [_p.x, _p.y, _p.z], r: [_q.x, _q.y, _q.z, _q.w], s: [_s.x, _s.y, _s.z] };
}

// ---------------------------------------------------------------- the export

export class Exporter {
  constructor(app) { this.app = app; this.report = () => {}; }

  // opts: {x0, z0, x1, z1} world bounds (snapped out to chunks), step (m), cats (Set), water, trees (canopies), markers, mode
  async run(opts) {
    const view3d = this.app.view3d;
    if (!view3d) throw new Error('open the 3D view once so models can load');
    const c0x = Math.max(0, chunkOf(Math.min(opts.x0, opts.x1))), c1x = Math.min(79, chunkOf(Math.max(opts.x0, opts.x1) - 0.001));
    const c0z = Math.max(0, chunkOf(Math.min(opts.z0, opts.z1))), c1z = Math.min(79, chunkOf(Math.max(opts.z0, opts.z1) - 0.001));
    const nChunks = (c1x - c0x + 1) * (c1z - c0z + 1);
    if (nChunks > MAX_CHUNKS) throw new Error(`area too large: ${nChunks} chunks, max ${MAX_CHUNKS} (${Math.sqrt(MAX_CHUNKS) * CHUNK} m on a side)`);
    const bounds = { x0: -WORLD_HALF + c0x * CHUNK, z0: -WORLD_HALF + c0z * CHUNK, x1: -WORLD_HALF + (c1x + 1) * CHUNK, z1: -WORLD_HALF + (c1z + 1) * CHUNK };
    const w = new GlbWriter();
    const flat = opts.mode !== 'instanced';
    const step = Math.max(1, Math.min(8, opts.step || 2));
    const waterLevel = this.app.config?.water_level ?? 30;
    const terrainHeights = [];   // per chunk, for the Unreal heightmap
    let hMin = Infinity, hMax = -Infinity;

    // --- terrain
    const terrainRoot = w.node({ name: 'Terrain' });
    let done = 0;
    for (let cz = c0z; cz <= c1z; cz++)
      for (let cx = c0x; cx <= c1x; cx++) {
        this.report(`terrain ${++done}/${nChunks}`);
        let t;
        try { t = await loadChunkTerrain(cx, cz); } catch { continue; }   // unexplored: no tile, no ground
        terrainHeights.push({ cx, cz, heights: t.heights });
        const n = CHUNK / step, verts = (n + 1) * (n + 1);
        const positions = new Float32Array(verts * 3), normals = new Float32Array(verts * 3), uvs = new Float32Array(verts * 2);
        const mpp = metersPerPixel(MAX_ZOOM);
        const hAt = (lx, lz) => sampleH(t.heights, lx / mpp - 0.5, (CHUNK - lz) / mpp - 0.5);   // lz from the south edge
        for (let j = 0; j <= n; j++)
          for (let i = 0; i <= n; i++) {
            const lx = i * step, lz = j * step, k = j * (n + 1) + i;
            const h = hAt(lx, lz);
            if (h < hMin) hMin = h; if (h > hMax) hMax = h;
            positions[k * 3] = t.minX + lx; positions[k * 3 + 1] = h; positions[k * 3 + 2] = -(t.minZ + lz);
            const dx = (hAt(lx + 0.5, lz) - hAt(lx - 0.5, lz)), dz = (hAt(lx, lz + 0.5) - hAt(lx, lz - 0.5));
            const len = Math.hypot(dx, 1, dz);
            normals[k * 3] = -dx / len; normals[k * 3 + 1] = 1 / len; normals[k * 3 + 2] = dz / len;
            uvs[k * 2] = lx / CHUNK; uvs[k * 2 + 1] = 1 - lz / CHUNK;   // map tile: north at the top
          }
        const indices = new Uint32Array(n * n * 6);
        let q = 0;
        for (let j = 0; j < n; j++)
          for (let i = 0; i < n; i++) {
            const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
            indices[q++] = a; indices[q++] = b; indices[q++] = c; indices[q++] = b; indices[q++] = d; indices[q++] = c;
          }
        let material;
        if (t.colour) material = w.material({ name: `ground_${cx}_${cz}`, pbrMetallicRoughness: { baseColorTexture: { index: w.texture(t.colour, `ground_${cx}_${cz}`) }, metallicFactor: 0, roughnessFactor: 0.95 } });
        else material = w.material({ name: 'ground', pbrMetallicRoughness: { baseColorFactor: [0.36, 0.5, 0.25, 1], metallicFactor: 0, roughnessFactor: 0.95 } });
        const mesh = w.mesh(`terrain_${cx}_${cz}`, [{ positions, normals, uvs, indices, material }]);
        w.node({ name: `terrain_${cx}_${cz}`, mesh }, terrainRoot);
      }
    if (terrainHeights.length === 0) throw new Error('no explored ground in that area');

    // --- water
    if (opts.water !== false) {
      const p = Float32Array.from([bounds.x0, waterLevel, -bounds.z0, bounds.x1, waterLevel, -bounds.z0, bounds.x1, waterLevel, -bounds.z1, bounds.x0, waterLevel, -bounds.z1]);
      const nrm = Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
      const material = w.material({ name: 'water', pbrMetallicRoughness: { baseColorFactor: [0.12, 0.29, 0.44, 0.7], metallicFactor: 0.1, roughnessFactor: 0.25 }, alphaMode: 'BLEND', doubleSided: true });
      w.node({ name: 'Water', mesh: w.mesh('water', [{ positions: p, normals: nrm, indices: Uint16Array.from([0, 1, 2, 0, 2, 3]), material }]) });
    }

    // --- objects: gather by prefab
    const byPrefab = new Map();
    const cats = opts.cats || new Set(['piece', 'other', 'rock', 'bush', 'tree']);
    let total = 0;
    for (let cz = c0z; cz <= c1z; cz++)
      for (let cx = c0x; cx <= c1x; cx++) {
        if (!objects.has(cx, cz)) continue;
        let data;
        try { data = await objects.get(cx, cz); } catch { continue; }
        for (const o of data.objs) {
          if (o.x < bounds.x0 || o.x >= bounds.x1 || o.z < bounds.z0 || o.z >= bounds.z1) continue;
          const info = prefabs.get(o.prefab);
          const cat = info ? info.c : 'other';
          if (!cats.has(cat)) continue;
          if (!byPrefab.has(o.prefab)) byPrefab.set(o.prefab, []);
          byPrefab.get(o.prefab).push(o); total++;
        }
      }
    const objectsRoot = w.node({ name: 'Objects' });
    const instanceRows = [];   // for instances.csv
    let canopyGeo = null, crownTex = null, pi = 0;
    for (const [hash, list] of byPrefab) {
      const info = prefabs.get(hash);
      const name = info?.n || ('prefab_' + (hash >>> 0).toString(16));
      this.report(`models ${++pi}/${byPrefab.size} (${name})`);
      const parts = await view3d.model(hash);
      const prims = [];
      if (parts) {
        const uris = await modelTextureUris(hash);
        for (const [partIndex, part] of parts.entries()) {
          const g = part.geometry;
          const pos = g.attributes.position.array, nrm = g.attributes.normal?.array, uv = g.attributes.uv?.array;
          const idx = g.index ? g.index.array : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
          const mats = Array.isArray(part.material) ? part.material : [part.material];
          const m = mats[0];
          const mat = { name: m.name || name, pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 0.9 } };
          const col = m.color ? [m.color.r, m.color.g, m.color.b, 1] : [1, 1, 1, 1];
          const src = uris[partIndex] || m.map?.image?.src || null;
          if (src) {
            const bytes = await textureBytes(src);
            if (bytes) { mat.pbrMetallicRoughness.baseColorTexture = { index: w.texture(bytes, src.slice(src.lastIndexOf('/') + 1)) }; mat.pbrMetallicRoughness.baseColorFactor = col; }
            else mat.pbrMetallicRoughness.baseColorFactor = col;
          } else mat.pbrMetallicRoughness.baseColorFactor = col;
          if (m.alphaTest > 0) { mat.alphaMode = 'MASK'; mat.alphaCutoff = m.alphaTest; }
          if (m.side === THREE.DoubleSide) mat.doubleSided = true;
          prims.push({ positions: Float32Array.from(pos), normals: nrm ? Float32Array.from(nrm) : undefined, uvs: uv ? Float32Array.from(uv) : undefined, indices: idx, material: w.material(mat) });
        }
      }
      // canopy: leaf billboard over the foliage bounds, like the viewer draws it
      let canopy = null;
      if (opts.trees !== false && info && info.k && info.k.length === 6 && info.k[3] > info.k[0]) {
        const k = info.k, tree = info.c === 'tree';
        const h = k[4] - k[1], y0 = tree ? k[1] + h * 0.3 : k[1], shrink = tree ? 0.8 : 1;
        const b = [k[0] * shrink, y0, k[2] * shrink, k[3] * shrink, k[4], k[5] * shrink];
        const size = [Math.max(0.3, b[3] - b[0]), Math.max(0.3, b[4] - b[1]), Math.max(0.3, b[5] - b[2])];
        const center = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
        canopyGeo = canopyGeo || canopyGeometry();
        let tex = null;
        if (info.kt) { const bytes = await textureBytes(`models/${info.kt}`); if (bytes) tex = w.texture(bytes, info.kt); }
        if (tex === null) { if (crownTex === null) crownTex = w.texture(await crownPng(info.kc || [0.35, 0.55, 0.25]), 'crown.png'); tex = crownTex; }
        const mat = w.material({ name: name + '_leaves', pbrMetallicRoughness: { baseColorTexture: { index: tex }, baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.95 }, alphaMode: 'MASK', alphaCutoff: 0.5, doubleSided: true });
        canopy = { mesh: w.mesh(name + '_canopy', [{ ...canopyGeo, material: mat }]), offset: new THREE.Matrix4().compose(new THREE.Vector3(...center), new THREE.Quaternion(), new THREE.Vector3(...size)) };
      }
      if (prims.length === 0 && !canopy) continue;
      const mesh = prims.length ? w.mesh(name, prims) : null;
      for (const o of list) instanceRows.push([name, o.x, o.y, o.z, o.qx, o.qy, o.qz, o.qw, o.sx, o.sy, o.sz]);
      if (flat) {
        const group = w.node({ name }, objectsRoot);
        list.forEach((o, i) => {
          const trs = objTRS(o);
          if (mesh !== null) w.node({ name: `${name}_${i}`, mesh, translation: trs.t, rotation: trs.r, scale: trs.s }, group);
          if (canopy) { const c = composeTRS(trs, canopy.offset); w.node({ name: `${name}_${i}_leaves`, mesh: canopy.mesh, translation: c.t, rotation: c.r, scale: c.s }, group); }
        });
      } else {
        if (mesh !== null) w.instanced(w.node({ name, mesh }, objectsRoot), list.map(objTRS));
        if (canopy) w.instanced(w.node({ name: name + '_leaves', mesh: canopy.mesh }, objectsRoot), list.map((o) => composeTRS(objTRS(o), canopy.offset)));
      }
    }

    // --- markers as empties
    const markerRows = [];
    if (opts.markers !== false) {
      const root = w.node({ name: 'Markers' });
      for (const set of markers.sets) {
        for (const m of set.markers || []) {
          if (m.x < bounds.x0 || m.x >= bounds.x1 || m.z < bounds.z0 || m.z >= bounds.z1) continue;
          const y = m.y ?? (view3d.heightAt(m.x, m.z) ?? waterLevel);
          const label = `${set.id || set.name}: ${m.label || m.name || ''}`.trim();
          w.node({ name: label, translation: [m.x, y, -m.z] }, root);
          markerRows.push([set.id || set.name, m.label || m.name || '', m.x, y, m.z]);
        }
      }
    }

    this.report('writing');
    const glb = w.finish();
    const meta = { bounds, chunks: { x0: c0x, z0: c0z, x1: c1x, z1: c1z }, step, objects: total, prefabs: byPrefab.size, waterLevel, hMin, hMax };
    if (opts.mode !== 'unreal') return { blob: new Blob([glb], { type: 'model/gltf-binary' }), name: `valheim_x${Math.round(bounds.x0)}_z${Math.round(bounds.z0)}_${Math.round(bounds.x1 - bounds.x0)}m.glb`, meta };

    // --- Unreal pack
    this.report('heightmap');
    const heightPng = await heightmapPng(terrainHeights, c0x, c0z, c1x, c1z, hMin, hMax);
    const files = [
      ['scene.glb', glb],
      ['heightmap_r16.png', heightPng],
      ['instances.csv', csv([['prefab', 'ue_x_cm', 'ue_y_cm', 'ue_z_cm', 'ue_qx', 'ue_qy', 'ue_qz', 'ue_qw', 'scale_x', 'scale_y', 'scale_z', 'valheim_x', 'valheim_y', 'valheim_z'],
        ...instanceRows.map(([n, x, y, z, qx, qy, qz, qw, sx, sy, sz]) => [n, (x * 100).toFixed(1), (-z * 100).toFixed(1), (y * 100).toFixed(1), qx.toFixed(6), (-qz).toFixed(6), qy.toFixed(6), qw.toFixed(6), sx.toFixed(4), sy.toFixed(4), sz.toFixed(4), x.toFixed(2), y.toFixed(2), z.toFixed(2)])])],
      ['markers.csv', csv([['set', 'label', 'ue_x_cm', 'ue_y_cm', 'ue_z_cm', 'valheim_x', 'valheim_y', 'valheim_z'], ...markerRows.map(([s, l, x, y, z]) => [s, l, (x * 100).toFixed(1), (-z * 100).toFixed(1), (y * 100).toFixed(1), x.toFixed(2), y.toFixed(2), z.toFixed(2)])])],
      ['import_valheim_webmap.py', unrealScript()],
      ['README.txt', unrealReadme(meta, heightPng.width, heightPng.height)],
    ];
    const zip = makeZip(files.map(([n, d]) => [n, typeof d === 'string' ? new TextEncoder().encode(d) : (d.bytes || d)]));
    return { blob: new Blob([zip], { type: 'application/zip' }), name: `valheim_unreal_x${Math.round(bounds.x0)}_z${Math.round(bounds.z0)}_${Math.round(bounds.x1 - bounds.x0)}m.zip`, meta };
  }
}

function csv(rows) { return rows.map((r) => r.map((v) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(',')).join('\n') + '\n'; }

// ---------------------------------------------------------------- 16-bit heightmap PNG

// one row of pixels per metre, north at the top (Unreal's importer reads +Y down as +X forward)
async function heightmapPng(tiles, c0x, c0z, c1x, c1z, hMin, hMax) {
  const W = (c1x - c0x + 1) * CHUNK, H = (c1z - c0z + 1) * CHUNK;
  const range = Math.max(1, hMax - hMin);
  const byKey = new Map(tiles.map((t) => [`${t.cx}_${t.cz}`, t.heights]));
  const stride = 1 + W * 2;
  const raw = new Uint8Array(stride * H);
  for (let py = 0; py < H; py++) {
    const row = py * stride; raw[row] = 0;   // filter: none
    const zOff = H - 1 - py;   // metres from the south edge of the area; north at the top of the image
    const cz = c0z + Math.floor(zOff / CHUNK), lz = zOff % CHUNK;
    for (let px = 0; px < W; px++) {
      const cx = c0x + Math.floor(px / CHUNK), lx = px - (cx - c0x) * CHUNK;
      const h = byKey.get(`${cx}_${cz}`);
      const v = h ? h[(CHUNK - 1 - lz) * TILE + lx] : hMin;
      const g = Math.max(0, Math.min(65535, Math.round((v - hMin) / range * 65535)));
      raw[row + 1 + px * 2] = g >> 8; raw[row + 2 + px * 2] = g & 255;
    }
  }
  const z = await deflate(raw);
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length); const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length); out.set(type, 4); out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13); const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, W); iv.setUint32(4, H); ihdr[8] = 16; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk(Uint8Array.from([73, 72, 68, 82]), ihdr), chunk(Uint8Array.from([73, 68, 65, 84]), z), chunk(Uint8Array.from([73, 69, 78, 68]), new Uint8Array(0))];
  const total = parts.reduce((a, p) => a + p.length, 0);
  const png = new Uint8Array(total); let o = 0; for (const p of parts) { png.set(p, o); o += p.length; }
  return { bytes: png, width: W, height: H };
}

async function deflate(raw) {
  if (typeof CompressionStream === 'function') {
    const cs = new CompressionStream('deflate');
    const writer = cs.writable.getWriter(); writer.write(raw); writer.close();
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
  }
  // stored (uncompressed) zlib stream: works everywhere, just bigger
  const blocks = Math.ceil(raw.length / 65535), out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  out[0] = 0x78; out[1] = 0x01; let o = 2;
  for (let i = 0; i < blocks; i++) {
    const s = i * 65535, len = Math.min(65535, raw.length - s);
    out[o++] = i === blocks - 1 ? 1 : 0; out[o++] = len & 255; out[o++] = len >> 8; out[o++] = ~len & 255; out[o++] = (~len >> 8) & 255;
    out.set(raw.subarray(s, s + len), o); o += len;
  }
  let a = 1, b = 0; for (let i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; b = (b + a) % 65521; }
  out[o++] = b >> 8; out[o++] = b & 255; out[o++] = a >> 8; out[o++] = a & 255;
  return out.subarray(0, o);
}

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) { crcTable = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; } }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---------------------------------------------------------------- zip (stored)

function makeZip(files) {
  const enc = new TextEncoder();
  const local = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const [name, data] of files) {
    const n = enc.encode(name), crc = crc32(data);
    const lh = new Uint8Array(30 + n.length); const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0x0800, true); dv.setUint16(8, 0, true);
    dv.setUint16(10, dosTime, true); dv.setUint16(12, dosDate, true); dv.setUint32(14, crc, true); dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true);
    dv.setUint16(26, n.length, true); dv.setUint16(28, 0, true); lh.set(n, 30);
    const ch = new Uint8Array(46 + n.length); const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true); cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, n.length, true); cv.setUint32(42, offset, true); ch.set(n, 46);
    local.push(lh, data); central.push(ch);
    offset += lh.length + data.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array(22); const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true); ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  const total = offset + cdSize + 22, out = new Uint8Array(total); let o = 0;
  for (const p of [...local, ...central, end]) { out.set(p, o); o += p.length; }
  return out;
}

// ---------------------------------------------------------------- Unreal helpers

function unrealReadme(meta, w, h) {
  const range = Math.max(1, meta.hMax - meta.hMin);
  const zScale = (range / 512 * 100).toFixed(3);
  const zLoc = ((meta.hMin + meta.hMax) / 2 * 100).toFixed(1);
  const x0 = (meta.bounds.z0 * 100).toFixed(0), y0 = (-meta.bounds.x1 * 100).toFixed(0);
  return `Valheim WebMap export for Unreal Engine 5
==========================================

Area: x ${meta.bounds.x0}..${meta.bounds.x1}, z ${meta.bounds.z0}..${meta.bounds.z1} (Valheim metres)
Ground: ${meta.hMin.toFixed(1)} m .. ${meta.hMax.toFixed(1)} m, water at ${meta.waterLevel} m
Objects: ${meta.objects} instances of ${meta.prefabs} prefabs

Files
  scene.glb               whole area: terrain meshes, water, every object as a node, markers as empties
  heightmap_r16.png       ${w} x ${h} px, 16-bit, 1 px = 1 m, north at the top, for a Landscape
  instances.csv           one row per object in Unreal units (cm, Unreal axes) plus the Valheim originals
  markers.csv             portals, tombstones, bases, boats
  import_valheim_webmap.py  optional editor script: spawns instances.csv onto already imported meshes

Quickest: File > Import Into Level > scene.glb
  Interchange imports the terrain and one Static Mesh per prefab, and places every object.
  Set the scene scale to 100 if asked (glTF metres to Unreal centimetres). Done.

Landscape instead of a terrain mesh
  1. Landscape mode > Import from File > heightmap_r16.png
  2. Scale: X 100, Y 100, Z ${zScale}   (16-bit range = 512 m at Z scale 100; this area spans ${range.toFixed(1)} m)
  3. Location: X ${x0}, Y ${y0}, Z ${zLoc}   (so the map lines up with instances.csv; heights centre on ${((meta.hMin + meta.hMax) / 2).toFixed(1)} m)
  4. Import. Unreal pads the heightmap to fit its component grid; that is fine.
  5. Delete the Terrain actors that came in with scene.glb.

Axes
  Valheim/Unity is left-handed, Y up, x east, z north. Unreal is left-handed, Z up.
  instances.csv already converted: X = valheim.x*100, Y = -valheim.z*100, Z = valheim.y*100,
  quaternion (x, -z, y, w). That matches how Unreal imports the glTF meshes. If a mesh you
  placed yourself looks mirrored, flip the sign of Y and of the quaternion's Y.

Content note
  The prefab meshes and textures are the game's assets, read from your own server's game
  files. Use them for your own scenes; do not redistribute this pack.
`;
}

function unrealScript() {
  return `# Valheim WebMap: place instances.csv in the open level.
# Run in the Unreal editor (Tools > Execute Python Script) after importing scene.glb or the
# individual prefab meshes. Meshes are looked up by prefab name under MESH_ROOT.
import csv, os, unreal

MESH_ROOT = '/Game/ValheimWebMap'        # where the imported static meshes live
CSV_PATH = os.path.join(os.path.dirname(__file__), 'instances.csv')

def find_mesh(name):
    reg = unreal.AssetRegistryHelpers.get_asset_registry()
    for a in reg.get_assets_by_path(MESH_ROOT, recursive=True):
        if a.asset_class_path.asset_name == 'StaticMesh' and str(a.asset_name) == name:
            return a.get_asset()
    return None

world = unreal.EditorLevelLibrary.get_editor_world()
by_mesh = {}
with open(CSV_PATH, newline='') as f:
    for row in csv.DictReader(f):
        by_mesh.setdefault(row['prefab'], []).append(row)

placed = missing = 0
for prefab, rows in by_mesh.items():
    mesh = find_mesh(prefab)
    if mesh is None:
        missing += len(rows); continue
    actor = unreal.EditorLevelLibrary.spawn_actor_from_class(unreal.Actor, unreal.Vector(0, 0, 0))
    actor.set_actor_label('VWM_' + prefab)
    comp = unreal.HierarchicalInstancedStaticMeshComponent(outer=actor, name=prefab)
    comp.set_static_mesh(mesh)
    actor.add_instance_component(comp)
    comp.register_component()
    for r in rows:
        q = unreal.Quat(float(r['ue_qx']), float(r['ue_qy']), float(r['ue_qz']), float(r['ue_qw']))
        t = unreal.Transform(unreal.Vector(float(r['ue_x_cm']), float(r['ue_y_cm']), float(r['ue_z_cm'])), q.rotator(), unreal.Vector(float(r['scale_x']), float(r['scale_z']), float(r['scale_y'])))
        comp.add_instance(t, True)
        placed += 1
unreal.log('Valheim WebMap: placed %d instances, %d had no mesh under %s' % (placed, missing, MESH_ROOT))
`;
}
