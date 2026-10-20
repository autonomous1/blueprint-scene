import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bake } from "../src/bake.ts";
import { measure } from "../src/measure.ts";
import { readScene } from "../src/plan.ts";
import type { Triangle } from "../src/types.ts";
import { trianglesFromBox } from "./boxes.ts";
import { writeGlb } from "./glb-writer.ts";

const ns = `xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"`;
const page = (buildings: string) => `<?xml version="1.0"?><svg ${ns} width="100mm" height="100mm" viewBox="0 0 100 100">
  <g inkscape:groupmode="layer" inkscape:label="bounds"><rect id="room" x="0" y="0" width="100" height="100"/></g>
  <g inkscape:groupmode="layer" inkscape:label="buildings">${buildings}</g>
</svg>`;

function near(actual: number, expected: number, label: string, tol = 1e-6): void {
  assert.ok(Math.abs(actual - expected) < tol, `${label}: ${actual} ≠ ${expected}`);
}

/** An L in model units: a long wall x −0.4..0.4, z 0..0.1, and a wing at its +X end, x 0.2..0.4, z 0.1..0.5. */
const L_SPANS: Array<[[number, number, number], [number, number, number]]> = [
  [[-0.4, 0, 0], [0.4, 0.3, 0.1]],
  [[0.2, 0, 0.1], [0.4, 0.3, 0.5]],
];

function writeL(dir: string): { models: string; group: (transform: string, id?: string) => string } {
  const models = path.join(dir, "models");
  mkdirSync(models, { recursive: true });
  const triangles: Triangle[] = L_SPANS.flatMap(([min, max]) => trianglesFromBox(min, max));
  const glb = path.join(models, "ell.glb");
  writeFileSync(glb, writeGlb([{ name: "ell", triangles }], [{ name: "ell", mesh: "ell" }]));
  const measured = measure({ glbPath: glb, outPath: path.join(dir, "ell.json"), svgPath: path.join(dir, "ell.svg") });
  const body = measured.svg.slice(measured.svg.indexOf("<g "), measured.svg.indexOf("</g>") + 4);
  return {
    models,
    group: (transform, id = "ell") => body.replace(/<g id="ell"/, `<g id="${id}" transform="${transform}"`),
  };
}

test("a copied stencil group is placed by its origin and its transform scale", () => {
  const scene = readScene(page(`
    <g id="s" data-model="ell" transform="matrix(30 0 0 30 10 90)"><path d="M 0 0 L 1 0 L 1 -1 Z"/></g>
    <g id="r" data-model="ell" transform="scale(2)"><rect x="0" y="0" width="1" height="1"/></g>
  `));
  const [s, r] = scene.placements;
  assert.deepEqual(s?.stencil?.origin, [10, 0, 10]);
  near(s!.stencil!.scale, 30, "scale");
  assert.equal(r?.stencil, undefined, "a group of rectangles is not a stencil");
});

