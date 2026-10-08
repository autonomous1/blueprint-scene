# Commands and plan labels

`blueprint-scene` measures a building GLB, lets you place copies of that footprint in an Inkscape plan, and bakes each layer into its own JSON file. The bake does not write `arena.game.json`. The arena manifest names those files, and the host loads them when it compiles the manifest.

The short form of the drawing scale is `blueprint-scene --help`. This page is the full reference for the commands and for how a plan must be labeled.

Run it with Node.js 22. From this repo:

```text
./bin/blueprint-scene --help
```

The `bin/blueprint-scene` script picks a Node 22 binary. Set `BLUEPRINT_NODE` to force a binary. With no arguments the process prints the usage text and exits 2. `-h` or `--help` anywhere in the arguments prints the usage text and exits 0. A plan error prints one message on stderr and exits 1.

Flags are `--name value` or `--name=value`. An unknown flag, a repeated flag, a missing value, or a bare word is an error.

## Model id

One string is the model id everywhere.

| Place | `brutalist-urban-1` |
| --- | --- |
| Arena asset id | `"id": "brutalist-urban-1"` |
| File the client loads | `"uri": "/assets/models/brutalist-urban-1.glb"` |
| GLB on disk, from the arena repo | `web/assets/models/brutalist-urban-1.glb` |
| Measure `--out` stem | `buildings/brutalist-urban-1.json` |
| Plan label | `data-model="brutalist-urban-1"` or `inkscape:label="model:brutalist-urban-1"` |
| Bake file | `<models>/brutalist-urban-1.glb` |

The id matches `^[A-Za-z0-9][A-Za-z0-9_.-]*$`. The first character is a letter or digit. The rest may also contain `_`, `.`, and `-`.

`measure` takes the id from the `--out` filename stem, not from the GLB filename. For this facade the stem is `brutalist-urban-1`, so the stencil group is tagged with the same id as the asset and the `.glb` basename.

## Drawing scale

Inkscape drawing scale is 1 mm = 1 m. A rectangle 8 mm wide is an 8 m facade when the page is set up as below and the rectangle is the whole instance.

Set the Inkscape document units to mm and the document scale to 1. Give the root `svg` a width in millimetres equal to the `viewBox` width:

```xml
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
     width="48mm" height="48mm" viewBox="0 0 48 48">
  <sodipodi:namedview inkscape:document-units="mm" inkscape:document-scale="1"/>
</svg>
```

World meters per user unit are `widthInMm / viewBoxWidth / documentScale`. With `width="48mm"`, `viewBox` width 48, and document scale 1, one user unit is one millimetre on the page and one metre in the world. The numbers in the Inkscape toolbar are metres.

`viewBox` must be four numbers, and its width and height must be positive. The toolbar origin is the lower-left of the page, and that point is world `(0, 0, 0)`. A `viewBox` that does not start at 0 does not move the room, and the bounds rectangle is not subtracted.

If `width` is missing or a percentage, the bake uses `height` against the `viewBox` height. One of those two must be a length. A percentage fails. Supported units are `mm`, `cm`, `m`, `in`, `ft`, `px`, `pt`, `pc`, and `q`. A bare number on the page width uses `inkscape:document-units` from `sodipodi:namedview`, and otherwise `px`. `1in` across a `viewBox` of width 1 is 25.4 m per user unit.

`inkscape:document-scale` divides that factor. Scale 2 on a 40 mm page with a `viewBox` width of 40 is 0.5 m per user unit. Leave it at 1.

The plan is the ground. Use the coordinates Inkscape shows in the toolbar, which are user space with Y up. The SVG `y` attribute is measured down from the top of the page, so the toolbar value is the page bottom minus that attribute. Map toolbar x to world x and toolbar y to world z. Do not add the page height again, and do not negate toolbar y.

```text
toolbarX = svgX
toolbarY = (viewBoxMinY + viewBoxHeight) - svgY
x = toolbarX * metersPerUserUnit
y = 0
z = toolbarY * metersPerUserUnit
```

The same mapping places buildings, props, spawn marks, bounds corners, and obstacle corners. The placement position is the center of the labeled geometry after its transform.

## measure

