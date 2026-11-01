import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PlanError } from "../src/errors.ts";
import { readFloorsSvg } from "../src/floors-svg.ts";
import { derivePlaces } from "../src/places.ts";
import { readScene } from "../src/plan.ts";
import type { RoomFile } from "../src/room-file.ts";
import type { AnyPlace, ElevatorPlace, ScenePlace, StairsPlace, Vec3, Yaw } from "../src/types.ts";

const ARENA_FLOORS = "/home/tim/dev/conveyor-engine-arena/dev/scenes/arena-1/designs/floorplans/brutalist-building-2-cbake.floors.svg";

const ROOM: RoomFile = {
  footprint: { minX: -2, maxX: 2, minZ: -1.5, maxZ: 1.5 },
} as RoomFile;

test("floors and room footprints become rooms, halls, and an optional platform", () => {
  const result = derivePlaces({
    buildings: [{ id: "hall-b", model: "bldg", position: [10, 0, 20], yaw: 0, scale: 10 }],
    floorsFor: () => readFloorsSvg(floorsSvg()),
    roomFileFor: (prefab) => (prefab === "room-b" ? ROOM : undefined),
  });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.places.map((place) => place.id), [
    "hall-b.floor-1.hall",
    "hall-b.floor-2.hall",
    "hall-b.roof-1",
    "hall-b.room-1",
    "hall-b.room-2",
  ]);

  const roomPolygon: Array<[number, number]> = [[16, 22.5], [20, 22.5], [20, 25.5], [16, 25.5]];
  const room1 = place(result.places, "hall-b.room-1");
  assert.equal(room1.kind, "room");
  assert.equal(room1.building, "hall-b");
  assert.equal(room1.floor, "1");
  assert.equal(room1.y, 0);
  assert.deepEqual(room1.polygon, roomPolygon);
  assert.deepEqual(room1.bounds, { minX: 16, maxX: 20, minZ: 22.5, maxZ: 25.5 });

  const room2 = place(result.places, "hall-b.room-2");
  assert.equal(room2.kind, "room");
  assert.equal(room2.floor, "2");
  assert.equal(room2.y, 2.75);
  assert.deepEqual(room2.polygon, roomPolygon);

  // Facade inset of 0.05 m pulls the outline in. The room does not touch that edge.
  const hallBounds = { minX: 10.05, maxX: 29.95, minZ: 20.05, maxZ: 29.95 };
  for (const id of ["hall-b.floor-1.hall", "hall-b.floor-2.hall"] as const) {
    const hall = place(result.places, id);
    assert.equal(hall.kind, "hall");
    assert.equal(hall.building, "hall-b");
    assert.equal(hall.floor, id === "hall-b.floor-1.hall" ? "1" : "2");
    assert.equal(hall.y, id === "hall-b.floor-1.hall" ? 0 : 2.75);
    assert.deepEqual(hall.bounds, hallBounds);
    for (const [x, z] of [[11, 21], [29, 29], [11, 29], [25, 21]] as const) {
      assert.equal(inside(hall.polygon, x, z), true, `${id} should contain footprint point ${x},${z}`);
    }
    assert.equal(inside(hall.polygon, 18, 24), false, `${id} should not cover the room`);
    assert.equal(inside(hall.polygon, 9, 21), false, `${id} should stay inside the footprint`);
  }

  const roof = place(result.places, "hall-b.roof-1");
  assert.equal(roof.kind, "platform");
  assert.equal(roof.floor, "2");
  assert.equal(roof.y, 2.95);
  assert.deepEqual(roof.polygon, [[22, 27], [24, 27], [24, 29], [22, 29]]);
});

test("a room polygon follows the building yaw", () => {
  const result = derivePlaces({
    buildings: [{ id: "hall-b", model: "bldg", position: [10, 0, 20], yaw: 90, scale: 10 }],
    floorsFor: () => readFloorsSvg(floorsSvg()),
    roomFileFor: () => ROOM,
  });
  const room = place(result.places, "hall-b.room-1");
  assert.equal(room.y, 0);
  assert.deepEqual(room.polygon, [[12.5, 10], [15.5, 10], [15.5, 14], [12.5, 14]]);
  const hall = place(result.places, "hall-b.floor-1.hall");
  assert.equal(inside(hall.polygon, 14, 12), false);
  assert.equal(inside(hall.polygon, 10.5, 19), true);
});

