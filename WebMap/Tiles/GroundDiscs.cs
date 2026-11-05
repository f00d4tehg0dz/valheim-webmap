using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using UnityEngine;

namespace WebMap.Tiles
{
    // Ground discs: ground that sits above the game's own "generated" ground.
    //
    // Valheim does not store the ground's height. It stores the seed, rebuilds the
    // generated ground from it, levels the ground under every location (villages,
    // altars, ...) and only then adds the players' terraforming (TerrainPatches),
    // which is capped at +-8 m from that levelled ground. World editors that go past
    // the cap (the Valheim World Editor's "No limit": mountains, canyons, big pads)
    // therefore save the extra ground as invisible locations: LocationProxy objects
    // whose "location" is DevGround1. Each one is a TerrainModifier that levels a disc
    // of 8 m radius to its own height and blends the ground out to about 13 m.
    //
    // The renderer used to start from the plain generator height, so none of that
    // ground showed up. Level() reproduces what the game does with those discs:
    //
    //   - discs are applied one after the other in TerrainModifier.SortByModifiers
    //     order (see Order below);
    //   - a point within LevelRadius of a disc takes the disc's height;
    //   - a point further out, within Reach, moves a share 1 - (d / Reach)^3 of the
    //     way towards it (Heightmap.SmoothTerrain2).
    //
    // The constants and the order are the ones the editor measured against the game
    // (Uplift.cs / Uplift.Weights.cs in its repository). The game works on a 1 m
    // vertex grid and centres a disc on the nearest vertex, so distances here are
    // measured from the disc's middle rounded to a whole metre.
    //
    // Only DevGround1 is handled. The levelling of the game's own locations (villages,
    // boss altars, ...) comes from modifiers inside each location's prefab, which this
    // class does not read.
    //
    // The sweep (main thread) collects the discs with Begin / Observe / Finish. Finish
    // publishes an immutable snapshot that renderer threads read through Level without
    // locking, and reports the zones whose ground changed so their tiles are redrawn.
    // What was last drawn is remembered in ground_discs.txt next to the tiles, so a
    // world edited while the server was off (or tiles drawn before this existed) are
    // redrawn on the first sweep instead of staying stale.
    internal static class GroundDiscs
    {
        public const float LevelRadius = 8f;       // within this a point takes the disc's height
        public const float Reach = 12.96f;         // beyond this the disc does nothing
        // where the modifier sits inside the location prefab; it only decides the order discs apply in
        private const float OffsetX = -0.0006f, OffsetY = 0f, OffsetZ = 0.1006f;

        public static readonly int ProxyPrefab = "LocationProxy".GetStableHashCode();
        public static readonly int DiscLocation = "DevGround1".GetStableHashCode();

        private const string FileName = "ground_discs.txt";
        private const float CellSize = 32f;
        private const float DirtyMargin = Reach + 2f;   // a disc changes ground out to Reach; +2 for the tile border

        private struct Disc
        {
            public float x, y, z;       // position as saved
            public float cx, cz;        // middle snapped to the nearest metre: what distances are measured from
            public float order;         // application order key, ascending
        }

        // Immutable once built. Discs are sorted in application order and every grid
        // cell lists its discs in that same order, so Level never has to sort.
        private sealed class Snapshot
        {
            public Disc[] discs;
            public Dictionary<long, int[]> cells;
        }

        private struct Key : IEquatable<Key>
        {
            public int x, y, z;
            public bool Equals(Key o) => x == o.x && y == o.y && z == o.z;
            public override bool Equals(object o) => o is Key k && Equals(k);
            public override int GetHashCode() { unchecked { return (x * 73856093) ^ (y * 19349663) ^ (z * 83492791); } }
        }

        private static volatile Snapshot current;      // read by renderer threads
        private static List<Disc> building;            // main thread, during a sweep
        private static Snapshot unsaved;               // drawn but not yet written to disk
        private static string filePath;

