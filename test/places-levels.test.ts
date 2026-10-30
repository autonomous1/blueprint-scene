import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PlanError } from "../src/errors.ts";
import { readFloorsSvg } from "../src/floors-svg.ts";
import { derivePlaces } from "../src/places.ts";
import type { RoomFile } from "../src/room-file.ts";
import type { AnyPlace, ElevatorPlace, StairsPlace, Vec3, Yaw } from "../src/types.ts";

const ARENA_FLOORS = "/home/tim/dev/conveyor-engine-arena/dev/scenes/arena-1/designs/floorplans/brutalist-building-2-cbake.floors.svg";

const BUILDING = { id: "hall-b", model: "bldg", position: [10, 0, 20] as Vec3, yaw: 0 as Yaw, scale: 10 };

test("a floor-1 stair uses the next floor, lands 4.8 m along +x, and joins both halls", () => {
  const result = derive(twoFloors(stair("s1", 12, 32.5, 4, 1, 'data-up="+x"')));
  assert.deepEqual(result.warnings, []);
  const place = stairsPlace(result.places, "hall-b.s1");
  assert.equal(place.floor, "1");
  assert.equal(place.y, 0);
  assert.equal(place.top, 2.75);
  assert.equal(place.width, 1);
  assert.equal(place.run, 4);
  closeVec(place.landings.bottom, [21.6, 0, 27]);
  closeVec(place.landings.top, [26.4, 2.75, 27]);
  assert.ok(Math.abs(xzDistance(place.landings.bottom, place.landings.top) - 4.8) < 1e-6);
  assert.equal(place.joins.from, "hall-b.floor-1.hall");
  assert.equal(place.joins.to, "hall-b.floor-2.hall");
});

test("a rotated stair turns its landings, and building yaw 90 turns them again", () => {
  const turned = derive(twoFloors(
    `<g transform="rotate(90 14 33)">${stair("s1", 12, 32.5, 4, 1, 'data-up="+x"')}</g>`,
  ));
  assert.deepEqual(turned.warnings, []);
  const group = stairsPlace(turned.places, "hall-b.s1");
  assert.equal(group.width, 1);
  assert.equal(group.run, 4);
  closeVec(group.landings.bottom, [24, 0, 29.4]);
  closeVec(group.landings.top, [24, 2.75, 24.6]);
  assert.ok(Math.abs(xzDistance(group.landings.bottom, group.landings.top) - 4.8) < 1e-6);

  const yawed = derive(
    twoFloors(`<g transform="rotate(90 14 33)">${stair("s1", 12, 32.5, 4, 1, 'data-up="+x"')}</g>`),
    { ...BUILDING, yaw: 90 },
  );
  const place = stairsPlace(yawed.places, "hall-b.s1");
  closeVec(place.landings.bottom, [19.4, 0, 6]);
  closeVec(place.landings.top, [14.6, 2.75, 6]);
  assert.ok(Math.abs(xzDistance(place.landings.bottom, place.landings.top) - 4.8) < 1e-6);
});

test("an outside stair needs data-top, and model:step props stay props", () => {
  const body = `
    <rect id="step-a" inkscape:label="model:step" x="1" y="1" width="0.4" height="1.5"/>
    ${stair("s2", 12, 32.5, 4, 1, 'data-top="2.75" data-up="+x"')}
  `;
  const source = readFloorsSvg(twoFloors("", "", body));
  assert.equal(source.props.length, 1);
  assert.equal(source.props[0]!.id, "step-a");
  assert.equal(source.props[0]!.model, "step");
  assert.equal(source.stairs.length, 1);
  assert.equal(source.props.some((prop) => prop.id === "s2"), false);

  const result = derive(twoFloors("", "", body));
  const place = stairsPlace(result.places, "hall-b.s2");
  assert.equal(place.floor, "ground");
  assert.equal(place.y, 0);
  assert.equal(place.top, 2.75);
  assert.equal(place.joins.from, "hall-b.floor-1.hall");
  assert.equal(place.joins.to, "hall-b.floor-2.hall");

  assert.throws(
    () => derive(twoFloors("", "", stair("s2", 12, 32.5, 4, 1, 'data-up="+x"'))),
    (err: unknown) => err instanceof PlanError,
  );
});

