using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using UnityEngine;
using WebMap.Tiles;
using WebMap.Util;

namespace WebMap.Models
{
    // The model library: one glTF per prefab the world contains, exported on
    // the game thread a few per frame and kept on disk under
    // map_data/models (prefabs are the same for every world). An index
    // records what was exported, with bounds and triangle counts, so a
    // restart exports nothing again and the browser knows which prefabs
    // have a model and which need a box.
    internal static class ModelStore
    {
        public const int FORMAT = 5;   // 5: locked meshes come from the mesh cache; index records which ones each prefab needs

        public sealed class Info
        {
            public int hash; public string name; public string cat; public bool ok; public int tris; public bool tex; public float[] bounds = new float[6]; public int renderers, unreadable;
            public List<string> wants = new List<string>();   // texture names its materials reference
            public List<string> meshWants = new List<string>();     // locked meshes it uses from the mesh cache (MeshCache.Key)
            public List<string> meshMissing = new List<string>();   // those the cache did not have when it was exported
            public float[] canopy;            // foliage bounds in model space (x0,y0,z0,x1,y1,z1), or null
            public string canopyTex;          // leaf texture file, or null
            public float[] canopyColor;       // leaf tint 0..1
        }

        private static string root;
        private static readonly ConcurrentDictionary<int, Info> index = new ConcurrentDictionary<int, Info>();
        private static readonly Queue<int> queue = new Queue<int>();
        private static readonly HashSet<int> queued = new HashSet<int>();
        private static readonly Dictionary<int, string> catOf = new Dictionary<int, string>();
        private static volatile string prefabsJson = "{\"rev\":0,\"prefabs\":{}}";
        private static int rev;
        private static bool indexDirty;
        private static int idleTicks;
        private static volatile bool extractDone;
        private static volatile bool meshDone;
        public static int Exported { get; private set; }
        public static int Readable { get; private set; }
        public static int Unreadable { get; private set; }

        public static string Root => root;
        public static string PrefabsJson => prefabsJson;
        public static int QueueLength { get { lock (queue) return queue.Count; } }

        public static void Init(string mapDataPath)
        {
            root = Path.Combine(mapDataPath, "models");
            Directory.CreateDirectory(root);
            index.Clear();
            try
            {
                string path = Path.Combine(root, "index.json");
                if (File.Exists(path))
                {
                    var doc = JsonParser.ParseObject(File.ReadAllText(path));
                    if ((int)JsonParser.Num(doc, "format") == FORMAT)
                    {
                        var ps = JsonParser.Obj(doc, "prefabs");
                        if (ps != null)
                            foreach (var kv in ps)
                            {
                                var d = kv.Value as Dictionary<string, object>;
                                if (d == null || !int.TryParse(kv.Key, NumberStyles.Integer, CultureInfo.InvariantCulture, out int h)) continue;
                                var info = new Info { hash = h, name = JsonParser.Str(d, "n"), cat = JsonParser.Str(d, "c"), ok = JsonParser.Bool(d, "m"), tris = (int)JsonParser.Num(d, "t"), tex = JsonParser.Bool(d, "x") };
                                var b = JsonParser.Arr(d, "b");
                                if (b != null && b.Count == 6) for (int i = 0; i < 6; i++) info.bounds[i] = (float)(b[i] is double x ? x : 0);
                                var w = JsonParser.Arr(d, "w");
                                if (w != null) foreach (var o in w) if (o is string ws) info.wants.Add(ws);
                                var mw = JsonParser.Arr(d, "mw");
                                if (mw != null) foreach (var o in mw) if (o is string ms) info.meshWants.Add(ms);
                                var mm = JsonParser.Arr(d, "mm");
                                if (mm != null) foreach (var o in mm) if (o is string ms) info.meshMissing.Add(ms);
                                info.renderers = (int)JsonParser.Num(d, "r"); info.unreadable = (int)JsonParser.Num(d, "u");
                                var k = JsonParser.Arr(d, "k");
                                if (k != null && k.Count == 6) { info.canopy = new float[6]; for (int i = 0; i < 6; i++) info.canopy[i] = (float)(k[i] is double x ? x : 0); }
                                info.canopyTex = JsonParser.Str(d, "kt", null);
                                var kc = JsonParser.Arr(d, "kc");
                                if (kc != null && kc.Count == 3) { info.canopyColor = new float[3]; for (int i = 0; i < 3; i++) info.canopyColor[i] = (float)(kc[i] is double x ? x : 0); }
                                // only trust entries whose file still exists
                                if (!info.ok || File.Exists(Path.Combine(root, FileName(h)))) index[h] = info;
                            }
                    }
                }
            }
            catch (Exception e) { ZLog.LogWarning("WebMap: models/index.json not readable: " + e.Message); }
            foreach (var i in index.Values) if (i.ok) Readable++; else if (i.renderers > 0) Unreadable++;
            // textures and meshes extracted since the last run: re-export the models that use them
            int again = RescanTextures() + RescanMeshes();
            WriteTexturesJson();
            Rebuild();
            ZLog.Log($"WebMap: model library at {root}: {index.Count} prefabs known" + (again > 0 ? $", {again} to re-export with newly extracted textures or meshes" : ""));
        }