test("a missing room prefab is an error", () => {
  assert.throws(
    () => derivePlaces({
      buildings: [{ id: "hall-b", model: "bldg", position: [10, 0, 20], yaw: 0, scale: 10 }],
      floorsFor: () => readFloorsSvg(floorsSvg()),
      roomFileFor: () => undefined,
    }),
    (err: unknown) => err instanceof PlanError && /room-b/.test(err.message) && /room\.json/.test(err.message),
  );
});

test("a duplicate place id is a PlanError", () => {
  assert.throws(
    () => derivePlaces({
      buildings: [{ id: "hall-b", model: "bldg", position: [0, 0, 0] as Vec3, yaw: 0 as Yaw, scale: 10 }],
      floorsFor: () => readFloorsSvg(oneFloor("floor-1.hall")),
      roomFileFor: () => ROOM,
    }),
    (err: unknown) => err instanceof PlanError && err.message === 'duplicate placement id "hall-b.floor-1.hall"',
  );
  assert.throws(
    () => derivePlaces({
      buildings: [{ id: "hall-b", model: "bldg", position: [10, 0, 20], yaw: 0, scale: 10 }],
      floorsFor: () => readFloorsSvg(floorsSvg()),
      roomFileFor: () => ROOM,
      taken: new Set(["hall-b.room-1"]),
    }),
    (err: unknown) => err instanceof PlanError && /duplicate placement id "hall-b.room-1"/.test(err.message),
  );
});

test("no floors file yields no places", () => {
  const result = derivePlaces({
    buildings: [{ id: "hall-b", model: "bldg", position: [10, 0, 20], yaw: 0, scale: 10 }],
    floorsFor: () => undefined,
    roomFileFor: () => ROOM,
  });
  assert.deepEqual(result.places, []);
  assert.deepEqual(result.warnings, []);
});

test("an empty hall difference keeps the footprint and warns", () => {
  const result = derivePlaces({
    buildings: [{ id: "hall-b", model: "bldg", position: [10, 0, 20], yaw: 0, scale: 10 }],
    floorsFor: () => readFloorsSvg(floorsSvg()),
    roomFileFor: () => ({ footprint: { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000 } }) as RoomFile,
  });
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0]!, /empty/);
  const hall = place(result.places, "hall-b.floor-1.hall");
  assert.deepEqual(hall.bounds, { minX: 10, maxX: 30, minZ: 20, maxZ: 30 });
  assert.equal(inside(hall.polygon, 18, 24), true);
});

test("an L-shaped hall follows the outline and leaves the notch empty", () => {
  const bare = derivePlaces({
    buildings: [{ id: "L", model: "bldg", position: [0, 0, 0], yaw: 0, scale: 1 }],
    floorsFor: () => readFloorsSvg(lSvg()),
    roomFileFor: () => undefined,
  });
  assert.deepEqual(bare.warnings, []);
  const source = readFloorsSvg(lSvg());
  assert.equal(source.outline.length, 6);
  assert.equal(source.footprint.length, 4);
  const hall = place(bare.places, "L.floor-1.hall");
  const lArea = Math.abs(polygonArea(source.outline));
  const aabbArea = Math.abs(polygonArea(source.footprint));
  const hallArea = Math.abs(polygonArea(hall.polygon));
  // The hall cells are the outline pulled in by the 0.05 m facade inset.
  const insetL = [[0.05, 0.05], [2.95, 0.05], [2.95, 0.95], [0.95, 0.95], [0.95, 1.95], [0.05, 1.95]] as const;
  assert.ok(Math.abs(lArea - 4) < 1e-6, String(lArea));
  assert.ok(Math.abs(aabbArea - 6) < 1e-6, String(aabbArea));
  assert.ok(Math.abs(hallArea - Math.abs(polygonArea(insetL))) < 1e-6, String(hallArea));
  assert.ok(aabbArea - hallArea > 1);
  assert.equal(inside(hall.polygon, 2, 1.5), false, "notch inside the bounding box is outside the L");
  assert.equal(inside(source.footprint, 2, 1.5), true);
  assert.equal(inside(hall.polygon, 0.5, 0.5), true);
  assert.equal(inside(hall.polygon, 0.5, 1.5), true);

  const leg: RoomFile = { footprint: { minX: -0.5, maxX: 0.5, minZ: -0.2, maxZ: 0.2 } } as RoomFile;
  const cut = derivePlaces({
    buildings: [{ id: "L", model: "bldg", position: [0, 0, 0], yaw: 0, scale: 1 }],
    floorsFor: () => readFloorsSvg(lSvg(lRoom())),
    roomFileFor: () => leg,
  });
  assert.deepEqual(cut.warnings, []);
  const cutHall = place(cut.places, "L.floor-1.hall");
  const roomArea = 1 * 0.4;
  assert.ok(Math.abs(Math.abs(polygonArea(cutHall.polygon)) - (hallArea - roomArea)) < 1e-6);
  assert.equal(inside(cutHall.polygon, 2, 0.4), false);
  assert.equal(inside(cutHall.polygon, 0.5, 0.5), true);
  assert.equal(inside(cutHall.polygon, 2, 1.5), false);
});

