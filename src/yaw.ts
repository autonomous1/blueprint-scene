import type { LocalBox, Vec3, Yaw } from "./types.ts";

/**
 * Yaw is degrees about +Y, right-handed: the same turn as Three.js
 * `Object3D.rotation.y` and a glTF quaternion about +Y.
 * 0 leaves model axes in place. 90 sends model +X to world −Z and model +Z to world +X.
 * Placements only use 0, 90, 180, and 270 (`yawConvention: "y-up-90"`).
 */
export function transformXz(x: number, z: number, yaw: Yaw): { x: number; z: number } {
  switch (yaw) {
    case 0:
      return xz(x, z);
    case 90:
      return xz(z, -x);
    case 180:
      return xz(-x, -z);
    case 270:
      return xz(-z, x);
  }
}

/** `0 === -0`, and JSON keeps a signed zero as 0. The placement math should too. */
function xz(x: number, z: number): { x: number; z: number } {
  return { x: x === 0 ? 0 : x, z: z === 0 ? 0 : z };
}

/** Model-space AABB to world AABB. Yaw turns XZ; Y is unchanged. */
export function placeBox(box: LocalBox, position: Vec3, yaw: Yaw): { min: Vec3; max: Vec3 } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const x of [box.minX, box.maxX]) {
    for (const z of [box.minZ, box.maxZ]) {
      const world = transformXz(x, z, yaw);
      if (world.x < minX) minX = world.x;
      if (world.x > maxX) maxX = world.x;
      if (world.z < minZ) minZ = world.z;
      if (world.z > maxZ) maxZ = world.z;
    }
  }
  return {
    min: [minX + position[0], box.minY + position[1], minZ + position[2]],
    max: [maxX + position[0], box.maxY + position[1], maxZ + position[2]],
  };
}
