# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Citynista is a web-based city planning tool prototype: draw street networks with multiple road types, shape them with bezier curves, and render them in a flat-shaded 2D top-down style similar to Apple Maps or Cities: Skylines. The long-term goal is importing OpenStreetMap graphs and making them editable. Snappy editing is prioritized over high-fidelity rendering.

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
   - Provides context via `setEditorContext()` / `getEditorContext()`

2. **Graph** (`src/lib/core/graph.svelte.ts`): Data model
   - Nodes and segments in `SvelteMap`s; saves to localStorage explicitly via `save()`
   - **Node** (`src/lib/core/node.svelte.ts`): position + connected segment ids
   - **Segment** (`src/lib/core/segment.svelte.ts`): start/end node ids, optional quadratic bezier control point (`controlX`/`controlY`), and an owned ordered lane stack (`lanes`: type sidewalk/grass/road/median, width, direction). `lanesKey` is the serialized form used in piece hashes and cross-section equality checks. Legacy saves with `laneTemplateId` migrate on load.

3. **Lane templates** (`src/lib/core/lane-template.ts`): presets (Street, Avenue, Highway, Path). Drawing or "apply preset" copies a template's lanes onto the segment via `createLanesFrom()` — segments never share lane arrays.

4. **Lane editor** (`src/lib/components/LaneEditor.svelte`): a docked side panel that appears whenever exactly one segment is selected, so edits preview live on the map. Edits the segment's lanes in place — add/remove/reorder, type, width, road-lane direction — re-rendering and saving on every change. Mode keyboard shortcuts only fire when the event target is `<body>`, so typing in panel inputs never hits Delete/Escape handlers.

### Road Geometry (`src/lib/core/road-geometry.ts`)

The intersection model: at nodes with 3+ roads (and 2-segment corners bending sharper than 135°), roads do **not** continue through. Each segment is trimmed back to a stop line (`computeIntersectionTrims`: widest crossing road's half-width + a fixed gap, reserved for future crosswalks); a pavement patch spans the stop lines with corner curves between adjacent arms, and sidewalk bands wrap the corners. Gentle 2-segment bends instead get continuous swept round joins (`addNodeJoins`). Medians and grass end at stop lines.

Layers render bottom-up: `sidewalk` (doubles as the full pavement plate), `grass`, `road`, `median`. Upper layers visually carve the lower ones, so overlapping geometry composes without booleans. There is deliberately no outline/casing around roads — only the lane colors themselves render.

Two construction paths:

- `buildNodeLayers(graph, node, centerlines)`: Clipper-based junction geometry scoped to one node's arms.
- `buildRoadLayers(graph)`: full-network build through the same pipeline — used only for the draw-mode ghost preview and debugging.

**Earcut caveat**: never hand `THREE.ShapeGeometry` a polygon with holes — it intermittently mis-triangulates. `pathsToPolygons` shrinks by an epsilon and decomposes holed polygons into simply-connected pieces; keep that invariant for any new geometry.

### Rendering (`src/lib/rendering/`)

- **`road-renderer.ts`**: piece-based incremental renderer. `update(graph)` caches one piece per segment and per node, keyed by a hash of its inputs; only changed pieces rebuild (segments are cheap analytic ribbon strips — no Clipper/earcut; nodes use `buildNodeLayers`). Ribbons overlap node pieces slightly to avoid hairline cracks; tiny per-piece elevations prevent z-fighting. `render(layers)` is the one-shot path for the ghost preview. **Performance contract: editing cost must stay proportional to what changed, not map size** — new geometry features must be expressible per-segment or per-node (or extend the piece hashes).
- **`node-renderer.ts`**: node discs (amber; blue + enlarged when selected). All nodes show in draw mode; in select mode they stay hidden except "revealed" ones — selection endpoints and the node under the cursor. Hovering a segment highlights its centerline via the selection renderer.
- **`selection-renderer.ts`**: selected-segment visuals — blue bezier centerline, dashed guides, red control-point handle.
- **`scene.svelte.ts`**: scene, orthographic camera, zoom (wheel), pan (space+drag, alt+drag, or middle mouse), FPS reporting.

### Modes (`src/lib/modes/`)

Each mode returns `ModeHandlers` (`onMouseDown`, `onMouseMove`, `onMouseUp`, `onKeyDown`, `cleanup`). Select is the always-on default; draw mode is entered by picking a preset in the toolbar (click or number keys). The editor's mode `$effect` deliberately `untrack`s `setupMode` so selection changes don't re-trigger it.

- **draw.ts**: click-to-draw with a translucent ghost preview of the pending road. Snaps to nodes and to segments (splitting them into T junctions on click). Escape is two-stage: first cancels the pending segment (removing an unused start node), second returns to select mode.
- **select.ts**: the default mode. Click selects a node or segment; shift+click toggles nodes/segments in the selection; dragging from empty ground draws a marquee selecting contained nodes and fully-contained segments; dragging a path moves the selected segments rigidly; the red handle changes curvature (shift snaps tangent-continuous with neighbor roads, or straight near the chord). Control points keep their relative position when endpoints move. Delete/Backspace removes the selection. Selecting a single segment also opens the lane editor panel.

### Planarization (`src/lib/core/crossings.ts`)

After drawing or finishing a drag, `resolveCrossings` finds mid-span segment crossings and splits both segments at a shared new node, creating a real intersection. Curved segments split via de Casteljau, preserving their exact shape. Crossings near existing endpoints are skipped, which guarantees termination.

## Testing Guidelines

- **Never use `waitForTimeout()` in tests** - rely on Playwright's default timeouts and auto-waiting
- Use positive and negative assertions to wait for things (e.g., `await expect(element).toBeVisible()`, `await expect(element).not.toBeVisible()`)
- Playwright automatically waits for elements to be actionable before performing actions
- For pointer interactions, world→screen at the default camera is `screen = center + world * (720 / 500)` at a 1280×720 viewport
- Geometry can be debugged headlessly: `buildRoadLayers` runs under `bun` with a duck-typed graph (see git history for SVG-dump debug scripts)

## LLM Instructions

- never run the dev server, assume the user is already running the dev server
- always use strict typesafety, never use any, don't add return types, always rely on inference
- use Svelte 5 runes (`$state`, `$effect`, `$derived`) instead of legacy reactivity
- use `SvelteMap` and `SvelteSet` from 'svelte/reactivity' for reactive collections
