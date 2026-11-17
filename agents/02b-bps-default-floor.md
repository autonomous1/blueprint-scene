**Task: 02b blueprint-scene: default walkable floor for upper levels (collision + textured mesh)**

### Problem
Repos: **blueprint-scene** (main) and **conveyor-engine-arena** (re-bake / asset URI). Depends on: **02** (places / hall = footprint − rooms) and the existing R6/R7 floors + rooms bake.

**Do not change the kernel (conveyor-engine-packages).**

Task **02** derives hall places from unused floor area. It does **not** put geometry under the pawn. In play, **floor-1** can stand on the arena ground, but **floor ≥ 2** has nowhere to walk in the hall: room instances keep their own `floor.*` slabs (R4/R7), and R7 drops only ground-floor room slabs (`maxY ≤ 0.05`). The circulation between rooms on an elevated floor is empty air.

### Required change
1. **Default floor slab (collision)** during rooms/floors bake, for every building that has a floors file:
   - For each floor whose elevation (world y after placement) is **> 0.05** (i.e. not the ground floor that uses arena ground):
     - Build a thin AABB slab covering the **hall polygon** from 02 (building footprint minus room instance footprints on that floor). If 02’s hall polygon is unavailable, footprint AABB minus room AABBs is enough for v1.
     - Slab thickness `FLOOR_T = 0.1` (same as room floors): world y `[elevation − FLOOR_T, elevation]`.
     - Id: `${buildingPlacementId}.floor-${n}.slab` (or `.hall.floor`). Merge into the bake’s obstacle list / `rooms.placements.json` obstacles (or buildings obstacles — pick one place and document it; prefer rooms output so building hollow stays separate).
   - Ground floor (`elevation ≤ 0.05`): **do not** emit a default slab (keep today’s “stand on arena ground” behaviour).
   - Room interiors already have `floor.*` from the room file — do **not** double-stack a hall slab under the room footprint (subtract room footprints from the slab, same as hall places).

2. **Default floor mesh (visual)** so the hall is visible, not only collidable:
   - Emit one textured quad (or low-poly mesh) per elevated floor hall, same XZ as the collision slab, y = elevation (or slightly below to avoid z-fight with room floors — e.g. elevation − 0.001 outside rooms only).
   - **Texture from Inkscape (preferred):** on each `floor-N` layer of `<model>.floors.svg`, allow an optional image (or rect with linked/embedded image) labelled `floor-texture` (or a child of a group with that label). Bake uses that image as a **tileable** albedo (repeat UVs in world metres — default 2 m per tile, overridable with `data-tile-m` on the image).
   - If no floor-texture is authored, use a repo default (e.g. `assets/floor-default.png` or a solid mid-grey) so elevated halls are never invisible.
   - Write a bake product GLB (or reuse crate/quad writer) and a placement the arena already loads (static model instance), **or** attach the mesh URI on a new lightweight placements field — prefer an existing static-prop / building-child pattern already used for rooms. Document the asset id scheme: `${model}.floor-${n}.hall` shared per model if all placements share floors (static instance), same as building cuts.

3. **Authoring note (floors SVG):**  
   Keep footprint + room instances as today. Optional: drop a tileable JPEG/PNG on the floor layer, label `floor-texture`, set `data-tile-m` if needed. No new top-level Inkscape layer required.

4. **Arena:** `npm run bake:scene` picks up the new slabs + mesh. No kernel change. Manifest/assets only if a new model URI must be listed (same pattern as room / cut building assets).

### Implementation note
```ts
// sketch — after room instances are posed for floor F
if (F.elevation > 0.05) {
  const hallPoly = footprintMinusRooms(F); // same geometry as derivePlaces hall
  obstacles.push(slabFromPolygon(hallPoly, F.elevation, FLOOR_T, id));
  meshes.push(texturedHallFloor(hallPoly, F.elevation, texture, tileM));
}
```
Reuse R7 pose helpers. Cut door openings out of the **visual** hall floor only if an external door’s clear volume intersects the slab in XZ at that elevation (optional v1: skip mesh cut if collision already allows walking through; prefer no thin ledge blocking the doorway).

### Acceptance
- `test/default-floor.test.ts` (blueprint-scene): floors SVG with `floor-1` (z absent) and `floor-2` (`z="2.75"`), one room instance on each.
  - No default slab / hall mesh for floor-1.
  - Floor-2 emits one slab obstacle at y ≈ 2.65..2.75 whose XZ covers the footprint minus the room, and a textured hall mesh (or GLB) with the same footprint rule.
  - With a `floor-texture` image on floor-2, the mesh material references that image (or baked KTX2/PNG copy); without it, the default texture is used.
- Re-bake arena: in play, walk the upper-floor hall outside room-b without falling; room interior still uses room floor; ground floor unchanged.
- Existing bake / rooms / door tests still pass. Places from 02 unchanged in meaning (hall still footprint − rooms).

### Out of scope
- Stairs/elevator meshes (03).
- Scene-graph portals (04).
- Generative layout (later).
- Replacing room `floor.*` textures inside prefabs.

### Do not
Change the kernel. Do not require a monolithic `places` layer. Do not put a full-building slab that seals exterior door gaps (subtract openings or keep slab only in hall XZ).
