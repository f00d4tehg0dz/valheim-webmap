#!/usr/bin/env python3
"""Pull locked meshes out of the Valheim game files into the mod's mesh cache.

The mod does this by itself (extract_meshes = true). This is the hand-run
fallback, and a way to look inside the game files:

  python3 tools/extract_meshes.py <valheim_server_Data> <plugins>/WebMap/map_data/models
  python3 tools/extract_meshes.py <valheim_server_Data> --dump Cart,beehive     # print what the files hold

Needs only the standard library. Reads the same models/index.json the mod
writes ("mw" lists per prefab) to know which meshes are wanted.
"""
import json, os, re, struct, sys, time, argparse, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract_textures import Bundle, LE, parse, read_value, looks_serialized, asset_files, is_bundle

FMT_SIZE = {0: 4, 1: 2, 2: 1, 3: 1, 4: 2, 5: 2, 6: 1, 7: 1, 8: 2, 9: 2, 10: 4, 11: 4}

def half(h):
    s = (h >> 15) & 1; e = (h >> 10) & 0x1F; m = h & 0x3FF
    if e == 0: v = m * 2.0 ** -24
    elif e == 31: v = float('inf') if m == 0 else float('nan')
    else: v = (1 + m / 1024.0) * 2.0 ** (e - 15)
    return -v if s else v

def component(b, p, fmt):
    if fmt == 0: return struct.unpack_from('<f', b, p)[0]
    if fmt == 1: return half(struct.unpack_from('<H', b, p)[0])
    if fmt == 2: return b[p] / 255.0
    if fmt == 3: return max(-1.0, struct.unpack_from('<b', b, p)[0] / 127.0)
    if fmt == 4: return struct.unpack_from('<H', b, p)[0] / 65535.0
    if fmt == 5: return max(-1.0, struct.unpack_from('<h', b, p)[0] / 32767.0)
    if fmt == 6: return b[p]
    if fmt == 7: return struct.unpack_from('<b', b, p)[0]
    if fmt == 8: return struct.unpack_from('<H', b, p)[0]
    if fmt == 9: return struct.unpack_from('<h', b, p)[0]
    if fmt == 10: return struct.unpack_from('<I', b, p)[0]
    if fmt == 11: return struct.unpack_from('<i', b, p)[0]
    return 0.0

def unpack_ints(pbv):
    n, bits, data = pbv.get('m_NumItems', 0), pbv.get('m_BitSize', 0), pbv.get('m_Data') or b''
    out = [0] * n
    if not bits: return out
    bitpos = idx = 0
    for i in range(n):
        v = got = 0
        while got < bits:
            if idx >= len(data): return out
            take = min(bits - got, 8 - bitpos)
            v |= ((data[idx] >> bitpos) & ((1 << take) - 1)) << got
            got += take; bitpos += take
            if bitpos == 8: bitpos = 0; idx += 1
        out[i] = v
    return out

def unpack_floats(pbv):
    ints = unpack_ints(pbv); bits = pbv.get('m_BitSize', 0)
    mx = float((1 << bits) - 1) if bits else 0.0
    st, rg = pbv.get('m_Start', 0.0), pbv.get('m_Range', 0.0)
    return [st + rg * (v / mx if mx else 0.0) for v in ints]

