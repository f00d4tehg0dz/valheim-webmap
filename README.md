# Valheim WebMap

Mod for your Valheim server. Makes a live map of your world you open in a
browser. Share `http://your_ip:3000`. Players install nothing. Server only.

![3D view of a player base](docs/screenshots/08-hero-3d.jpg)

## What it does

* **Big map, every metre.** One pixel is one metre. Seven zoom levels. Shows
  ground the way players shaped it: flat bases, moats, roads, farms. Trees,
  bushes and rocks drawn on top as their own layer. Checkbox turns them off.
  Cut a forest down, map shows the clearing next time it draws.
* **Buildings.** Every piece anyone placed, drawn as a footprint in its
  material colour. Hover to see what it is.
* **3D view.** One click. Real ground, water, and every object drawn with the
  game's own model: walls, roofs, portals, ruins, trees, rocks, boats. Same
  spot, same rotation, same size as in the game. Ground has fine grain up
  close, no seams, no grid. Base looks like your base.
* **Fog of war.** Ground nobody walked on is black. No switch to turn it off.
  Close-up tiles only draw where players walked.
* **Old trips count.** Install the mod on a world you played for months and
  the map still opens up everywhere anyone has been. The world save remembers
  which zones the game built, and it only builds them where someone stood.
  The mod lifts the fog there at start. Your in-game map itself lives in
  your character file, which the server never sees, so this is the closest
  thing to it. See `reveal_visited`.
* **Live players.** Arrow points where they look. Health bar. Biome. PvP,
  sleeping, dead. Follow one. Pings and chat pins land on the map.
* **Player card.** Click a player, on the map, in 3D, or in the list. Card
  shows health, stamina, eitr, what they wear and hold, how long they played,
  deaths, distance walked, visits. Updates live. Buttons: follow, go to,
  switch view.
* **Markers.** Portals with their tags and links, tombstones, player bases,
  boats, carts, your own `markers.json`. Boss altars, dungeons, traders and
  the world seed are never sent out. No spoilers.
* **Stats.** Per player: time played, visits, deaths, distance, portal trips,
  biomes. Per server: day, explored %, pieces built, trees, who was online
  last 24 h.
* **Events.** Joins, leaves, deaths, chat, pings. Saved to `events.jsonl`.
* **Export.** Pick an area, get a 3D file. Ground, water, every building and
  object, trees, markers. Opens in Blender, Unreal, Unity, Godot. Unreal
  pack has a heightmap too. See [docs/EXPORT.md](docs/EXPORT.md).
* Also: share links, search, works on phone, dark UI, Discord webhook,
  `POST /announce` to shout at everyone.

![Player base in 3D](docs/screenshots/03-base-3d.jpg)
![2D map](docs/screenshots/02-base-2d.jpg)
![Stats](docs/screenshots/05-stats.jpg)

## Install

1. Put [BepInEx] on the server. Unzip. Copy the `plugins/WebMap` folder to

       <server>/BepInEx/plugins/WebMap

   Folder holds `WebMap.dll`, `websocket-sharp.dll`, `web/`. Mod managers
   (r2modman, Gale, Thunderstore) do this for you. Lost the `web/` folder?
   No matter: a copy lives inside the DLL and the map still shows. Put a
   `web/` folder next to the DLL and it wins, so you can change the page.

   **Docker (lloesche/valheim-server):** with `BEPINEX=true`, BepInEx lives
   at `/opt/valheim/bepinex/BepInEx` on the data volume. `/config/bepinex`
   is only config. Plugin goes to `/opt/valheim/bepinex/BepInEx/plugins/WebMap`.
   Easiest: bind-mount a host folder there. Example in
   `tools/docker-compose.test.yml`. Config lands in
   `<config volume>/bepinex/com.valheimwebmap.server.cfg`. Open the port:
   `-p 3000:3000/tcp`.

2. Start server once. It writes the default config to `BepInEx/config`.
3. Edit config if you want. Restart. Config is read at start only.
4. Open port 3000. Visit `http://your_ip:3000`.

Map data lives in `plugins/WebMap/map_data/<World>/`. Model library in
`plugins/WebMap/map_data/models/`. Keep both when you update.

Behind Cloudflare or another cache? Purge it after every update, or set a
rule to not cache this host. The mod already sends the right headers.

### First start

Server draws the zoomed-out map first (zoom 0–5, ~500 tiles, one to two
minutes on one core). Then close-up tiles where players walked. Page works
right away: missing tiles show the zoomed-out one blown up, swap in when
done. Counter bottom-left: drawn / waiting.

