import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { PlanError } from "../src/errors.ts";
import { readFloorsSvg } from "../src/floors-svg.ts";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "buildings", "brutalist-building-2-cbake.floors.svg");

test("brutalist-building-2 floors are building-local", () => {
  const source = readFloorsSvg(readFileSync(FIXTURE, "utf8"));
  assert.equal(source.model, "brutalist-building-2-cbake");
  closeTo(source.scale, 30);
  assert.equal(source.yaw, 90);
  closeTo(source.origin[0], 7.2964);
  assert.equal(source.origin[1], 0);
  closeTo(source.origin[2], 15.1878);

  assert.equal(source.floors.length, 3);
  const [floor1, floor2, floor3] = source.floors;
  assert.equal(floor1!.n, 1);
  assert.equal(floor1!.name, "floor-1");
  closeTo(floor1!.elevation, 0);
  closeTo(floor1!.height!, 2.75);
  assert.equal(floor1!.rooms.length, 1);
  assert.equal(floor2!.n, 2);
  closeTo(floor2!.elevation, 2.75);
  closeTo(floor2!.height!, 2.75);
  assert.equal(floor2!.rooms.length, 1);
  assert.equal(floor3!.n, 3);
  closeTo(floor3!.elevation, 5.5);
  assert.equal(floor3!.height, undefined);
  assert.equal(floor3!.rooms.length, 0);

  const room = floor1!.rooms[0]!;
  assert.equal(room.id, "room-b-1");
  assert.equal(room.prefab, "room-b");
  closeTo(room.center.x, -12.2012);
  closeTo(room.center.z, -4.1944);
  assert.equal(room.yaw, 270);
  closeTo(room.drawnWidth, 5.4695);
  closeTo(room.drawnDepth, 5.4695);
  const upper = floor2!.rooms[0]!;
  assert.equal(upper.id, "room-b-1-3");
  assert.equal(upper.prefab, "room-b");
  closeTo(upper.center.x, -12.2012);
  closeTo(upper.center.z, -4.1944);
  assert.equal(upper.yaw, 270);

  assert.equal(source.doors.length, 2);
  const door = source.doors.find((item) => item.id === "door-1-1-9-2");
  assert.ok(door);
  assert.equal(door.model, "door-2");
  assert.equal(door.building, "brutalist-building-2-cbake");
  assert.equal(door.locked, true);
  assert.equal(door.key, "key");
  assert.equal(door.center[1], 0);
  closeTo(door.minX, -15.2375);
  closeTo(door.maxX, -14.9875);
  closeTo(door.minZ, -4.6175);
  closeTo(door.maxZ, -3.5355);
  const upperDoor = source.doors.find((item) => item.id === "door-1-1-9-2-4");
  assert.ok(upperDoor);
  assert.equal(upperDoor.center[1], 2.75);
  closeTo(upperDoor.minZ, -3.1432);
  closeTo(upperDoor.maxZ, -2.0612);

  assert.equal(source.props.length, 13);
  assert.equal(source.props.filter((prop) => prop.model === "step").length, 12);
  const step = source.props.find((prop) => prop.id === "rect13030");
  assert.ok(step);
  assert.equal(step.model, "step");
  closeTo(step.position[0], -15.9875);
  assert.equal(step.position[1], 0);
  closeTo(step.position[2], 2.5388);
  const landing = source.props.find((prop) => prop.id === "rect13030-5-9");
  assert.ok(landing);
  closeTo(landing.position[0], -15.9875);
  assert.equal(landing.position[1], 2.75);
  closeTo(landing.position[2], -1.8612);
  const weapon = source.props.find((prop) => prop.id === "alien-weapon-1");
  assert.ok(weapon);
  assert.equal(weapon.model, "alien-weapon-enh");
  assert.equal(weapon.position[1], 3.75);
});

test("an unrotated stencil keeps local positions as world minus origin", () => {
  const source = readFloorsSvg(svgWrap(layer("floor-1", `
    ${footprint("fp", "bldg", "matrix(30,0,0,30,4,6)")}
    ${room("room-a", 1, 2, 2, 4)}
  `) + layer("stairs-external", `<rect id="step-a" inkscape:label="model:step" x="8" y="8" width="2" height="2"/>`)));
  assert.equal(source.yaw, 0);
  assert.equal(source.scale, 30);
  assert.deepEqual(source.origin, [4, 0, 14]);
  assert.deepEqual(source.floors[0]!.rooms[0]!.center, { x: -2, z: 2 });
  assert.equal(source.floors[0]!.rooms[0]!.yaw, 0);
  assert.equal(source.floors[0]!.rooms[0]!.drawnWidth, 2);
  assert.equal(source.floors[0]!.rooms[0]!.drawnDepth, 4);
  assert.deepEqual(source.props[0]!.position, [5, 0, -3]);
  assert.equal(source.props[0]!.yaw, 0);
});

