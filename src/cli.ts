#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bake } from "./bake.ts";
import { PlanError } from "./errors.ts";
import { measure } from "./measure.ts";
import { writeCrateProp } from "./crate.ts";
import { writeDoorProp } from "./prop.ts";
import { writeRoom } from "./room-glb.ts";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readFloorsSvg } from "./floors-svg.ts";

const USAGE = `blueprint-scene measure --glb model.glb --out buildings/<id>.json --svg buildings/<id>.svg
blueprint-scene bake --svg plan.svg --models ./models --out web/game/buildings.placements.json
        [--mesh-prefix wall_] [--game web/game/arena.game.json]
        [--floors buildings] [--rooms web/assets/models]
blueprint-scene prop --shape door --svg door.svg --out props/door.glb
blueprint-scene prop --shape crate --svg crate.svg --out props/cover-crate.glb
blueprint-scene room --svg room.svg --out room.glb [--glb blender.glb]
blueprint-scene floors --svg buildings/<id>.floors.svg

Inkscape drawing scale is 1 mm = 1 m. A rectangle 8 mm wide is an 8 m facade.
The toolbar is the room: x → x and toolbar y → z. Yaw is snapped to 0, 90, 180, or 270.

measure writes raw GLB bounds and an SVG footprint group tagged
data-model="<id>". Units are "glb", not arena meters. The grid is 0.05 on
the unscaled model. A run of one cell is kept. Copy that group into a plan,
then move and scale it. Arena meters come from that scale.
Scale must be uniform. A 2× enlarge is scale 2. Non-uniform scale fails the file.

bake reads the buildings, bounds, props, spawn-points, and doors layers. It
writes five files and does not write arena.game.json or a scene object. --out
is the buildings placements file. bounds.json, props.placements.json,
spawn-points.json, and doors.placements.json are written in that same
directory. A copied measure stencil (a group holding the stencil path) is
placed by its group origin, the model origin, at its transform's uniform scale.
A rectangle's scale is its size relative to the measured stencil extent, and it
is centered on that extent; a rectangle out of proportion prints a warning.
Building obstacles are a 0.5 m XZ grid. Cells the mesh covers from y = 0 to 2 m merge into wall runs before short ones are dropped. A box under 1 m on its long side, or under 0.5 m³, is dropped. A facade longer than 1 m stays even when the mesh is about a centimetre thick. At most 32 boxes. A doors rectangle
with data-building="<model id>" is copied onto every placement of that model.
Each leaf id is <placement id>.<door id>. That opening is cut from each
placement's wall boxes and from the shared <model>.cut.glb. Static instances
are one mesh, so the opening is the same on every copy. A unique facade needs
another model, or a placement id. data-building="<placement id>" cuts only
that instance and does not punch the shared mesh. When the placement id
equals its model id, the door is model-scoped; rename the placement to keep
it on one copy. A name that matches neither fails. The cut is a hinge-aligned
opening through every wall box it overlaps, from its sill to sill + door height. The sill is the
rectangle's own z in meters (world y, like a prop z; not inherited from a
group; absent is 0); wall below the sill and above the head stays. The hinge is the drawn
rectangle's hinge edge. The opening is as wide as the door GLB's panel
(its door mesh) from --models: <id>.glb, or the file its --game asset uri
names (door-1 -> door1.glb). With no GLB or no panel mesh it prints a warning
and uses the rectangle; data-width overrides both. It writes a hinged placement. Its model is data-model or the label model:<id>, the same
as a prop. A door with no model id fails. The door file has no obstacle. Model-scoped
openings (a scene door bound to a model, and doors-external in a floors file)
write <model>.cut.glb next to the source in --models. The cut removes those
door gaps from the textured mesh. The source <model>.glb is not modified.
Point the asset uri at the cut file; a later bake refreshes it. A
placement-scoped door stays out of that mesh. An opening that did not land
on every placement is left out too, so one static mesh is not given a hole
only one copy has.
A props rectangle places the model. Its obstacle is the GLB bounds after
that position, yaw, and scale, or the rectangle when the GLB is missing.
The pawn radius is not added.
Each placement type is copied from that asset in the game file. It is not an
Inkscape label. An asset with no type omits the field. With no --game, a
web/game/arena.game.json in the working directory is used when it exists.
A second bake writes the same type. The game file itself is not written.
--floors is the directory of <model>.floors.svg. A building whose model has
that file gets the file's external doors, stairs, and room instances.
--rooms is the directory of <prefab>.room.json, required when a floors file
has a room. With at least one room, bake also writes rooms.placements.json
and rooms.lights.json beside --out. Without --floors those files are not written.

prop --shape door reads a door-design layer. Part ids are data-part-frame,
data-part-door, data-part-hinge, and data-part-texture. The texture image is
the full face. The frame is four boxes around the door, each mapped to the
strip of that image it covers. The door front and back use only the door
rectangle. The frame node does not swing. The door origin is the hinge edge.
There is no skin, no clip, and no obstacle.

prop --shape crate reads rectangles on a crate-design layer. One unlabeled
texture covers all six faces. Its width and height are the front, in meters,
and the depth is that width unless data-depth is set. Labeled faces are
front, back, left, right, top, and bottom. A missing opposite uses the given
side. Width and height are read after rotate() or matrix(). The front face
is the box width and height. A side face's width matches that height, and
its height is the depth. The top matches the front width and that depth.
Faces that disagree on a shared edge fail the file.
The GLB is one mesh of 24 vertices. Its origin is the center of the bottom
face. Each face uses its own PNG or JPEG texture. The same stem gets .collision.json
with one AABB of that size. There is no skin and no collision in the GLB.

room reads one room SVG. The file name is the room id. Layers are floor,
walls, ceiling, doors, windows, openings, holes, props, and lights. A
leading number and underscore on a layer name is ignored. The floor is the
footprint. Wall faces are front, back, left, and right. A missing opposite
reuses the given side, and a missing ceiling reuses the floor. The origin
is the center of the floor, y = 0 is the floor, front is +Z, and right is
+X. The command prints the size and the counts. It writes one GLB at --out
with the floor, the ceiling and the four inside walls. It also writes
<id>.room.json next to --out. The .room.json also lists the room's props and lights, which are not in the GLB. --glb copies a Blender GLB to --out.
Face textures are
PNG or JPEG. Doors, windows,
openings and holes are cut out of the faces. A window gets a pane
unless data-glass="false".

floors reads layers floor-<n>, doors-external, stairs-external, and ignore, then prints the model, floor elevations, and the room, door, and stair counts without writing a file.`;

