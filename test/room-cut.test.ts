import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DOOR_HEIGHT_M } from "../src/doors.ts";
import { PlanError } from "../src/errors.ts";
import { writeRoom } from "../src/room-glb.ts";
import { cutFace, roomApertures } from "../src/room-cut.ts";
import { readRoomSvg, type FaceTexture, type RoomFace, type RoomSource, type RoomWindow } from "../src/room-svg.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const TEX = dataUri(markedPng(1));
const FIXTURE = path.join(import.meta.dirname, "fixtures", "rooms", "room-b.svg");
const PNG_NAMES = ["floor.png", "ceiling.png", "long-wall.png", "long-wall-2.png", "short-wall.png", "short-wall-2.png"];

test("cutFace of no apertures is the whole face", () => {
  assert.deepEqual(cutFace([]), [{ s0: 0, s1: 1, t0: 0, t1: 1 }]);
});

test("two overlapping apertures fail with overlap on the front", () => {
  const room = bareRoom({
    windows: [
      win("win-a", { minX: -1, maxX: 1, minZ: 2.9, maxZ: 3.1, width: 2, sill: 0.9, height: 1.2 }),
      win("win-b", { minX: -0.5, maxX: 0.5, minZ: 2.9, maxZ: 3.1, width: 1, sill: 1, height: 1 }),
    ],
  });
  assert.throws(
    () => roomApertures(room),
    (err: unknown) => err instanceof PlanError && err.message === 'room "room-a": "win-a" and "win-b" overlap on the front',
  );
});

test("a hole with cut both cuts the floor and the ceiling", () => {
  const room = bareRoom({
    holes: [{ id: "hole-1", minX: -1, maxX: 0, minZ: -1, maxZ: 0, cut: "both" }],
  });
  const apertures = roomApertures(room);
  assert.deepEqual(apertures.front, []);
  assert.deepEqual(apertures.back, []);
  assert.deepEqual(apertures.left, []);
  assert.deepEqual(apertures.right, []);
  for (const face of ["floor", "ceiling"] as const) {
    assert.equal(apertures[face].length, 1);
    assert.equal(apertures[face][0]!.id, "hole-1");
    const cells = cutFace(apertures[face]);
    const hole = apertures[face][0]!;
    const s = (hole.s0 + hole.s1) / 2;
    const t = (hole.t0 + hole.t1) / 2;
    assert.ok(cells.length > 1, face);
    assert.ok(cells.every((cell) => s <= cell.s0 || s >= cell.s1 || t <= cell.t0 || t >= cell.t1), face);
  }
});

