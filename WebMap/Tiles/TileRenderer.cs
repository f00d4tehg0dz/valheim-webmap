using System;
using System.Collections.Generic;
using UnityEngine;
using WebMap.Util;

namespace WebMap.Tiles
{
    // Renders one tile of the map.
    //
    // A tile is produced in three stages so the expensive and the thread-bound
    // parts can be scheduled separately (see TileStore):
    //
    //   1. Sample   -- asks the game's WorldGenerator for biome and height at
    //                  every pixel (plus a one-pixel border for normals) and
    //                  adds player terraforming from TerrainPatches. This is
    //                  the only stage that calls into the game.
    //   2. Compose  -- turns heights and biomes into colours: water depth,
    //                  shoreline, snow, paint (roads, farmland), forest tint,
    //                  hillshade. At close zooms the tree canopies and rocks
    //                  go into a separate transparent overlay tile, so the
    //                  ground tile stays clean for the 3D view. Pure
    //                  arithmetic on arrays.
    //   3. Encode   -- PNGs for the colour tile and, when asked, the height
    //                  tile in Terrarium encoding (the same the 3D view and
    //                  most web terrain tools already understand).
    //
    // Stages 2 and 3 never touch Unity and can run on any thread.
    internal sealed class TileJob
    {
        public readonly int zoom, x, y;
        public readonly bool wantHeight;
        public readonly float mpp;                     // metres per pixel
        private readonly float minX, maxZ;             // world coords of the tile's north-west pixel edge

        public const int T = TileMath.TILE_SIZE;
        public const int S = T + 2;                    // sampled size incl. 1px border
        private readonly float[] h = new float[S * S];
        private readonly ushort[] biome = new ushort[S * S];
        private readonly byte[] forest = new byte[S * S];   // 0..255 forest density
        private byte[] rgb;                            // T*T*3
        private byte[] veg;                            // T*T*4, the vegetation overlay (zoom >= 5), straight alpha

        public byte[] ColorPng { get; private set; }
        public byte[] VegPng { get; private set; }     // null below zoom 5
        public byte[] HeightPng { get; private set; }
        public int SampledRows { get; private set; }   // progress for the sliced main-thread path

        private static float waterLevel = 30f;
        public static float WaterLevel { get => waterLevel; set => waterLevel = value; }

        public TileJob(int zoom, int x, int y, bool wantHeight)
        {
            this.zoom = zoom; this.x = x; this.y = y; this.wantHeight = wantHeight;
            mpp = TileMath.MetersPerPixel(zoom);
            TileMath.TileBounds(zoom, x, y, out minX, out _, out _, out maxZ);
        }

        // ---------------------------------------------------------------- 1. sample

        // Samples rows [from, to) of the bordered grid. Calls the game; the
        // caller decides which thread that is safe on.
        public void SampleRows(int from, int to)
        {
            var wg = WorldGenerator.instance;
            if (wg == null) throw new InvalidOperationException("WorldGenerator not ready");
            bool detail = zoom >= 4;                    // terraforming is invisible below 8 m/px
            for (int py = from; py < to; py++)
            {
                float wz = maxZ - (py - 1 + 0.5f) * mpp;
                for (int px = 0; px < S; px++)
                {
                    float wx = minX + (px - 1 + 0.5f) * mpp;
                    int i = py * S + px;
                    float r2 = wx * wx + wz * wz;
                    if (r2 > 10500f * 10500f)
                    {
                        h[i] = -100f; biome[i] = Palette.B_OCEAN; forest[i] = 0;
                        continue;
                    }
                    Heightmap.Biome b = wg.GetBiome(wx, wz);
                    float height = wg.GetBiomeHeight(b, wx, wz, out Color _);
                    // the game levels ground discs (editor "No limit" ground) first, then adds player terraforming on top
                    height = GroundDiscs.Level(wx, wz, height);
                    if (detail) height += TerrainPatches.DeltaAt(wx, wz);
                    h[i] = height;
                    biome[i] = (ushort)(int)b;
                    // forest density: the game's own definition (Meadows forests are where the factor is low)
                    float ff = 0f;
                    switch ((int)b)
                    {
                        case Palette.B_MEADOWS:
                            ff = WorldGenerator.GetForestFactor(new Vector3(wx, 0f, wz));
                            ff = ff < 1.15f ? Mathf.Clamp01((1.15f - ff) * 1.2f + 0.35f) : 0f;
                            break;
                        case Palette.B_BLACKFOREST:
                            ff = Mathf.Clamp01(1.0f - WorldGenerator.GetForestFactor(new Vector3(wx, 0f, wz)) * 0.35f);
                            if (ff < 0.45f) ff = 0.45f;
                            break;
                        case Palette.B_PLAINS:
                            ff = WorldGenerator.GetForestFactor(new Vector3(wx, 0f, wz));
                            ff = ff < 0.8f ? Mathf.Clamp01((0.8f - ff) * 1.5f + 0.2f) : 0f;
                            break;
                        case Palette.B_MISTLANDS:
                            ff = 0.5f;
                            break;
                        case Palette.B_SWAMP:
                            ff = 0.4f;
                            break;
                    }
                    if (height < waterLevel) ff = 0f;
                    forest[i] = (byte)(ff * 255f);
                }
            }
            SampledRows = to;
        }

