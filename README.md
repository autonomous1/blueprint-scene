# blueprint-scene

Bake an Inkscape plan and building GLBs into layer files the arena manifest can reference.

## Workflow

1. **Measure.** `blueprint-scene measure --glb model.glb --out buildings/<id>.json --svg buildings/<id>.svg` reads every triangle mesh and writes model bounds in meters plus an SVG footprint group tagged `data-model="<id>"`. That SVG is a stencil, not a layout.
2. **Author.** Duplicate the stencil group in Inkscape, then move and scale it. Scale must be uniform. A non-uniform scale fails the file.
3. **Bake.** `blueprint-scene bake --svg plan.svg --models ./models --out web/game/buildings.placements.json` reads each layer and writes one file per layer. `--out` is the buildings file. `bounds.json`, `props.placements.json`, and `spawn-points.json` are written next to it.

The drawing scale, the toolbar ground plane, and the yaw snap are stated in `blueprint-scene --help`. Flags, page setup, and the `buildings` layer labels are in [docs/commands-and-plan.md](docs/commands-and-plan.md).

Yaw is degrees about +Y, snapped to 0, 90, 180, or 270. The collision file names that `yawConvention: "y-up-90"`. It is the same turn as Three.js `rotation.y`. Positive 90° sends model +X to world −Z and model +Z to world +X. `data-yaw` overrides the SVG transform. Any other angle fails the file.

## CLI

Requires Node.js 22.

```text
blueprint-scene measure --glb model.glb --out buildings/<id>.json --svg buildings/<id>.svg
blueprint-scene bake --svg plan.svg --models ./models --out web/game/buildings.placements.json
```

`--models` is a directory of `<id>.glb`. When it is omitted, the bake reads `web/assets/models/<id>.glb`. The bake fails if a `data-model` has no GLB, or if that GLB has no triangle position data. It prints the mesh names it used, the vertex count, and the unscaled box count, then the box count for each instance.

A placement is a rectangle or a group on a layer named `buildings`, with `data-model="building-a"` or an Inkscape label `model:building-a`. `id` is the instance id. The position is the center of that footprint. Layers named `ignore` are skipped. Scale is the instance's size divided by the measured stencil. A 2× enlarge is `scale: 2`. Instances of one model may use different scales. Scale is applied to the vertices before the footprint is projected, so the grid is in world meters. Yaw and translation come after the runs.

Every triangle mesh contributes to the XZ footprint. A name does not have to start with `wall_`. `--mesh-prefix wall_` restores the name filter: a mesh is kept when its mesh or node name starts with the prefix, or when its mesh or node `extras.collision` is `true`. Primitives with no positions, a zero vertex count, or a non-triangle mode are skipped. Triangles are projected onto XZ. A triangle whose highest vertex is under 0.5 m is floor debris and is dropped. The grid cell is 0.5 m, and a cell is solid when any remaining triangle covers its center. Solid cells merge into horizontal and vertical runs, one AABB each. A run thinner than 0.4 m or shorter than 1 m is dropped, so a 0.2 m mullion does not appear. An empty cell is a doorway; a gap wider than 0.5 m stays open. If one instance still has more than 32 runs, the cell size doubles to 1 m and the grid runs once more. The instance log line is the mesh name, the scale, the cell size, and the box count.

## Output

`--out` is the buildings placements file. The bake also writes `bounds.json`, `props.placements.json`, and `spawn-points.json` in that directory. It does not write `arena.game.json` and it does not wrap any file in a `scene` object. The arena manifest is hand-edited and points at the files:

```json
"scene": {
  "id": "arena",
  "bounds": "./web/game/bounds.json",
  "spawnPoints": "./web/game/spawn-points.json",
  "placements": [
    "./web/game/buildings.placements.json",
    "./web/game/props.placements.json"
  ]
}
```

`bounds.json` is `{ minX, maxX, minY, maxY, minZ, maxZ }`. `minY` / `maxY` are `-2` / `12` unless the bounds rectangle sets `data-min-y` and `data-max-y`. The bounds layer must contain one rectangle. `spawn-points.json` is an array of `{ id, x, y, z, yaw }` with `y` at 0. A mark outside the bounds rectangle fails the bake. `props.placements.json` has one placement per tagged rectangle and one AABB, id `<id>-box`, sized from that rectangle.

The buildings file is the placements file. The arena manifest lists it; the host loads it:

```json
{
  "formatVersion": 1,
  "units": "meters",
  "placements": [
    { "id": "bldg-north", "model": "building-a", "position": [0, 0, 0], "yaw": 90, "scale": 2 }
  ],
  "obstacles": [
    { "id": "bldg-north-wall-0", "kind": "aabb", "min": [-2, 0, -1], "max": [2, 3, 1] }
  ]
}
```

Obstacles are world-space after scale, yaw, and translation. `min` / `max` are `[x, y, z]`. Y is the wall mesh extent; a host that only collides on XZ can ignore it. The instance id prefixes every obstacle id. The same `scale` sizes the mesh when the arena places the model.

`buildings/<id>.collision.json` holds the unscaled runs in model space:

```json
{
  "id": "building-a",
  "origin": [0, 0, 0],
  "yawConvention": "y-up-90",
  "boxes": [{ "id": "wall-0", "minX": -2, "maxX": 2, "minZ": -2, "maxZ": -1.6 }]
}
```
