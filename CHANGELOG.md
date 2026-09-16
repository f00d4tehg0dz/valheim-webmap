# Changelog

## 2.1.3

* Sky, sun, moon and shadows in 3D. Sky dome with sun disc, stars, dawn and dusk colours; fog to the horizon; the sun follows the server's time of day (Layers > "Time of day", or pick a fixed one); buildings, trees and hills cast shadows (toggle, off on phones by default); water ripples and mirrors the sky; filmic tone mapping.
* Every model, not one in eight. The engine locks most meshes, so the 3D view drew boxes (a cart with its boxes but no cart, a bare beehive). The mod now reads locked meshes out of the game files like it already did textures: `extract_meshes` config, `map_data/models/meshes/`, `tools/extract_meshes.py` by hand. Model library format 5: everything is exported again once.
* Materials that keep their colour map under `_BaseMap` and friends get their texture too.

## 2.1.1

* Addressed issue [#2](https://github.com/f00d4tehg0dz/valheim-webmap/issues/2) with !pin command not working. Pins from the web page. Right click (long press on a phone), pick a type, label, done. Remove your own from the popup. `POST /api/pin`, `POST /api/unpin?id=`. `web_pins` turns it off. 
* Addressed issue [#3](https://github.com/f00d4tehg0dz/valheim-webmap/issues/3) with title bar in Mobile not being supported.
* Addressed issue [#1](https://github.com/f00d4tehg0dz/valheim-webmap/issues/1) with Web dir not being included in build, causing mod manager Gale to fail installation
* Addressed issue [#5](https://github.com/f00d4tehg0dz/valheim-webmap/issues/5) with @Aughen PR #6. WebSocket compression off by default, `websocket_compression` turns it back on. 
* Addressed issue with fog coverage not being 100% on initial load with @clanofartisans PR #7
* Build script: one `-ValheimManaged` path works. (#6)
* `POST /api/reload` (token): Update the web app without restarting the game.
* Layer list says "Pins", not "Chat pins".

## 2.1.0

* Old trips count. Fog lifts everywhere players have already been, even from
  before the mod was installed. The world save lists every zone the game
  built, and it only builds them near a player. Runs at start and once a
  minute. `reveal_visited` (on) and `reveal_visited_margin` (3 zones, about
  150 m from where they walked).
* Player card. Click a player on the map, in 3D or in the list: health,
  stamina, eitr, what they wear and hold, state, lifetime stats. Updates live.
  Server now sends stamina, eitr and gear.
* Export. Pick an area, get a 3D scene: glTF (instanced, or one node per
  object) or an Unreal pack with a 16-bit heightmap, CSVs in Unreal units
  and an editor script. Made in the browser. Fog applies.
* Demo site. `tools/Dockerfile.demo` and `docker-compose.demo.yml` run the
  mock server as a public demo. Mock draws the tree and rock overlay and
  loops forever.
* Stats table fits the sidebar. README in plain words.

## 1.0.1

First public release. Same as 1.0.0 plus README and screenshot fixes.

## 1.0.0

First release.

* Tiled map, seven zoom levels, 1 m/px. Rendered from world generator plus
  player terraforming (levelled ground, moats, paved roads, farmland). Trees,
  bushes, rocks as a separate overlay layer. Close-zoom tiles render only over explored ground.
  Re-render when ground changes. Worker thread, own PNG encoder, sliced
  main-thread fallback.
* Buildings as vector data per 256 m chunk: footprint, height, material,
  prefab. Drawn as material-coloured footprints with hover info.
* 3D view (three.js). Terrain from height tiles with quadtree LOD, seamless
  between tiles, clean ground tiles with tiled fine grain up close. Water.
  Players. Markers. World objects as game's own meshes: mod exports each
  prefab to glTF once (`map_data/models/`), publishes each chunk's objects
  with prefab, position, rotation, scale. Browser instances models.
* Textures pulled from the game's own asset files by the mod itself, in the
  background, on every platform. `tools/extract_textures.py` as manual
  fallback. `POST /api/reexport` rebuilds models.
* Fog of war always on. Black over unexplored ground. World locations
  (bosses, dungeons, traders) never published.
* Markers: portals with tags and links, tombstones,
  player bases (clusters of built pieces), boats, carts, custom
  `markers.json` sets.
* Layer toggles drive 2D and 3D: buildings with opacity, players, chat pins,
  trees and rocks overlay (2D),
  labels, 256 m grid, marker sets, object categories.
* Stats per player: playtime, sessions, deaths, distance, portal trips,
  biomes. Per server: day, explored %, counts, online history.
* Event feed with `events.jsonl` history. Deaths carry position.
* Web app: dark UI, sidebar, search, permalinks, follow mode, mobile
  layout. No build step.
* Simple endpoints kept for scripts: `/map`, `/players`, `/pins`,
  `/messages`, `/structures`, `/forest`, `/vehicles`. Websocket speaks JSON.
* Discord webhook, `POST /announce`, chat pin commands.
