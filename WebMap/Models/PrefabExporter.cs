using System;
using System.Collections.Generic;
using UnityEngine;
using WebMap.Tiles;

namespace WebMap.Models
{
    // Turns a game prefab into a glTF model, on the main thread.
    //
    // Walks the prefab's hierarchy the way the game would show it freshly
    // placed: active objects only (so WearNTear's "worn" and "broken" states,
    // which start inactive, are skipped), the first LOD of every LODGroup,
    // every enabled MeshRenderer. Vertices are baked into the prefab's root
    // frame and flipped into glTF's right-handed space (z negated, winding
    // reversed), which matches how the viewer places instances (scene Z = -z).
    //
    // Materials keep their colour; textures are exported once each (downscaled)
    // when the engine lets us read them, and referenced by URI so a hundred
    // wood pieces share one wood texture. Meshes the engine marks unreadable
    // yield no geometry -- the caller falls back to a box of the right size.
    internal static class PrefabExporter
    {
        public sealed class Result
        {
            public byte[] glb; public float[] bounds; public int triangles; public bool textured; public bool readable;
            public int renderers, unreadable, foliageSkipped;
            public List<string> wants = new List<string>();   // texture names the materials reference (present or not)
            public List<string> meshWants = new List<string>();     // keys of locked meshes (MeshCache.Key) this prefab uses
            public List<string> meshMissing = new List<string>();   // those with no cache file yet (drawn without that part)
            // canopy: the foliage the model does NOT carry, summarised for the viewer's billboard leaves
            public string category = "other"; public bool hasCanopy; public bool canopyLeafNamed; public float[] canopy = { 1e9f, 1e9f, 1e9f, -1e9f, -1e9f, -1e9f }; public string canopyTexture; public float[] canopyColor = { 0.35f, 0.55f, 0.25f };
        }

        private static readonly string[] altColorProps = { "_BaseMap", "_BaseColorMap", "_Albedo", "_AlbedoMap", "_Diffuse", "_ColorMap", "_Tex" };
        private static readonly Dictionary<string, string> textureFiles = new Dictionary<string, string>();   // texture name -> file name, or null when not obtainable

        // File name for a texture by name: stable across restarts, so the same file can come from the
        // engine (readable textures) or from TextureExtractor (everything else).
        public static string TextureFileName(string texName) => "tex_" + System.Text.RegularExpressions.Regex.Replace(texName ?? "", "[^a-zA-Z0-9_-]", "_") + ".png";
        private static readonly string[] skipComponents = { "Character", "Player", "ItemDrop", "Projectile", "Ragdoll", "Fish", "Procreation", "Tameable", "MonsterAI", "AnimalAI" };

        // Does the prefab render anything at all (and is it a thing, not a creature or an item)?
        public static bool IsVisibleThing(GameObject go)
        {
            if (go == null) return false;
            string n = go.name.ToLowerInvariant();
            if (n.StartsWith("vfx_") || n.StartsWith("sfx_") || n.StartsWith("fx_") || n.StartsWith("_")) return false;
            foreach (var c in skipComponents) if (go.GetComponent(c) != null) return false;
            return go.GetComponentInChildren<MeshRenderer>(true) != null;
        }

