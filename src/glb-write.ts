import type { Triangle, Vec3 } from "./types.ts";

export type DoorCorner = {
  position: Vec3;
  normal: Vec3;
  /**
   * glTF UV. (0, 0) is the top-left of the PNG and (1, 1) is the bottom-right.
   * Omit it on the untextured rim.
   */
  uv?: readonly [number, number];
};

/**
 * One triangle mesh, positions only. No material, skin, or animation clip.
 * The chunk padding matches the glTF 2 GLB layout.
 */
export function writeTriangleGlb(name: string, triangles: Triangle[]): Uint8Array {
  const floats: number[] = [];
  for (const triangle of triangles) {
    for (const vertex of triangle) floats.push(vertex[0], vertex[1], vertex[2]);
  }
  const vertexCount = floats.length / 3;
  const positions = floatBuffer(floats);
  const indices = u32Buffer(Array.from({ length: vertexCount }, (_, index) => index));
  const bin = new Uint8Array(positions.byteLength + indices.byteLength);
  bin.set(positions, 0);
  bin.set(indices, positions.byteLength);
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name, mesh: 0 }],
    meshes: [{
      name,
      primitives: [{
        attributes: { POSITION: 0 },
        indices: 1,
        mode: 4,
      }],
    }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: vertexCount, type: "VEC3" },
      { bufferView: 1, componentType: 5125, count: vertexCount, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength },
    ],
    buffers: [{ byteLength: bin.byteLength }],
  };
  return packGlb(json, bin);
}

export type MeshPrimitive = {
  corners: readonly DoorCorner[];
  /** PNG bytes. The same array is embedded once and shared. */
  image?: Uint8Array;
  /**
   * Corners are groups of four, wound from outside. Indices are two
   * triangles per quad, so four corners stay four vertices.
   */
  quads?: boolean;
};

export type NamedMesh = {
  name: string;
  /** Group node that holds this mesh. The group itself has no mesh. */
  parent?: string;
  primitives: readonly MeshPrimitive[];
};

const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

/**
 * One node per mesh, at the vertex origin. A mesh with `parent` hangs under
 * that group node. No skin and no animation. A primitive with `image` gets
 * TEXCOORD_0. Other faces use a flat color.
 */
export function writeMeshesGlb(meshes: readonly NamedMesh[]): Uint8Array {
  const images: Uint8Array[] = [];
  const imageIndexOf = (png: Uint8Array): number => {
    const found = images.indexOf(png);
    if (found >= 0) return found;
    images.push(png);
    return images.length - 1;
  };
  const bin = new BinBuilder();
  const accessors: unknown[] = [];
  const bufferViews: unknown[] = [];
  const materials: unknown[] = [{
    name: "flat",
    pbrMetallicRoughness: {
      baseColorFactor: [0.18, 0.16, 0.14, 1],
      metallicFactor: 0,
      roughnessFactor: 1,
    },
  }];
  const materialForImage = new Map<number, number>();
  const gltfMeshes = meshes.map((mesh) => {
    const primitives = [];
    for (const primitive of mesh.primitives) {
      if (primitive.corners.length === 0) continue;
      const quads = primitive.quads === true;
      if (quads) {
        if (primitive.corners.length % 4 !== 0) throw new Error(`${mesh.name} primitive is not quads`);
      } else if (primitive.corners.length % 3 !== 0) {
        throw new Error(`${mesh.name} primitive is not triangles`);
      }
      const textured = primitive.image != null;
      const built = cornerBuffers(primitive.corners, textured);
      const indexValues = quads ? quadIndices(built.count) : built.indices;
      const position = pushAccessor(bin, bufferViews, accessors, floatBuffer(built.positions), ARRAY_BUFFER, vec3Accessor(0, built.count, built.positions));
      const normal = pushAccessor(bin, bufferViews, accessors, floatBuffer(built.normals), ARRAY_BUFFER, vec3Accessor(0, built.count, built.normals));
      const indices = pushAccessor(
        bin,
        bufferViews,
        accessors,
        u32Buffer(indexValues),
        ELEMENT_ARRAY_BUFFER,
        { componentType: 5125, count: indexValues.length, type: "SCALAR" },
      );
      let material = 0;
      const attributes: { POSITION: number; NORMAL: number; TEXCOORD_0?: number } = { POSITION: position, NORMAL: normal };
      if (textured && primitive.image) {
        attributes.TEXCOORD_0 = pushAccessor(
          bin,
          bufferViews,
          accessors,
          floatBuffer(built.uvs),
          ARRAY_BUFFER,
          { componentType: 5126, count: built.count, type: "VEC2" },
        );
        const source = imageIndexOf(primitive.image);
        const existing = materialForImage.get(source);
        if (existing != null) material = existing;
        else {
          material = materials.length;
          materialForImage.set(source, material);
          materials.push({
            pbrMetallicRoughness: {
              baseColorTexture: { index: source },
              metallicFactor: 0,
              roughnessFactor: 1,
            },
          });
        }
      }
      primitives.push({ attributes, indices, material, mode: 4 });
    }
    if (primitives.length === 0) throw new Error(`${mesh.name} has no triangles`);
    return { name: mesh.name, primitives };
  });
  const imageViews = images.map((png) => pushView(bin, bufferViews, png));
  const bytes = bin.toUint8Array();
  const hierarchy = sceneNodes(meshes);
  const json: Record<string, unknown> = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: hierarchy.roots }],
    nodes: hierarchy.nodes,
    meshes: gltfMeshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bytes.byteLength }],
  };
  if (images.length > 0) {
    json.samplers = [{ magFilter: 9729, minFilter: 9729, wrapS: 33071, wrapT: 33071 }];
    json.textures = images.map((_, index) => ({ sampler: 0, source: index }));
    json.images = imageViews.map((bufferView) => ({ mimeType: "image/png", bufferView }));
  }
  return packGlb(json, bytes);
}