        public void SampleAll() => SampleRows(0, S);

        // ---------------------------------------------------------------- 2. compose

        private static readonly Vector3 sunDir = new Vector3(-0.45f, 0.72f, 0.53f).normalized;   // from the north-west, high

        public void Compose()
        {
            rgb = new byte[T * T * 3];
            float wl = waterLevel;
            for (int py = 0; py < T; py++)
            {
                for (int px = 0; px < T; px++)
                {
                    int i = (py + 1) * S + (px + 1);
                    float hh = h[i];
                    int b = biome[i];
                    float wx = minX + (px + 0.5f) * mpp;
                    float wz = maxZ - (py + 0.5f) * mpp;

                    Palette.Rgb c = Ground(b, hh, i);

                    // paint: roads, farmland, paved floors
                    if (zoom >= 4 && hh >= wl - 0.5f && TerrainPatches.PaintAt(wx, wz, out float dirt, out float cult, out float paved))
                    {
                        c = Palette.Rgb.Lerp(c, Palette.PaintDirt, dirt * 0.85f);
                        c = Palette.Rgb.Lerp(c, Palette.PaintCultivated, cult * 0.9f);
                        c = Palette.Rgb.Lerp(c, Palette.PaintPaved, paved * 0.95f);
                    }

                    // forest tint at every zoom (the canopies below only exist at close zooms)
                    float f = forest[i] / 255f;
                    if (f > 0f)
                    {
                        Palette.Rgb dark = b == Palette.B_BLACKFOREST ? new Palette.Rgb(38, 54, 34)
                                         : b == Palette.B_PLAINS ? new Palette.Rgb(120, 130, 60)
                                         : b == Palette.B_MISTLANDS ? new Palette.Rgb(62, 78, 84)
                                         : b == Palette.B_SWAMP ? new Palette.Rgb(50, 56, 34)
                                         : new Palette.Rgb(60, 104, 46);
                        float amount = zoom >= 5 ? 0.22f : 0.55f;
                        c = Palette.Rgb.Lerp(c, dark, f * amount);
                    }

                    // shoreline & water
                    if (hh < wl)
                    {
                        float depth = wl - hh;
                        float t = Mathf.Clamp01(depth / 28f);
                        t = (float)Math.Sqrt(t);
                        Palette.Rgb water = Palette.Rgb.Lerp(Palette.WaterShallow, Palette.WaterDeep, t);
                        if (b == Palette.B_ASHLANDS && depth < 6f) water = Palette.Rgb.Lerp(Palette.AshlandsLava, water, Mathf.Clamp01(depth / 6f));
                        // ground shows through in the shallows
                        float see = Mathf.Clamp01(1f - depth / 3.5f) * 0.45f;
                        c = Palette.Rgb.Lerp(water, c, see);
                    }
                    else if (hh < wl + 2.2f && b != Palette.B_MOUNTAIN && b != Palette.B_DEEPNORTH && b != Palette.B_ASHLANDS)
                    {
                        float t = Mathf.Clamp01((wl + 2.2f - hh) / 2.2f);
                        c = Palette.Rgb.Lerp(c, Palette.Sand, t * 0.8f);
                    }

                    // hillshade from the height neighbourhood (border pixels make this exact at tile edges)
                    float dx = (h[i + 1] - h[i - 1]) / (2f * mpp);
                    float dz = (h[i - S] - h[i + S]) / (2f * mpp);       // row above is north (+z)
                    if (hh < wl) { dx *= 0.35f; dz *= 0.35f; }
                    // normal of the surface z = f(x, y): (-dx, 1, -dz)
                    float nx = -dx, ny = 1f, nz = -dz;
                    float inv = 1f / (float)Math.Sqrt(nx * nx + ny * ny + nz * nz);
                    nx *= inv; ny *= inv; nz *= inv;
                    float light = nx * sunDir.x + ny * sunDir.y + nz * sunDir.z;
                    float shade = 0.55f + 0.55f * Mathf.Clamp01(light);
                    // steep rock faces in the mountains lose their snow
                    c = c.Scale(shade);

                    int o = (py * T + px) * 3;
                    rgb[o] = c.r; rgb[o + 1] = c.g; rgb[o + 2] = c.b;
                }
            }

            if (zoom >= 5) { veg = new byte[T * T * 4]; BakeVegetation(); }
        }

