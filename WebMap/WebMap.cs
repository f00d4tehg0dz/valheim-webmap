using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text.RegularExpressions;
using BepInEx;
using HarmonyLib;
using UnityEngine;
using WebMap.Live;
using WebMap.Patches;
using WebMap.Tiles;
using WebMap.World;
using static ZRoutedRpc;
using Random = UnityEngine.Random;

namespace WebMap
{
    [BepInPlugin(GUID, NAME, VERSION)]
    public class WebMap : BaseUnityPlugin
    {
        public const string GUID = "com.valheimwebmap.server";
        public const string NAME = "WebMap";
        public const string VERSION = "2.1.2";

        private static readonly string[] ALLOWED_PINS = { "dot", "fire", "mine", "house", "cave" };

        public DiscordWebHook discordWebHook;
        public static MapDataServer mapDataServer;
        public static string worldDataPath;
        public static string mapDataPath;
        public static string pluginPath;

        public static int sayMethodHash = 0;
        public static int chatMessageMethodHash = 0;

        public static string currentWorldName;
        public static Dictionary<string, object> serverInfo;

        private static Harmony harmony;
        public static WebMap instance;

        public void Awake()
        {
            instance = this;
            harmony = new Harmony(GUID);
            harmony.PatchAll(Assembly.GetExecutingAssembly());

            pluginPath = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            mapDataPath = Path.Combine(pluginPath ?? string.Empty, "map_data");
            Directory.CreateDirectory(mapDataPath);

            WebMapConfig.ReadConfigFile(Config);
            discordWebHook = new DiscordWebHook(WebMapConfig.DISCORD_WEBHOOK);
            ZLog.Log($"WebMap {VERSION} loaded");
        }

        // No Config.Save() here: BepInEx writes the file when the entries are bound,
        // and saving on shutdown overwrote edits made while the server was running.
        public void OnDestroy() { }

        // ---------------------------------------------------------------- world lifecycle

        public void SetServerInfo(bool openServer, bool publicServer, string serverName, string password, string worldName)
        {
            serverInfo = new Dictionary<string, object>
            {
                ["openServer"] = openServer, ["publicServer"] = publicServer, ["serverName"] = serverName,
                ["password"] = password, ["worldName"] = worldName
                // the world seed is deliberately not kept anywhere: it must never reach the web
            };
        }

        public void NewWorld()
        {
            string worldName = WebMapConfig.GetWorldName();
            bool forceReload = currentWorldName != null && currentWorldName != worldName;

            worldDataPath = Path.Combine(mapDataPath, worldName);
            Directory.CreateDirectory(worldDataPath);

            if (mapDataServer == null)
            {
                ZLog.Log($"WebMap: loading world '{worldName}'");
                mapDataServer = new MapDataServer();
            }
            else if (forceReload)
            {
                ZLog.Log($"WebMap: switching world from '{currentWorldName}' to '{worldName}'");
            }
            currentWorldName = worldName;

            // single-image world render (served at /map for simple clients)
            try
            {
                string mapImagePath = Path.Combine(worldDataPath, "map.png");
                if (File.Exists(mapImagePath))
                {
                    mapDataServer.mapImageData = File.ReadAllBytes(mapImagePath);
                    mapDataServer.BuildMapJpg();
                }
            }
            catch (Exception e) { ZLog.LogWarning("WebMap: legacy map.png not readable: " + e.Message); }

            Fog.Init(WebMapConfig.TEXTURE_SIZE, WebMapConfig.PIXEL_SIZE);
            string fogPath = Path.Combine(worldDataPath, "fog.png");
            if (!Fog.Load(fogPath))
            {
                ZLog.Log("WebMap: starting a fresh fog of war");
                Fog.Save(fogPath);
            }

            try
            {
                string pinsFile = Path.Combine(worldDataPath, "pins.csv");
                if (File.Exists(pinsFile)) mapDataServer.pins = new List<string>(File.ReadAllLines(pinsFile));
            }
            catch (Exception e) { ZLog.LogWarning("WebMap: pins.csv not readable: " + e.Message); }

            Stats.Load();
            Events.LoadTail();
            TileStore.Init(worldDataPath);
            Models.ModelStore.Init(mapDataPath);

            if (forceReload) mapDataServer.Reload();
        }

