import assert from "node:assert/strict";
import test from "node:test";
import { cutDoorFromBoxes, situateDoor } from "../src/doors.ts";
import type { DoorHinge, LocalBox, SceneDoor, Vec3, Yaw } from "../src/types.ts";
import { placeBox, transformXz } from "../src/yaw.ts";

const ORIGIN: Vec3 = [0, 0, 0];

function box(minX: number, maxX: number, minZ: number, maxZ: number): LocalBox {
  return { minX, maxX, minY: 0, maxY: 3, minZ, maxZ };
}

/** A 10 m room, walls 0.5 m thick. Outer faces: south z 5 (yaw 0), east x 5 (90), north z −5 (180), west x −5 (270). */
const ROOM: LocalBox[] = [
  box(-5, 5, 4.5, 5),
  box(4.5, 5, -4.5, 4.5),
  box(-5, 5, -5, -4.5),
  box(-5, -4.5, -4.5, 4.5),
];

type Wall = { yaw: Yaw; axis: "x" | "z"; outer: number; inward: number };
const WALLS: Wall[] = [
  { yaw: 0, axis: "z", outer: 5, inward: -1 },
  { yaw: 90, axis: "x", outer: 5, inward: -1 },
  { yaw: 180, axis: "z", outer: -5, inward: 1 },
  { yaw: 270, axis: "x", outer: -5, inward: 1 },
];

/** A rectangle 2 m along the wall from `a0` to `a1`, 0.3 m across, its outside on the outer face. */
function drawn(wall: Wall, a0: number, a1: number, hinge: DoorHinge, width?: number): SceneDoor {
  const n0 = wall.outer;
  const n1 = wall.outer + wall.inward * 0.3;
  const [minN, maxN] = [Math.min(n0, n1), Math.max(n0, n1)];
  const along = (a0 + a1) / 2;
  const normal = (minN + maxN) / 2;
  const rect = wall.axis === "z"
    ? { minX: a0, maxX: a1, minZ: minN, maxZ: maxN, center: [along, 0, normal] as Vec3 }
    : { minX: minN, maxX: maxN, minZ: a0, maxZ: a1, center: [normal, 0, along] as Vec3 };
  return { id: `d-${wall.yaw}-${hinge}`, model: "door-1", building: "room", hinge, open: false, width, ...rect };
}

/** World span along the wall of local x `x0..x1` at the placement. */
function alongSpan(position: Vec3, yaw: Yaw, x0: number, x1: number, axis: "x" | "z"): [number, number] {
  const ends = [x0, x1].map((x) => {
    const w = transformXz(x, 0, yaw);
    return axis === "z" ? position[0] + w.x : position[2] + w.z;
  });
  return [Math.min(...ends), Math.max(...ends)];
}

function near(actual: number, expected: number, label: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} ≠ ${expected}`);
}

function solid(boxes: readonly LocalBox[], x: number, y: number, z: number): boolean {
  return boxes.some((b) => x > b.minX && x < b.maxX && y > b.minY && y < b.maxY && z > b.minZ && z < b.maxZ);
}

for (const wall of WALLS) {
  for (const hinge of ["left", "right"] as const) {
    test(`yaw ${wall.yaw}, ${hinge} hinge: the mesh, the opening, and the cut cover the drawn rectangle`, () => {
      const [a0, a1] = [-1, 1.5];
      const door = drawn(wall, a0, a1, hinge);
      const world = ROOM.map((b) => placeBox(b, ORIGIN, 0));
      const { placement, opening } = situateDoor(door, world);
      assert.equal(placement.yaw, wall.yaw);
      near(placement.size[0], a1 - a0, "width is the drawn span");

      // The hinge is on the outer face, at the drawn rectangle's hinge edge.
      near(wall.axis === "z" ? placement.position[2] : placement.position[0], wall.outer, "hinge on outer face");
      const localPlusX = transformXz(1, 0, wall.yaw);
      const alongPlus = wall.axis === "z" ? localPlusX.x : localPlusX.z;
      const hingeAlong = wall.axis === "z" ? placement.position[0] : placement.position[2];
      const expectedHinge = (hinge === "left") === (alongPlus > 0) ? a0 : a1;
      near(hingeAlong, expectedHinge, "hinge edge");

      // Opening span along the wall equals the drawn span.
      const [o0, o1] = alongSpan(placement.position, placement.yaw, opening.minX, opening.maxX, wall.axis);
      near(o0, a0, "opening start");
      near(o1, a1, "opening end");

      // The arena mounts the hinge-origin GLB at `position`: a left-hinge panel is
      // local x 0..w, a right-hinge panel −w..0 (prop --shape door). Same span.
      const w = placement.size[0];
      const [m0, m1] = alongSpan(placement.position, placement.yaw, hinge === "left" ? 0 : -w, hinge === "left" ? w : 0, wall.axis);
      near(m0, a0, "mesh start");
      near(m1, a1, "mesh end");

      // The cut: open across the drawn span, solid 5 cm past each end and above it.
      const cut = cutDoorFromBoxes(ROOM, { placement, opening }, ORIGIN, 0);
      const point = (along: number, y: number): [number, number, number] => {
        const n = wall.outer + wall.inward * 0.25;
        return wall.axis === "z" ? [along, y, n] : [n, y, along];
      };
      for (let a = a0 + 0.05; a < a1; a += 0.1) assert.equal(solid(cut, ...point(a, 1)), false, `open at ${a.toFixed(2)}`);
      assert.equal(solid(cut, ...point(a0 - 0.05, 1)), true, "jamb before the rectangle");
      assert.equal(solid(cut, ...point(a1 + 0.05, 1)), true, "jamb after the rectangle");
      assert.equal(solid(cut, ...point((a0 + a1) / 2, 2.5)), true, "lintel");
    });
  }
}

test("a data-width marker opens that width centered on the marker, for either hinge", () => {
  const world = ROOM.map((b) => placeBox(b, ORIGIN, 0));
  for (const hinge of ["left", "right"] as const) {
    const marker = drawn(WALLS[0]!, 0.9, 1.1, hinge, 2);
    const { placement, opening } = situateDoor(marker, world);
    const [o0, o1] = alongSpan(placement.position, placement.yaw, opening.minX, opening.maxX, "z");
    near(o0, 0, `${hinge} start`);
    near(o1, 2, `${hinge} end`);
    near(placement.position[0], hinge === "left" ? 0 : 2, `${hinge} hinge`);
  }
});

test("locked and key are copied onto the placement and omitted when absent", () => {
  const world = ROOM.map((b) => placeBox(b, ORIGIN, 0));
  const plain = situateDoor(drawn(WALLS[0]!, -1, 1, "left"), world).placement;
  assert.equal("locked" in plain, false);
  assert.equal("key" in plain, false);
  const marked = drawn(WALLS[0]!, -1, 1, "left");
  marked.locked = true;
  marked.key = "key";
  const placement = situateDoor(marked, world).placement;
  assert.equal(placement.locked, true);
  assert.equal(placement.key, "key");
  assert.equal(placement.open, false);
});
