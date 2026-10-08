import { pathToFileURL } from "node:url";
import { bake } from "./bake.ts";
import { PlanError } from "./errors.ts";
import { measure } from "./measure.ts";
import { writeCrateProp } from "./crate.ts";
import { writeDoorProp } from "./prop.ts";

const USAGE = `blueprint-scene measure --glb model.glb --out buildings/<id>.json --svg buildings/<id>.svg
blueprint-scene bake --svg plan.svg --models ./models --out web/game/buildings.placements.json
        [--mesh-prefix wall_]
blueprint-scene prop --shape door --svg door.svg --out props/door.glb
blueprint-scene prop --shape crate --svg crate.svg --out props/cover-crate.glb

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
directory. Building scale is the SVG size relative to the measured stencil.
Building obstacles are a 0.5 m XZ grid. Cells the mesh covers from y = 0 to 2 m merge into wall runs before short ones are dropped. A box under 1 m on its long side, or under 0.5 m³, is dropped. A facade longer than 1 m stays even when the mesh is about a centimetre thick. At most 32 boxes. A doors rectangle
with data-building="<placement id>" stamps a gap in that building and writes
a hinged placement. Its model is data-model or the label model:<id>, the same
as a prop. A door with no model id fails. The door file has no obstacle.
A props rectangle places the model. Its obstacle is the GLB bounds after
that position, yaw, and scale, or the rectangle when the GLB is missing.
The pawn radius is not added.

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
side. The front rectangle is the width and height. The depth is the left or
right rectangle's width. Faces that disagree on a shared edge fail the file.
The GLB is one mesh of 24 vertices. Its origin is the center of the bottom
face. Each face uses its own texture. The same stem gets .collision.json
with one AABB of that size. There is no skin and no collision in the GLB.`;

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
  const flags = parseFlags(argv, new Set(["svg", "models", "out", "mesh-prefix", "collision-dir"]));
  if (!flags.svg) throw new PlanError(`missing --svg\n${USAGE}`);
  if (!flags.out) throw new PlanError(`missing --out\n${USAGE}`);
  const result = bake({
    svgPath: flags.svg,
    outPath: flags.out,
    modelsDir: flags.models,
    meshPrefix: flags["mesh-prefix"],
    collisionDir: flags["collision-dir"],
  });
  for (const line of result.lines) console.log(line);
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
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exit(main(process.argv.slice(2)));
}
