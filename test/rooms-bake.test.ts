import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bake } from "../src/bake.ts";
import { openingInModel } from "../src/building-mesh-cut.ts";
import { PlanError } from "../src/errors.ts";
import { readFloorsSvg, type FloorsSource } from "../src/floors-svg.ts";
import { writeTriangleGlb } from "../src/glb-write.ts";
import { trianglesFromGlb } from "../src/glb.ts";
import type { RoomFile } from "../src/room-file.ts";
import { writeRoom } from "../src/room-glb.ts";
import { cutFacadeWalls, placeRoomDoors, roomFacadeOpenings, type PendingRoomDoor } from "../src/rooms-bake.ts";
import type { DoorPlacement, LocalBox, Obstacle, Placement, SceneDoor, Vec3 } from "../src/types.ts";
import { placeBox } from "../src/yaw.ts";
import { trianglesFromBox } from "./boxes.ts";
import { writeGlb } from "./glb-writer.ts";

const TEX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SNIPPET = '{"id":"rm","kind":"model","type":"room","instance":"static","uri":"/assets/models/rm.glb","mediaType":"model/gltf-binary"}';
const WALLS = { blk: trianglesFromBox([-0.5, 0, -0.5], [0.5, 0.6, 0.5]) };

type Box = { min: Vec3; max: Vec3 };

type StageOpts = {
  doorX?: number;
  doorW?: number;
  yaw?: 0 | 90;
  building?: { x: number; y: number; w: number; h: number };
  /** Floors-file room rect depth. The prefab stays 6×6. */
  roomDepth?: number;
  writeRoomFile?: boolean;
  panel?: number;
  game?: "rm" | "other" | "none";
  /** Room-prefab door wall. `left` is the other outer face in this fixture. */
  roomDoorWall?: "front" | "left";
};

type Stage = {
  dir: string;
  svg: string;
  floors: string;
  rooms: string;
  models: string;
  out: string;
  collision: string;
  game?: string;
};

