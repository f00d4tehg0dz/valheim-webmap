using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using WebMap.Models.Unity;

namespace WebMap.Models
{
    // Pulls the meshes the engine keeps locked (Read/Write off, so Mesh.vertices throws)
    // out of the game's own asset files, on a background thread, into the mesh cache.
    // Same route as TextureExtractor: UnityFS bundle -> serialized file -> Mesh object
    // -> vertex streams (in the file or in its .resS) -> plain arrays. Without this,
    // most of the game's models (about seven in eight) could only be drawn as boxes.
    internal static class MeshExtractor
    {
        public static bool Running { get; private set; }
        public static string LastReport { get; private set; } = "";
        public static int LastFound { get; private set; }
        private static Thread thread;
        private static readonly HashSet<string> gaveUp = new HashSet<string>();

        // wanted: mesh keys (MeshCache.Key). Runs when nothing is running and something new is wanted.
        public static bool Start(ICollection<string> wanted, string modelsDir, Action onDone)
        {
            if (Running || wanted.Count == 0) return false;
            var keys = new HashSet<string>();
            lock (gaveUp) foreach (var w in wanted) if (!gaveUp.Contains(w)) keys.Add(w);
            if (keys.Count == 0) return false;
            string dataDir = UnityEngine.Application.dataPath;
            Running = true;
            thread = new Thread(() =>
            {
                try { Run(keys, dataDir, modelsDir); }
                catch (Exception e) { LastReport = "failed: " + e.Message; ZLog.LogWarning("WebMap: mesh extraction failed: " + e); }
                finally { Running = false; try { onDone?.Invoke(); } catch { } }
            }) { IsBackground = true, Name = "WebMap meshes", Priority = ThreadPriority.BelowNormal };
            thread.Start();
            return true;
        }

        private static void Run(HashSet<string> wanted, string dataDir, string modelsDir)
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();
            int total = wanted.Count, found = 0, files = 0, broken = 0;
            // names alone decide whether an object is worth decoding; the full key is checked after
            var names = new HashSet<string>();
            foreach (var k in wanted) names.Add(k.Substring(0, k.IndexOf('|')));
            ZLog.Log($"WebMap: extracting {total} meshes from the game files in {dataDir}");
            foreach (string path in TextureExtractor.AssetFiles(dataDir))
            {
                if (wanted.Count == 0) break;
                files++;
                try
                {
                    if (TextureExtractor.IsBundle(path))
                    {
                        using (var bundle = new BundleFile(path))
                            foreach (var node in bundle.Nodes)
                            {
                                if (wanted.Count == 0) break;
                                if (node.Name.EndsWith(".resS") || node.Name.EndsWith(".resource") || node.Size < 48 || node.Size > 512L * 1024 * 1024) continue;
                                byte[] data;
                                try { data = bundle.ReadNode(node); } catch { continue; }
                                if (!SerializedFile.Looks(data)) continue;
                                found += FromSerialized(path, bundle, data, wanted, names, modelsDir, ref broken);
                            }
                    }
                    else found += FromSerialized(path, null, File.ReadAllBytes(path), wanted, names, modelsDir, ref broken);
                }
                catch (Exception e) { if (WebMapConfig.DEBUG) ZLog.LogWarning($"WebMap: {Path.GetFileName(path)} skipped: {e.Message}"); }
            }
            lock (gaveUp) foreach (var w in wanted) gaveUp.Add(w);
            LastFound = found;
            LastReport = $"{found} of {total} meshes extracted from {files} files in {sw.Elapsed.TotalSeconds:F0}s" + (broken > 0 ? $", {broken} could not be decoded" : "") + (wanted.Count > 0 ? $", {wanted.Count} not found" : "");
            ZLog.Log("WebMap: " + LastReport);
        }

