#!/usr/bin/env node
// A stand-in for the mod's HTTP/websocket server, for working on the web app
// without a Valheim server: procedural terrain tiles, a fake base, trees,
// markers, wandering players, chat. Same routes and frames as MapDataServer.
//
//   node tools/mockserver.js [port]      then open http://localhost:3000
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');

const PORT = +(process.argv[2] || 3000);
const WEB = path.join(__dirname, '..', 'WebMap', 'web');
const TILE = 256, MAX_ZOOM = 7, WORLD_HALF = 10240, WATER = 30;
const MIME = { html: 'text/html', js: 'text/javascript', css: 'text/css', png: 'image/png', svg: 'image/svg+xml', json: 'application/json', bin: 'application/octet-stream', ico: 'image/x-icon' };

// ---------------------------------------------------------------- procedural world
function hash(x, y) { let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296; }
function smooth(t) { return t * t * (3 - 2 * t); }
function noise(x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y), tx = smooth(x - x0), ty = smooth(y - y0);
  const a = hash(x0, y0), b = hash(x0 + 1, y0), c = hash(x0, y0 + 1), d = hash(x0 + 1, y0 + 1);
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}
function fbm(x, y, oct = 5) { let v = 0, a = 0.5, f = 1; for (let i = 0; i < oct; i++) { v += a * noise(x * f, y * f); a *= 0.5; f *= 2; } return v; }
function height(x, z) {
  const r = Math.hypot(x, z);
  const cont = fbm(x / 2400 + 10, z / 2400 + 10, 4) * 2 - 1;
  let h = 44 + cont * 55 + (fbm(x / 400 + 3, z / 400 + 7, 6) - 0.5) * 70 - r * r / 3.2e6;
  const mountain = Math.max(0, fbm(x / 1500 + 20, z / 1500 + 20, 3) - 0.62) * 900;
  h += mountain;
  // a flat base near spawn with a moat
  const db = Math.hypot(x - 180, z - 120);
  if (db < 60) h = 42; else if (db < 72) h = 32 + (db - 60) * 0.8;
  return h;
}
function biome(x, z, h) {
  const r = Math.hypot(x, z);
  if (h < WATER - 2 && r > 9200) return 256;
  if (h > 110) return 4;
  const n = fbm(x / 3000 + 50, z / 3000 + 50, 3);
  if (z > 6500) return 64;
  if (z < -6500 && r > 6000) return 32;
  if (n > 0.6 && r > 2500) return 16;
  if (n < 0.42 && r > 1500) return 8;
  if (h < WATER + 4 && n > 0.5 && r > 1000) return 2;
  if (r > 5500 && n > 0.48) return 512;
  return 1;
}
const BIOME_COLORS = { 1: [112, 146, 72], 8: [64, 84, 48], 2: [84, 82, 56], 4: [138, 136, 132], 16: [188, 172, 98], 512: [96, 92, 108], 32: [104, 52, 42], 64: [220, 228, 236], 256: [20, 44, 82] };

function renderTile(layer, z, x, y) {
  const mpp = Math.pow(2, MAX_ZOOM - z), span = TILE * mpp;
  const minX = -WORLD_HALF + x * span, maxZ = WORLD_HALF - y * span;
  const S = TILE + 2;
  const H = new Float32Array(S * S), B = new Uint16Array(S * S);
  for (let py = 0; py < S; py++) for (let px = 0; px < S; px++) {
    const wx = minX + (px - 1 + 0.5) * mpp, wz = maxZ - (py - 1 + 0.5) * mpp;
    const h = height(wx, wz); H[py * S + px] = h; B[py * S + px] = biome(wx, wz, h);
  }
  const out = Buffer.alloc(TILE * TILE * 3);
  const sun = [-0.45, 0.72, 0.53];
  for (let py = 0; py < TILE; py++) for (let px = 0; px < TILE; px++) {
    const i = (py + 1) * S + px + 1, h = H[i], b = B[i];
    let c;
    if (layer === 'height') {
      const v = Math.max(0, Math.min(0xffffff, Math.round((h + 32768) * 256)));
      c = [v >> 16, (v >> 8) & 255, v & 255];
    } else {
      c = (BIOME_COLORS[b] || [80, 80, 80]).slice();
      if (b === 4) { const s = Math.max(0, Math.min(1, (h - 50) / 45)); c = c.map((v, k) => v + ([232, 236, 240][k] - v) * s); }
      const f = fbm((minX + px * mpp) / 60, (maxZ - py * mpp) / 60, 3);
      if ((b === 1 && f > 0.55) || b === 8) c = c.map((v, k) => v + ([40, 70, 36][k] - v) * (b === 8 ? 0.35 : 0.5));
      if (h < WATER) { const t = Math.sqrt(Math.min(1, (WATER - h) / 28)); const w = [52 + (20 - 52) * t, 116 + (44 - 116) * t, 148 + (82 - 148) * t]; const see = Math.max(0, 1 - (WATER - h) / 3.5) * 0.45; c = w.map((v, k) => v + (c[k] - v) * see); }
      else if (h < WATER + 2.2 && b !== 4) { const t = (WATER + 2.2 - h) / 2.2; c = c.map((v, k) => v + ([196, 184, 140][k] - v) * t * 0.8); }
      const dx = (H[i + 1] - H[i - 1]) / (2 * mpp), dz = (H[i - S] - H[i + S]) / (2 * mpp);
      const nx = -dx, ny = 1, nz = -dz, inv = 1 / Math.hypot(nx, ny, nz);
      const light = Math.max(0, (nx * sun[0] + ny * sun[1] + nz * sun[2]) * inv);
      const shade = 0.55 + 0.55 * light;
      c = c.map((v) => Math.max(0, Math.min(255, v * shade)));
    }
    const o = (py * TILE + px) * 3; out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2];
  }
  return png(out, TILE, TILE, 3);
}

