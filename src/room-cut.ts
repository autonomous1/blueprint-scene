import { DOOR_HEIGHT_M } from "./doors.ts";
import { PlanError } from "./errors.ts";
import type { DoorCorner } from "./glb-write.ts";
import { faceCorners } from "./room-glb.ts";
import type { RoomFace, RoomSource, WallFace } from "./room-svg.ts";
import type { Vec3 } from "./types.ts";

export type St = { s0: number; s1: number; t0: number; t1: number };

export type Aperture = St & { id: string };

const FACES: readonly RoomFace[] = ["front", "back", "left", "right", "floor", "ceiling"];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** (s, t) of a point on the face. c = faceCorners(...). */
export function stOf(c: readonly DoorCorner[], p: Vec3): [number, number] {
  const e1 = sub(c[1]!.position, c[0]!.position);
  const e3 = sub(c[3]!.position, c[0]!.position);
  const d = sub(p, c[0]!.position);
  return [dot(d, e1) / dot(e1, e1), dot(d, e3) / dot(e3, e3)];
}

/** Quad for a sub-rectangle, same winding and UV mapping as the whole face. */
export function subQuad(c: readonly DoorCorner[], r: St): DoorCorner[] {
  const at = (s: number, t: number): DoorCorner => {
    const lerp = (i: 0 | 1 | 2, k: "position") =>
      c[0]![k][i] + s * (c[1]![k][i] - c[0]![k][i]) + t * (c[3]![k][i] - c[0]![k][i]);
    const uv = (i: 0 | 1) => c[0]!.uv![i] + s * (c[1]!.uv![i] - c[0]!.uv![i]) + t * (c[3]!.uv![i] - c[0]!.uv![i]);
    return { position: [lerp(0, "position"), lerp(1, "position"), lerp(2, "position")], normal: c[0]!.normal, uv: [uv(0), uv(1)] };
  };
  return [at(r.s0, r.t0), at(r.s1, r.t0), at(r.s1, r.t1), at(r.s0, r.t1)];
}

/**
 * Doors, windows, openings, and holes as rectangles in each face's (s, t).
 * s runs along c0→c1 and t along c0→c3. Values are clamped to [0, 1].
 */
export function roomApertures(room: RoomSource): Record<RoomFace, Aperture[]> {
  const hx = room.width / 2;
  const hz = room.depth / 2;
  const y1 = room.height;
  const out: Record<RoomFace, Aperture[]> = {
    front: [],
    back: [],
    left: [],
    right: [],
    floor: [],
    ceiling: [],
  };
  const add = (face: RoomFace, id: string, a: Vec3, b: Vec3): void => {
    const corners = faceCorners(face, hx, hz, y1);
    const [sA, tA] = stOf(corners, a);
    const [sB, tB] = stOf(corners, b);
    out[face].push({
      id,
      s0: clamp01(Math.min(sA, sB)),
      s1: clamp01(Math.max(sA, sB)),
      t0: clamp01(Math.min(tA, tB)),
      t1: clamp01(Math.max(tA, tB)),
    });
  };

  for (const door of room.doors) {
    const alongX = door.wall === "front" || door.wall === "back";
    const width = door.width ?? (alongX ? door.maxX - door.minX : door.maxZ - door.minZ);
    const height = door.height ?? DOOR_HEIGHT_M;
    const [a, b] = wallRect(door.wall, door.center[0], door.center[2], width, door.center[1], height);
    add(door.wall, door.id, a, b);
  }
  for (const win of room.windows) {
    const [a, b] = wallRect(win.wall, (win.minX + win.maxX) / 2, (win.minZ + win.maxZ) / 2, win.width, win.sill, win.height);
    add(win.wall, win.id, a, b);
  }
  for (const opening of room.openings) {
    const [a, b] = wallRect(
      opening.wall,
      (opening.minX + opening.maxX) / 2,
      (opening.minZ + opening.maxZ) / 2,
      opening.width,
      opening.sill,
      opening.height,
    );
    add(opening.wall, opening.id, a, b);
  }
  for (const hole of room.holes) {
    if (hole.cut === "floor" || hole.cut === "both") {
      add("floor", hole.id, [hole.minX, 0, hole.minZ], [hole.maxX, 0, hole.maxZ]);
    }
    if (hole.cut === "ceiling" || hole.cut === "both") {
      add("ceiling", hole.id, [hole.minX, y1, hole.minZ], [hole.maxX, y1, hole.maxZ]);
    }
  }

  for (const face of FACES) {
    const list = out[face];
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i]!;
        const b = list[j]!;
        const s = Math.min(a.s1, b.s1) - Math.max(a.s0, b.s0);
        const t = Math.min(a.t1, b.t1) - Math.max(a.t0, b.t0);
        if (s > 1e-6 && t > 1e-6) {
          throw new PlanError(`room "${room.id}": "${a.id}" and "${b.id}" overlap on the ${face}`);
        }
      }
    }
  }
  return out;
}

/** Kept rectangles. No apertures returns the single cell `{0, 1, 0, 1}`. */
export function cutFace(apertures: readonly Aperture[]): St[] {
  const ss = uniqueSorted([0, 1, ...apertures.flatMap((aperture) => [aperture.s0, aperture.s1])]);
  const ts = uniqueSorted([0, 1, ...apertures.flatMap((aperture) => [aperture.t0, aperture.t1])]);
  const rows: St[][] = [];
  for (let row = 0; row < ts.length - 1; row += 1) {
    const t0 = ts[row]!;
    const t1 = ts[row + 1]!;
    const tMid = (t0 + t1) / 2;
    const runs: St[] = [];
    let run: St | undefined;
    for (let col = 0; col < ss.length - 1; col += 1) {
      const s0 = ss[col]!;
      const s1 = ss[col + 1]!;
      const sMid = (s0 + s1) / 2;
      const open = apertures.some((aperture) =>
        sMid >= aperture.s0 && sMid <= aperture.s1 && tMid >= aperture.t0 && tMid <= aperture.t1);
      if (open) {
        run = undefined;
        continue;
      }
      if (run && run.s1 === s0) run.s1 = s1;
      else {
        run = { s0, s1, t0, t1 };
        runs.push(run);
      }
    }
    rows.push(runs);
  }

  const finished: St[] = [];
  let active: St[] = [];
  for (const runs of rows) {
    const next: St[] = [];
    const used = new Set<number>();
    for (const run of runs) {
      const match = active.findIndex((item, index) => !used.has(index) && item.s0 === run.s0 && item.s1 === run.s1);
      if (match >= 0) {
        used.add(match);
        const extended = active[match]!;
        extended.t1 = run.t1;
        next.push(extended);
      } else {
        next.push({ s0: run.s0, s1: run.s1, t0: run.t0, t1: run.t1 });
      }
    }
    for (let index = 0; index < active.length; index += 1) {
      if (!used.has(index)) finished.push(active[index]!);
    }
    active = next;
  }
  finished.push(...active);
  return finished;
}

/** Opposite corners of a wall opening centred on (x, z), from the sill up. */
function wallRect(wall: WallFace, x: number, z: number, width: number, sill: number, height: number): [Vec3, Vec3] {
  const half = width / 2;
  const y1 = sill + height;
  if (wall === "front" || wall === "back") return [[x - half, sill, z], [x + half, y1, z]];
  return [[x, sill, z - half], [x, y1, z + half]];
}

function uniqueSorted(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const value of sorted) {
    const last = out[out.length - 1];
    if (last === undefined || value - last > 1e-9) out.push(value);
  }
  return out;
}
