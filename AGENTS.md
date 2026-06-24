# AGENTS.md

This file provides guidance to Codex (and other coding agents) when working with code in this repository.

## Project Overview

Citynista is a web-based city planning tool prototype: draw street networks with multiple road types, shape them with bezier curves, and render them in a flat-shaded 2D top-down map style. The medium-term goal is procedurally generating buildings, vegetation, and other content inside the city blocks the road network encloses. OpenStreetMap import was prototyped and shelved — the public data proved too low-quality (noisy geometry, disconnected segments, sidewalks modeled as separate ways) to render cleanly, so the project drives its own drawn networks instead. Snappy editing is prioritized over high-fidelity rendering.

## Tech Stack

- **Framework**: SvelteKit with Svelte 5 (using runes: `$state`, `$effect`, `$derived`)
- **Runtime**: Bun (use `bun` commands, not `npm` or `node`)
- **Rendering**: Three.js (WebGL, orthographic top-down camera on the XZ plane)
- **Geometry**: clipper-lib for polygon booleans/offsets (typed in `src/types/clipper-lib.d.ts`)
- **Styling**: Tailwind CSS v4
- **UI Components**: bits-ui, shadcn-svelte components

## Development Commands

- **Start dev server**: `bun run dev` (runs Vite dev server with HMR)
- **Build for production**: `bun run build`
- **Preview production build**: `bun run preview`
- **Type check**: `bun run check`
- **Lint & format**: `bun run quality` (runs format, lint, and check)
- **Format code**: `bun run format`
- **Lint code**: `bun run lint`
- **E2E tests**: `bun run test` | `bun run test -- -g 'partial name of test'`

## Architecture

### Coordinate System

The world is 2D on Three.js's XZ plane: graph coordinates are `(x, y)` where `y` is stored in the mesh's `z`. The camera is orthographic looking straight down; layers separate by small Y offsets. `SceneManager.screenToWorld()` converts pointer positions.

### Core State Management

1. **Editor** (`src/lib/editor.svelte.ts`): Top-level controller
   - Owns the graph, scene, renderers, and mode switching (draw, select)
   - Tracks selection state (`selectedNodes`, `selectedSegments`)
   - `rebuildRoads()` re-renders the network; `resolveSegmentCrossings()` planarizes overlaps
   - Undo/redo (⌘Z/⇧⌘Z, toolbar buttons): whole-graph snapshots captured via `graph.onSaved` — one save equals one undo step, so every operation that persists (draw click, finished drag, lane tweak, delete, fixture load) is undoable with no per-command code
   - Provides context via `setEditorContext()` / `getEditorContext()`

2. **Graph** (`src/lib/core/graph.svelte.ts`): Data model
   - Nodes and segments in `SvelteMap`s; saves to localStorage explicitly via `save()`
   - **Node** (`src/lib/core/node.svelte.ts`): position + connected segment ids
   - **Segment** (`src/lib/core/segment.svelte.ts`): start/end node ids, optional quadratic bezier control point (`controlX`/`controlY`), and an owned ordered lane stack (`lanes`: role vehicle/pedestrian/buffer, surface asphalt/concrete/grass/curb/paint, width, direction). `lanesKey` is the serialized form used in piece hashes and cross-section equality checks. Legacy saves with `laneTemplateId` and old lane `type` values migrate on load.

3. **Lane layers** (`src/lib/core/lane-types.ts`): lanes store function (`role`) separately from material (`surface`). `laneLayer()` derives the render layer (`pavement` / `grass` / `asphalt` / `concrete` / `paint` / `curb`), and every rendering/connection rule is keyed to that layer's **surface class** (`roadway` / `island` / `verge` / `walkway`), never the role or material name. Roadways flow into each other across transitions (material changes are a color seam), islands continue into other islands, verges cut square, walkways render via the pavement plate. `paint` is a dormant flush buffer layer in this slice.

4. **Lane templates** (`src/lib/core/lane-template.ts`): presets (Street, Avenue, Highway, Path). Drawing or "apply preset" copies a template's lanes onto the segment via `createLanesFrom()` — segments never share lane arrays.