        public void Online()
        {
            StaticCoroutine.Start(PlayerSnapshotLoop());
            StaticCoroutine.Start(UpdateFogLoop());
            StaticCoroutine.Start(SaveLoop());
            StaticCoroutine.Start(WorldSweep.Loop());
            StaticCoroutine.Start(Announce.Pump());
            StaticCoroutine.Start(TileStore.MainThreadPump());
            StaticCoroutine.Start(Models.ModelStore.Pump());
            TileStore.Start();
            // close-zoom tiles for everything already explored (cheap: only queues what is missing)
            int stride = Math.Max(1, (int)(TileMath.TileSpanMeters(WebMapConfig.PRERENDER_ZOOM + 1) / WebMapConfig.PIXEL_SIZE / 2));
            Fog.ForEachExplored(TileStore.OnExplored, stride);
            Events.Add("server", "Server", "online");
            NotifyOnline();
        }

        public void NotifyOnline()
        {
            try
            {
                string ip = AccessTools.Method(typeof(ZNet), "GetServerIP")?.Invoke(ZNet.instance, new object[] { })?.ToString() ?? "";
                discordWebHook.SendMessage($"🎮 **{serverInfo["serverName"]}** is *online* 🟢\n💻 {ip}:{ZNet.instance.GetHostPort()}\n🔑 {serverInfo["password"]}\n🗺 {WebMapConfig.URL}");
            }
            catch (Exception e) { if (WebMapConfig.DEBUG) ZLog.LogWarning("WebMap: online notice failed: " + e.Message); }
        }

        public void NotifyOffline()
        {
            try { discordWebHook.SendMessage($"🎮 **{serverInfo["serverName"]}** is *offline* 🔴"); } catch { }
        }

        public void NotifyJoin(ZNetPeer peer)
        {
            string message = $"player _{peer.m_playerName}_ joined";
            discordWebHook.SendMessage($"🎮 **{serverInfo["serverName"]}** {message}");
            Events.Add("join", peer.m_playerName, "joined the server");
            Stats.OnJoin(Players.KeyOf(peer), peer.m_playerName);
        }

        public void NotifyLeave(ZNetPeer peer)
        {
            string message = $"player _{peer.m_playerName}_ left";
            discordWebHook.SendMessage($"🎮 **{serverInfo["serverName"]}** {message}");
            Announce.Enqueue(message);
            Events.Add("leave", peer.m_playerName, "left the server");
            Stats.OnLeave(Players.KeyOf(peer), peer.m_playerName);
            Players.Forget(peer);
        }

        // ---------------------------------------------------------------- loops (main thread)

        public IEnumerator PlayerSnapshotLoop()
        {
            while (true)
            {
                try
                {
                    Players.Refresh(mapDataServer.players);
                    Stats.OnTick(Players.Current);
                }
                catch (Exception e) { if (WebMapConfig.DEBUG) ZLog.LogWarning("WebMap: player snapshot failed: " + e.Message); }
                yield return new WaitForSeconds(WebMapConfig.PLAYER_UPDATE_INTERVAL);
            }
        }