        public static Result Export(GameObject prefab, string modelsDir, Palette.Rgb fallback, string category = "other")
        {
            var res = new Result { bounds = new float[6], category = category ?? "other" };
            if (prefab == null) return res;
            var writer = new GlbWriter();

            // renderers hidden by a LODGroup (any LOD but the first)
            var hidden = new HashSet<Renderer>();
            var lodZero = new HashSet<Renderer>();
            foreach (var lg in prefab.GetComponentsInChildren<LODGroup>(true))
            {
                LOD[] lods;
                try { lods = lg.GetLODs(); } catch { continue; }
                if (lods == null || lods.Length == 0) continue;
                for (int i = 0; i < lods.Length; i++)
                    if (lods[i].renderers != null)
                        foreach (var r in lods[i].renderers)
                            if (r != null) { if (i == 0) lodZero.Add(r); else hidden.Add(r); }
            }
            foreach (var r in lodZero) hidden.Remove(r);

            Matrix4x4 toRoot = prefab.transform.worldToLocalMatrix;
            int tris = 0;
            var stack = new Stack<Transform>();
            stack.Push(prefab.transform);
            while (stack.Count > 0)
            {
                Transform t = stack.Pop();
                if (t != prefab.transform && !t.gameObject.activeSelf) continue;
                foreach (Transform c in t) stack.Push(c);

                var mr = t.GetComponent<MeshRenderer>();
                if (mr == null || !mr.enabled || hidden.Contains(mr)) continue;
                var mf = t.GetComponent<MeshFilter>();
                if (mf == null || mf.sharedMesh == null) continue;
                Mesh mesh = mf.sharedMesh;
                res.renderers++;

                // geometry: from the engine when the mesh is readable, else from the mesh cache
                // (MeshExtractor fills it from the game files); a locked mesh not cached yet is skipped
                float[] pos, nrm = null, uv = null; int vcount; List<uint[]> subIdx = null;
                bool readable = false;
                try { readable = mesh.isReadable; } catch { }
                if (readable)
                {
                    Vector3[] verts; Vector3[] norms; Vector2[] uvs;
                    try { verts = mesh.vertices; norms = mesh.normals; uvs = mesh.uv; }
                    catch { readable = false; verts = null; norms = null; uvs = null; }
                    if (!readable || verts == null || verts.Length == 0) { res.unreadable++; continue; }
                    vcount = verts.Length;
                    pos = new float[vcount * 3];
                    if (norms != null && norms.Length == vcount) nrm = new float[vcount * 3];
                    if (uvs != null && uvs.Length == vcount) uv = new float[vcount * 2];
                    for (int i = 0; i < vcount; i++)
                    {
                        pos[i * 3] = verts[i].x; pos[i * 3 + 1] = verts[i].y; pos[i * 3 + 2] = verts[i].z;
                        if (nrm != null) { nrm[i * 3] = norms[i].x; nrm[i * 3 + 1] = norms[i].y; nrm[i * 3 + 2] = norms[i].z; }
                        if (uv != null) { uv[i * 2] = uvs[i].x; uv[i * 2 + 1] = uvs[i].y; }
                    }
                }
                else
                {
                    int vc = 0, subCount = 0, idx0 = 0;
                    try { vc = mesh.vertexCount; subCount = mesh.subMeshCount; } catch { }
                    try { idx0 = (int)mesh.GetIndexCount(0); } catch { }
                    string key = string.IsNullOrEmpty(mesh.name) || vc <= 0 ? null : MeshCache.Key(mesh.name, vc, subCount, idx0);
                    var cached = key != null ? MeshCache.Load(modelsDir, key) : null;
                    if (key != null && !res.meshWants.Contains(key)) res.meshWants.Add(key);
                    if (cached == null)
                    {
                        if (key != null && !res.meshMissing.Contains(key)) res.meshMissing.Add(key);
                        res.unreadable++; continue;
                    }
                    pos = cached.positions; nrm = cached.normals; uv = cached.uvs; subIdx = cached.subMeshes; vcount = pos.Length / 3;
                }
                res.readable = true;

                Matrix4x4 m = toRoot * t.localToWorldMatrix;
                Matrix4x4 nm = m.inverse.transpose;
                bool mirrored = m.determinant < 0;   // negative scale flips winding once more
                for (int i = 0; i < vcount; i++)
                {
                    Vector3 v = m.MultiplyPoint3x4(new Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]));
                    pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = -v.z;
                    if (nrm != null)
                    {
                        Vector3 n = nm.MultiplyVector(new Vector3(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2])).normalized;
                        nrm[i * 3] = n.x; nrm[i * 3 + 1] = n.y; nrm[i * 3 + 2] = -n.z;
                    }
                    if (uv != null) uv[i * 2 + 1] = 1f - uv[i * 2 + 1];
                }