5. **Lane editor** (`src/lib/components/LaneEditor.svelte`): a docked side panel that appears whenever one or more segments are selected, so edits preview live on the map. Segments with identical cross-sections are edited together; mixed selections can only be overwritten with a preset. Edits lanes in place — add/remove/reorder, function, material, width, vehicle direction, lane markings — re-rendering and saving on every change. Mode keyboard shortcuts only fire when the event target is `<body>`, so typing in panel inputs never hits Delete/Escape handlers.

### Road Geometry (`src/lib/core/road-geometry.ts`)

How a node renders is decided by its **connection pair** (`connectionPair`): road-bearing segments outrank paths, so two roads continue through a node — median, grass center and all — no matter how many paths attach; each attached path joins with a straight pavement apron (`addApron`) under the roadway instead of forcing a junction. A node is a **junction patch** (`isPatchNode`) only when its counted arms (road-bearing if ≥2, otherwise all) number 3+ — pairs are never junctions. Among 3+ road nodes, a **merge node** (`mergeInfo`) carves out an exception: when a near-collinear same-section pair exists and every other road arm is narrower and joins at a shallow angle (≤ ~57°), the pair acts as a **through road** — never trimmed (only its own bend fillet applies), its strips running through uninterrupted like any continuation — while each merging arm stops at its 1/sin trim and lands on the through road's flank with a **gore** (`addGore`): tangent corner curves from both mouth corners onto the through roadway edge enclose an asphalt wedge, with a slim plate rim around it (the same curves from the mouth's full width) continuing the merger's sidewalks along the gore until they merge into the through sidewalk — the rest of the pocket stays green; gore edges tuck slightly under the through ribbon against antialiasing hairlines. Two extra arms that continue each other are a crossing, not two ramps, and keep the node a regular junction — so 4-way crossings never reclassify. At patches every counted arm is trimmed to a stop line (`computeIntersectionTrims`): far enough that its mouth clears every crossing arm's edge plus a fixed gap (reserved for future crosswalks) — for shallow angles the pullback grows with 1/sin of the crossing angle, but only for arms no wider than the one they're clearing; paths always pull back from roads, roads never yield to paths. An asphalt patch connects the road-bearing mouths with corner curves; one solid pavement plate polygon (every mouth joined by outer corner curves) seals the junction interior. Grass never enters a junction — verges stop square at their stop lines. Every bending pair gets an angle-proportional **fillet**: both segments pull back by `pairFilletTrim` (R·tan(θ/2), R = 4× the node half-width, capped at the old sharp-corner trim) and `addPairJoin` runs the node cross-section through the gap as corner bands (`addCornerBands`) — every lane turns on curves at any angle, with no sharpness threshold anywhere. A pair with _different_ cross-sections forms a **transition node** at _any_ angle, rendered by **morphing inside the segment ribbons** — there is no separate transition piece. The **narrower segment anchors** the node cross-section (tie-break: lane-stack key): it stays untouched, and only the wider side necks down to meet it — one monotone taper, no waviness. `transitionMorph` computes the wide side's target offsets per lane interval (matched strips morph to the anchor strip's offsets; the roadway falls back to the anchor's bounding span when the carriageway count changes; center strips match across types so a grass center tapers to a median; unmatched strips end square). Both segments compute the same blended cross-section, so their ribbons meet at the node vertex-for-vertex and the taper follows the road's actual curvature; `buildStrip` interpolates offsets with a smoothstep ease that completes a short margin before the node (so the bend zone has a constant cross-section and renders like a same-road bend), inserting vertices through the zone so straight 2-sample segments taper exactly. Strips with no counterpart end in a square cut where the morph begins — never a sliver. Bent transitions get the same fillet treatment as same-type bends, with the corner bands carrying the anchor cross-section both ribbons have morphed to by their mouths. Nothing ends rounded: every strip terminates square — at transitions all strips (matched or not) ride the taper to the seam line (an unmatched island pinches toward its centerline and ends square once squeezed below a usable width — a wind-down nose; unmatched verges cut square where the morph begins), and at junction stop lines everything stops flush with the patch. `buildNodeLayers` applies the same junction-disc curb rounding as the full build — without it, slivers between patch, corner bands, and mouths leak the ground color.

Layers render bottom-up in the derived road-layer order (`pavement` doubles as the full pavement plate; `curb` on top). Upper layers visually carve the lower ones, so overlapping geometry composes without booleans. There is deliberately no outline/casing around roads — only the lane colors themselves render.

