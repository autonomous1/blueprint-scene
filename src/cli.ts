import { pathToFileURL } from "node:url";
import { bake } from "./bake.ts";
import { PlanError } from "./errors.ts";
import { measure } from "./measure.ts";

const USAGE = `blueprint-scene measure --glb model.glb --out buildings/<id>.json --svg buildings/<id>.svg
blueprint-scene bake --svg plan.svg --models ./models --out web/game/buildings.placements.json
        [--mesh-prefix wall_]

Inkscape drawing scale is 1 mm = 1 m. A rectangle 8 mm wide is an 8 m facade.
The toolbar is the room: x → x and toolbar y → z. Yaw is snapped to 0, 90, 180, or 270.

measure writes raw model bounds in meters and an SVG footprint group tagged
data-model="<id>". Copy that group into a plan, then move and scale it.
Scale must be uniform. A 2× enlarge is scale 2. Non-uniform scale fails the file.

bake reads the buildings, bounds, props, and spawn-points layers. It writes
four files and does not write arena.game.json or a scene object. --out is the
buildings placements file. bounds.json, props.placements.json, and
spawn-points.json are written in that same directory. Building scale is the
SVG size relative to the measured stencil. Building obstacles are a 0.5 m XZ
grid, at most 32 boxes. Doorway gaps stay gaps.`;

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
  measure({ glbPath: flags.glb, outPath: flags.out, svgPath: flags.svg });
  console.log(`wrote ${flags.out}`);
  console.log(`wrote ${flags.svg}`);
}

function runBake(argv: string[]): void {
  const flags = parseFlags(argv, new Set(["svg", "models", "out", "mesh-prefix"]));
  if (!flags.svg) throw new PlanError(`missing --svg\n${USAGE}`);
  if (!flags.out) throw new PlanError(`missing --out\n${USAGE}`);
  const result = bake({
    svgPath: flags.svg,
    outPath: flags.out,
    modelsDir: flags.models,
    meshPrefix: flags["mesh-prefix"],
  });
  for (const line of result.lines) console.log(line);
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