```text
blueprint-scene measure --glb model.glb --out buildings/<id>.json --svg buildings/<id>.svg
```

| Flag | Required | Meaning |
| --- | --- | --- |
| `--glb` | yes | GLB to read. Every triangle mesh is included. |
| `--out` | yes | Bounds JSON. The filename stem is the model id. |
| `--svg` | yes | Stencil SVG. This is a footprint to copy, not a layout. |

Parent directories are created. On success the process prints the GLB path, the vertex count, and the run count, then `wrote <out>` and `wrote <svg>`.

```text
web/assets/models/brutalist-urban-1.glb: 21548 vertices, 5 runs
wrote buildings/brutalist-urban-1.json
wrote buildings/brutalist-urban-1.svg
```

`--mesh-prefix` is not a measure flag. Measure always reads every triangle mesh. Empty primitives and non-triangle modes are skipped. A GLB with no triangle positions fails. A GLB that has positions and still produces no run fails before either file is written.

### Bounds JSON

`buildings/brutalist-urban-1.json` looks like this. `units` is `"glb"`. `bounds` is the raw GLB box, about one unit across. It is not a 0–1 UV range and not the arena size in meters. `footprint` is one local XZ box per run, in those same units. This model has five runs. The snippet shows the bounds and the first run.

```json
{
  "id": "brutalist-urban-1",
  "units": "glb",
  "bounds": {
    "min": [-0.490556, 0, -0.177599],
    "max": [0.490556, 0.524156, 0.177599]
  },
  "footprint": [
    { "minX": -0.45, "maxX": 0.490556, "minY": 0.00192, "maxY": 0.508796, "minZ": -0.177599, "maxZ": 0.03552 }
  ]
}
```

`bounds` is the axis-aligned box of every triangle vertex. `footprint` is a 0.05 grid on the unscaled GLB. Every triangle is projected. A run stays when its long side is at least one cell. Measure does not use the bake rule that drops a run shorter than 1 m or thinner than 0.4 m. Arena meters are the scale of the SVG instance, applied later. The stencil extent used for that scale is separate, so a plan already drawn around it does not move. Numbers are rounded to six decimal places. A file saved as `buildings/brutalist-urban-1-measure.json` is the same measure with id `brutalist-urban-1-measure`, because the stem is the id.

### Stencil SVG

The stencil is one group. Its origin is the model origin. Model +X becomes SVG +x. Model +Z becomes SVG −y, which is toolbar +y and world +z. One GLB unit is 1 mm on the page. The group holds one filled `path`, the union of the footprint runs. Overlapping and edge-adjacent runs are united the way Inkscape Path → Union does: one closed outline, and a hole where a courtyard is fully enclosed. Disjoint walls are separate subpaths of that same path. `fill-rule` is `evenodd`. The group is tagged `data-model`. The path is a stencil, not a collider, and it is not the outer bounds rectangle. The page `viewBox` is the footprint, so a model of about one unit is a page of about 1 mm, not a 1 mm canvas with an empty group.

A 10-unit wall with a 2-unit gap is two outlines. The gap is empty. Two parallel walls are two outlines. Four walls that close a court are one outline with a hole. That wall is a page 10 mm wide.

```xml
<g id="gap" data-model="gap" inkscape:label="model:gap">
  <path fill-rule="evenodd"
        d="M 0 0 L 4 0 L 4 -0.5 L 0 -0.5 Z M 6 0 L 10 0 L 10 -0.5 L 6 -0.5 Z"/>
</g>
```

Model +Z is stored as SVG −y, so it points up the page. The path has no `data-model` of its own. The group is the placement. `brutalist-urban-1` is about one GLB unit across and its SVG contains that path. Scale still uses the separate XZ extent of triangles at least 0.05 on both axes (or the raw bounds when every triangle is thinner than that), so a plan already drawn around that extent does not move. Bake obstacles stay on the 0.5 m grid after that scale. The measure path is not the collider.

Copy this group into a plan. The group's box is the run union. Bake divides that drawn size by the 5 cm extent.

## Authoring the plan

Duplicate the stencil group once per building. On each copy:

1. Set a new `id`. Inkscape keeps the original id on a duplicate, and a repeated id fails the bake. The id is the instance name (`south-facade`), not the model id.
2. Leave `data-model` and `inkscape:label` on the model id (`brutalist-urban-1`).
3. Move it. A uniform scale is allowed. A non-uniform scale fails the file.

Put the copies on the `buildings` layer. The stencil file itself is not a layout: it has no `buildings` layer, so baking it reports no placements.

## bake

```text
blueprint-scene bake --svg plan.svg --models ./models --out web/game/buildings.placements.json
        [--mesh-prefix wall_]
```

| Flag | Required | Meaning |
| --- | --- | --- |
| `--svg` | yes | Inkscape plan. |
| `--out` | yes | Buildings placements JSON. `bounds.json`, `props.placements.json`, `spawn-points.json`, and `doors.placements.json` are written in the same directory. |
| `--models` | no | Directory of `<id>.glb`. Default is `web/assets/models` relative to the working directory. |
| `--mesh-prefix` | no | When set, keep a mesh whose mesh or node name starts with this prefix, or whose mesh or node `extras.collision` is `true`. Omit it to use every triangle mesh. |

From the arena repo, the default directory is the folder that holds `brutalist-urban-1.glb`:

```text
./bin/blueprint-scene bake \
  --svg plan.svg \
  --models web/assets/models \
  --out web/game/buildings.placements.json
```

A missing file fails with `<id>: no GLB at <path>`. A GLB with no triangle positions fails with `<id>: no triangle position data`.

There is no CLI flag for the collision directory. Each model also writes `buildings/<id>.collision.json` relative to the working directory.

### What the log means

```text
brutalist-urban-1: meshes <mesh name>; <vertex count> vertices
south-facade: meshes <mesh name>; scale 2; cell 0.5 m; 4 boxes
wrote web/game/buildings.placements.json
wrote web/game/bounds.json
wrote web/game/props.placements.json
wrote web/game/spawn-points.json
wrote web/game/doors.placements.json
wrote buildings/brutalist-urban-1.collision.json
```

The model line is the GLB: mesh names and vertex count. The instance line is the mesh name, the scale, the cell size, and the world run count. The cell is 0.5 m, or 1 m when the 0.5 m grid still produced more than 32 runs. `--mesh-prefix wall_` on a mesh whose name does not start with `wall_` selects nothing, so the counts are 0.

### Placements file

This is the bake of a 1 m box whose stencil was replaced by an 8 mm square and then scaled 2×. The world box is 16 m and its center is the rectangle center. A copied `brutalist-urban-1` group has the same fields: `model` is `brutalist-urban-1`, and `position`, `yaw`, and `scale` are whatever that copy measures.

```json
{
  "formatVersion": 1,
  "units": "meters",
  "placements": [
    {
      "id": "placed",
      "model": "box",
      "position": [8, 0, 92],
      "yaw": 0,
      "scale": 16
    }
  ],
  "obstacles": [
    {
      "id": "placed-wall-0",
      "kind": "aabb",
      "min": [0, 0, 84],
      "max": [16, 16, 100]
    }
  ]
}
```

`position` is the center, in world metres, `[x, y, z]`, with `y` at 0. `yaw` is 0, 90, 180, or 270. `scale` is the instance size divided by the measured stencil. A 2× enlarge of the stencil group is `scale: 2`. Two instances of one model may use different scales. The obstacle above is a mesh from −0.5 m to 0.5 m on X and Z and from 0 m to 1 m on Y, multiplied by 16 and placed at `(8, 0, 92)` on a 100 mm page. The XZ center is `(8, 92)` and each ground side is 16 m.

`obstacles` are the GLB footprint after that scale, then yaw, then translation. `min` and `max` are `[x, y, z]`. Y is the mesh extent. The instance id prefixes each obstacle id: `<instance>-wall-<index>`. A doorway in the GLB is the gap between those boxes. Yaw turns the boxes and leaves the gap open. The measure path draws that same gap, and it is not the collider. Drawing one rectangle the size of the 5 cm stencil extent also places the model. The doorway still comes from the mesh.

The same `scale` is what the arena applies to the mesh. The bake does not write `arena.game.json`. Point the manifest at the layer files instead of pasting them:

```json
"bounds": "./web/game/bounds.json",
"spawnPoints": "./web/game/spawn-points.json",
"placements": [
  "./web/game/buildings.placements.json",
  "./web/game/props.placements.json"
]
```

A path is relative to the arena repo. It may also point at the sibling blueprint-scene checkout. The host reads each placements file, places each instance at its `position`, `yaw`, and `scale`, and adds each obstacle as an AABB. Obstacle ids in the file are strings. The host numbers them from 100, skipping ids already used in `scene.collision` and the room-shell ids 10, 11, 12, and 13. The same string id in two files fails the load. The asset `scale` on `brutalist-urban-1` (40) is not applied to these instances. None of the layer files contains a `scene` object.

A single room face can still carry its own pose. A face written as the string `"brutalist-urban-1"` uses the asset `scale` because that face omitted one. A face object uses the scale you write on it:

```json
"faces": {
  "south": {
    "model": "brutalist-urban-1",
    "position": [8, 0, 92],
    "yaw": 0,
    "scale": 16
  }
}
```

`yaw` on the face is degrees, the same 0 / 90 / 180 / 270 as a placement.

### Model-space collision file

`buildings/brutalist-urban-1.collision.json` is the footprint in model metres, before the instance scale. A model whose runs are all shorter than 1 m or thinner than 0.4 m has an empty `boxes` array here, while a scaled instance in the placements file can still have world boxes.

```json
{
  "id": "brutalist-urban-1",
  "origin": [0, 0, 0],
  "yawConvention": "y-up-90",
  "boxes": [
    { "id": "wall-0", "minX": -0.311998, "maxX": -0.231358, "minZ": -0.129599, "maxZ": -0.071999 }
  ]
}
```

`yawConvention: "y-up-90"` is the same turn as Three.js `rotation.y`. Yaw 0 leaves model axes in place. Positive 90° sends model +X to world −Z and model +Z to world +X. Yaw 180 sends both +X and +Z to their opposites. Yaw 270 sends model +X to world +Z and model +Z to world −X.

### Footprint rules

Scale is applied first. Triangles are then projected onto XZ, and yaw and translation happen after the runs exist.

- A triangle whose highest vertex is under 0.5 m is floor debris and is dropped. Other Y values are ignored until a run takes its height from the triangles that overlap it.
- The grid cell is 0.5 m. A cell is solid when any remaining triangle covers its center. A tessellated wall is made of smaller triangles; those still paint a center they cover.
- Solid cells merge into horizontal and vertical runs. One run is one AABB. Overlapping corners stay two runs, so an L does not become one box over the room.
- A run thinner than 0.4 m or shorter than 1 m is dropped. A 0.2 m mullion does not appear.
- An empty cell is a doorway. A gap wider than 0.5 m is not filled.
- At most 32 obstacles are kept per instance. If the 0.5 m grid still exceeds that, the cell doubles to 1 m and the grid runs once more.
- The check is in world metres, after that instance's scale. The collision file is the same grid before scale.
- A `doors` rectangle is stamped after that fill, on that instance's grid only. Cells the opening overlaps are cleared, then the runs are merged again. The model collision file and the GLB stay whole.

## Doors

A door is a rectangle on the `doors` layer. It overlaps the building it opens. `data-building` is the placement id in this SVG. A name that is not a placement fails the bake and writes nothing. `data-model` or the label `model:<id>` is the placement model, the same way a prop is tagged. Both may be set when they are the same id. A door with neither fails the bake and writes nothing. The bake does not substitute `"door"`.

`data-hinge` is `left` or `right`. The default is `left`, as seen from outside the building. `data-open="true"` starts the panel open. The default is `false`. `data-width` is the opening width in metres when the rectangle is only a marker. `data-height` and `data-depth` replace the panel size. Otherwise the panel is `[width, 2.1, 0.08]`, and `width` is the rectangle's extent along the wall.