        public IEnumerator UpdateFogLoop()
        {
            float visitedT = 0f;
            while (true)
            {
                yield return new WaitForSeconds(WebMapConfig.UPDATE_FOG_TEXTURE_INTERVAL);
                try
                {
                    foreach (var p in Players.Current)
                    {
                        if (!p.tracked || p.dead) continue;
                        int n = Fog.Reveal(p.x, p.z, WebMapConfig.EXPLORE_RADIUS);
                        if (n > 0) Stats.OnRevealed(p.key, p.name, n);
                    }
                    // zones generated since the last look (ships, hidden players): once a minute is plenty
                    visitedT += WebMapConfig.UPDATE_FOG_TEXTURE_INTERVAL;
                    if (visitedT >= 60f) { visitedT = 0f; Fog.RevealVisitedZones(); }
                }
                catch (Exception e) { if (WebMapConfig.DEBUG) ZLog.LogWarning("WebMap: fog update failed: " + e.Message); }
            }
        }

        public IEnumerator SaveLoop()
        {
            float fogT = 0f, statsT = 0f;
            while (true)
            {
                yield return new WaitForSeconds(5f);
                fogT += 5f; statsT += 5f;
                if (fogT >= WebMapConfig.SAVE_FOG_TEXTURE_INTERVAL)
                {
                    fogT = 0f;
                    if (Fog.Dirty) Fog.Save(Path.Combine(worldDataPath, "fog.png"));
                }
                if (statsT >= WebMapConfig.STATS_SAVE_INTERVAL)
                {
                    statsT = 0f;
                    Stats.Save();
                }
            }
        }

        public static void SavePins()
        {
            try { lock (mapDataServer.pins) File.WriteAllLines(Path.Combine(worldDataPath, "pins.csv"), mapDataServer.pins); }
            catch (Exception e) { ZLog.Log("WebMap: FAILED TO WRITE PINS FILE! " + e.Message); }
        }

        // ---------------------------------------------------------------- pins
        //
        // Pins come from chat (!pin, !undopin, !deletepin) and from the web page (POST /api/pin).
        // On Valheim 1.0 chat is sent player to player, so the server only sees it while it is
        // forwarding between two or more players: a lone player's !pin never reaches us. The web
        // page is the way that always works.

        public static readonly Regex PinTextFilter = new Regex("[^a-zA-Z0-9 ]", RegexOptions.Compiled);

        public static string CleanPinText(string text, int max = 20)
        {
            text = PinTextFilter.Replace((text ?? "").Trim(), "");
            return text.Length > max ? text.Substring(0, max) : text;
        }

        public static string CleanPinType(string type) => Array.Exists(ALLOWED_PINS, e => e == (type ?? "").ToLower()) ? type.ToLower() : "dot";

        // owner: who may undo it (steam id for chat, "web:<client>" for the page)
        public static string PlacePin(string owner, string type, string name, Vector3 pos, string text)
        {
            long timestamp = new DateTimeOffset(DateTime.UtcNow).ToUnixTimeSeconds();
            string pinId = $"{timestamp}-{Random.Range(1000, 9999)}";
            mapDataServer.AddPin(owner, pinId, CleanPinType(type), name, pos, CleanPinText(text));

            int overflow;
            lock (mapDataServer.pins) overflow = mapDataServer.pins.FindAll(pin => pin.StartsWith(owner + ",")).Count - WebMapConfig.MAX_PINS_PER_USER;
            for (int t = overflow; t > 0; t--)
            {
                int pinIdx;
                lock (mapDataServer.pins) pinIdx = mapDataServer.pins.FindIndex(pin => pin.StartsWith(owner + ","));
                if (pinIdx > -1) mapDataServer.RemovePin(pinIdx);
            }
            SavePins();
            return pinId;
        }

        public static bool UndoPin(string owner)
        {
            int pinIdx;
            lock (mapDataServer.pins) pinIdx = mapDataServer.pins.FindLastIndex(pin => pin.StartsWith(owner + ","));
            if (pinIdx < 0) return false;
            mapDataServer.RemovePin(pinIdx); SavePins();
            return true;
        }