// tree and rock discs for the overlay layer, like the mod's tiles/veg
const VEG_LOOK = { 1: [[86, 138, 58], 4.5], 2: [[44, 82, 52], 3.0], 3: [[56, 62, 40], 3.0], 4: [[74, 104, 112], 4.0], 5: [[70, 56, 46], 2.5], 6: [[70, 110, 50], 1.3], 7: [[118, 118, 112], 2.5], 8: [[134, 104, 74], 2.5], 9: [[96, 70, 44], 0.7], 10: [[90, 120, 60], 1.0], 11: [[60, 40, 34], 3.0] };
function renderVegTile(z, x, y) {
  const mpp = Math.pow(2, MAX_ZOOM - z), span = TILE * mpp;
  const minX = -WORLD_HALF + x * span, maxZ = WORLD_HALF - y * span, minZ = maxZ - span;
  const out = Buffer.alloc(TILE * TILE * 4);
  const c0x = Math.floor((minX + WORLD_HALF) / 256), c1x = Math.floor((minX + span - 1 + WORLD_HALF) / 256);
  const c0z = Math.floor((minZ + WORLD_HALF) / 256), c1z = Math.floor((maxZ - 1 + WORLD_HALF) / 256);
  const blend = (px, py, col, a) => { if (px < 0 || py < 0 || px >= TILE || py >= TILE || a <= 0) return; const o = (py * TILE + px) * 4; const oa = out[o + 3] / 255, na = a + oa * (1 - a); if (na <= 0) return; const w = a / na; for (let k = 0; k < 3; k++) out[o + k] += (col[k] - out[o + k]) * w; out[o + 3] = Math.round(na * 255); };
  for (let cz = c0z; cz <= c1z; cz++) for (let cx = c0x; cx <= c1x; cx++) {
    for (const p of vegPoints(cx, cz)) {
      const look = VEG_LOOK[p.kind]; if (!look) continue;
      const r = look[1] * p.size / mpp, cxp = (p.x - minX) / mpp - 0.5, cyp = (maxZ - p.z) / mpp - 0.5;
      if (r < 0.75) { blend(Math.round(cxp), Math.round(cyp), look[0], Math.min(1, r * 1.1) * 0.85); continue; }
      const sh = Math.min(r * 0.35, 3);
      for (const [ox, oy, rr, col, alpha, hl] of [[sh, sh, r * 0.95, [0, 0, 0], 0.28, 0], [0, 0, r, look[0], 0.93, p.kind === 7 || p.kind === 8 ? 0.35 : 0.55]]) {
        const x0 = Math.max(0, Math.floor(cxp + ox - rr)), x1 = Math.min(TILE - 1, Math.ceil(cxp + ox + rr)), y0 = Math.max(0, Math.floor(cyp + oy - rr)), y1 = Math.min(TILE - 1, Math.ceil(cyp + oy + rr));
        for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
          const dx = px - cxp - ox, dy = py - cyp - oy, d2 = dx * dx + dy * dy; if (d2 > rr * rr) continue;
          const d = Math.sqrt(d2) / rr, a = alpha * Math.min(1, (1 - d) * rr * 1.5);
          const l = 1 + hl * (-(dx + dy) / (rr * 1.4142)) - 0.25 * d;
          blend(px, py, hl ? col.map((v) => Math.max(0, Math.min(255, v * l))) : col, a);
        }
      }
    }
  }
  return png(out, TILE, TILE, 4);
}