        private Palette.Rgb Ground(int b, float hh, int i)
        {
            switch (b)
            {
                case Palette.B_MEADOWS:
                {
                    float t = Mathf.Clamp01((hh - 45f) / 70f);
                    return Palette.Rgb.Lerp(Palette.Meadows, new Palette.Rgb(150, 154, 86), t);
                }
                case Palette.B_MOUNTAIN:
                {
                    float snow = Mathf.Clamp01((hh - 50f) / 45f);
                    // steep faces show rock through the snow
                    float dx = (h[i + 1] - h[i - 1]) / (2f * mpp);
                    float dz = (h[i - S] - h[i + S]) / (2f * mpp);
                    float slope = (float)Math.Sqrt(dx * dx + dz * dz);
                    snow *= Mathf.Clamp01(1.25f - slope * 0.55f);
                    Palette.Rgb low = Palette.Rgb.Lerp(Palette.Meadows, Palette.MountainRock, Mathf.Clamp01((hh - 20f) / 40f));
                    return Palette.Rgb.Lerp(low, Palette.Snow, snow);
                }
                case Palette.B_DEEPNORTH:
                {
                    float t = Mathf.Clamp01((hh - 30f) / 30f);
                    return Palette.Rgb.Lerp(new Palette.Rgb(170, 196, 214), Palette.DeepNorth, t);
                }
                case Palette.B_ASHLANDS:
                {
                    float t = Mathf.Clamp01((hh - 30f) / 60f);
                    return Palette.Rgb.Lerp(new Palette.Rgb(80, 40, 34), Palette.Ashlands, t);
                }
                case Palette.B_PLAINS:
                {
                    float t = Mathf.Clamp01((hh - 30f) / 50f);
                    return Palette.Rgb.Lerp(Palette.Plains, new Palette.Rgb(160, 150, 96), t);
                }
                default:
                    return Palette.Biome(b);
            }
        }

        // Trees and rocks as small shaded discs with a soft shadow. At 4 m/px a
        // beech is one pixel; at 1 m/px it is a nine-pixel-wide crown.
        private void BakeVegetation()
        {
            float margin = 12f;
            float tMinX = minX - margin, tMaxX = minX + T * mpp + margin;
            float tMaxZ = maxZ + margin, tMinZ = maxZ - T * mpp - margin;
            int zx0 = TileMath.ZoneCoord(tMinX), zx1 = TileMath.ZoneCoord(tMaxX);
            int zz0 = TileMath.ZoneCoord(tMinZ), zz1 = TileMath.ZoneCoord(tMaxZ);
            var pts = new List<Vegetation.Point>();
            for (int zz = zz0; zz <= zz1; zz++)
                for (int zx = zx0; zx <= zx1; zx++)
                {
                    var arr = Vegetation.Zone(zx, zz);
                    if (arr != null) pts.AddRange(arr);
                }
            if (pts.Count == 0) return;
            // north to south so nearer (southern) crowns overlap farther ones
            pts.Sort((a, b) => b.z.CompareTo(a.z));

            foreach (var p in pts)
            {
                if (p.x < tMinX || p.x > tMaxX || p.z < tMinZ || p.z > tMaxZ) continue;
                float r = Palette.VegRadius(p.kind) * p.size;
                float rp = r / mpp;
                float cx = (p.x - minX) / mpp - 0.5f;
                float cy = (maxZ - p.z) / mpp - 0.5f;
                Palette.Rgb col = Palette.VegColor(p.kind);
                bool isRock = p.kind == Palette.Veg.Rock || p.kind == Palette.Veg.Ore;
                if (rp < 0.75f)
                {
                    Blend((int)Math.Round(cx), (int)Math.Round(cy), col, Mathf.Clamp01(rp * 1.1f) * 0.85f);
                    continue;
                }
                // shadow, offset to the south-east away from the sun
                float sh = Math.Min(rp * 0.35f, 3f);
                Disc(cx + sh, cy + sh, rp * 0.95f, new Palette.Rgb(0, 0, 0), 0.28f, 0.0f, false);
                // crown / boulder with a highlight toward the sun
                Disc(cx, cy, rp, col, isRock ? 0.95f : 0.92f, isRock ? 0.35f : 0.55f, true);
            }
        }