        private static int FromSerialized(string path, BundleFile bundle, byte[] data, HashSet<string> wanted, HashSet<string> names, string modelsDir, ref int broken)
        {
            SerializedFile sf;
            try { sf = new SerializedFile(data); } catch { return 0; }
            int found = 0;
            foreach (var o in sf.Objects)
            {
                if (sf.ClassOf(o) != 43) continue;
                // peek at the name before decoding the whole object: it is the first field
                string peek = PeekName(data, o);
                if (peek != null && !names.Contains(peek)) continue;
                SerializedFile.MeshData m;
                try { m = sf.ReadMesh(o); } catch { continue; }
                if (m == null || m.Name == null || !names.Contains(m.Name)) continue;
                int vcount = m.VertexCount > 0 ? m.VertexCount : CompressedCount(m);
                int idx0 = m.SubMeshes.Count > 0 ? SerializedFile.AsInt(m.SubMeshes[0], "indexCount") : 0;
                string key = MeshCache.Key(m.Name, vcount, m.SubMeshes.Count, idx0);
                if (!wanted.Contains(key)) { key = MeshCache.Key(m.Name, vcount, m.SubMeshes.Count, 0); if (!wanted.Contains(key)) continue; }
                byte[] vbytes = m.VertexBytes;
                if ((vbytes == null || vbytes.Length == 0) && m.VertexCount > 0 && !string.IsNullOrEmpty(m.StreamPath) && m.StreamSize > 0)
                {
                    string name = m.StreamPath.Substring(m.StreamPath.LastIndexOf('/') + 1);
                    try
                    {
                        if (bundle != null) { var rn = bundle.Find(name); if (rn == null) continue; vbytes = bundle.ReadRange(rn.Offset + m.StreamOffset, m.StreamSize); }
                        else
                        {
                            string ext = Path.Combine(Path.GetDirectoryName(path) ?? "", name);
                            if (!File.Exists(ext)) continue;
                            using (var fs = File.OpenRead(ext)) { fs.Seek(m.StreamOffset, SeekOrigin.Begin); vbytes = new byte[m.StreamSize]; int got = 0; while (got < m.StreamSize) { int r = fs.Read(vbytes, got, m.StreamSize - got); if (r <= 0) break; got += r; } }
                        }
                    }
                    catch { continue; }
                }
                MeshDecoder.Decoded dec = null;
                try { dec = MeshDecoder.Decode(m, vbytes); } catch (Exception e) { if (WebMapConfig.DEBUG) ZLog.LogWarning($"WebMap: mesh {m.Name}: {e.Message}"); }
                if (dec == null || dec.Positions == null || dec.SubMeshes.Count == 0) { broken++; wanted.Remove(key); lock (gaveUp) gaveUp.Add(key); ZLog.LogWarning($"WebMap: mesh {m.Name} could not be decoded (compression {m.MeshCompression}, {m.Channels.Count} channels)"); continue; }
                try
                {
                    MeshCache.Save(modelsDir, key, new MeshCache.Data { positions = dec.Positions, normals = dec.Normals, uvs = dec.Uvs, subMeshes = dec.SubMeshes });
                    wanted.Remove(key); found++;
                }
                catch (Exception e) { ZLog.LogWarning($"WebMap: could not write mesh {m.Name}: {e.Message}"); }
            }
            return found;
        }

        private static int CompressedCount(SerializedFile.MeshData m)
        {
            if (m.Compressed == null || !m.Compressed.TryGetValue("m_Vertices", out object v)) return 0;
            return SerializedFile.AsInt(v as Dictionary<string, object>, "m_NumItems") / 3;
        }

        // m_Name is the first field of every named object: length-prefixed UTF-8
        private static string PeekName(byte[] data, SerializedFile.ObjectInfo o)
        {
            try
            {
                int p = (int)o.Start;
                int len = data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | (data[p + 3] << 24);
                if (len < 0 || len > 512 || p + 4 + len > data.Length) return null;
                return System.Text.Encoding.UTF8.GetString(data, p + 4, len);
            }
            catch { return null; }
        }
    }
}
