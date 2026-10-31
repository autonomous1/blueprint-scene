import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bake } from "../src/bake.ts";
import { main } from "../src/cli.ts";
import { readFloorsSvg } from "../src/floors-svg.ts";
import { derivePlaces } from "../src/places.ts";
import { buildSceneGraph, doorProbe, type SceneGraphFile, type ScenePortal } from "../src/scene-graph.ts";
import type { RoomFile } from "../src/room-file.ts";
import type { AnyPlace, BoundsFile, DoorPlacement, ScenePlace, Vec3, Yaw } from "../src/types.ts";
import { trianglesFromBox } from "./boxes.ts";

const ROOM: RoomFile = { footprint: { minX: -2, maxX: 2, minZ: -1.5, maxZ: 1.5 } } as RoomFile;
const BAR: RoomFile = { footprint: { minX: -5, maxX: 5, minZ: -1, maxZ: 1 } } as RoomFile;
const BUILDING = { id: "hall-b", model: "bldg", position: [10, 0, 20] as Vec3, yaw: 0 as Yaw, scale: 10 };
const BOUNDS: BoundsFile = { minX: -40, maxX: 80, minY: -2, maxY: 30, minZ: -40, maxZ: 80 };

test("doors, stairs, and an elevator link places, and a room has no hall opening", () => {
  const derived = deriveHall(mainSvg(), ROOM);
  assert.equal(derived.warnings.length, 0);
  const roomDoor = leaf("room-1.door-1", [18.5, 0, 22.5], 180, { locked: true, key: "key" });
  const outsideDoor = leaf("hall-b.door-ext", [10, 0, 26.5], 270);
  const first = buildSceneGraph({ places: derived.places, doors: [roomDoor, outsideDoor], bounds: BOUNDS });
  const again = buildSceneGraph({ places: derived.places, doors: [outsideDoor, roomDoor], bounds: BOUNDS });
  assert.equal(JSON.stringify(again.graph), JSON.stringify(first.graph));
  assert.deepEqual(again.warnings, first.warnings);

  const graph = first.graph;
  const ids = graph.places.map((place) => place.id);
  assert.deepEqual(ids, [...ids].sort());
  const portalIds = graph.portals.map((portal) => portal.id);
  assert.deepEqual(portalIds, [...portalIds].sort());
  const outside = graph.places.find((place) => place.id === "outside");
  assert.equal(outside?.kind, "outside");
  assert.equal(outside && outside.kind === "outside" ? outside.y : undefined, 0);

  const roomLink = one(between(graph.portals, "hall-b.room-1", "hall-b.floor-1.hall"));
  assert.equal(roomLink.kind, "door");
  assert.equal(roomLink.door, "room-1.door-1");
  assert.equal(roomLink.locked, true);
  assert.equal(roomLink.key, "key");
  assert.equal(roomLink.width, 1);
  assert.equal(roomLink.cost, round6(distance(roomLink.at.a, roomLink.at.b)));

  const outsideLink = one(between(graph.portals, "outside", "hall-b.floor-1.hall"));
  assert.equal(outsideLink.door, "hall-b.door-ext");
  assert.equal(outsideLink.locked, undefined);
  assert.equal(outsideLink.key, undefined);

  const bottom = one(graph.portals.filter((portal) => portal.id === "hall-b.s1:bottom"));
  assert.equal(bottom.kind, "landing");
  assert.equal(bottom.cost, 0.5);
  assert.ok(links(bottom, "hall-b.s1", "hall-b.floor-1.hall"));
  const top = one(graph.portals.filter((portal) => portal.id === "hall-b.s1:top"));
  assert.equal(top.kind, "landing");
  assert.equal(top.cost, 5.2);
  assert.ok(links(top, "hall-b.s1", "hall-b.floor-2.hall"));

  for (const stop of [0, 1] as const) {
    const cab = graph.places.find((place) => place.id === `hall-b.e1@${stop}`);
    assert.equal(cab?.kind, "elevator");
    assert.equal(cab?.y, stop === 0 ? 0 : 2.75);
    const shaft = derived.places.find((place) => place.id === "hall-b.e1");
    assert.deepEqual(cab?.polygon, shaft?.polygon);
  }
  const ride = one(graph.portals.filter((portal) => portal.kind === "elevator"));
  assert.equal(ride.id, "hall-b.e1:0-1");
  assert.equal(ride.cost, 8 + 2.75);
  assert.ok(links(ride, "hall-b.e1@0", "hall-b.e1@1"));
  assert.equal(graph.portals.some((portal) => portal.id === "hall-b.e1@0:landing"), true);
  assert.equal(graph.portals.some((portal) => portal.id === "hall-b.e1@1:landing"), true);

  assert.equal(graph.portals.some((portal) =>
    portal.kind === "opening" && (portal.a === "hall-b.room-1" || portal.b === "hall-b.room-1"),
  ), false);
});

