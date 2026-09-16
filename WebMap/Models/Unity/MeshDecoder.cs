using System;
using System.Collections.Generic;

namespace WebMap.Models.Unity
{
    // Turns a Mesh object's packed vertex streams (or its compressed form) into plain
    // arrays: positions, normals, first UV set, and one index list per sub-mesh.
    // Same layout rules the engine uses: channels 0 position, 1 normal, 2 tangent,
    // 3 colour, 4.. texcoords; streams laid out one after another, 16-byte aligned.
    internal static class MeshDecoder
    {
        public sealed class Decoded
        {
            public string Name; public int VertexCount;
            public float[] Positions; public float[] Normals; public float[] Uvs;   // xyz / xyz / uv, Unity's own frame
            public List<uint[]> SubMeshes = new List<uint[]>();                     // absolute vertex indices, triangles
        }

        // vertexBytes: m_DataSize, or the bytes fetched from the .resS stream when m_DataSize is empty
        public static Decoded Decode(SerializedFile.MeshData m, byte[] vertexBytes)
        {
            var d = new Decoded { Name = m.Name, VertexCount = m.VertexCount };
            if (m.VertexCount > 0 && vertexBytes != null && vertexBytes.Length > 0) DecodeStreams(m, vertexBytes, d);
            else if (m.Compressed != null) DecodeCompressed(m, d);
            else return null;
            if (d.Positions == null) return null;

            // sub-mesh triangles
            if (m.MeshCompression != 0 && m.Compressed != null && m.Compressed.TryGetValue("m_Triangles", out object tri))
            {
                uint[] all = UnpackInts(tri as Dictionary<string, object>);
                foreach (var sm in m.SubMeshes)
                {
                    int first = (int)(SerializedFile.AsLong(sm, "firstByte") / 2), count = SerializedFile.AsInt(sm, "indexCount");
                    if (SerializedFile.AsInt(sm, "topology") != 0) continue;
                    var sl = Slice(all, first, count, (uint)SerializedFile.AsLong(sm, "baseVertex"), d.VertexCount);
                    if (sl != null) d.SubMeshes.Add(sl);
                }
            }
            else if (m.IndexBuffer != null)
            {
                bool u32 = m.IndexFormat == 1;
                foreach (var sm in m.SubMeshes)
                {
                    int firstByte = (int)SerializedFile.AsLong(sm, "firstByte"), count = SerializedFile.AsInt(sm, "indexCount");
                    if (SerializedFile.AsInt(sm, "topology") != 0 || count < 3) continue;   // triangles only
                    uint baseVertex = (uint)SerializedFile.AsLong(sm, "baseVertex");
                    var idx = new uint[count];
                    for (int i = 0; i < count; i++)
                    {
                        int p = firstByte + i * (u32 ? 4 : 2);
                        if (p + (u32 ? 4 : 2) > m.IndexBuffer.Length) { idx = null; break; }
                        uint v = u32 ? BitConverter.ToUInt32(m.IndexBuffer, p) : BitConverter.ToUInt16(m.IndexBuffer, p);
                        v += baseVertex;
                        if (v >= (uint)d.VertexCount) { idx = null; break; }
                        idx[i] = v;
                    }
                    if (idx != null) d.SubMeshes.Add(idx);
                }
            }
            return d.SubMeshes.Count > 0 ? d : null;
        }

        private static uint[] Slice(uint[] all, int first, int count, uint baseVertex, int vertexCount)
        {
            if (first < 0 || first + count > all.Length) return null;
            var idx = new uint[count];
            for (int i = 0; i < count; i++) { uint v = all[first + i] + baseVertex; if (v >= (uint)vertexCount) return null; idx[i] = v; }
            return idx;
        }

        // vertex format enum (2019+): Float, Float16, UNorm8, SNorm8, UNorm16, SNorm16, UInt8, SInt8, UInt16, SInt16, UInt32, SInt32
        private static int FormatSize(int f) { switch (f) { case 0: case 10: case 11: return 4; case 1: case 4: case 5: case 8: case 9: return 2; default: return 1; } }

        private static void DecodeStreams(SerializedFile.MeshData m, byte[] bytes, Decoded d)
        {
            int vc = m.VertexCount;
            var chs = m.Channels;
            int nStreams = 0;
            foreach (var c in chs) nStreams = Math.Max(nStreams, SerializedFile.AsInt(c, "stream") + 1);
            var stride = new int[nStreams]; var start = new long[nStreams];
            for (int ci = 0; ci < chs.Count; ci++)
            {
                var c = chs[ci]; int dim = SerializedFile.AsInt(c, "dimension") & 0xF;
                if (dim == 0) continue;
                stride[SerializedFile.AsInt(c, "stream")] += dim * FormatSize(SerializedFile.AsInt(c, "format"));
            }
            long off = 0;
            for (int s = 0; s < nStreams; s++) { start[s] = off; off += (long)stride[s] * vc; off = (off + 15) & ~15L; }

            float[] Read(int channel, int wantDim)
            {
                if (channel >= chs.Count) return null;
                var c = chs[channel]; int dim = SerializedFile.AsInt(c, "dimension") & 0xF;
                if (dim == 0) return null;
                int s = SerializedFile.AsInt(c, "stream"), fmt = SerializedFile.AsInt(c, "format"), co = SerializedFile.AsInt(c, "offset");
                int fs = FormatSize(fmt), use = Math.Min(dim, wantDim);
                var o = new float[vc * wantDim];
                for (int v = 0; v < vc; v++)
                {
                    long p = start[s] + (long)v * stride[s] + co;
                    if (p + dim * fs > bytes.Length) return null;
                    for (int k = 0; k < use; k++) o[v * wantDim + k] = ReadComponent(bytes, (int)p + k * fs, fmt);
                }
                return o;
            }
            d.Positions = Read(0, 3);
            d.Normals = Read(1, 3);
            d.Uvs = Read(4, 2);
        }

