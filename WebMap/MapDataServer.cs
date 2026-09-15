using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using UnityEngine;
using WebSocketSharp;
using WebSocketSharp.Net;
using WebSocketSharp.Server;
using WebMap.Live;
using WebMap.Tiles;
using WebMap.Util;
using WebMap.World;
using static WebMap.WebMapConfig;

namespace WebMap
{
    // The HTTP + websocket front door.
    //
    // Everything served here is a string or byte array that some other part
    // of the mod built on the thread it was safe to build on; the request
    // handlers never touch the game. Tiles come from disk through TileStore,
    // vector data from the sweep's published chunks, live state from the
    // snapshots.
    //
    // Routes (all GET unless noted):
    //   /                          the web app (static files under web/, subfolders allowed)
    //   /config                    client configuration
    //   /tiles/map/{z}/{x}/{y}.png rendered map tile      (404 + X-WebMap-Tile: pending while it renders)
    //   /tiles/height/{z}/{x}/{y}.png  Terrarium-encoded height tile
    //   /tiles/veg/{z}/{x}/{y}.png    transparent overlay of tree crowns and rocks (zoom 5+, 2D only)
    //   /data/structures/index.json, /data/structures/{cx}_{cz}.json
    //   /data/veg/{cx}_{cz}.bin    vegetation points for a chunk
    //   /data/markers.json         marker sets (locations, portals, tombstones, vehicles, custom)
    //   /data/players.json, /data/stats.json, /data/events.json, /data/pins.json, /data/fog.png
    //   /api/status                renderer and sweep status
    //   /api/rerender?zoom=N (POST, token)   re-render tiles from zoom N up
    //   /api/reexport (POST, token)  re-export all prefab models (after extracting textures)
    //   /api/reload (POST, token)    drop cached web files and tell open browsers to refresh (no restart)
    //   /api/sweep (POST)          run a world sweep now
    //   /api/pin (POST) place a pin from the page, /api/unpin?id= (POST) remove one of your own
    //   simple endpoints: /map /map.jpg /fog /players /pins /messages /structures /structures/stats
    //               /structures/refresh /forest /forest/stats /vehicles /announce (POST)
    //   websocket: /ws (and / for old clients), JSON frames, see Broadcast()
    public class WebSocketHandler : WebSocketBehavior
    {
        protected override void OnOpen()
        {
            string endpoint = Context.Headers.Get("X-Forwarded-For");
            if (endpoint.IsNullOrEmpty()) endpoint = Context.UserEndPoint.ToString();
            if (WebMapConfig.DEBUG) ZLog.Log("WebMap: new visitor connected from " + endpoint);
            var s = MapDataServer.getInstance();
            if (s != null)
            {
                Send(s.HelloFrame());
                Send("{\"t\":\"players\",\"data\":" + Players.Json + "}");
                Send("{\"t\":\"events\",\"data\":" + Events.RecentJson + ",\"initial\":true}");
            }
            base.OnOpen();
        }

        protected override void OnMessage(MessageEventArgs e)
        {
            if (e.Data == "players") Send("{\"t\":\"players\",\"data\":" + Players.Json + "}");
            base.OnMessage(e);
        }
    }

    public class MapDataServer
    {
        private static readonly Dictionary<string, string> contentTypes = new Dictionary<string, string> {
            {"html", "text/html; charset=utf-8"}, {"js", "text/javascript; charset=utf-8"}, {"mjs", "text/javascript; charset=utf-8"},
            {"css", "text/css; charset=utf-8"}, {"json", "application/json"}, {"png", "image/png"}, {"jpg", "image/jpeg"},
            {"webp", "image/webp"}, {"svg", "image/svg+xml"}, {"ico", "image/x-icon"}, {"woff", "font/woff"}, {"woff2", "font/woff2"},
            {"bin", "application/octet-stream"}, {"wasm", "application/wasm"}, {"map", "application/json"}, {"txt", "text/plain; charset=utf-8"},
            {"webmanifest", "application/manifest+json"}
        };