test("room-b cuts the door out of the left wall and leaves the other faces whole", () => {
  const staged = stage();
  const out = path.join(staged.dir, "room-b.glb");
  try {
    const room = readRoomSvg(readFileSync(staged.svgPath, "utf8"), staged.svgPath);
    const door = room.doors.find((item) => item.id === "door-1-1-9-22");
    assert.ok(door);
    const width = door.width ?? door.maxZ - door.minZ;
    const height = door.height ?? DOOR_HEIGHT_M;
    assertNear(width, 1.8900341);
    assertNear(height, 2.1);
    const z0 = door.center[2] - width / 2;
    const z1 = door.center[2] + width / 2;
    assertNear(z0, -0.7458);
    assertNear(z1, 1.1442);

    writeRoom({ svgPath: staged.svgPath, outPath: out });
    const { doc, bin } = readGlb(readFileSync(out));
    assert.deepEqual(doc.meshes?.map((mesh) => mesh.name), ["floor", "ceiling", "walls"]);

    const left = wallQuads(doc, bin, [1, 0, 0]);
    assert.equal(left.length, 3);
    let area = 0;
    for (const quad of left) {
      area += quadArea(quad);
      assertInside(quad);
      for (const corner of quad) {
        assertNear(corner.position[0]!, -3);
        assertNear(corner.uv![0]!, (3 - corner.position[2]!) / 6);
        assertNear(corner.uv![1]!, (3 - corner.position[1]!) / 3);
        assert.ok(Math.abs(corner.normal[0]! - 1) < 1e-4);
      }
      const [y0, y1] = span(quad, 1);
      const [qz0, qz1] = span(quad, 2);
      const overlapsDoor = overlap(y0, y1, 0, 2.1) > 1e-4 && overlap(qz0, qz1, -0.7458, 1.1442) > 1e-4;
      assert.equal(overlapsDoor, false);
    }
    assertNear(area, 6 * 3 - width * height);
    const lintels = left.filter((quad) => {
      const [y0, y1] = span(quad, 1);
      const [qz0, qz1] = span(quad, 2);
      return Math.abs(y0 - 2.1) < 1e-4 && Math.abs(y1 - 3) < 1e-4 && Math.abs(qz0 - (-3)) < 1e-4 && Math.abs(qz1 - 3) < 1e-4;
    });
    assert.equal(lintels.length, 1);

    assert.equal(wallQuads(doc, bin, [0, 0, -1]).length, 1);
    assert.equal(wallQuads(doc, bin, [0, 0, 1]).length, 1);
    assert.equal(wallQuads(doc, bin, [-1, 0, 0]).length, 1);
    assert.equal(readCorners(doc, bin, onePrimitive(doc, "floor")).length, 4);
    assert.equal(readCorners(doc, bin, onePrimitive(doc, "ceiling")).length, 4);
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("an inline room cuts the window, the opening, and the ceiling hole, and adds a textured pane", () => {
  const png = markedPng(1);
  const { doc, bin } = bake(cutLayers(`data-texture="${TEX}"`));
  const front = wallQuads(doc, bin, [0, 0, -1]);
  assert.equal(front.length, 4);
  assert.equal(front.some((quad) => overlapsRect(quad, 0, -1, 1, 1, 0.9, 2.1)), false);
  assert.ok(hasBox(front, 0, -3, 3, 1, 0, 0.9));
  assert.ok(hasBox(front, 0, -3, 3, 1, 2.1, 3));
  assert.ok(hasBox(front, 0, -3, -1, 1, 0.9, 2.1));
  assert.ok(hasBox(front, 0, 1, 3, 1, 0.9, 2.1));
  for (const quad of front) assertInside(quad);

  const back = wallQuads(doc, bin, [0, 0, 1]);
  assert.equal(back.some((quad) => overlapsRect(quad, 0, -2, 0, 1, 0, 2.1)), false);
  assert.ok(covers(back, -2.5, 1, -3));
  assert.ok(covers(back, 1, 1, -3));

  const ceiling = quadsOf(readCorners(doc, bin, onePrimitive(doc, "ceiling")));
  assert.equal(ceiling.some((quad) => overlapsRect(quad, 0, -1, 0, 2, -1, 0)), false);
  assert.equal(readCorners(doc, bin, onePrimitive(doc, "floor")).length, 4);

  const glass = doc.meshes?.find((mesh) => mesh.name === "glass");
  assert.equal(glass?.primitives?.length, 1);
  const pane = glass?.primitives?.[0];
  if (!pane) throw new Error("missing pane");
  const corners = readCorners(doc, bin, pane);
  assert.equal(corners.length, 4);
  assertInside(corners);
  for (const corner of corners) {
    assertNear(corner.position[2]!, 3);
    assertNear(corner.uv![0]!, (1 - corner.position[0]!) / 2);
    assertNear(corner.uv![1]!, (2.1 - corner.position[1]!) / 1.2);
  }
  const [x0, x1] = span(corners, 0);
  const [y0, y1] = span(corners, 1);
  assertNear(x0, -1);
  assertNear(x1, 1);
  assertNear(y0, 0.9);
  assertNear(y1, 2.1);
  const material = doc.materials?.[pane.material ?? -1];
  assert.equal(material?.alphaMode, "BLEND");
  assert.equal(material?.doubleSided, true);
  assert.deepEqual(textureBytes(doc, bin, pane), png);
  const wall = primitiveByNormal(doc, bin, [0, 0, -1]);
  assert.equal(doc.materials?.[wall.material ?? -1]?.alphaMode, undefined);
});

test("a window without a texture gets a plain blended pane", () => {
  const { doc, bin } = bake(cutLayers(""));
  const glass = doc.meshes?.find((mesh) => mesh.name === "glass");
  assert.equal(glass?.primitives?.length, 1);
  const pane = glass?.primitives?.[0];
  if (!pane) throw new Error("missing pane");
  assert.equal(pane.attributes?.TEXCOORD_0, undefined);
  const material = doc.materials?.[pane.material ?? -1];
  assert.equal(material?.pbrMetallicRoughness?.baseColorTexture, undefined);
  assert.deepEqual(material?.pbrMetallicRoughness?.baseColorFactor, [0.75, 0.85, 0.9, 0.3]);
  assert.equal(material?.alphaMode, "BLEND");
  assert.equal(material?.doubleSided, true);
  const corners = readCorners(doc, bin, pane);
  const [x0, x1] = span(corners, 0);
  const [y0, y1] = span(corners, 1);
  assertNear(x0, -1);
  assertNear(x1, 1);
  assertNear(y0, 0.9);
  assertNear(y1, 2.1);
  for (const corner of corners) assertNear(corner.position[2]!, 3);
});

test("data-glass false cuts the wall and adds no glass mesh", () => {
  const { doc, bin } = bake(cutLayers('data-glass="false"'));
  assert.equal(doc.meshes?.some((mesh) => mesh.name === "glass"), false);
  const front = wallQuads(doc, bin, [0, 0, -1]);
  assert.equal(front.length, 4);
  assert.equal(front.some((quad) => overlapsRect(quad, 0, -1, 1, 1, 0.9, 2.1)), false);
});

function cutLayers(windowAttrs: string): string {
  return `
    ${layer("windows", `<rect id="win-1" x="4" y="7.9" width="2" height="0.2" data-wall="front" ${windowAttrs}/>`)}
    ${layer("openings", `<rect id="open-1" x="3" y="13.9" width="2" height="0.2" data-wall="back"/>`)}
    ${layer("holes", `<rect id="hole-1" x="4" y="11" width="1" height="1" data-cut="ceiling"/>`)}
  `;
}

function bake(extra: string): { doc: GlbDoc; bin: Uint8Array } {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-cut-"));
  try {
    const svgPath = path.join(dir, "room-a.svg");
    const out = path.join(dir, "room-a.glb");
    writeFileSync(svgPath, baseRoom(extra));
    writeRoom({ svgPath, outPath: out });
    return readGlb(readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

function win(id: string, fields: Pick<RoomWindow, "minX" | "maxX" | "minZ" | "maxZ" | "width" | "sill" | "height">): RoomWindow {
  return { id, wall: "front", glass: false, ...fields };
}

function stage(): { dir: string; svgPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-room-"));
  const svgPath = path.join(dir, "room-b.svg");
  writeFileSync(svgPath, readFileSync(FIXTURE, "utf8"));
  PNG_NAMES.forEach((name, index) => writeFileSync(path.join(dir, name), markedPng(index + 1)));
  return { dir, svgPath };
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

function assertNear(got: number, expected: number): void {
  assert.ok(Math.abs(got - expected) < 1e-4, `${got} !== ${expected}`);
}

type GlbPrimitive = {
  attributes?: { POSITION?: number; NORMAL?: number; TEXCOORD_0?: number };
  material?: number;
};
type GlbDoc = {
  meshes?: Array<{ name?: string; primitives?: GlbPrimitive[] }>;
  materials?: Array<{
    alphaMode?: string;
    doubleSided?: boolean;
    pbrMetallicRoughness?: { baseColorFactor?: number[]; baseColorTexture?: { index: number } };
  }>;
  textures?: Array<{ source?: number }>;
  images?: Array<{ bufferView?: number }>;
  bufferViews?: Array<{ byteOffset?: number; byteLength: number }>;
  accessors?: Array<{ bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string }>;
};
type Corner = { position: number[]; normal: number[]; uv?: number[] };

function readGlb(bytes: Buffer): { doc: GlbDoc; bin: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  const doc = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as GlbDoc;
  const binAt = 20 + jsonLength;
  const binLength = view.getUint32(binAt, true);
  return { doc, bin: bytes.subarray(binAt + 8, binAt + 8 + binLength) };
}

function onePrimitive(doc: GlbDoc, name: string): GlbPrimitive {
  const mesh = doc.meshes?.find((item) => item.name === name);
  assert.equal(mesh?.primitives?.length, 1, name);
  const primitive = mesh?.primitives?.[0];
  if (!primitive) throw new Error(`missing ${name}`);
  return primitive;
}

function primitiveByNormal(doc: GlbDoc, bin: Uint8Array, normal: readonly [number, number, number]): GlbPrimitive {
  const mesh = doc.meshes?.find((item) => item.name === "walls");
  for (const primitive of mesh?.primitives ?? []) {
    const got = readCorners(doc, bin, primitive)[0]?.normal;
    if (got && got.every((value, index) => Math.abs(value - normal[index]!) < 1e-4)) return primitive;
  }
  throw new Error(`missing normal ${normal.join(",")}`);
}

function readCorners(doc: GlbDoc, bin: Uint8Array, primitive: GlbPrimitive): Corner[] {
  const positionAttr = primitive.attributes?.POSITION;
  const normalAttr = primitive.attributes?.NORMAL;
  const uvAttr = primitive.attributes?.TEXCOORD_0;
  if (positionAttr == null || normalAttr == null) throw new Error("primitive is missing attributes");
  const position = readAccessor(doc, bin, positionAttr);
  const normal = readAccessor(doc, bin, normalAttr);
  const uv = uvAttr == null ? undefined : readAccessor(doc, bin, uvAttr);
  const count = doc.accessors?.[positionAttr]?.count ?? 0;
  const corners: Corner[] = [];
  for (let index = 0; index < count; index += 1) {
    const corner: Corner = {
      position: position.slice(index * 3, index * 3 + 3),
      normal: normal.slice(index * 3, index * 3 + 3),
    };
    if (uv) corner.uv = uv.slice(index * 2, index * 2 + 2);
    corners.push(corner);
  }
  return corners;
}

function readAccessor(doc: GlbDoc, bin: Uint8Array, index: number): number[] {
  const accessor = doc.accessors?.[index];
  const bufferView = accessor?.bufferView == null ? undefined : doc.bufferViews?.[accessor.bufferView];
  if (!accessor || !bufferView) throw new Error(`missing accessor ${index}`);
  const components = accessor.type === "VEC3" ? 3 : accessor.type === "VEC2" ? 2 : accessor.type === "SCALAR" ? 1 : 0;
  if (components === 0) throw new Error(`accessor type ${accessor.type}`);
  const base = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const out: number[] = [];
  for (let vertex = 0; vertex < accessor.count; vertex += 1) {
    for (let component = 0; component < components; component += 1) {
      const at = base + (vertex * components + component) * 4;
      out.push(accessor.componentType === 5126 ? view.getFloat32(at, true) : view.getUint32(at, true));
    }
  }
  return out;
}

function textureBytes(doc: GlbDoc, bin: Uint8Array, primitive: GlbPrimitive): Buffer {
  const material = doc.materials?.[primitive.material ?? -1];
  const textureIndex = material?.pbrMetallicRoughness?.baseColorTexture?.index;
  if (textureIndex == null) throw new Error("primitive has no texture");
  const source = doc.textures?.[textureIndex]?.source;
  if (source == null) throw new Error("texture has no image");
  const image = doc.images?.[source];
  const bufferView = doc.bufferViews?.[image?.bufferView ?? -1];
  if (!bufferView) throw new Error("missing image");
  const start = bufferView.byteOffset ?? 0;
  return Buffer.from(bin.subarray(start, start + bufferView.byteLength));
}

function wallQuads(doc: GlbDoc, bin: Uint8Array, normal: readonly [number, number, number]): Corner[][] {
  return quadsOf(readCorners(doc, bin, primitiveByNormal(doc, bin, normal)));
}

function quadsOf(corners: Corner[]): Corner[][] {
  assert.equal(corners.length % 4, 0);
  const quads: Corner[][] = [];
  for (let index = 0; index < corners.length; index += 4) quads.push(corners.slice(index, index + 4));
  return quads;
}

function span(corners: Corner[], axis: 0 | 1 | 2): [number, number] {
  const values = corners.map((corner) => corner.position[axis]!);
  return [Math.min(...values), Math.max(...values)];
}

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.min(a1, b1) - Math.max(a0, b0);
}

function overlapsRect(quad: Corner[], axisA: 0 | 1 | 2, a0: number, a1: number, axisB: 0 | 1 | 2, b0: number, b1: number): boolean {
  const [qa0, qa1] = span(quad, axisA);
  const [qb0, qb1] = span(quad, axisB);
  return overlap(qa0, qa1, a0, a1) > 1e-4 && overlap(qb0, qb1, b0, b1) > 1e-4;
}

function hasBox(quads: Corner[][], axisA: 0 | 1 | 2, a0: number, a1: number, axisB: 0 | 1 | 2, b0: number, b1: number): boolean {
  return quads.some((quad) => {
    const [qa0, qa1] = span(quad, axisA);
    const [qb0, qb1] = span(quad, axisB);
    return Math.abs(qa0 - a0) < 1e-4 && Math.abs(qa1 - a1) < 1e-4 && Math.abs(qb0 - b0) < 1e-4 && Math.abs(qb1 - b1) < 1e-4;
  });
}

function covers(quads: Corner[][], x: number, y: number, z: number): boolean {
  return quads.some((quad) => {
    const [x0, x1] = span(quad, 0);
    const [y0, y1] = span(quad, 1);
    const [z0, z1] = span(quad, 2);
    return x >= x0 - 1e-4 && x <= x1 + 1e-4 && y >= y0 - 1e-4 && y <= y1 + 1e-4 && z >= z0 - 1e-4 && z <= z1 + 1e-4;
  });
}

function quadArea(quad: Corner[]): number {
  const p0 = quad[0]!.position;
  const p1 = quad[1]!.position;
  const p3 = quad[3]!.position;
  const e1 = [p1[0]! - p0[0]!, p1[1]! - p0[1]!, p1[2]! - p0[2]!];
  const e3 = [p3[0]! - p0[0]!, p3[1]! - p0[1]!, p3[2]! - p0[2]!];
  const cross = [
    e1[1]! * e3[2]! - e1[2]! * e3[1]!,
    e1[2]! * e3[0]! - e1[0]! * e3[2]!,
    e1[0]! * e3[1]! - e1[1]! * e3[0]!,
  ];
  return Math.hypot(cross[0]!, cross[1]!, cross[2]!);
}

function assertInside(corners: Corner[]): void {
  const p0 = corners[0];
  const p1 = corners[1];
  const p2 = corners[2];
  if (!p0 || !p1 || !p2) throw new Error("quad is missing a corner");
  const e1 = [p1.position[0]! - p0.position[0]!, p1.position[1]! - p0.position[1]!, p1.position[2]! - p0.position[2]!];
  const e2 = [p2.position[0]! - p0.position[0]!, p2.position[1]! - p0.position[1]!, p2.position[2]! - p0.position[2]!];
  const cross = [
    e1[1]! * e2[2]! - e1[2]! * e2[1]!,
    e1[2]! * e2[0]! - e1[0]! * e2[2]!,
    e1[0]! * e2[1]! - e1[1]! * e2[0]!,
  ];
  const normal = p0.normal;
  const dot = cross[0]! * normal[0]! + cross[1]! * normal[1]! + cross[2]! * normal[2]!;
  assert.ok(dot > 0, `winding ${dot}`);
}