        public static int Count { get { var s = current; return s == null ? 0 : s.discs.Length; } }

        // Main thread, at start (after TileStore.Init). Loads what the tiles on disk were
        // last drawn with, so the first sweep can tell what changed since.
        public static void Init(string worldDataPath)
        {
            filePath = Path.Combine(worldDataPath, FileName);
            current = null;
            try
            {
                if (!File.Exists(filePath)) return;
                var list = new List<Disc>();
                foreach (string line in File.ReadAllLines(filePath))
                {
                    string[] p = line.Split(' ');
                    if (p.Length < 3) continue;
                    if (float.TryParse(p[0], NumberStyles.Float, CultureInfo.InvariantCulture, out float x)
                        && float.TryParse(p[1], NumberStyles.Float, CultureInfo.InvariantCulture, out float y)
                        && float.TryParse(p[2], NumberStyles.Float, CultureInfo.InvariantCulture, out float z))
                        list.Add(Make(x, y, z));
                }
                current = Build(list);
            }
            catch (Exception e) { ZLog.LogWarning("WebMap: could not read " + FileName + ": " + e.Message); }
        }

        // ------------------------------------------------------------ renderer threads

        // Height at a world position once the discs are applied to the generator's height there.
        public static float Level(float wx, float wz, float height)
        {
            var s = current;
            if (s == null) return height;
            if (!s.cells.TryGetValue(CellKey(CellOf(wx), CellOf(wz)), out int[] idx)) return height;
            Disc[] ds = s.discs;
            float h = height;
            for (int n = 0; n < idx.Length; n++)
            {
                Disc d = ds[idx[n]];
                float dx = wx - d.cx, dz = wz - d.cz;
                float d2 = dx * dx + dz * dz;
                if (d2 >= Reach * Reach) continue;
                if (d2 <= LevelRadius * LevelRadius) { h = d.y; continue; }
                float u = (float)Math.Sqrt(d2) / Reach;
                float t = 1f - u * u * u;
                h += (d.y - h) * t;
            }
            return h;
        }

        // ------------------------------------------------------------ sweep (main thread)

        public static void Begin()
        {
            var s = current;
            building = new List<Disc>(s == null ? 16 : s.discs.Length + 16);
        }

        // Called for every object whose prefab is LocationProxy (WorldSweep checks the prefab).
        public static void Observe(ZDO zdo, Vector3 pos)
        {
            if (building == null) return;
            int location = 0;
            try { location = zdo.GetInt(ZDOVars.s_location, 0); } catch { }
            if (location != DiscLocation) return;
            building.Add(Make(pos.x, pos.y, pos.z));
        }

        // End of sweep. Publishes the discs and returns the zones whose ground changed
        // since the last drawn state (on the first sweep: since the file, or since nothing).
        public static List<long> Finish()
        {
            var list = building;
            building = null;
            var zones = new List<long>();
            if (list == null) return zones;

            // what the previous sweep enqueued has had a sweep interval to draw: remember it as done
            // once the queue is empty, so a stop in the middle of a redraw redraws again next time
            TrySave();

            Snapshot before = current;
            Snapshot after = Build(list);

            var was = KeysOf(before);
            var now = KeysOf(after);
            var dirty = new HashSet<long>();
            if (before != null)
                foreach (Disc d in before.discs) if (!now.Contains(KeyOf(d))) AddZones(dirty, d);
            foreach (Disc d in after.discs) if (!was.Contains(KeyOf(d))) AddZones(dirty, d);

            current = after;
            if (dirty.Count > 0) unsaved = after;   // no saved file counts as "nothing drawn": every disc is then dirty
            zones.AddRange(dirty);
            return zones;
        }

        // ------------------------------------------------------------ internals