The gap is that door's own rectangle: the width along its local X, and 2 m inward along local −Z. It is rotated by the door yaw, the same yaw as the visual, and then stamped into the building grid. It does not take the footprint's extent, so a wall along X at yaw 0 loses about 2 m of X and only its own thickness in Z. A yaw of 90 swaps those axes. The door file has no obstacle. `position` is the rectangle center pushed onto the nearest wall face. `yaw` matches that face: maxZ is 0, minZ is 180, maxX is 90, minX is 270. A tie prefers the max side, then a Z face.

```json
{
  "formatVersion": 1,
  "units": "meters",
  "placements": [
    {
      "id": "front",
      "model": "door-1",
      "position": [10, 0, 10.5],
      "yaw": 0,
      "hinge": "left",
      "size": [2, 2.1, 0.08],
      "open": false
    }
  ],
  "obstacles": []
}
```

## prop

```text
blueprint-scene prop --shape door --svg door.svg --out props/door.glb
```

The SVG is an elevation on a `door-design` layer, in the same millimetre scale as a plan. Across the page is model X and up the page is model Y. The part name is the element id: `data-part-frame`, `data-part-door`, and `data-part-hinge` are rectangles, and `data-part-texture` is an image. The hinge mark sits on the left or right edge of the door. A mark in the middle, or on the top or bottom, fails the file. The door sits inside the frame, and the frame keeps a border.

The GLB has four frame meshes and one door mesh. A node named `frame` parents the four boxes and has no mesh of its own. Those boxes are the outer rectangle minus the door: left and right stiles run the full height, and the rails sit between them. The hole is the door rectangle. Depth is 0.12 m. `door` is a box the size of the door rectangle, 0.08 m thick. Its origin is the hinge edge, midway up, on the back of the frame (`z = 0`). The panel extends toward +Z, the outward face, and sits in the opening. A left hinge runs from x 0 to the door width. A right hinge runs from the negative width to 0. The texture image is the full face. It may be a PNG data URI or a path relative to the SVG. Each frame piece samples the strip of that image it covers, so the left stile reads the left edge. The door's front and back show only the door rectangle. U 0 is the left of the image and V 0 is the top of the PNG. A picture that covers the frame, with the hinges on the left, maps onto a left-hinge door without mirroring. Edges are untextured. There is no skin, no animation clip, and no obstacle.

The arena parents the panel under a node on that hinge and yaws the node when `open` is true. A left hinge swings positive and a right hinge swings negative, about 100°, so the latch moves inward. The frame stays at the placement yaw.

```text
blueprint-scene prop --shape crate --svg crate.svg --out props/cover-crate.glb
```

`prop --shape crate` reads rectangles and images on a `crate-design` layer. The page scale is the plan scale. Each rectangle carries a texture: `data-texture` (a path relative to the SVG, or a PNG data URI) or an image `href`, including an image nested in the rectangle. A label is `data-face`, or an Inkscape label, or an element id, when that text is `front`, `back`, `left`, `right`, `top`, or `bottom`.

One rectangle and no label maps that image onto all six faces. The rectangle's width and height are the front face, in meters. Depth equals the width unless `data-depth` is set. `data-depth` is a page length, the same conversion as the rectangle, and only on that unlabeled rectangle.

Labeled faces name the sides. A missing opposite uses the side that was drawn: no back uses front, no left uses right, no right uses left, no bottom uses top, and no top uses bottom. Front is required. Left or right is required, and top or bottom is required. The front rectangle's width is the box width and its height is the box height. Depth is the left or right rectangle's width. The top and bottom rectangles' height is that depth, and their width is the front width. A side rectangle's height is the front height. A face that disagrees on a shared edge fails the file, and nothing is written.

The GLB is one mesh named `crate`: six quads, 24 vertices. The origin is the center of the bottom face, so y = 0 is the floor. x runs from −width/2 to width/2 and z runs from −depth/2 to depth/2. Front is +Z, right is +X, and top is +Y. Each face's UVs cover its own image. U grows toward the viewer's right and V = 0 is the top of the PNG. The images are embedded. There is no skin, no clip, and no collision inside the GLB. Beside the GLB, the same stem is written as `<stem>.collision.json`: one AABB of that size, with `minY` 0 and `maxY` the height, origin `[0, 0, 0]`, `yawConvention` `y-up-90`. The crate is not scaled by a building scale and it does not read the occupancy grid.

## Plan labeling

