using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using WebMap.Tiles;

namespace WebMap.World
{
    // The one walk over every object in the world.
    //
    // Everything the map knows about the world's contents -- buildings,
    // trees, terraforming, portals, tombstones, boats -- comes from this
    // sweep, so the ZDO table is only ever walked once per cycle. It runs on
    // the main thread (ZDOs are not safe anywhere else) in slices of a few
    // thousand objects per frame, and the collectors it feeds publish their
    // results in one go at the end, so readers never see a half-built sweep.
    //
    // Zones whose ground changed (terraforming, felled or planted trees) are
    // handed to the tile store for re-rendering.
    internal static class WorldSweep
    {
        private static readonly int terrainCompilerHash = "_TerrainCompiler".GetStableHashCode();
        private static readonly Dictionary<int, string> nameCache = new Dictionary<int, string>();
        private static bool sweeping;

        public static volatile bool RefreshRequested;
        public static int LastScanned { get; private set; }
        public static double LastSweepSeconds { get; private set; }
        public static DateTime LastSweepUtc { get; private set; }
        public static int Sweeps { get; private set; }

        public static IEnumerator Loop()
        {
            float loopStart = Time.time;   // game time, like WaitForSeconds: it barely advances while the world is still loading
            yield return new WaitForSeconds(WebMapConfig.FIRST_SWEEP_DELAY);
            // one extra sweep shortly after start: the first one runs early so the map fills in quickly,
            // and this catches anything that was still loading when it did
            bool early = WebMapConfig.SECOND_SWEEP_DELAY > WebMapConfig.FIRST_SWEEP_DELAY;
            while (true)
            {
                yield return Sweep();
                if (early)
                {
                    early = false;
                    float wait = WebMapConfig.SECOND_SWEEP_DELAY - (Time.time - loopStart);
                    if (wait > 0f) yield return new WaitForSeconds(wait);
                    continue;
                }
                float waited = 0f;
                while (waited < WebMapConfig.SWEEP_INTERVAL && !RefreshRequested && !StructureMap.RefreshRequested)
                {
                    yield return new WaitForSeconds(1f);
                    waited += 1f;
                }
                RefreshRequested = false;
                StructureMap.RefreshRequested = false;
            }
        }

        public static string NameOf(int prefabHash)
        {
            if (nameCache.TryGetValue(prefabHash, out string n)) return n;
            n = null;
            try
            {
                var go = ZNetScene.instance != null ? ZNetScene.instance.GetPrefab(prefabHash) : null;
                if (go != null) n = go.name;
            }
            catch { }
            nameCache[prefabHash] = n;
            return n;
        }

        private static IEnumerator Sweep()
        {
            if (sweeping) yield break;
            sweeping = true;
            var started = DateTime.UtcNow;
            float t0 = Time.realtimeSinceStartup;

            List<ZDO> all = null;
            try { all = new List<ZDO>(ZDOMan.instance.m_objectsByID.Values); }
            catch (Exception e) { ZLog.LogWarning("WebMap: could not list ZDOs: " + e.Message); }
            if (all == null) { sweeping = false; yield break; }

            int size = WebMapConfig.TEXTURE_SIZE, half = size / 2, pixel = WebMapConfig.PIXEL_SIZE;
            int perFrame = Math.Max(500, WebMapConfig.SWEEP_ZDOS_PER_FRAME);
            // nobody connected (e.g. right after a restart): nobody to lag either, so sweep in big slices
            int peers = 0;
            try { peers = ZNet.instance != null ? ZNet.instance.GetPeers().Count : 0; } catch { }
            if (peers == 0) perFrame *= 20;

            Structures.Begin();
            Ruins.Begin();
            Vegetation.Begin();
            Vehicles.Begin();
            Markers.Begin();
            StructureMap.Begin();
            ForestMap.Begin();
            WorldObjects.Begin();
            var changedZones = new HashSet<long>();

            int seen = 0;
            foreach (var zdo in all)
            {
                seen++;
                if (zdo != null)
                {
                    try
                    {
                        Vector3 p = zdo.GetPosition();
                        int pref = zdo.GetPrefab();
                        if (pref == terrainCompilerHash)
                        {
                            if (TerrainPatches.Observe(zdo, p))
                                changedZones.Add(TileMath.ZoneKey(TileMath.ZoneCoord(p.x), TileMath.ZoneCoord(p.z)));
                        }
                        else
                        {
                            long creator = 0L;
                            try { creator = zdo.GetLong(ZDOVars.s_creator, 0L); } catch { }
                            // the 3D object data (and the model export it requests) only matters with 3D on
                            if (WebMapConfig.ENABLE_3D) WorldObjects.Observe(zdo, pref, p, creator);
                            int lx = Mathf.RoundToInt(p.x / pixel + half);
                            int ly = Mathf.RoundToInt(p.z / pixel + half);
                            bool inLegacy = lx >= 0 && ly >= 0 && lx < size && ly < size;
                            int legacyIdx = ly * size + lx;

                            if (creator != 0L)
                            {
                                var veh = Vehicles.Classify(pref);
                                if (veh != Vehicles.Kind.None) Vehicles.Observe(pref, veh, p);
                                else if (!Markers.Observe(zdo, NameOf(pref), p))
                                {
                                    Structures.Observe(zdo, pref, p, creator);
                                    if (inLegacy) StructureMap.Observe(pref, legacyIdx);
                                }
                            }
                            else if (!Markers.Observe(zdo, NameOf(pref), p))
                            {
                                if (Vegetation.Observe(pref, p)) { if (inLegacy) ForestMap.Observe(pref, legacyIdx); }
                                else Ruins.Observe(zdo, pref, p);
                            }
                        }
                    }
                    catch (Exception e)
                    {
                        if (WebMapConfig.DEBUG) ZLog.LogWarning("WebMap: sweep skipped an object: " + e.Message);
                    }
                }
                if (seen % perFrame == 0) yield return null;
            }

            foreach (long z in Vegetation.Finish()) changedZones.Add(z);
            yield return null;
            int changedChunks = Structures.Finish();
            Ruins.Finish();
            yield return null;
            Vehicles.Finish();
            Markers.Finish();
            yield return null;
            StructureMap.Finish();
            StructureMap.LastScanned = seen;
            yield return null;
            ForestMap.Finish();
            yield return null;
            int changedObjectChunks = WorldObjects.Finish();

            // The first sweep after a start only establishes the baseline: the
            // collectors' change hashes are empty, so every wood and moat would
            // otherwise count as "changed" and every close-zoom tile on disk would
            // be re-rendered at each restart.
            int rerendered = 0;
            if (Sweeps > 0)
                foreach (long key in changedZones)
                {
                    TileMath.UnzoneKey(key, out int zx, out int zz);
                    TileStore.OnZoneChanged(zx, zz);
                    rerendered++;
                }

            LastScanned = seen;
            LastSweepSeconds = Time.realtimeSinceStartup - t0;
            LastSweepUtc = started;
            Sweeps++;
            sweeping = false;
            ZLog.Log($"WebMap: world sweep #{Sweeps}: {seen} objects in {LastSweepSeconds:0.0}s -> {Structures.Total} pieces ({changedChunks} chunks changed), "
                   + $"{Vegetation.LastTrees} trees, {Vegetation.LastRocks} rocks, {TerrainPatches.Count} terraformed zones, {rerendered} zones re-rendered, "
                   + $"{WorldObjects.Total} 3D objects ({changedObjectChunks} chunks changed), {Models.ModelStore.QueueLength} models to export");
            Live.Stats.OnSweep();
            MapDataServer.getInstance()?.BroadcastWorldRevision();
        }
    }
}
