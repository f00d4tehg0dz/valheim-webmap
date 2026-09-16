using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;

namespace WebMap.Models
{
    // Meshes the engine will not hand over (Read/Write off) as plain files under
    // map_data/models/meshes/, written by MeshExtractor from the game's own asset
    // files and read back by PrefabExporter. Keyed by name + vertex count + sub-mesh
    // count, which is all a locked mesh still tells us at runtime. Game data:
    // stays on the server, never served, never shipped.
    internal static class MeshCache
    {
        public sealed class Data
        {
            public float[] positions, normals, uvs;   // Unity's own frame, like Mesh.vertices
            public List<uint[]> subMeshes = new List<uint[]>();
        }

        private const uint MAGIC = 0x314d4d57;   // "WMM1"
        private static readonly Regex unsafeChars = new Regex("[^a-zA-Z0-9_.-]", RegexOptions.Compiled);

        // indexCount0: index count of the first sub-mesh, 0 when the engine would not say; it tells apart the
        // many meshes that share a name like "default" or "Cube"
        public static string Key(string name, int vertexCount, int subMeshes, int indexCount0) => name + "|" + vertexCount + "|" + subMeshes + "|" + indexCount0;

        public static string FileName(string key)
        {
            string[] p = key.Split('|');
            string n = unsafeChars.Replace(p[0], "_");
            if (n.Length > 80) n = n.Substring(0, 80);
            return "mesh_" + n + "_" + (p.Length > 1 ? p[1] : "0") + "_" + (p.Length > 2 ? p[2] : "0") + "_" + (p.Length > 3 ? p[3] : "0") + ".bin";
        }

        public static string Dir(string modelsDir) => Path.Combine(modelsDir, "meshes");

        public static bool Exists(string modelsDir, string key) => File.Exists(Path.Combine(Dir(modelsDir), FileName(key)));

        public static void Save(string modelsDir, string key, Data d)
        {
            Directory.CreateDirectory(Dir(modelsDir));
            string file = Path.Combine(Dir(modelsDir), FileName(key)), tmp = file + ".tmp";
            using (var fs = File.Create(tmp))
            using (var w = new BinaryWriter(fs))
            {
                w.Write(MAGIC);
                int vc = d.positions.Length / 3;
                w.Write(vc);
                w.Write((byte)((d.normals != null ? 1 : 0) | (d.uvs != null ? 2 : 0)));
                foreach (float f in d.positions) w.Write(f);
                if (d.normals != null) foreach (float f in d.normals) w.Write(f);
                if (d.uvs != null) foreach (float f in d.uvs) w.Write(f);
                w.Write(d.subMeshes.Count);
                foreach (var sm in d.subMeshes) { w.Write(sm.Length); foreach (uint i in sm) w.Write(i); }
            }
            if (File.Exists(file)) File.Delete(file);
            File.Move(tmp, file);
        }

        public static Data Load(string modelsDir, string key)
        {
            string file = Path.Combine(Dir(modelsDir), FileName(key));
            if (!File.Exists(file)) return null;
            try
            {
                using (var fs = File.OpenRead(file))
                using (var r = new BinaryReader(fs))
                {
                    if (r.ReadUInt32() != MAGIC) return null;
                    int vc = r.ReadInt32(); byte flags = r.ReadByte();
                    if (vc <= 0 || vc > 4_000_000) return null;
                    var d = new Data { positions = new float[vc * 3] };
                    for (int i = 0; i < d.positions.Length; i++) d.positions[i] = r.ReadSingle();
                    if ((flags & 1) != 0) { d.normals = new float[vc * 3]; for (int i = 0; i < d.normals.Length; i++) d.normals[i] = r.ReadSingle(); }
                    if ((flags & 2) != 0) { d.uvs = new float[vc * 2]; for (int i = 0; i < d.uvs.Length; i++) d.uvs[i] = r.ReadSingle(); }
                    int ns = r.ReadInt32();
                    for (int s = 0; s < ns && s < 256; s++)
                    {
                        int n = r.ReadInt32(); if (n < 0 || n > 50_000_000) return null;
                        var idx = new uint[n]; for (int i = 0; i < n; i++) idx[i] = r.ReadUInt32();
                        d.subMeshes.Add(idx);
                    }
                    return d;
                }
            }
            catch (Exception e) { ZLog.LogWarning("WebMap: mesh file " + Path.GetFileName(file) + " unreadable: " + e.Message); return null; }
        }
    }
}