export function main(argv: string[]): number {
  try {
    if (argv.length === 0) {
      console.log(USAGE);
      return 2;
    }
    if (argv.some((arg) => arg === "-h" || arg === "--help")) {
      console.log(USAGE);
      return 0;
    }
    const command = argv[0];
    if (command === "measure") {
      runMeasure(argv.slice(1));
      return 0;
    }
    if (command === "bake") {
      runBake(argv.slice(1));
      return 0;
    }
    if (command === "prop") {
      runProp(argv.slice(1));
      return 0;
    }
    if (command === "room") {
      runRoom(argv.slice(1));
      return 0;
    }
    if (command === "floors") {
      runFloors(argv.slice(1));
      return 0;
    }
    throw new PlanError(`unknown command "${command}"\n${USAGE}`);
  } catch (err) {
    if (err instanceof PlanError) console.error(err.message);
    else if (err instanceof Error) console.error(err.stack ?? err.message);
    else console.error(String(err));
    return 1;
  }
}

function runMeasure(argv: string[]): void {
  const flags = parseFlags(argv, new Set(["glb", "out", "svg"]));
  if (!flags.glb) throw new PlanError(`missing --glb\n${USAGE}`);
  if (!flags.out) throw new PlanError(`missing --out\n${USAGE}`);
  if (!flags.svg) throw new PlanError(`missing --svg\n${USAGE}`);
  const measured = measure({ glbPath: flags.glb, outPath: flags.out, svgPath: flags.svg });
  console.log(`${flags.glb}: ${measured.vertexCount} vertices, ${measured.runCount} runs`);
  console.log(`wrote ${flags.out}`);
  console.log(`wrote ${flags.svg}`);
}