                Material[] mats = mr.sharedMaterials;
                int subs = subIdx != null ? subIdx.Count : mesh.subMeshCount;
                for (int s = 0; s < subs; s++)
                {
                    uint[] raw;
                    if (subIdx != null) raw = subIdx[s];
                    else
                    {
                        int[] idx;
                        try { idx = mesh.GetTriangles(s); } catch { continue; }
                        if (idx == null) continue;
                        raw = new uint[idx.Length];
                        for (int i = 0; i < idx.Length; i++) raw[i] = (uint)idx[i];
                    }
                    if (raw == null || raw.Length < 3) continue;
                    uint[] indices = new uint[raw.Length];
                    for (int i = 0; i + 2 < raw.Length; i += 3)
                    {
                        // reverse winding for the handedness flip (and again for mirrored transforms)
                        if (mirrored) { indices[i] = raw[i]; indices[i + 1] = raw[i + 1]; indices[i + 2] = raw[i + 2]; }
                        else { indices[i] = raw[i + 2]; indices[i + 1] = raw[i + 1]; indices[i + 2] = raw[i]; }
                    }
                    var prim = new GlbWriter.Primitive { positions = pos, normals = nrm, uvs = uv, indices = indices };
                    Material mat = mats != null && s < mats.Length ? mats[s] : (mats != null && mats.Length > 0 ? mats[0] : null);
                    ApplyMaterial(prim, mat, modelsDir, fallback, res);
                    if (prim.textureUri != null) res.textured = true;
                    // foliage never ships as geometry: thousands of alpha-cut cards per tree are heavy and
                    // shimmer. The viewer draws a few billboard quads over the canopy's bounds instead, so
                    // only the bounds, the leaf texture and the leaf colour are recorded here.
                    if (prim.foliage)
                    {
                        res.foliageSkipped++;
                        var used = new HashSet<uint>(indices);
                        foreach (uint vi in used)
                        {
                            int o = (int)vi * 3;
                            if (pos[o] < res.canopy[0]) res.canopy[0] = pos[o];
                            if (pos[o + 1] < res.canopy[1]) res.canopy[1] = pos[o + 1];
                            if (pos[o + 2] < res.canopy[2]) res.canopy[2] = pos[o + 2];
                            if (pos[o] > res.canopy[3]) res.canopy[3] = pos[o];
                            if (pos[o + 1] > res.canopy[4]) res.canopy[4] = pos[o + 1];
                            if (pos[o + 2] > res.canopy[5]) res.canopy[5] = pos[o + 2];
                        }
                        res.hasCanopy = true;
                        // the leaf texture, preferring one named like leaves over an atlas or a guess
                        if (prim.textureUri != null && (res.canopyTexture == null || (!res.canopyLeafNamed && IsLeafName(prim.textureUri.ToLowerInvariant()))))
                        { res.canopyTexture = prim.textureUri; res.canopyLeafNamed = IsLeafName(prim.textureUri.ToLowerInvariant()); }
                        if (prim.textureUri == null) { res.canopyColor[0] = prim.r; res.canopyColor[1] = prim.g; res.canopyColor[2] = prim.b; }
                        continue;
                    }
                    writer.Add(prim);
                    tris += raw.Length / 3;
                }
            }

            if (writer.Count == 0) return res;
            res.glb = writer.Write(prefab.name, out res.bounds);
            res.triangles = tris;
            return res;
        }

        private static bool IsLeafName(string n) => n.Contains("leaf") || n.Contains("leaves") || n.Contains("branch") || n.Contains("needle") || n.Contains("foliage") || n.Contains("canopy") || n.Contains("grass") || n.Contains("_bush") || n.StartsWith("bush") || n.Contains("shrub") || n.Contains("bloom") || n.Contains("flower");
        private static bool IsWoodName(string n) => n.Contains("bark") || n.Contains("trunk") || n.Contains("log") || n.Contains("stump") || n.Contains("root") || n.Contains("wood") || n.Contains("stem");

        private static void ApplyMaterial(GlbWriter.Primitive prim, Material mat, string modelsDir, Palette.Rgb fallback, Result res)
        {
            prim.r = fallback.r / 255f; prim.g = fallback.g / 255f; prim.b = fallback.b / 255f;
            if (mat == null) return;
            prim.name = mat.name;
            string shader = "";
            try { shader = mat.shader != null ? mat.shader.name.ToLowerInvariant() : ""; } catch { }
            string mn = mat.name.ToLowerInvariant();
            string tn = "";
            try { if (mat.mainTexture != null) tn = mat.mainTexture.name.ToLowerInvariant(); } catch { }
            bool cutoff = false;
            try { cutoff = mat.HasProperty("_Cutoff") && mat.GetFloat("_Cutoff") > 0.01f; } catch { }
            prim.alphaMask = shader.Contains("vegetation") || shader.Contains("cutout") || shader.Contains("leaf") || mn.Contains("leaf") || mn.Contains("branch") || (cutoff && !shader.Contains("standard"));
            // Foliage = leaves, needles, branch cards: named so on the material or its texture. Bark, trunks,
            // logs and stumps are geometry even though the game draws the whole tree with its vegetation
            // shader. An unnamed vegetation-shader material with alpha cutout (leaf card atlases) counts too.
            bool leafy = IsLeafName(mn) || IsLeafName(tn);
            bool woody = IsWoodName(mn) || IsWoodName(tn);
            prim.foliage = !woody && (leafy || (shader.Contains("vegetation") && cutoff && (res.category == "tree" || res.category == "bush")));
            if (shader.Contains("water") || shader.Contains("particle") || shader.Contains("glow")) prim.a = 0.5f;

            string texFile = ExportTexture(mat, modelsDir, res);
            if (texFile != null)
            {
                prim.textureUri = texFile;
                // with a texture the base colour is a tint only
                Color c = Color.white;
                try { if (mat.HasProperty("_Color")) c = mat.color; } catch { }
                prim.r = Mathf.Clamp01(c.r); prim.g = Mathf.Clamp01(c.g); prim.b = Mathf.Clamp01(c.b);
                if (prim.r + prim.g + prim.b < 0.15f) { prim.r = prim.g = prim.b = 1f; }   // some materials tint black and rely on emission
            }
            else
            {
                // no readable texture: the material colour, unless it is plain white (then the palette guess is better)
                try
                {
                    if (mat.HasProperty("_Color"))
                    {
                        Color c = mat.color;
                        if (!(c.r > 0.9f && c.g > 0.9f && c.b > 0.9f)) { prim.r = c.r; prim.g = c.g; prim.b = c.b; }
                    }
                }
                catch { }
            }
        }

        // The material's main texture as a file in the models dir: an already present file (exported earlier,
        // or extracted from the game files by TextureExtractor), else exported now when the engine
        // lets us read it. Returns the file name, or null. The name is recorded either way so the
        // extraction tool knows what to look for.
        private static string ExportTexture(Material mat, string modelsDir, Result res)
        {
            Texture2D tex = null;
            try { tex = mat.mainTexture as Texture2D; } catch { }
            if (tex == null)
            {
                // shaders that keep their colour map under another name
                foreach (var prop in altColorProps)
                    try { if (mat.HasProperty(prop)) { tex = mat.GetTexture(prop) as Texture2D; if (tex != null) break; } } catch { }
            }
            if (tex == null || string.IsNullOrEmpty(tex.name)) return null;
            string name = tex.name;
            if (!res.wants.Contains(name)) res.wants.Add(name);
            if (!WebMapConfig.USE_TEXTURES) return null;   // name recorded (so a later switch-on knows what to fetch), never used
            if (textureFiles.TryGetValue(name, out string cached)) return cached;
            string file = TextureFileName(name);
            if (System.IO.File.Exists(System.IO.Path.Combine(modelsDir, file))) { textureFiles[name] = file; return file; }
            try
            {
                if (!tex.isReadable) { textureFiles[name] = null; return null; }
                Color32[] px = tex.GetPixels32();
                int w = tex.width, h = tex.height;
                int max = Math.Max(16, WebMapConfig.TEXTURE_MAX_SIZE);
                int step = 1; while (w / step > max || h / step > max) step *= 2;
                int ow = Math.Max(1, w / step), oh = Math.Max(1, h / step);
                byte[] rgba = new byte[ow * oh * 4];
                bool anyAlpha = false;
                for (int y = 0; y < oh; y++)
                    for (int x = 0; x < ow; x++)
                    {
                        // box-filter the block so downscaled leaves keep their alpha coverage
                        int r = 0, g = 0, b = 0, a = 0, n = 0;
                        for (int yy = 0; yy < step; yy++)
                            for (int xx = 0; xx < step; xx++)
                            {
                                int sx = x * step + xx, sy = y * step + yy;
                                if (sx >= w || sy >= h) continue;
                                var c = px[sy * w + sx]; r += c.r; g += c.g; b += c.b; a += c.a; n++;
                            }
                        if (n == 0) n = 1;
                        // Unity rows start at the bottom; PNG rows at the top
                        int o = ((oh - 1 - y) * ow + x) * 4;
                        rgba[o] = (byte)(r / n); rgba[o + 1] = (byte)(g / n); rgba[o + 2] = (byte)(b / n); rgba[o + 3] = (byte)(a / n);
                        if (rgba[o + 3] < 250) anyAlpha = true;
                    }
                byte[] png = anyAlpha ? Util.Png.Encode(rgba, ow, oh, Util.Png.Format.RGBA, fast: true) : Util.Png.Encode(StripAlpha(rgba), ow, oh, Util.Png.Format.RGB, fast: true);
                System.IO.File.WriteAllBytes(System.IO.Path.Combine(modelsDir, file), png);
            }
            catch (Exception e)
            {
                if (WebMapConfig.DEBUG) ZLog.LogWarning("WebMap: texture " + tex.name + " not exported: " + e.Message);
                file = null;
            }
            textureFiles[name] = file;
            return file;
        }

        // Called before a re-export pass: forget which textures were unobtainable, files may have appeared.
        public static void ForgetMissingTextures()
        {
            var gone = new List<string>();
            foreach (var kv in textureFiles) if (kv.Value == null) gone.Add(kv.Key);
            foreach (var k in gone) textureFiles.Remove(k);
        }

        private static byte[] StripAlpha(byte[] rgba)
        {
            byte[] rgb = new byte[rgba.Length / 4 * 3];
            for (int i = 0, o = 0; i < rgba.Length; i += 4, o += 3) { rgb[o] = rgba[i]; rgb[o + 1] = rgba[i + 1]; rgb[o + 2] = rgba[i + 2]; }
            return rgb;
        }
    }
}
