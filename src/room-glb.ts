import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadTextureRef } from "./crate.ts";
import { PlanError } from "./errors.ts";
import { trianglesFromGlb } from "./glb.ts";
import type { DoorCorner, MeshPrimitive, NamedMesh } from "./glb-write.ts";
import { writeMeshesGlb } from "./glb-write.ts";
import { cutFace, roomApertures, subQuad, type Aperture } from "./room-cut.ts";
import { roomFile, type RoomFile } from "./room-file.ts";
import { readRoomSvg, type RoomFace, type RoomSource } from "./room-svg.ts";
import type { Vec3 } from "./types.ts";

const WALL_FACES: readonly RoomFace[] = ["front", "back", "left", "right"];

/** Untextured window pane. Blended and drawn from both sides. */
const PANE_RGBA: readonly [number, number, number, number] = [0.75, 0.85, 0.9, 0.3];

const c = (position: Vec3, normal: Vec3, uv: readonly [number, number]): DoorCorner => ({ position, normal, uv });

/**
 * One quad, wound counter-clockwise from inside the room.
 * Wall UVs are the crate ones: V = 0 is the top of the PNG. Floor and ceiling
 * use the plan: U grows with +X and V = 0 is +Z.
 */
export function faceCorners(face: RoomFace, hx: number, hz: number, y1: number): DoorCorner[] {
  switch (face) {
    case "front": // crate back at z = +hz, facing -Z
      return [
        c([hx, 0, hz], [0, 0, -1], [0, 1]),
        c([-hx, 0, hz], [0, 0, -1], [1, 1]),
        c([-hx, y1, hz], [0, 0, -1], [1, 0]),
        c([hx, y1, hz], [0, 0, -1], [0, 0]),
      ];
    case "back": // crate front at z = -hz, facing +Z
      return [
        c([-hx, 0, -hz], [0, 0, 1], [0, 1]),
        c([hx, 0, -hz], [0, 0, 1], [1, 1]),
        c([hx, y1, -hz], [0, 0, 1], [1, 0]),
        c([-hx, y1, -hz], [0, 0, 1], [0, 0]),
      ];
    case "left": // crate right at x = -hx, facing +X
      return [
        c([-hx, 0, hz], [1, 0, 0], [0, 1]),
        c([-hx, 0, -hz], [1, 0, 0], [1, 1]),
        c([-hx, y1, -hz], [1, 0, 0], [1, 0]),
        c([-hx, y1, hz], [1, 0, 0], [0, 0]),
      ];
    case "right": // crate left at x = +hx, facing -X
      return [
        c([hx, 0, -hz], [-1, 0, 0], [0, 1]),
        c([hx, 0, hz], [-1, 0, 0], [1, 1]),
        c([hx, y1, hz], [-1, 0, 0], [1, 0]),
        c([hx, y1, -hz], [-1, 0, 0], [0, 0]),
      ];
    case "floor": // plan rule: V = 0 at +Z
      return [
        c([-hx, 0, hz], [0, 1, 0], [0, 0]),
        c([hx, 0, hz], [0, 1, 0], [1, 0]),
        c([hx, 0, -hz], [0, 1, 0], [1, 1]),
        c([-hx, 0, -hz], [0, 1, 0], [0, 1]),
      ];
    case "ceiling": // plan rule, seen from below
      return [
        c([hx, y1, hz], [0, -1, 0], [1, 0]),
        c([-hx, y1, hz], [0, -1, 0], [0, 0]),
        c([-hx, y1, -hz], [0, -1, 0], [0, 1]),
        c([hx, y1, -hz], [0, -1, 0], [1, 1]),
      ];
  }
}

/** Floor, ceiling, and the four inside walls. Origin is the floor centre. Cuts are in (s, t). */
export function roomMeshes(room: RoomSource, images: (ref: string) => Uint8Array): NamedMesh[] {
  const hx = room.width / 2;
  const hz = room.depth / 2;
  const y1 = room.height;
  const apertures = roomApertures(room);
  const quad = (face: RoomFace): MeshPrimitive => {
    const corners = faceCorners(face, hx, hz, y1);
    return {
      corners: cutFace(apertures[face]).flatMap((rect) => subQuad(corners, rect)),
      image: images(room.faces[face].ref),
      quads: true,
    };
  };
  const meshes: NamedMesh[] = [
    { name: "floor", primitives: [quad("floor")] },
    { name: "ceiling", primitives: [quad("ceiling")] },
    { name: "walls", primitives: WALL_FACES.map(quad) },
  ];
  const glass = glassPrimitives(room, apertures, hx, hz, y1, images);
  if (glass.length > 0) meshes.push({ name: "glass", primitives: glass });
  return meshes;
}

/** One quad per glazed window, on the wall, with upright pane UVs when textured. */
function glassPrimitives(
  room: RoomSource,
  apertures: Record<RoomFace, Aperture[]>,
  hx: number,
  hz: number,
  y1: number,
  images: (ref: string) => Uint8Array,
): MeshPrimitive[] {
  const primitives: MeshPrimitive[] = [];
  for (const win of room.windows) {
    if (!win.glass) continue;
    const aperture = apertures[win.wall].find((item) => item.id === win.id);
    if (!aperture) throw new PlanError(`room "${room.id}" window "${win.id}" has no aperture`);
    const corners = paneQuad(faceCorners(win.wall, hx, hz, y1), aperture);
    if (win.paneRef) {
      primitives.push({ corners, image: images(win.paneRef), quads: true, blend: true });
    } else {
      primitives.push({ corners, quads: true, color: PANE_RGBA, blend: true });
    }
  }
  return primitives;
}

