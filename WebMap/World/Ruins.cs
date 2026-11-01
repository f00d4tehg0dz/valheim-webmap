using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using UnityEngine;
using WebMap.Tiles;
using WebMap.Util;

namespace WebMap.World
{
    // World-generated structures -- abandoned houses, fuling villages, shipwrecks, mountain and
    // castle ruins -- as vector data for the 2D map. Same chunk format as the player-built
    // Structures ([x, z, y, yaw, sx, sz, h, mat, prefabIdx] per piece) and the same name-based
    // footprints, so the 2D map gets them without the 3D object data or the model export.
    // Like Structures, a chunk is only advertised once it is under explored ground.
    internal static class Ruins
    {
        private sealed class Chunk { public int rev; public string json; public int count; }
        private static readonly ConcurrentDictionary<int, Chunk> chunks = new ConcurrentDictionary<int, Chunk>();
        private static readonly ConcurrentDictionary<int, int> chunkHash = new ConcurrentDictionary<int, int>();
        private static readonly Dictionary<int, bool> wanted = new Dictionary<int, bool>();
        private static Dictionary<int, List<Structures.Piece>> building;
        private static int total;
        private static volatile string indexJson = "{\"rev\":0,\"chunks\":[]}";
        private static int indexRev, indexExplored = -1;

        // structural pieces that are not Piece/WearNTear prefabs but still read as buildings
        private static readonly Regex kits = new Regex("^(mountainkit|castlekit|goblin|dvergr|dverger|ashland|charred|blackmarble|startplatform|bossstone_|cloth_hanging|fenrirhide|shipwreck|ruin)", RegexOptions.Compiled);

        public static int Total { get; private set; }
        public static string IndexJson => indexJson;

        private static int ChunkKey(int cx, int cz) => cx * 4096 + cz;

        public static void Begin()
        {
            building = new Dictionary<int, List<Structures.Piece>>(chunks.Count + 16);
            total = 0;
        }

        // Main thread. Called for objects nobody built that are neither markers nor vegetation.
        public static void Observe(ZDO zdo, int prefabHash, Vector3 pos)
        {
            if (building == null || !Wanted(prefabHash)) return;
            // dungeon interiors are built high above their entrance (y ~ 5000): skip them, they would
            // pinpoint every crypt and cave from the map (the same no-spoilers rule as the markers)
            if (pos.y > 1000f) return;
            var shape = Structures.ShapeOf(prefabHash);
            if (shape.skip) return;
            short yaw = 0;
            try { yaw = (short)Math.Round(zdo.GetRotation().eulerAngles.y); } catch { }
            int cx = TileMath.ChunkCoord(pos.x), cz = TileMath.ChunkCoord(pos.z);
            if (cx < 0 || cz < 0 || cx >= TileMath.ChunksPerSide || cz >= TileMath.ChunksPerSide) return;
            int key = ChunkKey(cx, cz);
            if (!building.TryGetValue(key, out var list)) building[key] = list = new List<Structures.Piece>(64);
            list.Add(new Structures.Piece { x = pos.x, y = pos.y, z = pos.z, yaw = yaw, sx = shape.sx, sz = shape.sz, h = shape.h, mat = shape.mat, prefab = prefabHash });
            total++;
        }

        private static bool Wanted(int prefabHash)
        {
            if (wanted.TryGetValue(prefabHash, out bool w)) return w;
            w = false;
            try
            {
                var go = ZNetScene.instance != null ? ZNetScene.instance.GetPrefab(prefabHash) : null;
                if (go != null)
                {
                    string n = go.name.ToLowerInvariant();
                    // never spawners, pickables, loot or anything a player could farm off the map
                    bool excluded = n.StartsWith("dungeon_") || n.Contains("spawner") || n.StartsWith("pickable") || n.Contains("treasure") || n.Contains("loot")
                        || n.Contains("_ragdoll") || n.StartsWith("vfx_") || n.StartsWith("sfx_") || n.StartsWith("fx_");
                    // creatures (the fulings themselves match "goblin"), pickables, items and bones are not buildings
                    if (!excluded)
                        foreach (var comp in new[] { "Character", "Humanoid", "MonsterAI", "AnimalAI", "Pickable", "ItemDrop", "Tameable" })
                            if (go.GetComponent(comp) != null) { excluded = true; break; }
                    if (!excluded && (n.Contains("_ribs") || n.Contains("skull") || n.Contains("bones") || n.Contains("berries") || n.Contains("bush")))
                        excluded = true;
                    if (!excluded)
                        w = go.GetComponent("Piece") != null || go.GetComponent("WearNTear") != null || kits.IsMatch(n);
                }
            }
            catch { }
            wanted[prefabHash] = w;
            return w;
        }

