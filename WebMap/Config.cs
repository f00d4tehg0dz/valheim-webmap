using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using BepInEx.Configuration;
using UnityEngine;

namespace WebMap
{
    internal static class WebMapConfig
    {
        public static int TEXTURE_SIZE = 2048;
        public static int PIXEL_SIZE = 12;
        public static float EXPLORE_RADIUS = 100f;
        public static bool REVEAL_VISITED = true;
        public static int REVEAL_VISITED_MARGIN = 3;
        public static float UPDATE_FOG_TEXTURE_INTERVAL = 2f;
        public static float SAVE_FOG_TEXTURE_INTERVAL = 30f;
        public static int MAX_PINS_PER_USER = 50;
        public static bool WEB_PINS = true;
        public static bool WEBSOCKET_COMPRESSION = false;
        public static int MAX_MESSAGES = 100;
        public static bool ALWAYS_MAP = true;
        public static bool ALWAYS_VISIBLE = false;
        public static bool DEBUG = false;
        public static bool TEST = false;

        public static int SERVER_PORT = 3000;
        public static float PLAYER_UPDATE_INTERVAL = 1f;
        public static bool CACHE_SERVER_FILES = true;

        public static string WORLD_NAME = "";
        public static Vector3 WORLD_START_POS = Vector3.zero;
        public static int DEFAULT_ZOOM = 100;

        public static bool SHOW_VEHICLES = true;

        public static string ANNOUNCE_NAME = "Server";
        public static string DISCORD_WEBHOOK = "";
        public static string DISCORD_INVITE_URL = "";

        public static string URL = "";
        public static string MAP_TITLE = "";

        // tile renderer
        public static int RENDER_THREADS = 1;
        public static int PRERENDER_ZOOM = 5;
        public static int MAX_RENDER_ZOOM = 7;
        public static int HEIGHT_MAX_ZOOM = 7;
        public static int MAIN_THREAD_ROWS_PER_FRAME = 24;

        // world sweep
        public static float SWEEP_INTERVAL = 120f;
        public static float FIRST_SWEEP_DELAY = 30f;
        public static int SWEEP_ZDOS_PER_FRAME = 3000;

        // markers, stats, privacy
        public static bool SHOW_LAST_SEEN_POSITION = false;
        public static bool EVENT_LOG = true;
        public static float STATS_SAVE_INTERVAL = 60f;
        public static bool ENABLE_3D = true;
        public static bool LEGACY_MAP = true;
        public static bool REVEAL_ALL = false;

        // 3.1: model export for the 3D view
        public static bool EXPORT_MODELS = true;
        public static string OBJECT_CATEGORIES = "piece,other,rock,bush,tree";
        public static bool USE_TEXTURES = true;
        public static bool EXTRACT_MESHES = true;
        public static int TEXTURE_MAX_SIZE = 512;
        public static int MODEL_EXPORT_MS_PER_FRAME = 6;