        private static float ReadComponent(byte[] b, int p, int fmt)
        {
            switch (fmt)
            {
                case 0: return BitConverter.ToSingle(b, p);
                case 1: return Half(BitConverter.ToUInt16(b, p));
                case 2: return b[p] / 255f;
                case 3: return Math.Max(-1f, (sbyte)b[p] / 127f);
                case 4: return BitConverter.ToUInt16(b, p) / 65535f;
                case 5: return Math.Max(-1f, BitConverter.ToInt16(b, p) / 32767f);
                case 6: return b[p];
                case 7: return (sbyte)b[p];
                case 8: return BitConverter.ToUInt16(b, p);
                case 9: return BitConverter.ToInt16(b, p);
                case 10: return BitConverter.ToUInt32(b, p);
                case 11: return BitConverter.ToInt32(b, p);
                default: return 0f;
            }
        }

        private static float Half(ushort h)
        {
            int sign = (h >> 15) & 1, exp = (h >> 10) & 0x1F, mant = h & 0x3FF;
            float v;
            if (exp == 0) v = mant * (float)Math.Pow(2, -24);
            else if (exp == 31) v = mant == 0 ? float.PositiveInfinity : float.NaN;
            else v = (1f + mant / 1024f) * (float)Math.Pow(2, exp - 15);
            return sign == 1 ? -v : v;
        }

        // ---- compressed meshes (m_MeshCompression != 0): packed bit vectors

        private static uint[] UnpackInts(Dictionary<string, object> pbv)
        {
            if (pbv == null) return new uint[0];
            int n = SerializedFile.AsInt(pbv, "m_NumItems"), bits = SerializedFile.AsInt(pbv, "m_BitSize");
            byte[] data = pbv.TryGetValue("m_Data", out object dd) ? dd as byte[] : null;
            var o = new uint[n];
            if (data == null || bits == 0) return o;
            int bitPos = 0, idx = 0;
            for (int i = 0; i < n; i++)
            {
                uint v = 0; int got = 0;
                while (got < bits)
                {
                    if (idx >= data.Length) return o;
                    int take = Math.Min(bits - got, 8 - bitPos);
                    v |= (uint)(((data[idx] >> bitPos) & ((1 << take) - 1)) << got);
                    got += take; bitPos += take;
                    if (bitPos == 8) { bitPos = 0; idx++; }
                }
                o[i] = v;
            }
            return o;
        }

        private static float[] UnpackFloats(Dictionary<string, object> pbv)
        {
            if (pbv == null) return null;
            uint[] ints = UnpackInts(pbv);
            int bits = SerializedFile.AsInt(pbv, "m_BitSize");
            float range = SerializedFile.AsFloat(pbv, "m_Range"), startV = SerializedFile.AsFloat(pbv, "m_Start");
            float max = bits >= 32 ? 4294967295f : (float)((1L << bits) - 1);
            var o = new float[ints.Length];
            for (int i = 0; i < ints.Length; i++) o[i] = startV + range * (max > 0 ? ints[i] / max : 0f);
            return o;
        }

        private static void DecodeCompressed(SerializedFile.MeshData m, Decoded d)
        {
            var c = m.Compressed;
            Dictionary<string, object> P(string k) => c.TryGetValue(k, out object v) ? v as Dictionary<string, object> : null;
            float[] verts = UnpackFloats(P("m_Vertices"));
            if (verts == null || verts.Length < 3) return;
            d.VertexCount = verts.Length / 3;
            d.Positions = verts;
            var nrmP = P("m_Normals");
            if (nrmP != null && SerializedFile.AsInt(nrmP, "m_NumItems") > 0)
            {
                float[] nxy = UnpackFloats(nrmP); uint[] signs = UnpackInts(P("m_NormalSigns"));
                int n = nxy.Length / 2;
                var o = new float[n * 3];
                for (int i = 0; i < n; i++)
                {
                    float x = nxy[i * 2], y = nxy[i * 2 + 1];
                    float zz = 1f - x * x - y * y; float z = zz > 0 ? (float)Math.Sqrt(zz) : 0f;
                    if (i < signs.Length && signs[i] == 0) z = -z;
                    o[i * 3] = x; o[i * 3 + 1] = y; o[i * 3 + 2] = z;
                }
                if (n == d.VertexCount) d.Normals = o;
            }
            var uvP = P("m_UV");
            if (uvP != null && SerializedFile.AsInt(uvP, "m_NumItems") > 0)
            {
                float[] uv = UnpackFloats(uvP);
                uint info = (uint)SerializedFile.AsLong(c, "m_UVInfo");
                // m_UVInfo packs (dimension-1, exists) per channel, 4 bits each; 0 means "uv0 with 2 floats"
                int dim0 = info == 0 ? 2 : (int)((info & 3) + 1);
                if (uv.Length >= d.VertexCount * dim0)
                {
                    var o = new float[d.VertexCount * 2];
                    for (int i = 0; i < d.VertexCount; i++) { o[i * 2] = uv[i * dim0]; o[i * 2 + 1] = uv[i * dim0 + 1]; }
                    d.Uvs = o;
                }
            }
        }
    }
}
