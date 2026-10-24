export type Vec3 = [number, number, number];

/** Quarter-turn about +Y, in degrees. See `transformXz`. */
export type Yaw = 0 | 90 | 180 | 270;

/**
 * `type` on an asset in `arena.game.json`. `kind` on that asset stays
 * `model` or `texture`. This list is not read from an Inkscape label.
 */
export const ASSET_TYPES = [
  "sky",
  "background",
  "floor",
  "building",
  "door",
  "character",
  "ammo",
  "health",
  "crate",
  "weapon",
  "projectile",
  "key",
  "room",
] as const;

export type AssetType = (typeof ASSET_TYPES)[number];

export type Placement = {
  id: string;
  model: string;
  /** Copied from the asset. Omitted when that asset has no type. */
  type?: AssetType;
  position: Vec3;
  yaw: Yaw;
  /** Uniform scale of the stencil. A 2× enlarge in Inkscape is 2. */
  scale: number;
};

export type Obstacle = {
  id: string;
  kind: "aabb";
  min: Vec3;
  max: Vec3;
};

/**
 * Room rectangle from the Inkscape `bounds` layer, in world metres.
 * `minY` / `maxY` are set only when the rectangle carries `data-min-y` / `data-max-y`.
 */
export type XzBounds = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minY?: number;
  maxY?: number;
};

/** File the manifest points at with `scene.bounds`. Vertical span defaults to −2..12. */
export type BoundsFile = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
};

/**
 * A tagged rectangle on the `props` layer. Position is the center.
 * `scale` is the uniform SVG scale (1 when the rectangle is not scaled).
 * The obstacle is the model bounds when that GLB is loaded, otherwise this
 * rectangle. Neither box is grown by the pawn radius.
 */
export type SceneProp = {
  id: string;
  model: string;
  position: Vec3;
  yaw: Yaw;
  scale: number;
  /** World metres along model +X and model +Z, before yaw. */
  drawnWidth: number;
  drawnDepth: number;
  minY?: number;
  maxY?: number;
};

/** A mark on the `spawn-points` layer. */
export type SceneSpawn = {
  id: string;
  position: Vec3;
  yaw: Yaw;
};

export type DoorHinge = "left" | "right";

/**
 * A rectangle on the `doors` layer, before it is pushed onto a wall.
 * `center` is the rectangle center. `width` is set only by `data-width`.
 */
export type SceneDoor = {
  id: string;
  /** Asset id from `data-model` or the label `model:<id>`. */
  model: string;
  building: string;
  center: Vec3;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  hinge: DoorHinge;
  width?: number;
  height?: number;
  depth?: number;
  open: boolean;
  /** `data-locked="true"`. The arena starts the leaf shut until `key` is used. */
  locked?: boolean;
  /** Pickup placement id from `data-key`. Read when `locked` is set. */
  key?: string;
};

/**
 * One hinged panel. `position` is the hinge on the wall face: the hinge
 * edge of the plan rectangle (left hinge: its local −X end, right hinge: its
 * +X end), pushed onto that face. The arena mounts the GLB origin, which is
 * the hinge, there, so the mesh and the opening start at the drawn
 * rectangle's hinge edge. `size` is `[width, height, depth]` in meters.
 * The width is `data-width`, else the door GLB's panel width, else the
 * drawn span. There is no obstacle.
 * The clear opening is not centered on `position`. A left hinge occupies
 * local x 0..width and a right hinge local x −width..0, from y 0 to `size[1]`.
 */
export type DoorPlacement = {
  id: string;
  /** Asset id, the same string a prop writes. Not a default of "door". */
  model: string;
  /** Copied from the asset. Omitted when that asset has no type. */
  type?: AssetType;
  position: Vec3;
  yaw: Yaw;
  hinge: DoorHinge;
  size: Vec3;
  open: boolean;
  /** When true, the arena starts this leaf shut until `key` is used. */
  locked?: boolean;
  /** Pickup placement id that unlocks a locked door. */
  key?: string;
};

export type DoorsFile = {
  formatVersion: 1;
  units: "meters";
  placements: DoorPlacement[];
  obstacles: [];
};

/** File the manifest points at with `scene.spawnPoints`. `y` is 0. */
export type SpawnPoint = {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: Yaw;
};

export type PlacementsFile = {
  formatVersion: 1;
  units: "meters";
  placements: Placement[];
  obstacles: Obstacle[];
};

/** Model-space wall run. Y is kept for world obstacles and omitted from the collision file. */
export type LocalBox = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
};

export type CollisionBox = {
  id: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

export type CollisionFile = {
  id: string;
  origin: Vec3;
  yawConvention: "y-up-90";
  boxes: CollisionBox[];
};

export type Triangle = [Vec3, Vec3, Vec3];