        // Main thread, end of sweep. Publishes changed chunks; returns how many changed.
        public static int Finish()
        {
            if (building == null) return 0;
            int changed = 0;
            var seen = new HashSet<int>();
            foreach (var kv in building)
            {
                var list = kv.Value;
                list.Sort((a, b) => a.z != b.z ? a.z.CompareTo(b.z) : a.x.CompareTo(b.x));
                int h = 17;
                foreach (var p in list)
                    h = unchecked(h * 31 + (int)(p.x * 10) * 7 + (int)(p.z * 10) * 13 + (int)(p.y * 10) * 3 + p.yaw * 101 + p.prefab);
                seen.Add(kv.Key);
                if (chunkHash.TryGetValue(kv.Key, out int old) && old == h) continue;
                chunkHash[kv.Key] = h;
                int cx = kv.Key / 4096, cz = kv.Key % 4096;
                int rev = (chunks.TryGetValue(kv.Key, out var prev) ? prev.rev : 0) + 1;
                var pieces = list.ToArray();
                chunks[kv.Key] = new Chunk { rev = rev, count = pieces.Length, json = BuildChunkJson(cx, cz, rev, pieces) };
                changed++;
            }
            foreach (int key in new List<int>(chunks.Keys))
            {
                if (seen.Contains(key)) continue;
                chunks.TryRemove(key, out _);
                chunkHash.TryRemove(key, out _);
                changed++;
            }
            Total = total;
            int explored = Fog.ExploredCells;
            if (changed > 0 || explored != indexExplored) { indexRev++; indexExplored = explored; indexJson = BuildIndex(); }
            building = null;
            return changed;
        }

        // null when the chunk is unknown or not explored yet
        public static string ChunkJson(int cx, int cz)
        {
            float minX = TileMath.ChunkMin(cx), minZ = TileMath.ChunkMin(cz);
            if (!WebMapConfig.REVEAL_ALL && !Fog.AnyExplored(minX, minZ, minX + TileMath.CHUNK_SIZE, minZ + TileMath.CHUNK_SIZE)) return null;
            return chunks.TryGetValue(ChunkKey(cx, cz), out var c) ? c.json : null;
        }

        private static string BuildChunkJson(int cx, int cz, int rev, Structures.Piece[] pieces)
        {
            var names = new Dictionary<int, int>();
            var nameList = new List<string>();
            var j = new JsonWriter(pieces.Length * 48 + 256);
            j.BeginObject();
            j.Prop("cx", cx).Prop("cz", cz).Prop("rev", rev).Prop("count", pieces.Length);
            j.Key("pieces").BeginArray();
            foreach (var p in pieces)
            {
                if (!names.TryGetValue(p.prefab, out int idx))
                {
                    idx = nameList.Count; names[p.prefab] = idx;
                    nameList.Add(Structures.ShapeOf(p.prefab).name);
                }
                j.BeginArray();
                j.Value(p.x, 1).Value(p.z, 1).Value(p.y, 1).Value((int)p.yaw);
                j.Value(p.sx, 2).Value(p.sz, 2).Value(p.h, 2).Value((int)p.mat).Value(idx);
                j.End();
            }
            j.End();
            j.Key("prefabs").BeginArray();
            foreach (var n in nameList) j.Value(n);
            j.End();
            j.End();
            return j.ToString();
        }

        private static string BuildIndex()
        {
            var j = new JsonWriter(chunks.Count * 24 + 64);
            j.BeginObject();
            j.Prop("rev", indexRev);
            j.Prop("chunkSize", TileMath.CHUNK_SIZE);
            j.Key("chunks").BeginArray();
            foreach (var kv in chunks)
            {
                int cx = kv.Key / 4096, cz = kv.Key % 4096;
                float minX = TileMath.ChunkMin(cx), minZ = TileMath.ChunkMin(cz);
                if (!WebMapConfig.REVEAL_ALL && !Fog.AnyExplored(minX, minZ, minX + TileMath.CHUNK_SIZE, minZ + TileMath.CHUNK_SIZE)) continue;
                j.BeginArray().Value(cx).Value(cz).Value(kv.Value.rev).Value(kv.Value.count).End();
            }
            j.End();
            j.End();
            return j.ToString();
        }
    }
}