        public static bool DeletePinByText(string owner, string text)
        {
            int pinIdx;
            lock (mapDataServer.pins) pinIdx = mapDataServer.pins.FindLastIndex(pin =>
            {
                string[] pinParts = pin.Split(',');
                return pinParts[0] == owner && pinParts[pinParts.Length - 1] == text;
            });
            if (pinIdx < 0) return false;
            mapDataServer.RemovePin(pinIdx); SavePins();
            return true;
        }

        // remove one pin by id; owner "" (token holder) may remove any
        public static bool DeletePinById(string owner, string pinId)
        {
            int pinIdx;
            lock (mapDataServer.pins) pinIdx = mapDataServer.pins.FindIndex(pin =>
            {
                string[] pinParts = pin.Split(',');
                return pinParts.Length > 1 && pinParts[1] == pinId && (owner.Length == 0 || pinParts[0] == owner);
            });
            if (pinIdx < 0) return false;
            mapDataServer.RemovePin(pinIdx); SavePins();
            return true;
        }

        // true when the message was a command (and so not ordinary chat)
        private static bool HandleChatCommand(string owner, string name, Vector3 pos, string message)
        {
            string upper = message.ToUpper();
            if (upper.StartsWith("!PIN"))
            {
                string[] parts = message.Split(' ');
                string type = "dot"; int startIdx = 1;
                if (parts.Length > 1 && Array.Exists(ALLOWED_PINS, e => e == parts[1].ToLower())) { type = parts[1].ToLower(); startIdx = 2; }
                string text = startIdx < parts.Length ? string.Join(" ", parts, startIdx, parts.Length - startIdx) : "";
                PlacePin(owner, type, name, pos, text);
                return true;
            }
            if (upper.StartsWith("!UNDOPIN")) { UndoPin(owner); return true; }
            if (upper.StartsWith("!DELETEPIN"))
            {
                string[] parts = message.Split(' ');
                DeletePinByText(owner, parts.Length > 1 ? string.Join(" ", parts, 1, parts.Length - 1) : "");
                return true;
            }
            return false;
        }

        // ---------------------------------------------------------------- patches

        // Single-image world render, served at /map and used as the page's fallback base layer.
        [HarmonyPatch(typeof(ZoneSystem), nameof(ZoneSystem.Start))]
        private class ZoneSystemPatch
        {
            private static readonly Color DeepWaterColor = new Color(0.36105883f, 0.36105883f, 0.43137255f);
            private static readonly Color ShallowWaterColor = new Color(0.574f, 0.50709206f, 0.47892025f);
            private static readonly Color ShoreColor = new Color(0.1981132f, 0.12241901f, 0.1503943f);

            private static Color GetPixelColor(Heightmap.Biome biome)
            {
                switch (biome)
                {
                    case Heightmap.Biome.Meadows: return new Color(0.573f, 0.655f, 0.361f);
                    case Heightmap.Biome.Swamp: return new Color(0.639f, 0.447f, 0.345f);
                    case Heightmap.Biome.Mountain: return Color.white;
                    case Heightmap.Biome.BlackForest: return new Color(0.420f, 0.455f, 0.247f);
                    case Heightmap.Biome.Plains: return new Color(0.906f, 0.671f, 0.470f);
                    case Heightmap.Biome.AshLands: return new Color(0.690f, 0.192f, 0.192f);
                    case Heightmap.Biome.DeepNorth: return Color.white;
                    case Heightmap.Biome.Mistlands: return new Color(0.36f, 0.22f, 0.4f);
                    default: return Color.white;
                }
            }

