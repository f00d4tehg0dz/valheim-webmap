# How it works

## Shape

```
 game thread                     worker threads                    HTTP / websocket threads
 ───────────────────────────     ──────────────────────────────    ────────────────────────────
 WorldSweep (sliced ZDO walk)    TileStore workers                 MapDataServer
   ├─ TerrainPatches.Observe  ─▶   TileJob.Sample (WorldGenerator)   ├─ /tiles/…  ◀─ disk + memory cache
   ├─ Vegetation.Observe      ─▶   TileJob.Compose (colours, veg)    ├─ /data/…   ◀─ published JSON/bytes
   ├─ Structures.Observe      ─▶   TileJob.Encode  (own PNG writer)  ├─ /models/… ◀─ map_data/models
   ├─ WorldObjects.Observe          write tiles/{map,height}/z/x_y     ├─ static web/
   ├─ Markers/Vehicles              notify "tiles" over ws             └─ ws: players, events, tiles, world
   └─ StructureMap/ForestMap
 ModelStore.Pump (few prefabs per frame) ─▶ map_data/models/*.glb
 Players.Refresh (1 Hz) ─▶ Stats.OnTick
 Fog.Reveal ─▶ TileStore.OnExplored
```

Three rules keep game responsive:

1. **Game thread only reads.** ZDO and peer access happens in `WorldSweep`,
   `Players.Refresh`, `Fog.Reveal`, Harmony patches. Main thread, sliced.
   Each publishes immutable result (array, string). Other threads only read.
2. **Rendering off-thread.** Terrain sampling asks `WorldGenerator` for
   biome and height from worker. Pure arithmetic over immutable state.
   Colours, vegetation, PNG encoding never touch Unity (`Util/Png.cs` is own
   encoder). If engine rejects off-thread sampling, `TileStore` catches
   exception, moves sampling to sliced main-thread coroutine (`MainThreadPump`).
3. **Render only what someone can see.** Close-zoom tiles (above
   `prerender_zoom`) queue only over explored mask. Re-render only when zone
   under them changed.

## Tiles

`Tiles/TileMath.cs` defines pyramid (mirror in `web/js/crs.js`): 20,480 m
square, 256 px tiles, zoom 7 = 1 m/px. `TileJob` renders each tile in three
stages:

* **Sample.** 258×258 grid (one-pixel border for normals):
  `WorldGenerator.GetBiome`, `GetBiomeHeight`, `GetForestFactor`, plus
  bilinear terraforming delta from `TerrainPatches` at zoom ≥ 4.
* **Compose.** Biome ground colour (snow line, meadow yellowing), paint mask
  (dirt, cultivated, paved), forest tint, water depth and shore, hillshade.
  At zoom ≥ 5: vegetation of overlapping zones as shaded discs with soft
  shadow, into a separate transparent overlay (`tiles/veg/`), so the ground
  tile stays clean for the 3D view. `tiles/format.txt` versions the look:
  a bump drops close-zoom tiles for re-render.
* **Encode.** RGB PNG for map, RGBA PNG for the overlay. Terrarium RGB PNG
  for heights (`h = R·256 + G + B/256 − 32768`).

`TileStore` schedules by priority (browser request > overview > changed
ground > explored close-zoom). Writes atomically. Tracks versions for ETags.
Batches "rendered" notifications for websocket.

## Terraforming

Each modified zone owns `_TerrainCompiler` ZDO. `TCData` blob (gzip) holds,
for 65×65 vertices: `bool modified, float level, float smooth`, then
`bool painted, Color paint`. `TerrainPatches.Decode` reads it with
`BinaryReader`, only when ZDO data revision changed. Renderer adds
level+smooth to generator height, same as `Heightmap`. Vertex (i, j) sits at
`zoneCentre + (i − 32, j − 32)`.

## World sweep

`WorldSweep.Sweep` copies `ZDOMan.m_objectsByID.Values` once. Walks it in
slices. Classifies each object by prefab hash (names cached per hash):
terrain compilers → `TerrainPatches`; objects with creator → vehicles
(`Ship`/`Vagon` component), portals and tombstones (`Markers`), else
`Structures`; objects without creator → `Vegetation` (prefab-name patterns).
Every visible object → `WorldObjects`. Collectors build fresh dictionaries,
swap them in at `Finish()`, report changed zones and chunks. Changed zones go
to `TileStore.OnZoneChanged`.

`Structures` publishes per-256 m-chunk JSON (`[x, z, y, yaw, sx, sz, h, mat,
prefabIdx]`), revision per chunk, index of chunks over explored ground.
Footprints come from prefab name (`ShapeOfName`): size token when present
(`stone_wall_4x2`), family defaults otherwise. `ComputeBases` bins
player-placed pieces into 64 m cells, merges busy neighbours, reports
clusters ≥ 30 pieces as base markers.

`Vegetation` publishes per-zone point arrays for renderer. Served per chunk
as compact binary for 3D fallback path.

## Models and world objects

3D view draws world with game's meshes.

* `Models/PrefabExporter` + `Models/GlbWriter`: prefab (from
  `ZNetScene.GetPrefab`) → glTF 2.0 binary, on game thread. Active children
  only (WearNTear worn/broken variants stay out). First LOD of each
  `LODGroup`. Every enabled `MeshRenderer` with readable
  `MeshFilter.sharedMesh`. Vertices baked into prefab root frame. z negated,
  winding reversed for glTF right-handed space. UV v flipped. Materials keep
  `_Color`. Foliage materials (leaves, branches, needles) are never exported
  as geometry: their bounds, leaf texture and tint are recorded instead
  (`k`, `kt`, `kc` in the prefab index). The viewer draws three crossed
  billboard quads over those bounds, tiled with the leaf texture or a
  procedural leaf mask. Three quads per tree instead of hundreds of cards.