        private static Disc Make(float x, float y, float z)
        {
            float ox = x + OffsetX, oy = y + OffsetY, oz = z + OffsetZ;
            return new Disc
            {
                x = x, y = y, z = z,
                cx = (float)Math.Floor(x + 0.5f), cz = (float)Math.Floor(z + 0.5f),
                // the game sorts its modifiers by their distance from the world's middle, height included
                order = ox * ox + oy * oy + oz * oz,
            };
        }

        private static int CompareOrder(Disc a, Disc b)
        {
            int c = a.order.CompareTo(b.order);
            if (c != 0) return c;
            c = a.x.CompareTo(b.x); if (c != 0) return c;
            c = a.z.CompareTo(b.z); if (c != 0) return c;
            return a.y.CompareTo(b.y);
        }

        private static Snapshot Build(List<Disc> list)
        {
            list.Sort(CompareOrder);
            var s = new Snapshot { discs = list.ToArray() };
            var tmp = new Dictionary<long, List<int>>();
            for (int i = 0; i < s.discs.Length; i++)
            {
                Disc d = s.discs[i];
                int x0 = CellOf(d.cx - Reach), x1 = CellOf(d.cx + Reach);
                int z0 = CellOf(d.cz - Reach), z1 = CellOf(d.cz + Reach);
                for (int cz = z0; cz <= z1; cz++)
                    for (int cx = x0; cx <= x1; cx++)
                    {
                        long k = CellKey(cx, cz);
                        if (!tmp.TryGetValue(k, out var l)) tmp[k] = l = new List<int>(8);
                        l.Add(i);                       // i ascends, so each cell stays in application order
                    }
            }
            s.cells = new Dictionary<long, int[]>(tmp.Count);
            foreach (var kv in tmp) s.cells[kv.Key] = kv.Value.ToArray();
            return s;
        }

        private static int CellOf(float w) => (int)Math.Floor(w / CellSize);
        private static long CellKey(int cx, int cz) => ((long)(cx + 4096) << 20) | (uint)(cz + 4096);

        private static Key KeyOf(Disc d) => new Key
        {
            x = (int)Math.Round(d.x * 100f), y = (int)Math.Round(d.y * 100f), z = (int)Math.Round(d.z * 100f),
        };

        private static HashSet<Key> KeysOf(Snapshot s)
        {
            var set = new HashSet<Key>();
            if (s != null) foreach (Disc d in s.discs) set.Add(KeyOf(d));
            return set;
        }

        // Every zone a change to this disc can reach.
        private static void AddZones(HashSet<long> into, Disc d)
        {
            int zx0 = TileMath.ZoneCoord(d.cx - DirtyMargin), zx1 = TileMath.ZoneCoord(d.cx + DirtyMargin);
            int zz0 = TileMath.ZoneCoord(d.cz - DirtyMargin), zz1 = TileMath.ZoneCoord(d.cz + DirtyMargin);
            for (int zz = zz0; zz <= zz1; zz++)
                for (int zx = zx0; zx <= zx1; zx++)
                    into.Add(TileMath.ZoneKey(zx, zz));
        }

        private static void TrySave()
        {
            var s = unsaved;
            if (s == null || filePath == null) return;
            if (TileStore.QueueLength > 0) return;
            try
            {
                var lines = new string[s.discs.Length];
                for (int i = 0; i < lines.Length; i++)
                {
                    Disc d = s.discs[i];
                    lines[i] = d.x.ToString("R", CultureInfo.InvariantCulture) + " "
                             + d.y.ToString("R", CultureInfo.InvariantCulture) + " "
                             + d.z.ToString("R", CultureInfo.InvariantCulture);
                }
                string tmp = filePath + ".tmp";
                File.WriteAllLines(tmp, lines);
                if (File.Exists(filePath)) File.Delete(filePath);
                File.Move(tmp, filePath);
                unsaved = null;
            }
            catch (Exception e) { ZLog.LogWarning("WebMap: could not write " + FileName + ": " + e.Message); }
        }
    }
}
