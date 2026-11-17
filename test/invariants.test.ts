import assert from "node:assert/strict";
import test from "node:test";
import { PlanError } from "../src/errors.ts";
import { resolveExteriorDoors } from "../src/rooms-bake.ts";
import { buildSceneGraph } from "../src/scene-graph.ts";
import type { BoundsFile, DoorPlacement, Placement, SceneDoor, ScenePlace } from "../src/types.ts";
import { unionAabbs, type XzPoint } from "../src/union.ts";

/** Independent of `Ring.area`, so the stored sign cannot pass the check alone. */
function shoelace(points: readonly XzPoint[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i]!;
    const next = points[(i + 1) % points.length]!;
    area += point.x * next.z - next.x * point.z;
  }
  return area / 2;
}

test("union_positive_area_is_ccw", () => {
  const [square] = unionAabbs([{ minX: 0, maxX: 1, minZ: 0, maxZ: 1 }]);
  assert.ok(square);
  assert.ok(square.area > 0);
  assert.ok(shoelace(square.points) > 0);

  const court = unionAabbs([
    { minX: 0, maxX: 10, minZ: 0, maxZ: 1 },
    { minX: 0, maxX: 10, minZ: 7, maxZ: 8 },
    { minX: 0, maxX: 1, minZ: 0, maxZ: 8 },
    { minX: 9, maxX: 10, minZ: 0, maxZ: 8 },
  ]);
  const outer = court.filter((ring) => ring.area > 0);
  const holes = court.filter((ring) => ring.area < 0);
  assert.equal(outer.length, 1);
  assert.equal(holes.length, 1);
  assert.ok(shoelace(outer[0]!.points) > 0);
  assert.ok(shoelace(holes[0]!.points) < 0);
});

const BOUNDS: BoundsFile = { minX: -10, maxX: 20, minY: -2, maxY: 12, minZ: -10, maxZ: 20 };

function hall(id: string, minZ: number, maxZ: number): ScenePlace {
  return {
    id,
    kind: "hall",
    y: 0,
    polygon: [[0, minZ], [6, minZ], [6, maxZ], [0, maxZ]],
    bounds: { minX: 0, maxX: 6, minZ, maxZ },
  };
}

test("scene_graph_door_portal_ids", () => {
  const door = (id: string, x: number): DoorPlacement => ({
    id,
    model: "door-1",
    position: [x, 0, 4],
    yaw: 0,
    hinge: "left",
    size: [1, 2.1, 0.1],
    open: false,
  });
  const built = buildSceneGraph({
    places: [hall("south", 0, 4), hall("north", 4, 8)],
    doors: [door("west-leaf", 1), door("east-leaf", 4)],
    bounds: BOUNDS,
  });
  const doorPortals = built.graph.portals.filter((portal) => portal.kind === "door");
  assert.deepEqual(doorPortals.map((portal) => portal.id).sort(), ["east-leaf", "west-leaf"]);
  assert.equal(doorPortals.every((portal) => portal.door === portal.id), true);
  const ids = built.graph.portals.map((portal) => portal.id);
  assert.equal(new Set(ids).size, ids.length);
});

function placementDoor(id: string): SceneDoor {
  return {
    id,
    model: "door-1",
    building: "b",
    bind: "placement",
    center: [0, 0, 0],
    minX: 0,
    maxX: 1,
    minZ: 0,
    maxZ: 1,
    hinge: "left",
    open: false,
  };
}

test("exterior_door_ids_are_unique", () => {
  const kept = resolveExteriorDoors([placementDoor("a"), placementDoor("b")], [], () => [], new Set());
  assert.deepEqual(kept.map((door) => door.id), ["a", "b"]);
  assert.throws(
    () => resolveExteriorDoors([placementDoor("a"), placementDoor("a")], [], () => [], new Set()),
    (err: unknown) => err instanceof PlanError && err.message === 'duplicate placement id "a"',
  );
  assert.throws(
    () => resolveExteriorDoors([placementDoor("a")], [], () => [], new Set(["a"])),
    (err: unknown) => err instanceof PlanError && err.message === 'duplicate placement id "a"',
  );

  const modelDoor: SceneDoor = {
    ...placementDoor("d"),
    building: "bldg",
    bind: "model",
    minX: -0.5,
    maxX: 0.5,
    minZ: -0.5,
    maxZ: 0.5,
  };
  const placement: Placement = { id: "p", model: "bldg", position: [0, 0, 0], yaw: 0, scale: 1 };
  const boxes = () => [{ min: [-1, 0, -1] as [number, number, number], max: [1, 1, 1] as [number, number, number] }];
  assert.throws(
    () => resolveExteriorDoors([modelDoor], [placement], boxes, new Set(["p.d"])),
    (err: unknown) => err instanceof PlanError && err.message === 'duplicate placement id "p.d"',
  );
});