        // Models with a locked mesh whose cache file now exists (the mesh extractor ran): re-export them.
        public static int RescanMeshes()
        {
            int again = 0;
            foreach (var i in index.Values)
            {
                if (i.meshMissing.Count == 0) continue;
                bool needs = false;
                foreach (var k in i.meshMissing) if (MeshCache.Exists(root, k)) { needs = true; break; }
                if (needs) { Request(i.hash, i.cat, force: true); again++; }
            }
            return again;
        }

        // mesh keys the models need that have no cache file yet
        public static List<string> MissingMeshes()
        {
            var seen = new HashSet<string>(); var list = new List<string>();
            foreach (var i in index.Values)
                foreach (var k in i.meshMissing)
                    if (seen.Add(k) && !MeshCache.Exists(root, k)) list.Add(k);
            return list;
        }
        public static int MeshesWanted { get; private set; }
        public static int MeshesPresent { get; private set; }

        // Models that still lack a texture one of their materials wants, when that file now exists
        // (the extractor ran while the server was up): queue them for re-export. Returns the count.
        public static int RescanTextures()
        {
            if (!WebMapConfig.USE_TEXTURES) return 0;
            int again = 0;
            var missing = new HashSet<string>();
            foreach (var i in index.Values)
            {
                // a prefab with no geometry can never become textured: re-exporting it forever helps nobody
                if (i.wants.Count == 0 || !i.ok) continue;
                bool needs = false;
                foreach (var w in i.wants)
                {
                    string file = PrefabExporter.TextureFileName(w);
                    bool present = File.Exists(Path.Combine(root, file));
                    // a model is stale if a texture it wants exists but the model was exported without it
                    if (present && (!i.tex || (i.canopy != null && i.canopyTex == null && IsFoliageWant(w)))) needs = true;
                }
                if (needs) { Request(i.hash, i.cat, force: true); again++; }
            }
            if (again > 0) PrefabExporter.ForgetMissingTextures();
            return again;
        }
        // texture names the models reference that have no file yet
        public static List<string> MissingTextures()
        {
            var seen = new HashSet<string>(); var list = new List<string>();
            foreach (var i in index.Values)
                foreach (var w in i.wants)
                    if (seen.Add(w) && !File.Exists(Path.Combine(root, PrefabExporter.TextureFileName(w)))) list.Add(w);
            return list;
        }

        private static bool IsFoliageWant(string texName)
        {
            string n = texName.ToLowerInvariant();
            return n.Contains("leaf") || n.Contains("leaves") || n.Contains("branch") || n.Contains("needle") || n.Contains("foliage") || n.Contains("bush");
        }

