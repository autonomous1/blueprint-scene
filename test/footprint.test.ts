import assert from "node:assert/strict";
import test from "node:test";
import { CELL_M, coarseFootprint, footprintFromTriangles, MAX_OBSTACLES, measureFootprint } from "../src/footprint.ts";
import type { LocalBox, Triangle, Vec3 } from "../src/types.ts";
import { trianglesFromBox } from "./boxes.ts";

function covers(box: LocalBox, point: Vec3): boolean {
  const [x, y, z] = point;
  return x > box.minX && x < box.maxX && y > box.minY && y < box.maxY && z > box.minZ && z < box.maxZ;
}

test("an L of two walls does not become one box over the room", () => {
  const boxes = footprintFromTriangles([
    ...trianglesFromBox([0, 0, 0], [4, 3, 0.4]),
    ...trianglesFromBox([0, 0, 0], [0.4, 3, 4]),
  ]);
  assert.equal(boxes.length, 2);
  assert.equal(boxes.some((box) => covers(box, [2, 1, 2])), false);
});

test("a 2cm sheet across a doorway is dropped and the gap stays open", () => {
  const boxes = footprintFromTriangles([
    ...trianglesFromBox([0, 0, 0], [1, 3, 0.4]),
    ...trianglesFromBox([2, 0, 0], [3, 3, 0.4]),
    ...trianglesFromBox([1, 0, 0], [2, 3, 0.02]),
  ]);
  assert.equal(boxes.length, 2);
  assert.equal(boxes.some((box) => covers(box, [1.5, 1, 0.01])), false);
  assert.equal(boxes.some((box) => covers(box, [0.5, 1, 0.2])), true);
});

test("collinear neighbors closer than one cell merge and a 1m gap does not", () => {
  const boxes = footprintFromTriangles([
    ...trianglesFromBox([0, 0, 0], [1, 3, 0.4]),
    ...trianglesFromBox([1.03, 0, 0], [2, 3, 0.4]),
    ...trianglesFromBox([4, 0, 0], [5, 3, 0.4]),
  ]);
  assert.equal(boxes.length, 2);
  const merged = boxes.find((box) => box.minX === 0);
  assert.ok(merged);
  assert.equal(merged.maxX, 2);
  assert.equal(merged.minZ, 0);
  assert.equal(merged.maxZ, 0.4);
  assert.equal(boxes.some((box) => covers(box, [1.5, 1, 0.2])), true);
  assert.equal(boxes.some((box) => covers(box, [3, 1, 0.2])), false);
});

test("a 10 m wall with a 2 m gap is two runs, and a 0.2 m mullion is absent", () => {
  const wall = (x0: number, x1: number): Triangle[] => {
    const parts = 40;
    const dx = (x1 - x0) / parts;
    const triangles: Triangle[] = [];
    for (let i = 0; i < parts; i += 1) {
      const jitter = i % 2 === 0 ? 0 : 0.02;
      triangles.push(...trianglesFromBox(
        [x0 + i * dx, 0, jitter],
        [x0 + (i + 1) * dx, 3, 0.5 + jitter],
      ));
    }
    return triangles;
  };
  const boxes = footprintFromTriangles([
    ...wall(0, 10),
    ...wall(12, 22),
    ...trianglesFromBox([0, 0, 0], [22, 0.2, 2]),
    ...trianglesFromBox([11.1, 0, 0], [11.3, 3, 0.5]),
  ]);
  assert.equal(boxes.length, 2);
  assert.equal(boxes.some((box) => covers(box, [5, 1, 0.25])), true);
  assert.equal(boxes.some((box) => covers(box, [17, 1, 0.25])), true);
  assert.equal(boxes.some((box) => covers(box, [11, 1, 0.25])), false);
  assert.equal(boxes.some((box) => covers(box, [11.2, 1, 0.25])), false);
  assert.equal(boxes.some((box) => covers(box, [5, 1, 0.25]) && covers(box, [17, 1, 0.25])), false);
});

test("stamping a 2 m opening splits a 10 m wall and leaves the middle empty", () => {
  const wall = trianglesFromBox([-5, 0, -0.5], [5, 3, 0.5]);
  const sealed = footprintFromTriangles(wall);
  assert.equal(sealed.length, 1);
  const boxes = footprintFromTriangles(wall, CELL_M, [{ minX: -1, maxX: 1, minZ: -1, maxZ: 1 }]);
  assert.equal(boxes.length, 2);
  assert.equal(boxes.some((box) => covers(box, [0, 1, 0])), false);
  assert.ok((boxes[1]?.minX ?? 0) - (boxes[0]?.maxX ?? 0) >= 2);
});

test("a wall of sub-cell triangles is one run", () => {
  const triangles: Triangle[] = [];
  for (let i = 0; i < 50; i += 1) {
    for (let k = 0; k < 2; k += 1) {
      triangles.push(...trianglesFromBox(
        [i * 0.2, 0, k * 0.25],
        [(i + 1) * 0.2, 3, (k + 1) * 0.25],
      ));
    }
  }
  const boxes = footprintFromTriangles(triangles);
  assert.equal(boxes.length, 1);
  assert.ok(boxes[0]!.maxX - boxes[0]!.minX >= 9);
  assert.equal(boxes[0]!.minY, 0);
  assert.equal(boxes[0]!.maxY, 3);
  assert.ok(boxes[0]!.maxZ - boxes[0]!.minZ >= 0.4);
});

test("measure keeps a sub-metre run that bake drops", () => {
  const wall = trianglesFromBox([0, 0, 0], [0.8, 1, 0.3]);
  assert.equal(footprintFromTriangles(wall).length, 0);
  const boxes = measureFootprint(wall);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0]!.minX, 0);
  assert.equal(boxes[0]!.maxX, 0.8);
  assert.equal(boxes[0]!.minZ, 0);
  assert.equal(boxes[0]!.maxZ, 0.3);
});

test("more than 32 runs doubles the cell once", () => {
  const triangles: Triangle[] = [];
  const count = MAX_OBSTACLES + 8;
  for (let i = 0; i < count; i += 1) {
    triangles.push(...trianglesFromBox([i * 3, 0, 0], [i * 3 + 2, 3, 1]));
  }
  const fine = footprintFromTriangles(triangles, CELL_M);
  assert.ok(fine.length > MAX_OBSTACLES);
  const coarse = coarseFootprint(triangles);
  assert.equal(coarse.cellSize, CELL_M * 2);
  assert.equal(coarse.boxes.length, count);
  assert.equal(coarse.boxes.some((box) => covers(box, [1, 1, 0.5]) && covers(box, [4, 1, 0.5])), false);
});