        public static void ReadConfigFile(ConfigFile config)
        {
            TEXTURE_SIZE = config.Bind("Texture", "texture_size",
                WebMapConfig.TEXTURE_SIZE,
                "How large is the map texture? Probably dont change this.").Value;

            PIXEL_SIZE = config.Bind("Texture", "pixel_size",
                WebMapConfig.PIXEL_SIZE,
                "How many in game units does a map pixel represent? Probably dont change this.").Value;

            EXPLORE_RADIUS = config.Bind<float>("Texture", "explore_radius",
                WebMapConfig.EXPLORE_RADIUS,
                "A larger explore_radius reveals the map more quickly.").Value;

            REVEAL_VISITED = config.Bind("Texture", "reveal_visited",
                WebMapConfig.REVEAL_VISITED,
                "Lift the fog everywhere players have already been, including before the mod was installed. "
                + "The world save remembers which 64 m zones the game generated; those only exist where someone "
                + "stood nearby. The in-game map itself lives in each player's character file, which the server "
                + "never sees, so this is the closest thing to it. Runs at start and after each world walk.").Value;

            REVEAL_VISITED_MARGIN = config.Bind("Texture", "reveal_visited_margin",
                WebMapConfig.REVEAL_VISITED_MARGIN,
                new BepInEx.Configuration.ConfigDescription(
                "The game generates zones up to 5 away from a player. A zone only counts as visited when every "
                + "zone within this many of it was generated too, so the edge of the reveal sits near where "
                + "players actually saw. 3 = about 150 m from the path, 4 = about 100 m (the in-game radius), "
                + "0 = the whole generated area (about 320 m).",
                new BepInEx.Configuration.AcceptableValueRange<int>(0, 5))).Value;

            UPDATE_FOG_TEXTURE_INTERVAL = config.Bind<float>("Interval", "update_fog_texture_interval",
                WebMapConfig.UPDATE_FOG_TEXTURE_INTERVAL,
                "How often do we update the fog texture on the server in seconds.").Value;

            SAVE_FOG_TEXTURE_INTERVAL = config.Bind<float>("Interval", "save_fog_texture_interval",
                WebMapConfig.SAVE_FOG_TEXTURE_INTERVAL,
                "How often do we save the fog texture in seconds.").Value;

            MAX_PINS_PER_USER = config.Bind("User", "max_pins_per_user",
                WebMapConfig.MAX_PINS_PER_USER,
                "How many pins each client is allowed to make before old ones start being deleted.").Value;

            WEB_PINS = config.Bind("User", "web_pins",
                WebMapConfig.WEB_PINS,
                "Let people place and remove their own pins from the web page (right click or long press the map). Chat pins (!pin) only reach the server while two or more players are online, so this is the way that always works.").Value;

            WEBSOCKET_COMPRESSION = config.Bind("Server", "websocket_compression",
                WebMapConfig.WEBSOCKET_COMPRESSION,
                "Allow permessage-deflate on the live websocket. Off by default: some reverse proxies (IIS ARR) accept the handshake and then drop every frame.").Value;

            SERVER_PORT = config.Bind("Server", "server_port",
                WebMapConfig.SERVER_PORT,
                "HTTP port for the website. The map will be display on this site.").Value;

            PLAYER_UPDATE_INTERVAL = config.Bind("Interval", "player_update_interval",
                WebMapConfig.PLAYER_UPDATE_INTERVAL,
                "How often do we send position data to web browsers in seconds.").Value;

            CACHE_SERVER_FILES = config.Bind("Server", "cache_server_files",
                WebMapConfig.CACHE_SERVER_FILES,
                "Should the server cache web files to be more performant?").Value;

            DEFAULT_ZOOM = config.Bind("Texture", "default_zoom",
                WebMapConfig.DEFAULT_ZOOM,
                "How zoomed in should the web map start at? Higher is more zoomed in.").Value;

            MAX_MESSAGES = config.Bind("Server", "max_messages",
                WebMapConfig.MAX_MESSAGES,
                "How many messages to keep buffered and display to client.").Value;

            ALWAYS_MAP = config.Bind("User", "always_map",
                WebMapConfig.ALWAYS_MAP,
                "Update the map to show where hidden players have traveled.").Value;

            ALWAYS_VISIBLE = config.Bind("User", "always_visible",
                WebMapConfig.ALWAYS_VISIBLE,
                "Completely ignore the players preference to be hidden.").Value;

            DEBUG = config.Bind("Server", "debug",
                WebMapConfig.DEBUG,
                "Output debugging information.").Value;

            TEST = config.Bind("Server", "test",
                WebMapConfig.TEST,
                "Enable test features (bugs).").Value;

            SHOW_VEHICLES = config.Bind("Server", "show_vehicles",
                WebMapConfig.SHOW_VEHICLES,
                "Report boats and carts at /vehicles. They are only ever reported in "
                + "territory players have already explored, but turning this off stops "
                + "the endpoint reporting anything at all.").Value;

            DISCORD_WEBHOOK = config.Bind("Server", "discord_webhook",
                WebMapConfig.DISCORD_WEBHOOK,
                "Discord webhook URL").Value;

            DISCORD_INVITE_URL = config.Bind("Server", "discord_invite_url",
                WebMapConfig.DISCORD_INVITE_URL,
                "Optional Discord invite URL to be added to the webpage.").Value;

            URL = config.Bind("Server", "webmap_url",
                WebMapConfig.URL,
                "URL to view the web map.").Value;

            MAP_TITLE = config.Bind("Server", "map_title",
                WebMapConfig.MAP_TITLE,
                "Title shown in the web map header. Empty = the server name.").Value;

            RENDER_THREADS = config.Bind("Render", "render_threads",
                WebMapConfig.RENDER_THREADS,
                "Worker threads for rendering map tiles. 1 is right for most servers; 2 on a box with spare cores. "
                + "0 samples terrain on the game thread in small slices (slowest, safest).").Value;

            PRERENDER_ZOOM = config.Bind("Render", "prerender_zoom",
                WebMapConfig.PRERENDER_ZOOM,
                "Render the whole world up to this zoom on first start (0 = 128 m/px ... 7 = 1 m/px). "
                + "5 (4 m/px, ~400 tiles) takes about a minute. Closer zooms are only rendered where players have explored.").Value;

            MAX_RENDER_ZOOM = config.Bind("Render", "max_render_zoom",
                WebMapConfig.MAX_RENDER_ZOOM,
                "Closest zoom rendered over explored ground. 7 = 1 m/px (full detail), 6 = 2 m/px (a quarter of the disk and CPU).").Value;

            HEIGHT_MAX_ZOOM = config.Bind("Render", "height_max_zoom",
                WebMapConfig.HEIGHT_MAX_ZOOM,
                "Closest zoom for height tiles (used by the 3D view). Lower it to save disk if 3D is off.").Value;

            MAIN_THREAD_ROWS_PER_FRAME = config.Bind("Render", "main_thread_rows_per_frame",
                WebMapConfig.MAIN_THREAD_ROWS_PER_FRAME,
                "When sampling on the game thread, how many tile rows to sample per frame.").Value;

            SWEEP_INTERVAL = config.Bind<float>("Sweep", "sweep_interval",
                WebMapConfig.SWEEP_INTERVAL,
                "Seconds between walks over the world's objects (structures, trees, terraforming, portals).").Value;

            FIRST_SWEEP_DELAY = config.Bind<float>("Sweep", "first_sweep_delay",
                WebMapConfig.FIRST_SWEEP_DELAY,
                "Seconds after world load before the first sweep.").Value;

            SWEEP_ZDOS_PER_FRAME = config.Bind("Sweep", "zdos_per_frame",
                WebMapConfig.SWEEP_ZDOS_PER_FRAME,
                "Objects inspected per game frame during a sweep. Lower is gentler on the game, higher finishes sooner.").Value;

            REVEAL_ALL = config.Bind("Markers", "reveal_all",
                WebMapConfig.REVEAL_ALL,
                "Ignore the fog of war entirely: no black veil, render and show the whole world, every build, tree and marker. Testing only. "
                + "The full world at 1 m/px is ~6400 tiles and renders on demand as people browse.").Value;

            SHOW_LAST_SEEN_POSITION = config.Bind("User", "show_last_seen_position",
                WebMapConfig.SHOW_LAST_SEEN_POSITION,
                "Show where offline players were last seen in the stats panel.").Value;

            EVENT_LOG = config.Bind("Server", "event_log",
                WebMapConfig.EVENT_LOG,
                "Append joins, leaves, deaths, chat and pings to events.jsonl in the world's map data.").Value;

            STATS_SAVE_INTERVAL = config.Bind<float>("Interval", "stats_save_interval",
                WebMapConfig.STATS_SAVE_INTERVAL,
                "How often to save stats.json, in seconds.").Value;

            ENABLE_3D = config.Bind("Server", "enable_3d",
                WebMapConfig.ENABLE_3D,
                "Offer the 3D view in the web map.").Value;

            EXPORT_MODELS = config.Bind("Models", "export_models",
                WebMapConfig.EXPORT_MODELS,
                "Export the game's prefab meshes (buildings, trees, rocks, ruins) as glTF for the 3D view. "
                + "Runs once per prefab on the game thread, a few milliseconds per frame, and is cached under map_data/models.").Value;

            OBJECT_CATEGORIES = config.Bind("Models", "object_categories",
                WebMapConfig.OBJECT_CATEGORIES,
                "Which kinds of world object the 3D view gets, comma separated: piece (everything built), other (ruins, "
                + "dungeon entrances, furniture, boats), rock, bush, tree. Trees and bushes are ~half the objects of a world; "
                + "their leaves only show once the leaf textures are extracted, trunks always do.").Value;

            USE_TEXTURES = config.Bind("Models", "use_textures",
                WebMapConfig.USE_TEXTURES,
                "Texture the 3D models. The mod reads the textures its models need out of the game's own asset "
                + "files on a background thread (a minute or two on first start, once per game version). "
                + "Off: flat material colours; existing texture files are ignored.").Value;

            EXTRACT_MESHES = config.Bind("Models", "extract_meshes",
                WebMapConfig.EXTRACT_MESHES,
                "Read the meshes the engine keeps locked (most of them: carts, beehives, ruins, rocks...) out of the game's "
                + "own asset files, so the 3D view shows the real shape instead of a box. Background thread, a few minutes "
                + "on first start, once per game version. Off: locked meshes stay boxes.").Value;

            TEXTURE_MAX_SIZE = config.Bind("Models", "texture_max_size",
                WebMapConfig.TEXTURE_MAX_SIZE,
                "Longest side of exported textures, in pixels. 256 is plenty for a map; 512 looks sharper up close.").Value;

            MODEL_EXPORT_MS_PER_FRAME = config.Bind("Models", "export_ms_per_frame",
                WebMapConfig.MODEL_EXPORT_MS_PER_FRAME,
                "Game-thread time budget per frame for model export while the queue drains.").Value;

            LEGACY_MAP = config.Bind("Server", "legacy_map",
                WebMapConfig.LEGACY_MAP,
                "Build the single-image 2048px world render (map.png, served at /map and /map.jpg) if it does not exist yet. "
                + "Takes a few seconds on the game thread at world load; the web map does not need it.").Value;
        }