        private void Disc(float cx, float cy, float r, Palette.Rgb col, float alpha, float highlight, bool shaded)
        {
            int x0 = Math.Max(0, (int)Math.Floor(cx - r)), x1 = Math.Min(T - 1, (int)Math.Ceiling(cx + r));
            int y0 = Math.Max(0, (int)Math.Floor(cy - r)), y1 = Math.Min(T - 1, (int)Math.Ceiling(cy + r));
            float r2 = r * r;
            for (int py = y0; py <= y1; py++)
            {
                for (int px = x0; px <= x1; px++)
                {
                    float dx = px - cx, dy = py - cy;
                    float d2 = dx * dx + dy * dy;
                    if (d2 > r2) continue;
                    float d = (float)Math.Sqrt(d2) / r;           // 0 centre .. 1 edge
                    float a = alpha * Mathf.Clamp01((1f - d) * r * 1.5f);   // soft edge, about a pixel wide
                    Palette.Rgb c = col;
                    if (shaded)
                    {
                        // light from the north-west: brighter up-left, darker down-right
                        float l = 1f + highlight * (-(dx + dy) / (r * 1.4142f)) - 0.25f * d;
                        c = col.Scale(l);
                    }
                    Blend(px, py, c, a);
                }
            }
        }

        // "over" compositing into the overlay (straight alpha)
        private void Blend(int px, int py, Palette.Rgb c, float a)
        {
            if (px < 0 || py < 0 || px >= T || py >= T || a <= 0f) return;
            int o = (py * T + px) * 4;
            float oa = veg[o + 3] / 255f;
            float na = a + oa * (1f - a);
            if (na <= 0f) return;
            float w = a / na;
            veg[o] = (byte)(veg[o] + (c.r - veg[o]) * w);
            veg[o + 1] = (byte)(veg[o + 1] + (c.g - veg[o + 1]) * w);
            veg[o + 2] = (byte)(veg[o + 2] + (c.b - veg[o + 2]) * w);
            veg[o + 3] = (byte)Math.Round(na * 255f);
        }

        // ---------------------------------------------------------------- 3. encode

        public void Encode()
        {
            ColorPng = Png.Encode(rgb, T, T, Png.Format.RGB, fast: zoom >= 6);
            if (veg != null) { VegPng = Png.Encode(veg, T, T, Png.Format.RGBA, fast: zoom >= 6); veg = null; }
            if (wantHeight)
            {
                // Terrarium: h = (R * 256 + G + B / 256) - 32768
                byte[] ht = new byte[T * T * 3];
                for (int py = 0; py < T; py++)
                    for (int px = 0; px < T; px++)
                    {
                        float hh = h[(py + 1) * S + (px + 1)];
                        int v = (int)Math.Round((hh + 32768f) * 256f);
                        if (v < 0) v = 0; if (v > 0xFFFFFF) v = 0xFFFFFF;
                        int o = (py * T + px) * 3;
                        ht[o] = (byte)(v >> 16); ht[o + 1] = (byte)(v >> 8); ht[o + 2] = (byte)v;
                    }
                HeightPng = Png.Encode(ht, T, T, Png.Format.RGB);
            }
            rgb = null;
        }

        // Which biome dominates this tile -- handed to the client for the "you are looking at" readout.
        public int DominantBiome()
        {
            var counts = new Dictionary<int, int>();
            for (int i = 0; i < biome.Length; i += 7) { counts.TryGetValue(biome[i], out int n); counts[biome[i]] = n + 1; }
            int best = 0, bestN = -1;
            foreach (var kv in counts) if (kv.Value > bestN) { best = kv.Key; bestN = kv.Value; }
            return best;
        }
    }
}
