export type Vec3 = [number, number, number];

/** Quarter-turn about +Y, in degrees. See `transformXz`. */
export type Yaw = 0 | 90 | 180 | 270;

export type Placement = {
  id: string;
  model: string;
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
 * The obstacle is the rectangle, not the model footprint.
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