            private static void Postfix(ZoneSystem __instance)
            {
                WebMap.instance.NewWorld();
                if (mapDataServer.mapImageData != null || !WebMapConfig.LEGACY_MAP) return;

                ZLog.Log("WebMap: building legacy world render (once)");
                int size = WebMapConfig.TEXTURE_SIZE, num = size / 2;
                float num2 = WebMapConfig.PIXEL_SIZE / 2f;
                Color32[] colorArray = new Color32[size * size];
                float[] heightArray = new float[size * size];
                for (int i = 0; i < size; i++)
                    for (int j = 0; j < size; j++)
                    {
                        float wx = (j - num) * WebMapConfig.PIXEL_SIZE + num2;
                        float wy = (i - num) * WebMapConfig.PIXEL_SIZE + num2;
                        Heightmap.Biome biome = WorldGenerator.instance.GetBiome(wx, wy);
                        float biomeHeight = WorldGenerator.instance.GetBiomeHeight(biome, wx, wy, out Color _);
                        colorArray[i * size + j] = GetPixelColor(biome);
                        heightArray[i * size + j] = biomeHeight;
                    }

                float waterLevel = ZoneSystem.instance.m_waterLevel;
                Vector3 sunDir = new Vector3(-0.57735f, 0.57735f, 0.57735f);
                Color[] newColors = new Color[colorArray.Length];
                for (int t = 0; t < colorArray.Length; t++)
                {
                    float h = heightArray[t];
                    int tUp = t - size; if (tUp < 0) tUp = t;
                    int tDown = t + size; if (tDown > colorArray.Length - 1) tDown = t;
                    int tRight = t + 1; if (tRight > colorArray.Length - 1) tRight = t;
                    int tLeft = t - 1; if (tLeft < 0) tLeft = t;
                    Vector3 va = new Vector3(2f, 0f, heightArray[tRight] - heightArray[tLeft]).normalized;
                    Vector3 vb = new Vector3(0f, 2f, heightArray[tUp] - heightArray[tDown]).normalized;
                    float surfaceLight = Vector3.Dot(Vector3.Cross(va, vb), sunDir) * 0.25f + 0.75f;
                    float shoreMask = Mathf.Clamp(h - waterLevel, 0, 1);
                    float shallowRamp = Mathf.Clamp((h - waterLevel + 0.2f * 12.5f) * 0.5f, 0, 1);
                    float deepRamp = Mathf.Clamp((h - waterLevel + 1f * 12.5f) * 0.1f, 0, 1);
                    Color ans = Color.Lerp(ShoreColor, colorArray[t], shoreMask);
                    ans = Color.Lerp(ShallowWaterColor, ans, shallowRamp);
                    ans = Color.Lerp(DeepWaterColor, ans, deepRamp);
                    newColors[t] = new Color(ans.r * surfaceLight, ans.g * surfaceLight, ans.b * surfaceLight, ans.a);
                }

                Texture2D newTexture = new Texture2D(size, size, TextureFormat.RGBA32, false);
                newTexture.SetPixels(newColors);
                byte[] pngBytes = ImageConv.EncodeToPNG(newTexture);
                UnityEngine.Object.Destroy(newTexture);
                mapDataServer.mapImageData = pngBytes;
                mapDataServer.BuildMapJpg();
                try { File.WriteAllBytes(Path.Combine(worldDataPath, "map.png"), pngBytes); }
                catch (Exception e) { ZLog.LogError("WebMap: FAILED TO WRITE MAP FILE! " + e.Message); }
            }
        }

        [HarmonyPatch(typeof(ZoneSystem), nameof(ZoneSystem.Load))]
        private class ZoneSystemLoadPatch
        {
            private static void Postfix()
            {
                if (ZoneSystem.instance.FindClosestLocation("StartTemple", Vector3.zero, out ZoneSystem.LocationInstance startLocation))
                {
                    WebMapConfig.WORLD_START_POS = startLocation.m_position;
                    ZLog.Log("WebMap: starting point " + WebMapConfig.WORLD_START_POS);
                }
                else ZLog.LogWarning("WebMap: failed to find starting point");

                WebMap.instance.Online();
                mapDataServer.ListenAsync();
                try { Fog.RevealVisitedZones(); } catch (Exception e) { ZLog.LogWarning("WebMap: visited-zone reveal failed: " + e.Message); }
            }
        }

