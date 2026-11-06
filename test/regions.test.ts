import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.ts";
import { PlanError } from "../src/errors.ts";
import {
  bakeWalkableRegions,
  buildRegions,
  DEFAULT_HEIGHT,
  DEFAULT_RADIUS,
  obstaclesFrom,
  STEP_HEIGHT,
  type BakedRegionsFile,
  type Region,
  type RegionBox,
  type RegionPlace,
} from "../src/regions.ts";
import type { SceneGraphFile } from "../src/scene-graph.ts";

const RADIUS = DEFAULT_RADIUS;
const HEIGHT = DEFAULT_HEIGHT;
const ARENA = "/home/tim/dev/conveyor-engine-arena";
const DOOR = "brutalist-building-1-cbake-9.door-1-1-9-22-0";

function floor(minX: number, maxX: number, minZ: number, maxZ: number, y = 0): RegionPlace {
  return {
    id: "floor",
    y,
    polygon: [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]],
    bounds: { minX, maxX, minZ, maxZ },
  };
}

function wall(minX: number, maxX: number, minZ: number, maxZ: number, maxY = 2, minY = 0): RegionBox {
  return { minX, maxX, minZ, maxZ, minY, maxY };
}

function regionById(regions: readonly Region[], id: string): Region {
  const region = regions.find((item) => item.id === id);
  assert.ok(region, id);
  return region;
}

function overlaps(
  a: { minX: number; maxX: number; minZ: number; maxZ: number },
  b: { minX: number; maxX: number; minZ: number; maxZ: number },
): boolean {
  return Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) > 1e-4
    && Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ) > 1e-4;
}

function inflate(box: RegionBox, radius: number): { minX: number; maxX: number; minZ: number; maxZ: number } {
  return {
    minX: Math.min(box.minX, box.maxX) - radius,
    maxX: Math.max(box.minX, box.maxX) + radius,
    minZ: Math.min(box.minZ, box.maxZ) - radius,
    maxZ: Math.max(box.minZ, box.maxZ) + radius,
  };
}

test("a wall in the middle leaves regions and portals around the inflated box", () => {
  const place = floor(0, 20, 0, 20);
  const box = wall(8, 12, 8, 12);
  const graph = buildRegions(place, [box], { radius: RADIUS, height: HEIGHT });
  assert.ok(graph.regions.length >= 2);
  assert.ok(graph.portals.length >= 1);
  const blocked = inflate(box, RADIUS);
  for (const region of graph.regions) assert.equal(overlaps(region, blocked), false);
  assert.equal(graph.regions.some((region) => contains(region, 10, 10)), false);
  const path = bfs(graph.regions, graph.portals, [1, 0, 10], [19, 0, 10]);
  assert.ok(path);
  assert.ok(path.length >= 2);
});

test("a gap narrower than the capsule is closed and a wider gap stays open", () => {
  const place = floor(0, 20, 0, 20);
  const narrow = buildRegions(place, [wall(8, 12, 0, 9.6), wall(8, 12, 10.4, 20)], { radius: RADIUS, height: HEIGHT });
  assert.equal(bfs(narrow.regions, narrow.portals, [1, 0, 5], [19, 0, 5]), undefined);

  const openBoxes = [wall(8, 12, 0, 9.4), wall(8, 12, 10.6, 20)];
  const open = buildRegions(place, openBoxes, { radius: RADIUS, height: HEIGHT });
  const path = bfs(open.regions, open.portals, [1, 0, 5], [19, 0, 5]);
  assert.ok(path);
  assert.ok(path.length >= 2);
  for (const id of path) {
    const region = regionById(open.regions, id);
    for (const box of openBoxes) assert.equal(overlaps(region, inflate(box, RADIUS)), false);
  }
});

test("a step does not split the floor and a taller box does", () => {
  const place = floor(0, 20, 0, 20);
  const step = wall(8, 12, 8, 12, STEP_HEIGHT);
  const stepped = buildRegions(place, [step], { radius: RADIUS, height: HEIGHT });
  assert.equal(stepped.regions.length, 1);
  assert.equal(stepped.portals.length, 0);
  assert.equal(contains(stepped.regions[0]!, 10, 10), true);

  const tall = wall(8, 12, 8, 12, STEP_HEIGHT + 0.2);
  const split = buildRegions(place, [tall], { radius: RADIUS, height: HEIGHT });
  assert.ok(split.portals.length >= 1);
  assert.equal(split.regions.some((region) => containsOpen(region, 10, 10)), false);

  const slab = wall(0, 20, 0, 20, 0, -0.2);
  const floored = buildRegions(place, [slab], { radius: RADIUS, height: HEIGHT });
  assert.equal(floored.regions.length, 1);
});

