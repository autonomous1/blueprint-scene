import assert from "node:assert/strict";
import test from "node:test";
import { cutDoorFromBoxes, doorClearLocal, subtractDoorOpening, type SituatedDoor } from "../src/doors.ts";
import { PlanError } from "../src/errors.ts";
import type { DoorPlacement, LocalBox, Vec3 } from "../src/types.ts";
import { placeBox } from "../src/yaw.ts";

function door(fields: Pick<DoorPlacement, "hinge" | "yaw" | "position" | "size"> & Partial<DoorPlacement>): DoorPlacement {
  return { id: "front", model: "door-1", open: false, ...fields };
}

function situated(placement: DoorPlacement): SituatedDoor {
  return { placement, opening: doorClearLocal(placement) };
}

function covers(box: { min: Vec3; max: Vec3 }, point: Vec3): boolean {
  const [x, y, z] = point;
  return x > box.min[0] && x < box.max[0] && y > box.min[1] && y < box.max[1] && z > box.min[2] && z < box.max[2];
}

function coversLocal(box: LocalBox, x: number, y: number, z: number): boolean {
  return x > box.minX && x < box.maxX && y > box.minY && y < box.maxY && z > box.minZ && z < box.maxZ;
}

function worldOf(boxes: readonly LocalBox[], position: Vec3, yaw: DoorPlacement["yaw"]): Array<{ min: Vec3; max: Vec3 }> {
  return boxes.map((box) => placeBox(box, position, yaw));
}

test("the clear opening is the hinged panel, not a centered mark", () => {
  const left = doorClearLocal(door({
    hinge: "left",
    yaw: 0,
    position: [10, 0, 10.5],
    size: [2, 2.1, 0.08],
  }));
  assert.deepEqual(left, { minX: 0, maxX: 2, minY: 0, maxY: 2.1, minZ: -2, maxZ: 0 });

  const right = doorClearLocal(door({
    hinge: "right",
    yaw: 90,
    position: [10.5, 0, 10],
    size: [2, 2.4, 0.1],
  }));
  assert.equal(right.minX, -2);
  assert.equal(right.maxX, 0);
  assert.equal(right.minY, 0);
  assert.equal(right.maxY, 2.4);
  assert.equal(right.minZ, -2);
  assert.equal(right.maxZ, 0);
});

test("subtract keeps the jambs, the lintel, and a sill below the opening", () => {
  const wall: LocalBox = { minX: -5, maxX: 5, minY: -1, maxY: 3, minZ: -1, maxZ: 0 };
  const opening = doorClearLocal(door({
    hinge: "left",
    yaw: 0,
    position: [0, 0, 0],
    size: [2, 2.1, 0.08],
  }));
  const parts = subtractDoorOpening(wall, opening);
  assert.equal(parts.length, 4);
  assert.deepEqual(parts[0], { ...wall, maxX: 0 });
  assert.deepEqual(parts[1], { ...wall, minX: 2 });
  assert.equal(parts.some((box) => coversLocal(box, 1, 2.5, -0.5)), true);
  assert.equal(parts.some((box) => coversLocal(box, 1, -0.5, -0.5)), true);
  assert.equal(parts.some((box) => coversLocal(box, 1, 1, -0.5)), false);
  assert.equal(parts.some((box) => coversLocal(box, -1, 1, -0.5)), true);
  for (const box of parts) {
    assert.ok(box.minY >= wall.minY - 1e-9 && box.maxY <= wall.maxY + 1e-9);
    assert.ok(box.minZ >= wall.minZ - 1e-9 && box.maxZ <= wall.maxZ + 1e-9);
  }
});

test("a thick host keeps the solid behind the 2 m opening", () => {
  const wall: LocalBox = { minX: -5, maxX: 5, minY: -1, maxY: 3, minZ: -10, maxZ: 0 };
  const opening = doorClearLocal(door({
    hinge: "left",
    yaw: 0,
    position: [0, 0, 0],
    size: [2, 2.1, 0.08],
  }));
  const parts = subtractDoorOpening(wall, opening);
  assert.equal(parts.length, 5);
  assert.equal(parts.some((box) => coversLocal(box, 1, 1, -1)), false);
  assert.equal(parts.some((box) => coversLocal(box, 1, 1, -5)), true);
  assert.equal(parts.some((box) => coversLocal(box, 1, 2.5, -1)), true);
  assert.equal(parts.some((box) => coversLocal(box, 1, -0.5, -1)), true);
});