test("a diagonal stencil warns with the building id and the hall uses the bounding box", () => {
  const result = derivePlaces({
    buildings: [{ id: "hall-b", model: "bldg", position: [0, 0, 0], yaw: 0, scale: 1 }],
    floorsFor: () => readFloorsSvg(diagonalSvg()),
    roomFileFor: () => undefined,
  });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /hall-b/);
  assert.match(result.warnings[0]!, /diagonal/);
  const hall = place(result.places, "hall-b.floor-1.hall");
  assert.equal(inside(hall.polygon, 0.5, 0.2), true);
});

test("building-2 floor-2 hall does not cover the stencil notch", () => {
  const source = readFloorsSvg(readFileSync(ARENA_FLOORS, "utf8"), ARENA_FLOORS);
  assert.equal(source.outlineFallback, undefined);
  assert.equal(source.outline.length, 8);
  assert.equal(source.footprint.length, 4);
  const notch = notchOf(source.footprint, source.outline);
  assert.ok(notch, "the stepped outline leaves a point inside the bounding box");
  const result = derivePlaces({
    buildings: [{ id: "b2", model: source.model, position: [0, 0, 0], yaw: 0, scale: source.scale }],
    floorsFor: () => source,
    roomFileFor: () => ({ footprint: { minX: -0.01, maxX: 0.01, minZ: -0.01, maxZ: 0.01 } }) as RoomFile,
  });
  assert.deepEqual(result.warnings, []);
  const hall = place(result.places, "b2.floor-2.hall");
  assert.equal(inside(hall.polygon, notch[0], notch[1]), false);
  assert.equal(inside(source.footprint, notch[0], notch[1]), true);
});

test("a room rect over the shaft binds the cab and lands outside the room door", () => {
  const svg = cabFloors(cabRoom("cab"));
  const result = deriveCab(svg, cabFile("left"));
  assert.deepEqual(result.warnings, []);
  const place = cabPlace(result.places);
  assert.equal(place.room, "hall-b.cab");
  assert.deepEqual(place.stops, [0, 2.75]);
  // Door wall `left`, instance yaw 0: landing is 0.6 m past −x of the 2×2 shaft.
  closeLanding(place.landings[0]!, [11.4, 0, 23]);
  closeLanding(place.landings[1]!, [11.4, 2.75, 23]);
  assert.ok(place.landings[0]![0] < place.bounds.minX);
  assert.deepEqual(place.joins, ["hall-b.floor-1.hall", "hall-b.floor-2.hall"]);
});

test("instance yaw 90 turns the room-door landing", () => {
  const svg = cabFloors(`<g transform="rotate(90 3 37)">${cabRoom("cab")}</g>`);
  const result = deriveCab(svg, cabFile("left"));
  assert.deepEqual(result.warnings, []);
  const place = cabPlace(result.places);
  assert.equal(place.room, "hall-b.cab");
  // Left wall normal (−1, 0) through yaw 90 is +z.
  closeLanding(place.landings[0]!, [13, 0, 24.6]);
  closeLanding(place.landings[1]!, [13, 2.75, 24.6]);
  assert.ok(place.landings[0]![2] > place.bounds.maxZ);
});

