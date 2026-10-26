import { doorClearLocal } from "./doors.ts";
import { PlanError } from "./errors.ts";
import { readTexturedGlb, type TexturedGlb, type TexturedPrimitive, type TexturedVertex } from "./glb.ts";
import { writeTexturedGlb } from "./glb-write.ts";
import type { DoorPlacement, LocalBox, Triangle, Vec3, Yaw } from "./types.ts";
import { inverseYaw, transformXz } from "./yaw.ts";

/**
 * A point this far outside a plane is outside the opening. A point on the
 * plane counts as inside, so a facade triangle lying on the door face is
 * removed where it covers the hole.
 */
const PLANE_EPS = 1e-8;

type Vert = {
  p: Vec3;
  n?: Vec3;
  uv?: readonly [number, number];
};

/**
 * The door gap in the building GLB's space. That space is the one
 * `trianglesFromGlb` returns: node transforms applied, placement scale not.
 * The gap is `doorClearLocal` — X along the wall, Y up from the sill, Z from
 * `-DOOR_GAP_DEPTH_M` (inward) to 0 (the face). Eight corners go door → world
 * → model. Cardinal yaw keeps the result an AABB.
 *
 * Check: building (-20.611524, 0, 0.25919), yaw 90, scale 30, left hinge
 * (-23.754711, 2.75, 15.259191), yaw 0, width 1.055523, height 2.1.
 * Local (0, 0, 0) is model (-0.5, 0.091667, -0.104773).
 */
export function openingInModel(
  placement: DoorPlacement,
  buildingPosition: Vec3,
  buildingYaw: Yaw,
  buildingScale: number,
): LocalBox {
  return boxInModel(placement, doorClearLocal(placement), buildingPosition, buildingYaw, buildingScale);
}

/**
 * `local` is in the door frame (`doorClearLocal`: hinge at the origin, −Z
 * inward). Eight corners go door → world → model. Cardinal yaw keeps an AABB.
 * `openingInModel` is this for the 2 m inward stamp. A wall cut passes the
 * thicker box `doorCutLocal` measured, so the punch includes the proud face.
 */