test("yaw 0 left, yaw 90 right, and yaw 180 left place the panel on the hinge", () => {
  const wall: LocalBox = { minX: -5, maxX: 5, minY: 0, maxY: 3, minZ: -0.5, maxZ: 0.5 };
  const other: LocalBox = { minX: 20, maxX: 22, minY: 1, maxY: 2, minZ: -3, maxZ: 4 };

  const yaw0 = situated(door({
    hinge: "left",
    yaw: 0,
    position: [10, 0, 10.5],
    size: [2, 2.1, 0.08],
  }));
  const cut0 = cutDoorFromBoxes([wall, other], yaw0, [10, 0, 10], 0);
  assert.equal(cut0.length, 4);
  assert.deepEqual(cut0[3], other);
  const world0 = worldOf(cut0.slice(0, 3), [10, 0, 10], 0);
  assert.equal(world0.some((box) => covers(box, [9, 1, 10])), true);
  assert.equal(world0.some((box) => covers(box, [11, 1, 10])), false);
  assert.equal(world0.some((box) => covers(box, [11, 2.5, 10])), true);
  assert.equal(world0.some((box) => covers(box, [11.5, 1, 10])), false);

  const yaw90 = situated(door({
    hinge: "right",
    yaw: 90,
    position: [10.5, 0, 10],
    size: [2, 2.1, 0.08],
  }));
  const world90 = worldOf(cutDoorFromBoxes([wall], yaw90, [10, 0, 10], 90), [10, 0, 10], 90);
  assert.equal(world90.length, 3);
  assert.equal(world90.some((box) => covers(box, [10, 1, 9])), true);
  assert.equal(world90.some((box) => covers(box, [10, 1, 11])), false);
  assert.equal(world90.some((box) => covers(box, [10, 2.5, 11])), true);
  assert.equal(world90.some((box) => covers(box, [10, 1, 11.5])), false);
  for (const box of world90) {
    assert.ok(Math.abs(box.min[0] - 9.5) < 1e-6 && Math.abs(box.max[0] - 10.5) < 1e-6);
  }

  const face: LocalBox = { minX: -5, maxX: 5, minY: 0, maxY: 3, minZ: -0.5, maxZ: 0.5 };
  const yaw180 = situated(door({
    hinge: "left",
    yaw: 180,
    position: [0, 0, -0.5],
    size: [2, 2.1, 0.08],
  }));
  const world180 = worldOf(cutDoorFromBoxes([face], yaw180, [0, 0, 0], 0), [0, 0, 0], 0);
  assert.equal(world180.some((box) => covers(box, [1, 1, 0])), true);
  assert.equal(world180.some((box) => covers(box, [-1.5, 1, 0])), false);
  assert.equal(world180.some((box) => covers(box, [-1.5, 2.5, 0])), true);
});

test("a door that misses every wall box fails; one that spans two boxes cuts both", () => {
  const opening = situated(door({
    hinge: "left",
    yaw: 0,
    position: [0, 0, 0.5],
    size: [2, 2.1, 0.08],
  }));
  const missed: LocalBox = { minX: 10, maxX: 12, minY: 0, maxY: 3, minZ: -0.5, maxZ: 0.5 };
  assert.throws(
    () => cutDoorFromBoxes([missed], opening, [0, 0, 0], 0),
    (err: unknown) => err instanceof PlanError && /door "front" does not hit a wall box/.test(err.message),
  );
  // Opening x 0..2. It straddles the seam at x 1, so both boxes are cut (multi-box fix).
  const left: LocalBox = { minX: -1, maxX: 1, minY: 0, maxY: 3, minZ: -0.5, maxZ: 0.5 };
  const right: LocalBox = { minX: 1, maxX: 4, minY: 0, maxY: 3, minZ: -0.5, maxZ: 0.5 };
  const cut = cutDoorFromBoxes([left, right], opening, [0, 0, 0], 0);
  const solid = (x: number, y: number): boolean => cut.some((box) => coversLocal(box, x, y, 0));
  for (const x of [0.25, 0.75, 1.25, 1.75]) assert.equal(solid(x, 1), false, `gap at x ${x}`);
  assert.equal(solid(-0.5, 1), true, "left jamb");
  assert.equal(solid(3, 1), true, "right jamb");
  assert.equal(solid(0.5, 2.5), true, "lintel over the left box");
  assert.equal(solid(1.5, 2.5), true, "lintel over the right box");
  // Nothing outside the original two boxes, and no column erased.
  for (const box of cut) assert.ok(box.minX >= -1 - 1e-9 && box.maxX <= 4 + 1e-9);
});