The bake reads `rect` and `g` elements. A path, circle, ellipse, polygon, polyline, text, image, or `use` is not a placement. `use` is not expanded.

A placement is a `rect` or a non-layer `g` that:

- has an ancestor Inkscape layer named `buildings`, and
- has no ancestor Inkscape layer named `ignore`, and
- has `data-model="<id>"` or an Inkscape label `model:<id>`.

An Inkscape layer is a group with `inkscape:groupmode="layer"`. The layer name is `inkscape:label`. Both names are exact: `buildings` and `ignore`. A group that is not a layer does not start or stop that search. Its `inkscape:label` is read only as a model id.

```xml
<g inkscape:groupmode="layer" inkscape:label="buildings" id="layer-buildings">
  <!-- One rect the size of the stencil union. This model is 0.802554 m by 0.220798 m. -->
  <rect id="south-facade" data-model="brutalist-urban-1"
        x="-0.311998" y="-0.091199" width="0.802554" height="0.220798"/>

  <g id="north-facade"
     data-model="brutalist-urban-1"
     inkscape:label="model:brutalist-urban-1"
     transform="translate(24 8)">
    <!-- the stencil rect, with no data-model of its own -->
  </g>

  <g inkscape:groupmode="layer" inkscape:label="ignore">
    <rect id="hidden" data-model="brutalist-urban-1"
          x="-0.311998" y="-0.091199" width="0.802554" height="0.220798"/>
  </g>
</g>
```

`south-facade` and `north-facade` are placements. `hidden` is dropped because its layer is `ignore`. A rectangle with neither `data-model` nor a `model:` label is decoration, on any layer. A rectangle on `bounds` is the room: the layer must exist and must contain one rectangle, and the bake does not infer the room from the buildings. `data-min-y` and `data-max-y` on that rectangle replace the default vertical span of `-2` and `12`. A rectangle on `props` with `data-model` or `model:<id>` is a prop. Its placement scale is the uniform SVG scale. Its obstacle (`<id>-box`) is the GLB bounds after that position, yaw, and scale. A missing GLB uses the rectangle. The pawn radius is not added. A rectangle on `doors` with `data-building` is a door, and it also needs `data-model` or a `model:` label. A `text`, `path`, or small `rect` on `spawn-points` is a spawn. Yaw comes from that element's transform, or `0` when it is not rotated. A spawn outside the bounds rectangle fails the bake. Those layers use the same toolbar mapping as a building. Layers named `notes`, guides, and anything else are decoration. `defs`, `metadata`, and `sodipodi:namedview` are skipped.

A tagged group is one placement. The bake does not also emit the rectangles inside it. Put `data-model` on the group you duplicated, not on those inner rectangles. Inner rectangles that themselves carry `data-model`, and that are not inside an already tagged group, are separate placements and need their own ids.

### `data-model` and `model:`

Either attribute selects the model. Both may be set when they are the same id. If they differ, the file fails:

```text
rect "<id>" data-model "a" disagrees with label "model:b"
```

The label must be the whole string `model:<id>`, with optional spaces after the colon (`model: brutalist-urban-1`). The match is case-sensitive. A label of `brutalist-urban-1` without the `model:` prefix does not select a model. The layer name `buildings` is a layer name, not a model id.

Attribute lookup uses the local name, so `data-model`, `inkscape:label`, `inkscape:groupmode`, `inkscape:document-units`, and `inkscape:document-scale` are read with or without a prefix. Inkscape's prefixed form is what you should author.

### Instance id

Every placement has an `id`. It uses the same character rule as the model id. A missing id fails with `placement of model "<model>" is missing id`. A duplicate fails with `duplicate placement id "<id>"`. An empty plan fails with `no building placements in the SVG`.

### Geometry the scale is measured against

For a `rect`, the local box is `x`, `y`, `width`, `height`, before that rectangle's own `transform`. The rectangle's `transform` is part of the placement matrix.

For a `g`, the local box is the union of the rectangles and paths inside it, including transforms on those children and on nested groups. Path coordinates are user units. The group's own `transform` is the placement matrix, so it is applied once.