test("shafts and cab rooms are omitted and a shaft footprint is not walkable", () => {
  const hall = floor(0, 20, 0, 20);
  hall.id = "hall";
  const shaft = {
    id: "shaft",
    kind: "elevator" as const,
    y: 0,
    polygon: [[8, 8], [12, 8], [12, 12], [8, 12]] as Array<[number, number]>,
    bounds: { minX: 8, maxX: 12, minZ: 8, maxZ: 12 },
    stops: [0, 3],
    waitS: 1,
    speed: 1,
    landings: [[10, 0, 10], [10, 3, 10]] as Array<[number, number, number]>,
    joins: ["hall", "hall"],
    room: "cab",
  };
  const cab = { ...floor(8, 12, 8, 12), id: "cab", kind: "room" as const };
  const graph: SceneGraphFile = {
    formatVersion: 1,
    units: "meters",
    places: [shaft, { ...hall, kind: "hall" }, cab, { ...floor(0, 20, 0, 20), id: "outside" as const, kind: "outside" as const, y: 0 as const }],
    portals: [],
  };
  const baked = bakeWalkableRegions(graph, [
    { id: "cab.front.0", minX: 8, maxX: 12, minZ: 8, maxZ: 8.2, minY: 0, maxY: 2 },
  ], RADIUS, HEIGHT);
  assert.deepEqual(baked.places.map((place) => place.placeId), ["hall", "outside"]);
  const hallRegions = baked.places[0]!.regions;
  assert.equal(hallRegions.some((region) => containsOpen(region, 10, 10)), false);
  assert.equal(hallRegions.some((region) => contains(region, 1, 1)), true);
});