test("a door into empty space warns once, and a door with one place on both sides warns once", () => {
  const linked = deriveHall(twoFloors(stair("s1", 12, 32.5, 4, 1, 'data-up="+x"')));
  const lower = must(linked.places, "hall-b.floor-1.hall");
  const upper = must(linked.places, "hall-b.floor-2.hall");
  const outsideDoor = westDoor("hall-b.door-ext", lower.y, lower.bounds.minX, 23);
  const drop = northDoor("hall-b.door-drop", upper.y, upper.bounds.maxZ, 15);
  const dropped = buildSceneGraph({ places: linked.places, doors: [outsideDoor, drop], bounds: BOUNDS });
  assert.deepEqual(dropped.warnings, ["door hall-b.door-drop opens into no place on the front side"]);
  assert.equal(dropped.graph.portals.some((portal) => portal.door === "hall-b.door-drop"), false);

  const hall = deriveHall(oneFloor());
  const floor = must(hall.places, "hall-b.floor-1.hall");
  const same = buildSceneGraph({
    places: hall.places,
    doors: [
      westDoor("hall-b.door-ext", floor.y, floor.bounds.minX, 23),
      leaf("hall-b.door-mid", [19.5, floor.y, 25], 0),
    ],
    bounds: BOUNDS,
  });
  assert.deepEqual(same.warnings, ["door hall-b.door-mid: both sides are hall-b.floor-1.hall"]);
  assert.equal(same.graph.portals.some((portal) => portal.door === "hall-b.door-mid"), false);
});

test("a floor-2 door whose outward probe misses that floor's outline does not portal", () => {
  const derived = derivePlaces({
    buildings: [{ id: "setback", model: "bldg", position: [0, 0, 0], yaw: 0, scale: 1 }],
    floorsFor: () => readFloorsSvg(setbackSvg()),
    roomFileFor: () => undefined,
  });
  const lower = must(derived.places, "setback.floor-1.hall");
  const upper = must(derived.places, "setback.floor-2.hall");
  assert.ok(upper.bounds.maxX < lower.bounds.maxX);
  const midZ = (upper.bounds.minZ + upper.bounds.maxZ) / 2;
  const door = leaf("floor2-east", [upper.bounds.maxX - 0.2, upper.y, midZ + 0.5], 90);
  const front = doorProbe(door, 0.6);
  const back = doorProbe(door, -(2 + 0.6));
  assert.equal(inside(lower.polygon, front[0], front[2]), true);
  assert.equal(inside(upper.polygon, front[0], front[2]), false);
  assert.ok(distanceToPolygon(upper.polygon, front[0], front[2]) > 0.06);
  assert.equal(inside(upper.polygon, back[0], back[2]), true);
  const linked = buildSceneGraph({
    places: derived.places,
    doors: [door],
    bounds: { minX: -5, maxX: 20, minY: -2, maxY: 12, minZ: -5, maxZ: 20 },
  });
  assert.deepEqual(
    linked.warnings.filter((warning) => warning.startsWith("door floor2-east")),
    ["door floor2-east opens into no place on the front side"],
  );
  assert.equal(linked.graph.portals.some((portal) => portal.door === "floor2-east"), false);
});

