# Render-derivation refactor

Goal: stop deriving markings and junction geometry from the lane **type enum** with
per-case special-casing. Derive them from one model: the **cross-section structure +
lane connectivity**. Material and access never affect geometry — only colour and
markings. This kills a cluster of carried-over bugs (material seams, transition centre
stubs, merge-gore tangles) and is the foundation for the lane-centric north star
(types become presets over role / material / access / mode).

Keep: analytic ribbon strips, Clipper infra, the lane-connectivity model
(`lane-connections.ts`), the piece-cached renderer, blocks, the fixtures.
Replace: the *derivation* — how type maps to geometry, transitions, and paint.

## The model (types become presets)

A lane keeps its `type` field as a **preset selector**. The lane-types table is the
single decoder from `type` to:

- **role** — `drivable | walkable | island | verge` (today's `surface`). Drives ALL
  geometry and transition decisions.
- **material** — `asphalt | concrete | grass | pavement | …`. Drives ONLY colour.
- **access** — `general | bike | parking | transit` (today's `accessory`). Drives
  markings + connectivity, never geometry.
- direction, width — as today.

Two keys, used deliberately:
- **structural key** = `role + access + direction + width` per lane (material-agnostic).
  Decides transition-vs-continuity, morph, and junction cross-section matching.
- **piece key** = full `lanesKey` incl. material/colour. Decides renderer cache
  invalidation only (a colour change must rebuild the piece, but is NOT a transition).

## Pillar 1 — role / material / access split (kills bug B: material seams)

- Enrich `LANE_TYPE_SPECS` with explicit `material` (and treat `surface`=role,
  `accessory`=access). `laneColor` derives from material.
- Add `lanesStructureKey(lanes)` (role+access+direction+width, no material).
- Re-key transition/continuity/morph decisions (`isTransitionNode`,
  `isContinuationNode`, `transitionMorph`, and any geometry that currently compares
  `lanesKey`/type) to the **structural** key. Keep `lanesKey` only for the piece hash.
- Generalise `lanePaintBetween`: a "plain travel lane" is `role=drivable && access=general
  && !turn` — drop the `type==='road' || type==='concrete'` name check, so dashed/centre
  lines and seams work for any material.
- Verify: rendering is **identical** except road↔concrete (and any same-structure
  material change) now renders as a continuation — no morph, dividers on both sides,
  no slivers.

## Pillar 2 — single-owned, connectivity-driven markings (kills bug A: centre stubs / false breaks)

- One owner for the centre line and lane lines across **both** segments and nodes
  (today it is split between `buildPaint` and `buildNodePaint`, which strands stubs).
- A boundary's line type derives from the two lanes' roles/access + whether a
  movement crosses/changes there (connectivity) — not from type names.
- A boundary that has no counterpart across a transition is **cut** (honour the
  `null` morph target for the centre too — the current centre exemption is the stub bug).
- `centerCrossedAt` must not false-positive at a plain widening/transition.

## Pillar 3 — uniform junction / transition construction (kills C, D, E, F)

- One construction for patch / merge / transition geometry, replacing the bespoke
  `addGore` / `addMergeNode` / morph / median-continuation special-cases. Mutual
  clipping of overlapping gores; median/island continuation rebuilt on the
  structural model (the reverted grass-median feature lands here, correctly).
- Unify the live `buildNodeLayers` and ghost `buildRoadLayers` paths (bug F).

## Delivery

New branch `render-derivation-refactor` (current). Each pillar ships as
browser-verifiable slices (codex implements to a spec, Claude reviews + headless-verifies
vs `downtown` and `connector-carve-demo`). Each slice deletes special-case code; if a
slice adds a special case, it's wrong. Bug clusters A–F and full context:
see memory `render-derivation-refactor`.
