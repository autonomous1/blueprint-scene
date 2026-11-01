import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PlanError } from "../src/errors.ts";
import { writeDoorProp } from "../src/prop.ts";

const fixture = path.join(import.meta.dirname, "fixtures", "door", "door-design.svg");

test("a hinge that is not on a side edge fails and writes nothing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-prop-"));
  try {
    const middle = designSvg(`<rect id="data-part-hinge" x="1.55" y="8.7" width="0.1" height="0.2" />`);
    const top = designSvg(`<rect id="data-part-hinge" x="1.55" y="7.65" width="0.1" height="0.2" />`);
    const svgMiddle = path.join(dir, "middle.svg");
    const svgTop = path.join(dir, "top.svg");
    writeFileSync(svgMiddle, middle);
    writeFileSync(svgTop, top);
    const outPath = path.join(dir, "door.glb");
    assert.throws(
      () => writeDoorProp({ svgPath: svgMiddle, outPath }),
      (err: unknown) => err instanceof PlanError && /not on an edge/.test(err.message),
    );
    assert.throws(
      () => writeDoorProp({ svgPath: svgTop, outPath }),
      (err: unknown) => err instanceof PlanError && /not on an edge/.test(err.message),
    );
    assert.equal(readdirSync(dir).includes("door.glb"), false);

    const right = designSvg(`<rect id="data-part-hinge" x="2.05" y="8.7" width="0.1" height="0.2" />`);
    const svgRight = path.join(dir, "right.svg");
    writeFileSync(svgRight, right);
    const rightOut = path.join(dir, "right.glb");
    writeDoorProp({ svgPath: svgRight, outPath: rightOut });
    const { doc, bin } = readGlb(readFileSync(rightOut));
    const box = bounds(meshCorners(doc, bin, "door").map((corner) => corner.position));
    assert.ok(Math.abs(box.minX + 1) < 1e-4, `right minX ${box.minX}`);
    assert.ok(Math.abs(box.maxX) < 1e-4, `right maxX ${box.maxX}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function designSvg(hinge: string): string {
  const source = readFileSync(fixture, "utf8");
  return source.replace(/<rect\s+id="data-part-hinge"[\s\S]*?\/>/, hinge);
}

type GlbNode = {
  name?: string;
  translation?: unknown;
  rotation?: unknown;
  scale?: unknown;
  mesh?: number;
  children?: number[];
};
type GlbDoc = {
  skins?: unknown;
  animations?: unknown;
  nodes?: GlbNode[];
  meshes?: Array<{ name?: string; primitives?: GlbPrimitive[] }>;
  bufferViews?: Array<{ byteOffset?: number; byteLength: number }>;
  accessors?: Array<{ bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string }>;
};
type GlbPrimitive = {
  attributes?: { POSITION?: number; NORMAL?: number; TEXCOORD_0?: number };
  indices?: number;
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

function meshCorners(doc: GlbDoc, bin: Uint8Array, name: string): Corner[] {
  const meshIndex = doc.meshes?.findIndex((mesh) => mesh.name === name) ?? -1;
  const mesh = doc.meshes?.[meshIndex];
  if (!mesh || meshIndex < 0) throw new Error(`missing mesh ${name}`);
  const corners: Corner[] = [];
  for (const primitive of mesh.primitives ?? []) corners.push(...readCorners(doc, bin, primitive));
  return corners;
}

function readCorners(doc: GlbDoc, bin: Uint8Array, primitive: GlbPrimitive): Corner[] {
  const positionAttr = primitive.attributes?.POSITION;
  const normalAttr = primitive.attributes?.NORMAL;
  const indexAttr = primitive.indices;
  if (positionAttr == null || normalAttr == null || indexAttr == null) throw new Error("primitive is missing attributes");
  const position = readAccessor(doc, bin, positionAttr);
  const normal = readAccessor(doc, bin, normalAttr);
  const uvAttr = primitive.attributes?.TEXCOORD_0;
  const uv = uvAttr == null ? undefined : readAccessor(doc, bin, uvAttr);
  return readAccessor(doc, bin, indexAttr).map((index) => ({
    position: position.slice(index * 3, index * 3 + 3),
    normal: normal.slice(index * 3, index * 3 + 3),
    ...(uv ? { uv: uv.slice(index * 2, index * 2 + 2) } : {}),
  }));
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

function bounds(points: number[][]): { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } {
  const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const [x, y, z] of points) {
    if (x! < box.minX) box.minX = x!;
    if (x! > box.maxX) box.maxX = x!;
    if (y! < box.minY) box.minY = y!;
    if (y! > box.maxY) box.maxY = y!;
    if (z! < box.minZ) box.minZ = z!;
    if (z! > box.maxZ) box.maxZ = z!;
  }
  return box;
}