        [HarmonyPatch(typeof(ZNet), nameof(ZNet.Start))]
        private class ZNetPatchStart
        {
            private static void Postfix(List<ZNetPeer> ___m_peers) { mapDataServer.players = ___m_peers; }
        }

        [HarmonyPatch(typeof(ZNet), nameof(ZNet.Shutdown))]
        private class ZNetPatchShutdown
        {
            private static void Postfix()
            {
                try { Stats.Save(force: true); } catch { }
                try { if (Fog.Dirty) Fog.Save(Path.Combine(worldDataPath, "fog.png")); } catch { }
                TileStore.Stop();
                mapDataServer.Stop();
                WebMap.instance.NotifyOffline();
            }
        }

        [HarmonyPatch(typeof(ZNet), nameof(ZNet.SetServer))]
        private class ZNetPatchSetServer
        {
            // global:: because the mod's WebMap.World namespace shadows the game's World class here
            private static void Postfix(bool server, bool openServer, bool publicServer, string serverName, string password, global::World world)
            {
                WebMap.instance.SetServerInfo(openServer, publicServer, serverName, password, world.m_name);
            }
        }

        [HarmonyPatch(typeof(ZNet), nameof(ZNet.Disconnect))]
        private class ZNetPatchDisconnect
        {
            private static void Prefix(ref ZNetPeer peer)
            {
                if (!peer.m_server && !string.IsNullOrEmpty(peer.m_playerName)) WebMap.instance.NotifyLeave(peer);
            }
        }

        [HarmonyPatch(typeof(ZRoutedRpc), nameof(ZRoutedRpc.AddPeer))]
        private class ZRoutedRpcAddPeerPatch
        {
            private static void Postfix(ZNetPeer peer)
            {
                if (!peer.m_server && !string.IsNullOrEmpty(peer.m_playerName)) WebMap.instance.NotifyJoin(peer);
            }
        }

        // Chat on 1.0 is addressed per recipient and passes through RouteRPC on the
        // server while it forwards; HandleRoutedRPC only sees Everybody-targeted
        // traffic (pings). See README "How chat reaches the server on 1.0".
        [HarmonyPatch(typeof(ZRoutedRpc), "RouteRPC")]
        private class ZRoutedRpcRoutePatch
        {
            private static readonly Dictionary<string, float> recent = new Dictionary<string, float>();

            private static void Prefix(ref ZRoutedRpc __instance, RoutedRPCData rpcData)
            {
                if (rpcData == null || rpcData.m_targetPeerID == 0L) return;
                try
                {
                    if (IsDuplicate(rpcData)) return;
                    RoutedRPCData data = rpcData;
                    ZRoutedRpcPatch.Observe(ref __instance, ref data);
                }
                catch (Exception ex) { ZLog.LogWarning("WebMap: failed observing a routed rpc: " + ex); }
            }

            private static bool IsDuplicate(RoutedRPCData d)
            {
                byte[] body = d.m_parameters != null ? d.m_parameters.GetArray() : null;
                uint h = 2166136261u;
                if (body != null) foreach (byte b in body) { h ^= b; h *= 16777619u; }
                string key = d.m_senderPeerID + ":" + d.m_methodHash + ":" + h;
                float now = Time.realtimeSinceStartup;
                if (recent.TryGetValue(key, out float seen) && now - seen < 2f) return true;
                recent[key] = now;
                if (recent.Count > 256)
                {
                    var stale = new List<string>();
                    foreach (var kv in recent) if (now - kv.Value > 10f) stale.Add(kv.Key);
                    foreach (var k in stale) recent.Remove(k);
                }
                return false;
            }
        }

        [HarmonyPatch(typeof(ZRoutedRpc), nameof(ZRoutedRpc.HandleRoutedRPC))]
        private class ZRoutedRpcPatch
        {
            private static readonly string[] ignoreRpc = { "DestroyZDO", "SetEvent", "OnTargeted", "Step" };