        // Every texture the exported models reference, and whether a file for it exists.
        // The extractor (and the manual tool) read this to know what to pull out of the game files.
        public static void WriteTexturesJson()
        {
            try
            {
                var names = new SortedDictionary<string, int>(StringComparer.Ordinal);
                foreach (var i in index.Values) foreach (var w in i.wants) names[w] = names.TryGetValue(w, out int n) ? n + 1 : 1;
                var j = new JsonWriter(names.Count * 80 + 64);
                int present = 0;
                j.BeginObject().Key("textures").BeginArray();
                foreach (var kv in names)
                {
                    string file = PrefabExporter.TextureFileName(kv.Key);
                    bool p = File.Exists(Path.Combine(root, file));
                    if (p) present++;
                    j.BeginObject().Prop("name", kv.Key).Prop("file", file).Prop("present", p).Prop("models", kv.Value).End();
                }
                j.End().Prop("count", names.Count).Prop("present", present).Prop("enabled", WebMapConfig.USE_TEXTURES).End();
                File.WriteAllText(Path.Combine(root, "textures.json"), j.ToString());
                TexturesWanted = names.Count; TexturesPresent = present;
            }
            catch (Exception e) { ZLog.LogWarning("WebMap: could not write models/textures.json: " + e.Message); }
        }
        public static int TexturesWanted { get; private set; }
        public static int TexturesPresent { get; private set; }

        // Re-export every known prefab (after textures were extracted, or a format tweak). Returns the count queued.
        public static int ReexportAll()
        {
            PrefabExporter.ForgetMissingTextures();
            int n = 0;
            foreach (var i in index.Values) { Request(i.hash, i.cat, force: true); n++; }
            return n;
        }

        public static string FileName(int hash) => unchecked((uint)hash).ToString("x8") + ".glb";

        public static bool Known(int hash) => index.ContainsKey(hash);

        // Main thread (from the sweep). Queues an export if this prefab is new.
        public static void Request(int hash, string cat, bool force = false)
        {
            if (!force && index.ContainsKey(hash)) return;
            lock (queue)
            {
                if (queued.Contains(hash)) return;
                queued.Add(hash);
                queue.Enqueue(hash);
                catOf[hash] = cat;
            }
        }

        // Main thread: a few prefabs per frame, within a time budget.
        public static IEnumerator Pump()
        {
            var sw = new System.Diagnostics.Stopwatch();
            while (true)
            {
                if (QueueLength == 0)
                {
                    if (indexDirty) { SaveIndex(); WriteTexturesJson(); Rebuild(); MapDataServer.getInstance()?.BroadcastWorldRevision(); indexDirty = false; }
                    // once a minute (and a few seconds after the first export): fetch missing textures from the
                    // game files on a background thread, then re-export the models that use them
                    int tick = idleTicks++;
                    if (extractDone) { extractDone = false; int n = RescanTextures(); WriteTexturesJson(); Rebuild(); ZLog.Log($"WebMap: {n} models to re-export with newly extracted textures"); }
                    else if (meshDone) { meshDone = false; int n = RescanMeshes(); Rebuild(); ZLog.Log($"WebMap: {n} models to re-export with newly extracted meshes"); }
                    else if (tick == 5 || tick % 60 == 59)
                    {
                        int again = RescanTextures() + RescanMeshes();
                        if (again > 0) ZLog.Log($"WebMap: {again} models to re-export with newly extracted textures or meshes");
                        else if (WebMapConfig.USE_TEXTURES && !TextureExtractor.Running && !MeshExtractor.Running)
                        {
                            var missing = MissingTextures();
                            if (missing.Count > 0) TextureExtractor.Start(missing, root, Math.Max(64, WebMapConfig.TEXTURE_MAX_SIZE), () => extractDone = true);
                        }
                        // locked meshes next, once textures are settled
                        if (WebMapConfig.EXTRACT_MESHES && !TextureExtractor.Running && !MeshExtractor.Running)
                        {
                            var missing = MissingMeshes();
                            if (missing.Count > 0) MeshExtractor.Start(missing, root, () => meshDone = true);
                        }
                    }
                    yield return new WaitForSeconds(1f);
                    continue;
                }
                sw.Restart();
                int budgetMs = Math.Max(2, WebMapConfig.MODEL_EXPORT_MS_PER_FRAME);
                while (sw.ElapsedMilliseconds < budgetMs)
                {
                    int hash; string cat;
                    lock (queue)
                    {
                        if (queue.Count == 0) break;
                        hash = queue.Dequeue();
                        catOf.TryGetValue(hash, out cat); catOf.Remove(hash);
                    }
                    ExportOne(hash, cat ?? "other");
                    lock (queue) queued.Remove(hash);
                }
                if (Exported % 50 == 0 && indexDirty) { SaveIndex(); Rebuild(); }
                yield return null;
            }
        }