export function boxInModel(
  placement: DoorPlacement,
  local: LocalBox,
  buildingPosition: Vec3,
  buildingYaw: Yaw,
  buildingScale: number,
): LocalBox {
  if (!(buildingScale > 0)) throw new PlanError("building scale must be positive");
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const x of [local.minX, local.maxX]) {
    for (const y of [local.minY, local.maxY]) {
      for (const z of [local.minZ, local.maxZ]) {
        const world = doorToWorld(placement, x, y, z);
        const model = worldToModel(world, buildingPosition, buildingYaw, buildingScale);
        if (model[0] < minX) minX = model[0];
        if (model[0] > maxX) maxX = model[0];
        if (model[1] < minY) minY = model[1];
        if (model[1] > maxY) maxY = model[1];
        if (model[2] < minZ) minZ = model[2];
        if (model[2] > maxZ) maxZ = model[2];
      }
    }
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

/**
 * A collision skin thinner than this, in model units, may stop short of the
 * facade. 0.02 is 0.6 m on a scale-30 building. A thicker axis is the door
 * width or the full wall.
 */
const SKIN_M = 0.02;

/**
 * How far past a thin skin a center-ray hit may pull the punch, in model
 * units. Measured from the original face, so a stack of skins cannot walk
 * further than this. A wall metres further is not included.
 */
const SKIN_REACH_M = 0.02;

/**
 * A through-cut already spans the wall, but the facade vertex can still sit
 * a fraction of a millimetre outside that face. 0.002 is 6 cm at scale 30.
 */
const FACADE_SLIVER_M = 0.002;

/**
 * Grow `box` out to a mesh face the doorway center actually hits. A thin
 * axis may reach `SKIN_REACH_M`. Any axis may reach `FACADE_SLIVER_M`, so a
 * punch that stops just short of the facade removes that face. The door
 * width is not grown out to the next wall.
 */
export function extendSkinToFacade(triangles: readonly Triangle[], box: LocalBox): LocalBox {
  const min = [box.minX, box.minY, box.minZ];
  const max = [box.maxX, box.maxY, box.maxZ];
  for (const axis of [0, 1, 2] as const) {
    const startMin = min[axis]!;
    const startMax = max[axis]!;
    const reach = startMax - startMin < SKIN_M ? SKIN_REACH_M : FACADE_SLIVER_M;
    const origin: Vec3 = [
      (min[0]! + max[0]!) / 2,
      (min[1]! + max[1]!) / 2,
      (min[2]! + max[2]!) / 2,
    ];
    origin[axis] = startMin - 1;
    const dir: Vec3 = [0, 0, 0];
    dir[axis] = 1;
    for (const at of axisHits(triangles, origin, dir, axis)) {
      if (at < startMin && startMin - at <= reach) {
        const pulled = at - PLANE_EPS;
        if (pulled < min[axis]!) min[axis] = pulled;
      }
      if (at > startMax && at - startMax <= reach) {
        const pulled = at + PLANE_EPS;
        if (pulled > max[axis]!) max[axis] = pulled;
      }
    }
  }
  return {
    minX: min[0]!,
    maxX: max[0]!,
    minY: min[1]!,
    maxY: max[1]!,
    minZ: min[2]!,
    maxZ: max[2]!,
  };
}

function axisHits(triangles: readonly Triangle[], origin: Vec3, dir: Vec3, axis: 0 | 1 | 2): number[] {
  const hits: number[] = [];
  for (const [a, b, c] of triangles) {
    const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const p: Vec3 = [
      dir[1] * ac[2] - dir[2] * ac[1],
      dir[2] * ac[0] - dir[0] * ac[2],
      dir[0] * ac[1] - dir[1] * ac[0],
    ];
    const det = ab[0] * p[0] + ab[1] * p[1] + ab[2] * p[2];
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const tvec: Vec3 = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]];
    const u = (tvec[0] * p[0] + tvec[1] * p[1] + tvec[2] * p[2]) * inv;
    if (u < -1e-5 || u > 1 + 1e-5) continue;
    const q: Vec3 = [
      tvec[1] * ab[2] - tvec[2] * ab[1],
      tvec[2] * ab[0] - tvec[0] * ab[2],
      tvec[0] * ab[1] - tvec[1] * ab[0],
    ];
    const v = (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2]) * inv;
    if (v < -1e-5 || u + v > 1 + 1e-5) continue;
    const t = (ac[0] * q[0] + ac[1] * q[1] + ac[2] * q[2]) * inv;
    if (t <= 1e-4) continue;
    hits.push(origin[axis] + dir[axis] * t);
  }
  return hits;
}

/**
 * Source triangles that are not strictly outside `opening`, one count per
 * opening. A triangle that only touches the box from the outside is not
 * counted. The bake logs this as the triangles the punch removes.
 */
export function openingOverlapCounts(bytes: Uint8Array, openings: readonly LocalBox[]): number[] {
  const doc = readTexturedGlb(bytes);
  const tris: Vert[][] = [];
  for (const mesh of doc.meshes) {
    for (const primitive of mesh.primitives) {
      for (let index = 0; index < primitive.indices.length; index += 3) {
        const a = vertexAt(primitive, primitive.indices[index]!);
        const b = vertexAt(primitive, primitive.indices[index + 1]!);
        const c = vertexAt(primitive, primitive.indices[index + 2]!);
        tris.push([a, b, c]);
      }
    }
  }
  return openings.map((opening) => tris.reduce((count, tri) => count + (disjoint(tri, opening) ? 0 : 1), 0));
}

export type MeshProbe = {
  /** Highest vertex in the mesh, metres in the same space as `openingInModel`. */
  maxY: number;
  /**
   * True when a ray along `axis` in `direction` through the opening hits a
   * triangle inside the box. Samples are the inner 3×3 of the other two axes,
   * so a doorway that is already a hole is clear and a facade quad is not.
   */
  blocks(opening: LocalBox, axis: 0 | 2, direction: -1 | 1): boolean;
};

