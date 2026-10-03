import assert from "node:assert/strict";
import test from "node:test";
import { transformXz } from "../src/yaw.ts";

test("y-up-90 is a right-handed quarter turn about +Y", () => {
  assert.deepEqual(transformXz(1, 0, 0), { x: 1, z: 0 });
  assert.deepEqual(transformXz(0, 1, 0), { x: 0, z: 1 });
  assert.deepEqual(transformXz(1, 0, 90), { x: 0, z: -1 });
  assert.deepEqual(transformXz(0, 1, 90), { x: 1, z: 0 });
  assert.deepEqual(transformXz(1, 0, 180), { x: -1, z: 0 });
  assert.deepEqual(transformXz(0, 1, 180), { x: 0, z: -1 });
  assert.deepEqual(transformXz(1, 0, 270), { x: 0, z: 1 });
  assert.deepEqual(transformXz(0, 1, 270), { x: -1, z: 0 });
});
