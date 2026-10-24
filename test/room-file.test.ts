import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DOOR_HEIGHT_M } from "../src/doors.ts";
import { PlanError } from "../src/errors.ts";
import type { XzRect } from "../src/footprint.ts";
import { writeTriangleGlb } from "../src/glb-write.ts";
import { roomFile } from "../src/room-file.ts";
import { writeRoom } from "../src/room-glb.ts";
import type { FaceTexture, RoomFace, RoomSource, RoomWindow } from "../src/room-svg.ts";
import type { Vec3 } from "../src/types.ts";
import { trianglesFromWalls } from "./boxes.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const TEX = dataUri(markedPng(1));
const FIXTURE = path.join(import.meta.dirname, "fixtures", "rooms", "room-b.svg");
const PNG_NAMES = ["floor.png", "ceiling.png", "long-wall.png", "long-wall-2.png", "short-wall.png", "short-wall-2.png"];

test("room-b svg path writes collision, one walkable rect, and the door", () => {
  const staged = stage();
  const out = path.join(staged.dir, "room-b.glb");
  try {
    const written = writeRoom({ svgPath: staged.svgPath, outPath: out });
    const jsonPath = path.join(staged.dir, "room-b.room.json");
    const text = readFileSync(jsonPath, "utf8");
    assert.equal(text.includes("/home"), false);
    assert.equal(text.includes(staged.dir), false);
    assert.equal(text.includes(tmpdir()), false);
    assert.equal(text.endsWith("\n"), true);
    assert.deepEqual(JSON.parse(text), written.file);

    const file = written.file;
    assert.equal(file.source, "svg");
    assert.equal(file.glb, "room-b.glb");
    assert.equal(file.id, "room-b");
    assert.equal(file.props.length, 2);
    assert.deepEqual(file.lights, []);
    const ammo = file.props.find((item) => item.id === "cover-crate-2-1");
    const kit = file.props.find((item) => item.id === "cover-crate-2-6");
    assert.ok(ammo);
    assert.ok(kit);
    assert.equal(ammo.model, "ammo-box");
    assert.equal(kit.model, "med-kit");
    assert.ok(near(ammo.position, [-1.0094, 0, 2.0477]), ammo.position.join(","));
    assert.ok(near(kit.position, [0.5974, 0, -1.6066]), kit.position.join(","));
    for (const prop of [ammo, kit]) {
      assert.ok(prop.yaw === 0 || prop.yaw === 90 || prop.yaw === 180 || prop.yaw === 270);
      assert.ok(prop.scale > 0);
      assert.ok(prop.drawnWidth > 0);
      assert.ok(prop.drawnDepth > 0);
    }
    assert.deepEqual(
      file.obstacles.map((box) => box.id).sort(),
      ["back.0", "floor.0", "front.0", "left.0", "left.1", "left.2", "right.0"],
    );
    assert.equal(file.obstacles.some((box) => box.id.startsWith("ceiling")), false);
    assert.deepEqual(box(file, "front.0"), {
      id: "front.0", minX: -3, maxX: 3, minY: 0, maxY: 3, minZ: 3, maxZ: 3.2,
    });
    assert.deepEqual(box(file, "floor.0"), {
      id: "floor.0", minX: -3, maxX: 3, minY: -0.1, maxY: 0, minZ: -3, maxZ: 3,
    });

    const door = written.room.doors[0];
    assert.ok(door);
    assert.equal(door.wall, "left");
    const width = door.width ?? door.maxZ - door.minZ;
    const height = door.height ?? DOOR_HEIGHT_M;
    assert.equal(height, 2.1);
    const z0 = door.center[2] - width / 2;
    const z1 = door.center[2] + width / 2;
    const left = file.obstacles.filter((item) => item.id.startsWith("left."));
    assert.equal(left.length, 3);
    for (const item of left) {
      assert.equal(item.minX, -3.2);
      assert.equal(item.maxX, -3);
      const zHit = item.maxZ > z0 + 1e-6 && item.minZ < z1 - 1e-6;
      const yHit = item.maxY > 0.01 && item.minY < 2.09;
      assert.equal(zHit && yHit, false, item.id);
    }

    assert.deepEqual(file.walkable, [{ minX: -3, maxX: 3, minZ: -3, maxZ: 3 }]);
    assert.deepEqual(file.holes, []);
    assert.equal(file.doors.length, 1);
    const fileDoor = file.doors[0]!;
    assert.equal(fileDoor.wall, "left");
    assert.equal(fileDoor.id, door.id);
    assert.equal(fileDoor.model, door.model);
    assert.equal(fileDoor.hinge, door.hinge);
    assert.equal(fileDoor.open, door.open);
    assert.equal(fileDoor.height, height);
    assert.ok(Math.abs(fileDoor.width - width) < 1e-6);
    assert.ok(Math.abs(fileDoor.center[1] - door.center[1]) < 1e-6);
    assert.deepEqual(written.warnings, []);
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("a glass window adds a pane and a floor hole is removed from the walkable area", () => {
  const staged = writeInline(cutLayers(`data-texture="${TEX}"`));
  try {
    const file = staged.written.file;
    const front = file.obstacles.filter((item) => item.id.startsWith("front."));
    assert.equal(front.length, 4);
    assert.deepEqual(box(file, "win-1.pane"), {
      id: "win-1.pane", minX: -1, maxX: 1, minY: 0.9, maxY: 2.1, minZ: 3, maxZ: 3.2,
    });
    const hole = staged.written.room.holes[0];
    assert.ok(hole);
    assert.equal(hole.cut, "floor");
    assert.deepEqual(file.holes, [{ minX: hole.minX, maxX: hole.maxX, minZ: hole.minZ, maxZ: hole.maxZ }]);
    assert.equal(file.holes.length, 1);
    for (const rect of file.walkable) assert.equal(overlaps(rect, file.holes[0]!), false);
    const floorArea = staged.written.room.width * staged.written.room.depth;
    const holeArea = (hole.maxX - hole.minX) * (hole.maxZ - hole.minZ);
    assert.ok(Math.abs(sumArea(file.walkable) - (floorArea - holeArea)) < 1e-6);
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("data-glass false cuts the wall and adds no pane box", () => {
  const staged = writeInline(cutLayers('data-glass="false"'));
  try {
    const file = staged.written.file;
    assert.equal(file.obstacles.some((item) => item.id.endsWith(".pane")), false);
    assert.equal(file.obstacles.filter((item) => item.id.startsWith("front.")).length, 4);
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("a blender glb is copied and a shifted shell warns once", () => {
  const staged = stage();
  const svgOut = path.join(staged.dir, "svg", "room-b.glb");
  const blendOut = path.join(staged.dir, "blend", "room-b.glb");
  const shiftOut = path.join(staged.dir, "shift", "room-b.glb");
  const blendGlb = path.join(staged.dir, "blender.glb");
  const shiftGlb = path.join(staged.dir, "shifted.glb");
  try {
    writeFileSync(blendGlb, shell(0));
    writeFileSync(shiftGlb, shell(2));
    const svg = writeRoom({ svgPath: staged.svgPath, outPath: svgOut });
    const blend = writeRoom({ svgPath: staged.svgPath, outPath: blendOut, glbPath: blendGlb });
    const shift = writeRoom({ svgPath: staged.svgPath, outPath: shiftOut, glbPath: shiftGlb });
    assert.equal(blend.file.source, "blender");
    assert.deepEqual(readFileSync(blendOut), readFileSync(blendGlb));
    assert.deepEqual(blend.warnings, []);
    assert.deepEqual(blend.file.obstacles, svg.file.obstacles);
    assert.equal(shift.warnings.length, 1);
    assert.equal(
      shift.warnings[0],
      'room "room-b": GLB bounds x -1.2..5.2 z -3.2..3.2 do not match the footprint',
    );
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("more than 64 obstacles fails", () => {
  const windows: RoomWindow[] = [];
  for (let row = 0; row < 7; row += 1) {
    for (let col = 0; col < 10; col += 1) {
      const minX = -2.5 + col * 0.5;
      windows.push({
        id: `w${row}c${col}`,
        wall: "front",
        minX,
        maxX: minX + 0.25,
        minZ: 3,
        maxZ: 3,
        width: 0.25,
        sill: 0.1 + row * 0.4,
        height: 0.2,
        glass: true,
      });
    }
  }
  const room = bareRoom({ windows });
  assert.throws(
    () => roomFile(room, "room-a.glb", "svg"),
    (err: unknown) => {
      if (!(err instanceof PlanError)) return false;
      const match = /^room "room-a": (\d+) obstacles, the limit is 64$/.exec(err.message);
      return match != null && Number(match[1]) > 64;
    },
  );
});

test("writeRoom twice writes the same room json", () => {
  const staged = stage();
  const out = path.join(staged.dir, "room-b.glb");
  try {
    writeRoom({ svgPath: staged.svgPath, outPath: out });
    const first = readFileSync(path.join(staged.dir, "room-b.room.json"));
    writeRoom({ svgPath: staged.svgPath, outPath: out });
    assert.deepEqual(readFileSync(path.join(staged.dir, "room-b.room.json")), first);
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("inline lights are copied into the room json", () => {
  const staged = writeInline(layer("lights", `
    <rect id="panel-el" inkscape:label="light:panel" x="4.5" y="10.5" width="1" height="0.5" data-width="1" data-height="0.5"/>
    <circle id="lamp-el" inkscape:label="light:lamp" cx="3" cy="13" r="0.2" z="2.2" data-color="#FFD9A0" data-intensity="8"/>
    <circle id="bulb-el" inkscape:label="light:bulb" cx="6" cy="10" r="0.2"/>
  `));
  try {
    const lights = staged.written.file.lights;
    assert.deepEqual(lights.map((item) => item.id), ["panel", "lamp", "bulb"]);
    assert.deepEqual(lights[0], {
      id: "panel",
      type: "rect",
      position: [0, 2.8, 0.25],
      color: "#ffffff",
      intensity: 30,
      width: 1,
      height: 0.5,
    });
    assert.deepEqual(lights[1], {
      id: "lamp",
      type: "point",
      position: [-2, 2.2, -2],
      color: "#ffd9a0",
      intensity: 8,
    });
    assert.equal("range" in lights[1]!, false);
    assert.deepEqual(lights[2], {
      id: "bulb",
      type: "point",
      position: [1, 2.8, 1],
      color: "#ffffff",
      intensity: 12,
    });
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("room lights fail on size, placement, name, color, and intensity", () => {
  failsRoom(
    layer("lights", `<rect id="wide-el" inkscape:label="light:panel" x="4.5" y="10.5" width="1" height="0.5" data-width="1"/>`),
    /light "panel" needs both data-width and data-height/,
  );
  failsRoom(
    layer("lights", `<circle id="out-el" inkscape:label="light:lamp" cx="0" cy="11" r="0.2"/>`),
    /outside the footprint/,
  );
  failsRoom(
    layer("lights", `<circle id="high-el" inkscape:label="light:lamp" cx="5" cy="11" r="0.2" z="5"/>`),
    /y 5 is not in \(0, 3]/,
  );
  failsRoom(
    layer("lights", `
      <circle id="lamp-a" inkscape:label="light:lamp" cx="5" cy="11" r="0.2"/>
      <circle id="lamp-b" inkscape:label="light:lamp" cx="6" cy="11" r="0.2"/>
    `),
    /duplicate light "lamp"/,
  );
  failsRoom(
    layer("lights", `<circle id="noname" inkscape:label="light:" cx="5" cy="11" r="0.2"/>`),
    /light label "light:" needs light:<name>/,
  );
  failsRoom(
    layer("lights", `<circle id="red-el" inkscape:label="light:lamp" cx="5" cy="11" r="0.2" data-color="red"/>`),
    /data-color "red"/,
  );
  failsRoom(
    layer("lights", `<rect id="dim-el" inkscape:label="light:lamp" x="4" y="10" width="0.4" height="0.2" data-intensity="0"/>`),
    /data-intensity/,
  );
});

test("an intensity outside 1–100 warns and is still written", () => {
  const staged = writeInline(layer("lights", `<circle id="hot-el" inkscape:label="light:hot" cx="5" cy="11" r="0.2" data-intensity="500"/>`));
  try {
    assert.equal(staged.written.warnings.length, 1);
    assert.match(staged.written.warnings[0]!, /500/);
    assert.equal(staged.written.file.lights.length, 1);
    assert.equal(staged.written.file.lights[0]!.id, "hot");
    assert.equal(staged.written.file.lights[0]!.intensity, 500);
    assert.equal(staged.written.file.lights[0]!.type, "point");
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("a prop rect rotated 90 degrees has yaw 90", () => {
  const staged = writeInline(layer("props", `<rect id="crate-turn" inkscape:label="model:ammo-box" x="4" y="10" width="2" height="0.4" transform="rotate(90 5 10.2)"/>`));
  try {
    assert.equal(staged.written.file.props.length, 1);
    const prop = staged.written.file.props[0]!;
    assert.equal(prop.id, "crate-turn");
    assert.equal(prop.model, "ammo-box");
    assert.equal(prop.yaw, 90);
    assert.equal("minY" in prop, false);
    assert.equal("maxY" in prop, false);
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("blueprint-scene room writes the glb and the room json, and --glb copies", () => {
  const bin = path.join(import.meta.dirname, "..", "bin", "blueprint-scene");
  const staged = stage();
  const outDir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-room-out-"));
  const out = path.join(outDir, "room-b.glb");
  const json = path.join(outDir, "room-b.room.json");
  const glb = path.join(staged.dir, "blender.glb");
  try {
    const summary = "room room-b: 6\u00d76\u00d73 m, 1 doors, 0 windows, 0 openings, 0 holes, 2 props, 0 lights";
    const cli = spawnSync(bin, ["room", "--svg", staged.svgPath, "--out", out], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stdout, `${summary}\nwrote ${out}\nwrote ${json}\n`);

    writeFileSync(glb, shell(0));
    const copied = spawnSync(bin, ["room", "--svg", staged.svgPath, "--out", out, "--glb", glb], { encoding: "utf8" });
    assert.equal(copied.status, 0, copied.stderr);
    assert.equal(copied.stdout, `${summary}\nwrote ${out}\nwrote ${json}\n`);
    assert.deepEqual(readFileSync(out), readFileSync(glb));
    const file = JSON.parse(readFileSync(json, "utf8")) as { source: string };
    assert.equal(file.source, "blender");
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

function near(got: readonly number[], want: readonly number[]): boolean {
  return got.length === want.length && got.every((value, index) => Math.abs(value - want[index]!) <= 1e-3);
}

function failsRoom(extra: string, pattern: RegExp): void {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-room-"));
  const svgPath = path.join(dir, "room-a.svg");
  writeFileSync(svgPath, baseRoom(extra));
  try {
    assert.throws(
      () => writeRoom({ svgPath, outPath: path.join(dir, "room-a.glb") }),
      (err: unknown) => err instanceof PlanError && pattern.test((err as Error).message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function box(file: { obstacles: Array<{ id: string }> }, id: string): { id: string } {
  const found = file.obstacles.find((item) => item.id === id);
  assert.ok(found, id);
  return found;
}

function overlaps(a: XzRect, b: XzRect): boolean {
  const x = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const z = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
  return x > 1e-6 && z > 1e-6;
}

function sumArea(rects: XzRect[]): number {
  return rects.reduce((sum, rect) => sum + (rect.maxX - rect.minX) * (rect.maxZ - rect.minZ), 0);
}

function shell(dx: number): Uint8Array {
  const v = (x: number, y: number, z: number): Vec3 => [x, y, z];
  const x0 = -3.2 + dx;
  const x1 = 3.2 + dx;
  return writeTriangleGlb("walls", trianglesFromWalls([
    { min: v(x0, 0, 3), max: v(x1, 3, 3.2) },
    { min: v(x0, 0, -3.2), max: v(x1, 3, -3) },
    { min: v(x0, 0, -3.2), max: v(-3 + dx, 3, 3.2) },
    { min: v(3 + dx, 0, -3.2), max: v(x1, 3, 3.2) },
  ]));
}

function writeInline(extra: string): { dir: string; written: ReturnType<typeof writeRoom> } {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-room-"));
  const svgPath = path.join(dir, "room-a.svg");
  const out = path.join(dir, "room-a.glb");
  writeFileSync(svgPath, baseRoom(extra));
  return { dir, written: writeRoom({ svgPath, outPath: out }) };
}

function bareRoom(over: Partial<RoomSource>): RoomSource {
  const faces = {} as Record<RoomFace, FaceTexture>;
  for (const face of ["front", "back", "left", "right", "floor", "ceiling"] as const) {
    faces[face] = { face, source: face, ref: "tex" };
  }
  return {
    id: "room-a",
    svgPath: "/tmp/room-a.svg",
    width: 6,
    depth: 6,
    height: 3,
    footprint: { minX: -3, maxX: 3, minZ: -3, maxZ: 3 },
    faces,
    doors: [],
    windows: [],
    openings: [],
    holes: [],
    props: [],
    lights: [],
    warnings: [],
    ...over,
  };
}

function stage(): { dir: string; svgPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-room-"));
  const svgPath = path.join(dir, "room-b.svg");
  writeFileSync(svgPath, readFileSync(FIXTURE, "utf8"));
  PNG_NAMES.forEach((name, index) => writeFileSync(path.join(dir, name), markedPng(index + 1)));
  return { dir, svgPath };
}

function cutLayers(windowAttrs: string): string {
  return `
    ${layer("windows", `<rect id="win-1" x="4" y="7.9" width="2" height="0.2" data-wall="front" ${windowAttrs}/>`)}
    ${layer("openings", `<rect id="open-1" x="3" y="13.9" width="2" height="0.2" data-wall="back"/>`)}
    ${layer("holes", `<rect id="hole-1" x="4" y="11" width="1" height="1" data-cut="floor"/>`)}
  `;
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

function markedPng(mark: number): Buffer {
  const bytes = Buffer.from(PNG);
  bytes[20] = mark;
  return bytes;
}

function dataUri(png: Buffer): string {
  return `data:image/png;base64,${png.toString("base64")}`;
}
