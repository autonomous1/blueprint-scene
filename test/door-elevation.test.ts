import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bake } from "../src/bake.ts";
import { cutDoorFromBoxes, situateDoor } from "../src/doors.ts";
import { readScene } from "../src/plan.ts";
import type { LocalBox, SceneDoor, Vec3 } from "../src/types.ts";
import { trianglesFromBox } from "./boxes.ts";

const NS = `xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"`;

/** A 10 m hall, wall 1 m thick and 0..8 m tall; doors are drawn over its south face. */
function plan(doors: string, props = ""): string {
  return `<?xml version="1.0"?><svg ${NS} width="20mm" height="20mm" viewBox="0 0 20 20">
    <g inkscape:groupmode="layer" inkscape:label="bounds"><rect id="room" x="0" y="0" width="20" height="20"/></g>
    <g inkscape:groupmode="layer" inkscape:label="buildings">
      <rect id="hall" data-model="m" x="5" y="9.5" width="10" height="1"/>
    </g>
    <g inkscape:groupmode="layer" inkscape:label="props">${props}</g>
    <g inkscape:groupmode="layer" inkscape:label="doors">${doors}</g>
  </svg>`;
}

function bakeIn(svgText: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-door-z-"));
  try {
    const svg = path.join(dir, "plan.svg");
    writeFileSync(svg, svgText);
    return bake({
      svgPath: svg,
      outPath: path.join(dir, "buildings.placements.json"),
      collisionDir: path.join(dir, "buildings"),
      walls: { m: trianglesFromBox([-5, 0, -0.5], [5, 8, 0.5]) },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type Box = { min: Vec3; max: Vec3 };
function solidAt(boxes: readonly Box[], x: number, y: number, z: number): boolean {
  return boxes.some((b) => x > b.min[0] && x < b.max[0] && y > b.min[1] && y < b.max[1] && z > b.min[2] && z < b.max[2]);
}

const DOOR = (id: string, x: number, extra = "") =>
  `<rect id="${id}" data-building="hall" inkscape:label="model:door-1" x="${x}" y="9.5" width="2" height="1" ${extra}/>`;

test("a door with z is placed at y = z; z absent or 0 stays on the ground", () => {
  const result = bakeIn(plan(DOOR("high", 6, `z="2.75"`) + DOOR("zero", 9, `z="0"`) + DOOR("plain", 12)));
  const at = (id: string) => result.doors.placements.find((d) => d.id === id)!;
  assert.equal(at("high").position[1], 2.75);
  assert.equal(at("zero").position[1], 0);
  assert.equal(at("plain").position[1], 0);
  assert.deepEqual(at("high").size, at("plain").size, "z does not change the size");
  assert.equal(at("high").position[0], at("plain").position[0] - 6, "z does not move the door in XZ");
  assert.equal(at("high").position[2], at("plain").position[2]);
});

test("an elevated door opens y z..z+height, with wall below the sill and a lintel above", () => {
  const result = bakeIn(plan(DOOR("high", 6, `z="2.75"`) + DOOR("plain", 12)));
  const boxes = result.file.obstacles;
  const high = result.doors.placements.find((d) => d.id === "high")!;
  const plain = result.doors.placements.find((d) => d.id === "plain")!;
  const h = high.size[1];
  const mid = (d: typeof high) => d.position[0] + d.size[0] / 2;
  const z = 10; // inside the 1 m wall
  // Elevated door.
  assert.equal(solidAt(boxes, mid(high), 1, z), true, "solid below the sill");
  assert.equal(solidAt(boxes, mid(high), 2.7, z), true, "solid just under the sill");
  assert.equal(solidAt(boxes, mid(high), 2.8, z), false, "open just over the sill");
  assert.equal(solidAt(boxes, mid(high), 2.75 + h - 0.05, z), false, "open just under the head");
  assert.equal(solidAt(boxes, mid(high), 2.75 + h + 0.05, z), true, "lintel above");
  const sill = boxes.find((b) => b.min[0] < mid(high) && b.max[0] > mid(high) && b.max[1] > 0 && b.max[1] <= 2.75 + 1e-9 && b.min[2] < z && b.max[2] > z);
  assert.ok(sill && Math.abs(sill.max[1] - 2.75) < 1e-9, "the sill box tops out at z");
  // Ground door, unchanged.
  assert.equal(solidAt(boxes, mid(plain), 0.05, z), false, "ground door open at the floor");
  assert.equal(solidAt(boxes, mid(plain), h - 0.05, z), false);
  assert.equal(solidAt(boxes, mid(plain), h + 0.05, z), true, "ground door lintel");
});

test("door z is read like a prop z: the element's own attribute in meters, not inherited from a <g>", () => {
  const svg = plan(
    `<g z="3">${DOOR("grouped", 6)}</g>` + DOOR("own", 12, `z="1.5"`),
    `<g z="3"><rect id="crate-g" inkscape:label="model:crate" x="2" y="2" width="1" height="1"/></g>`
      + `<rect id="crate-own" inkscape:label="model:crate" x="4" y="2" width="1" height="1" z="1.5"/>`,
  );
  const scene = readScene(svg);
  const door = (id: string) => scene.doors.find((d) => d.id === id)!;
  const prop = (id: string) => scene.props.find((p) => p.id === id)!;
  assert.equal(door("grouped").center[1], prop("crate-g").position[1], "a group z is ignored for both");
  assert.equal(door("grouped").center[1], 0);
  assert.equal(door("own").center[1], prop("crate-own").position[1], "same units as a prop");
  assert.equal(door("own").center[1], 1.5);
  assert.throws(() => readScene(plan(DOOR("bad", 6, `z="high"`))), /door "bad" z "high" is not a number/);
});

test("the wall face is chosen among boxes that stand at the door's height", () => {
  // A low plinth (y 0..2) sticks out in front of the wall; the wall (y 0..6) is behind it.
  const plinth: Box = { min: [-5, 0, 0], max: [5, 2, 1] };
  const wall: Box = { min: [-5, 0, -1], max: [5, 6, 0] };
  const door = (y: number): SceneDoor => ({
    id: `d${y}`, model: "door-1", building: "b", hinge: "left", open: false,
    center: [0, y, 1.1], minX: -0.5, maxX: 0.5, minZ: 1, maxZ: 1.2,
  });
  const high = situateDoor(door(3), [plinth, wall], 1);
  assert.equal(high.placement.position[2], 0, "elevated door sits on the wall face above the plinth");
  assert.equal(high.placement.position[1], 3);
  const local: LocalBox[] = [{ minX: -5, maxX: 5, minY: 0, maxY: 6, minZ: -1, maxZ: 0 }];
  const cut = cutDoorFromBoxes(local, high, [0, 0, 0], 0);
  const spans = cut.filter((b) => b.minX < 0 && b.maxX > 0).map((b) => [b.minY, b.maxY]).sort((a, b) => a[0]! - b[0]!);
  assert.deepEqual(spans, [[0, 3], [3 + high.placement.size[1], 6]], "sill box under, lintel over");
});
