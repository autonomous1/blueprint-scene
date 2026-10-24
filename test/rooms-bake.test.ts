import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bake } from "../src/bake.ts";
import { PlanError } from "../src/errors.ts";
import { readFloorsSvg } from "../src/floors-svg.ts";
import type { RoomFile } from "../src/room-file.ts";
import { writeRoom } from "../src/room-glb.ts";
import type { Obstacle, Vec3 } from "../src/types.ts";
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
  /** Room-prefab door wall. `left` leaves the facade wall solid until the external door cuts it. */
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
    assert.deepEqual(result.rooms!.placements, [
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
      result.file.obstacles.some((item) => covers(item, [6, 1, 10])),
      true,
      JSON.stringify(result.file.obstacles),
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

test("bake --help names --floors and --rooms", () => {
  const bin = path.join(import.meta.dirname, "..", "bin", "blueprint-scene");
  const cli = spawnSync(bin, ["bake", "--help"], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /--floors/);
  assert.match(cli.stdout, /--rooms/);
});

function floorsSvg(doorX: number, doorW: number, depth: number): string {
  const fp = (id: string, z: string) =>
    `<g id="${id}" data-model="blk" transform="matrix(10,0,0,10,0,0)" ${z}><path d="M 0 0 L 1 0 L 1 -1 Z"/></g>`;
  const room = (id: string) =>
    `<rect id="${id}" inkscape:label="model:rm" x="-3" y="-4.9" width="6" height="${depth}"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
     width="20mm" height="20mm" viewBox="0 0 20 20">
  <sodipodi:namedview inkscape:document-units="mm"/>
  <g inkscape:groupmode="layer" inkscape:label="floor-1">${fp("fp1", "")}${room("r1")}</g>
  <g inkscape:groupmode="layer" inkscape:label="floor-2">${fp("fp2", 'z="3"')}${room("r2")}</g>
  <g inkscape:groupmode="layer" inkscape:label="doors-external">
    <rect id="front" inkscape:label="model:door-1" x="${doorX}" y="-5.2" width="${doorW}" height="0.2"/>
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

function roomSvg(doorWall: "front" | "left" = "front"): string {
  const door = doorWall === "front"
    ? `<rect id="d1" inkscape:label="model:door-1" data-wall="front" x="4.5" y="7.9" width="1" height="0.2"/>`
    : `<rect id="d1" inkscape:label="model:door-1" data-wall="left" x="1.9" y="10.5" width="0.2" height="1"/>`;
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
  </g>
  <g inkscape:groupmode="layer" inkscape:label="lights">
    <circle id="lamp-el" inkscape:label="light:lamp" cx="5" cy="11" r="0.2" z="2"/>
    <rect id="panel-el" inkscape:label="light:panel" x="4.5" y="10.5" width="1" height="0.5" data-width="1" data-height="0.5"/>
  </g>
</svg>`;
}