First start also exports the 3D models. A couple of thousand prefabs, a few
minutes. Done once, kept forever. Log: `WebMap: models exported N (readable
meshes R, ...)`.

### Textures

Server does not let anyone read textures. So the mod reads them straight
out of the game's own files instead. Background thread, low priority, starts
a few seconds after the first model export. Windows, Linux, Docker. Nothing
to install. One to two minutes over ~2 GB of game files, once per game
version. Log:

```
WebMap: extracting 142 textures from the game files in .../valheim_server_Data
WebMap: 139 of 142 textures extracted from 61 files in 74s, 3 not found
WebMap: 180 models to re-export with newly extracted textures
```

Textures are game files. Not in this repo. Not in the mod zip. Never shared.
They only ever sit in your `map_data/models/` folder, made from your own
server. `use_textures = false` skips all of it (flat colours).
`texture_max_size` caps them (default 512).

Doing it by hand, same job, plain Python 3, no packages:

```
python3 tools/extract_textures.py <valheim_server_Data> <plugins>/WebMap/map_data/models
```

### Meshes

Same story for the shapes. The engine locks most meshes (about seven in
eight: carts, beehives, ruins, rocks, furniture...). Ask it for the
vertices and it says no. Old versions drew those as boxes, or left parts
out: a cart with boxes but no cart. Now the mod reads the locked meshes out
of the game files too, right after the textures, and draws the real thing.
Once per game version, a few minutes. Log:

```
WebMap: extracting 1900 meshes from the game files in .../valheim_server_Data
WebMap: 1880 of 1900 meshes extracted from 800 files in 180s, 20 not found
WebMap: 1700 models to re-export with newly extracted meshes
```

Mesh files live in `map_data/models/meshes/`. Game data, same rules as
textures: never in the repo, never in the zip, never served. Only the
finished `.glb` models go to the browser. `extract_meshes = false` turns it
off (locked meshes stay boxes). By hand:

```
python3 tools/extract_meshes.py <valheim_server_Data> <plugins>/WebMap/map_data/models
python3 tools/extract_meshes.py <valheim_server_Data> --dump Cart,beehive   # look inside the game files
```

Still a box or a gap? The log names every mesh it could not find or decode.
Send it in an issue.

### Server load

Map drawing runs on its own thread (`render_threads`, default 1, low
priority). Game thread only does: one slow walk over the world every
`sweep_interval` seconds (3,000 objects per frame), player snapshot once a
second, fog, model export within `export_ms_per_frame`. PNGs are made by the
mod's own writer, off the game thread.

If the engine refuses to sample ground off the game thread, the mod does a
few rows per frame on it instead. Slower. Never freezes. `render_threads = 0`
forces that.

Disk: whole world at 1 m/px is ~6,400 tiles, few hundred MB. Only walked
ground draws close up, so a normal world is tens of MB. `max_render_zoom = 6`
cuts that by four.

## Config

| Section | Key | Default | What |
|---|---|---|---|
| Render | `render_threads` | 1 | threads drawing tiles (0 = do it on game thread, slowly) |
| Render | `prerender_zoom` | 5 | draw the whole world up to this zoom at first start |
| Render | `max_render_zoom` | 7 | closest zoom over walked ground (7 = 1 m/px) |
| Render | `height_max_zoom` | 7 | closest zoom for height tiles (3D) |
| Sweep | `sweep_interval` | 120 | seconds between world walks |
| Sweep | `zdos_per_frame` | 3000 | objects looked at per frame during a walk |
| Markers | `reveal_all` | false | no fog: whole world shown and sent out. Testing only |
| User | `always_map` | true | lift fog where hidden players walk. Their spot stays hidden |
| User | `always_visible` | false | ignore players' "hidden" setting |
| User | `show_last_seen_position` | false | offline players' last spot in stats |
| Server | `server_port` | 3000 | HTTP port |
| Server | `map_title` | (server name) | title on the page |
| Server | `enable_3d` | true | offer the 3D view |
| Server | `event_log` | true | write events to `events.jsonl` |
| Server | `legacy_map` | true | build one big `map.png` for `/map` |
| Models | `export_models` | true | export prefab meshes for 3D |
| Models | `object_categories` | piece,other,rock,bush,tree | what the 3D view and export get |
| Models | `use_textures` | true | textures on 3D models (off: flat colours) |
| Models | `texture_max_size` | 512 | longest texture edge |
| Models | `export_ms_per_frame` | 6 | game-thread ms per frame for export |
| Texture | `explore_radius` | 100 | metres revealed around a player |
| Texture | `reveal_visited` | true | lift fog everywhere the world save shows players have been, even before the mod |
| Texture | `reveal_visited_margin` | 3 | how far in from the edge of the built zones the reveal stops (0 = 320 m, 3 = 150 m, 4 = 100 m) |
| Discord | `discord_webhook`, `discord_invite_url` | | webhook for events |
| Server | `webmap_url`, `max_pins_per_user` | | link shown in game, pin limit |
| User | `web_pins` | true | let the web page place pins (right click / long press) |
| Models | `extract_meshes` | true | read locked meshes out of the game files (else boxes) |
| Server | `websocket_compression` | false | permessage-deflate on the live feed. Off: IIS ARR and some proxies drop every frame with it on |

