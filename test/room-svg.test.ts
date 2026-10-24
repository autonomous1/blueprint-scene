import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PlanError } from "../src/errors.ts";
import { layerRole, readRoomSvg, wallLine } from "../src/room-svg.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const FIXTURE = path.join(import.meta.dirname, "fixtures", "rooms", "room-b.svg");
const TEX = dataUri(markedPng(1));

test("room-b is 6 by 6 by 3 with the drawn faces", () => {
  const staged = stage();
  try {
    const room = readRoomSvg(readFileSync(staged.svgPath, "utf8"), staged.svgPath);
    assert.equal(room.id, "room-b");
    assert.equal(room.svgPath, staged.svgPath);
    assertNear(room.width, 6);
    assertNear(room.depth, 6);
    assertNear(room.height, 3);
    assertNear(room.footprint.minX, -3);
    assertNear(room.footprint.maxX, 3);
    assertNear(room.footprint.minZ, -3);
    assertNear(room.footprint.maxZ, 3);
    assert.ok(room.faces.front.ref.endsWith("long-wall.png"), room.faces.front.ref);
    assert.ok(room.faces.left.ref.endsWith("short-wall-2.png"), room.faces.left.ref);
    assert.ok(room.faces.right.ref.endsWith("long-wall-2.png"), room.faces.right.ref);
    assert.ok(room.faces.back.ref.endsWith("short-wall.png"), room.faces.back.ref);
    assert.ok(room.faces.floor.ref.endsWith("floor.png"), room.faces.floor.ref);
    assert.equal(room.faces.front.source, "front");
    assert.equal(room.faces.ceiling.source, "ceiling");
    assert.ok(room.faces.ceiling.ref.endsWith("ceiling.png"), room.faces.ceiling.ref);
    assert.equal(room.windows.length, 0);
    assert.equal(room.openings.length, 0);
    assert.equal(room.holes.length, 0);
    assert.equal(room.lights.length, 0);
    assert.deepEqual(room.warnings, []);

    const door = room.doors.find((item) => item.id === "door-1-1-9-22");
    assert.ok(door);
    assert.equal(door.model, "door-1");
    assert.equal(door.building, "room-b");
    assert.equal(door.wall, "left");
    assert.equal(door.locked, true);
    assert.equal(door.key, "key");
    assert.equal(door.hinge, "left");
    assert.equal(door.open, false);
    // The fixture rect has no z attribute, so the sill is 0. An explicit 2.75 is covered below.
    assert.equal(door.center[1], 0);
    assertNear(door.center[0], -3);
    assertNear(door.center[2], 0.1992);
    assertNear(door.minZ, -0.7458);
    assertNear(door.maxZ, 1.1442);

    const ammo = room.props.find((item) => item.id === "cover-crate-2-1");
    const kit = room.props.find((item) => item.id === "cover-crate-2-6");
    assert.ok(ammo);
    assert.ok(kit);
    assert.equal(ammo.model, "ammo-box");
    assert.equal(kit.model, "med-kit");
    assert.equal(ammo.position[1], 0);
    assert.equal(kit.position[1], 0);
    assertNear(ammo.position[0], -1.0094);
    assertNear(ammo.position[2], 2.0477);
    assertNear(kit.position[0], 0.5974);
    assertNear(kit.position[2], -1.6066);
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("a missing back and right reuse front and left, and a missing ceiling reuses the floor", () => {
  const staged = stage({
    mutate: (svg) => dropCeiling(dropImage(dropImage(svg, "image17655"), "image17817")),
  });
  try {
    const room = readRoomSvg(readFileSync(staged.svgPath, "utf8"), staged.svgPath);
    assert.equal(room.faces.back.source, "front");
    assert.equal(room.faces.back.ref, room.faces.front.ref);
    assert.equal(room.faces.right.source, "left");
    assert.equal(room.faces.right.ref, room.faces.left.ref);
    assert.equal(room.faces.ceiling.source, "floor");
    assert.equal(room.faces.ceiling.ref, room.faces.floor.ref);
    assertNear(room.width, 6);
    assertNear(room.depth, 6);
    assertNear(room.height, 3);
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("an embedded floor image keeps the data URI", () => {
  const uri = dataUri(markedPng(9));
  const staged = stage({
    mutate: (svg) => svg.replace('xlink:href="floor.png"', `xlink:href="${uri}"`),
    skip: ["floor.png"],
  });
  try {
    const room = readRoomSvg(readFileSync(staged.svgPath, "utf8"), staged.svgPath);
    assert.equal(room.faces.floor.ref, uri);
    assert.equal(room.faces.floor.source, "floor");
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("a missing linked floor falls back to sodipodi:absref", () => {
  const staged = stage({ skip: ["floor.png"] });
  const elsewhere = path.join(staged.dir, "elsewhere");
  const abs = path.join(elsewhere, "floor.png");
  try {
    mkdirSync(elsewhere);
    writeFileSync(abs, markedPng(4));
    const svg = readFileSync(staged.svgPath, "utf8").replace(
      'sodipodi:absref="/home/tim/dev/conveyor-engine-arena/dev/scenes/arena-1/designs/rooms/floor.png"',
      `sodipodi:absref="${abs}"`,
    );
    writeFileSync(staged.svgPath, svg);
    const room = readRoomSvg(svg, staged.svgPath);
    assert.equal(room.faces.floor.ref, abs);
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("a floor link missing at both paths names floor", () => {
  const staged = stage({
    mutate: (svg) => svg.replace(
      'sodipodi:absref="/home/tim/dev/conveyor-engine-arena/dev/scenes/arena-1/designs/rooms/floor.png"',
      'sodipodi:absref="/tmp/blueprint-scene-missing-floor.png"',
    ),
    skip: ["floor.png"],
  });
  try {
    assert.throws(
      () => readRoomSvg(readFileSync(staged.svgPath, "utf8"), staged.svgPath),
      (err: unknown) => err instanceof PlanError && /face "floor"/.test((err as Error).message)
        && /floor\.png/.test((err as Error).message),
    );
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("a floor texture that is not a png fails", () => {
  const staged = stage({ skip: ["floor.png"] });
  try {
    writeFileSync(path.join(staged.dir, "floor.png"), Buffer.from("not a png"));
    assert.throws(
      () => readRoomSvg(readFileSync(staged.svgPath, "utf8"), staged.svgPath),
      (err: unknown) => err instanceof PlanError && /floor/.test((err as Error).message)
        && /png/.test((err as Error).message),
    );
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("a minimal room reuses a missing opposite and reads a 01_ floor layer", () => {
  const room = readRoomSvg(baseRoom(), "/tmp/room-a.svg");
  assert.equal(room.id, "room-a");
  assertNear(room.width, 6);
  assertNear(room.depth, 6);
  assertNear(room.height, 3);
  assert.equal(room.faces.back.source, "front");
  assert.equal(room.faces.right.source, "left");
  assert.equal(room.faces.ceiling.source, "floor");
  assert.equal(room.faces.floor.ref, TEX);
});

test("windows, openings, holes, and lights use the room frame", () => {
  const room = readRoomSvg(baseRoom(`
    ${layer("windows", `<rect id="win-1" x="4" y="7.9" width="2" height="0.2" data-wall="front" data-texture="${TEX}"/>`)}
    ${layer("openings", `<rect id="open-1" x="3" y="13.9" width="2" height="0.2" data-wall="back"/>`)}
    ${layer("holes", `<rect id="hole-1" x="4" y="11" width="1" height="1" data-cut="ceiling"/>`)}
    ${layer("lights", `
      <circle id="lamp" inkscape:label="light:lamp" cx="5" cy="11" r="0.2"/>
      <rect id="panel-light" inkscape:label="light:panel" x="4" y="10" width="0.4" height="0.2"
            data-width="0.8" data-height="0.3" data-intensity="150" data-color="#ffeedd" data-range="4"/>
    `)}
  `), "/tmp/room-a.svg");
  assert.equal(room.windows.length, 1);
  const win = room.windows[0]!;
  assert.equal(win.wall, "front");
  assert.equal(win.sill, 0.9);
  assert.equal(win.height, 1.2);
  assertNear(win.width, 2);
  assert.equal(win.glass, true);
  assert.equal(win.paneRef, TEX);
  assertNear((win.minZ + win.maxZ) / 2, 3);
  assertNear(win.maxZ - win.minZ, 0.2);
  const opening = room.openings[0]!;
  assert.equal(opening.wall, "back");
  assert.equal(opening.sill, 0);
  assert.equal(opening.height, 2.1);
  assertNear(opening.width, 2);
  assertNear((opening.minZ + opening.maxZ) / 2, -3);
  const hole = room.holes[0]!;
  assert.equal(hole.cut, "ceiling");
  assertNear(hole.minX, -1);
  assertNear(hole.maxX, 0);
  assertNear(hole.minZ, -1);
  assertNear(hole.maxZ, 0);
  assert.equal(room.lights.length, 2);
  const lamp = room.lights[0]!;
  assert.equal(lamp.id, "lamp");
  assertNear(lamp.x, 0);
  assertNear(lamp.z, 0);
  assertNear(lamp.y, 2.8);
  assert.equal(lamp.intensity, 12);
  assert.equal(lamp.color, "#ffffff");
  assert.equal(lamp.range, 0);
  assert.equal(lamp.width, undefined);
  const panel = room.lights[1]!;
  assert.equal(panel.id, "panel");
  assertNear(panel.x, -0.8);
  assertNear(panel.z, 0.9);
  assert.equal(panel.intensity, 150);
  assert.equal(panel.color, "#ffeedd");
  assert.equal(panel.range, 4);
  assert.equal(panel.width, 0.8);
  assert.equal(panel.height, 0.3);
  assert.equal(room.warnings.length, 1);
  assert.match(room.warnings[0]!, /150/);
});

test("a door sill of 2.75 below the room height is kept", () => {
  const room = readRoomSvg(baseRoom(doorLayer('x="1.8" y="10" width="0.4" height="2" data-wall="left" z="2.75"')), "/tmp/room-a.svg");
  assert.equal(room.doors[0]!.center[1], 2.75);
  assertNear(room.doors[0]!.center[0], -3);
});

test("room svg failures", () => {
  const file = "/tmp/room-a.svg";
  fails(svgWrap(layer("walls", `
    ${img("front", 'inkscape:label="front" x="2" y="5" width="6" height="3"')}
    ${img("left", 'inkscape:label="left" x="-14" y="-1" width="6" height="3" transform="rotate(-90)"')}
  `)), file, /missing floor/);
  fails(svgWrap(`
    ${layer("01_floor", img("floor", 'x="2" y="8" width="6" height="6"'))}
    ${layer("walls", img("left", 'inkscape:label="left" x="-14" y="-1" width="6" height="3" transform="rotate(-90)"'))}
  `), file, /missing front/);
  fails(baseRoom(layer("walls", img("front-2", 'inkscape:label="front" x="2" y="5" width="6" height="3"'))), file, /more than one "front"/);
  fails(baseRoom().replace('height="3" transform="rotate(-90)"', 'height="4" transform="rotate(-90)"'), file, /face "left": height/);
  fails(baseRoom().replace('width="6" height="6"', 'width="5" height="6"'), file, /face "floor"/);
  fails(baseRoom(doorLayer('x="1.8" y="10" width="0.4" height="2"')), file, /missing data-wall/);
  fails(baseRoom(doorLayer('x="1.8" y="10" width="0.4" height="2" data-wall="top"')), file, /data-wall "top"/);
  fails(baseRoom(doorLayer('x="3.8" y="10" width="0.4" height="2" data-wall="left"')), file, /from the left wall/);
  fails(baseRoom(doorLayer('x="1" y="10.8" width="2" height="0.4" data-wall="left"')), file, /long side/);
  fails(baseRoom(doorLayer('x="1.8" y="10" width="0.4" height="2" data-wall="left" z="3"')), file, /sill/);
  fails(baseRoom(doorLayer('x="1.8" y="10" width="0.4" height="2" data-wall="left" z="2" data-height="2"')), file, /above room height/);
  fails(baseRoom().replace(
    'inkscape:label="front" x="2" y="5" width="6" height="3"',
    'inkscape:label="front" x="2" y="5" width="6" height="3" transform="rotate(30)"',
  ), file, /rotation 30/);
  fails(baseRoom().replace(
    'inkscape:label="front" x="2" y="5" width="6" height="3"',
    'inkscape:label="front" x="2" y="5" width="6" height="3" transform="scale(2)"',
  ), file, /scale 2 is not 1/);
  fails(baseRoom(layer("doors", `<rect id="front" inkscape:label="model:door-1" x="1.8" y="10" width="0.4" height="2" data-wall="left"/>`)), file, /duplicate id/);
  fails(baseRoom(layer("lights", `<rect id="lamp" inkscape:label="light:lamp" x="4" y="10" width="0.4" height="0.2" data-intensity="0"/>`)), file, /data-intensity/);
  fails(baseRoom(layer("lights", `<rect id="lamp" inkscape:label="light:lamp" x="4" y="10" width="0.4" height="0.2" data-intensity="nope"/>`)), file, /not a finite number/);
  fails(baseRoom(), "/tmp/room b.svg", /invalid room id "room b"/);
  fails(baseRoom(layer("props", `<rect id="out-prop" inkscape:label="model:ammo-box" x="30" y="10" width="0.4" height="0.4"/>`)), file, /outside the room/);
  fails(baseRoom(layer("holes", `<rect id="cut" x="30" y="10" width="0.4" height="0.4"/>`)), file, /outside the room/);
  fails(baseRoom(layer("holes", `<rect id="cut" x="4" y="11" width="1" height="1" data-cut="wall"/>`)), file, /data-cut/);
});

test("layerRole strips a numeric prefix and wallLine is the inner face", () => {
  assert.equal(layerRole("01_Walls"), "walls");
  assert.equal(layerRole("ignore"), "ignore");
  assert.equal(layerRole("notes"), undefined);
  assert.equal(layerRole(undefined), undefined);
  assert.deepEqual(wallLine("front", 6, 4), { axis: "z", at: 2 });
  assert.deepEqual(wallLine("back", 6, 4), { axis: "z", at: -2 });
  assert.deepEqual(wallLine("left", 6, 4), { axis: "x", at: -3 });
  assert.deepEqual(wallLine("right", 6, 4), { axis: "x", at: 3 });
});

test("blueprint-scene room prints the summary and writes the GLB", () => {
  const bin = path.join(import.meta.dirname, "..", "bin", "blueprint-scene");
  const staged = stage();
  const outDir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-room-out-"));
  const out = path.join(outDir, "sub", "room-b.glb");
  try {
    const cli = spawnSync(bin, ["room", "--svg", staged.svgPath, "--out", out], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    const json = path.join(outDir, "sub", "room-b.room.json");
    assert.equal(
      cli.stdout,
      `room room-b: 6\u00d76\u00d73 m, 1 doors, 0 windows, 0 openings, 0 holes, 2 props, 0 lights\nwrote ${out}\nwrote ${json}\n`,
    );
    assert.equal(existsSync(out), true);
    const missingSvg = spawnSync(bin, ["room", "--out", out], { encoding: "utf8" });
    assert.notEqual(missingSvg.status, 0);
    assert.match(missingSvg.stderr, /missing --svg/);
    assert.match(missingSvg.stderr, /blueprint-scene room/);
    const missingOut = spawnSync(bin, ["room", "--svg", staged.svgPath], { encoding: "utf8" });
    assert.notEqual(missingOut.status, 0);
    assert.match(missingOut.stderr, /missing --out/);
    assert.match(missingOut.stderr, /blueprint-scene room/);
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

const PNG_NAMES = ["floor.png", "ceiling.png", "long-wall.png", "long-wall-2.png", "short-wall.png", "short-wall-2.png"];

function stage(options?: { mutate?: (svg: string) => string; skip?: string[] }): { dir: string; svgPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-room-"));
  const svgPath = path.join(dir, "room-b.svg");
  let svg = readFileSync(FIXTURE, "utf8");
  if (options?.mutate) svg = options.mutate(svg);
  writeFileSync(svgPath, svg);
  const skip = new Set(options?.skip ?? []);
  PNG_NAMES.forEach((name, index) => {
    if (!skip.has(name)) writeFileSync(path.join(dir, name), markedPng(index + 1));
  });
  return { dir, svgPath };
}

function dropImage(svg: string, id: string): string {
  const next = svg.replace(new RegExp(`\\s*<image\\b[^>]*\\bid="${id}"[^>]*/>`), "");
  if (next === svg) throw new Error(`fixture image ${id} not found`);
  return next;
}

function dropCeiling(svg: string): string {
  const next = svg.replace(/\s*<g\b[^>]*inkscape:label="ceiling"[\s\S]*?<\/g>/, "");
  if (next === svg) throw new Error("fixture ceiling layer not found");
  return next;
}

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

function layer(label: string, body: string): string {
  return `<g inkscape:groupmode="layer" inkscape:label="${label}">${body}</g>`;
}

function img(id: string, attrs: string): string {
  return `<image id="${id}" href="${TEX}" preserveAspectRatio="none" ${attrs}/>`;
}

function baseRoom(extra = ""): string {
  return svgWrap(`
    ${layer("01_floor", img("floor", 'x="2" y="8" width="6" height="6"'))}
    ${layer("walls", `
      ${img("front", 'inkscape:label="front" x="2" y="5" width="6" height="3"')}
      ${img("left", 'inkscape:label="left" x="-14" y="-1" width="6" height="3" transform="rotate(-90)"')}
    `)}
    ${extra}
  `);
}

function doorLayer(attrs: string): string {
  return layer("doors", `<rect id="door-a" inkscape:label="model:door-1" ${attrs}/>`);
}

function fails(svg: string, file: string, pattern: RegExp): void {
  assert.throws(
    () => readRoomSvg(svg, file),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      return err instanceof PlanError && pattern.test(message);
    },
    `expected ${pattern}`,
  );
}

function markedPng(mark: number): Buffer {
  const bytes = Buffer.from(PNG);
  bytes[20] = mark;
  return bytes;
}

function dataUri(png: Buffer): string {
  return `data:image/png;base64,${png.toString("base64")}`;
}

function assertNear(got: number, expected: number): void {
  assert.ok(Math.abs(got - expected) < 1e-4, `${got} !== ${expected}`);
}