function png(pixels, w, h, ch) {
  const stride = w * ch, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ch === 3 ? 2 : ch === 4 ? 6 : 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

// fog: explored around spawn and along a path
const FOG = 2048, FPX = 12;
const fog = Buffer.alloc(FOG * FOG, 0);
function reveal(x, z, r) { const cx = Math.round(x / FPX + 1024), cy = Math.round(z / FPX + 1024), rp = Math.ceil(r / FPX); for (let j = cy - rp; j <= cy + rp; j++) for (let i = cx - rp; i <= cx + rp; i++) if (i >= 0 && j >= 0 && i < FOG && j < FOG && (i - cx) ** 2 + (j - cy) ** 2 < rp * rp) fog[j * FOG + i] = 255; }
for (let t = 0; t < 400; t++) reveal(Math.sin(t / 25) * t * 6, Math.cos(t / 40) * t * 5 + 100, 260);
reveal(180, 120, 700);
function fogPng() { const flipped = Buffer.alloc(FOG * FOG); for (let y = 0; y < FOG; y++) fog.copy(flipped, y * FOG, (FOG - 1 - y) * FOG, (FOG - y) * FOG); return png(flipped, FOG, FOG, 1); }
function explored(x, z) { const i = Math.round(x / FPX + 1024), j = Math.round(z / FPX + 1024); return i >= 0 && j >= 0 && i < FOG && j < FOG && fog[j * FOG + i] > 0; }

// structures: a village near spawn
const pieces = [];
function addBuilding(bx, bz, w, d, mat, rot) {
  const y = height(bx, bz);
  const cos = Math.cos(rot * Math.PI / 180), sin = Math.sin(rot * Math.PI / 180);
  const put = (lx, lz, sx, sz, h, m, name) => pieces.push([+(bx + lx * cos + lz * sin).toFixed(1), +(bz - lx * sin + lz * cos).toFixed(1), +y.toFixed(1), rot, sx, sz, h, m, name]);
  for (let i = -w / 2 + 1; i < w / 2; i += 2) for (let j = -d / 2 + 1; j < d / 2; j += 2) put(i, j, 2, 2, 0.2, mat, 'wood_floor');
  for (let i = -w / 2 + 1; i < w / 2; i += 2) { put(i, -d / 2, 2, 0.3, 2, mat, 'wood_wall'); put(i, d / 2, 2, 0.3, 2, mat, 'wood_wall'); }
  for (let j = -d / 2 + 1; j < d / 2; j += 2) { put(-w / 2, j, 0.3, 2, 2, mat, 'wood_wall'); put(w / 2, j, 0.3, 2, 2, mat, 'wood_wall'); }
  for (let i = -w / 2 + 1; i < w / 2; i += 2) for (let j = -d / 2 + 1; j < d / 2; j += 2) put(i, j, 2, 2, 1, 6, 'wood_roof_45');
}
addBuilding(180, 120, 8, 12, 0, 0); addBuilding(200, 100, 6, 6, 3, 30); addBuilding(160, 140, 10, 8, 2, -20); addBuilding(150, 100, 4, 4, 4, 45);
pieces.push([190, 130, 42, 0, 2.2, 0.6, 3.2, 8, 'portal_wood']);
pieces.push([170, 115, 42, 0, 1.5, 1.5, 0.5, 7, 'fire_pit']);
for (let i = 0; i < 40; i++) pieces.push([+(120 + i * 2).toFixed(1), 60, +height(120 + i * 2, 60).toFixed(1), 0, 2, 0.2, 1.2, 0, 'wood_fence']);
const chunksIdx = new Map();
for (const p of pieces) { const k = `${Math.floor((p[0] + WORLD_HALF) / 256)}_${Math.floor((p[1] + WORLD_HALF) / 256)}`; if (!chunksIdx.has(k)) chunksIdx.set(k, []); chunksIdx.get(k).push(p); }
function chunkJson(cx, cz) {
  const list = chunksIdx.get(`${cx}_${cz}`) || [];
  const names = [], idx = new Map();
  const out = list.map((p) => { if (!idx.has(p[8])) { idx.set(p[8], names.length); names.push(p[8]); } return p.slice(0, 8).concat(idx.get(p[8])); });
  return JSON.stringify({ cx, cz, rev: 1, count: out.length, pieces: out, prefabs: names });
}
const vegCache = new Map();
function vegPoints(cx, cz) {
  const k = `${cx}_${cz}`;
  if (vegCache.has(k)) return vegCache.get(k);
  const minX = -WORLD_HALF + cx * 256, minZ = -WORLD_HALF + cz * 256;
  const pts = [];
  for (let i = 0; i < 600; i++) {
    const x = minX + hash(cx * 1000 + i, cz) * 256, z = minZ + hash(cz * 1000 + i, cx) * 256;
    const h = height(x, z); if (h < WATER + 1) continue;
    const b = biome(x, z, h); if (b === 4 && hash(i, 7) > 0.2) continue;
    const f = fbm(x / 60, z / 60, 3);
    let kind = 0;
    if (b === 8) kind = hash(i, 1) < 0.85 ? 2 : 7;
    else if (b === 1) kind = f > 0.55 ? (hash(i, 2) < 0.8 ? 1 : 6) : (hash(i, 3) < 0.08 ? 7 : 0);
    else if (b === 2) kind = hash(i, 4) < 0.5 ? 3 : 0;
    else if (b === 16) kind = hash(i, 5) < 0.15 ? 1 : 0;
    else if (b === 512) kind = hash(i, 6) < 0.3 ? 4 : hash(i, 8) < 0.5 ? 7 : 0;
    else if (b === 4) kind = 7;
    if (!kind) continue;
    if (Math.hypot(x - 180, z - 120) < 90) continue;
    pts.push({ x, z, h, kind, size: 0.7 + hash(i, 9) * 0.8 });
  }
  vegCache.set(k, pts);
  return pts;
}
function vegBin(cx, cz) {
  const minX = -WORLD_HALF + cx * 256, minZ = -WORLD_HALF + cz * 256;
  const pts = vegPoints(cx, cz).map((p) => [p.x, p.z, p.h, p.kind, p.size]);
  const b = Buffer.alloc(8 + pts.length * 8);
  b.write('VEG1', 0); b.writeUInt32LE(pts.length, 4);
  pts.forEach((p, i) => { const o = 8 + i * 8; b.writeInt16LE(Math.round((p[0] - minX) * 4), o); b.writeInt16LE(Math.round((p[1] - minZ) * 4), o + 2); b.writeInt16LE(Math.round(p[2] * 4), o + 4); b[o + 6] = p[3]; b[o + 7] = Math.round(p[4] * 32); });
  return b;
}

// ---------------------------------------------------------------- 3D model library (phase 2: real meshes)
// Valheim's string hash, so the mock's prefab ids match what the mod would send.
function stableHash(s) {
  let a = 5381, b = 5381;
  for (let i = 0; i < s.length; i += 2) {
    a = (Math.imul(a, 33) ^ s.charCodeAt(i)) | 0;
    if (i + 1 < s.length) b = (Math.imul(b, 33) ^ s.charCodeAt(i + 1)) | 0;
  }
  return (a + Math.imul(b, 1566083941)) | 0;
}
// tiny glTF 2.0 binary writer: primitives {pos:[], nrm:[], idx:[], rgb:[r,g,b]}
function glb(name, prims) {
  const bufs = [], views = [], accessors = [], materials = [], primitives = [];
  let off = 0;
  const push = (buf, target) => { const pad = (4 - buf.length % 4) % 4; bufs.push(buf, Buffer.alloc(pad)); views.push({ buffer: 0, byteOffset: off, byteLength: buf.length, target }); off += buf.length + pad; return views.length - 1; };
  const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (const p of prims) {
    const pos = Buffer.from(new Float32Array(p.pos).buffer), nrm = Buffer.from(new Float32Array(p.nrm).buffer), idx = Buffer.from(new Uint32Array(p.idx).buffer);
    const pmin = [1e9, 1e9, 1e9], pmax = [-1e9, -1e9, -1e9];
    for (let i = 0; i < p.pos.length; i += 3) for (let k = 0; k < 3; k++) { pmin[k] = Math.min(pmin[k], p.pos[i + k]); pmax[k] = Math.max(pmax[k], p.pos[i + k]); mn[k] = Math.min(mn[k], pmin[k]); mx[k] = Math.max(mx[k], pmax[k]); }
    const vp = push(pos, 34962), vn = push(nrm, 34962), vi = push(idx, 34963);
    accessors.push({ bufferView: vp, componentType: 5126, count: p.pos.length / 3, type: 'VEC3', min: pmin, max: pmax });
    accessors.push({ bufferView: vn, componentType: 5126, count: p.nrm.length / 3, type: 'VEC3' });
    accessors.push({ bufferView: vi, componentType: 5125, count: p.idx.length, type: 'SCALAR' });
    materials.push({ name: p.name || 'mat', pbrMetallicRoughness: { baseColorFactor: [p.rgb[0], p.rgb[1], p.rgb[2], 1], metallicFactor: 0, roughnessFactor: 0.9 }, doubleSided: true });
    const a = accessors.length - 3;
    primitives.push({ attributes: { POSITION: a, NORMAL: a + 1 }, indices: a + 2, material: materials.length - 1 });
  }
  const bin = Buffer.concat(bufs);
  const json = JSON.stringify({ asset: { version: '2.0', generator: 'webmap-mock' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name }], meshes: [{ name, primitives }], materials, accessors, bufferViews: views, buffers: [{ byteLength: bin.length }] });
  let jb = Buffer.from(json); const jpad = (4 - jb.length % 4) % 4; jb = Buffer.concat([jb, Buffer.alloc(jpad, 0x20)]);
  const head = Buffer.alloc(12); head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + jb.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jb.length, 0); jh.write('JSON', 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004E4942, 4);
  return { bytes: Buffer.concat([head, jh, jb, bh, bin]), bounds: [...mn, ...mx] };
}
// geometry helpers (all flat-shaded: each face has its own vertices)
function box(x0, y0, z0, x1, y1, z1, rgb, name) {
  const pos = [], nrm = [], idx = [];
  const face = (a, b, c, d, n) => { const s = pos.length / 3; pos.push(...a, ...b, ...c, ...d); for (let i = 0; i < 4; i++) nrm.push(...n); idx.push(s, s + 1, s + 2, s, s + 2, s + 3); };
  face([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]); face([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1]);
  face([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0]); face([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0]);
  face([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0]); face([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]);
  return { pos, nrm, idx, rgb, name };
}
function cone(r0, r1, y0, y1, n, rgb, name) {
  const pos = [], nrm = [], idx = [];
  for (let i = 0; i < n; i++) {
    const a0 = i / n * Math.PI * 2, a1 = (i + 1) / n * Math.PI * 2, am = (a0 + a1) / 2;
    const nx = Math.cos(am), nz = Math.sin(am), ny = (r0 - r1) / (y1 - y0);
    const s = pos.length / 3;
    pos.push(Math.cos(a0) * r0, y0, Math.sin(a0) * r0, Math.cos(a1) * r0, y0, Math.sin(a1) * r0, Math.cos(a1) * r1, y1, Math.sin(a1) * r1, Math.cos(a0) * r1, y1, Math.sin(a0) * r1);
    for (let k = 0; k < 4; k++) nrm.push(nx, ny, nz);
    idx.push(s, s + 2, s + 1, s, s + 3, s + 2);
  }
  return { pos, nrm, idx, rgb, name };
}
function wedge(w, d, h, rgb, name) {  // a 45 deg roof piece: triangle prism along x
  const pos = [], nrm = [], idx = [];
  const tri = (a, b, c, n) => { const s = pos.length / 3; pos.push(...a, ...b, ...c); for (let i = 0; i < 3; i++) nrm.push(...n); idx.push(s, s + 1, s + 2); };
  const quad = (a, b, c, d, n) => { tri(a, b, c, n); tri(a, c, d, n); };
  const k = 1 / Math.SQRT2;
  quad([-w / 2, 0, -d / 2], [w / 2, 0, -d / 2], [w / 2, h, d / 2], [-w / 2, h, d / 2], [0, k, -k]);
  quad([-w / 2, h, d / 2], [w / 2, h, d / 2], [w / 2, h - 0.15, d / 2], [-w / 2, h - 0.15, d / 2], [0, 0, 1]);
  quad([-w / 2, h - 0.15, d / 2], [w / 2, h - 0.15, d / 2], [w / 2, -0.15, -d / 2], [-w / 2, -0.15, -d / 2], [0, -k, k]);
  return { pos, nrm, idx, rgb, name };
}
const MODEL_DEFS = {
  wood_floor: { cat: 'piece', prims: [box(-1, -0.1, -1, 1, 0.1, 1, [0.55, 0.42, 0.26], 'wood')] },
  wood_wall: { cat: 'piece', prims: [box(-1, 0, -0.15, 1, 2, 0.15, [0.5, 0.38, 0.22], 'wood'), box(-0.95, 0.2, -0.17, 0.95, 0.3, 0.17, [0.42, 0.3, 0.16], 'beam'), box(-0.95, 1.7, -0.17, 0.95, 1.8, 0.17, [0.42, 0.3, 0.16], 'beam')] },
  wood_roof_45: { cat: 'piece', prims: [wedge(2, 2, 2, [0.36, 0.28, 0.2], 'roof')] },
  wood_fence: { cat: 'piece', prims: [box(-1, 0, -0.08, 1, 0.5, 0.08, [0.5, 0.4, 0.25], 'wood'), box(-1, 0.8, -0.08, 1, 1.1, 0.08, [0.5, 0.4, 0.25], 'wood'), box(-0.95, 0, -0.1, -0.8, 1.2, 0.1, [0.4, 0.3, 0.18], 'post'), box(0.8, 0, -0.1, 0.95, 1.2, 0.1, [0.4, 0.3, 0.18], 'post')] },
  portal_wood: { cat: 'piece', prims: [box(-1.1, 0, -0.3, -0.7, 3.2, 0.3, [0.35, 0.28, 0.2], 'wood'), box(0.7, 0, -0.3, 1.1, 3.2, 0.3, [0.35, 0.28, 0.2], 'wood'), box(-1.2, 3.0, -0.35, 1.2, 3.4, 0.35, [0.35, 0.28, 0.2], 'wood'), box(-0.7, 0.2, -0.02, 0.7, 3.0, 0.02, [0.6, 0.4, 0.9], 'glow')] },
  fire_pit: { cat: 'piece', prims: [cone(0.9, 0.7, 0, 0.35, 10, [0.45, 0.45, 0.45], 'stone'), cone(0.3, 0.05, 0.3, 0.9, 6, [1, 0.55, 0.1], 'fire')] },
  // trees: trunk geometry only; the canopy is billboard leaves drawn by the viewer over `k` bounds
  Beech1: { cat: 'tree', prims: [cone(0.35, 0.2, 0, 6, 8, [0.42, 0.3, 0.18], 'bark')], k: [-3.2, 4, -3.2, 3.2, 12, 3.2], kc: [0.3, 0.52, 0.2] },
  FirTree: { cat: 'tree', prims: [cone(0.3, 0.12, 0, 9, 8, [0.35, 0.24, 0.14], 'bark')], k: [-2.6, 2, -2.6, 2.6, 14, 2.6], kc: [0.12, 0.32, 0.18] },
  Bush01: { cat: 'bush', prims: [cone(0.1, 0.1, 0, 0.3, 5, [0.3, 0.2, 0.1], 'stem')], k: [-1.2, 0, -1.2, 1.2, 1.6, 1.2], kc: [0.24, 0.42, 0.18] },
  rock4_coast: { cat: 'rock', prims: [cone(3.5, 1.5, -1, 3.5, 7, [0.5, 0.5, 0.48], 'rock')] },
  StoneTower1: { cat: 'other', prims: [cone(4, 3.6, 0, 9, 12, [0.42, 0.42, 0.4], 'stone'), cone(4.2, 4.2, 9, 9.6, 12, [0.36, 0.36, 0.34], 'stone')] },
  Karve: { cat: 'other', prims: [box(-1.5, 0, -6, 1.5, 1.2, 6, [0.4, 0.3, 0.18], 'hull'), box(-0.1, 1.2, -0.3, 0.1, 7, 0.3, [0.5, 0.4, 0.25], 'mast')] },
};
const models = new Map();   // hash -> {name, cat, glb, bounds}
for (const [name, d] of Object.entries(MODEL_DEFS)) { const g = glb(name, d.prims); models.set(stableHash(name), { name, cat: d.cat, glb: g.bytes, bounds: g.bounds, tris: d.prims.reduce((s, p) => s + p.idx.length / 3, 0), k: d.k, kc: d.kc }); }
// one prefab deliberately without a model to exercise the box fallback
const NOMODEL = stableHash('piece_chest_wood');
function prefabsJson() {
  const prefabs = {};
  for (const [h, m] of models) { prefabs[h] = { n: m.name, c: m.cat, m: true, t: m.tris, x: false, b: m.bounds.map((v) => +v.toFixed(3)) }; if (m.k) { prefabs[h].k = m.k; prefabs[h].kc = m.kc; } }
  prefabs[NOMODEL] = { n: 'piece_chest_wood', c: 'piece', m: false, t: 0, x: false, b: [-0.5, 0, -0.4, 0.5, 0.8, 0.4] };
  return JSON.stringify({ rev: 1, format: 1, exported: models.size + 1, readable: models.size, unreadable: 1, queued: 0, prefabs });
}
// world objects: the village pieces (yaw -> quaternion about y), trees from the vegetation generator, a few extras
const objChunks = new Map();
function addObj(name, x, y, z, yawDeg, scale = 1, creator = false) {
  const cx = Math.floor((x + WORLD_HALF) / 256), cz = Math.floor((z + WORLD_HALF) / 256), k = `${cx}_${cz}`;
  if (!objChunks.has(k)) objChunks.set(k, []);
  const half = -yawDeg * Math.PI / 360;   // Unity y-rotation quaternion (game frame)
  objChunks.get(k).push({ prefab: stableHash(name), x, y, z, qx: 0, qy: Math.sin(half), qz: 0, qw: Math.cos(half), s: scale, creator });
}
for (const p of pieces) {
  const name = p[8] === 'wood_roof_45' ? 'wood_roof_45' : p[8];
  // pieces were laid out with their pivots at the piece centre; walls stand on the floor, roofs on the wall tops
  const yOff = name === 'wood_floor' ? 0.1 : name === 'wood_roof_45' ? 2.1 : 0;
  addObj(name, p[0], p[2] + yOff, p[1], p[3], 1, true);
}
addObj('piece_chest_wood', 176, 42.2, 118, 0, 1, true); addObj('piece_chest_wood', 178, 42.2, 118, 90, 1, true);
addObj('StoneTower1', -400, height(-400, -900), -900, 15); addObj('Karve', 240, WATER, -620, 70);
for (let cx = 38; cx <= 42; cx++) for (let cz = 38; cz <= 42; cz++) {
  const minX = -WORLD_HALF + cx * 256, minZ = -WORLD_HALF + cz * 256;
  const buf = vegBin(cx, cz), n = buf.readUInt32LE(4);
  for (let i = 0; i < n; i++) {
    const o = 8 + i * 8, x = minX + buf.readInt16LE(o) / 4, z = minZ + buf.readInt16LE(o + 2) / 4, y = buf.readInt16LE(o + 4) / 4, kind = buf[o + 6], size = buf[o + 7] / 32;
    const name = kind === 1 ? 'Beech1' : kind === 2 ? 'FirTree' : kind === 6 ? 'Bush01' : kind === 7 ? 'rock4_coast' : null;
    if (name) addObj(name, x, y, z, hash(i, cx * 7 + cz) * 360, size);
  }
}
function objectsIndex() { return JSON.stringify({ rev: 1, chunkSize: 256, chunks: [...objChunks.entries()].map(([k, v]) => [...k.split('_').map(Number), 1, v.length]) }); }
function objectsBin(cx, cz) {
  const list = objChunks.get(`${cx}_${cz}`); if (!list) return null;
  const table = [], ti = new Map();
  for (const o of list) if (!ti.has(o.prefab)) { ti.set(o.prefab, table.length); table.push(o.prefab); }
  const b = Buffer.alloc(12 + table.length * 4 + list.length * 44);
  b.write('OBJ1', 0); b.writeUInt32LE(list.length, 4); b.writeUInt32LE(table.length, 8);
  let o = 12; for (const h of table) { b.writeInt32LE(h, o); o += 4; }
  for (const x of list) {
    b.writeUInt16LE(ti.get(x.prefab), o); b[o + 2] = x.creator ? 1 : 0; b[o + 3] = 0; o += 4;
    for (const v of [x.x, x.y, x.z, x.qx, x.qy, x.qz, x.qw, x.s, x.s, x.s]) { b.writeFloatLE(v, o); o += 4; }
  }
  return b;
}