* Textures: dedicated server marks every `Texture2D` unreadable. Exporter
  records texture *name* each material wants (`models/textures.json`).
  References `tex_<name>.png` when file exists. `Models/TextureExtractor`
  pulls wanted textures from the game files on a background thread:
  `Models/Unity/BundleFile` reads UnityFS containers block by block (LZ4),
  `SerializedFile` walks type trees to find `Texture2D` objects,
  `TextureDecoder` turns DXT1/DXT5/BC7 into RGBA, PNGs written to models
  dir. Once per game version; names not found are not retried. `ModelStore`
  re-exports models whose textures appeared.
  `/api/reexport` forces all. Leaf textures feed the canopy billboards.
* Meshes: the engine locks most meshes too (`Mesh.isReadable` false, about
  seven in eight). Exporter keys each locked mesh by name + vertex count +
  sub-mesh count + first index count (`mw`/`mm` in the index; a locked mesh
  still reports those) and reads it from `map_data/models/meshes/*.bin`
  (`Models/MeshCache`, own little format) when present. `Models/MeshExtractor`
  fills that cache from the game files after textures: `SerializedFile.ReadMesh`
  (generic type-tree reader) then `Unity/MeshDecoder` unpacks vertex streams
  (float/half/normalised formats, 16-byte aligned streams, `.resS` streamed
  data) or packed-bit compressed meshes. `ModelStore.RescanMeshes` re-exports
  models whose missing meshes appeared. `tools/extract_meshes.py` is the same
  in Python, with `--dump` to inspect what the files hold.
* `Models/ModelStore` owns `map_data/models/` and `index.json`. Sweep
  requests prefab first time it sees it. `Pump()` exports few per frame
  within `export_ms_per_frame`. `/data/prefabs.json` tells browser what
  exists. Prefabs same for every world. Library survives restarts.
* `World/WorldObjects`: during same sweep, every ZDO whose prefab is visible
  thing (has MeshRenderer, not creature, item, projectile, effect) in
  configured `object_categories`. Records prefab hash, position,
  `GetRotation()`, `scale`/`scaleScalar`, creator flag. Per 256 m chunk.
  Revision by content hash. Served as compact binary (`OBJ1`, 44 bytes per
  object). Gated by fog.

Browser `view3d.js`: loads chunk objects, fetches each prefab glTF once
(`GLTFLoader`, cached per session and by HTTP cache), draws one
`InstancedMesh` per model part per chunk. Instance transform: position
(x, y, −z), quaternion (−qx, −qy, qz, qw), scale. Prefab without model:
nothing drawn. Server without object chunks (`export_models` off): view
uses footprint volumes and shape vegetation.

## Live state

`Players.Refresh` (1 Hz, main thread) snapshots peer list to JSON.
`Stats.OnTick` accumulates playtime, distance (jump faster than boat = portal
trip), biomes, 5-minute online-history buckets. Saved to `stats.json`.
`Events`: ring buffer + `events.jsonl`. `DeathWatch` and chat patches feed both.

## Web app

No build step. ES modules. Leaflet (global) and three.js (import map)
vendored under `web/vendor`.

* `crs.js` — CRS: lat = z, lng = x, `scale(zoom) = 2^(zoom−7)`.
* `layers/tiles.js` — `FallbackTileLayer`: ancestor tile scaled up while
  real one missing. Per-tile refresh from `tiles` frame.
* `layers/fog.js` — explored mask as black overlay. Refresh every 20 s.
* `layers/structures.js` — canvas `GridLayer`, rotated footprints from
  chunk data. `pick()` for hover.
* `layers/markers.js`, `layers/players.js` — marker sets, chat pins, portal
  links, player arrows, pings, follow mode.
* `layerstate.js` — sidebar toggles shared by both views.
* `ui.js` — sidebar panels. `app.js` — glue, search, permalink, 2D/3D switch.
* `view3d.js` — quadtree terrain (rings of zoom 7/6/5/4 around camera
  target, coarse tiles hidden once children ready, skirts hide LOD cracks),
  water plane, instanced prefab models per chunk, sprite labels with constant
  screen size. Ground shader darkens unexplored terrain from fog mask and
  draws 256 m grid.
* `data.js` — chunk stores: structures, vegetation, objects (`OBJ1`
  decoder), prefab index, markers, stats.

## Known limits

* Model library is exported from server's own game files into
  `map_data/models/`. Not part of mod package. Game assets not
  redistributable.
* Objects placed as ZDO says. Animated pieces (doors mid-swing, sails) show
  rest pose. Dungeon interiors sit far above map, outside any chunk you look at.
* LOD seams in 3D hidden by skirts, not stitched.
* Fog resolution: 12 m cells.
* Biome under cursor not shown. Player markers show their biome.

## Export (`web/js/export.js`)

Browser only. Reads the zoom-7 height and map tiles of the chosen chunks,
`data/objects/<chunk>.bin`, the prefab glbs already loaded by the 3D view,
`data/markers.json`. Writes glTF binary with its own small writer: one
terrain mesh per chunk, water plane, one mesh per prefab, instances either
as `EXT_mesh_gpu_instancing` accessors or as one node each, canopy quads
with the leaf texture, marker empties. Unreal pack adds a 16-bit grayscale
PNG (own encoder, `CompressionStream` deflate with a stored fallback), CSVs
in Unreal units, a Python helper, README; zipped by a stored-zip writer.
Capped at 36 chunks.