function stage(opts: StageOpts = {}): Stage {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-rooms-"));
  try {
    const floors = path.join(dir, "floors");
    const rooms = path.join(dir, "rooms");
    const models = path.join(dir, "models");
    mkdirSync(floors);
    mkdirSync(rooms);
    mkdirSync(models);
    const doorX = opts.doorX ?? -0.5;
    const doorW = opts.doorW ?? 1;
    const depth = opts.roomDepth ?? 6;
    writeFileSync(path.join(floors, "blk.floors.svg"), floorsSvg(doorX, doorW, depth));
    const building = opts.building ?? { x: 5, y: 25, w: 10, h: 10 };
    const svg = path.join(dir, "plan.svg");
    writeFileSync(svg, sceneSvg(building, opts.yaw ?? 0));
    const panel = opts.panel ?? 1;
    writeFileSync(path.join(models, "door-1.glb"), writeGlb(
      [{ name: "door", triangles: trianglesFromBox([0, 0, 0], [panel, 2.1, 0.08]) }],
      [{ name: "door", mesh: "door" }],
    ));
    if (opts.writeRoomFile !== false) {
      const svgPath = path.join(rooms, "rm.svg");
      writeFileSync(svgPath, roomSvg(opts.roomDoorWall ?? "front"));
      writeRoom({ svgPath, outPath: path.join(rooms, "rm.glb") });
    }
    const gameKind = opts.game ?? "rm";
    let game: string | undefined;
    if (gameKind !== "none") {
      game = path.join(dir, "game.json");
      const asset = gameKind === "rm"
        ? { id: "rm", kind: "model", type: "room", uri: "/assets/models/rm.glb" }
        : { id: "crate", kind: "model", type: "crate", uri: "/assets/models/crate.glb" };
      writeFileSync(game, JSON.stringify({ assets: [asset] }));
    }
    return {
      dir,
      svg,
      floors,
      rooms,
      models,
      out: path.join(dir, "out", "buildings.placements.json"),
      collision: path.join(dir, "collision"),
      game,
    };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

function run(staged: Stage, opts: { floors?: boolean; rooms?: boolean } = {}) {
  return bake({
    svgPath: staged.svg,
    outPath: staged.out,
    collisionDir: staged.collision,
    modelsDir: staged.models,
    walls: WALLS,
    ...(staged.game ? { gamePath: staged.game } : {}),
    ...(opts.floors === false ? {} : { floorsDir: staged.floors }),
    ...(opts.rooms === false ? {} : { roomsDir: staged.rooms }),
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hits(obstacle: Obstacle, box: Box): boolean {
  return obstacle.min[0] < box.max[0] && obstacle.max[0] > box.min[0]
    && obstacle.min[1] < box.max[1] && obstacle.max[1] > box.min[1]
    && obstacle.min[2] < box.max[2] && obstacle.max[2] > box.min[2];
}

/** Open-leaf clear volume: local x across the width, y up the height, z 2 m inward. Inset so a jamb face does not count. */
function doorwayClear(door: DoorPlacement): Box {
  const [width, height] = door.size;
  const placed = placeBox({
    minX: (door.hinge === "left" ? 0 : -width) + 0.01,
    maxX: (door.hinge === "left" ? width : 0) - 0.01,
    minY: 0.01,
    maxY: height - 0.01,
    minZ: -2 + 0.01,
    maxZ: -0.01,
  }, door.position, door.yaw);
  return { min: placed.min, max: placed.max };
}

function covers(obstacle: Obstacle, point: Vec3): boolean {
  const [x, y, z] = point;
  return x > obstacle.min[0] && x < obstacle.max[0]
    && y > obstacle.min[1] && y < obstacle.max[1]
    && z > obstacle.min[2] && z < obstacle.max[2];
}

test("bake places rooms, merges the facade door, and hollows the building", () => {
  const staged = stage();
  try {
    const source = readFloorsSvg(readFileSync(path.join(staged.floors, "blk.floors.svg"), "utf8"));
    assert.equal(source.model, "blk");
    assert.equal(source.scale, 10);
    assert.equal(source.floors[0]!.elevation, 0);
    assert.equal(source.floors[1]!.elevation, 3);
    const room = source.floors[0]!.rooms[0]!;
    assert.equal(room.id, "r1");
    assert.equal(room.prefab, "rm");
    assert.equal(room.yaw, 0);
    assert.ok(Math.abs(room.center.x) < 1e-6, String(room.center.x));
    assert.ok(Math.abs(room.center.z - 1.9) < 1e-4, String(room.center.z));
    assert.equal(room.drawnWidth, 6);
    assert.equal(room.drawnDepth, 6);
    const door = source.doors[0]!;
    assert.equal(door.id, "front");
    assert.ok(Math.abs(door.minX - -0.5) < 1e-4 && Math.abs(door.maxX - 0.5) < 1e-4, `${door.minX}..${door.maxX}`);
    assert.ok(Math.abs(door.minZ - 5) < 1e-4 && Math.abs(door.maxZ - 5.2) < 1e-4, `${door.minZ}..${door.maxZ}`);
    assert.equal(source.props[0]!.id, "step");

    const result = run(staged);
    const roomsPath = path.join(staged.dir, "out", "rooms.placements.json");
    const lightsPath = path.join(staged.dir, "out", "rooms.lights.json");
    assert.deepEqual(JSON.parse(readFileSync(roomsPath, "utf8")), result.rooms);
    assert.deepEqual(JSON.parse(readFileSync(lightsPath, "utf8")), result.lights);
    assert.deepEqual(result.rooms!.placements.filter((item) => item.model === "rm"), [
      { id: "B.r1", model: "rm", type: "room", position: [10, 0, 11.9], yaw: 0, scale: 1 },
      { id: "B.r2", model: "rm", type: "room", position: [10, 3, 11.9], yaw: 0, scale: 1 },
    ]);
    const front = result.doors.placements.find((item) => item.id === "B.front");
    assert.deepEqual(front && {
      id: front.id,
      model: front.model,
      position: front.position,
      yaw: front.yaw,
      hinge: front.hinge,
      size: front.size,
      open: front.open,
    }, {
      id: "B.front",
      model: "door-1",
      position: [9.5, 0, 15],
      yaw: 0,
      hinge: "left",
      size: [1, 2.1, 0.08],
      open: false,
    });
    assert.equal(result.doors.placements.some((item) => item.id === "B.r1.d1"), false);
    assert.equal(result.props.placements.some((item) => item.id === "B.step" && item.model === "step"), true);
    assert.equal(result.lines.some((line) => line.startsWith("warning:")), false, result.lines.join("\n"));
    assert.equal(result.lines.includes(SNIPPET), false);

    const interior: Box = { min: [7.01, 0.01, 8.91], max: [12.99, 2.99, 14.89] };
    const doorway: Box = { min: [9.51, 0.01, 14.91], max: [10.49, 2.09, 15.19] };
    const buildingHits = result.file.obstacles.filter((item) => hits(item, interior)).map((item) => item.id);
    assert.deepEqual(buildingHits, []);
    const doorHits = [
      ...result.file.obstacles,
      ...result.rooms!.obstacles.filter((item) => item.id.startsWith("B.r1.")),
    ].filter((item) => hits(item, doorway)).map((item) => item.id);
    assert.deepEqual(doorHits, []);
    assert.equal(
      result.file.obstacles.some((item) => item.id.startsWith("B-wall-") && covers(item, [6, 1, 10])),
      false,
      JSON.stringify(result.file.obstacles.filter((item) => item.id.startsWith("B-wall-"))),
    );
    assert.equal(
      result.file.obstacles.some((item) => item.id.startsWith("B-wall-") && covers(item, [5.2, 1, 10])),
      true,
      JSON.stringify(result.file.obstacles.filter((item) => item.id.startsWith("B-wall-"))),
    );
    assert.equal(result.rooms!.obstacles.some((item) => item.id.startsWith("B.r1.floor.")), false);
    const slab = result.rooms!.obstacles.find((item) => item.id === "B.r2.floor.0");
    assert.ok(slab, result.rooms!.obstacles.map((item) => item.id).join(","));
    assert.ok(Math.abs(slab.min[1] - 2.9) < 1e-4, String(slab.min[1]));
    assert.ok(Math.abs(slab.max[1] - 3) < 1e-4, String(slab.max[1]));

    const prefab = JSON.parse(readFileSync(path.join(staged.rooms, "rm.room.json"), "utf8")) as RoomFile;
    const lamp = prefab.lights.find((item) => item.id === "lamp");
    const panel = prefab.lights.find((item) => item.id === "panel");
    assert.ok(lamp && panel);
    assert.deepEqual(lamp.position, [0, 2, 0]);
    assert.deepEqual(panel.position, [0, 2.8, 0.25]);
    assert.deepEqual(result.lights!.lights.find((item) => item.id === "B.r1.lamp"), {
      id: "B.r1.lamp",
      type: "point",
      position: [10, lamp.position[1], 11.9],
      color: lamp.color,
      intensity: lamp.intensity,
    });
    assert.deepEqual(result.lights!.lights.find((item) => item.id === "B.r1.panel"), {
      id: "B.r1.panel",
      type: "rect",
      position: [10, panel.position[1], 11.9 + panel.position[2]],
      yaw: 0,
      color: panel.color,
      intensity: panel.intensity,
      width: panel.width,
      height: panel.height,
    });
    assert.equal("yaw" in result.lights!.lights.find((item) => item.id === "B.r1.lamp")!, false);
    const upper = result.lights!.lights.find((item) => item.id === "B.r2.lamp");
    assert.deepEqual(upper?.position, [10, 3 + lamp.position[1], 11.9]);
    assert.equal(upper && "yaw" in upper, false);
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("a yaw 90 building turns the room and still merges the door", () => {
  const staged = stage({ yaw: 90 });
  try {
    const result = run(staged);
    assert.deepEqual(result.rooms!.placements.find((item) => item.id === "B.r1"), {
      id: "B.r1",
      model: "rm",
      type: "room",
      position: [11.9, 0, 10],
      yaw: 90,
      scale: 1,
    });
    assert.equal(result.rooms!.placements.some((item) => item.id === "B.r1.d1"), false);
    assert.equal(result.doors.placements.find((item) => item.id === "B.front")?.yaw, 90);
    assert.equal(result.lights!.lights.find((item) => item.id === "B.r1.panel")?.yaw, 90);
    assert.equal("yaw" in result.lights!.lights.find((item) => item.id === "B.r1.lamp")!, false);
    assert.equal(result.lines.some((line) => line.startsWith("warning:")), false, result.lines.join("\n"));
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("a room door with no external match is emitted, and a partial overlap fails", () => {
  const apart = stage({ doorX: 3, doorW: 1 });
  try {
    const result = run(apart);
    const leaf = result.rooms!.placements.find((item) => item.id === "B.r1.d1");
    assert.deepEqual(leaf, {
      id: "B.r1.d1",
      model: "door-1",
      position: [9.5, 0, 15.1],
      yaw: 0,
      hinge: "left",
      size: [1, 2.1, 0.08],
      open: false,
    });
    assert.equal(result.doors.placements.some((item) => item.id === "B.r1.d1"), false);
    assert.equal(result.doors.placements.some((item) => item.id === "B.front"), true);
    const staticBoxes = [...result.file.obstacles, ...result.rooms!.obstacles];
    for (const id of ["B.r1.d1", "B.r2.d1"]) {
      const door = result.rooms!.placements.find((item): item is DoorPlacement => item.id === id);
      assert.ok(door && door.hinge, id);
      const doorHits = staticBoxes.filter((item) => hits(item, doorwayClear(door))).map((item) => item.id);
      assert.deepEqual(doorHits, [], `${id}: a baked box seals the open gap`);
    }
    const front = result.doors.placements.find((item) => item.id === "B.front");
    assert.ok(front);
    const exteriorHits = staticBoxes.filter((item) => hits(item, doorwayClear(front))).map((item) => item.id);
    assert.deepEqual(exteriorHits, [], "B.front: a baked box seals the open gap");
    assert.equal(result.file.obstacles.some((item) => covers(item, [8, 1, 14.95])), true);
  } finally {
    rmSync(apart.dir, { recursive: true, force: true });
  }

  const partial = stage({ doorX: 0, doorW: 1 });
  try {
    assert.throws(
      () => run(partial),
      (err: unknown) => err instanceof PlanError
        && err.message.includes('door "B.front"')
        && err.message.includes("B.r1.d1")
        && err.message.includes("partially overlaps"),
    );
  } finally {
    rmSync(partial.dir, { recursive: true, force: true });
  }
});

test("a wider external door merges and warns", () => {
  const staged = stage({ doorX: -0.6, doorW: 1.2, panel: 1.2 });
  try {
    const result = run(staged);
    const warning = result.lines.find((line) => line.startsWith("warning:") && line.includes("B.r1.d1"));
    assert.ok(warning, result.lines.join("\n"));
    assert.match(warning, /width/);
    assert.match(warning, /B\.front/);
    assert.equal(result.lines.some((line) => line.startsWith("warning:") && line.includes("height")), false);
    assert.equal(result.rooms!.placements.some((item) => item.id === "B.r1.d1"), false);
    assert.equal(result.doors.placements.some((item) => item.id === "B.front"), true);
    const front = result.doors.placements.find((item) => item.id === "B.front")!;
    const doorway: Box = {
      min: [front.position[0] + 0.01, front.position[1] + 0.01, front.position[2] - 0.09],
      max: [front.position[0] + front.size[0] - 0.01, front.position[1] + front.size[1] - 0.01, front.position[2] + 0.19],
    };
    const doorHits = [
      ...result.file.obstacles,
      ...result.rooms!.obstacles,
    ].filter((item) => hits(item, doorway)).map((item) => item.id);
    assert.deepEqual(doorHits, []);
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("an external door cuts a solid room wall across the facade", () => {
  const staged = stage({ roomDoorWall: "left" });
  try {
    const result = run(staged);
    assert.equal(result.doors.placements.some((item) => item.id === "B.front"), true);
    assert.equal(result.rooms!.placements.some((item) => item.id === "B.r1.d1"), true);
    const doorway: Box = { min: [9.51, 0.01, 14.91], max: [10.49, 2.09, 15.19] };
    const doorHits = [
      ...result.file.obstacles,
      ...result.rooms!.obstacles,
    ].filter((item) => hits(item, doorway)).map((item) => item.id);
    assert.deepEqual(doorHits, []);
    assert.ok(result.rooms!.obstacles.some((item) => item.id.startsWith("B.r1.front")));
    assert.equal(result.lines.some((line) => line.includes("partially overlaps")), false, result.lines.join("\n"));
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("floors bake fails on scale, room size, a missing room file, and a missing --rooms", () => {
  const scaled = stage({ building: { x: 4.75, y: 24.75, w: 10.5, h: 10.5 } });
  try {
    assert.throws(
      () => run(scaled),
      (err: unknown) => /differs from blk\.floors\.svg/.test(messageOf(err)) && /10\.5/.test(messageOf(err)),
    );
  } finally {
    rmSync(scaled.dir, { recursive: true, force: true });
  }

  const sized = stage({ roomDepth: 6.3 });
  try {
    assert.throws(
      () => run(sized),
      (err: unknown) => {
        const message = messageOf(err);
        return message.includes("6") && message.includes("6.3") && message.includes("\u00d7");
      },
    );
  } finally {
    rmSync(sized.dir, { recursive: true, force: true });
  }

  const missing = stage({ writeRoomFile: false });
  try {
    assert.throws(
      () => run(missing),
      (err: unknown) => /cannot read/.test(messageOf(err)) && /rm\.room\.json/.test(messageOf(err)),
    );
  } finally {
    rmSync(missing.dir, { recursive: true, force: true });
  }

  const noRooms = stage();
  try {
    assert.throws(
      () => run(noRooms, { rooms: false }),
      (err: unknown) => /--rooms/.test(messageOf(err)),
    );
  } finally {
    rmSync(noRooms.dir, { recursive: true, force: true });
  }
});

test("a room prefab missing from the game file is printed as an asset snippet", () => {
  const staged = stage({ game: "other" });
  try {
    const result = run(staged);
    assert.equal(result.lines.includes(SNIPPET), true, result.lines.join("\n"));
    assert.equal(result.rooms!.placements.find((item) => item.id === "B.r1" && "type" in item && item.type), undefined);
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("empty exteriors leave room doors out of the shared cut", () => {
  const staged = stage();
  try {
    writeFileSync(path.join(staged.floors, "blk.floors.svg"), floorsSvg(-0.5, 1, 6, { doors: false }));
    const result = run(staged);
    const opens = result.lines.filter((line) => line.startsWith("cut-open "));
    assert.deepEqual(opens, []);
    assert.equal(result.lines.includes("cut-shared blk 0"), true);
    const inputs = result.lines.find((line) => line.startsWith("bake-inputs "));
    assert.ok(inputs, result.lines.join("\n"));
    assert.ok(inputs.includes(`svg=${path.resolve(staged.svg)}`));
    assert.ok(inputs.includes(`floors=${path.resolve(staged.floors)}`));
    assert.ok(inputs.includes(`rooms=${path.resolve(staged.rooms)}`));
    assert.equal(result.doors.placements.length, 0);
    const leaf = result.rooms!.placements.find((item) => item.id === "B.r1.d1");
    assert.deepEqual(leaf, {
      id: "B.r1.d1",
      model: "door-1",
      position: [9.5, 0, 15.1],
      yaw: 0,
      hinge: "left",
      size: [1, 2.1, 0.08],
      open: false,
    });
    assert.equal(result.rooms!.placements.some((item) => item.id === "B.r2.d1"), true);
    const staticBoxes = [...result.file.obstacles, ...result.rooms!.obstacles];
    const door = leaf as DoorPlacement;
    const doorHits = staticBoxes.filter((item) => hits(item, doorwayClear(door))).map((item) => item.id);
    assert.deepEqual(doorHits, []);
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("an interior room door is not a shared punch", () => {
  const shell: Obstacle = { id: "B-wall-0", kind: "aabb", min: [0, 0, 0], max: [4, 3, 0.2] };
  const partition: Obstacle = { id: "B.room.front", kind: "aabb", min: [0, 0, 3.8], max: [4, 3, 4.2] };
  const facade = pendingDoor("B.facade", [2, 0, 0.2], { min: [0, 0, 0], max: [4, 3, 0.2] });
  const interior = pendingDoor("B.inside", [2, 0, 4], { min: [0, 0, 3.8], max: [4, 3, 4.2] });
  const lines: string[] = [];
  const placed = placeRoomDoors([facade, interior], [], new Map(), lines, {
    buildingId: "B",
    rooms: [partition],
    buildings: [shell],
  });
  assert.deepEqual(placed.placements.map((door) => door.id), ["B.facade", "B.inside"]);
  assert.deepEqual(placed.wallCuts.map((cut) => cut.id), ["B.facade"]);
  assert.deepEqual(lines, []);
  const local = placed.wallCuts[0]!.local;
  assert.ok(local.maxZ - local.minZ > 0.1, `wall cut depth ${local.maxZ - local.minZ}`);
  assert.ok(local.maxZ <= 0.2 + 1e-6 && local.minZ >= -2 - 1e-6);
});

test("a room door cuts 1 m into a deep building box and warns", () => {
  const buildings: Obstacle[] = [{ id: "B-wall-0", kind: "aabb", min: [0, 0, 0], max: [4, 3, 6] }];
  const host = { min: [0, 0, 0] as Vec3, max: [4, 3, 0.2] as Vec3 };
  const lines: string[] = [];
  placeRoomDoors([pendingDoor("B.inside", [2, 0, 0.2], host)], [], new Map(), lines, {
    buildingId: "B",
    rooms: [],
    buildings,
  });
  assert.deepEqual(lines, [
    'warning: room door "B.inside" meets building box "B-wall-0" 5.8 m deep; cut capped at 1 m',
  ]);
  const covered = (x: number, z: number): boolean => buildings.some((box) => covers(box, [x, 1, z]));
  assert.equal(covered(2, 0.6), false);
  assert.equal(covered(2, 2), true);
  assert.equal(covered(2, 5), true);
  assert.equal(covered(0.5, 0.5), true);
});

function pendingDoor(id: string, center: Vec3, host: { min: Vec3; max: Vec3 }): PendingRoomDoor {
  const sceneDoor: SceneDoor = {
    id,
    model: "door-1",
    building: "B",
    center,
    minX: center[0] - 0.5,
    maxX: center[0] + 0.5,
    minZ: center[2] - 0.1,
    maxZ: center[2] + 0.1,
    hinge: "left",
    width: 1,
    height: 2.1,
    open: false,
  };
  return {
    id,
    width: 1,
    height: 2.1,
    along: "x",
    spanMin: center[0] - 0.5,
    spanMax: center[0] + 0.5,
    face: center[2],
    normal: { x: 0, z: 1 },
    sceneDoor,
    host,
    file: "room.room.json",
  };
}

test("an interior door several metres inside does not punch the facade", () => {
  const staged = stage();
  try {
    const svgPath = path.join(staged.rooms, "rm.svg");
    writeFileSync(svgPath, roomSvg("front", true));
    writeRoom({ svgPath, outPath: path.join(staged.rooms, "rm.glb") });
    writeFileSync(
      path.join(staged.models, "blk.glb"),
      writeTriangleGlb("blk", trianglesFromBox([-0.5, 0, -0.5], [0.5, 0.6, 0.5])),
    );
    const result = bake({
      svgPath: staged.svg,
      outPath: staged.out,
      collisionDir: staged.collision,
      modelsDir: staged.models,
      floorsDir: staged.floors,
      roomsDir: staged.rooms,
      ...(staged.game ? { gamePath: staged.game } : {}),
    });
    const opens = result.lines.filter((line) => line.startsWith("cut-open blk "));
    assert.equal(opens.some((line) => line.includes("source=room")), false, opens.join("\n"));
    assert.equal(opens.length, 1, opens.join("\n"));
    assert.match(opens[0]!, /id=B\.front /);
    assert.match(opens[0]!, /source=doors-external /);
    const depth = Number(opens[0]!.match(/depth=(\S+)/)?.[1]);
    assert.ok(depth > 0 && depth < 0.5, `exterior cut depth ${depth} is not the wall slab`);
    const leaf = result.rooms!.placements.find((item) => item.id === "B.r1.d2");
    assert.ok(leaf && "hinge" in leaf, "interior door leaf missing");
    assert.equal(result.doors.placements.some((item) => item.id === "B.r1.d2"), false);
    const building = result.file.placements.find((item) => item.id === "B");
    assert.ok(building);
    const gap = openingInModel(leaf as DoorPlacement, building.position, building.yaw, building.scale);
    const center = [(gap.minX + gap.maxX) / 2, (gap.minY + gap.maxY) / 2, (gap.minZ + gap.maxZ) / 2];
    const cut = trianglesFromGlb(readFileSync(path.join(staged.models, "blk.cut.glb"))).triangles;
    const source = trianglesFromGlb(readFileSync(path.join(staged.models, "blk.glb"))).triangles;
    const facadeZ = -0.5;
    assert.ok(rayHitsZ(source, center, facadeZ - 0.05, facadeZ + 0.05) > 0, "fixture facade has no triangles behind the interior door");
    assert.ok(
      rayHitsZ(cut, center, facadeZ - 0.05, facadeZ + 0.05) > 0,
      `facade tris removed behind the interior door at ${center.map((n) => n.toFixed(3)).join(",")}`,
    );
    const exterior = aabbOf(opens[0]!);
    const doorCenter = [
      (exterior.minX + exterior.maxX) / 2,
      (exterior.minY + exterior.maxY) / 2,
      (exterior.minZ + exterior.maxZ) / 2,
    ];
    assert.ok(rayHitsZ(source, doorCenter, 0.45, 0.55) > 0, "exterior doorway has no source triangles");
    assert.equal(rayHitsZ(cut, doorCenter, 0.45, 0.55), 0, "exterior door did not cut the facade");
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("an interior door facing a hall 4 m from the facade leaves the shell", () => {
  const staged = stage();
  try {
    const svgPath = path.join(staged.rooms, "rm.svg");
    writeFileSync(svgPath, roomSvg("front", true));
    writeRoom({ svgPath, outPath: path.join(staged.rooms, "rm.glb") });
    // 12 m shell. Shift the 6 m room so its back door sits 4 m from the inner south face.
    writeFileSync(
      path.join(staged.floors, "blk.floors.svg"),
      floorsSvg(-0.5, 1, 6, { doors: false })
        .replaceAll("matrix(10,0,0,10,0,0)", "matrix(12,0,0,12,0,0)")
        .replaceAll('y="-4.9"', 'y="-4.7"'),
    );
    writeFileSync(staged.svg, sceneSvg({ x: 4, y: 24, w: 12, h: 12 }, 0));
    const result = run(staged);
    assert.equal(
      result.lines.some((line) => line.startsWith("warning: room door")),
      false,
      result.lines.filter((line) => line.startsWith("warning:")).join("\n"),
    );
    const walls = result.file.obstacles.filter((item) => item.id.startsWith("B-wall-"));
    const leaf = result.rooms!.placements.find((item) => item.id === "B.r1.d2");
    assert.ok(leaf && "hinge" in leaf, "interior door leaf missing");
    const door = leaf as DoorPlacement;
    assert.equal(door.yaw, 180);
    assert.deepEqual(door.position, [10.5, 0, 8.5]);
    const covered = (localZ: number): boolean => walls.some((box) => covers(box, doorPoint(door, localZ, 1)));
    for (let localZ = 0.25; localZ <= 3.9; localZ += 0.25) {
      assert.equal(covered(localZ), false, `hall at ${localZ} m`);
    }
    assert.equal(covered(4.15), true, "facade 4 m out is still solid");
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

function doorPoint(door: DoorPlacement, localZ: number, localY: number): Vec3 {
  const [width] = door.size;
  const midX = door.hinge === "left" ? width / 2 : -width / 2;
  return placeBox({
    minX: midX,
    maxX: midX,
    minY: localY,
    maxY: localY,
    minZ: localZ,
    maxZ: localZ,
  }, door.position, door.yaw).min;
}

test("a room door on the building wall does not punch the shared mesh", () => {
  const staged = stage();
  try {
    writeFileSync(path.join(staged.floors, "blk.floors.svg"), floorsSvg(-0.5, 1, 6, { doors: false }));
    writeFileSync(
      path.join(staged.models, "blk.glb"),
      writeTriangleGlb("blk", trianglesFromBox([-0.5, 0, -0.5], [0.5, 0.6, 0.5])),
    );
    const result = bake({
      svgPath: staged.svg,
      outPath: staged.out,
      collisionDir: staged.collision,
      modelsDir: staged.models,
      floorsDir: staged.floors,
      roomsDir: staged.rooms,
      ...(staged.game ? { gamePath: staged.game } : {}),
    });
    const opens = result.lines.filter((line) => line.startsWith("cut-open blk "));
    assert.deepEqual(opens, []);
    assert.equal(result.lines.includes("cut-shared blk 0"), true);
    assert.equal(result.lines.some((line) => line.startsWith("cut-tris ")), false);
    assert.equal(existsSync(path.join(staged.models, "blk.cut.glb")), false);
    const leaf = result.rooms!.placements.find((item) => item.id === "B.r1.d1");
    assert.ok(leaf && "hinge" in leaf, "room door leaf missing");
    const source = trianglesFromGlb(readFileSync(path.join(staged.models, "blk.glb"))).triangles;
    assert.ok(rayHitsZ(source, [0, 0.1, 0]) > 0, "source facade has no triangles");
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

function aabbOf(line: string): { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } {
  const raw = line.slice(line.indexOf("aabb=") + "aabb=".length).split(",").map(Number);
  return { minX: raw[0]!, maxX: raw[1]!, minY: raw[2]!, maxY: raw[3]!, minZ: raw[4]!, maxZ: raw[5]! };
}

/** Hits of a −Z ray whose Z lies in [z0, z1]. Omit the range to count every hit. */
function rayHitsZ(tris: Vec3[][], center: number[], z0 = -Infinity, z1 = Infinity): number {
  const origin: Vec3 = [center[0]!, center[1]!, 2];
  const dir: Vec3 = [0, 0, -1];
  let count = 0;
  for (const [a, b, c] of tris) {
    if (!a || !b || !c) continue;
    const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const p: Vec3 = [dir[1] * ac[2] - dir[2] * ac[1], dir[2] * ac[0] - dir[0] * ac[2], dir[0] * ac[1] - dir[1] * ac[0]];
    const det = ab[0] * p[0] + ab[1] * p[1] + ab[2] * p[2];
    if (Math.abs(det) < 1e-10) continue;
    const inv = 1 / det;
    const tvec: Vec3 = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]];
    const u = (tvec[0] * p[0] + tvec[1] * p[1] + tvec[2] * p[2]) * inv;
    if (u < -1e-5 || u > 1 + 1e-5) continue;
    const q: Vec3 = [tvec[1] * ab[2] - tvec[2] * ab[1], tvec[2] * ab[0] - tvec[0] * ab[2], tvec[0] * ab[1] - tvec[1] * ab[0]];
    const v = (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2]) * inv;
    if (v < -1e-5 || u + v > 1 + 1e-5) continue;
    const t = (ac[0] * q[0] + ac[1] * q[1] + ac[2] * q[2]) * inv;
    const z = origin[2] + dir[2] * t;
    if (t > 1e-4 && z >= z0 - 1e-4 && z <= z1 + 1e-4) count += 1;
  }
  return count;
}

test("a moved floors exterior is the only shared opening", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-move-door-"));
  try {
    const floors = path.join(dir, "floors");
    const models = path.join(dir, "models");
    mkdirSync(floors);
    mkdirSync(models);
    writeFileSync(path.join(models, "door-1.glb"), writeGlb(
      [{ name: "door", triangles: trianglesFromBox([0, 0, 0], [1, 2.1, 0.08]) }],
      [{ name: "door", mesh: "door" }],
    ));
    const svg = path.join(dir, "plan.svg");
    writeFileSync(svg, sceneSvg({ x: 5, y: 25, w: 10, h: 10 }, 0));
    const bakeAt = (doorX: number) => {
      writeFileSync(path.join(floors, "blk.floors.svg"), floorsSvg(doorX, 1, 6, { rooms: false }));
      return bake({
        svgPath: svg,
        outPath: path.join(dir, "out", "buildings.placements.json"),
        collisionDir: path.join(dir, "collision"),
        modelsDir: models,
        walls: WALLS,
        floorsDir: floors,
      });
    };
    const first = bakeAt(-0.5);
    const second = bakeAt(1.5);
    const opens = (lines: readonly string[]) => lines.filter((line) => line.startsWith("cut-open blk "));
    const before = opens(first.lines);
    const after = opens(second.lines);
    assert.equal(before.length, 1, first.lines.join("\n"));
    assert.equal(after.length, 1, second.lines.join("\n"));
    assert.match(before[0]!, /id=B\.front /);
    assert.match(before[0]!, /source=doors-external /);
    assert.match(before[0]!, /blk\.floors\.svg/);
    assert.match(after[0]!, /source=doors-external /);
    const aabb = (line: string) => line.slice(line.indexOf("aabb="));
    assert.notEqual(aabb(before[0]!), aabb(after[0]!));
    assert.equal(after.some((line) => line.includes(aabb(before[0]!))), false);
    assert.equal(first.lines.includes("cut-shared blk 1"), true);
    assert.equal(second.lines.includes("cut-shared blk 1"), true);
    assert.equal(second.doors.placements.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a room door merged with an external is one shared opening", () => {
  const staged = stage();
  try {
    const result = run(staged);
    const opens = result.lines.filter((line) => line.startsWith("cut-open blk "));
    assert.equal(opens.length, 1, result.lines.filter((line) => line.startsWith("cut-")).join("\n"));
    assert.match(opens[0]!, /id=B\.front /);
    assert.match(opens[0]!, /source=doors-external /);
    assert.match(opens[0]!, /blk\.floors\.svg/);
    assert.equal(result.lines.includes("cut-shared blk 1"), true);
    assert.equal(result.lines.some((line) => line.startsWith("cut-open") && line.includes(".d1")), false);
    assert.equal(result.rooms!.placements.some((item) => item.id === "B.r1.d1"), false);
    assert.equal(result.doors.placements.filter((item) => item.id === "B.front").length, 1);
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("a room door on the footprint edge is a facade opening", () => {
  const report = roomFacadeOpenings(facadePlan(0, 2.8, 0), new Map([["rm", facadeRoom(["front", "back"])]]));
  assert.equal(report.openings.length, 1);
  const front = report.openings[0]!;
  assert.equal(front.doorId, "front");
  assert.equal(front.axis, 2);
  assert.ok(Math.abs(front.distance - 0.2) < 1e-6, String(front.distance));
  assert.ok(Math.abs(front.box.minZ - 0.48) < 1e-6, String(front.box.minZ));
  assert.ok(Math.abs(front.box.maxZ - 0.505) < 1e-6, String(front.box.maxZ));
  assert.ok(Math.abs(front.box.minX - -0.05) < 1e-6 && Math.abs(front.box.maxX - 0.05) < 1e-6);
  assert.ok(Math.abs(front.box.minY) < 1e-6 && Math.abs(front.box.maxY - 0.2) < 1e-6);
  assert.equal(report.rejected.find((item) => item.doorId === "back")?.reason, "inner wall");
});

test("a room instance yawed 90 cuts the side the front wall lands on", () => {
  const report = roomFacadeOpenings(facadePlan(2.8, 0, 90), new Map([["rm", facadeRoom(["front"])]]));
  assert.equal(report.openings.length, 1, JSON.stringify(report.rejected));
  const front = report.openings[0]!;
  assert.equal(front.axis, 0);
  assert.ok(Math.abs(front.distance - 0.2) < 1e-6, String(front.distance));
  assert.ok(Math.abs(front.box.minX - 0.48) < 1e-6, String(front.box.minX));
  assert.ok(Math.abs(front.box.maxX - 0.505) < 1e-6, String(front.box.maxX));
  assert.ok(Math.abs(front.box.minZ - -0.05) < 1e-6 && Math.abs(front.box.maxZ - 0.05) < 1e-6);
});

test("a room set back 1.5 m is rejected for distance", () => {
  const report = roomFacadeOpenings(facadePlan(0, 1.5, 0), new Map([["rm", facadeRoom(["front"])]]));
  assert.deepEqual(report.openings, []);
  assert.equal(report.rejected[0]?.reason, "distance");
  assert.ok(Math.abs((report.rejected[0]?.distance ?? 0) - 1.5) < 1e-6, String(report.rejected[0]?.distance));
});

test("a door whose span leaves the footprint edge is rejected for span", () => {
  const report = roomFacadeOpenings(facadePlan(5.2, 2.8, 0), new Map([["rm", facadeRoom(["front"])]]));
  assert.deepEqual(report.openings, []);
  assert.equal(report.rejected[0]?.reason, "span");
});

test("a facade room door cuts its rectangle and an inner door does not", () => {
  const staged = facadeStage({ centerZ: 2.8, back: true });
  try {
    const result = runFacade(staged);
    const opens = result.lines.filter((line) => line.startsWith("cut-open blk "));
    const skips = result.lines.filter((line) => line.startsWith("cut-skip blk "));
    assert.equal(opens.length, 1, result.lines.filter((line) => line.startsWith("cut-")).join("\n"));
    assert.match(opens[0]!, /source=room:rm\/front /);
    assert.match(opens[0]!, /distance=0\.2000/);
    assert.equal(skips.some((line) => /source=room:rm\/back /.test(line) && /reason=inner wall/.test(line)), true, skips.join("\n"));
    const cut = trianglesFromGlb(readFileSync(path.join(staged.models, "blk.cut.glb"))).triangles;
    const source = trianglesFromGlb(readFileSync(path.join(staged.models, "blk.glb"))).triangles;
    assert.ok(rayHitsZ(source, [0, 0.1, 0], 0.45, 0.55) > 0, "north facade missing");
    assert.equal(rayHitsZ(cut, [0, 0.1, 0], 0.45, 0.55), 0, "door rectangle still has facade tris");
    assert.ok(rayHitsZ(cut, [0.2, 0.1, 0], 0.45, 0.55) > 0, "facade removed beside the door");
    assert.ok(rayHitsZ(cut, [0, 0.1, 0], -0.55, -0.45) > 0, "inner door removed south facade tris");
    assert.ok(rayHitsX(cut, [0, 0.1, 0], 0.45, 0.55) > 0, "east facade was cut");
    const shell = result.file.obstacles.find((item) => item.id.startsWith("B-wall-"));
    assert.ok(shell, result.file.obstacles.map((item) => item.id).join(","));
    assert.equal(result.file.obstacles.some((item) => covers(item, [50, 1, 54.9])), false, "doorway still solid");
    assert.equal(result.file.obstacles.some((item) => covers(item, [53, 1, 54.9])), true, "shell beside the door is gone");
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("a yaw-90 room instance cuts the east edge", () => {
  const staged = facadeStage({ centerX: 2.8, centerZ: 0, yaw: 90 });
  try {
    const result = runFacade(staged);
    const opens = result.lines.filter((line) => line.startsWith("cut-open blk "));
    assert.equal(opens.length, 1, opens.join("\n"));
    assert.match(opens[0]!, /source=room:rm\/front /);
    const cut = trianglesFromGlb(readFileSync(path.join(staged.models, "blk.cut.glb"))).triangles;
    assert.equal(rayHitsX(cut, [0, 0.1, 0], 0.45, 0.55), 0, "east edge still has tris in the door");
    assert.ok(rayHitsX(cut, [0, 0.1, 0.2], 0.45, 0.55) > 0, "east edge removed beside the door");
    assert.ok(rayHitsZ(cut, [0, 0.1, 0], 0.45, 0.55) > 0, "north facade was cut");
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("a room set back 1.5 m does not cut and is logged as distance", () => {
  const staged = facadeStage({ centerZ: 1.5 });
  try {
    const result = runFacade(staged);
    const opens = result.lines.filter((line) => line.startsWith("cut-open blk "));
    const skips = result.lines.filter((line) => line.startsWith("cut-skip blk "));
    assert.deepEqual(opens, []);
    assert.equal(skips.some((line) => /reason=distance/.test(line) && /distance=1\.5000/.test(line)), true, skips.join("\n"));
    assert.equal(existsSync(path.join(staged.models, "blk.cut.glb")), false);
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("the same opening from doors-external and a room door is one box", () => {
  const staged = facadeStage({
    centerZ: 2.8,
    exterior: `<rect id="front" inkscape:label="model:door-1" x="9.5" y="4.9" width="1" height="0.2"/>`,
  });
  try {
    writeFileSync(path.join(staged.models, "door-1.glb"), writeGlb(
      [{ name: "door", triangles: trianglesFromBox([0, 0, 0], [1, 2.1, 0.08]) }],
      [{ name: "door", mesh: "door" }],
    ));
    const result = runFacade(staged);
    const opens = result.lines.filter((line) => line.startsWith("cut-open blk "));
    assert.equal(opens.length, 1, result.lines.filter((line) => line.startsWith("cut-")).join("\n"));
    assert.match(opens[0]!, /source=doors-external /);
    assert.equal(opens.some((line) => line.includes("source=room:")), false);
    assert.equal(result.lines.includes("cut-shared blk 1"), true);
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("a room door on a floor's notch edge is an opening, and each floor uses its own outline", () => {
  const rooms = new Map([["rm", facadeRoom(["front"])]]);
  const square: Array<[number, number]> = [[-5, -5], [5, -5], [5, 5], [-5, 5]];
  const plan = facadePlan(0, 0, 0);
  const report = roomFacadeOpenings({
    ...plan,
    footprint: square,
    outline: square,
    floors: [
      {
        n: 1,
        name: "floor-1",
        elevation: 0,
        footprint: square,
        outline: eastNotch(3, -2, 2),
        rooms: [{ id: "r1", prefab: "rm", center: { x: 0.8, z: 0 }, yaw: 90, drawnWidth: 4, drawnDepth: 4 }],
        platforms: [],
      },
      {
        n: 2,
        name: "floor-2",
        elevation: 3,
        footprint: square,
        outline: eastNotch(1, -2, 2),
        rooms: [{ id: "r2", prefab: "rm", center: { x: -1.2, z: 0 }, yaw: 90, drawnWidth: 4, drawnDepth: 4 }],
        platforms: [],
      },
    ],
  }, rooms);
  assert.equal(report.openings.length, 2, JSON.stringify(report.rejected));
  const floor1 = report.openings.find((item) => item.id === "r1.front");
  const floor2 = report.openings.find((item) => item.id === "r2.front");
  assert.ok(floor1 && floor2);
  assert.equal(floor1.outward, 1);
  assert.equal(floor2.outward, 1);
  assert.ok(Math.abs(floor1.distance - 0.2) < 1e-6, String(floor1.distance));
  assert.ok(Math.abs(floor2.distance - 0.2) < 1e-6, String(floor2.distance));
  assert.ok(Math.abs(floor1.box.minX - 0.28) < 1e-6 && Math.abs(floor1.box.maxX - 0.305) < 1e-6);
  assert.ok(Math.abs(floor2.box.minX - 0.08) < 1e-6 && Math.abs(floor2.box.maxX - 0.105) < 1e-6);
  const againstAabb = roomFacadeOpenings(facadePlan(0.8, 0, 90), rooms);
  assert.deepEqual(againstAabb.openings, []);
  assert.equal(againstAabb.rejected[0]?.reason, "distance");
  assert.ok(Math.abs((againstAabb.rejected[0]?.distance ?? 0) - 2.2) < 1e-6, String(againstAabb.rejected[0]?.distance));
});

test("a door on a notch edge's line but outside its span is not opened by that edge", () => {
  const rooms = new Map([["rm", facadeRoom(["front"])]]);
  const square: Array<[number, number]> = [[-5, -5], [5, -5], [5, 5], [-5, 5]];
  const plan = facadePlan(0, 0, 0);
  const report = roomFacadeOpenings({
    ...plan,
    footprint: square,
    outline: square,
    floors: [{
      n: 1,
      name: "floor-1",
      elevation: 0,
      footprint: square,
      outline: eastNotch(4, -1, 1),
      rooms: [{ id: "r1", prefab: "rm", center: { x: 2.2, z: 3 }, yaw: 90, drawnWidth: 4, drawnDepth: 4 }],
      platforms: [],
    }],
  }, rooms);
  assert.deepEqual(report.openings, []);
  assert.equal(report.rejected[0]?.reason, "distance");
  assert.ok(Math.abs((report.rejected[0]?.distance ?? 0) - 0.8) < 1e-6, String(report.rejected[0]?.distance));
});

test("a mesh facade 0.6 m past the outline is cut, and one 1.5 m past is not", () => {
  const near = facadeStage({ centerZ: 2.8, lipM: 0.6 });
  const far = facadeStage({ centerZ: 2.8, lipM: 1.5 });
  try {
    const nearResult = runFacade(near);
    const opens = nearResult.lines.filter((line) => line.startsWith("cut-open blk "));
    assert.equal(opens.length, 1, nearResult.lines.filter((line) => line.startsWith("cut-")).join("\n"));
    assert.match(opens[0]!, /source=room:rm\/front /);
    assert.ok(aabbOf(opens[0]!).maxZ > 0.56, opens[0]);
    const cut = trianglesFromGlb(readFileSync(path.join(near.models, "blk.cut.glb"))).triangles;
    assert.equal(rayHitsZ(cut, [0, 0.1, 0], 0.555, 0.57), 0, "door rectangle still has the outer facade");
    assert.ok(rayHitsZ(cut, [0.2, 0.1, 0], 0.555, 0.57) > 0, "outer facade removed beside the door");
    const farResult = runFacade(far);
    const farOpens = farResult.lines.filter((line) => line.startsWith("cut-open blk "));
    assert.equal(farOpens.length, 1, farResult.lines.filter((line) => line.startsWith("cut-")).join("\n"));
    assert.ok(Math.abs(aabbOf(farOpens[0]!).maxZ - 0.505) < 1e-4, farOpens[0]);
    const farCut = trianglesFromGlb(readFileSync(path.join(far.models, "blk.cut.glb"))).triangles;
    assert.ok(rayHitsZ(farCut, [0, 0.1, 0], 0.64, 0.66) > 0, "facade 1.5 m out was cut");
  } finally {
    rmSync(near.dir, { recursive: true, force: true });
    rmSync(far.dir, { recursive: true, force: true });
  }
});

test("a zero-thickness facade skin splits around the door and stays flat", () => {
  const building: Placement = {
    id: "B",
    model: "blk",
    position: [0, 0, 0],
    yaw: 0,
    scale: 1,
  };
  const obstacles: Obstacle[] = [{
    id: "B-wall-1",
    kind: "aabb",
    min: [5, 0, 0],
    max: [5, 4, 8],
  }];
  const door: LocalBox = {
    minX: 4.5,
    maxX: 5.5,
    minY: 0.2,
    maxY: 2.2,
    minZ: 3,
    maxZ: 4,
  };
  cutFacadeWalls(obstacles, building, [door]);
  assert.ok(obstacles.length >= 2, obstacles.map((item) => item.id).join(","));
  for (const piece of obstacles) {
    assert.equal(piece.min[0], 5);
    assert.equal(piece.max[0], 5);
    assert.equal(flatCovers(piece, [5, 1, 3.5]), false, JSON.stringify(piece));
  }
  assert.equal(obstacles.some((piece) => piece.max[2] <= 3 && piece.min[1] < 1 && piece.max[1] > 1), true);
  assert.equal(obstacles.some((piece) => piece.min[2] >= 4 && piece.min[1] < 1 && piece.max[1] > 1), true);
});

/** East outline with a rectangular notch. `insetX` is the notch face. */
function eastNotch(insetX: number, z0: number, z1: number): Array<[number, number]> {
  return [[-5, -5], [5, -5], [5, z0], [insetX, z0], [insetX, z1], [5, z1], [5, 5], [-5, 5]];
}

/** True when `point` lies in the piece on every axis that has thickness. */
function flatCovers(obstacle: Obstacle, point: Vec3): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if (!(obstacle.max[axis]! > obstacle.min[axis]!)) continue;
    if (point[axis]! <= obstacle.min[axis]! || point[axis]! >= obstacle.max[axis]!) return false;
  }
  return true;
}

function facadePlan(x: number, z: number, yaw: 0 | 90 | 180 | 270): FloorsSource {
  return {
    model: "blk",
    scale: 10,
    yaw: 0,
    origin: [0, 0, 0],
    footprint: [[-5, -5], [5, -5], [5, 5], [-5, 5]],
    outline: [[-5, -5], [5, -5], [5, 5], [-5, 5]],
    floors: [{
      n: 1,
      name: "floor-1",
      elevation: 0,
      outline: [[-5, -5], [5, -5], [5, 5], [-5, 5]],
      footprint: [[-5, -5], [5, -5], [5, 5], [-5, 5]],
      rooms: [{ id: "r1", prefab: "rm", center: { x, z }, yaw, drawnWidth: 4, drawnDepth: 4 }],
      platforms: [],
    }],
    doors: [],
    props: [],
    stairs: [],
    elevators: [],
  };
}

function facadeRoom(walls: readonly ("front" | "back")[]): RoomFile {
  return {
    formatVersion: 1,
    units: "meters",
    id: "rm",
    glb: "rm.glb",
    source: "svg",
    footprint: { minX: -2, maxX: 2, minZ: -2, maxZ: 2 },
    height: 3,
    obstacles: [],
    walkable: [],
    holes: [],
    doors: walls.map((wall) => ({
      id: wall,
      model: "door-1",
      wall,
      center: wall === "front" ? [0, 0, 2] : [0, 0, -2],
      width: 1,
      height: 2,
      hinge: "left" as const,
      open: false,
    })),
    props: [],
    lights: [],
  };
}

function facadeStage(opts: {
  centerX?: number;
  centerZ?: number;
  yaw?: 0 | 90;
  back?: boolean;
  exterior?: string;
  /**
   * World metres a thin sheet sits outside the +Z stencil edge. The sheet
   * misses the 0.05 measure-cell centres, so the group scale still matches
   * the footprint.
   */
  lipM?: number;
}): Stage {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-facade-"));
  const floors = path.join(dir, "floors");
  const rooms = path.join(dir, "rooms");
  const models = path.join(dir, "models");
  mkdirSync(floors);
  mkdirSync(rooms);
  mkdirSync(models);
  const cx = opts.centerX ?? 0;
  const cz = opts.centerZ ?? 2.8;
  const yaw = opts.yaw ?? 0;
  const sx = 10 + cx;
  const sy = 10 - cz;
  const yawAttr = yaw === 0 ? "" : ` data-yaw="${yaw}"`;
  const room = `<rect id="r1" inkscape:label="model:rm" x="${sx - 2}" y="${sy - 2}" width="4" height="4"${yawAttr}/>`;
  writeFileSync(path.join(floors, "blk.floors.svg"), `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
     width="20mm" height="20mm" viewBox="0 0 20 20">
  <sodipodi:namedview inkscape:document-units="mm"/>
  <g inkscape:groupmode="layer" inkscape:label="floor-1">
    <g id="fp1" data-model="blk" transform="matrix(10,0,0,10,10,10)"><path d="M -0.5 -0.5 L 0.5 -0.5 L 0.5 0.5 L -0.5 0.5 Z"/></g>
    ${room}
  </g>
  <g inkscape:groupmode="layer" inkscape:label="doors-external">${opts.exterior ?? ""}</g>
</svg>`);
  const doors = opts.back
    ? [facadeRoom(["front", "back"]).doors[0]!, facadeRoom(["front", "back"]).doors[1]!]
    : facadeRoom(["front"]).doors;
  writeFileSync(path.join(rooms, "rm.room.json"), `${JSON.stringify({ ...facadeRoom(["front"]), doors })}\n`);
  const tris = trianglesFromBox([-0.5, 0, -0.5], [0.5, 1, 0.5]);
  if (opts.lipM !== undefined && opts.lipM > 0) {
    const z0 = 0.5 + opts.lipM / 10;
    tris.push(...trianglesFromBox([-0.5, 0, z0], [0.5, 1, z0 + 0.001]));
  }
  writeFileSync(path.join(models, "blk.glb"), writeTriangleGlb("blk", tris));
  const svg = path.join(dir, "plan.svg");
  writeFileSync(svg, `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
     width="100mm" height="100mm" viewBox="0 0 100 100">
  <sodipodi:namedview inkscape:document-units="mm"/>
  <g inkscape:groupmode="layer" inkscape:label="bounds"><rect id="yard" x="0" y="0" width="100" height="100"/></g>
  <g inkscape:groupmode="layer" inkscape:label="buildings">
    <g id="B" data-model="blk" transform="matrix(10 0 0 10 50 50)"><path d="M -0.5 -0.5 L 0.5 -0.5 L 0.5 0.5 L -0.5 0.5 Z"/></g>
  </g>
</svg>`);
  return { dir, svg, floors, rooms, models, out: path.join(dir, "out", "buildings.placements.json"), collision: path.join(dir, "collision") };
}

function runFacade(staged: Stage) {
  return bake({
    svgPath: staged.svg,
    outPath: staged.out,
    collisionDir: staged.collision,
    modelsDir: staged.models,
    floorsDir: staged.floors,
    roomsDir: staged.rooms,
  });
}

/** Hits of a +X ray whose X lies in [x0, x1]. */
function rayHitsX(tris: Vec3[][], center: number[], x0: number, x1: number): number {
  const origin: Vec3 = [-2, center[1]!, center[2]!];
  const dir: Vec3 = [1, 0, 0];
  let count = 0;
  for (const [a, b, c] of tris) {
    if (!a || !b || !c) continue;
    const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const p: Vec3 = [dir[1] * ac[2] - dir[2] * ac[1], dir[2] * ac[0] - dir[0] * ac[2], dir[0] * ac[1] - dir[1] * ac[0]];
    const det = ab[0] * p[0] + ab[1] * p[1] + ab[2] * p[2];
    if (Math.abs(det) < 1e-10) continue;
    const inv = 1 / det;
    const tvec: Vec3 = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]];
    const u = (tvec[0] * p[0] + tvec[1] * p[1] + tvec[2] * p[2]) * inv;
    if (u < -1e-5 || u > 1 + 1e-5) continue;
    const q: Vec3 = [tvec[1] * ab[2] - tvec[2] * ab[1], tvec[2] * ab[0] - tvec[0] * ab[2], tvec[0] * ab[1] - tvec[1] * ab[0]];
    const v = (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2]) * inv;
    if (v < -1e-5 || u + v > 1 + 1e-5) continue;
    const t = (ac[0] * q[0] + ac[1] * q[1] + ac[2] * q[2]) * inv;
    const x = origin[0] + dir[0] * t;
    if (t > 1e-4 && x >= x0 - 1e-4 && x <= x1 + 1e-4) count += 1;
  }
  return count;
}

test("a scene with no floors dir writes no rooms files", () => {
  const staged = stage();
  try {
    const result = run(staged, { floors: false });
    assert.equal(result.rooms, undefined);
    assert.equal(result.lights, undefined);
    assert.equal(existsSync(path.join(path.dirname(staged.out), "rooms.placements.json")), false);
    assert.equal(existsSync(path.join(path.dirname(staged.out), "rooms.lights.json")), false);
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("a copied stencil that fills its path uses the group scale, so the step meets the facade", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-align-"));
  try {
    const floors = path.join(dir, "floors");
    const rooms = path.join(dir, "rooms");
    mkdirSync(floors);
    mkdirSync(rooms);
    writeFileSync(path.join(floors, "blk.floors.svg"), alignFloors());
    writeFileSync(path.join(rooms, "rm.room.json"), `${JSON.stringify({
      formatVersion: 1,
      units: "meters",
      id: "rm",
      glb: "rm.glb",
      source: "svg",
      footprint: { minX: -3, maxX: 3, minZ: -3, maxZ: 3 },
      height: 3,
      obstacles: [],
      walkable: [],
      holes: [],
      doors: [],
      props: [],
      lights: [],
    })}\n`);
    const result = bake({
      svgPath: writeScene(dir),
      outPath: path.join(dir, "out", "buildings.placements.json"),
      collisionDir: path.join(dir, "collision"),
      floorsDir: floors,
      roomsDir: rooms,
      walls: { blk: trianglesFromBox([-0.5, 0, -0.5], [0.5, 3, 0.5]) },
    });
    const building = result.file.placements.find((item) => item.id === "B");
    assert.ok(building);
    assert.equal(building.scale, 10);
    assert.deepEqual(building.position, [50, 0, 50]);
    const meshWest = building.position[0] + -0.5 * building.scale;
    const meshEast = building.position[0] + 0.5 * building.scale;
    const meshSouth = building.position[2] + -0.5 * building.scale;
    const meshNorth = building.position[2] + 0.5 * building.scale;
    const stepBox = result.props.obstacles.find((item) => item.id === "B.step-box");
    assert.ok(stepBox);
    assert.ok(Math.abs(stepBox.max[0] - meshWest) < 1e-6, `step inner ${stepBox.max[0]} mesh ${meshWest}`);
    const room = result.rooms?.placements.find((item) => item.id === "B.r1");
    if (!room || !("scale" in room)) assert.fail("missing room placement");
    assert.equal(room.scale, 1);
    assert.ok(
      room.position[0] - 3 > meshWest
      && room.position[0] + 3 < meshEast
      && room.position[2] - 3 > meshSouth
      && room.position[2] + 3 < meshNorth,
      `room outside shell mesh ${meshWest}..${meshEast}`,
    );
    const report = result.lines.find((line) => line.startsWith("B: measure "));
    assert.ok(report, result.lines.join("\n"));
    assert.match(report, /measure -0\.5\.\.0\.5 × -0\.5\.\.0\.5 \(1×1\)/);
    assert.match(report, /stencil 1×1/);
    assert.match(report, /drawn 10×10/);
    assert.match(report, /scaleForPlacement 10 \(x 10 z 10\)/);
    assert.match(report, /floors\.scale 10$/);
    assert.equal(result.lines.some((line) => line.startsWith("warning:")), false, result.lines.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an undersized copied stencil keeps the group scale and fails against the footprint", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-undersize-"));
  try {
    const floors = path.join(dir, "floors");
    mkdirSync(floors);
    writeFileSync(path.join(floors, "blk.floors.svg"), alignFloors());
    assert.throws(
      () => bake({
        svgPath: writeScene(dir),
        outPath: path.join(dir, "out", "buildings.placements.json"),
        collisionDir: path.join(dir, "collision"),
        floorsDir: floors,
        walls: { blk: trianglesFromBox([-0.4, 0, -0.4], [0.4, 3, 0.4]) },
      }),
      (err: unknown) => {
        const message = messageOf(err);
        return /mesh differs from blk\.floors\.svg footprint at scale 10/.test(message)
          && /mesh 8\u00d78 m, footprint 10\u00d710 m/.test(message)
          && !/12\.5/.test(message);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a mesh lip past the measure path warns per axis and keeps the group scale", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-lip-"));
  try {
    const floors = path.join(dir, "floors");
    mkdirSync(floors);
    const pathD = "M -0.5 0.2 L 0.5 0.2 L 0.5 -0.2 L -0.5 -0.2 Z";
    writeFileSync(path.join(floors, "lip.floors.svg"), `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
     width="40mm" height="40mm" viewBox="0 0 40 40">
  <sodipodi:namedview inkscape:document-units="mm"/>
  <g inkscape:groupmode="layer" inkscape:label="floor-1">
    <g id="fp" data-model="lip" transform="matrix(30,0,0,30,0,0)"><path d="${pathD}"/></g>
  </g>
</svg>`);
    const svg = path.join(dir, "plan.svg");
    writeFileSync(svg, `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
     width="100mm" height="100mm" viewBox="0 0 100 100">
  <sodipodi:namedview inkscape:document-units="mm"/>
  <g inkscape:groupmode="layer" inkscape:label="bounds"><rect id="yard" x="0" y="0" width="100" height="100"/></g>
  <g inkscape:groupmode="layer" inkscape:label="buildings">
    <g id="B" data-model="lip" transform="matrix(30 0 0 30 50 50)"><path d="${pathD}"/></g>
  </g>
</svg>`);
    const result = bake({
      svgPath: svg,
      outPath: path.join(dir, "out", "buildings.placements.json"),
      collisionDir: path.join(dir, "collision"),
      floorsDir: floors,
      walls: {
        lip: [
          ...trianglesFromBox([-0.5, 0, -0.2], [0.5, 1, 0.2]),
          ...trianglesFromBox([-0.5, 0, -0.222], [0.5, 1, -0.2]),
        ],
      },
    });
    const building = result.file.placements.find((item) => item.id === "B");
    assert.ok(building);
    assert.equal(building.scale, 30);
    const warn = result.lines.find((line) => line.includes("not the model's proportions"));
    assert.ok(warn, result.lines.join("\n"));
    assert.match(warn, /scale x 30 from drawn 30 \/ mesh 1/);
    assert.match(warn, /z 28\.436 from drawn 12 \/ mesh 0\.422/);
    assert.match(warn, /using group scale 30/);
    const report = result.lines.find((line) => line.startsWith("B: measure "));
    assert.ok(report, result.lines.join("\n"));
    assert.match(report, /scaleForPlacement 30 \(x 30 z 28\.436019\)/);
    assert.match(report, /floors\.scale 30$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function alignFloors(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
     width="20mm" height="20mm" viewBox="0 0 20 20">
  <sodipodi:namedview inkscape:document-units="mm"/>
  <g inkscape:groupmode="layer" inkscape:label="floor-1">
    <g id="fp1" data-model="blk" transform="matrix(10,0,0,10,10,10)"><path d="M -0.5 -0.5 L 0.5 -0.5 L 0.5 0.5 L -0.5 0.5 Z"/></g>
    <rect id="r1" inkscape:label="model:rm" x="7" y="7" width="6" height="6"/>
  </g>
  <g inkscape:groupmode="layer" inkscape:label="stairs-external">
    <rect id="step" inkscape:label="model:step" x="4.6" y="9.5" width="0.4" height="1"/>
  </g>
</svg>`;
}

function writeScene(dir: string): string {
  const svg = path.join(dir, "plan.svg");
  writeFileSync(svg, `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     width="100mm" height="100mm" viewBox="0 0 100 100">
  <g inkscape:groupmode="layer" inkscape:label="bounds"><rect id="yard" x="0" y="0" width="100" height="100"/></g>
  <g inkscape:groupmode="layer" inkscape:label="buildings">
    <g id="B" data-model="blk" transform="matrix(10 0 0 10 50 50)"><path d="M -0.5 -0.5 L 0.5 -0.5 L 0.5 0.5 L -0.5 0.5 Z"/></g>
  </g>
</svg>`);
  return svg;
}

test("bake --help names --floors and --rooms", () => {
  const bin = path.join(import.meta.dirname, "..", "bin", "blueprint-scene");
  const cli = spawnSync(bin, ["bake", "--help"], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /--floors/);
  assert.match(cli.stdout, /--rooms/);
});

function floorsSvg(
  doorX: number,
  doorW: number,
  depth: number,
  extras: { doors?: boolean; rooms?: boolean } = {},
): string {
  // 10×10 m, shifted so the 6×6 room at local (0, 1.9) sits more than 0.6 m inside.
  // A room rect outside the outline is a PlanError. The old 0..10 triangle did not contain it.
  const fp = (id: string, z: string) =>
    `<g id="${id}" data-model="blk" transform="matrix(10,0,0,10,0,0)" ${z}><path d="M -0.4 0.2 L 0.6 0.2 L 0.6 -0.8 L -0.4 -0.8 Z"/></g>`;
  const room = (id: string) => extras.rooms === false
    ? ""
    : `<rect id="${id}" inkscape:label="model:rm" x="-3" y="-4.9" width="6" height="${depth}"/>`;
  const door = extras.doors === false
    ? ""
    : `<rect id="front" inkscape:label="model:door-1" x="${doorX}" y="-5.2" width="${doorW}" height="0.2"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
     width="20mm" height="20mm" viewBox="0 0 20 20">
  <sodipodi:namedview inkscape:document-units="mm"/>
  <g inkscape:groupmode="layer" inkscape:label="floor-1">${fp("fp1", "")}${room("r1")}</g>
  <g inkscape:groupmode="layer" inkscape:label="floor-2">${fp("fp2", 'z="3"')}${room("r2")}</g>
  <g inkscape:groupmode="layer" inkscape:label="doors-external">
    ${door}
  </g>
  <g inkscape:groupmode="layer" inkscape:label="stairs-external">
    <rect id="step" inkscape:label="model:step" x="2" y="-2" width="1" height="1"/>
  </g>
</svg>`;
}

function sceneSvg(building: { x: number; y: number; w: number; h: number }, yaw: 0 | 90): string {
  const yawAttr = yaw === 0 ? "" : ` data-yaw="${yaw}"`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
     width="40mm" height="40mm" viewBox="0 0 40 40">
  <sodipodi:namedview inkscape:document-units="mm"/>
  <g inkscape:groupmode="layer" inkscape:label="bounds"><rect id="yard" x="0" y="0" width="40" height="40"/></g>
  <g inkscape:groupmode="layer" inkscape:label="buildings">
    <rect id="B" data-model="blk" x="${building.x}" y="${building.y}" width="${building.w}" height="${building.h}"${yawAttr}/>
  </g>
</svg>`;
}

function roomSvg(doorWall: "front" | "left" = "front", backDoor = false): string {
  const door = doorWall === "front"
    ? `<rect id="d1" inkscape:label="model:door-1" data-wall="front" x="4.5" y="7.9" width="1" height="0.2"/>`
    : `<rect id="d1" inkscape:label="model:door-1" data-wall="left" x="1.9" y="10.5" width="0.2" height="1"/>`;
  const back = backDoor
    ? `<rect id="d2" inkscape:label="model:door-1" data-wall="back" x="4.5" y="13.9" width="1" height="0.2"/>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:xlink="http://www.w3.org/1999/xlink"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
     width="20mm" height="20mm" viewBox="0 0 20 20">
  <sodipodi:namedview inkscape:document-units="mm" inkscape:document-scale="1"/>
  <g inkscape:groupmode="layer" inkscape:label="01_floor">
    <image id="floor" href="${TEX}" preserveAspectRatio="none" x="2" y="8" width="6" height="6"/>
  </g>
  <g inkscape:groupmode="layer" inkscape:label="walls">
    <image id="front" inkscape:label="front" href="${TEX}" preserveAspectRatio="none" x="2" y="5" width="6" height="3"/>
    <image id="left" inkscape:label="left" href="${TEX}" preserveAspectRatio="none" x="-14" y="-1" width="6" height="3" transform="rotate(-90)"/>
  </g>
  <g inkscape:groupmode="layer" inkscape:label="doors">
    ${door}
    ${back}
  </g>
  <g inkscape:groupmode="layer" inkscape:label="lights">
    <circle id="lamp-el" inkscape:label="light:lamp" cx="5" cy="11" r="0.2" z="2"/>
    <rect id="panel-el" inkscape:label="light:panel" x="4.5" y="10.5" width="1" height="0.5" data-width="1" data-height="0.5"/>
  </g>
</svg>`;
}