        private static void ExportOne(int hash, string cat)
        {
            var info = new Info { hash = hash, cat = cat };
            GameObject go = null;
            try { go = ZNetScene.instance != null ? ZNetScene.instance.GetPrefab(hash) : null; } catch { }
            info.name = go != null ? go.name : ("#" + hash);
            try
            {
                if (go != null && WebMapConfig.EXPORT_MODELS)
                {
                    var fallback = FallbackColor(go.name, cat);
                    var r = PrefabExporter.Export(go, root, fallback, cat);
                    info.renderers = r.renderers; info.unreadable = r.unreadable; info.wants = r.wants; info.meshWants = r.meshWants; info.meshMissing = r.meshMissing;
                    if (r.hasCanopy) { info.canopy = r.canopy; info.canopyTex = r.canopyTexture; info.canopyColor = r.canopyColor; }
                    if (r.glb != null)
                    {
                        File.WriteAllBytes(Path.Combine(root, FileName(hash)), r.glb);
                        info.ok = true; info.tris = r.triangles; info.bounds = r.bounds; info.tex = r.textured;
                        Readable++;
                    }
                    else if (r.renderers > 0) Unreadable++;
                    if (!info.ok) info.bounds = RendererBounds(go);
                }
            }
            catch (Exception e)
            {
                ZLog.LogWarning($"WebMap: model export of {info.name} failed: {e.Message}");
            }
            if (index.TryGetValue(hash, out var old) && old.ok) Readable--;   // re-export: counted again below
            index[hash] = info;
            Exported++;
            indexDirty = true;
            if (Exported == 1 || Exported % 100 == 0)
                ZLog.Log($"WebMap: models exported {Exported} (readable meshes {Readable}, unreadable {Unreadable}, queued {QueueLength})");
        }

        // Prefab-space bounds from the renderers (works even when meshes are unreadable), in the viewer's frame (z negated).
        private static float[] RendererBounds(GameObject go)
        {
            var b = new float[6];
            bool any = false;
            Bounds acc = new Bounds();
            foreach (var r in go.GetComponentsInChildren<MeshRenderer>(true))
            {
                Bounds rb;
                try { rb = r.bounds; } catch { continue; }
                if (!any) { acc = rb; any = true; } else acc.Encapsulate(rb);
            }
            if (!any) { b[0] = b[1] = b[2] = -0.5f; b[3] = b[4] = b[5] = 0.5f; return b; }
            // renderer bounds are in world space; a prefab asset sits at the origin, so this is prefab space
            Vector3 mn = acc.min, mx = acc.max;
            b[0] = mn.x; b[1] = mn.y; b[2] = -mx.z; b[3] = mx.x; b[4] = mx.y; b[5] = -mn.z;
            return b;
        }