        private readonly System.Threading.Timer broadcastTimer;
        private readonly ConcurrentDictionary<string, byte[]> fileCache = new ConcurrentDictionary<string, byte[]>();
        private readonly HttpServer httpServer;
        private readonly string publicRoot;
        private static Dictionary<string, string> embeddedWeb;   // "js/app.js" -> resource name
        private readonly WebSocketServiceHost wsHost, wsLegacyHost;
        private static MapDataServer __instance;

        // single-image world render
        public byte[] mapImageData;
        private byte[] mapJpgCache;

        public List<string> pins = new List<string>();
        public List<ZNetPeer> players = new List<ZNetPeer>();

        private string lastPlayersJson = "";
        private volatile bool forceReload;
        private volatile int worldRev;
        private volatile bool worldChanged;

        public MapDataServer()
        {
            __instance = this;
            httpServer = new HttpServer(SERVER_PORT);
            // permessage-deflate is off unless asked for: IIS ARR and some other proxies accept the
            // handshake with it and then stall every frame
            httpServer.AddWebSocketService<WebSocketHandler>("/ws", ws => ws.IgnoreExtensions = !WEBSOCKET_COMPRESSION);
            httpServer.AddWebSocketService<WebSocketHandler>("/", ws => ws.IgnoreExtensions = !WEBSOCKET_COMPRESSION);
            httpServer.KeepClean = true;
            wsHost = httpServer.WebSocketServices["/ws"];
            wsLegacyHost = httpServer.WebSocketServices["/"];

            publicRoot = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location) ?? string.Empty, "web"));

            broadcastTimer = new System.Threading.Timer(e => { try { Broadcast(); } catch (Exception ex) { if (DEBUG) ZLog.LogWarning("WebMap: broadcast failed: " + ex.Message); } },
                null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(PLAYER_UPDATE_INTERVAL));

            httpServer.OnGet += (sender, e) => { try { if (!Route(e, false)) ServeStatic(e); } catch (Exception ex) { Fail(e, ex); } };
            httpServer.OnPost += (sender, e) => { try { if (!Route(e, true)) NotFound(e.Response); } catch (Exception ex) { Fail(e, ex); } };
            httpServer.OnHead += (sender, e) => { try { if (!Route(e, false)) ServeStatic(e); } catch (Exception ex) { Fail(e, ex); } };
        }

        public static MapDataServer getInstance() => __instance;

        private static void Fail(HttpRequestEventArgs e, Exception ex)
        {
            ZLog.LogWarning("WebMap: request " + e.Request.RawUrl + " failed: " + ex);
            try { e.Response.StatusCode = 500; e.Response.Close(); } catch { }
        }

        // ---------------------------------------------------------------- websocket

        public string HelloFrame()
        {
            return "{\"t\":\"hello\",\"version\":\"" + WebMap.VERSION + "\",\"worldRev\":" + worldRev + ",\"config\":" + MakeClientConfigJson() + "}";
        }

        private void Send(string frame)
        {
            try { wsHost.Sessions.Broadcast(frame); } catch { }
            try { wsLegacyHost.Sessions.Broadcast(frame); } catch { }
        }

        private void Broadcast()
        {
            if (forceReload)
            {
                forceReload = false;
                Send("{\"t\":\"reload\"}");
                return;
            }
            string pj = Players.Json;
            if (pj != lastPlayersJson)
            {
                lastPlayersJson = pj;
                Send("{\"t\":\"players\",\"data\":" + pj + "}");
            }
            string ev = Events.DrainPendingJson();
            if (ev != null) Send("{\"t\":\"events\",\"data\":" + ev + "}");
            var tiles = TileStore.DrainNotifications();
            if (tiles != null)
            {
                var j = new JsonWriter(tiles.Count * 12 + 32);
                j.BeginObject().Prop("t", "tiles").Key("keys").BeginArray();
                foreach (var k in tiles) j.Value(k);
                j.End().Prop("status", TileStore.OnDisk + "/" + TileStore.QueueLength).End();
                Send(j.ToString());
            }
            if (worldChanged)
            {
                worldChanged = false;
                Send("{\"t\":\"world\",\"rev\":" + worldRev + ",\"stats\":" + Stats.Json + "}");
            }
        }

        public void BroadcastWorldRevision() { worldRev++; worldChanged = true; }
        public void Reload() { forceReload = true; }

        public void BroadcastPing(long id, string name, Vector3 position)
        {
            var j = new JsonWriter(128);
            j.BeginObject().Prop("t", "ping").Prop("id", id).Prop("name", name).Prop("x", position.x, 1).Prop("z", position.z, 1).End();
            Send(j.ToString());
            Events.Add("ping", name, "pinged the map", position.x, position.z);
        }

        // ---------------------------------------------------------------- pins (chat commands)

        public void AddPin(string id, string pinId, string type, string name, Vector3 position, string pinText)
        {
            lock (pins) pins.Add($"{id},{pinId},{type},{name},{Fixed(position.x)},{Fixed(position.z)},{pinText}");
            var j = new JsonWriter(160);
            j.BeginObject().Prop("t", "pin").Prop("owner", id).Prop("id", pinId).Prop("type", type).Prop("name", name)
             .Prop("x", position.x, 1).Prop("z", position.z, 1).Prop("text", pinText).End();
            Send(j.ToString());
            Events.Add("pin", name, "placed a pin" + (pinText.Length > 0 ? ": " + pinText : ""), position.x, position.z);
        }

        public void RemovePin(int idx)
        {
            string[] parts;
            lock (pins) { parts = pins[idx].Split(','); pins.RemoveAt(idx); }
            Send("{\"t\":\"rmpin\",\"id\":\"" + parts[1] + "\"}");
        }

        public string PinsJson()
        {
            var j = new JsonWriter(1024);
            j.BeginArray();
            lock (pins)
                foreach (var line in pins)
                {
                    var p = line.Split(',');
                    if (p.Length < 7) continue;
                    j.BeginObject().Prop("owner", p[0]).Prop("id", p[1]).Prop("type", p[2]).Prop("name", p[3]);
                    float.TryParse(p[4], NumberStyles.Float, CultureInfo.InvariantCulture, out float x);
                    float.TryParse(p[5], NumberStyles.Float, CultureInfo.InvariantCulture, out float z);
                    j.Prop("x", x, 1).Prop("z", z, 1).Prop("text", string.Join(",", p, 6, p.Length - 6)).End();
                }
            j.End();
            return j.ToString();
        }

        public void AddMessage(long id, int type, string name, string message)
        {
            string kind = type == (int)Talker.Type.Shout ? "shout" : type == (int)Talker.Type.Whisper ? "whisper" : name == "Server" ? "server" : "chat";
            Events.Add(kind, name, message);
        }

        private static string Fixed(float f) => f.ToString("F2", CultureInfo.InvariantCulture);

        // ---------------------------------------------------------------- legacy map.png

        public void BuildMapJpg()
        {
            if (mapJpgCache != null || mapImageData == null || mapImageData.Length == 0) return;
            try
            {
                var tex = new Texture2D(TEXTURE_SIZE, TEXTURE_SIZE, TextureFormat.RGBA32, false);
                if (!ImageConv.LoadImage(tex, mapImageData)) return;
                mapJpgCache = ImageConv.EncodeToJPG(tex, 85);
                UnityEngine.Object.Destroy(tex);
            }
            catch (Exception ex) { ZLog.LogWarning("WebMap: jpeg encode failed: " + ex.Message); }
        }

        // ---------------------------------------------------------------- lifecycle

        public void ListenAsync()
        {
            httpServer.Start();
            if (httpServer.IsListening) ZLog.Log($"WebMap: HTTP server listening on port {SERVER_PORT}");
            else ZLog.LogError("WebMap: HTTP server failed to start");
        }

        public void Stop()
        {
            broadcastTimer.Dispose();
            try { httpServer.Stop(); } catch { }
        }

        // ---------------------------------------------------------------- routing

        private bool Route(HttpRequestEventArgs e, bool post)
        {
            var req = e.Request; var res = e.Response;
            string path = req.Url.AbsolutePath;

            if (path.StartsWith("/tiles/")) return post ? false : ServeTile(e, path);
            if (path.StartsWith("/data/")) return post ? false : ServeData(e, path);
            if (path.StartsWith("/models/")) return post ? false : ServeModel(e, path);

            switch (path)
            {
                case "/config": return Text(e, MakeClientConfigJson(), "application/json", nocache: true);
                case "/api/status":
                {
                    var j = new JsonWriter(512);
                    j.BeginObject().PropRaw("tiles", TileStore.StatusJson()).Prop("sweeps", WorldSweep.Sweeps)
                     .Prop("lastSweepSeconds", WorldSweep.LastSweepSeconds, 1).Prop("objects", WorldSweep.LastScanned)
                     .Prop("structures", Structures.Total).Prop("worldRev", worldRev).Prop("version", WebMap.VERSION).End();
                    return Text(e, j.ToString(), "application/json", nocache: true);
                }
                case "/api/sweep":
                    if (!post) return false;
                    WorldSweep.RefreshRequested = true;
                    return Text(e, "{\"queued\":true}", "application/json", nocache: true, status: 202);
                case "/api/reexport":
                {
                    // re-export every prefab model, e.g. after textures were added
                    if (!post) return false;
                    if (!Authorized(req)) return Text(e, "{\"error\":\"forbidden\"}", "application/json", nocache: true, status: 403);
                    int n = Models.ModelStore.ReexportAll();
                    return Text(e, "{\"queued\":" + n + "}", "application/json", nocache: true, status: 202);
                }
                case "/api/rerender":
                {
                    if (!post) return false;
                    if (!Authorized(req)) return Text(e, "{\"error\":\"forbidden\"}", "application/json", nocache: true, status: 403);
                    int.TryParse(req.QueryString["zoom"] ?? "0", out int z);
                    int n = TileStore.Rerender(z);
                    return Text(e, "{\"queued\":" + n + "}", "application/json", nocache: true, status: 202);
                }
                case "/api/reload":
                {
                    // pick up new files in web/ without restarting the game: forget the cached copies
                    // and tell every open browser to refresh. The DLL itself still needs a restart.
                    if (!post) return false;
                    if (!Authorized(req)) return Text(e, "{\"error\":\"forbidden\"}", "application/json", nocache: true, status: 403);
                    int n = fileCache.Count;
                    fileCache.Clear();
                    Reload();
                    ZLog.Log("WebMap: web files reloaded (" + n + " cached files dropped), browsers told to refresh");
                    return Text(e, "{\"dropped\":" + n + ",\"browsers\":" + (wsHost.Sessions.Count + wsLegacyHost.Sessions.Count) + "}", "application/json", nocache: true);
                }

                // ---- simple endpoints (single-image map, plain lists)
                case "/map":
                    if (mapImageData == null) return Text(e, "not built", "text/plain", status: 503);
                    return Bytes(e, mapImageData, "application/octet-stream", "public, max-age=604800, immutable");
                case "/map.jpg":
                    if (mapJpgCache == null) return Text(e, "not built", "text/plain", status: 503);
                    return Bytes(e, mapJpgCache, "image/jpeg", "public, max-age=604800, immutable");
                case "/fog": return Bytes(e, Fog.Png(), "image/png", "no-cache");
                case "/players": return Text(e, Players.Json, "application/json", nocache: true);
                case "/messages": return Text(e, Events.RecentJson, "application/json", nocache: true);
                case "/pins":
                {
                    string text; lock (pins) text = string.Join("\n", pins);
                    return Text(e, text, "text/csv", nocache: true);
                }
                case "/structures": return Bytes(e, StructureMap.GetPng(), "image/png", "no-cache");
                case "/structures/stats": return Text(e, Structures.StatsJson, "application/json", nocache: true);
                case "/structures/refresh":
                    WorldSweep.RefreshRequested = true;
                    return Text(e, "{\"queued\":true}", "application/json", nocache: true, status: 202);
                case "/forest": return Bytes(e, ForestMap.GetPng(), "image/png", "no-cache");
                case "/forest/stats": return Text(e, ForestMap.GetStats(), "application/json", nocache: true);
                case "/vehicles": return Text(e, Vehicles.GetJson(), "application/json", nocache: true);
                case "/api/pin":
                {
                    // place a pin from the web page. Body: JSON {x,z,type,text,name,client}
                    if (!post) return false;
                    if (!WEB_PINS && !Authorized(req)) return Text(e, "{\"error\":\"web pins are off\"}", "application/json", nocache: true, status: 403);
                    string body;
                    using (var sr = new StreamReader(req.InputStream, Encoding.UTF8)) body = sr.ReadToEnd();
                    Dictionary<string, object> f;
                    try { f = JsonParser.Parse(body) as Dictionary<string, object>; } catch { f = null; }
                    if (f == null || !f.TryGetValue("x", out object xo) || !f.TryGetValue("z", out object zo)) return Text(e, "{\"error\":\"need x and z\"}", "application/json", nocache: true, status: 400);
                    float x = Convert.ToSingle(xo, CultureInfo.InvariantCulture), z = Convert.ToSingle(zo, CultureInfo.InvariantCulture);
                    float half = Tiles.TileMath.WORLD_SIZE / 2f;
                    if (float.IsNaN(x) || float.IsNaN(z) || Mathf.Abs(x) > half || Mathf.Abs(z) > half) return Text(e, "{\"error\":\"off the map\"}", "application/json", nocache: true, status: 400);
                    string owner = WebOwner(req, f);
                    if (!PinRateOk(owner)) return Text(e, "{\"error\":\"slow down\"}", "application/json", nocache: true, status: 429);
                    string name = WebMap.CleanPinText(f.TryGetValue("name", out object no) ? no as string : null, 16);
                    if (name.Length == 0) name = "web";
                    string id = WebMap.PlacePin(owner, f.TryGetValue("type", out object to) ? to as string : "dot", name, new Vector3(x, 0, z), f.TryGetValue("text", out object txo) ? txo as string : "");
                    return Text(e, "{\"id\":\"" + id + "\",\"owner\":\"" + owner + "\"}", "application/json", nocache: true);
                }
                case "/api/unpin":
                {
                    // remove one pin: ?id=<pin id>. Only its owner (same browser) or the token holder
                    if (!post) return false;
                    string id = req.QueryString["id"] ?? "";
                    if (id.Length == 0 || id.Contains(",")) return Text(e, "{\"error\":\"need id\"}", "application/json", nocache: true, status: 400);
                    string owner = Authorized(req) ? "" : WebOwner(req, null);
                    if (!WEB_PINS && owner.Length > 0) return Text(e, "{\"error\":\"web pins are off\"}", "application/json", nocache: true, status: 403);
                    bool ok = WebMap.DeletePinById(owner, id);
                    return Text(e, ok ? "{\"removed\":true}" : "{\"error\":\"not yours\"}", "application/json", nocache: true, status: ok ? 200 : 404);
                }
                case "/announce":
                {
                    if (!post) return false;
                    if (!Authorized(req)) return Text(e, "{\"error\":\"forbidden\"}", "application/json", nocache: true, status: 403);
                    string body;
                    using (var sr = new StreamReader(req.InputStream, Encoding.UTF8)) body = sr.ReadToEnd();
                    body = (body ?? "").Trim();
                    if (body.Length == 0) return Text(e, "{\"error\":\"empty\"}", "application/json", nocache: true, status: 400);
                    Announce.Enqueue(body);      // Announce.Send posts it to the event feed once delivered
                    return Text(e, "{\"queued\":true}", "application/json", nocache: true, status: 202);
                }
            }
            return false;
        }

        // a browser identifies itself with a random id it made up and keeps (X-WebMap-Client header
        // or "client" in the body); pins it placed can be removed from that browser only
        private static readonly Regex clientIdFilter = new Regex("[^A-Za-z0-9_-]", RegexOptions.Compiled);
        private static readonly Dictionary<string, float> pinLast = new Dictionary<string, float>();

        private static string WebOwner(HttpListenerRequest req, Dictionary<string, object> body)
        {
            string c = req.Headers["X-WebMap-Client"];
            if (string.IsNullOrEmpty(c) && body != null && body.TryGetValue("client", out object co)) c = co as string;
            c = clientIdFilter.Replace(c ?? "", "");
            if (c.Length > 40) c = c.Substring(0, 40);
            if (c.Length == 0) c = "anon";
            return "web:" + c;
        }

        private static bool PinRateOk(string owner)
        {
            float now = (float)(DateTime.UtcNow - new DateTime(2020, 1, 1)).TotalSeconds;
            lock (pinLast)
            {
                if (pinLast.TryGetValue(owner, out float last) && now - last < 2f) return false;
                pinLast[owner] = now;
                if (pinLast.Count > 512) pinLast.Clear();
            }
            return true;
        }

        private static bool Authorized(HttpListenerRequest req)
        {
            string want = Announce.Token;
            string got = req.Headers["X-Announce-Token"] ?? req.Headers["X-WebMap-Token"] ?? "";
            return want != null && got == want;
        }

        // /tiles/{layer}/{z}/{x}/{y}.png
        private bool ServeTile(HttpRequestEventArgs e, string path)
        {
            var res = e.Response;
            string[] p = path.Split('/');
            if (p.Length != 6 || !p[5].EndsWith(".png")) { NotFound(res); return true; }
            string layer = p[2];
            if (layer != "map" && layer != "height" && layer != "veg") { NotFound(res); return true; }
            if (!int.TryParse(p[3], out int z) || !int.TryParse(p[4], out int x) || !int.TryParse(p[5].Substring(0, p[5].Length - 4), out int y))
            { NotFound(res); return true; }

            byte[] data = TileStore.Get(layer, z, x, y, out string etag);
            if (data == null)
            {
                res.Headers.Add("X-WebMap-Tile", "pending");
                res.Headers.Add(HttpResponseHeader.CacheControl, "no-store");
                res.StatusCode = 404;
                res.Close();
                return true;
            }
            string inm = e.Request.Headers["If-None-Match"];
            if (inm != null && inm == etag)
            {
                res.Headers.Add("ETag", etag);
                res.Headers.Add(HttpResponseHeader.CacheControl, "no-cache");
                res.StatusCode = 304;
                res.Close();
                return true;
            }
            res.Headers.Add("ETag", etag);
            return Bytes(e, data, "image/png", "no-cache");
        }

        // /data/...
        private bool ServeData(HttpRequestEventArgs e, string path)
        {
            var res = e.Response;
            string rest = path.Substring("/data/".Length);
            switch (rest)
            {
                case "players.json": return Text(e, Players.Json, "application/json", nocache: true);
                case "stats.json": return Text(e, Stats.Json, "application/json", nocache: true);
                case "events.json": return Text(e, Events.RecentJson, "application/json", nocache: true);
                case "pins.json": return Text(e, PinsJson(), "application/json", nocache: true);
                case "markers.json": return Text(e, Markers.Json, "application/json", nocache: true);
                case "fog.png": return Bytes(e, Fog.Png(), "image/png", "no-cache");
                case "structures/index.json": return Text(e, Structures.IndexJson, "application/json", nocache: true);
                case "objects/index.json": return Text(e, WorldObjects.IndexJson, "application/json", nocache: true);
                case "prefabs.json": return Text(e, Models.ModelStore.PrefabsJson, "application/json", nocache: true);
            }
            if (rest.StartsWith("objects/") && rest.EndsWith(".bin"))
            {
                if (!ParseChunk(rest.Substring(8, rest.Length - 12), out int cx, out int cz)) { NotFound(res); return true; }
                float minX = TileMath.ChunkMin(cx), minZ = TileMath.ChunkMin(cz);
                if (!REVEAL_ALL && !Fog.AnyExplored(minX, minZ, minX + TileMath.CHUNK_SIZE, minZ + TileMath.CHUNK_SIZE)) { NotFound(res); return true; }
                byte[] data = WorldObjects.ChunkBytes(cx, cz);
                if (data == null) { NotFound(res); return true; }
                return Bytes(e, data, "application/octet-stream", "no-cache", compressible: true);
            }
            if (rest.StartsWith("structures/") && rest.EndsWith(".json"))
            {
                if (!ParseChunk(rest.Substring("structures/".Length, rest.Length - "structures/".Length - 5), out int cx, out int cz)) { NotFound(res); return true; }
                string json = Structures.ChunkJson(cx, cz);
                if (json == null) json = "{\"cx\":" + cx + ",\"cz\":" + cz + ",\"rev\":0,\"count\":0,\"pieces\":[],\"prefabs\":[]}";
                return Text(e, json, "application/json", nocache: true);
            }
            if (rest.StartsWith("veg/") && rest.EndsWith(".bin"))
            {
                if (!ParseChunk(rest.Substring(4, rest.Length - 8), out int cx, out int cz)) { NotFound(res); return true; }
                float minX = TileMath.ChunkMin(cx), minZ = TileMath.ChunkMin(cz);
                if (!REVEAL_ALL && !Fog.AnyExplored(minX, minZ, minX + TileMath.CHUNK_SIZE, minZ + TileMath.CHUNK_SIZE)) { NotFound(res); return true; }
                return Bytes(e, Vegetation.Chunk(cx, cz), "application/octet-stream", "no-cache");
            }
            NotFound(res);
            return true;
        }

        // /models/{file}.glb | .png  from map_data/models (shared by all worlds)
        private bool ServeModel(HttpRequestEventArgs e, string path)
        {
            var res = e.Response;
            string name = path.Substring("/models/".Length);
            if (name.Length == 0 || name.Contains("/") || name.Contains("..") || name.Contains("\\")) { NotFound(res); return true; }
            string root = Models.ModelStore.Root;
            if (root == null) { NotFound(res); return true; }
            string full = Path.Combine(root, name);
            if (!File.Exists(full)) { NotFound(res); return true; }
            byte[] data;
            try { data = File.ReadAllBytes(full); } catch { NotFound(res); return true; }
            string etag = "\"" + data.Length.ToString("x") + "-" + Fnv(data).ToString("x") + "\"";
            if (e.Request.Headers["If-None-Match"] == etag) { res.Headers.Add("ETag", etag); res.Headers.Add(HttpResponseHeader.CacheControl, "no-cache"); res.StatusCode = 304; res.Close(); return true; }
            res.Headers.Add("ETag", etag);
            bool glb = name.EndsWith(".glb");
            return Bytes(e, data, glb ? "model/gltf-binary" : "image/png", "no-cache", compressible: glb);
        }

        private static bool ParseChunk(string s, out int cx, out int cz)
        {
            cx = cz = 0;
            int us = s.IndexOf('_');
            if (us < 0) return false;
            return int.TryParse(s.Substring(0, us), out cx) && int.TryParse(s.Substring(us + 1), out cz)
                && cx >= 0 && cz >= 0 && cx < TileMath.ChunksPerSide && cz < TileMath.ChunksPerSide;
        }

        // ---------------------------------------------------------------- static files

        private void ServeStatic(HttpRequestEventArgs e)
        {
            var req = e.Request; var res = e.Response;
            string path = req.Url.AbsolutePath;
            if (path == "/") path = "/index.html";
            string rel = path.TrimStart('/');
            if (rel.Length == 0 || rel.Contains("..") || rel.Contains("\\") || rel.Contains(":")) { NotFound(res); return; }
            string ext = Path.GetExtension(rel).TrimStart('.').ToLowerInvariant();
            if (!contentTypes.TryGetValue(ext, out string ctype)) { NotFound(res); return; }

            if (!fileCache.TryGetValue(rel, out byte[] data))
            {
                string full = Path.GetFullPath(Path.Combine(publicRoot, rel.Replace('/', Path.DirectorySeparatorChar)));
                if (full.StartsWith(publicRoot, StringComparison.Ordinal) && File.Exists(full))
                {
                    try { data = File.ReadAllBytes(full); }
                    catch (Exception ex) { ZLog.LogError("WebMap: failed to read " + rel + ": " + ex.Message); NotFound(res); return; }
                }
                else
                {
                    data = EmbeddedWebFile(rel);     // no web folder on disk: the copy built into the DLL
                    if (data == null) { NotFound(res); return; }
                }
                if (CACHE_SERVER_FILES) fileCache[rel] = data;
            }
            // vendored libraries never change between mod versions; everything else revalidates cheaply
            string cache = rel.StartsWith("vendor/") ? "public, max-age=2592000, immutable" : "no-cache";
            string etag = "\"" + data.Length.ToString("x") + "-" + Fnv(data).ToString("x") + "\"";
            if (req.Headers["If-None-Match"] == etag)
            {
                res.Headers.Add("ETag", etag);
                res.Headers.Add(HttpResponseHeader.CacheControl, cache);
                res.StatusCode = 304; res.Close(); return;
            }
            res.Headers.Add("ETag", etag);
            Bytes(e, data, ctype, cache, compressible: ext == "html" || ext == "js" || ext == "mjs" || ext == "css" || ext == "json" || ext == "svg");
        }

        // the web app is also compiled into the DLL (see WebMap.csproj) so a missing web folder
        // is not fatal; the first request logs which copy is in use
        private byte[] EmbeddedWebFile(string rel)
        {
            var asm = Assembly.GetExecutingAssembly();
            if (embeddedWeb == null)
            {
                var map = new Dictionary<string, string>(StringComparer.Ordinal);
                foreach (string name in asm.GetManifestResourceNames())
                    if (name.StartsWith("web/") || name.StartsWith("web\\")) map[name.Substring(4).Replace('\\', '/')] = name;
                embeddedWeb = map;
                if (!Directory.Exists(publicRoot)) ZLog.LogWarning("WebMap: no web folder next to WebMap.dll, serving the copy built into the DLL (" + map.Count + " files)");
            }
            if (!embeddedWeb.TryGetValue(rel, out string resName)) return null;
            using (var st = asm.GetManifestResourceStream(resName))
            {
                if (st == null) return null;
                using (var ms = new MemoryStream()) { st.CopyTo(ms); return ms.ToArray(); }
            }
        }

        private static uint Fnv(byte[] d)
        {
            uint h = 2166136261u;
            int step = Math.Max(1, d.Length / 4096);
            for (int i = 0; i < d.Length; i += step) { h ^= d[i]; h *= 16777619u; }
            return h;
        }

        // ---------------------------------------------------------------- response helpers

        private static bool Text(HttpRequestEventArgs e, string text, string ctype, bool nocache = false, int status = 200)
        {
            return Bytes(e, Encoding.UTF8.GetBytes(text ?? ""), ctype, nocache ? "no-cache" : null, compressible: true, status: status);
        }

        private static bool Bytes(HttpRequestEventArgs e, byte[] data, string ctype, string cache, bool compressible = false, int status = 200)
        {
            var res = e.Response;
            if (cache != null) res.Headers.Add(HttpResponseHeader.CacheControl, cache);
            res.Headers.Add("Access-Control-Allow-Origin", "*");
            res.ContentType = ctype;
            res.StatusCode = status;
            if (compressible && data.Length > 1400)
            {
                string ae = e.Request.Headers["Accept-Encoding"] ?? "";
                if (ae.Contains("gzip"))
                {
                    using (var ms = new MemoryStream(data.Length / 3 + 64))
                    {
                        using (var gz = new GZipStream(ms, System.IO.Compression.CompressionLevel.Fastest, true)) gz.Write(data, 0, data.Length);
                        data = ms.ToArray();
                    }
                    res.Headers.Add(HttpResponseHeader.ContentEncoding, "gzip");
                    res.Headers.Add(HttpResponseHeader.Vary, "Accept-Encoding");
                }
            }
            res.ContentLength64 = data.Length;
            if (e.Request.HttpMethod == "HEAD") { res.Close(); return true; }
            res.Close(data, true);
            return true;
        }

        private static void NotFound(HttpListenerResponse res)
        {
            res.StatusCode = 404;
            res.Close();
        }
    }
}