### Your own markers

Put `markers.json` next to the world's map data
(`plugins/WebMap/map_data/<world>/markers.json`). Read again when it changes.

```json
{ "sets": [
  { "id": "mines", "label": "Mines", "markers": [
    { "x": 2210, "z": 980, "label": "Silver mine", "icon": "mine", "description": "north face" }
  ] }
] }
```

Icons: `pin dot fire mine house cave boss trader dungeon camp village ruin runestone wreck portal tombstone boat cart poi spawn`.

### Player card

Click a player. Card pops up next to them. Health, stamina, eitr as bars.
State: PvP, sleeping, dead. Biome and coordinates. What they hold in each
hand and wear on head, chest, legs, back, belt. Lifetime numbers: played,
deaths, walked, visits, portal trips. Follow, go to, switch 2D/3D. Card
stays open and updates live. Escape or click away closes it. Works on the
2D map, in 3D, and from the Players list. Game only sends current stamina
and eitr, not the max, so those bars fill against 100 or the current value.

### Export a 3D scene

Download button, top bar. Pick the area (what you see on the 2D map, or
256 m to 1.5 km around the centre), ground detail, what to include, format:

* **glTF, instanced.** One mesh per prefab, placed many times. Small file.
  Blender, Godot, three.js.
* **glTF, one object per node.** Unreal, Unity, anything that lacks the
  instancing extension. Bigger file, same stuff.
* **Unreal pack.** Zip: the flat scene, `heightmap_r16.png` for a Landscape,
  `instances.csv` and `markers.csv` in Unreal units, an editor Python
  script, README with the exact Landscape scale and location numbers.

Made in the browser from what the map already shows. Fog applies: nothing
undiscovered leaves the server. Meshes and textures are the game's own
files from your server. Use the export yourself, do not pass it around.
Steps per editor in [docs/EXPORT.md](docs/EXPORT.md).

## HTTP API

| Path | Returns |
|---|---|
| `/tiles/map/{z}/{x}/{y}.png` | ground tile, zoom 0–7. 404 + `X-WebMap-Tile: pending` while drawing |
| `/tiles/veg/{z}/{x}/{y}.png` | tree and rock overlay, zoom 5–7, transparent PNG |
| `/tiles/height/{z}/{x}/{y}.png` | height tile, [Terrarium] encoding |
| `/data/structures/index.json`, `/data/structures/{cx}_{cz}.json` | pieces per 256 m chunk |
| `/data/veg/{cx}_{cz}.bin` | vegetation points per chunk (`Vegetation.cs`) |
| `/data/objects/index.json`, `/data/objects/{cx}_{cz}.bin` | every placed object per chunk: prefab, position, rotation, scale (`WorldObjects.cs`) |
| `/data/prefabs.json` | model library: which prefabs have a model, bounds, triangles, textures |
| `/models/{hash}.glb`, `/models/tex_*.png` | exported models and textures. Cacheable |
| `/data/markers.json` | marker sets |
| `/data/players.json` | live players: position, health, stamina, eitr, gear, state |
| `/data/stats.json`, `/data/events.json`, `/data/pins.json` | stats, events, pins |
| `/data/fog.png` | explored mask, north up |
| `/config`, `/api/status` | config, drawing and sweep status |
| `POST /api/sweep` | walk the world now |
| `POST /api/rerender?zoom=N` | redraw tiles from zoom N up (token) |
| `POST /api/reexport` | export every model again (token) |
| `POST /api/reload` | forget cached web files, refresh every open browser (token). Swap files in `web/` without restarting the game |
| `POST /announce` | message on every player's screen (token) |
| `/map`, `/map.jpg`, `/fog`, `/players`, `/pins`, `/messages`, `/structures`, `/structures/stats`, `/structures/refresh`, `/forest`, `/forest/stats`, `/vehicles` | simple endpoints: one-image map, plain lists |

