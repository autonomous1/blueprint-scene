import assert from "node:assert/strict";
import test from "node:test";
import { cutDoorFromBoxes, situateDoor, type SituatedDoor } from "../src/doors.ts";
import { PlanError } from "../src/errors.ts";
import type { LocalBox, SceneDoor, Vec3, Yaw } from "../src/types.ts";
import { placeBox } from "../src/yaw.ts";

const ORIGIN: Vec3 = [0, 0, 0];

function box(minX: number, maxX: number, minZ: number, maxZ: number, minY = 0, maxY = 3): LocalBox {
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

/** Left-hinged door at (x, 0, 0) on the +Z face (yaw 0): opening x..x+width, y 0..2.1, z −2..0. */
function doorAt(x: number, width: number, yaw: Yaw = 0, z = 0): SituatedDoor {
  return {
    placement: { id: "d", model: "door-1", position: [x, 0, z], yaw, hinge: "left", size: [width, 2.1, 0.08], open: false },
    opening: { minX: 0, maxX: width, minY: 0, maxY: 2.1, minZ: -2, maxZ: 0 },
  };
}

function inside(boxes: readonly LocalBox[], x: number, y: number, z: number): boolean {
  return boxes.some((b) => x > b.minX && x < b.maxX && y > b.minY && y < b.maxY && z > b.minZ && z < b.maxZ);
}

function volume(boxes: readonly LocalBox[]): number {
  return boxes.reduce((sum, b) => sum + (b.maxX - b.minX) * (b.maxY - b.minY) * (b.maxZ - b.minZ), 0);
}

test("a door straddling the seam of two wall boxes cuts both, the gap is continuous, and the lintel spans both", () => {
  const wall = [box(0, 5, -0.5, 0), box(5, 10, -0.5, 0)];
  const cut = cutDoorFromBoxes(wall, doorAt(4, 2), ORIGIN, 0);
  for (let x = 4.05; x < 6; x += 0.1) {
    for (const y of [0.1, 1, 2.05]) {
      assert.equal(inside(cut, x, y, -0.25), false, `gap closed at x ${x.toFixed(2)} y ${y}`);
    }
    assert.equal(inside(cut, x, 2.5, -0.25), true, `lintel missing at x ${x.toFixed(2)}`);
  }
  assert.equal(inside(cut, 3.9, 1, -0.25), true, "left jamb");
  assert.equal(inside(cut, 6.1, 1, -0.25), true, "right jamb");
  assert.equal(cut.length, 4, "jamb + lintel from each box");
  assert.ok(Math.abs(volume(cut) - (volume(wall) - 2 * 2.1 * 0.5)) < 1e-9, "only the opening is removed");
});

test("a door fully inside one box splits that box and leaves its neighbours unchanged", () => {
  const neighbour = box(10, 20, -0.5, 0);
  const cut = cutDoorFromBoxes([box(0, 10, -0.5, 0), neighbour], doorAt(4, 2), ORIGIN, 0);
  assert.equal(cut.length, 4);
  assert.ok(cut.includes(neighbour), "neighbour is the same object, not re-transformed");
  assert.equal(inside(cut, 5, 1, -0.25), false);
  assert.equal(inside(cut, 5, 2.5, -0.25), true);
});

test("a box that only touches the opening at a shared edge is not cut", () => {
  const touching = box(6, 10, -0.5, 0);
  const cut = cutDoorFromBoxes([box(0, 6, -0.5, 0), touching], doorAt(4, 2), ORIGIN, 0);
  assert.ok(cut.includes(touching));
  assert.equal(cut.length, 3, "two jamb-side pieces would be wrong: the left box keeps its jamb and lintel");
});

test("an interior wall inside the 2 m stamp is not cut, and a proud skin does not seal the doorway", () => {
  const interior = box(0, 10, -1.8, -1.5);
  const skin = box(3, 7, 0, 0.05);
  const column = box(4.5, 5.5, 0.3, 0.6);
  const cut = cutDoorFromBoxes([box(0, 10, -0.5, 0), interior, skin, column], doorAt(4, 2), ORIGIN, 0);
  assert.ok(cut.includes(interior), "interior wall is whole");
  assert.ok(cut.includes(column), "a detached column in front is whole");
  assert.equal(inside(cut, 5, 1, 0.025), false, "skin is cut through");
  assert.equal(inside(cut, 5, 1, -0.25), false);
});

test("a door on a turned building cuts every box it straddles", () => {
  const wall = [box(0, 5, -0.5, 0), box(5, 10, -0.5, 0)];
  const position: Vec3 = [3, 0, -7];
  const yaw: Yaw = 90;
  const world = placeBox(wall[0]!, position, yaw);
  const situated = situateDoor(
    { id: "d", model: "door-1", building: "b", center: [world.max[0] - 0.1, 0, -7 - 5], minX: 0, maxX: 0, minZ: 0, maxZ: 0, hinge: "left", width: 2, open: false },
    wall.map((b) => placeBox(b, position, yaw)),
  );
  const cut = cutDoorFromBoxes(wall, situated, position, yaw);
  assert.equal(cut.length, 4);
  assert.equal(inside(cut, 5, 1, -0.25), false, "seam column is open in model space");
});

test("no wall box under the opening is a plan error", () => {
  assert.throws(() => cutDoorFromBoxes([box(20, 30, -0.5, 0)], doorAt(4, 2), ORIGIN, 0), PlanError);
  assert.throws(() => cutDoorFromBoxes([box(0, 10, -3, -2.5)], doorAt(4, 2), ORIGIN, 0), PlanError);
});

test("a door mark on the seam of two boxes goes on the outside face, not the seam", () => {
  const boxes = [box(0, 5, -0.5, 0), box(5, 10, -0.5, 0)].map((b) => placeBox(b, ORIGIN, 0));
  const door: SceneDoor = {
    id: "d", model: "door-1", building: "b", center: [5.01, 0, -0.05],
    minX: 4, maxX: 6.02, minZ: -0.1, maxZ: 0, hinge: "left", open: false,
  };
  const { placement } = situateDoor(door, boxes);
  assert.equal(placement.yaw, 0);
  assert.ok(Math.abs(placement.position[0] - 4) < 1e-9 && placement.position[2] === 0, `hinge ${placement.position}`);
  assert.ok(Math.abs(placement.size[0] - 2.02) < 1e-9, "width is the run along the wall");
});