test("floors sort by n, nested layers stay on the floor, and the top floor keeps data-height", () => {
  const source = readFloorsSvg(svgWrap(`
    ${layer("ignore", layer("walls", room("skipped", 1, 1, 2, 2)))}
    ${layer("floor-2", footprint("b", "bldg", "matrix(30,0,0,30,4,6)", 'z="3"'), 'data-height="1.5"')}
    ${layer("floor-1", layer("rooms", room("room-a", 1, 2, 2, 2)) + footprint("a", "bldg", "matrix(30,0,0,30,4,6)"))}
    ${layer("doors-external", `<rect id="door-a" inkscape:label="model:door-2" x="1" y="1" width="1" height="2"/>`)}
  `));
  assert.deepEqual(source.floors.map((floor) => floor.n), [1, 2]);
  assert.equal(source.floors[0]!.height, 3);
  assert.equal(source.floors[0]!.rooms.length, 1);
  assert.equal(source.floors[0]!.rooms[0]!.id, "room-a");
  assert.equal(source.floors[1]!.height, 1.5);
  assert.equal(source.doors.length, 1);
  assert.equal(source.doors[0]!.building, "bldg");
  assert.equal(source.doors[0]!.center[1], 0);
});

test("floors files reject a bad layer, footprint, elevation, room, or door", () => {
  const fp = footprint("a", "bldg", "matrix(0,30,-30,0,10,10)");
  fails(svgWrap(layer("walls", fp)), /floors file layer "walls" is not floor-<n>, floor-<n>-texture, doors-external, stairs-external or ignore/);
  fails(svgWrap(layer("floor-x", fp)), /floors file layer "floor-x" is not floor-<n>, floor-<n>-texture, doors-external, stairs-external or ignore/);
  fails(svgWrap(layer("floor-1", room("room-a", 1, 1, 2, 2))), /floor-1 needs exactly one footprint/);
  fails(svgWrap(layer("floor-1", fp + footprint("c", "bldg", "matrix(0,30,-30,0,10,10)"))), /floor-1 needs exactly one footprint/);
  fails(
    svgWrap(layer("floor-1", fp) + layer("floor-2", footprint("b", "bldg", "matrix(0,30,-30,0,11,10)", 'z="2.75"'))),
    /floor-2 footprint does not match floor-1/,
  );
  fails(
    svgWrap(layer("floor-1", footprint("a", "bldg", "matrix(0,30,-30,0,10,10)", 'z="5"')) + layer("floor-2", footprint("b", "bldg", "matrix(0,30,-30,0,10,10)", 'z="1"'))),
    /floor-2 elevation must be above floor-1/,
  );
  fails(
    svgWrap(layer("floor-1", fp + room("room-a", 1, 1, 2, 2, 'transform="rotate(45)"'))),
    /rotation 45° is not 0, 90, 180, or 270/,
  );
  fails(
    svgWrap(layer("floor-1", fp + room("room-a", 1, 1, 2, 2, 'transform="scale(1.1)"'))),
    /room "room-a" must not be scaled/,
  );
  fails(
    svgWrap(layer("floor-1", fp + room("shared", 1, 1, 2, 2)) + layer("doors-external", `<rect id="shared" inkscape:label="model:door-2" x="1" y="1" width="1" height="2"/>`)),
    /duplicate id "shared"/,
  );
  fails(
    svgWrap(layer("floor-1", fp) + layer("doors-external", `<rect id="door-a" inkscape:label="model:door-2" x="1" y="1" width="1" height="2" data-building="other"/>`)),
    /door "door-a" data-building must be "bldg" or absent/,
  );
});

test("blueprint-scene floors prints the summary and writes nothing", () => {
  const bin = path.join(import.meta.dirname, "..", "bin", "blueprint-scene");
  const cli = spawnSync(bin, ["floors", "--svg", FIXTURE], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(
    cli.stdout,
    "floors brutalist-building-2-cbake: 3 floors (z 0, 2.75, 5.5), 2 rooms, 2 doors, 13 stairs props\n",
  );
  const missing = spawnSync(bin, ["floors"], { encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /missing --svg/);
  assert.match(missing.stderr, /blueprint-scene floors/);
});

function svgWrap(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:xlink="http://www.w3.org/1999/xlink"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
     width="20mm" height="20mm" viewBox="0 0 20 20">
  <sodipodi:namedview inkscape:document-units="mm" inkscape:document-scale="1"/>
  ${body}
</svg>`;
}

function layer(label: string, body: string, attrs = ""): string {
  return `<g inkscape:groupmode="layer" inkscape:label="${label}" ${attrs}>${body}</g>`;
}

function footprint(id: string, model: string, transform: string, attrs = ""): string {
  return `<g id="${id}" data-model="${model}" inkscape:label="footprint" transform="${transform}" ${attrs}><path d="M 0 0 L 1 0 L 1 -1 Z"/></g>`;
}

function room(id: string, x: number, y: number, width: number, height: number, attrs = ""): string {
  return `<rect id="${id}" inkscape:label="model:room-b" x="${x}" y="${y}" width="${width}" height="${height}" ${attrs}/>`;
}

function fails(svg: string, pattern: RegExp): void {
  assert.throws(
    () => readFloorsSvg(svg),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      return err instanceof PlanError && pattern.test(message);
    },
    `expected ${pattern}`,
  );
}

function closeTo(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) <= 1e-3, `${actual} is not within 0.001 of ${expected}`);
}