Websocket at `/ws`. JSON frames: `hello`, `players`, `events`, `tiles`,
`world`, `ping`, `pin`, `rmpin`, `reload`.

Tile grid: world is a 20,480 m square around the origin. Zoom 7: one pixel
is one metre. Tile (0,0) is the north-west corner. Zoom `z` has `2^(7-z)`
metres per pixel. `tx = floor((x + 10240) / (256 · 2^(7-z)))`,
`ty = floor((10240 − z_world) / (256 · 2^(7-z)))`.

### Token

`POST /announce`, `/api/rerender`, `/api/reexport`, `/api/reload` need a secret in header
`X-Announce-Token`. Secret is read from file `announce.token` next to the
DLL. No file, no access.

### New web files, no restart

Changed something in `web/`? Copy the files over, then:

```
curl -X POST -H "X-Announce-Token: yoursecret" http://localhost:3000/api/reload
```

Server forgets its cached copies and every open browser reloads. Only the
web files. A new DLL still needs a game restart. For dev work set
`cache_server_files = false` and the server reads from disk every time.

## Pins

**From the web page.** Right click the map (long press on a phone). Pick a
type, write a label, add pin. Your own pins have a "Remove pin" button.
Only the browser that made a pin can remove it. `web_pins = false` turns
this off. `max_pins_per_user` caps pins per browser, old ones go first.

**From chat.** Type in game:

* `!pin [type] [text]` — types `dot`, `fire`, `mine`, `house`, `cave`
* `!undoPin`, `!deletePin [text]`

Chat pins have a catch. Since Valheim 1.0 the game sends chat straight from
player to player, not to the server. The server only sees chat while it
passes it on between two or more players. Alone on the server, your `!pin`
never arrives. Not a bug in the mod, nothing the mod can do. Use the web
page, it always works. Pings (middle click on the in-game map) still reach
the server, alone or not.

## Build

Windows: `.\build.ps1`. Needs .NET SDK and the Steam "Valheim Dedicated
Server" tool, or `-ValheimManaged <path>`. Linux/macOS: `./build.sh`.
Output: `dist/ValheimWebMap-<version>.zip` and `dist/pkg/plugins/WebMap/`.
`-Deploy <plugins dir>` or `--deploy` copies the plugin there.

## Public demo site

Want a demo people can click on without showing your real world? Run the
mock server in Docker. Made-up island, fake players walking in circles,
fake chat. No game files inside, nothing to leak, nothing it can write.

```
docker compose -f tools/docker-compose.demo.yml up -d --build
```

Port 3000. Put your reverse proxy or Cloudflare Tunnel in front on a demo
hostname. Title and world name come from `WEBMAP_TITLE` and `WEBMAP_WORLD`
in the compose file. Image is ~60 MB, uses under 100 MB RAM. Tiles are drawn
on first request and cached; the demo loops forever.

Your real map: keep it for your players. Cloudflare Access, a password on
the proxy, or a hostname nobody guesses. The mod itself has no login.

## Try it without a real server

`tools/mockserver.js` (Node, no packages): serves the web app with a made-up
world, fake players, fake events. `node tools/mockserver.js`, open
<http://localhost:3000>.

`tools/docker-compose.test.yml`: real dedicated server (lloesche image)
with a copy of your world.

```powershell
# copy world folder to valheim-test\config\worlds_local\<World>\
.\build.ps1 -Deploy valheim-test\plugins
docker compose -f tools\docker-compose.test.yml up      # first run downloads server
```

Then <http://localhost:3000>. In game: Join by IP, `127.0.0.1:2456`

A copied world lifts the fog where players have been (`reveal_visited`), not
what each player's in-game map shows: that lives in their character file.
Want it all: set `reveal_all = true` in
`valheim-test\config\bepinex\com.valheimwebmap.server.cfg` and restart. Tiles
still draw as you look.

## Licence

MIT. See `LICENSE`. Leaflet (BSD-2) and three.js (MIT) vendored under
`web/vendor`.

[BepInEx]: https://github.com/BepInEx/BepInEx
[Terrarium]: https://github.com/tilezen/joerd/blob/master/docs/formats.md#terrarium
