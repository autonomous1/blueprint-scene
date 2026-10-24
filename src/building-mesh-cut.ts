import { doorClearLocal } from "./doors.ts";
import { PlanError } from "./errors.ts";
import { readTexturedGlb, type TexturedGlb, type TexturedPrimitive, type TexturedVertex } from "./glb.ts";
import { writeTexturedGlb } from "./glb-write.ts";
import type { DoorPlacement, LocalBox, Vec3, Yaw } from "./types.ts";
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
  if (!(buildingScale > 0)) throw new PlanError("building scale must be positive");
  const gap = doorClearLocal(placement);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const x of [gap.minX, gap.maxX]) {
    for (const y of [gap.minY, gap.maxY]) {
      for (const z of [gap.minZ, gap.maxZ]) {
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