const markers = { rev: 1, sets: [
  { id: 'portals', label: 'Portals', markers: [{ x: 190, z: 130, y: 42, cat: 'portal', icon: 'portal', label: 'home', tag: 'home' }, { x: 1400, z: -280, y: 40, cat: 'portal', icon: 'portal', label: 'home', tag: 'home' }] },
  { id: 'tombstones', label: 'Tombstones', markers: [{ x: 620, z: 310, y: 40, cat: 'tombstone', icon: 'tombstone', label: "Ragnar's tombstone", owner: 'Ragnar', when: 638000000000000000 }] },
  { id: 'bases', label: 'Player bases', markers: [{ x: 178, z: 118, y: 42, cat: 'base', icon: 'house', label: 'home', pieces: 372 }] },
  { id: 'vehicles', label: 'Boats & carts', markers: [{ x: 240, z: -620, cat: 'boat', icon: 'boat', label: 'Karve' }] },
] };

const players = [{ id: 1, name: 'Ragnar', health: 88, maxHealth: 120, stamina: 63, eitr: 0, gear: { right: 'AxeBronze', left: 'ShieldWood', chest: 'ArmorBronzeChest', helmet: 'HelmetBronze', legs: 'ArmorBronzeLegs', shoulder: 'CapeDeerHide' }, x: 200, z: 140, y: 42, yaw: 40, biome: 'Meadows' }, { id: 2, name: 'Freya', health: 40, maxHealth: 95, x: 640, z: 320, y: 40, yaw: 200, biome: 'Black Forest' }, { id: 3, name: 'Hidden', health: 50, maxHealth: 50, hidden: true }];
let t = 0;
const events = [{ id: 1, ts: new Date().toISOString(), type: 'server', name: 'Server', text: 'online' }, { id: 2, ts: new Date().toISOString(), type: 'join', name: 'Ragnar', text: 'joined the server' }];
const stats = () => ({ server: { startedUtc: new Date(Date.now() - 3.6e6).toISOString(), online: 2, day: 142, dayFraction: 0.4, night: false, exploredPercent: 6.3, structures: pieces.length, trees: 12831, rocks: 2200, terraformedZones: 12, objects: 481200, lastSweepUtc: new Date().toISOString(), lastSweepSeconds: 4.2, tiles: { onDisk: 512, queued: 3, rendered: 512, avgMs: 140, maxRenderZoom: 7 } },
  onlineHistory: Array.from({ length: 288 }, (_, i) => [Math.floor(Date.now() / 1000) - (288 - i) * 300, Math.round(2 + 2 * Math.sin(i / 20) + (i % 7 === 0 ? 1 : 0))]),
  players: [{ key: 'a', name: 'Ragnar', playtime: 54000, sessions: 31, deaths: 7, distance: 182000, portalTrips: 40, online: true, lastSeen: new Date().toISOString(), biomes: ['Meadows', 'Black Forest'] }, { key: 'b', name: 'Freya', playtime: 32000, sessions: 18, deaths: 2, distance: 91000, portalTrips: 12, online: true, lastSeen: new Date().toISOString(), biomes: ['Meadows'] }, { key: 'c', name: 'Olaf', playtime: 9000, sessions: 4, deaths: 9, distance: 12000, portalTrips: 1, online: false, lastSeen: new Date(Date.now() - 2 * 864e5).toISOString(), lastX: 300, lastZ: -200, biomes: ['Meadows'] }] });