test("a probe in the facade inset still counts as the hall", () => {
  const derived = deriveHall(oneFloor());
  const hall = must(derived.places, "hall-b.floor-1.hall");
  const z = (hall.bounds.minZ + hall.bounds.maxZ) / 2;
  const door = westDoor("hall-b.door-inset", hall.y, hall.bounds.minX - 0.03 + 0.6, z);
  const front = doorProbe(door, 0.6);
  assert.ok(Math.abs(front[0] - (hall.bounds.minX - 0.03)) < 1e-6);
  assert.equal(inside(hall.polygon, front[0], front[2]), false);
  assert.ok(distanceToPolygon(hall.polygon, front[0], front[2]) <= 0.06);
  const linked = buildSceneGraph({
    places: derived.places,
    doors: [door, westDoor("hall-b.door-ext", hall.y, hall.bounds.minX, z - 3)],
    bounds: BOUNDS,
  });
  assert.deepEqual(linked.warnings, ["door hall-b.door-inset: both sides are hall-b.floor-1.hall"]);
  assert.equal(linked.graph.portals.some((portal) => portal.door === "hall-b.door-inset"), false);
});

test("a split hall's bridge is not an opening onto the neighbouring platform", () => {
  const hall: Array<[number, number]> = [
    [0, 0], [10, 0], [10, 2], [5, 2],
    [5, 8], [10, 8], [10, 10], [0, 10], [0, 8], [5, 8],
    [5, 2], [0, 2],
  ];
  const platform: Array<[number, number]> = [[5, 2], [8, 2], [8, 8], [5, 8]];
  const bridges = bridgeEdges(hall);
  assert.ok(bridges.length >= 2);
  const linked = buildSceneGraph({
    places: [boxed("b.floor-1.hall", "hall", hall), boxed("b.deck", "platform", platform)],
    doors: [],
    bounds: BOUNDS,
  });
  const openings = linked.graph.portals.filter((portal) => portal.kind === "opening");
  assert.equal(openings.length, 2);
  for (const portal of openings) {
    const x = (portal.at.a[0] + portal.at.b[0]) / 2;
    const z = (portal.at.a[2] + portal.at.b[2]) / 2;
    assert.ok(!(Math.abs(x - 5) < 0.2 && z > 3 && z < 7), `${x},${z} lies on the bridge`);
  }

  const derived = derivePlaces({
    buildings: [BUILDING],
    floorsFor: () => readFloorsSvg(splitSvg()),
    roomFileFor: () => BAR,
  });
  const split = must(derived.places, "hall-b.floor-1.hall");
  const splitBridges = bridgeEdges(split.polygon);
  assert.ok(splitBridges.length >= 2, "two rooms should split the hall");
  assert.ok(derived.places.some((place) => place.id === "hall-b.deck"));
  const graph = buildSceneGraph({ places: derived.places, doors: [], bounds: BOUNDS });
  for (const portal of graph.graph.portals.filter((item) => item.kind === "opening")) {
    const x = (portal.at.a[0] + portal.at.b[0]) / 2;
    const z = (portal.at.a[2] + portal.at.b[2]) / 2;
    for (const edge of splitBridges) {
      const along = segmentT(x, z, edge[0], edge[1]);
      if (along === undefined || along <= 0.05 || along >= 0.95) continue;
      assert.ok(distanceToSegment(x, z, edge[0], edge[1]) > 0.05);
    }
  }
});

test("a place with no portals warns once", () => {
  const derived = deriveHall(twoFloors());
  const lower = must(derived.places, "hall-b.floor-1.hall");
  const linked = buildSceneGraph({
    places: derived.places,
    doors: [westDoor("hall-b.door-ext", lower.y, lower.bounds.minX, 23)],
    bounds: BOUNDS,
  });
  assert.deepEqual(linked.warnings, ["place hall-b.floor-2.hall has no portals"]);
});

