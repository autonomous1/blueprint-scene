import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bake } from "../src/bake.ts";
import { PlanError } from "../src/errors.ts";
import { measure } from "../src/measure.ts";
import type { PlacementsFile } from "../src/types.ts";
import { attr, localName, parseXml } from "../src/xml.ts";
import { trianglesFromBox } from "./boxes.ts";
import { writeGlb } from "./glb-writer.ts";

const ns = `xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"`;

test("a 1 m box stencil placed at 8 mm with a 2× scale bakes a 16 m box", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-measure-"));
  try {
    const models = path.join(dir, "models");
    mkdirSync(models);
    const glb = path.join(models, "box.glb");
    writeFileSync(glb, writeGlb(
      [{ name: "box", triangles: trianglesFromBox([-0.5, 0, -0.5], [0.5, 1, 0.5]) }],
      [{ name: "box", mesh: "box" }],
    ));
    const jsonPath = path.join(dir, "buildings", "box.json");
    const stencilPath = path.join(dir, "buildings", "box.svg");
    const measured = measure({ glbPath: glb, outPath: jsonPath, svgPath: stencilPath });
    assert.deepEqual(measured.file.bounds, { min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] });
    assert.equal(measured.file.footprint.length, 1);
    assert.equal(measured.file.footprint[0]?.minX, -0.5);
    assert.equal(measured.file.footprint[0]?.maxX, 0.5);
    const stencil = parseXml(readFileSync(stencilPath, "utf8"));
    const group = stencil.children.find((child) => localName(child.name) === "g");
    assert.equal(attr(group ?? stencil, "data-model"), "box");
    const rect = group?.children.find((child) => localName(child.name) === "rect");
    assert.equal(attr(rect ?? stencil, "width"), "1");
    assert.equal(attr(rect ?? stencil, "height"), "1");

    const plan = path.join(dir, "plan.svg");
    writeFileSync(plan, `<?xml version="1.0"?><svg ${ns} width="100mm" height="100mm" viewBox="0 0 100 100">
      <g inkscape:groupmode="layer" inkscape:label="bounds"><rect id="room" x="0" y="0" width="1" height="1"/></g>
      <g inkscape:groupmode="layer" inkscape:label="buildings">
        <g id="placed" data-model="box" transform="scale(2)">
          <rect x="0" y="0" width="8" height="8"/>
        </g>
      </g>
    </svg>`);
    const baked = bake({
      svgPath: plan,
      modelsDir: models,
      outPath: path.join(dir, "arena.placements.json"),
      collisionDir: path.join(dir, "collision"),
    });
    const written = JSON.parse(readFileSync(path.join(dir, "arena.placements.json"), "utf8")) as PlacementsFile;
    assert.deepEqual(written, baked.file);
    assert.equal(baked.file.placements.length, 1);
    const placement = baked.file.placements[0]!;
    assert.equal(placement.scale, 16);
    assert.deepEqual(placement.position, [8, 0, 92]);
    assert.equal(baked.file.obstacles.length, 1);
    const box = baked.file.obstacles[0]!;
    assert.equal(box.max[0] - box.min[0], 16);
    assert.equal(box.max[2] - box.min[2], 16);
    assert.equal((box.min[0] + box.max[0]) / 2, placement.position[0]);
    assert.equal((box.min[2] + box.max[2]) / 2, placement.position[2]);

    const copy = path.join(dir, "copy.svg");
    writeFileSync(copy, `<?xml version="1.0"?><svg ${ns} width="20mm" height="20mm" viewBox="0 0 20 20">
      <g inkscape:groupmode="layer" inkscape:label="bounds"><rect id="room" x="0" y="0" width="1" height="1"/></g>
      <g inkscape:groupmode="layer" inkscape:label="buildings">
        <g id="copy" data-model="box" transform="translate(8 4) scale(2)">
          <rect x="-0.5" y="-0.5" width="1" height="1"/>
        </g>
      </g>
    </svg>`);
    const doubled = bake({
      svgPath: copy,
      modelsDir: models,
      outPath: path.join(dir, "copy.json"),
      collisionDir: path.join(dir, "copy-buildings"),
    });
    assert.equal(doubled.file.placements[0]?.scale, 2);
    assert.equal(doubled.file.obstacles[0]!.max[0]! - doubled.file.obstacles[0]!.min[0]!, 2);

    const stretched = path.join(dir, "stretched.svg");
    writeFileSync(stretched, `<?xml version="1.0"?><svg ${ns} width="20mm" height="20mm" viewBox="0 0 20 20">
      <g inkscape:groupmode="layer" inkscape:label="bounds"><rect id="room" x="0" y="0" width="1" height="1"/></g>
      <g inkscape:groupmode="layer" inkscape:label="buildings">
        <rect id="bad" data-model="box" x="0" y="0" width="8" height="4"/>
      </g>
    </svg>`);
    assert.throws(
      () => bake({
        svgPath: stretched,
        modelsDir: models,
        outPath: path.join(dir, "stretched.json"),
        collisionDir: path.join(dir, "stretched-buildings"),
      }),
      (err: unknown) => err instanceof PlanError && /not uniform/.test(err.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli help states the drawing scale once", () => {
  const bin = path.join(import.meta.dirname, "..", "bin", "blueprint-scene");
  const help = spawnSync(bin, ["--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.deepEqual(help.stdout.match(/1 mm = 1 m/g), ["1 mm = 1 m"]);
});