        private static Palette.Rgb FallbackColor(string name, string cat)
        {
            switch (cat)
            {
                case "piece": return Palette.MaterialColor(World.Structures.ShapeOfName(name).mat);
                case "tree": case "bush": { var c = Vegetation.ClassifyName(name.ToLowerInvariant()); return Palette.VegColor(c.kind == Palette.Veg.None ? Palette.Veg.Deciduous : c.kind); }
                case "rock": return Palette.VegColor(Palette.Veg.Rock);
                default: return new Palette.Rgb(150, 140, 130);
            }
        }

        private static void SaveIndex()
        {
            try
            {
                var j = new JsonWriter(index.Count * 120 + 64);
                j.BeginObject().Prop("format", FORMAT).Key("prefabs").BeginObject();
                foreach (var kv in index) WriteInfo(j, kv.Value, full: true);
                j.End().End();
                string path = Path.Combine(root, "index.json"), tmp = path + ".tmp";
                File.WriteAllText(tmp, j.ToString());
                if (File.Exists(path)) File.Delete(path);
                File.Move(tmp, path);
            }
            catch (Exception e) { ZLog.LogWarning("WebMap: could not save models/index.json: " + e.Message); }
        }

        private static void WriteInfo(JsonWriter j, Info i, bool full)
        {
            j.Key(i.hash.ToString(CultureInfo.InvariantCulture)).BeginObject();
            j.Prop("n", i.name).Prop("c", i.cat).Prop("m", i.ok).Prop("t", i.tris).Prop("x", i.tex);
            if (full)
            {
                j.Prop("r", i.renderers).Prop("u", i.unreadable);
                j.Key("w").BeginArray(); foreach (var w in i.wants) j.Value(w); j.End();
                if (i.meshWants.Count > 0) { j.Key("mw").BeginArray(); foreach (var w in i.meshWants) j.Value(w); j.End(); }
                if (i.meshMissing.Count > 0) { j.Key("mm").BeginArray(); foreach (var w in i.meshMissing) j.Value(w); j.End(); }
            }
            else if (i.unreadable > 0) j.Prop("u", i.unreadable);   // the page can say "part of this model is missing"
            j.Key("b").BeginArray(); foreach (float v in i.bounds) j.Value(v, 3); j.End();
            if (i.canopy != null)
            {
                j.Key("k").BeginArray(); foreach (float v in i.canopy) j.Value(v, 2); j.End();
                if (i.canopyTex != null) j.Prop("kt", i.canopyTex);
                if (i.canopyColor != null) { j.Key("kc").BeginArray(); foreach (float v in i.canopyColor) j.Value(v, 3); j.End(); }
            }
            j.End();
        }

        private static void Rebuild()
        {
            rev++;
            try
            {
                var seen = new HashSet<string>(); int present = 0;
                foreach (var i in index.Values) foreach (var k in i.meshWants) if (seen.Add(k) && MeshCache.Exists(root, k)) present++;
                MeshesWanted = seen.Count; MeshesPresent = present;
            }
            catch { }
            var j = new JsonWriter(index.Count * 100 + 64);
            j.BeginObject().Prop("rev", rev).Prop("format", FORMAT).Prop("exported", Exported).Prop("readable", Readable).Prop("unreadable", Unreadable).Prop("queued", QueueLength)
             .Prop("texturesWanted", TexturesWanted).Prop("texturesPresent", TexturesPresent).Prop("extracting", TextureExtractor.Running).Prop("extractReport", TextureExtractor.LastReport)
             .Prop("meshesWanted", MeshesWanted).Prop("meshesPresent", MeshesPresent).Prop("extractingMeshes", MeshExtractor.Running).Prop("meshReport", MeshExtractor.LastReport);
            j.Key("prefabs").BeginObject();
            foreach (var kv in index) WriteInfo(j, kv.Value, full: false);
            j.End().End();
            prefabsJson = j.ToString();
        }
    }
}