/** Wall pane. u follows s and v = 0 is the top of the opening, as seen in (s, t). */
function paneQuad(c: readonly DoorCorner[], aperture: Aperture): DoorCorner[] {
  const quad = subQuad(c, aperture);
  const sSpan = aperture.s1 - aperture.s0;
  const tSpan = aperture.t1 - aperture.t0;
  const samples: Array<[number, number]> = [
    [aperture.s0, aperture.t0],
    [aperture.s1, aperture.t0],
    [aperture.s1, aperture.t1],
    [aperture.s0, aperture.t1],
  ];
  return quad.map((corner, index) => {
    const [s, t] = samples[index]!;
    const uv: [number, number] = [
      sSpan === 0 ? 0 : (s - aperture.s0) / sSpan,
      tSpan === 0 ? 0 : 1 - (t - aperture.t0) / tSpan,
    ];
    return { position: corner.position, normal: corner.normal, uv };
  });
}

/**
 * Read a room SVG. Without `glbPath`, write the generated inside-face GLB.
 * With `glbPath`, copy that Blender GLB (origin at the floor centre).
 * Either way, write `<id>.room.json` next to `--out`.
 */
export function writeRoom(options: {
  svgPath: string;
  outPath: string;
  glbPath?: string;
}): { room: RoomSource; file: RoomFile; warnings: string[] } {
  let svgText: string;
  try {
    svgText = readFileSync(options.svgPath, "utf8");
  } catch {
    throw new PlanError(`could not read "${options.svgPath}"`);
  }
  const room = readRoomSvg(svgText, options.svgPath);
  const blender = options.glbPath;
  let blenderBytes: Uint8Array | undefined;
  if (blender) {
    try {
      blenderBytes = readFileSync(blender);
    } catch {
      throw new PlanError(`could not read "${blender}"`);
    }
  }
  const file = roomFile(room, path.basename(options.outPath), blender ? "blender" : "svg");
  const warnings = [...room.warnings];
  if (blenderBytes) {
    const bounds = glbBoundsWarning(room, blenderBytes);
    if (bounds) warnings.push(bounds);
  }
  const bytes = blenderBytes ?? svgGlb(room, options.svgPath);
  mkdirSync(path.dirname(path.resolve(options.outPath)), { recursive: true });
  if (!blender || !sameFile(blender, options.outPath)) writeFileSync(options.outPath, bytes);
  const jsonPath = path.join(path.dirname(options.outPath), `${room.id}.room.json`);
  writeFileSync(jsonPath, `${JSON.stringify(file, null, 2)}\n`);
  return { room, file, warnings };
}

/** Generated inside faces. One PNG per distinct ref. */
function svgGlb(room: RoomSource, svgPath: string): Uint8Array {
  const loaded = new Map<string, Uint8Array>();
  for (const face of Object.keys(room.faces) as RoomFace[]) {
    const texture = room.faces[face];
    if (loaded.has(texture.ref)) continue;
    loaded.set(texture.ref, loadTextureRef(svgPath, texture.ref, texture.source));
  }
  for (const win of room.windows) {
    if (!win.glass || !win.paneRef || loaded.has(win.paneRef)) continue;
    loaded.set(win.paneRef, loadTextureRef(svgPath, win.paneRef, win.id));
  }
  return writeMeshesGlb(roomMeshes(room, (ref) => {
    const image = loaded.get(ref);
    if (!image) throw new PlanError(`room "${room.id}" texture "${ref}" was not loaded`);
    return image;
  }));
}

/** Warn when a side of the GLB's XZ bounds is more than 0.5 m off ±width/2, ±depth/2. */
function glbBoundsWarning(room: RoomSource, bytes: Uint8Array): string | undefined {
  const { triangles } = trianglesFromGlb(bytes);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const triangle of triangles) {
    for (const vertex of triangle) {
      minX = Math.min(minX, vertex[0]);
      maxX = Math.max(maxX, vertex[0]);
      minZ = Math.min(minZ, vertex[2]);
      maxZ = Math.max(maxZ, vertex[2]);
    }
  }
  const hx = room.width / 2;
  const hz = room.depth / 2;
  const off = (got: number, expected: number) => Math.abs(got - expected) > 0.5;
  if (!off(minX, -hx) && !off(maxX, hx) && !off(minZ, -hz) && !off(maxZ, hz)) return undefined;
  const dp2 = (n: number) => {
    const rounded = Math.round(n * 100) / 100;
    return Object.is(rounded, -0) ? "0" : String(rounded);
  };
  return `room "${room.id}": GLB bounds x ${dp2(minX)}..${dp2(maxX)} z ${dp2(minZ)}..${dp2(maxZ)} do not match the footprint`;
}

function sameFile(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  if (left === right) return true;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}