def decode(m, vbytes):
    """m: the Mesh dict from read_value; returns (positions, normals, uvs, [index lists]) or None"""
    vd = m.get('m_VertexData') or {}
    vc = vd.get('m_VertexCount', 0)
    chs = vd.get('m_Channels') or []
    pos = nrm = uv = None
    if vc and vbytes:
        nstreams = max((c['stream'] for c in chs), default=-1) + 1
        stride = [0] * nstreams
        for c in chs:
            dim = c['dimension'] & 0xF
            if dim: stride[c['stream']] += dim * FMT_SIZE.get(c['format'], 0)
        start = []; off = 0
        for s in range(nstreams):
            start.append(off); off += stride[s] * vc; off = (off + 15) & ~15
        def read(ch, want):
            if ch >= len(chs): return None
            c = chs[ch]; dim = c['dimension'] & 0xF
            if not dim: return None
            s, fmt, co = c['stream'], c['format'], c['offset']; fs = FMT_SIZE.get(fmt, 0); use = min(dim, want)
            out = [0.0] * (vc * want)
            for v in range(vc):
                p = start[s] + v * stride[s] + co
                if p + dim * fs > len(vbytes): return None
                for k in range(use): out[v * want + k] = component(vbytes, p + k * fs, fmt)
            return out
        pos, nrm, uv = read(0, 3), read(1, 3), read(4, 2)
    elif m.get('m_CompressedMesh'):
        c = m['m_CompressedMesh']
        pos = unpack_floats(c['m_Vertices']); vc = len(pos) // 3
        if c['m_Normals'].get('m_NumItems'):
            nxy = unpack_floats(c['m_Normals']); signs = unpack_ints(c['m_NormalSigns']); nrm = []
            for i in range(len(nxy) // 2):
                x, y = nxy[2 * i], nxy[2 * i + 1]; zz = 1 - x * x - y * y; z = math.sqrt(zz) if zz > 0 else 0.0
                if i < len(signs) and signs[i] == 0: z = -z
                nrm += [x, y, z]
            if len(nrm) != vc * 3: nrm = None
        if c['m_UV'].get('m_NumItems'):
            u = unpack_floats(c['m_UV']); info = c.get('m_UVInfo', 0); d0 = 2 if info == 0 else (info & 3) + 1
            if len(u) >= vc * d0: uv = [u[i * d0 + k] for i in range(vc) for k in range(2)]
    if not pos: return None
    subs = []
    if m.get('m_MeshCompression', 0) and m.get('m_CompressedMesh'):
        allidx = unpack_ints(m['m_CompressedMesh']['m_Triangles'])
        for sm in m['m_SubMeshes']:
            if sm.get('topology', 0) != 0: continue
            first, cnt, base = sm['firstByte'] // 2, sm['indexCount'], sm.get('baseVertex', 0)
            idx = [v + base for v in allidx[first:first + cnt]]
            if len(idx) == cnt and all(v < vc for v in idx): subs.append(idx)
    else:
        ib = m.get('m_IndexBuffer') or b''; u32 = m.get('m_IndexFormat', 0) == 1; sz = 4 if u32 else 2
        for sm in m['m_SubMeshes']:
            if sm.get('topology', 0) != 0: continue
            fb, cnt, base = sm['firstByte'], sm['indexCount'], sm.get('baseVertex', 0)
            if fb + cnt * sz > len(ib): continue
            idx = list(struct.unpack_from('<%d%s' % (cnt, 'I' if u32 else 'H'), ib, fb))
            idx = [v + base for v in idx]
            if all(v < vc for v in idx): subs.append(idx)
    if not subs: return None
    return pos, nrm, uv, subs

def key(name, vc, subs, idx0): return f"{name}|{vc}|{subs}|{idx0}"
def file_name(k):
    p = k.split('|'); n = re.sub(r'[^a-zA-Z0-9_.-]', '_', p[0])[:80]
    return f"mesh_{n}_{p[1] if len(p) > 1 else 0}_{p[2] if len(p) > 2 else 0}_{p[3] if len(p) > 3 else 0}.bin"

def write_bin(path, pos, nrm, uv, subs):
    with open(path + '.tmp', 'wb') as f:
        f.write(struct.pack('<II', 0x314d4d57, len(pos) // 3)); f.write(bytes([(1 if nrm else 0) | (2 if uv else 0)]))
        f.write(struct.pack('<%df' % len(pos), *pos))
        if nrm: f.write(struct.pack('<%df' % len(nrm), *nrm))
        if uv: f.write(struct.pack('<%df' % len(uv), *uv))
        f.write(struct.pack('<i', len(subs)))
        for s in subs: f.write(struct.pack('<i', len(s))); f.write(struct.pack('<%dI' % len(s), *s))
    os.replace(path + '.tmp', path)

def peek_name(data, start):
    ln = struct.unpack_from('<i', data, start)[0]
    if ln < 0 or ln > 512 or start + 4 + ln > len(data): return None
    return data[start + 4:start + 4 + ln].decode('utf-8', 'replace')

def scan_serialized(data, stream_read, names, on_mesh):
    types, objs = parse(data)
    for o in objs:
        cid, nodes = types[o[3]]
        if cid != 43 or nodes is None: continue
        pn = peek_name(data, o[1])
        if pn is not None and pn not in names: continue
        try: m, _ = read_value(LE(data, o[1]), nodes, 0)
        except Exception as e: print(f"  mesh at {o[1]}: read failed ({e})"); continue
        if m.get('m_Name') not in names: continue
        vd = m.get('m_VertexData') or {}; vb = vd.get('m_DataSize') or b''
        if not vb and vd.get('m_VertexCount', 0) and m.get('m_StreamData', {}).get('size'):
            sd = m['m_StreamData']
            try: vb = stream_read(sd['path'], sd['offset'], sd['size'])
            except Exception as e: print(f"  {m['m_Name']}: stream read failed ({e})"); continue
        on_mesh(m, vb)

def scan(path, names, on_mesh):
    if is_bundle(path):
        b = Bundle(path)
        try:
            for name, (off, sz) in b.nodes.items():
                if name.endswith(('.resS', '.resource')) or sz < 48: continue
                data = b.node(name)
                if not looks_serialized(data): continue
                scan_serialized(data, lambda p, o, s: b.read(b.nodes[p.split('/')[-1]][0] + o, s), names, on_mesh)
        finally: b.close()
    else:
        data = open(path, 'rb').read()
        if not looks_serialized(data): return
        def ext(p, o, s):
            with open(os.path.join(os.path.dirname(path), p.split('/')[-1]), 'rb') as f: f.seek(o); return f.read(s)
        scan_serialized(data, ext, names, on_mesh)

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("data_dir"); ap.add_argument("models_dir", nargs='?')
    ap.add_argument("--dump", help="comma-separated mesh names: print layout and a few values, write nothing")
    ap.add_argument("--all", action="store_true", help="rewrite meshes that are already cached")
    a = ap.parse_args()
    if not os.path.isdir(a.data_dir): sys.exit(f"not a directory: {a.data_dir}")
    t0 = time.time(); files = 0
    if a.dump:
        names = set(n.strip() for n in a.dump.split(',') if n.strip())
        def show(m, vb):
            vd = m.get('m_VertexData') or {}
            chs = [(c['stream'], c['offset'], c['format'], c['dimension'] & 0xF) for c in (vd.get('m_Channels') or []) if c['dimension'] & 0xF]
            print(f"{m['m_Name']}: verts {vd.get('m_VertexCount')} subs {len(m['m_SubMeshes'])} idxfmt {m.get('m_IndexFormat')} compression {m.get('m_MeshCompression')} data {len(vd.get('m_DataSize') or b'')}B stream {m.get('m_StreamData', {}).get('size', 0)}B channels(stream,off,fmt,dim) {chs}")
            for sm in m['m_SubMeshes']: print(f"   sub firstByte {sm['firstByte']} count {sm['indexCount']} base {sm.get('baseVertex')} first {sm.get('firstVertex')} verts {sm.get('vertexCount')}")
            d = decode(m, vb)
            if d is None: print("   decode: FAILED"); return
            pos, nrm, uv, subs = d
            xs, ys, zs = pos[0::3], pos[1::3], pos[2::3]
            print(f"   decoded: bounds x {min(xs):.2f}..{max(xs):.2f} y {min(ys):.2f}..{max(ys):.2f} z {min(zs):.2f}..{max(zs):.2f} normals {'yes' if nrm else 'no'} uv {'yes' if uv else 'no'} tris {[len(s) // 3 for s in subs]}")
        for path in asset_files(a.data_dir):
            files += 1
            try: scan(path, names, show)
            except Exception as e: print(f"  skip {os.path.basename(path)}: {e}")
        print(f"looked through {files} files in {time.time() - t0:.0f}s"); return
    if not a.models_dir: sys.exit("models_dir needed (or --dump)")
    idx = os.path.join(a.models_dir, 'index.json')
    if not os.path.isfile(idx): sys.exit(f"{idx} not found: start the server once so the mod lists what it needs")
    doc = json.load(open(idx, encoding='utf-8'))
    wanted = set()
    for p in doc.get('prefabs', {}).values():
        for k in p.get('mm', p.get('mw', [])): wanted.add(k)
    outdir = os.path.join(a.models_dir, 'meshes'); os.makedirs(outdir, exist_ok=True)
    if not a.all: wanted = {k for k in wanted if not os.path.isfile(os.path.join(outdir, file_name(k)))}
    if not wanted: print("nothing to do: every locked mesh is already cached"); return
    names = {k.split('|')[0] for k in wanted}
    print(f"{len(wanted)} mesh(es) wanted"); done = [0]
    def save(m, vb):
        vd = m.get('m_VertexData') or {}
        vc = vd.get('m_VertexCount', 0) or (m.get('m_CompressedMesh', {}).get('m_Vertices', {}).get('m_NumItems', 0) // 3)
        idx0 = m['m_SubMeshes'][0]['indexCount'] if m['m_SubMeshes'] else 0
        k = key(m['m_Name'], vc, len(m['m_SubMeshes']), idx0)
        if k not in wanted:
            k = key(m['m_Name'], vc, len(m['m_SubMeshes']), 0)
            if k not in wanted: return
        d = decode(m, vb)
        if d is None: print(f"  {m['m_Name']}: could not decode"); wanted.discard(k); return
        write_bin(os.path.join(outdir, file_name(k)), *d); wanted.discard(k); done[0] += 1
        print(f"  {m['m_Name']} verts {vc} tris {[len(s) // 3 for s in d[3]]}")
    for path in asset_files(a.data_dir):
        if not wanted: break
        files += 1
        try: scan(path, names, save)
        except Exception as e: print(f"  skip {os.path.basename(path)}: {e}")
    print(f"wrote {done[0]} mesh(es) from {files} files in {time.time() - t0:.0f}s" + (f"; not found: {len(wanted)}" if wanted else ""))

if __name__ == "__main__":
    main()