/**
 * Parents come first, then one node per mesh. A parent has children and no
 * mesh, so a loader can yaw the whole frame without picking one stile.
 */
function sceneNodes(meshes: readonly NamedMesh[]): {
  nodes: Array<{ name: string; mesh?: number; children?: number[] }>;
  roots: number[];
} {
  const parents: string[] = [];
  for (const mesh of meshes) {
    if (mesh.parent && !parents.includes(mesh.parent)) parents.push(mesh.parent);
  }
  const nodes: Array<{ name: string; mesh?: number; children?: number[] }> = parents.map((name) => ({
    name,
    children: [],
  }));
  const roots = parents.map((_, index) => index);
  meshes.forEach((mesh, meshIndex) => {
    const nodeIndex = nodes.length;
    nodes.push({ name: mesh.name, mesh: meshIndex });
    if (!mesh.parent) {
      roots.push(nodeIndex);
      return;
    }
    const parent = nodes[parents.indexOf(mesh.parent)];
    if (!parent) throw new Error(`missing parent ${mesh.parent}`);
    parent.children?.push(nodeIndex);
  });
  return { nodes, roots };
}

function pushAccessor(
  bin: BinBuilder,
  bufferViews: unknown[],
  accessors: unknown[],
  bytes: Uint8Array,
  target: number,
  accessor: { bufferView?: number; componentType: number; count: number; type: string; min?: number[]; max?: number[] },
): number {
  const view = pushView(bin, bufferViews, bytes, target);
  const index = accessors.length;
  accessors.push({ ...accessor, bufferView: view });
  return index;
}

function pushView(bin: BinBuilder, bufferViews: unknown[], bytes: Uint8Array, target?: number): number {
  const part = bin.push(bytes);
  const index = bufferViews.length;
  bufferViews.push({
    buffer: 0,
    byteOffset: part.byteOffset,
    byteLength: part.byteLength,
    ...(target != null ? { target } : {}),
  });
  return index;
}

function quadIndices(count: number): number[] {
  const indices: number[] = [];
  for (let index = 0; index < count; index += 4) {
    indices.push(index, index + 1, index + 2, index, index + 2, index + 3);
  }
  return indices;
}

function cornerBuffers(corners: readonly DoorCorner[], textured: boolean): {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
  count: number;
} {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  for (const corner of corners) {
    positions.push(corner.position[0], corner.position[1], corner.position[2]);
    normals.push(corner.normal[0], corner.normal[1], corner.normal[2]);
    if (textured) {
      const uv = corner.uv;
      if (!uv) throw new Error("textured door corner is missing a uv");
      uvs.push(uv[0], uv[1]);
    }
  }
  return {
    positions,
    normals,
    uvs,
    indices: corners.map((_, index) => index),
    count: corners.length,
  };
}

function vec3Accessor(bufferView: number, count: number, values: number[]): {
  bufferView: number;
  componentType: number;
  count: number;
  type: string;
  min: number[];
  max: number[];
} {
  const stored = new Float32Array(values);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < stored.length; index += 1) {
    const value = stored[index]!;
    const axis = index % 3;
    if (value < min[axis]!) min[axis] = value;
    if (value > max[axis]!) max[axis] = value;
  }
  return { bufferView, componentType: 5126, count, type: "VEC3", min, max };
}

class BinBuilder {
  private readonly chunks: Uint8Array[] = [];
  private size = 0;

  push(bytes: Uint8Array): { byteOffset: number; byteLength: number } {
    const extra = (4 - (this.size % 4)) % 4;
    if (extra !== 0) {
      this.chunks.push(new Uint8Array(extra));
      this.size += extra;
    }
    const byteOffset = this.size;
    this.chunks.push(bytes);
    this.size += bytes.byteLength;
    return { byteOffset, byteLength: bytes.byteLength };
  }

  toUint8Array(): Uint8Array {
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return out;
  }
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