test("scene-graph writes regions.json beside --out", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-regions-"));
  try {
    const floors = path.join(dir, "floors");
    const rooms = path.join(dir, "rooms");
    mkdirSync(floors);
    mkdirSync(rooms);
    writeFileSync(path.join(floors, "bldg.floors.svg"), oneFloor());
    writeFileSync(path.join(dir, "buildings.placements.json"), JSON.stringify({
      formatVersion: 1,
      units: "meters",
      placements: [{ id: "hall-b", model: "bldg", position: [0, 0, 0], yaw: 0, scale: 1 }],
      obstacles: [{ id: "wall", kind: "aabb", min: [4, 0, 2], max: [5, 2, 8] }],
    }));
    writeFileSync(path.join(dir, "doors.placements.json"), JSON.stringify({
      formatVersion: 1, units: "meters", placements: [], obstacles: [],
    }));
    writeFileSync(path.join(dir, "bounds.json"), JSON.stringify({
      minX: 0, maxX: 20, minY: -2, maxY: 12, minZ: 0, maxZ: 20,
    }));
    const out = path.join(dir, "scene-graph.json");
    const code = main([
      "scene-graph",
      "--buildings", path.join(dir, "buildings.placements.json"),
      "--floors", floors,
      "--rooms", rooms,
      "--doors", path.join(dir, "doors.placements.json"),
      "--bounds", path.join(dir, "bounds.json"),
      "--out", out,
    ]);
    assert.equal(code, 0);
    const regionsPath = path.join(dir, "regions.json");
    assert.equal(existsSync(regionsPath), true);
    const baked = JSON.parse(readFileSync(regionsPath, "utf8")) as BakedRegionsFile;
    assert.equal(baked.version, 1);
    assert.equal(baked.radius, RADIUS);
    assert.equal(baked.height, HEIGHT);
    assert.ok(baked.places.some((place) => place.placeId === "outside" && place.regions.length > 0));
    const ids = baked.places.map((place) => place.placeId);
    assert.deepEqual(ids, [...ids].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a placements file with no obstacles fails the bake", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-regions-bad-"));
  try {
    writeFileSync(path.join(dir, "buildings.placements.json"), JSON.stringify({ placements: [] }));
    assert.throws(() => obstaclesFrom(JSON.parse(readFileSync(path.join(dir, "buildings.placements.json"), "utf8")), "buildings"), PlanError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("arena outside reaches a building door around the collision boxes", { timeout: 180_000 }, () => {
  const game = path.join(ARENA, "web/game");
  const scenePath = path.join(game, "scene-graph.json");
  assert.equal(existsSync(scenePath), true, scenePath);
  const scene = JSON.parse(readFileSync(scenePath, "utf8")) as SceneGraphFile;
  const boxes = [
    ...obstaclesFrom(JSON.parse(readFileSync(path.join(game, "buildings.placements.json"), "utf8")), "buildings"),
    ...obstaclesFrom(JSON.parse(readFileSync(path.join(game, "props.placements.json"), "utf8")), "props"),
    ...obstaclesFrom(JSON.parse(readFileSync(path.join(game, "rooms.placements.json"), "utf8")), "rooms"),
  ];
  const baked = bakeWalkableRegions(scene, boxes, RADIUS, HEIGHT);
  const cabRooms = scene.places.flatMap((place) => (
    place.kind === "elevator" && "room" in place && place.room ? [place.room] : []
  ));
  const kept = boxes.filter((box) => {
    const id = box.id;
    return !id || !cabRooms.some((room) => id.startsWith(`${room}.`));
  });
  const outside = baked.places.find((place) => place.placeId === "outside");
  assert.ok(outside);
  assert.ok(outside.regions.length > 0);
  const portal = scene.portals.find((item) => item.id === DOOR);
  assert.ok(portal);
  const stand = portal.b === "outside" ? portal.at.b : portal.at.a;
  const route = bfs(outside.regions, outside.portals, [72.1, 0, -6.2], stand);
  assert.ok(route, `regions ${outside.regions.length}`);
  const blockers = kept.flatMap((box) => {
    const blocks = box.minY === undefined || box.maxY === undefined
      || !(Math.max(box.minY, box.maxY) <= STEP_HEIGHT || Math.min(box.minY, box.maxY) >= HEIGHT);
    if (!blocks) return [];
    return [inflate(box, RADIUS)];
  });
  for (const id of route) {
    const region = regionById(outside.regions, id);
    for (const block of blockers) assert.equal(overlaps(region, block), false, `${id} hits a blocker`);
  }
});

function contains(region: Region, x: number, z: number): boolean {
  return x >= region.minX && x <= region.maxX && z >= region.minZ && z <= region.maxZ;
}

function containsOpen(region: Region, x: number, z: number): boolean {
  return x > region.minX && x < region.maxX && z > region.minZ && z < region.maxZ;
}

function locate(regions: readonly Region[], point: readonly [number, number, number]): string | undefined {
  let inside: Region | undefined;
  for (const region of regions) {
    if (Math.abs(region.y - point[1]) > STEP_HEIGHT + 1e-4) continue;
    if (point[0] < region.minX || point[0] > region.maxX || point[2] < region.minZ || point[2] > region.maxZ) continue;
    if (!inside || region.id < inside.id) inside = region;
  }
  if (inside) return inside.id;
  let best: Region | undefined;
  let bestDist = 0.5;
  for (const region of regions) {
    if (Math.abs(region.y - point[1]) > STEP_HEIGHT + 1e-4) continue;
    const x = Math.min(region.maxX, Math.max(region.minX, point[0]));
    const z = Math.min(region.maxZ, Math.max(region.minZ, point[2]));
    const dist = Math.hypot(x - point[0], z - point[2]);
    if (dist > 0.5) continue;
    if (best && (dist > bestDist || (dist === bestDist && region.id >= best.id))) continue;
    best = region;
    bestDist = dist;
  }
  return best?.id;
}

function bfs(
  regions: readonly Region[],
  portals: readonly { from: string; to: string }[],
  start: readonly [number, number, number],
  goal: readonly [number, number, number],
): string[] | undefined {
  const from = locate(regions, start);
  const to = locate(regions, goal);
  if (!from || !to) return undefined;
  if (from === to) return [from];
  const adj = new Map<string, string[]>();
  for (const portal of portals) {
    const left = adj.get(portal.from);
    if (left) left.push(portal.to);
    else adj.set(portal.from, [portal.to]);
    const right = adj.get(portal.to);
    if (right) right.push(portal.from);
    else adj.set(portal.to, [portal.from]);
  }
  const prev = new Map<string, string>();
  const queue = [from];
  prev.set(from, "");
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head]!;
    if (current === to) break;
    for (const next of adj.get(current) ?? []) {
      if (prev.has(next)) continue;
      prev.set(next, current);
      queue.push(next);
    }
  }
  if (!prev.has(to)) return undefined;
  const path: string[] = [];
  for (let cursor = to; cursor !== ""; cursor = prev.get(cursor) ?? "") path.push(cursor);
  path.reverse();
  return path;
}

function oneFloor(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
     width="20mm" height="20mm" viewBox="0 0 20 20">
  <sodipodi:namedview inkscape:document-units="mm" inkscape:document-scale="1"/>
  <g inkscape:groupmode="layer" inkscape:label="floor-1">
    <g id="fp" data-model="bldg" transform="matrix(1,0,0,1,0,20)"><path d="M 0 0 L 10 0 L 10 -10 L 0 -10 Z"/></g>
  </g>
</svg>`;
}