function runBake(argv: string[]): void {
  const flags = parseFlags(argv, new Set(["svg", "models", "out", "mesh-prefix", "collision-dir", "game", "floors", "rooms"]));
  if (!flags.svg) throw new PlanError(`missing --svg\n${USAGE}`);
  if (!flags.out) throw new PlanError(`missing --out\n${USAGE}`);
  const result = bake({
    svgPath: flags.svg,
    outPath: flags.out,
    modelsDir: flags.models,
    meshPrefix: flags["mesh-prefix"],
    collisionDir: flags["collision-dir"],
    gamePath: flags.game ?? defaultGamePath(),
    floorsDir: flags.floors,
    roomsDir: flags.rooms,
  });
  for (const line of result.lines) console.log(line);
}

/** Arena checkouts keep the asset catalog here. Other working directories omit type. */
function defaultGamePath(): string | undefined {
  const candidate = path.join("web", "game", "arena.game.json");
  return existsSync(candidate) ? candidate : undefined;
}

function runProp(argv: string[]): void {
  const flags = parseFlags(argv, new Set(["shape", "out", "svg"]));
  if (!flags.shape) throw new PlanError(`missing --shape\n${USAGE}`);
  if (!flags.out) throw new PlanError(`missing --out\n${USAGE}`);
  if (!flags.svg) throw new PlanError(`missing --svg\n${USAGE}`);
  if (flags.shape === "door") {
    writeDoorProp({ svgPath: flags.svg, outPath: flags.out });
    console.log(`wrote ${flags.out}`);
    return;
  }
  if (flags.shape === "crate") {
    const written = writeCrateProp({ svgPath: flags.svg, outPath: flags.out });
    console.log(`wrote ${written.glbPath}`);
    console.log(`wrote ${written.collisionPath}`);
    return;
  }
  throw new PlanError(`unknown prop shape "${flags.shape}"`);
}

function runRoom(argv: string[]): void {
  const flags = parseFlags(argv, new Set(["svg", "out", "glb"]));
  if (!flags.svg) throw new PlanError(`missing --svg\n${USAGE}`);
  if (!flags.out) throw new PlanError(`missing --out\n${USAGE}`);
  const written = writeRoom({ svgPath: flags.svg, outPath: flags.out, glbPath: flags.glb });
  const room = written.room;
  for (const warning of written.warnings) console.log(warning);
  const counts = [
    `${room.doors.length} doors`,
    `${room.windows.length} windows`,
    `${room.openings.length} openings`,
    `${room.holes.length} holes`,
    `${room.props.length} props`,
    `${room.lights.length} lights`,
  ].join(", ");
  console.log(`room ${room.id}: ${formatMetres(room.width)}\u00d7${formatMetres(room.depth)}\u00d7${formatMetres(room.height)} m, ${counts}`);
  console.log(`wrote ${flags.out}`);
  console.log(`wrote ${path.join(path.dirname(flags.out), `${room.id}.room.json`)}`);
}

function runFloors(argv: string[]): void {
  const flags = parseFlags(argv, new Set(["svg"]));
  if (!flags.svg) throw new PlanError(`missing --svg\n${USAGE}`);
  const source = readFloorsSvg(readFileSync(flags.svg, "utf8"));
  const elevations = source.floors.map((floor) => formatMetres(floor.elevation)).join(", ");
  const rooms = source.floors.reduce((count, floor) => count + floor.rooms.length, 0);
  console.log(
    `floors ${source.model}: ${source.floors.length} floors (z ${elevations}), ${rooms} rooms, ${source.doors.length} doors, ${source.props.length} stairs props`,
  );
}

function formatMetres(n: number): string {
  const rounded = Math.round(n * 1000) / 1000;
  if (Object.is(rounded, -0)) return "0";
  return String(rounded);
}

function parseFlags(argv: string[], known: Set<string>): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--")) throw new PlanError(`unexpected argument "${token}"`);
    const body = token.slice(2);
    const eq = body.indexOf("=");
    let key: string;
    let value: string | undefined;
    if (eq >= 0) {
      key = body.slice(0, eq);
      value = body.slice(eq + 1);
    } else {
      key = body;
      value = argv[i + 1];
      if (value == null || value.startsWith("--")) throw new PlanError(`missing value for --${key}`);
      i += 1;
    }
    if (!known.has(key)) throw new PlanError(`unknown option --${key}`);
    if (flags[key] != null) throw new PlanError(`duplicate option --${key}`);
    flags[key] = value;
  }
  return flags;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  process.exit(main(process.argv.slice(2)));
}