/**
 * Triangles of a textured GLB in `openingInModel` space, for doorway probes.
 * One parse serves every instance of a shared room mesh.
 */
export function meshProbe(bytes: Uint8Array): MeshProbe {
  const doc = readTexturedGlb(bytes);
  const tris: Triangle[] = [];
  let maxY = 0;
  for (const mesh of doc.meshes) {
    for (const primitive of mesh.primitives) {
      for (let index = 0; index < primitive.indices.length; index += 3) {
        const a = primitive.vertices[primitive.indices[index]!]?.position;
        const b = primitive.vertices[primitive.indices[index + 1]!]?.position;
        const c = primitive.vertices[primitive.indices[index + 2]!]?.position;
        if (!a || !b || !c) continue;
        tris.push([a, b, c]);
        for (const point of [a, b, c]) if (point[1] > maxY) maxY = point[1];
      }
    }
  }
  return {
    maxY,
    blocks(opening, axis, direction) {
      const min = [opening.minX, opening.minY, opening.minZ];
      const max = [opening.maxX, opening.maxY, opening.maxZ];
      const other = [0, 1, 2].filter((item) => item !== axis);
      for (const u of [0.35, 0.5, 0.65]) {
        for (const v of [0.35, 0.5, 0.65]) {
          const origin: Vec3 = [0, 0, 0];
          origin[other[0]!] = min[other[0]!]! + (max[other[0]!]! - min[other[0]!]!) * u;
          origin[other[1]!] = min[other[1]!]! + (max[other[1]!]! - min[other[1]!]!) * v;
          origin[axis] = direction > 0 ? min[axis]! - 0.5 : max[axis]! + 0.5;
          const dir: Vec3 = [0, 0, 0];
          dir[axis] = direction;
          if (rayHitsBox(tris, origin, dir, min, max)) return true;
        }
      }
      return false;
    },
  };
}

function rayHitsBox(
  tris: readonly Triangle[],
  origin: Vec3,
  dir: Vec3,
  min: readonly number[],
  max: readonly number[],
): boolean {
  for (const [a, b, c] of tris) {
    const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const p: Vec3 = [
      dir[1] * ac[2] - dir[2] * ac[1],
      dir[2] * ac[0] - dir[0] * ac[2],
      dir[0] * ac[1] - dir[1] * ac[0],
    ];
    const det = ab[0] * p[0] + ab[1] * p[1] + ab[2] * p[2];
    if (Math.abs(det) < 1e-10) continue;
    const inv = 1 / det;
    const tvec: Vec3 = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]];
    const u = (tvec[0] * p[0] + tvec[1] * p[1] + tvec[2] * p[2]) * inv;
    if (u < -1e-5 || u > 1 + 1e-5) continue;
    const q: Vec3 = [
      tvec[1] * ab[2] - tvec[2] * ab[1],
      tvec[2] * ab[0] - tvec[0] * ab[2],
      tvec[0] * ab[1] - tvec[1] * ab[0],
    ];
    const v = (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2]) * inv;
    if (v < -1e-5 || u + v > 1 + 1e-5) continue;
    const t = (ac[0] * q[0] + ac[1] * q[1] + ac[2] * q[2]) * inv;
    if (t <= 1e-4) continue;
    const hit: Vec3 = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
    let inside = true;
    for (let axis = 0; axis < 3; axis += 1) {
      if (hit[axis]! < min[axis]! - 1e-3 || hit[axis]! > max[axis]! + 1e-3) inside = false;
    }
    if (inside) return true;
  }
  return false;
}

/**
 * Punch `openings` out of a textured building GLB. Each opening is an AABB in
 * the mesh's model space. Triangles that miss an opening keep their vertices.
 * A triangle that crosses one is split; UVs and normals are barycentric on
 * the cut edges. Image bytes and materials are copied through.
 * An empty opening list returns `bytes` unchanged.
 */
export function cutBuildingGlb(bytes: Uint8Array, openings: readonly LocalBox[]): Uint8Array {
  if (openings.length === 0) return bytes;
  const doc = readTexturedGlb(bytes);
  const cut = cutTexturedGlb(doc, openings);
  return writeTexturedGlb(cut);
}