A bare number is user units. A length with a unit is converted through millimetres, so `width="8mm"` on a 1 mm-per-unit page is 8 user units and 8 m. `x` and `y` default to 0 when omitted. `width` and `height` must be positive.

The drawn size, in world metres, is the local width times the transform's x-axis length times metres-per-user-unit, and the same for the local height and the y-axis length. Bake then divides by the measured stencil:

```text
scaleX = drawnWidth / stencilWidth
scaleZ = drawnDepth / stencilDepth
```

`stencilWidth` is the stencil's X extent in model metres. `stencilDepth` is its Z extent. The two quotients must agree within 0.1% of their average. The placement `scale` is that average. A stencil with no area (a prefix that selected no mesh) yields scale 1 and no obstacles.

| What you draw | Placement scale |
| --- | --- |
| The measured group, unchanged | 1 |
| That group with `scale(2)` | 2 |
| A 1 m model drawn as an 8 mm by 8 mm rectangle, then `scale(2)` | 16 |
| An 8 mm by 4 mm rectangle for a square 1 m stencil | fails |

The 8 mm example, for a model whose stencil is 1 m by 1 m, centered after the scale:

```xml
<g inkscape:groupmode="layer" inkscape:label="buildings">
  <g id="placed" data-model="box" transform="scale(2)">
    <rect x="0" y="0" width="8" height="8"/>
  </g>
</g>
```

On a `width="100mm"` page with `viewBox="0 0 100 100"`, the child is 8 m by 8 m and the group scale is 2, so the drawn size is 16 m. The model is 1 m, so `scale` is 16. The rectangle center is SVG `(8, 8)`. Toolbar y is `100 - 8 = 92`, so the world position is `(8, 0, 92)`. The world box is 16 m on X and Z and is centered on that point.

A copied stencil keeps the model's proportions. Replacing the group with one rectangle is valid when that rectangle's width and height match the 5 cm stencil extent. Stretching it, or using `scale(2, 3)`, fails.

### Transforms, yaw, and `data-yaw`

Transforms are SVG order: the rightmost operation runs first, then the parent. `translate`, `scale`, `rotate`, `matrix`, `skewX`, and `skewY` are accepted. `rotate(90 8 4)` rotates about that point. Cardinal angles use exact sines and cosines, so `rotate(90)` is a quarter turn rather than a float near one.

With no `data-yaw`, the yaw is the transform's turn, snapped to 0, 90, 180, or 270. A turn more than half a degree off those four fails. `matrix(0 1 -1 0 0 0)` is the same yaw as `rotate(90)`. The two axis lengths must match within 0.1%. A zero scale fails.

`data-yaw` overrides that angle. It is a number of degrees, optionally followed by `deg` or `°`, and it is snapped the same way. The transform is then not read as a yaw, so an axis-aligned stencil can carry `data-yaw="90"`. Prefer a real `rotate` when you want the page to show the yaw the bake will use. When both are present, `data-yaw` is the value in the placements file.

### Errors you get from a bad label

| Condition | Message |
| --- | --- |
| `data-model` and `model:` differ | `rect "<id>" data-model "…" disagrees with label "model:…"` |
| Model id has a bad character | `rect "<id>" has invalid model id "…"` |
| No `id` | `placement of model "…" is missing id` |
| Bad instance id | `invalid placement id "…"` |
| Same instance id twice | `duplicate placement id "…"` |
| No rectangles or paths in the group | `placement "<id>" has no footprint` |
| Nothing tagged on `buildings` | `no building placements in the SVG` |
| Rotation is not a quarter turn | `placement "<id>" rotation N° is not 0, 90, 180, or 270` |
| Skew, or axes that are not perpendicular | `placement "<id>" transform is not a quarter turn` |
| `scale(2, 3)` on the transform | `placement "<id>" scale is not uniform` |
| Drawn aspect disagrees with the stencil | `placement "<id>" scale is not uniform (a vs b)` |
| Scale is 0 | `placement "<id>" transform scale is zero` |
| `data-yaw` is not a number | `placement "<id>" data-yaw "…" is not a number of degrees` |
| Page has no `viewBox` | `svg is missing viewBox` |
| Page width and height are not lengths | `svg width or height must be a length (m, mm, cm, in, px)` |