Two construction paths:

- `buildNodeLayers(graph, node, centerlines)`: Clipper-based junction geometry scoped to one node's arms.
- `buildRoadLayers(graph)`: full-network build through the same pipeline — used only for the draw-mode ghost preview and debugging.

**Earcut caveat**: never hand `THREE.ShapeGeometry` a polygon with holes — it intermittently mis-triangulates. `pathsToPolygons` shrinks by an epsilon and decomposes holed polygons into simply-connected pieces; keep that invariant for any new geometry.

### Blocks (`src/lib/core/blocks.ts`, `src/lib/rendering/block-renderer.ts`)

City blocks are the enclosed faces of the road graph: half-edges traced by always turning onto the next arm around each node (bezier-aware tangents), interior faces kept by winding sign, dead-end slits and sub-minimum faces dropped. A block's interior is its face polygon minus every nearby road ribbon and node disc (Clipper difference, all paths positively oriented), so it hugs the outer edge of any road regardless of width or curvature — including roads fully inside the block. Blocks render as a slightly lighter ground fill below the lane layers, cached per face by a boundary-geometry signature so the Clipper work only reruns for faces whose boundary actually changed.

### Rendering (`src/lib/rendering/`)

- **`road-renderer.ts`**: piece-based incremental renderer. `update(graph)` caches one piece per segment and per node, keyed by a hash of its inputs; only changed pieces rebuild (segments are cheap analytic ribbon strips — no Clipper/earcut; nodes use `buildNodeLayers`). Ribbons overlap node pieces slightly to avoid hairline cracks; tiny per-piece elevations prevent z-fighting. `render(layers)` is the one-shot path for the ghost preview. Segment pieces also carry **lane paint**: dashed white stripes between same-direction travel lanes and solid muted yellow between opposing flows — drawn on the lane boundaries (which may sit inside a merged same-type interval), following transition morphs proportionally within their interval's target, cutting where a boundary stops existing at the node, and stopping short of junction mouths. Junction patches paint continental crosswalks across every road mouth (in the gap the trims reserve), paths crossing a continuing road get a zebra centered on the node, and each incoming vehicle lane at a stop-line junction carries one combined arrow glyph for its active left/through/right movements. **Performance contract: editing cost must stay proportional to what changed, not map size** — new geometry features must be expressible per-segment or per-node (or extend the piece hashes).
- **`node-renderer.ts`**: node rings sized to the widest road at the node (the editor syncs radii in `rebuildRoads`), toned blue when revealed by hover, yellow when part of a selection. Nodes stay hidden in every mode except "revealed" ones — selection endpoints and the node under the cursor; hovering a segment shows its ribbon highlight and reveals its endpoint rings. In draw mode the snap feedback comes from the cursor ring, not from node markers.
- **`selection-renderer.ts`**: segment highlights — translucent full-width ribbon with round end caps matching the node rings — blue for hover, yellow with a solid stroke for selection (blue = hover, yellow = selected everywhere in the editor; fills use `LessDepth` so same-elevation overlaps never double-blend). Selection adds yellow dashed bezier guides and a yellow diamond curvature handle.
- **`scene.svelte.ts`**: scene, orthographic camera, zoom (wheel), pan (space+drag, alt+drag, or middle mouse), FPS reporting.

### Modes (`src/lib/modes/`)