const pins = [{ owner: 'x', id: 'p1', type: 'mine', name: 'Ragnar', x: 520, z: 480, text: 'copper' }];
const config = { web_pins: true, world_name: process.env.WEBMAP_WORLD || 'Mockheim', title: process.env.WEBMAP_TITLE || 'Mock server', version: '1.0.0-mock', texture_size: FOG, pixel_size: FPX, max_zoom: 7, world_size: 20480, world_start_pos: '0,40,0', water_level: WATER, enable_3d: true, explore_radius: 100, update_interval: 1 };

// ---------------------------------------------------------------- http
const tileCache = new Map();
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const send = (code, body, type, extra = {}) => { res.writeHead(code, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-cache' }, extra)); res.end(body); };
  let m;
  if ((m = /^\/tiles\/(map|height|veg)\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(p))) {
    const [, layer, z, x, y] = m;
    const key = `${layer}/${z}/${x}/${y}`;
    if (layer === 'veg' && +z < 5) return send(404, 'no overlay below zoom 5', 'text/plain');
    if (+z > 5) {   // pretend close-zoom tiles only exist where explored
      const mpp = Math.pow(2, 7 - z), span = TILE * mpp, minX = -WORLD_HALF + x * span, maxZ = WORLD_HALF - y * span;
      let any = false;
      for (let j = 0; j < 4 && !any; j++) for (let i = 0; i < 4 && !any; i++) if (explored(minX + (i + .5) * span / 4, maxZ - (j + .5) * span / 4)) any = true;
      if (!any) return send(404, 'pending', 'text/plain', { 'X-WebMap-Tile': 'pending' });
    }
    if (!tileCache.has(key)) { if (tileCache.size > 4000) tileCache.clear(); tileCache.set(key, layer === 'veg' ? renderVegTile(+z, +x, +y) : renderTile(layer, +z, +x, +y)); }
    return send(200, tileCache.get(key), 'image/png');
  }
  if (p === '/config') return send(200, JSON.stringify(config), 'application/json');
  if (p === '/data/fog.png') return send(200, fogPng(), 'image/png');
  if (p === '/data/structures/index.json') return send(200, JSON.stringify({ rev: 1, chunkSize: 256, chunks: [...chunksIdx.entries()].map(([k, v]) => [...k.split('_').map(Number), 1, v.length]) }), 'application/json');
  if ((m = /^\/data\/structures\/(\d+)_(\d+)\.json$/.exec(p))) return send(200, chunkJson(+m[1], +m[2]), 'application/json');
  if ((m = /^\/data\/veg\/(\d+)_(\d+)\.bin$/.exec(p))) return send(200, vegBin(+m[1], +m[2]), 'application/octet-stream');
  if (p === '/data/prefabs.json') return send(200, prefabsJson(), 'application/json');
  if (p === '/data/objects/index.json') return send(200, objectsIndex(), 'application/json');
  if ((m = /^\/data\/objects\/(\d+)_(\d+)\.bin$/.exec(p))) { const b = objectsBin(+m[1], +m[2]); return b ? send(200, b, 'application/octet-stream') : send(404, 'no objects', 'text/plain'); }
  if ((m = /^\/models\/([0-9a-f]{8})\.glb$/.exec(p))) { const mdl = models.get(parseInt(m[1], 16) | 0); return mdl ? send(200, mdl.glb, 'model/gltf-binary', { 'Cache-Control': 'max-age=3600' }) : send(404, 'no model', 'text/plain'); }
  if (p === '/data/markers.json') return send(200, JSON.stringify(markers), 'application/json');
  if (p === '/data/players.json') return send(200, JSON.stringify({ count: players.length, players }), 'application/json');
  if (p === '/data/stats.json') return send(200, JSON.stringify(stats()), 'application/json');
  if (p === '/data/events.json') return send(200, JSON.stringify(events), 'application/json');
  if (p === '/data/pins.json') return send(200, JSON.stringify(pins), 'application/json');
  if (p === '/api/pin' && req.method === 'POST') {
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let f; try { f = JSON.parse(body); } catch (e) { return send(400, '{"error":"bad json"}', 'application/json'); }
      const owner = 'web:' + String(req.headers['x-webmap-client'] || f.client || 'anon').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
      const clean = (t, n) => String(t || '').replace(/[^a-zA-Z0-9 ]/g, '').trim().slice(0, n);
      const pin = { owner, id: `${Math.floor(Date.now() / 1000)}-${1000 + Math.floor(Math.random() * 9000)}`, type: ['dot', 'fire', 'mine', 'house', 'cave'].includes(f.type) ? f.type : 'dot', name: clean(f.name, 16) || 'web', x: Math.round(+f.x * 10) / 10, z: Math.round(+f.z * 10) / 10, text: clean(f.text, 20) };
      if (!isFinite(pin.x) || !isFinite(pin.z)) return send(400, '{"error":"need x and z"}', 'application/json');
      pins.push(pin); if (pins.length > 200) { const old = pins.shift(); broadcast({ t: 'rmpin', id: old.id }); }
      broadcast(Object.assign({ t: 'pin' }, pin));
      send(200, JSON.stringify({ id: pin.id, owner }), 'application/json');
    });
    return;
  }
  if (p === '/api/unpin' && req.method === 'POST') {
    const owner = 'web:' + String(req.headers['x-webmap-client'] || 'anon').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    const i = pins.findIndex((q) => q.id === u.searchParams.get('id') && q.owner === owner);
    if (i < 0) return send(404, '{"error":"not yours"}', 'application/json');
    pins.splice(i, 1); broadcast({ t: 'rmpin', id: u.searchParams.get('id') });
    return send(200, '{"removed":true}', 'application/json');
  }
  // static
  let rel = p === '/' ? 'index.html' : p.slice(1);
  if (rel.includes('..')) return send(404, 'no', 'text/plain');
  const file = path.join(WEB, rel);
  fs.readFile(file, (err, data) => {
    if (err) return send(404, 'not found', 'text/plain');
    send(200, data, MIME[path.extname(file).slice(1)] || 'application/octet-stream');
  });
});