test("an explicit data-door-side that misses the room door warns; the default does not", () => {
  const warned = deriveCab(cabFloors(cabRoom("cab"), 'data-door-side="+y"'), cabFile("left"));
  assert.deepEqual(warned.warnings, [
    'elevator "hall-b.e1": data-door-side +y is a wall of room hall-b.cab; landings use the room door side -x',
  ]);
  closeLanding(cabPlace(warned.places).landings[0]!, [11.4, 0, 23]);

  const quiet = deriveCab(cabFloors(cabRoom("cab")), cabFile("left"));
  assert.deepEqual(quiet.warnings, []);

  const agreed = deriveCab(cabFloors(cabRoom("cab"), 'data-door-side="-x"'), cabFile("left"));
  assert.deepEqual(agreed.warnings, []);
  closeLanding(cabPlace(agreed.places).landings[0]!, [11.4, 0, 23]);
});

test("two rooms over the shaft, a room on the next floor, and a room with no door are PlanErrors", () => {
  assert.throws(
    () => deriveCab(cabFloors(cabRoom("cab-a") + cabRoom("cab-b")), cabFile("left")),
    (err: unknown) => err instanceof PlanError
      && /cab-a/.test(err.message)
      && /cab-b/.test(err.message),
  );
  assert.throws(
    () => deriveCab(cabFloors(cabRoom("cab"), "", cabRoom("above")), cabFile("left")),
    (err: unknown) => err instanceof PlanError && /floor-2/.test(err.message) && /above/.test(err.message),
  );
  assert.throws(
    () => deriveCab(cabFloors(cabRoom("cab")), cabFile(null)),
    (err: unknown) => err instanceof PlanError && /no door/.test(err.message) && /cab/.test(err.message),
  );
});

const LANDING_BUILDING = { id: "b", model: "bldg", position: [0, 0, 0] as Vec3, yaw: 0 as Yaw, scale: 1 };

test("a switchback landing joins both flights between the two halls", () => {
  const result = deriveLanding(switchbackSvg());
  assert.deepEqual(result.warnings, []);
  const mid = place(result.places, "b.s1-mid");
  assert.equal(mid.kind, "landing");
  assert.equal(mid.y, 1.5);
  assert.equal(mid.floor, "1");
  const lower = stairOf(result.places, "b.s1a");
  const upper = stairOf(result.places, "b.s1b");
  assert.equal(lower.joins.from, "b.floor-1.hall");
  assert.equal(lower.joins.to, "b.s1-mid");
  assert.equal(upper.joins.from, "b.s1-mid");
  assert.equal(upper.joins.to, "b.floor-2.hall");
});

test("the same flights without a landing still warn that the top joins no place", () => {
  const result = deriveLanding(switchbackSvg(false));
  assert.ok(result.warnings.some((warning) => warning === 'stairs "b.s1a" top landing joins no place'));
});

test("a landing at the wrong height, on a floor, or left unjoined is reported", () => {
  assert.throws(
    () => deriveLanding(switchbackSvg(true, "1.6")),
    (err: unknown) => err instanceof PlanError
      && err.message === 'stairs "b.s1a" top is on landing "b.s1-mid" at 1.5 but ends at 1.6',
  );
  assert.throws(
    () => deriveLanding(landingPage(landingRect("s1-mid", 'x="10" y="4" width="2.6" height="1.2"', 'data-elevation="0"'))),
    (err: unknown) => err instanceof PlanError && /floor-1/.test(err.message) && /platform:/.test(err.message),
  );
  assert.throws(
    () => deriveLanding(landingPage(landingRect("s1-mid", 'x="10" y="4" width="2.6" height="1.2"', 'data-elevation="3"'))),
    (err: unknown) => err instanceof PlanError && /floor-2/.test(err.message) && /platform:/.test(err.message),
  );
  const orphan = deriveLanding(landingPage(landingRect("alone", 'x="2" y="8" width="2" height="2"', 'data-elevation="1.2"')));
  assert.deepEqual(orphan.warnings, ['landing "b.alone" joins no stairs']);
  const dead = deriveLanding(landingPage(
    flight("s1a", 10, "+y", "0", "1.5") + landingRect("s1-mid", 'x="10" y="4" width="2.6" height="1.2"', 'data-elevation="1.5"'),
  ));
  assert.deepEqual(dead.warnings, ['landing "b.s1-mid" is a dead end']);
  const outside = deriveLanding(landingPage(landingRect("out", 'x="18" y="8" width="1" height="1"', 'data-elevation="1.2"')));
  assert.deepEqual(outside.warnings, [
    'landing "b.out" overlaps no floor outline',
    'landing "b.out" joins no stairs',
  ]);
  const shallow = deriveLanding(landingPage(
    flight("s1a", 10, "+y", "0", "1.5")
    + landingRect("s1-mid", 'x="10" y="4" width="2.6" height="0.5"', 'data-elevation="1.5"')
    + flight("s1b", 11.4, "-y", "1.5", "3"),
  ));
  assert.deepEqual(shallow.warnings, ['landing "b.s1-mid" is shallower than 0.8 m along the flight']);
});