        public static string GetWorldName()
        {
            if (ZNet.instance != null)
            {
                WORLD_NAME = ZNet.instance.GetWorldName();
            }
            else
            {
                string[] arguments = Environment.GetCommandLineArgs();
                string worldName = "";
                for (int t = 0; t < arguments.Length; t++)
                    if (arguments[t] == "-world")
                    {
                        worldName = arguments[t + 1];
                        break;
                    }
                WORLD_NAME = worldName;
            }
            return WORLD_NAME;
        }

        public static string MakeClientConfigJson()
        {
            Dictionary<string, object> config = new Dictionary<string, object>();

            config["world_name"] = GetWorldName();
            config["world_start_pos"] = WORLD_START_POS;
            config["default_zoom"] = DEFAULT_ZOOM;
            config["texture_size"] = TEXTURE_SIZE;
            config["pixel_size"] = PIXEL_SIZE;
            config["update_interval"] = PLAYER_UPDATE_INTERVAL;
            config["explore_radius"] = EXPLORE_RADIUS;
            config["max_messages"] = MAX_MESSAGES;
            config["web_pins"] = WEB_PINS;
            config["max_pins_per_user"] = MAX_PINS_PER_USER;
            config["always_map"] = ALWAYS_MAP;
            config["always_visible"] = ALWAYS_VISIBLE;
            config["title"] = string.IsNullOrEmpty(MAP_TITLE) ? (WebMap.serverInfo != null && WebMap.serverInfo.ContainsKey("serverName") ? WebMap.serverInfo["serverName"].ToString() : "Valheim") : MAP_TITLE;
            config["discord_invite_url"] = DISCORD_INVITE_URL;
            config["version"] = WebMap.VERSION;
            config["tile_size"] = Tiles.TileMath.TILE_SIZE;
            config["max_zoom"] = Tiles.TileMath.MAX_ZOOM;
            config["max_render_zoom"] = MAX_RENDER_ZOOM;
            config["height_max_zoom"] = HEIGHT_MAX_ZOOM;
            config["world_size"] = Tiles.TileMath.WORLD_SIZE;
            config["chunk_size"] = Tiles.TileMath.CHUNK_SIZE;
            config["water_level"] = Tiles.TileJob.WaterLevel;
            config["enable_3d"] = ENABLE_3D;
            config["show_last_seen_position"] = SHOW_LAST_SEEN_POSITION;
            config["reveal_all"] = REVEAL_ALL;
            config["models"] = EXPORT_MODELS;

            string json = DictionaryToJson(config);
            return json;
        }

        static string DictionaryToJson(Dictionary<string, object> dict)
        {
            var entries = dict.Select(d =>
            {
                switch (d.Value)
                {
                    case float o:
                        return $"\"{d.Key}\": {o.ToString("F2", CultureInfo.InvariantCulture)}";
                    case double o:
                        return $"\"{d.Key}\": {o.ToString("F2", CultureInfo.InvariantCulture)}";
                    case string o:
                        return $"\"{d.Key}\": \"{o}\"";
                    case bool o:
                        return $"\"{d.Key}\": {o.ToString().ToLower()}";
                    case Vector3 o:
                        return $"\"{d.Key}\": \"{o.x.ToString("F2", CultureInfo.InvariantCulture)}," +
                               $"{o.y.ToString("F2", CultureInfo.InvariantCulture)}," +
                               $"{o.z.ToString("F2", CultureInfo.InvariantCulture)}\"";
                    default:
                        return $"\"{d.Key}\": {d.Value}";
                }
            });
            return "{\n    " + string.Join(",\n    ", entries) + "\n}\n";
        }
    }
}