// ---------------------------------------------------------------- websocket (RFC 6455, text frames only)
const clients = new Set();
server.on('upgrade', (req, socket) => {
  if (!/^\/(ws)?$/.test(req.url)) { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  clients.add(socket);
  socket.on('close', () => clients.delete(socket)); socket.on('error', () => clients.delete(socket));
  socket.on('data', (buf) => { if ((buf[0] & 0x0f) === 8) socket.end(); });
  wsSend(socket, JSON.stringify({ t: 'hello', version: '1.0.0-mock', worldRev: 1, config }));
  wsSend(socket, JSON.stringify({ t: 'players', data: { count: players.length, players } }));
  wsSend(socket, JSON.stringify({ t: 'events', data: events, initial: true }));
});
function wsSend(sock, text) {
  const payload = Buffer.from(text), len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x81, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  try { sock.write(Buffer.concat([head, payload])); } catch {}
}
function broadcast(obj) { const s = JSON.stringify(obj); for (const c of clients) wsSend(c, s); }

setInterval(() => {
  t += 1;
  players[0].x = +(200 + Math.sin(t / 20) * 60).toFixed(1); players[0].z = +(140 + Math.cos(t / 20) * 40).toFixed(1); players[0].yaw = (t * 9) % 360;
  // Freya walks a loop so a long-running demo never wanders off the map
  const lap = t % 1200, ang = lap / 1200 * Math.PI * 2;
  players[1].x = +(640 + Math.cos(ang) * 420).toFixed(1); players[1].z = +(320 + Math.sin(ang) * 260).toFixed(1); players[1].yaw = Math.round((90 - ang * 180 / Math.PI + 360) % 360); players[1].health = 40 + (t % 50);
  reveal(players[1].x, players[1].z, 100);
  if (events.length > 200) events.splice(0, events.length - 200);
  broadcast({ t: 'players', data: { count: players.length, players } });
  if (t % 15 === 0) { const e = { id: 100 + t, ts: new Date().toISOString(), type: t % 30 ? 'chat' : 'death', name: 'Freya', text: t % 30 ? 'anyone seen my karve?' : 'died', x: players[1].x, z: players[1].z }; events.push(e); broadcast({ t: 'events', data: [e] }); }
  if (t % 25 === 0) broadcast({ t: 'ping', id: 1, name: 'Ragnar', x: players[0].x + 50, z: players[0].z - 30 });
  if (t % 20 === 0) broadcast({ t: 'tiles', keys: ['7/42/39'], status: `${512 + t}/3` });
}, 1000);

server.listen(PORT, () => console.log(`mock WebMap on http://localhost:${PORT}`));