/**
 * Source mesh in the cut-file form: node transforms baked, identity nodes,
 * no door punches. `cutBuildingGlb` with an empty list returns `bytes`
 * unchanged, which would keep a source node's scale. A stale `.cut.glb`
 * has to be replaced with this instead.
 */
export function uncutBuildingGlb(bytes: Uint8Array): Uint8Array {
  return writeTexturedGlb(readTexturedGlb(bytes));
}

function cutTexturedGlb(doc: TexturedGlb, openings: readonly LocalBox[]): TexturedGlb {
  const meshes = doc.meshes.map((mesh) => ({
    ...mesh,
    primitives: mesh.primitives
      .map((primitive) => cutPrimitive(primitive, openings))
      .filter((primitive) => primitive.indices.length > 0),
  })).filter((mesh) => mesh.primitives.length > 0);
  if (meshes.length === 0) throw new PlanError("door cut removed every triangle");
  return { ...doc, meshes };
}

function cutPrimitive(primitive: TexturedPrimitive, openings: readonly LocalBox[]): TexturedPrimitive {
  let tris: Vert[][] = [];
  for (let index = 0; index < primitive.indices.length; index += 3) {
    const a = vertexAt(primitive, primitive.indices[index]!);
    const b = vertexAt(primitive, primitive.indices[index + 1]!);
    const c = vertexAt(primitive, primitive.indices[index + 2]!);
    tris.push([a, b, c]);
  }
  for (const opening of openings) {
    const next: Vert[][] = [];
    for (const tri of tris) {
      if (disjoint(tri, opening)) next.push(tri);
      else next.push(...subtractBox(tri, opening));
    }
    tris = next;
  }
  const vertices: TexturedVertex[] = [];
  const indices: number[] = [];
  for (const tri of tris) {
    const base = vertices.length;
    for (const vert of tri) vertices.push(toVertex(vert));
    indices.push(base, base + 1, base + 2);
  }
  return {
    ...(primitive.material != null ? { material: primitive.material } : {}),
    vertices,
    indices,
  };
}

function vertexAt(primitive: TexturedPrimitive, index: number): Vert {
  const vertex = primitive.vertices[index];
  if (!vertex) throw new PlanError("glb index is out of range");
  return {
    p: vertex.position,
    ...(vertex.normal ? { n: vertex.normal } : {}),
    ...(vertex.uv ? { uv: vertex.uv } : {}),
  };
}

function toVertex(vert: Vert): TexturedVertex {
  return {
    position: vert.p,
    ...(vert.n ? { normal: vert.n } : {}),
    ...(vert.uv ? { uv: [vert.uv[0], vert.uv[1]] as const } : {}),
  };
}

/** True when every vertex is strictly outside one and the same face of the box. */
function disjoint(tri: readonly Vert[], box: LocalBox): boolean {
  const mins = [box.minX, box.minY, box.minZ];
  const maxs = [box.maxX, box.maxY, box.maxZ];
  for (let axis = 0; axis < 3; axis += 1) {
    let below = true;
    let above = true;
    for (const vert of tri) {
      if (vert.p[axis]! >= mins[axis]! - PLANE_EPS) below = false;
      if (vert.p[axis]! <= maxs[axis]! + PLANE_EPS) above = false;
    }
    if (below || above) return true;
  }
  return false;
}

/**
 * Keep the parts of one triangle that lie outside `box`. The portion inside
 * every plane, including a face that lies on a plane, is dropped.
 */