Each mode returns `ModeHandlers` (`onMouseDown`, `onMouseMove`, `onMouseUp`, `onKeyDown`, `cleanup`). Select is the always-on default; draw mode is entered by picking a preset in the toolbar (click or number keys). Draw mode has three styles (toolbar segmented control, Tab cycles): **straight** click-click, **curved** start/apex/end (the apex click is the quadratic control point), and **smooth** chaining (each segment's control auto-solves on the continuation tangent of the road it extends — perpendicular-bisector intersection, falling back to straight past ~84°). Holding Shift snaps the pending direction to 22.5° increments or exactly onto the continuation tangent when closer; positional snaps (nodes, segments) always win over angle snaps. The editor's mode `$effect` deliberately `untrack`s `setupMode` so selection changes don't re-trigger it.

- **draw.ts**: click-to-draw with a translucent ghost preview of the pending road. Snaps to nodes and to segments (splitting them into T junctions on click). Escape is two-stage: first cancels the pending segment (removing an unused start node), second returns to select mode.
- **bulldoze.ts**: click demolishes a node (with its segments) or a segment; dragging from open ground draws a red marquee demolishing everything contained. Deletion routes through the selection, so orphan cleanup, saving, and undo match Delete in select mode. There is deliberately no whole-map delete button; nuking everything means marquee-bulldozing it (undoable). Shared hit/marquee picking lives in `modes/picking.ts`.
- **select.ts**: the default mode. Click selects a node or segment; shift+click toggles nodes/segments in the selection; dragging from empty ground draws a marquee selecting contained nodes and fully-contained segments; dragging a path moves the selected segments rigidly; the curvature handle with shift snaps to the nearest perfect curve among every neighbor tangent at both endpoints — ray intersections and single rays — or straight near the chord, so dragging the other way catches the next neighbor's tangent; shift-dragging a selected node near the collinear line snaps onto it and straightens (any node onto the nearest line between two of its far endpoints — junctions and merge nodes straighten their through road while other arms follow; a dangling end onto the continuation of the road at its far node); away from the line a two-segment node re-solves both controls every frame so the road stays perfectly tangent through it (shift+click without dragging still toggles selection, deferred to mouseup). Control points keep their relative position when endpoints move. Delete/Backspace removes the selection. Selecting a single segment also opens the lane editor panel.

### Planarization (`src/lib/core/crossings.ts`)

After drawing (and only then — moving segments in select mode never splits), `resolveCrossings` finds mid-span segment crossings and splits both segments at a shared new node, creating a real intersection. Curved segments split via de Casteljau, preserving their exact shape. Crossings near existing endpoints are skipped, which guarantees termination.

### Fixtures (shared ground truth)

`static/fixtures/*.json` are named graph snapshots (the `graph.toJSON()` shape) — the single source of truth shared between a browser session, the e2e harness, and anyone editing the repo. Booting with `/?fixture=<name>` loads one into the live graph (works in dev **and** preview builds, since fixtures are static assets). In dev, a fixture bar (bottom-left) lists/cycles/reloads fixtures and saves the current graph under a name via the dev-only `PUT /api/fixtures/<name>` route, which writes straight into `static/fixtures/` — editing a fixture file on disk triggers a full page reload in dev, so file edits appear in the browser immediately. Workflow for visual bugs: reproduce in the browser → save as a fixture → fix against that exact graph → screenshot it headlessly (Playwright `page.goto('/?fixture=<name>')`) → reload in the browser to confirm.

## Testing Guidelines

- **Never use `waitForTimeout()` in tests** - rely on Playwright's default timeouts and auto-waiting
- Use positive and negative assertions to wait for things (e.g., `await expect(element).toBeVisible()`, `await expect(element).not.toBeVisible()`)
- Playwright automatically waits for elements to be actionable before performing actions
- For pointer interactions, world→screen at the default camera is `screen = center + world * (720 / 500)` at a 1280×720 viewport; wheel zoom multiplies by 1.1 per step and anchors at the viewport center
- Hit areas are the geometry itself — a node's ring, a road's half width — with a screen-pixel floor (via `sceneManager.worldPerPixel()`) for when geometry is smaller than a finger: zoomed in the whole road body is hoverable, zoomed out targets keep a clickable minimum; inside a node's ring the node always wins, and the visible gap between rings picks the segment
- Geometry can be debugged headlessly: `buildRoadLayers` runs under `bun` with a duck-typed graph (see git history for SVG-dump debug scripts)

## LLM Instructions

- never run the dev server, assume the user is already running the dev server
- always use strict typesafety, never use any, don't add return types, always rely on inference
- use Svelte 5 runes (`$state`, `$effect`, `$derived`) instead of legacy reactivity
- use `SvelteMap` and `SvelteSet` from 'svelte/reactivity' for reactive collections
- never commit, push, or create branches — leave all changes in the working tree for review
- match the surrounding comment density: this codebase explains its geometry rules in prose comments; keep that where you touch it, but don't add narration to obvious code
- verify changes with `bun run check` (and the relevant `bun run test -- -g '...'` when behavior changes); the performance contract above (per-piece hashes, cost proportional to what changed) is binding for any geometry/render change