test("a steep stair, a flat stair, a square stair, and a duplicate id are PlanErrors", () => {
  const run = (extra: string) => derive(twoFloors(extra));
  assert.throws(() => run(stair("s1", 12, 32.5, 2, 1, 'data-up="+x"')), isPlan);
  assert.throws(() => run(stair("s1", 12, 32.5, 4, 1, 'data-up="+x" data-top="0"')), isPlan);
  assert.throws(() => run(stair("sq", 12, 32.5, 1, 1)), isPlan);
  assert.throws(
    () => run(stair("s1", 12, 32.5, 4, 1, 'data-up="+x"') + stair("s1", 2, 32.5, 4, 1, 'data-up="+x"')),
    isPlan,
  );
  assert.throws(
    () => derive(twoFloors("", stair("top", 12, 32.5, 4, 1, 'data-up="+x"'))),
    isPlan,
  );
});

test("an elevator defaults to the floors above it and rejects a falling stop list", () => {
  const result = derive(twoFloors(elevator("e1", 2, 36, 2, 2)));
  assert.deepEqual(result.warnings, []);
  const place = elevatorPlace(result.places, "hall-b.e1");
  assert.equal(place.floor, "1");
  assert.deepEqual(place.stops, [0, 2.75]);
  assert.equal(place.waitS, 8);
  assert.equal(place.speed, 1);
  assert.equal(place.landings.length, 2);
  closeVec(place.landings[0]!, [13, 0, 21.4]);
  closeVec(place.landings[1]!, [13, 2.75, 21.4]);
  assert.deepEqual(place.joins, ["hall-b.floor-1.hall", "hall-b.floor-2.hall"]);

  assert.throws(
    () => derive(twoFloors(elevator("e1", 2, 36, 2, 2, 'data-stops="2.75,0"'))),
    isPlan,
  );
});

test("a raised building lifts stair landings and elevator stops", () => {
  const svg = twoFloors(
    stair("s1", 12, 32.5, 4, 1, 'data-up="+x"') + elevator("e1", 2, 36, 2, 2),
  );
  const result = derive(svg, { ...BUILDING, position: [10, 1, 20] });
  const stairPlace = stairsPlace(result.places, "hall-b.s1");
  closeVec(stairPlace.landings.bottom, [21.6, 1, 27]);
  closeVec(stairPlace.landings.top, [26.4, 3.75, 27]);
  assert.equal(stairPlace.top, 3.75);
  const cab = elevatorPlace(result.places, "hall-b.e1");
  assert.deepEqual(cab.stops, [1, 3.75]);
  closeVec(cab.landings[0]!, [13, 1, 21.4]);
  closeVec(cab.landings[1]!, [13, 3.75, 21.4]);
});

test("floor-3's hall follows floor-3's outline, not floor-1's", () => {
  const room = `<rect id="room-3" inkscape:label="model:room-b" x="0.5" y="18.75" width="1" height="0.5"/>`;
  const source = readFloorsSvg(setbackSvg(room));
  assert.equal(source.floors.length, 3);
  assert.ok(Math.abs(polygonArea(source.outline) - 12) < 1e-6);
  assert.ok(Math.abs(polygonArea(source.floors[2]!.outline) - 4) < 1e-6);
  const file: RoomFile = { footprint: { minX: -0.5, maxX: 0.5, minZ: -0.25, maxZ: 0.25 } } as RoomFile;
  const result = derivePlaces({
    buildings: [{ id: "setback", model: "bldg", position: [0, 0, 0], yaw: 0, scale: 1 }],
    floorsFor: () => source,
    roomFileFor: () => file,
  });
  assert.deepEqual(result.warnings, []);
  const hall = mustPlace(result.places, "setback.floor-3.hall");
  const lower = mustPlace(result.places, "setback.floor-1.hall");
  const hallArea = Math.abs(polygonArea(hall.polygon));
  const expected = 1.9 * 1.9 - 0.5;
  assert.ok(Math.abs(hallArea - expected) < 1e-4, String(hallArea));
  assert.ok(Math.abs(polygonArea(lower.polygon)) - hallArea > 5);
  assert.ok(hall.bounds.maxX < 2);
  assert.ok(lower.bounds.maxX > 3);
});

test("an elevator shaft that leaves a set-back floor is a PlanError naming that floor", () => {
  const cab = elevator("e1", 2.5, 18.5, 1, 1);
  assert.throws(
    () => derivePlaces({
      buildings: [{ id: "setback", model: "bldg", position: [0, 0, 0], yaw: 0, scale: 1 }],
      floorsFor: () => readFloorsSvg(setbackSvg(cab, "floor-1")),
      roomFileFor: () => undefined,
    }),
    (err: unknown) => err instanceof PlanError && /floor-3/.test(err instanceof Error ? err.message : ""),
  );
});