function subtractBox(tri: Vert[], box: LocalBox): Vert[][] {
  const planes = [
    (vert: Vert) => box.minX - vert.p[0],
    (vert: Vert) => vert.p[0] - box.maxX,
    (vert: Vert) => box.minY - vert.p[1],
    (vert: Vert) => vert.p[1] - box.maxY,
    (vert: Vert) => box.minZ - vert.p[2],
    (vert: Vert) => vert.p[2] - box.maxZ,
  ];
  let inside: Vert[][] = [tri];
  const kept: Vert[][] = [];
  for (const amount of planes) {
    const next: Vert[][] = [];
    for (const poly of inside) {
      const parts = splitPoly(poly, amount);
      const outside = clean(parts.outside);
      const rest = clean(parts.inside);
      if (outside.length >= 3) kept.push(outside);
      if (rest.length >= 3) next.push(rest);
    }
    inside = next;
  }
  return kept.flatMap(fan);
}

function splitPoly(poly: readonly Vert[], amount: (vert: Vert) => number): { outside: Vert[]; inside: Vert[] } {
  const outside: Vert[] = [];
  const inside: Vert[] = [];
  const distance = poly.map(amount);
  for (let index = 0; index < poly.length; index += 1) {
    const next = (index + 1) % poly.length;
    const here = distance[index]!;
    const there = distance[next]!;
    const from = poly[index]!;
    const to = poly[next]!;
    const fromOut = here > PLANE_EPS;
    const toOut = there > PLANE_EPS;
    if (fromOut) outside.push(from);
    else inside.push(from);
    if (fromOut !== toOut) {
      const denom = here - there;
      const t = denom === 0 ? 0 : Math.min(1, Math.max(0, here / denom));
      const hit = lerpVert(from, to, t);
      outside.push(hit);
      inside.push(hit);
    }
  }
  return { outside, inside };
}

function lerpVert(from: Vert, to: Vert, t: number): Vert {
  const hit: Vert = { p: mix3(from.p, to.p, t) };
  if (from.n && to.n) hit.n = unit(mix3(from.n, to.n, t));
  if (from.uv && to.uv) {
    hit.uv = [
      from.uv[0] + (to.uv[0] - from.uv[0]) * t,
      from.uv[1] + (to.uv[1] - from.uv[1]) * t,
    ];
  }
  return hit;
}

function clean(poly: readonly Vert[]): Vert[] {
  const out: Vert[] = [];
  for (const vert of poly) {
    const prev = out[out.length - 1];
    if (prev && nearPoint(prev.p, vert.p)) continue;
    out.push(vert);
  }
  if (out.length >= 2 && nearPoint(out[0]!.p, out[out.length - 1]!.p)) out.pop();
  return out;
}

function fan(poly: readonly Vert[]): Vert[][] {
  const tris: Vert[][] = [];
  for (let index = 1; index + 1 < poly.length; index += 1) {
    const tri = [poly[0]!, poly[index]!, poly[index + 1]!];
    if (area2(tri) > 1e-20) tris.push(tri);
  }
  return tris;
}

function area2(tri: readonly Vert[]): number {
  const ab = sub3(tri[1]!.p, tri[0]!.p);
  const ac = sub3(tri[2]!.p, tri[0]!.p);
  const cross = [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ];
  return cross[0]! * cross[0]! + cross[1]! * cross[1]! + cross[2]! * cross[2]!;
}

function nearPoint(a: Vec3, b: Vec3): boolean {
  return Math.abs(a[0] - b[0]) <= PLANE_EPS
    && Math.abs(a[1] - b[1]) <= PLANE_EPS
    && Math.abs(a[2] - b[2]) <= PLANE_EPS;
}

function mix3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function unit(n: Vec3): Vec3 {
  const len = Math.hypot(n[0], n[1], n[2]);
  if (!(len > 1e-12)) return n;
  return [n[0] / len, n[1] / len, n[2] / len];
}

function doorToWorld(placement: DoorPlacement, x: number, y: number, z: number): Vec3 {
  const along = transformXz(x, z, placement.yaw);
  return [
    placement.position[0] + along.x,
    placement.position[1] + y,
    placement.position[2] + along.z,
  ];
}

function worldToModel(world: Vec3, origin: Vec3, yaw: Yaw, scale: number): Vec3 {
  const local = transformXz(world[0] - origin[0], world[2] - origin[2], inverseYaw(yaw));
  return [local.x / scale, (world[1] - origin[1]) / scale, local.z / scale];
}