            private static void Postfix(ref ZRoutedRpc __instance, ref RoutedRPCData data) => Observe(ref __instance, ref data);

            internal static void Observe(ref ZRoutedRpc __instance, ref RoutedRPCData data)
            {
                int hash = data?.m_methodHash ?? 0;
                if (hash == 0) return;
                bool isSay = hash == sayMethodHash || hash == "Say".GetStableHashCode();
                bool isChat = hash == chatMessageMethodHash || hash == "ChatMessage".GetStableHashCode();
                if (!isSay && !isChat)
                {
                    if (WebMapConfig.DEBUG)
                    {
                        string other = StringExtensionMethods_Patch.GetStableHashName(hash);
                        if (!Array.Exists(ignoreRpc, x => x == other)) ZLog.Log("RoutedRPC: " + other);
                    }
                    return;
                }

                ZNetPeer peer = ZNet.instance.GetPeer(data.m_senderPeerID);
                string steamid = "";
                if (peer != null) { try { steamid = peer.m_rpc.GetSocket().GetHostName(); } catch { } }

                if (isSay)
                {
                    sayMethodHash = data.m_methodHash;
                    try
                    {
                        // the talker's own ZDO is the rpc target on 1.0; fall back to the peer
                        ZDO zdoData = !data.m_targetZDO.IsNone() ? ZDOMan.instance.GetZDO(data.m_targetZDO) : null;
                        if (zdoData == null && peer != null) zdoData = ZDOMan.instance.GetZDO(peer.m_characterID);
                        Vector3 pos = zdoData != null ? zdoData.GetPosition() : (peer != null ? peer.m_refPos : Vector3.zero);
                        ZPackage package = new ZPackage(data.m_parameters.GetArray());   // a copy: the original must still be forwarded
                        var messageType = package.ReadInt();
                        var userInfo = new UserInfo();
                        userInfo.Deserialize(ref package);
                        string message = (package.ReadString() ?? "").Trim();

                        if (!HandleChatCommand(steamid, userInfo.Name, pos, message) && messageType != (int)Talker.Type.Whisper)
                        {
                            mapDataServer.AddMessage(data.m_senderPeerID, messageType, userInfo.Name, message);
                        }
                    }
                    catch (Exception ex) { ZLog.LogWarning("WebMap: failed handling a chat message: " + ex); }
                }
                else
                {
                    chatMessageMethodHash = data.m_methodHash;
                    try
                    {
                        ZPackage package = new ZPackage(data.m_parameters.GetArray());
                        Vector3 pos = package.ReadVector3();
                        var messageType = package.ReadInt();
                        var userInfo = new UserInfo();
                        userInfo.Deserialize(ref package);
                        if (messageType == (int)Talker.Type.Ping)
                        {
                            mapDataServer.BroadcastPing(data.m_senderPeerID, userInfo.Name, pos);
                        }
                        else
                        {
                            var message = (package.ReadString() ?? "").Trim();
                            if (!HandleChatCommand(steamid, userInfo.Name, pos, message))
                                mapDataServer.AddMessage(data.m_senderPeerID, messageType, userInfo.Name, message);
                        }
                    }
                    catch (Exception ex) { if (WebMapConfig.DEBUG) ZLog.LogError(ex.ToString()); }
                }
            }
        }
    }

    public class StaticCoroutine
    {
        private static StaticCoroutineRunner runner;

        public static Coroutine Start(IEnumerator coroutine)
        {
            if (runner == null)
            {
                runner = new GameObject("[WebMap Coroutines]").AddComponent<StaticCoroutineRunner>();
                UnityEngine.Object.DontDestroyOnLoad(runner.gameObject);
            }
            return runner.StartCoroutine(coroutine);
        }

        private class StaticCoroutineRunner : MonoBehaviour { }
    }
}