test("bake writes scene-graph.json only when floors produce places", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-graph-"));
  try {
    const svg = path.join(dir, "plan.svg");
    writeFileSync(svg, planSvg());
    const bareOut = path.join(dir, "bare", "buildings.placements.json");
    mkdirSync(path.dirname(bareOut), { recursive: true });
    bake({
      svgPath: svg,
      outPath: bareOut,
      collisionDir: path.join(dir, "bare-buildings"),
      modelsDir: path.join(dir, "bare-models"),
      walls: { bldg: trianglesFromBox([-0.5, 0, -0.5], [0.5, 1, 0.5]) },
    });
    assert.equal(existsSync(path.join(dir, "bare", "scene-graph.json")), false);

    const floors = path.join(dir, "floors");
    mkdirSync(floors);
    writeFileSync(path.join(floors, "bldg.floors.svg"), oneFloorUnit());
    const out = path.join(dir, "out", "buildings.placements.json");
    mkdirSync(path.dirname(out), { recursive: true });
    const baked = bake({
      svgPath: svg,
      outPath: out,
      floorsDir: floors,
      collisionDir: path.join(dir, "buildings"),
      modelsDir: path.join(dir, "models"),
      walls: { bldg: trianglesFromBox([-0.5, 0, -0.5], [0.5, 1, 0.5]) },
    });
    const graphPath = path.join(dir, "out", "scene-graph.json");
    assert.equal(baked.lines.some((line) => line === `wrote ${graphPath}`), true);
    const graph = JSON.parse(readFileSync(graphPath, "utf8")) as SceneGraphFile;
    assert.equal(graph.formatVersion, 1);
    assert.equal(graph.units, "meters");
    assert.ok(graph.places.some((place) => place.id.endsWith(".floor-1.hall")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scene-graph cli re-derives places and ignores room placements that are not doors", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-graph-cli-"));
  try {
    const floors = path.join(dir, "floors");
    const rooms = path.join(dir, "rooms");
    mkdirSync(floors);
    mkdirSync(rooms);
    writeFileSync(path.join(floors, "bldg.floors.svg"), oneFloor());
    writeFileSync(path.join(dir, "buildings.placements.json"), JSON.stringify({
      formatVersion: 1,
      units: "meters",
      placements: [BUILDING],
      obstacles: [],
    }));
    writeFileSync(path.join(dir, "doors.placements.json"), JSON.stringify({
      formatVersion: 1,
      units: "meters",
      placements: [],
      obstacles: [],
    }));
    writeFileSync(path.join(dir, "rooms.placements.json"), JSON.stringify({
      formatVersion: 1,
      units: "meters",
      placements: [
        { id: "hall-b.room-mesh", model: "room-b", position: [0, 0, 0], yaw: 0, scale: 1 },
        {
          id: "not-a-real-link",
          model: "door-1",
          position: [0, 5, 0],
          yaw: 0,
          hinge: "left",
          size: [1, 2, 0.1],
          open: false,
        },
      ],
      obstacles: [],
    }));
    writeFileSync(path.join(dir, "bounds.json"), JSON.stringify(BOUNDS));
    const out = path.join(dir, "scene-graph.json");
    const code = main([
      "scene-graph",
      "--buildings", path.join(dir, "buildings.placements.json"),
      "--floors", floors,
      "--rooms", rooms,
      "--doors", path.join(dir, "doors.placements.json"),
      "--room-doors", path.join(dir, "rooms.placements.json"),
      "--bounds", path.join(dir, "bounds.json"),
      "--out", out,
    ]);
    assert.equal(code, 0);
    const graph = JSON.parse(readFileSync(out, "utf8")) as SceneGraphFile;
    assert.ok(graph.places.some((place) => place.id === "outside"));
    assert.ok(graph.places.some((place) => place.id === "hall-b.floor-1.hall"));
    assert.equal(graph.portals.some((portal) => portal.door === "hall-b.room-mesh"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function deriveHall(svg: string, room: RoomFile | undefined = undefined): { places: AnyPlace[]; warnings: string[] } {
  return derivePlaces({
    buildings: [BUILDING],
    floorsFor: () => readFloorsSvg(svg),
    roomFileFor: () => room,
  });
}

function must(places: readonly AnyPlace[], id: string): ScenePlace {
  const found = places.find((place) => place.id === id);
  assert.ok(found, id);
  return found;
}

function between(portals: readonly ScenePortal[], a: string, b: string): ScenePortal[] {
  return portals.filter((portal) => (portal.a === a && portal.b === b) || (portal.a === b && portal.b === a));
}

function one(portals: readonly ScenePortal[]): ScenePortal {
  assert.equal(portals.length, 1);
  return portals[0]!;
}

function links(portal: ScenePortal, a: string, b: string): boolean {
  return (portal.a === a && portal.b === b) || (portal.a === b && portal.b === a);
}

function leaf(
  id: string,
  position: Vec3,
  yaw: Yaw,
  extra: { locked?: boolean; key?: string } = {},
): DoorPlacement {
  return {
    id,
    model: "door-1",
    position,
    yaw,
    hinge: "left",
    size: [1, 2.1, 0.1],
    open: false,
    ...(extra.locked ? { locked: true } : {}),
    ...(extra.key ? { key: extra.key } : {}),
  };
}

/** Yaw 270: local +Z points west, out through a facade at `edgeX`. */
function westDoor(id: string, y: number, edgeX: number, z: number): DoorPlacement {
  return leaf(id, [edgeX, y, z - 0.5], 270);
}

/** Yaw 0: local +Z points north, out through a facade at `edgeZ`. */
function northDoor(id: string, y: number, edgeZ: number, x: number): DoorPlacement {
  return leaf(id, [x - 0.5, y, edgeZ], 0);
}

function boxed(id: string, kind: "hall" | "platform", polygon: Array<[number, number]>): ScenePlace {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of polygon) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { id, kind, building: "b", floor: "1", y: 0, polygon, bounds: { minX, maxX, minZ, maxZ } };
}

function bridgeEdges(polygon: readonly (readonly [number, number])[]): Array<[readonly [number, number], readonly [number, number]]> {
  const edges: Array<[readonly [number, number], readonly [number, number]]> = [];
  for (let i = 0; i < polygon.length; i += 1) {
    edges.push([polygon[i]!, polygon[(i + 1) % polygon.length]!]);
  }
  return edges.filter((edge, index) => edges.some((other, otherIndex) =>
    otherIndex !== index
    && Math.hypot(other[0][0] - edge[1][0], other[0][1] - edge[1][1]) <= 1e-4
    && Math.hypot(other[1][0] - edge[0][0], other[1][1] - edge[0][1]) <= 1e-4,
  ));
}

function inside(polygon: readonly (readonly [number, number])[], x: number, z: number): boolean {
  let hits = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i]![0];
    const zi = polygon[i]![1];
    const xj = polygon[j]![0];
    const zj = polygon[j]![1];
    const crosses = (zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (crosses) hits = !hits;
  }
  return hits;
}

function distanceToPolygon(polygon: readonly (readonly [number, number])[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < polygon.length; i += 1) {
    const dist = distanceToSegment(x, z, polygon[i]!, polygon[(i + 1) % polygon.length]!);
    if (dist < best) best = dist;
  }
  return best;
}

function distanceToSegment(
  x: number,
  z: number,
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-20) return Math.hypot(x - a[0], z - a[1]);
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / len2));
  return Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz));
}