test("a room rect outside its own floor outline is a PlanError", () => {
  const room = `<rect id="room-out" inkscape:label="model:room-b" x="2.8" y="18.8" width="0.4" height="0.4"/>`;
  assert.throws(
    () => derivePlaces({
      buildings: [{ id: "setback", model: "bldg", position: [0, 0, 0], yaw: 0, scale: 1 }],
      floorsFor: () => readFloorsSvg(setbackSvg(room, "floor-3")),
      roomFileFor: () => ({ footprint: { minX: -0.2, maxX: 0.2, minZ: -0.2, maxZ: 0.2 } }) as RoomFile,
    }),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : "";
      return err instanceof PlanError && /room-out/.test(message) && /floor-3/.test(message);
    },
  );
});

test("brutalist-building-2 still has its step props and no stair or elevator sources", () => {
  const source = readFloorsSvg(readFileSync(ARENA_FLOORS, "utf8"), ARENA_FLOORS);
  assert.equal(source.props.length, 16);
  assert.equal(source.props.filter((prop) => prop.model === "step").length, 16);
  assert.equal(source.stairs.length, 0);
  assert.equal(source.elevators.length, 0);
});

function derive(
  svg: string,
  building: { id: string; model: string; position: Vec3; yaw: Yaw; scale: number } = BUILDING,
) {
  return derivePlaces({
    buildings: [building],
    floorsFor: () => readFloorsSvg(svg),
    roomFileFor: () => undefined,
  });
}

function isPlan(err: unknown): boolean {
  return err instanceof PlanError;
}

function mustPlace(places: readonly AnyPlace[], id: string): AnyPlace {
  const found = places.find((place) => place.id === id);
  assert.ok(found, id);
  return found;
}

function stairsPlace(places: readonly AnyPlace[], id: string): StairsPlace {
  const found = mustPlace(places, id);
  assert.equal(found.kind, "stairs");
  return found as StairsPlace;
}

function elevatorPlace(places: readonly AnyPlace[], id: string): ElevatorPlace {
  const found = mustPlace(places, id);
  assert.equal(found.kind, "elevator");
  return found as ElevatorPlace;
}

function closeVec(actual: Vec3, expected: Vec3): void {
  for (let i = 0; i < 3; i += 1) {
    assert.ok(Math.abs(actual[i]! - expected[i]!) <= 1e-6, `${actual} vs ${expected}`);
  }
}

function xzDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
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

function twoFloors(floor1 = "", floor2 = "", external = ""): string {
  return svgWrap(`
    ${layer("floor-1", footprint("fp1", "") + floor1)}
    ${layer("floor-2", footprint("fp2", 'z="2.75"') + floor2)}
    ${external ? layer("stairs-external", external) : ""}
  `);
}

/** `extra` is inserted on `floor`. Floors 1 and 2 share a 4×3 outline; floor 3 is 2×2. */
function setbackSvg(extra = "", floor = "floor-3"): string {
  const on = (label: string, body: string) => (label === floor ? body + extra : body);
  const big = stencil("a", "M 0 0 L 4 0 L 4 -3 L 0 -3 Z", "");
  const mid = stencil("b", "M 0 0 L 4 0 L 4 -3 L 0 -3 Z", 'z="1"');
  const top = stencil("c", "M 0 0 L 2 0 L 2 -2 L 0 -2 Z", 'z="2"');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
     width="20mm" height="20mm" viewBox="0 0 20 20">
  <sodipodi:namedview inkscape:document-units="mm" inkscape:document-scale="1"/>
  ${layer("floor-1", on("floor-1", big))}
  ${layer("floor-2", on("floor-2", mid))}
  ${layer("floor-3", on("floor-3", top))}
</svg>`;
}

function stencil(id: string, path: string, attrs: string): string {
  return `<g id="${id}" data-model="bldg" transform="matrix(1,0,0,1,0,20)" ${attrs}><path d="${path}"/></g>`;
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

function stair(id: string, x: number, y: number, width: number, height: number, attrs = ""): string {
  return `<rect id="${id}" inkscape:label="stairs:${id}" x="${x}" y="${y}" width="${width}" height="${height}" ${attrs}/>`;
}

function elevator(id: string, x: number, y: number, width: number, height: number, attrs = ""): string {
  return `<rect id="${id}" inkscape:label="elevator:${id}" x="${x}" y="${y}" width="${width}" height="${height}" ${attrs}/>`;
}