test("a stairs-external landing is on the ground and skips the outline warning", () => {
  const result = deriveLanding(landingPage(
    "",
    landingRect("out", 'x="1" y="8" width="2" height="2"', 'data-elevation="1.2"'),
  ));
  assert.equal(result.warnings.some((warning) => warning.includes("overlaps")), false);
  const found = place(result.places, "b.out");
  assert.equal(found.kind, "landing");
  assert.equal(found.floor, "ground");
  assert.equal(found.y, 1.2);
  assert.deepEqual(result.warnings, ['landing "b.out" joins no stairs']);
});

test("readScene leaves places empty", () => {
  const scene = readScene(`<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="10mm" height="10mm" viewBox="0 0 10 10">
  <g inkscape:groupmode="layer" inkscape:label="buildings">
    <rect id="b" data-model="m" x="0" y="0" width="2" height="2"/>
  </g>
</svg>`);
  assert.deepEqual(scene.places, []);
});

function deriveLanding(svg: string) {
  return derivePlaces({
    buildings: [LANDING_BUILDING],
    floorsFor: () => readFloorsSvg(svg),
    roomFileFor: () => undefined,
  });
}

function stairOf(places: readonly AnyPlace[], id: string): StairsPlace {
  const found = place(places, id);
  assert.equal(found.kind, "stairs");
  return found as StairsPlace;
}

function landingPage(floor1: string, external = ""): string {
  const fp = (id: string, z: string) =>
    `<g id="${id}" data-model="bldg" transform="matrix(1,0,0,1,0,20)" ${z}><path d="M 0 0 L 16 0 L 16 -20 L 0 -20 Z"/></g>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
     width="20mm" height="20mm" viewBox="0 0 20 20">
  <sodipodi:namedview inkscape:document-units="mm" inkscape:document-scale="1"/>
  <g inkscape:groupmode="layer" inkscape:label="floor-1">${fp("fp1", "")}${floor1}</g>
  <g inkscape:groupmode="layer" inkscape:label="floor-2">${fp("fp2", 'z="3"')}</g>
  ${external ? `<g inkscape:groupmode="layer" inkscape:label="stairs-external">${external}</g>` : ""}
</svg>`;
}

function flight(id: string, x: number, up: string, bottom: string, top: string): string {
  return `<rect id="${id}" inkscape:label="stairs:${id}" x="${x}" y="2" width="1.2" height="2" data-up="${up}" data-bottom="${bottom}" data-top="${top}"/>`;
}

function landingRect(id: string, box: string, attrs: string): string {
  return `<rect id="${id}" inkscape:label="landing:${id}" ${box} ${attrs}/>`;
}

function switchbackSvg(landing = true, top = "1.5"): string {
  const mid = landing ? landingRect("s1-mid", 'x="10" y="4" width="2.6" height="1.2"', 'data-elevation="1.5"') : "";
  return landingPage(flight("s1a", 10, "+y", "0", top) + mid + flight("s1b", 11.4, "-y", "1.5", "3"));
}

function place(places: readonly ScenePlace[], id: string): ScenePlace {
  const found = places.find((item) => item.id === id);
  assert.ok(found, id);
  return found;
}

/** Even-odd. A bridged hole stays outside. */
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

function floorsSvg(): string {
  return svgWrap(`
    ${layer("ignore", room("skipped"))}
    ${layer("floor-1", footprint("fp1", "") + room("room-1"))}
    ${layer("floor-2", footprint("fp2", 'z="2.75"') + room("room-2") + roof(), 'style="display:none"')}
  `);
}