function segmentT(
  x: number,
  z: number,
  a: readonly [number, number],
  b: readonly [number, number],
): number | undefined {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-20) return undefined;
  return ((x - a[0]) * dx + (z - a[1]) * dz) / len2;
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function round6(n: number): number {
  const rounded = Math.round(n * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function mainSvg(): string {
  return svgWrap(`
    ${layer("floor-1", footprint("fp1", "") + room("room-1") + stair("s1", 12, 32.5, 4, 1, 'data-up="+x"') + elevator("e1", 2, 36, 2, 2))}
    ${layer("floor-2", footprint("fp2", 'z="2.75"') + roof())}
  `);
}

function oneFloor(): string {
  return svgWrap(layer("floor-1", footprint("fp1", "")));
}

function twoFloors(floor1 = "", floor2 = ""): string {
  return svgWrap(`
    ${layer("floor-1", footprint("fp1", "") + floor1)}
    ${layer("floor-2", footprint("fp2", 'z="2.75"') + floor2)}
  `);
}

/** Two rooms span the floor and split the hall. A platform sits on the north side of the cut. */
function splitSvg(): string {
  const barrierA = `<rect id="room-a" inkscape:label="model:room-b" x="0" y="34" width="10" height="2"/>`;
  const barrierB = `<rect id="room-b" inkscape:label="model:room-b" x="10" y="34" width="10" height="2"/>`;
  const deck = `<rect id="deck" inkscape:label="platform:deck" x="4" y="32" width="12" height="2" data-height="0"/>`;
  return svgWrap(layer("floor-1", footprint("fp1", "") + barrierA + barrierB + deck));
}

function setbackSvg(): string {
  const big = `<g id="a" data-model="bldg" transform="matrix(1,0,0,1,0,20)"><path d="M 0 0 L 6 0 L 6 -4 L 0 -4 Z"/></g>`;
  const small = `<g id="b" data-model="bldg" transform="matrix(1,0,0,1,0,20)" z="2.75"><path d="M 0 0 L 3 0 L 3 -3 L 0 -3 Z"/></g>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
     width="20mm" height="20mm" viewBox="0 0 20 20">
  <sodipodi:namedview inkscape:document-units="mm" inkscape:document-scale="1"/>
  ${layer("floor-1", big)}
  ${layer("floor-2", small)}
</svg>`;
}

function oneFloorUnit(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
     width="20mm" height="20mm" viewBox="0 0 20 20">
  <sodipodi:namedview inkscape:document-units="mm" inkscape:document-scale="1"/>
  ${layer("floor-1", `<g id="fp" data-model="bldg" transform="matrix(1,0,0,1,0,20)"><path d="M 0 0 L 1 0 L 1 -1 L 0 -1 Z"/></g>`)}
</svg>`;
}

function planSvg(): string {
  const ns = `xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"`;
  return `<?xml version="1.0"?><svg ${ns} width="20mm" height="20mm" viewBox="0 0 20 20">
    <g inkscape:groupmode="layer" inkscape:label="bounds">
      <rect id="yard" x="0" y="0" width="20" height="20"/>
    </g>
    <g inkscape:groupmode="layer" inkscape:label="buildings">
      <rect id="hall-b" data-model="bldg" x="5" y="14" width="1" height="1"/>
    </g>
  </svg>`;
}

function svgWrap(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
     width="40mm" height="40mm" viewBox="0 0 40 40">
  <sodipodi:namedview inkscape:document-units="mm" inkscape:document-scale="1"/>
  ${body}
</svg>`;
}

function layer(label: string, body: string): string {
  return `<g inkscape:groupmode="layer" inkscape:label="${label}">${body}</g>`;
}

function footprint(id: string, attrs: string): string {
  return `<g id="${id}" data-model="bldg" transform="matrix(10,0,0,10,0,40)" ${attrs}><path d="M 0 0 L 2 0 L 2 -1 L 0 -1 Z"/></g>`;
}

function room(id: string): string {
  return `<rect id="${id}" inkscape:label="model:room-b" x="6" y="34.5" width="4" height="3"/>`;
}

function roof(): string {
  return `<rect id="roof-1" inkscape:label="platform:roof-1" x="12" y="31" width="2" height="2" data-height="0.2"/>`;
}

function stair(id: string, x: number, y: number, width: number, height: number, attrs: string): string {
  return `<rect id="${id}" inkscape:label="stairs:${id}" x="${x}" y="${y}" width="${width}" height="${height}" ${attrs}/>`;
}

function elevator(id: string, x: number, y: number, width: number, height: number): string {
  return `<rect id="${id}" inkscape:label="elevator:${id}" x="${x}" y="${y}" width="${width}" height="${height}"/>`;
}
