Read agents/AGENTS.md first. Then this file. Then agents/codemap.md only for symbols in the Files table.

**Do not read** `~/.grok/memory-v2/`, `~/.grok/memory/`, `~/.grok/bundled/skills/`, or any other Grok memory / topic / skill file.
**Do not open** `../conveyor-engine-packages` unless the Files table names a path there.
**Codemap:** at most one exact-symbol search from the Files table, then open that source file. Do not scroll or re-open codemap.md.

**Repos:** scale / measure / stencil / bake in `/home/tim/dev/blueprint-scene`. Re-bake in `/home/tim/dev/conveyor-engine-arena`. Do not change conveyor-engine-packages. Do not read `~/.grok/memory-v2`.

**Task: D14 — Building placement scale must equal floors stencil scale (follows D13)**

### Problem
User replaced the building-2 GLB (dual Tripo+cube export fixed per D13), re-ran measure, and updated **both** the floorplan SVG and the scene SVG with the **same scaled stencil, identical dimensions in each SVG**. Bake now aborts:

```
rooms-bake.ts line 185
building "brutalist-building-2-cbake" scale 29.249488 differs from brutalist-building-2-cbake.floors.svg scale 29.999998 (mesh 28.893114×13.230878 m, footprint 29.634478×12.891389 m)
Process exited with code 1
```

### Numbers (derive, then verify in code)
- Mesh unit extent X = 28.893114 / 29.249488 ≈ **0.98782**; footprint X / floors scale = 29.634478 / 30 ≈ **0.98782** → X agrees: X alone gives scale **30.000**.
- Mesh unit extent Z = 13.230878 / 29.249488 ≈ **0.45235**; footprint Z / 30 ≈ **0.42971** → Z disagrees ~5%: Z alone gives 12.891389 / 0.45235 ≈ **28.498**.
- (30.000 + 28.498) / 2 ≈ **29.249** = the reported placement scale. So `scaleForPlacement` is **averaging per-axis X/Z fits**, and the Z input (mesh depth vs stencil/footprint depth) comes from different measures.

Likely causes to confirm (do not guess — log each value): the new GLB's Z extent (0.452) includes detail the stencil depth (0.430) does not (or vice versa); measure stencilWidth/Depth stale vs new GLB; drawn size read from the scene stencil path vs the floors matrix; or stencil group pose/scale on one side only.

### Required
1. Trace both sides for building-2: scene side (`plan.ts` stencilPose/drawn → `bake.ts` scaleForPlacement, per-axis x/z) and floors side (`floors-svg.ts` matrix scale, footprint). Print measure extent, stencil w×d, drawn w×d, per-axis scale, final scale, floors.scale.
2. Fix so placement scale matches floors.scale within the **existing** epsilon. If the scene uses a copied measure stencil group with a transform, **prefer group origin + uniform scale** (floors uses ~30) over drawn/extent divide. Do not average mismatched per-axis scales silently; if x vs z disagree beyond epsilon, warn with the source of each.
3. Only change the epsilon if you prove one side is still fed by the wrong measure — and fix that feed instead.
4. Make the error's mesh/footprint numbers consistent (same measure extent on both; mesh ≈ footprint after fix).
5. Spot-check building-1 (was warning x 28.578 vs z 29.99) and building-3 (29.890) through the same path.
6. Tests: matching stencils in scene + floors → equal scales; mismatched per-axis → explicit warn/error. `npm test`, typecheck; arena `bake:scene` / `bake.sh`.

### Acceptance (hard gate)
- Bake succeeds; no rooms-bake.ts:185 throw for building-2.
- Bake line shows scaleForPlacement ≈ floors.scale (~30) for building-2; building-1/3 reported.
- No room scale 0.9 hack. Play-check steps vs facade is nice-to-have; report numbers if available, but bake success is the gate.

### Out of scope
D12 room-a.open, D9/D10, hollow, z-fight.

### Files (read only these)
| File | Repo | Use |
|---|---|---|
| `src/rooms-bake.ts` (~line 185 scale check) | blueprint-scene | Throws when building placement scale ≠ floors.svg scale. |
| `src/bake.ts` `scaleForPlacement` / pose / meshLine | blueprint-scene | Per-axis sx/sz average → 29.249; log each input. |
| `src/plan.ts` stencilPose / drawnWidth / drawnDepth | blueprint-scene | How scene stencil group vs rect becomes drawn size / optional group scale. |
| `src/stencil.ts` `stencilBoxes` / `stencilSize` | blueprint-scene | Mesh extent fed into placement scale (Z ~0.452 vs footprint depth ~0.430). |
| `src/floors-svg.ts` | blueprint-scene | Floors matrix scale (~30) and footprint metres. |
| `src/measure.ts` (if re-measure still wrong) | blueprint-scene | Stale measure vs new GLB. |
| `test/bake.test.ts` / floors / rooms-bake tests | blueprint-scene | Matching stencils → equal scales; mismatched axes warn. |
| Scene `arena-1.svg` building-2 stencil | arena | Same scaled stencil as floors (user already matched dimensions). |
| `brutalist-building-2-cbake.floors.svg` | arena designs | Floors scale ~30; stencil identical to scene. |
| GLB `brutalist-building-2-cbake.glb` | arena assets | Post-D13 replacement mesh. |
| `web/game/buildings.placements.json` | arena | Baked scale after fix. |
| `scripts/bake.sh` / `npm run bake:scene` | arena | Re-bake until rooms-bake passes. |
