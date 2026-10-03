import { PlanError } from "./errors.ts";
import type { Triangle, Vec3 } from "./types.ts";

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

const COMPONENT_SIZE: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};

const TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT4: 16,
};

type GltfAccessor = {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  normalized?: boolean;
  sparse?: unknown;
};

type GltfPrimitive = {
  attributes?: { POSITION?: number };
  indices?: number;
  mode?: number;
};

type GltfMesh = {
  name?: string;
  extras?: { collision?: unknown };
  primitives?: GltfPrimitive[];
};

type GltfNode = {
  name?: string;
  mesh?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  children?: number[];
  extras?: { collision?: unknown };
};

type Gltf = {
  scene?: number;
  scenes?: Array<{ nodes?: number[] }>;
  nodes?: GltfNode[];
  meshes?: GltfMesh[];
  accessors?: GltfAccessor[];
  bufferViews?: Array<{ buffer?: number; byteOffset?: number; byteLength: number; byteStride?: number }>;
  buffers?: Array<{ uri?: string; byteLength?: number }>;
};

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export type GlbLoad = {
  triangles: Triangle[];
  /** Mesh names that contributed triangles, in scene order. */
  meshNames: string[];
  /** POSITION vertices of the meshes that contributed. */
  vertexCount: number;
};

export type GlbLoadOptions = {
  /**
   * When set, keep a mesh only when its mesh or node name starts with this
   * prefix, or when `extras.collision` is true. Omit it to use every triangle mesh.
   */
  meshPrefix?: string;
};

/**
 * Triangle meshes in model space, with glTF node transforms applied.
 * Empty primitives are skipped. Throws when the scene has no triangle positions.
 */
export function trianglesFromGlb(bytes: Uint8Array, options?: GlbLoadOptions): GlbLoad {
  const { json, bin } = parseGlb(bytes);
  const doc = json as Gltf;
  if (doc.buffers?.[0]?.uri) throw new PlanError("external glTF buffers are not supported; use a .glb");
  const sceneIndex = doc.scene ?? 0;
  const roots = doc.scenes?.[sceneIndex]?.nodes;
  if (!roots) throw new PlanError("glb has no default scene");
  const nodes = doc.nodes ?? [];
  const meshes = doc.meshes ?? [];
  const triangles: Triangle[] = [];
  const meshNames: string[] = [];
  let vertexCount = 0;
  let hasTrianglePositions = false;
  const visit = (index: number, parent: number[]): void => {
    const node = nodes[index];
    if (!node) throw new PlanError(`glb node ${index} is missing`);
    const world = mul4(parent, nodeMatrix(node));
    if (node.mesh != null) {
      const mesh = meshes[node.mesh];
      if (!mesh) throw new PlanError(`glb mesh ${node.mesh} is missing`);
      const extracted = meshTriangles(doc, bin, mesh, world);
      if (extracted.vertexCount > 0) hasTrianglePositions = true;
      if (extracted.vertexCount > 0 && isSelected(node, mesh, options?.meshPrefix)) {
        triangles.push(...extracted.triangles);
        meshNames.push(meshLabel(node, mesh));
        vertexCount += extracted.vertexCount;
      }
    }
    for (const child of node.children ?? []) visit(child, world);
  };
  for (const root of roots) visit(root, IDENTITY);
  if (!hasTrianglePositions) throw new PlanError("no triangle position data");
  return { triangles, meshNames, vertexCount };
}

function isSelected(node: GltfNode, mesh: GltfMesh, meshPrefix: string | undefined): boolean {
  if (meshPrefix == null || meshPrefix === "") return true;
  return hasPrefix(node.name, meshPrefix)
    || hasPrefix(mesh.name, meshPrefix)
    || collisionExtra(node.extras)
    || collisionExtra(mesh.extras);
}

function hasPrefix(name: string | undefined, prefix: string): boolean {
  return typeof name === "string" && name.startsWith(prefix);
}

function meshLabel(node: GltfNode, mesh: GltfMesh): string {
  if (typeof mesh.name === "string" && mesh.name !== "") return mesh.name;
  if (typeof node.name === "string" && node.name !== "") return node.name;
  return "mesh";
}

function collisionExtra(extras: { collision?: unknown } | undefined): boolean {
  return extras?.collision === true;
}

function meshTriangles(
  doc: Gltf,
  bin: Uint8Array,
  mesh: GltfMesh,
  world: number[],
): { triangles: Triangle[]; vertexCount: number } {
  const triangles: Triangle[] = [];
  let vertexCount = 0;
  for (const primitive of mesh.primitives ?? []) {
    const mode = primitive.mode ?? 4;
    if (mode !== 4) continue;
    const positionIndex = primitive.attributes?.POSITION;
    if (positionIndex == null) continue;
    const positions = readVec3(doc, bin, positionIndex);
    if (positions.length === 0) continue;
    const indices = primitive.indices == null
      ? positions.map((_, index) => index)
      : readScalar(doc, bin, primitive.indices);
    if (indices.length === 0) continue;
    if (indices.length % 3 !== 0) {
      throw new PlanError(`mesh "${mesh.name ?? "?"}" index count is not a multiple of 3`);
    }
    vertexCount += positions.length;
    for (let i = 0; i < indices.length; i += 3) {
      const a = positions[indices[i]!]!;
      const b = positions[indices[i + 1]!]!;
      const c = positions[indices[i + 2]!]!;
      triangles.push([transformPoint(world, a), transformPoint(world, b), transformPoint(world, c)]);
    }
  }
  return { triangles, vertexCount };
}