function oneFloor(roomId: string): string {
  return svgWrap(layer("floor-1", footprint("fp1", "") + room(roomId)));
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

function layer(label: string, body: string, attrs = ""): string {
  return `<g inkscape:groupmode="layer" inkscape:label="${label}" ${attrs}>${body}</g>`;
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

const CAB_BUILDING = { id: "hall-b", model: "bldg", position: [10, 0, 20] as Vec3, yaw: 0 as Yaw, scale: 10 };

function deriveCab(svg: string, file: RoomFile) {
  return derivePlaces({
    buildings: [CAB_BUILDING],
    floorsFor: () => readFloorsSvg(svg),
    roomFileFor: (prefab) => (prefab === "cab" ? file : undefined),
  });
}

function cabPlace(places: readonly ScenePlace[]): ElevatorPlace {
  const found = place(places, "hall-b.e1");
  assert.equal(found.kind, "elevator");
  return found as ElevatorPlace;
}

function closeLanding(actual: Vec3, expected: Vec3): void {
  for (let i = 0; i < 3; i += 1) {
    assert.ok(Math.abs(actual[i]! - expected[i]!) <= 1e-6, `${actual} vs ${expected}`);
  }
}

function cabFile(wall: "front" | "back" | "left" | "right" | null): RoomFile {
  return {
    footprint: { minX: -1, maxX: 1, minZ: -1, maxZ: 1 },
    doors: wall
      ? [{ id: "d", model: "door", wall, center: [0, 0, 0], width: 1, height: 2, hinge: "left", open: false }]
      : [],
  } as RoomFile;
}

/** Shaft at page (2, 36) size 2×2, the same rectangle as `cabRoom`. */
function cabFloors(floor1: string, elevatorAttrs = "", floor2 = ""): string {
  const shaft = `<rect id="e1" inkscape:label="elevator:e1" x="2" y="36" width="2" height="2" ${elevatorAttrs}/>`;
  return svgWrap(`
    ${layer("floor-1", footprint("fp1", "") + floor1 + shaft)}
    ${layer("floor-2", footprint("fp2", 'z="2.75"') + floor2)}
  `);
}

function cabRoom(id: string, floorAttr = ""): string {
  return `<rect id="${id}" inkscape:label="model:cab" x="2" y="36" width="2" height="2" ${floorAttr}/>`;
}

/** Page 20 mm. Local metres match the path: an L of area 4 inside an AABB of area 6. */
function lSvg(room = ""): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
     width="20mm" height="20mm" viewBox="0 0 20 20">
  <sodipodi:namedview inkscape:document-units="mm"/>
  <g inkscape:groupmode="layer" inkscape:label="floor-1">
    <g id="fp" data-model="bldg" transform="matrix(1,0,0,1,0,20)">
      <path d="M 0 0 L 3 0 L 3 -1 L 1 -1 L 1 -2 L 0 -2 Z"/>
    </g>
    ${room}
  </g>
</svg>`;
}

/** Room centre (2, 0.4), size 1 by 0.4, inside the long leg of the L. */
function lRoom(): string {
  return `<rect id="leg" inkscape:label="model:room-b" x="1.5" y="19.4" width="1" height="0.4"/>`;
}

function diagonalSvg(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
     width="20mm" height="20mm" viewBox="0 0 20 20">
  <sodipodi:namedview inkscape:document-units="mm"/>
  <g inkscape:groupmode="layer" inkscape:label="floor-1">
    <g id="fp" data-model="bldg" transform="matrix(1,0,0,1,0,20)">
      <path d="M 0 0 L 1 0 L 0 -1 Z"/>
    </g>
  </g>
</svg>`;
}

function polygonArea(polygon: readonly (readonly [number, number])[]): number {
  let area = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const point = polygon[i]!;
    const next = polygon[(i + 1) % polygon.length]!;
    area += point[0] * next[1] - next[0] * point[1];
  }
  return area / 2;
}

/** A sample inside the footprint AABB and outside the outline. */
function notchOf(
  footprint: readonly (readonly [number, number])[],
  outline: readonly (readonly [number, number])[],
): [number, number] | undefined {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of footprint) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  for (let i = 1; i < 24; i += 1) {
    for (let k = 1; k < 24; k += 1) {
      const x = minX + (i / 24) * (maxX - minX);
      const z = minZ + (k / 24) * (maxZ - minZ);
      if (inside(footprint, x, z) && !inside(outline, x, z)) return [x, z];
    }
  }
  return undefined;
}