for (const [yaw, transform] of [
  [0, "matrix(30 0 0 30 50 50)"],
  [90, "matrix(0 30 -30 0 50 50)"],
  [180, "matrix(-30 0 0 -30 50 50)"],
  [270, "matrix(0 -30 30 0 50 50)"],
] as const) {
  test(`yaw ${yaw}: an asymmetric stencil at ×30 bakes scale 30, origin at the group origin, walls on the drawn path`, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-pose-"));
    try {
      const ell = writeL(dir);
      const plan = path.join(dir, "plan.svg");
      writeFileSync(plan, page(ell.group(transform)));
      const baked = bake({
        svgPath: plan,
        modelsDir: ell.models,
        outPath: path.join(dir, "out", "buildings.placements.json"),
        collisionDir: path.join(dir, "collision"),
      });
      const placed = baked.file.placements[0]!;
      assert.equal(placed.yaw, yaw);
      near(placed.scale, 30, "scale");
      // Group origin: page (50, 50) → world (50, 0, 50) on this 100 mm page.
      assert.deepEqual(placed.position, [50, 0, 50]);
      // The wing is model x 0.2..0.4, z 0.1..0.5. Scaled and turned, the baked wing box
      // (deep on the axis the wing runs along) sits on the same world span as the drawn one.
      const wing = { x0: 0.2 * 30, x1: 0.4 * 30, z0: 0.1 * 30, z1: 0.5 * 30 };
      const turn = (x: number, z: number): [number, number] => {
        switch (yaw) {
          case 0: return [x, z];
          case 90: return [z, -x];
          case 180: return [-x, -z];
          default: return [-z, x];
        }
      };
      const a = turn(wing.x0, wing.z0);
      const b = turn(wing.x1, wing.z1);
      const want = { minX: 50 + Math.min(a[0], b[0]), maxX: 50 + Math.max(a[0], b[0]), minZ: 50 + Math.min(a[1], b[1]), maxZ: 50 + Math.max(a[1], b[1]) };
      const centerX = (want.minX + want.maxX) / 2;
      const centerZ = (want.minZ + want.maxZ) / 2;
      const hit = baked.file.obstacles.some((box) => centerX > box.min[0] && centerX < box.max[0] && centerZ > box.min[2] && centerZ < box.max[2]);
      assert.ok(hit, `no wall at the drawn wing center (${centerX}, ${centerZ})`);
      // Nothing is baked on the mirrored side, where an origin at the drawn center or a flipped X would put it.
      const mirrorX = 2 * 50 - centerX;
      const mirrorZ = 2 * 50 - centerZ;
      const ghost = baked.file.obstacles.some((box) => mirrorX > box.min[0] && mirrorX < box.max[0] && mirrorZ > box.min[2] && mirrorZ < box.max[2]);
      assert.equal(ghost, false, "wall on the mirrored side");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a drawn rectangle is centered on the stencil extent, not on the origin, at every yaw", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-rect-"));
  try {
    // A 2 m block whose origin is its corner: x 0..2, z 0..2, center (1, 1).
    const walls = { m: trianglesFromBox([0, 0, 0], [2, 3, 2]) };
    const plan = path.join(dir, "plan.svg");
    writeFileSync(plan, page(`
      <rect id="y0" data-model="m" x="10" y="80" width="2" height="2"/>
      <rect id="y90" data-model="m" x="30" y="80" width="2" height="2" transform="rotate(90 31 81)"/>
      <rect id="y180" data-model="m" x="50" y="80" width="2" height="2" transform="rotate(180 51 81)"/>
      <rect id="y270" data-model="m" x="70" y="80" width="2" height="2" data-yaw="270"/>
    `));
    const baked = bake({ svgPath: plan, outPath: path.join(dir, "out", "b.json"), collisionDir: path.join(dir, "c"), walls });
    for (const [id, x0] of [["y0", 10], ["y90", 30], ["y180", 50], ["y270", 70]] as const) {
      const placed = baked.file.placements.find((p) => p.id === id)!;
      near(placed.scale, 1, `${id} scale`);
      const box = baked.file.obstacles.find((o) => o.id === `${id}-wall-0`)!;
      // Drawn: x x0..x0+2, toolbar z 18..20.
      near(box.min[0], x0, `${id} minX`);
      near(box.max[0], x0 + 2, `${id} maxX`);
      near(box.min[2], 18, `${id} minZ`);
      near(box.max[2], 20, `${id} maxZ`);
    }
    assert.equal(baked.lines.some((line) => line.startsWith("warning:")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rectangle out of the model's proportions warns and uses the average scale", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-warn-"));
  try {
    const walls = { m: trianglesFromBox([-1, 0, -1], [1, 3, 1]) };
    const plan = path.join(dir, "plan.svg");
    writeFileSync(plan, page(`<rect id="wide" data-model="m" x="10" y="10" width="4" height="2"/>`));
    const baked = bake({ svgPath: plan, outPath: path.join(dir, "out", "b.json"), collisionDir: path.join(dir, "c"), walls });
    near(baked.file.placements[0]!.scale, 1.5, "average");
    assert.ok(baked.lines.some((line) => /warning: placement "wide" drawn size is not the model's proportions/.test(line)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stencil group with a non-uniform transform still fails", () => {
  assert.throws(
    () => readScene(page(`<g id="s" data-model="ell" transform="matrix(30 0 0 20 10 90)"><path d="M 0 0 L 1 0 L 1 -1 Z"/></g>`)),
    /not uniform/,
  );
});