function parseGlb(bytes: Uint8Array): { json: unknown; bin: Uint8Array } {
  if (bytes.byteLength < 20) throw new PlanError("glb is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new PlanError("not a glb");
  const version = view.getUint32(4, true);
  if (version !== 2) throw new PlanError(`unsupported glb version ${version}`);
  let offset = 12;
  let json: unknown = null;
  let bin = new Uint8Array(0);
  while (offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + length;
    if (end > bytes.byteLength) throw new PlanError("glb chunk overruns the file");
    const chunk = bytes.subarray(start, end);
    if (type === JSON_CHUNK) json = JSON.parse(new TextDecoder().decode(chunk));
    else if (type === BIN_CHUNK) bin = new Uint8Array(chunk);
    offset = end;
  }
  if (json == null) throw new PlanError("glb has no JSON chunk");
  return { json, bin };
}

function readVec3(doc: Gltf, bin: Uint8Array, accessorIndex: number): Vec3[] {
  const values = readAccessor(doc, bin, accessorIndex, "VEC3");
  const out: Vec3[] = [];
  for (let i = 0; i < values.length; i += 3) out.push([values[i]!, values[i + 1]!, values[i + 2]!]);
  return out;
}

function readScalar(doc: Gltf, bin: Uint8Array, accessorIndex: number): number[] {
  return readAccessor(doc, bin, accessorIndex, "SCALAR");
}

function readAccessor(doc: Gltf, bin: Uint8Array, accessorIndex: number, expect: string): number[] {
  const accessor = doc.accessors?.[accessorIndex];
  if (!accessor) throw new PlanError(`glb accessor ${accessorIndex} is missing`);
  if (accessor.sparse) throw new PlanError("sparse glTF accessors are not supported");
  if (accessor.type !== expect) throw new PlanError(`glb accessor ${accessorIndex} is ${accessor.type}, expected ${expect}`);
  if (expect === "VEC3" && accessor.componentType !== 5126) {
    throw new PlanError("positions must be FLOAT VEC3");
  }
  const components = TYPE_COMPONENTS[accessor.type];
  if (!components) throw new PlanError(`unsupported accessor type ${accessor.type}`);
  const size = COMPONENT_SIZE[accessor.componentType];
  if (!size) throw new PlanError(`unsupported component type ${accessor.componentType}`);
  if (accessor.bufferView == null) throw new PlanError(`glb accessor ${accessorIndex} has no bufferView`);
  const bufferView = doc.bufferViews?.[accessor.bufferView];
  if (!bufferView) throw new PlanError(`glb bufferView ${accessor.bufferView} is missing`);
  if ((bufferView.buffer ?? 0) !== 0) throw new PlanError("only glb buffer 0 is supported");
  const stride = bufferView.byteStride ?? components * size;
  const base = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const out: number[] = [];
  for (let i = 0; i < accessor.count; i += 1) {
    for (let k = 0; k < components; k += 1) {
      const at = base + i * stride + k * size;
      if (at + size > bin.byteLength) throw new PlanError("glb accessor reads past the buffer");
      out.push(readComponent(view, at, accessor.componentType));
    }
  }
  return out;
}

function readComponent(view: DataView, offset: number, componentType: number): number {
  switch (componentType) {
    case 5120:
      return view.getInt8(offset);
    case 5121:
      return view.getUint8(offset);
    case 5122:
      return view.getInt16(offset, true);
    case 5123:
      return view.getUint16(offset, true);
    case 5125:
      return view.getUint32(offset, true);
    case 5126:
      return view.getFloat32(offset, true);
    default:
      throw new PlanError(`unsupported component type ${componentType}`);
  }
}

function nodeMatrix(node: GltfNode): number[] {
  if (node.matrix) {
    if (node.matrix.length !== 16) throw new PlanError(`node "${node.name ?? "?"}" matrix must have 16 numbers`);
    return node.matrix;
  }
  const t = node.translation ?? [0, 0, 0];
  const r = node.rotation ?? [0, 0, 0, 1];
  const s = node.scale ?? [1, 1, 1];
  return compose(t, r, s);
}

/** Column-major T * R * S, matching glTF and Three.js. */
function compose(t: number[], q: number[], s: number[]): number[] {
  const x = q[0] ?? 0;
  const y = q[1] ?? 0;
  const z = q[2] ?? 0;
  const w = q[3] ?? 1;
  const sx = s[0] ?? 1;
  const sy = s[1] ?? 1;
  const sz = s[2] ?? 1;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0] ?? 0, t[1] ?? 0, t[2] ?? 0, 1,
  ];
}

function mul4(a: number[], b: number[]): number[] {
  const out = new Array<number>(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[column * 4 + row] =
        a[row]! * b[column * 4]! +
        a[4 + row]! * b[column * 4 + 1]! +
        a[8 + row]! * b[column * 4 + 2]! +
        a[12 + row]! * b[column * 4 + 3]!;
    }
  }
  return out;
}

function transformPoint(m: number[], p: Vec3): Vec3 {
  const [x, y, z] = p;
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ];
}
