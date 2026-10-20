import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readAssetFiles } from "../src/asset-type.ts";
import { bake } from "../src/bake.ts";
import { writeDoorProp } from "../src/prop.ts";
import { trianglesFromBox } from "./boxes.ts";
import { writeGlb } from "./glb-writer.ts";

const ns = `xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"`;
const PLAN = `<?xml version="1.0"?><svg ${ns} width="20mm" height="20mm" viewBox="0 0 20 20">
  <g inkscape:groupmode="layer" inkscape:label="bounds"><rect id="room" x="0" y="0" width="20" height="20"/></g>
  <g inkscape:groupmode="layer" inkscape:label="buildings"><rect id="hall" data-model="m" x="5" y="9.5" width="10" height="1"/></g>
  <g inkscape:groupmode="layer" inkscape:label="doors">
    <rect id="front" data-building="hall" inkscape:label="model:door-1" x="8" y="9.5" width="2" height="1"/>
  </g>
</svg>`;
const WALLS = { m: trianglesFromBox([-5, 0, -0.5], [5, 3, 0.5]) };
const DESIGN = path.join(import.meta.dirname, "fixtures", "door", "door-design.svg");

/** The arena layout: models in web/assets/models, door-1 declared with uri door1.glb. */
function arenaTree(): { dir: string; models: string; game: string; svg: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-door-file-"));
  const models = path.join(dir, "web", "assets", "models");
  mkdirSync(models, { recursive: true });
  const game = path.join(dir, "arena.game.json");
  writeFileSync(game, JSON.stringify({
    assets: [{ id: "door-1", kind: "model", type: "door", uri: "/assets/models/door1.glb" }],
  }));
  const svg = path.join(dir, "plan.svg");
  writeFileSync(svg, PLAN);
  return { dir, models, game, svg };
}

function run(tree: ReturnType<typeof arenaTree>, gamePath?: string) {
  return bake({
    svgPath: tree.svg,
    outPath: path.join(tree.dir, "out", "buildings.placements.json"),
    collisionDir: path.join(tree.dir, "collision"),
    modelsDir: tree.models,
    walls: WALLS,
    ...(gamePath ? { gamePath } : {}),
  });
}

test("readAssetFiles maps an asset id to its uri file name", () => {
  const files = readAssetFiles(JSON.stringify({
    assets: { "door-2": { uri: "/assets/models/door2.glb" }, sky: { kind: "texture" } },
  }), "game.json");
  assert.equal(files.get("door-2"), "door2.glb");
  assert.equal(files.has("sky"), false);
});

test("--game resolves door-1 to the declared door1.glb, so the opening is the panel width", () => {
  const tree = arenaTree();
  try {
    writeDoorProp({ svgPath: DESIGN, outPath: path.join(tree.models, "door1.glb") });
    const result = run(tree, tree.game);
    const width = result.doors.placements[0]!.size[0];
    assert.ok(width > 0 && width < 1.9, `panel width ${width}, not the 2 m rectangle`);
    assert.ok(result.lines.some((line) => /door model "door-1": panel .* from .*door1\.glb/.test(line)));
    assert.equal(result.lines.some((line) => line.startsWith("warning:")), false);
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});

test("a door GLB that is not found warns with the models dir and the names tried", () => {
  const tree = arenaTree();
  try {
    writeDoorProp({ svgPath: DESIGN, outPath: path.join(tree.models, "door1.glb") });
    const result = run(tree);
    assert.equal(result.doors.placements[0]!.size[0], 2);
    const warning = result.lines.find((line) => line.startsWith("warning:"));
    assert.ok(warning, "no warning");
    assert.match(warning, /door model "door-1": no GLB in /);
    assert.ok(warning.includes(path.resolve(tree.models)), warning);
    assert.match(warning, /tried door-1\.glb/);
    assert.match(warning, /--game/);
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});

test("a GLB with no mesh named door uses a panel/leaf mesh, and one with only a frame warns", () => {
  const tree = arenaTree();
  try {
    const leaf = trianglesFromBox([0, -1, 0], [0.9, 1, 0.08]);
    const frame = trianglesFromBox([-0.2, -1.1, 0], [1.1, 1.2, 0.12]);
    writeFileSync(path.join(tree.models, "door-1.glb"), writeGlb(
      [{ name: "Frame", triangles: frame }, { name: "DoorLeaf", triangles: leaf }],
      [{ name: "Frame", mesh: "Frame" }, { name: "DoorLeaf", mesh: "DoorLeaf" }],
    ));
    const named = run(tree);
    assert.ok(Math.abs(named.doors.placements[0]!.size[0] - 0.9) < 1e-6);
    assert.ok(named.lines.some((line) => /meshes DoorLeaf; no mesh named "door"/.test(line)));

    writeFileSync(path.join(tree.models, "door-1.glb"), writeGlb(
      [{ name: "frame-left", triangles: frame }],
      [{ name: "frame-left", mesh: "frame-left" }],
    ));
    const bare = run(tree);
    assert.equal(bare.doors.placements[0]!.size[0], 2);
    assert.ok(bare.lines.some((line) => /warning: door model "door-1": .*door-1\.glb has no panel mesh/.test(line)));
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});
