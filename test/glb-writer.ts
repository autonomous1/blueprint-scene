import type { Triangle, Vec3 } from "../src/types.ts";

export type GlbMesh = {
  name: string;
  triangles: Triangle[];
  extras?: { collision: boolean };
  /** glTF primitive mode. Defaults to 4 (TRIANGLES). */
  mode?: number;
  /** Write a primitive with no POSITION attribute. */
  omitPosition?: boolean;
};

export type GlbNode = {
  name: string;
  mesh?: string;
  translation?: Vec3;
  rotation?: [number, number, number, number];
  matrix?: number[];
  extras?: { collision: boolean };
  children?: GlbNode[];
};

/** Minimal glTF 2 GLB. Non-indexed triangle positions, one buffer. */
export function writeGlb(meshes: GlbMesh[], roots: GlbNode[]): Uint8Array {
  const meshIndex = new Map(meshes.map((mesh, index) => [mesh.name, index]));
  const flat: GlbNode[] = [];
  const childIndices: number[][] = [];
  const visit = (node: GlbNode): number => {
    const index = flat.length;
    flat.push(node);
    childIndices.push([]);
    for (const child of node.children ?? []) childIndices[index]!.push(visit(child));
    return index;
  };
  const rootIndices = roots.map(visit);

  const parts: Uint8Array[] = [];
  let byteLength = 0;
  const accessors: unknown[] = [];
  const bufferViews: unknown[] = [];
  const primitiveOf: Array<{ position: number; indices: number } | null> = [];
  for (const mesh of meshes) {
    if (mesh.omitPosition) {
      primitiveOf.push(null);
      continue;
    }
    const floats: number[] = [];
    for (const triangle of mesh.triangles) {
      for (const vertex of triangle) floats.push(vertex[0], vertex[1], vertex[2]);
    }
    const vertexCount = floats.length / 3;
    const positions = floatBuffer(floats);
    const indices = u32Buffer(Array.from({ length: vertexCount }, (_, index) => index));
    const positionView = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: positions.byteLength });
    const positionAccessor = accessors.length;
    accessors.push({ bufferView: positionView, componentType: 5126, count: vertexCount, type: "VEC3" });
    parts.push(positions);
    byteLength += positions.byteLength;
    const indexView = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: indices.byteLength });
    const indexAccessor = accessors.length;
    accessors.push({ bufferView: indexView, componentType: 5125, count: vertexCount, type: "SCALAR" });
    parts.push(indices);
    byteLength += indices.byteLength;
    primitiveOf.push({ position: positionAccessor, indices: indexAccessor });
  }
  const bin = new Uint8Array(byteLength);
  let at = 0;
  for (const part of parts) {
    bin.set(part, at);
    at += part.byteLength;
  }

  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: rootIndices }],
    nodes: flat.map((node, index) => {
      const out: Record<string, unknown> = { name: node.name };
      if (node.mesh != null) {
        const mesh = meshIndex.get(node.mesh);
        if (mesh == null) throw new Error(`node ${node.name} references missing mesh ${node.mesh}`);
        out.mesh = mesh;
      }
      if (node.matrix) out.matrix = node.matrix;
      else {
        if (node.translation) out.translation = node.translation;
        if (node.rotation) out.rotation = node.rotation;
      }
      if (node.extras) out.extras = node.extras;
      const children = childIndices[index] ?? [];
      if (children.length > 0) out.children = children;
      return out;
    }),
    meshes: meshes.map((mesh, index) => {
      const prim = primitiveOf[index];
      const primitive = prim == null
        ? { mode: mesh.mode ?? 4 }
        : {
            attributes: { POSITION: prim.position },
            indices: prim.indices,
            mode: mesh.mode ?? 4,
          };
      return {
        name: mesh.name,
        ...(mesh.extras ? { extras: mesh.extras } : {}),
        primitives: [primitive],
      };
    }),
    accessors,
    bufferViews,
    buffers: [{ byteLength }],
  };
  return packGlb(json, bin);
}

function floatBuffer(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return out;
}

function u32Buffer(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value, true));
  return out;
}

function packGlb(json: unknown, bin: Uint8Array): Uint8Array {
  const jsonBytes = pad(new TextEncoder().encode(JSON.stringify(json)), 4, 0x20);
  const binBytes = pad(bin, 4, 0);
  const total = 12 + 8 + jsonBytes.byteLength + 8 + binBytes.byteLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.byteLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  const binAt = 20 + jsonBytes.byteLength;
  view.setUint32(binAt, binBytes.byteLength, true);
  view.setUint32(binAt + 4, 0x004e4942, true);
  out.set(binBytes, binAt + 8);
  return out;
}

function pad(bytes: Uint8Array, mod: number, fill: number): Uint8Array {
  const extra = (mod - (bytes.byteLength % mod)) % mod;
  if (extra === 0) return bytes;
  const out = new Uint8Array(bytes.byteLength + extra);
  out.set(bytes);
  out.fill(fill, bytes.byteLength);
  return out;
}
