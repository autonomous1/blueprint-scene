**Task: 02 blueprint-scene: derive places from floors + rooms (no new Inkscape `places` layer)**

### Problem
Repo: **blueprint-scene**. Base it on the current source: the Drive copy `dev/blueprint-scene/src`, 19 Oct 20:32 (has `parseLocked`/`parseKey`/`doorElevation`). Depends on: 00 (blueprint-scene published ≥ 0.1.2), and the existing R6/R7 floors + room bake path.

**Do not change the kernel (conveyor-engine-packages).**

Bots need a scene graph of *places* (rooms, halls, platforms) so they can plan routes. The earlier draft of this task required a new Inkscape `places` layer with `building:` / `floor:` groups and hand-drawn `room:` / `hall:` / `platform:` polygons. That fights the layouts you already have:

| Authoring today | Role |
|---|---|
| `arena-1.svg` (scene) | Bounds, building placements, scene doors/props/spawns |
| `<model>.floors.svg` (per building model) | `floor-N` layers with footprint stencil + `model:<room>` instances; `doors-external`; `stairs-external` |
| `<prefab>.room.json` / room SVG | Footprint, wall doors, props, lights |

Re-drawing all of that into one `places` layer would block later **automated layout**: footprint + room/stair/elevator kit → floor plan → same floors SVG + room instances → same graph. Places must be **derived** from those files, then **linked** by spatial analysis (doors, openings, stairs). Linking portals is task **04**; this task only builds `ScenePlace[]`.

Today `readScene` collects buildings, bounds, props, spawns and doors. R6/R7 already know floors, room instances and external doors. Nothing yet emits walkable places.

### Required change
1. **New module** `src/places.ts` (name OK if clearer):  
   `derivePlaces(input): { places: ScenePlace[]; warnings: string[] }`  
   Inputs (all already produced or readable today — do not invent a scene `places` layer):
   - Scene building placements (from `readScene` / bake)
   - For each building whose model has a floors file: `FloorsSource` from `readFloorsSvg`
   - For each room instance prefab: `RoomFile` footprint (from `--rooms` / `.room.json`)

2. **Emit places** (sorted by `id`):
   - **Room.** One place per floors room instance.  
     - `id`: `${buildingPlacementId}.${instanceId}` (same id scheme as R7 room placements).  
     - `kind: "room"`.  
     - `building`, `floor` (`"1"`, `"2"`, … from `floor-N`), `y` = that floor’s world elevation (placement y + floor elevation).  
     - `polygon`: room footprint rectangle in **world** XZ (instance center + yaw + drawn/footprint width×depth; prefer `.room.json` footprint when present, else the floors rect). Counter-clockwise.  
     - `bounds` from the polygon.
   - **Hall (circulation).** One place per floor that has a footprint stencil.  
     - `id`: `${buildingPlacementId}.floor-${n}.hall`.  
     - `kind: "hall"`.  
     - `polygon`: building footprint on that floor in world XZ **minus** the room footprints on that floor (AABB or simple polygon difference is enough for v1; if difference is empty or degenerate, emit the full footprint and a warning).  
     - Same `building` / `floor` / `y` rules as rooms.
   - **Platform.** Optional in this task: only if a floors element is already labelled `platform:<id>` (rect/path) or a floor has `data-kind="platform"` — do **not** require authors to add a new top-level layer. If none exist, `places` simply has no platforms. `data-height` adds to floor `y` (deck above the floor).
   - **Stairs / elevator** kinds exist on the type but are **not** filled here (task 03, from `stairs-external` / elevator markers).

3. **Id uniqueness.** Place ids must not collide with each other or with door/placement ids (`claimPlacementId` or the bake’s duplicate check). Duplicate → `PlanError`.

4. **Wire into plan/bake without a `places` layer.**  
   - `PlanScene` gains `places: ScenePlace[]` (default `[]`).  
   - Prefer computing places in bake (or a `derivePlaces` call from bake) once floors + rooms are loaded — **not** inside `walk()` looking for `layer === "places"`.  
   - A scene with no floors files → `places: []` (byte-stable with today’s outputs aside from the new empty field if you expose it on `PlanScene` only in memory; **do not** write `scene-graph.json` yet — that is task 04).

5. **Ignored / hidden.** Same as R6: `ignore` skipped; hidden floor layers still count.

### Implementation note
```ts
// src/types.ts
export type PlaceKind = "room" | "hall" | "platform" | "stairs" | "elevator";
export type ScenePlace = {
  id: string;
  kind: PlaceKind;
  building?: string;
  floor?: string;
  /** Walkable elevation in world metres (y). */
  y: number;
  /** World XZ polygon, counter-clockwise. */
  polygon: Array<[number, number]>;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
};

// src/places.ts — sketch
export function derivePlaces(args: {
  buildings: Array<{ id: string; model: string; position: Vec3; yaw: number; scale: number }>;
  floorsFor: (model: string) => FloorsSource | undefined;
  roomFileFor: (prefab: string) => RoomFile | undefined;
}): { places: ScenePlace[]; warnings: string[] } {
  // for each building with floors:
  //   for each floor:
  //     push hall from footprint − rooms
  //     for each room instance: push room from footprint at instance pose
}
```

World pose must match R7 (`rooms-bake` building-local → world). Reuse `transformXz` / `placeBox`; do not fork a second transform convention.

### Acceptance
- `test/places.test.ts` (node:test, `npm test` in blueprint-scene):
  - Inline floors SVG: one building placement, `floor-1` (z absent → y 0) and `floor-2` (`z="2.75"`), each with a footprint stencil and one `model:room-b` instance; stub `RoomFile` footprint 4×3.  
    Expect `places` sorted by id containing:
    - two `room` places with correct `building`, `floor`, `y` (0 and 2.75), and world polygons matching instance pose
    - two `hall` places whose polygons contain the footprint and do not cover the room interiors (point-in-polygon checks)
  - Unknown / missing room prefab when an instance exists → clear error (same spirit as R7).
  - Duplicate place id → `PlanError`.
  - No floors file → `places: []`.
  - Optional: one `platform:roof-1` with `data-height="0.2"` on floor-2 → `y === 2.95`.
- Existing tests (`test/bake.test.ts`, `test/doors*.test.ts`, `test/plan.test.ts`, floors/rooms tests) pass. No new Inkscape layer required in arena SVGs.
- **Do not** write `scene-graph.json` or change door/portal linking (04). **Do not** implement stairs/elevator places (03). **Do not** change the kernel.

### Out of scope / later
- Door ↔ place portals and openings by probe (task **04** — spatial analysis of door leaf vs place polygons).
- Stairs/elevator places from `stairs-external` (task **03**).
- Arena load / route search (05+).
- Generative layout that *writes* floors SVGs — only keep the derive API stable so a generator can feed the same inputs later.

### Authoring note (for humans and future generators)
Keep using `arena-1.svg` + `<model>.floors.svg` + room prefabs. Do **not** migrate geometry into a monolithic `places` layer. A layout tool should emit floors + room instances; `derivePlaces` turns that into the graph nodes.
