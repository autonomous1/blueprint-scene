import assert from "node:assert/strict";
import test from "node:test";
import { unionAabbs, type Aabb2, type XzPoint } from "../src/union.ts";

function covers(points: readonly XzPoint[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const a = points[i]!;
    const b = points[j]!;
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function filled(boxes: Aabb2[], x: number, z: number): boolean {
  const rings = unionAabbs(boxes);
  let inside = false;
  for (const ring of rings) if (covers(ring.points, x, z)) inside = !inside;
  return inside;
}

test("a square walks counter-clockwise from its lower-left corner", () => {
  const [ring] = unionAabbs([{ minX: 0, maxX: 1, minZ: 0, maxZ: 1 }]);
  assert.ok(ring);
  assert.equal(ring.area, 1);
  assert.deepEqual(ring.points, [
    { x: 0, z: 0 },
    { x: 1, z: 0 },
    { x: 1, z: 1 },
    { x: 0, z: 1 },
  ]);
});

test("edge-adjacent runs become one outline, and an L does not fill the room", () => {
  const joined = unionAabbs([
    { minX: 0, maxX: 5, minZ: 0, maxZ: 1 },
    { minX: 5, maxX: 10, minZ: 0, maxZ: 1 },
  ]);
  assert.equal(joined.length, 1);
  assert.equal(joined[0]!.points.length, 4);
  assert.equal(joined[0]!.area, 10);

  const elbowBoxes = [
    { minX: 0, maxX: 4, minZ: 0, maxZ: 1 },
    { minX: 0, maxX: 1, minZ: 0, maxZ: 4 },
  ];
  const elbow = unionAabbs(elbowBoxes);
  assert.equal(elbow.length, 1);
  assert.equal(elbow[0]!.points.length, 6);
  assert.equal(elbow[0]!.area > 0, true);
  assert.equal(filled(elbowBoxes, 2, 0.5), true);
  assert.equal(filled(elbowBoxes, 0.5, 2), true);
  assert.equal(filled(elbowBoxes, 2, 2), false);
});

test("a box inside another stays solid, and corner contact stays two outlines", () => {
  const nestedBoxes = [
    { minX: 0, maxX: 10, minZ: 0, maxZ: 10 },
    { minX: 2, maxX: 4, minZ: 2, maxZ: 4 },
  ];
  const nested = unionAabbs(nestedBoxes);
  assert.equal(nested.length, 1);
  assert.equal(nested[0]!.area > 0, true);
  assert.equal(filled(nestedBoxes, 3, 3), true);

  const cornerBoxes = [
    { minX: 0, maxX: 1, minZ: 0, maxZ: 1 },
    { minX: 1, maxX: 2, minZ: 1, maxZ: 2 },
  ];
  const corners = unionAabbs(cornerBoxes);
  assert.equal(corners.length, 2);
  assert.equal(corners.every((ring) => ring.area > 0), true);
  assert.equal(filled(cornerBoxes, 0.5, 0.5), true);
  assert.equal(filled(cornerBoxes, 1.5, 1.5), true);
  assert.equal(filled(cornerBoxes, 0.5, 1.5), false);
});

test("two parallel walls are two outlines, and a closed court keeps a hole", () => {
  const parallelBoxes = [
    { minX: 0, maxX: 10, minZ: 0, maxZ: 0.5 },
    { minX: 0, maxX: 10, minZ: 4, maxZ: 4.5 },
  ];
  const parallel = unionAabbs(parallelBoxes);
  assert.equal(parallel.length, 2);
  assert.equal(parallel.every((ring) => ring.area > 0), true);
  assert.equal(filled(parallelBoxes, 5, 0.25), true);
  assert.equal(filled(parallelBoxes, 5, 4.25), true);
  assert.equal(filled(parallelBoxes, 5, 2), false);

  const openBoxes = [
    { minX: 0, maxX: 10, minZ: 0, maxZ: 1 },
    { minX: 0, maxX: 1, minZ: 0, maxZ: 8 },
    { minX: 9, maxX: 10, minZ: 0, maxZ: 8 },
  ];
  const open = unionAabbs(openBoxes);
  assert.equal(open.length, 1);
  assert.equal(open[0]!.area > 0, true);
  assert.equal(filled(openBoxes, 5, 4), false);

  const courtBoxes = [
    { minX: 0, maxX: 10, minZ: 0, maxZ: 1 },
    { minX: 0, maxX: 10, minZ: 7, maxZ: 8 },
    { minX: 0, maxX: 1, minZ: 0, maxZ: 8 },
    { minX: 9, maxX: 10, minZ: 0, maxZ: 8 },
  ];
  const court = unionAabbs(courtBoxes);
  assert.equal(court.length, 2);
  const hole = court.find((ring) => ring.area < 0);
  const outer = court.find((ring) => ring.area > 0);
  assert.ok(hole);
  assert.ok(outer);
  assert.equal(hole.points.length, 4);
  assert.equal(outer.points.length, 4);
  assert.equal(filled(courtBoxes, 5, 0.5), true);
  assert.equal(filled(courtBoxes, 5, 4), false);
  assert.equal(filled(courtBoxes, 5, 9), false);
});
