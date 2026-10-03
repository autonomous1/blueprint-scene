import type { Triangle, Vec3 } from "../src/types.ts";

/** Closed box as two triangles per face, the shape a wall mesh would have. */
export function trianglesFromBox(min: Vec3, max: Vec3): Triangle[] {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const a: Vec3 = [x0, y0, z0];
  const b: Vec3 = [x1, y0, z0];
  const c: Vec3 = [x1, y0, z1];
  const d: Vec3 = [x0, y0, z1];
  const e: Vec3 = [x0, y1, z0];
  const f: Vec3 = [x1, y1, z0];
  const g: Vec3 = [x1, y1, z1];
  const h: Vec3 = [x0, y1, z1];
  return [
    [a, b, c], [a, c, d],
    [e, h, g], [e, g, f],
    [a, d, h], [a, h, e],
    [b, f, g], [b, g, c],
    [a, e, f], [a, f, b],
    [d, c, g], [d, g, h],
  ];
}

export function trianglesFromWalls(walls: Array<{ min: Vec3; max: Vec3 }>): Triangle[] {
  return walls.flatMap((wall) => trianglesFromBox(wall.min, wall.max));
}
