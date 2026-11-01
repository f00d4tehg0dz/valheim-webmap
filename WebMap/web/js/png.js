// Height tiles read straight from the PNG bytes instead of through a canvas. getImageData is
// what privacy browsers perturb (Brave's fingerprinting protection, Firefox's resistFingerprinting),
// and on Terrarium-encoded heights one unit of red is 256 m, so that noise showed up in 3D as
// spikes (#18). Only what the server writes is supported: 8-bit RGB or RGBA, not interlaced.

// Terrarium RGB -> Float32Array of heights (row-major, north first)
export async function fetchTerrarium(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('missing ' + url);
  const { width, height, channels, data } = await decodePng(new Uint8Array(await res.arrayBuffer()));
  const n = width * height, out = new Float32Array(n);
  for (let i = 0, j = 0; j < n; i += channels, j++) out[j] = data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768;
  return out;
}

export async function decodePng(b) {
  if (typeof DecompressionStream === 'undefined') throw new Error('no DecompressionStream');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 8 || dv.getUint32(0) !== 0x89504e47) throw new Error('not a png');
  let o = 8, w = 0, h = 0, colourType = 0;
  const idat = [];
  while (o + 8 <= b.length) {
    const len = dv.getUint32(o), type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    if (type === 'IHDR') {
      w = dv.getUint32(o + 8); h = dv.getUint32(o + 12); colourType = b[o + 17];
      if (b[o + 16] !== 8 || (colourType !== 2 && colourType !== 6) || b[o + 20] !== 0) throw new Error('unsupported png');
    } else if (type === 'IDAT') idat.push(b.subarray(o + 8, o + 8 + len));
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  const channels = colourType === 6 ? 4 : 3, stride = w * channels;
  const raw = new Uint8Array(await new Response(new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  if (raw.length < (stride + 1) * h) throw new Error('truncated png');
  const out = new Uint8Array(stride * h);
  const c = channels;
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)], s = y * (stride + 1) + 1, d = y * stride, u = d - stride;
    let x = 0;
    switch (filter) {
      case 0: out.set(raw.subarray(s, s + stride), d); break;
      case 1: for (; x < c; x++) out[d + x] = raw[s + x]; for (; x < stride; x++) out[d + x] = raw[s + x] + out[d + x - c]; break;
      case 2: if (y) for (; x < stride; x++) out[d + x] = raw[s + x] + out[u + x]; else out.set(raw.subarray(s, s + stride), d); break;
      case 3:
        for (; x < c; x++) out[d + x] = raw[s + x] + (y ? out[u + x] >> 1 : 0);
        for (; x < stride; x++) out[d + x] = raw[s + x] + ((out[d + x - c] + (y ? out[u + x] : 0)) >> 1);
        break;
      case 4:
        for (; x < stride; x++) {
          const a = x >= c ? out[d + x - c] : 0, b = y ? out[u + x] : 0, cc = y && x >= c ? out[u + x - c] : 0;
          const p = a + b - cc, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - cc);
          out[d + x] = raw[s + x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : cc);
        }
        break;
      default: throw new Error('bad png filter');
    }
  }
  return { width: w, height: h, channels, data: out };
}
