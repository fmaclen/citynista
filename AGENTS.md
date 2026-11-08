# AGENTS.md

Citynista is a browser city-road editor: draw streets from lane presets, shape them, and see them drawn as a flat top-down map. Later goal: buildings and vegetation inside the blocks the roads enclose. Snappy editing beats rendering fidelity.

Stack: SvelteKit + Svelte 5 runes, Three.js (orthographic top-down camera on the XZ plane), clipper-lib for polygon booleans (typed in `src/types/clipper-lib.d.ts`), Tailwind v4, bits-ui/shadcn-svelte. Use `bun`, never `npm` or `node`. Scripts are in `package.json`.

## Worktrees

T3 opens each thread in `.worktrees/<branch>`; `scripts/worktree-setup` writes the slot's `PORT` (dev) and `PREVIEW_PORT` (tests) to `.env`. Dev, preview and Playwright read them with `strictPort`.

- `bun run test -- e2e/split.test.ts` or `-g 'partial name'` builds, serves on `PREVIEW_PORT`, runs the named tests; each test writes a screenshot to `test-results/`. Run only the tests your change touches.
- `e2e/lab-jitter.test.ts` drags every road end of the `/lab` places and checks the drawing rules in `src/lib/lab/checks.ts`; slow, run it when you change the drawing.

## How it fits together

**The graph** (`src/lib/core/`) is what the user edits and what is saved: nodes and segments. A segment has one cross-section (`lanes`, each with a stable `id`), an optional quadratic control point, and an `offset` (metres the cross-section sits right of the drawn line). A node's `junction` holds the user's edits there: connections `added`/`removed` against the defaults, `crossings`, per-approach `control`, a two-road node's `taper`. `connections` on it is a copy of the result, rewritten on every build.

**The road model** (`src/lib/lab/`, model in `model.ts`) is what gets drawn. `core/place.ts` reads the graph into it every rebuild: each segment becomes a road trimmed back from its nodes, each node of two or more roads a junction whose connections are the defaults (`lab/connect.ts`) minus `removed` plus `added`. Nothing recognises a junction type from angles; defaults are a few general rules written at the top of `connect.ts`, and crossing defaults in `defaultCrossings` (`lab/junction.ts`).

- `lab/road.ts` draws a road: one strip per lane, paint, its crossings (zebra over the roadway, refuge in a median, paving through verges).
- `lab/link.ts` draws a node where two roads meet: paved between them, each connected lane a band in its own surface, unconnected lanes end. Paint comes from neighbouring car paths (same way white dashes, opposing yellow, outer edges edge lines, none where paths overlap).
- `lab/junction.ts` draws a junction of three or more: asphalt inside the curb outline, corner sidewalks, carried-through roads, stop lines and arrows from the approach controls and connections.
- `lab/scene.ts` caches one drawing per road and per junction by version; `rendering/lab-renderer.ts` turns each into Three.js meshes, rebuilding only pieces whose drawing changed.

**Performance contract:** editing cost stays proportional to what changed, not to map size. `PlaceBuilder` caches curves, road shapes, junctions, tapers and default crossings by key; keep new per-road or per-node work behind those keys. `?stats` exposes `__renderStats()` and `__perfMove()` for measuring a drag frame.

**Where the road is:** `core/road-line.ts` is the line each road shows on (drawn line moved by the offset). Picking, snapping, splitting, crossing detection and node rings (`nodePoint`) all read it; nodes themselves stay on the drawn lines.

**Earcut caveat:** never hand `THREE.ShapeGeometry` a polygon with holes; it mis-triangulates. `toPolygons` in `lab/clip.ts` slices holed polygons into simple pieces.

## Editing

`src/lib/editor.svelte.ts` owns the graph, scene, renderers, selection and modes. One `graph.save()` is one undo step. Modes live in `src/lib/modes/`: select (default; drag nodes, roads, curvature handle, offset handle, taper handles on a selected two-road node), draw (pick a preset slot; smooth chaining and Shift angle snaps), split, bulldoze, place (paste), and the lane connector (double-click a node: drag lane dot to lane dot to toggle a connection, drag or double-click crossing handles, click approach badges to cycle none/stop/yield/signal). After drawing, `core/crossings.ts` splits roads that cross where they show.

The lane panel (`components/LaneEditor.svelte`) edits the selected segments' lanes in place. Keyboard shortcuts fire only when the event target is `<body>`.

## Cities and examples

Cities live in localStorage (`core/city-store.ts`); edits reach storage only on Save (⌘S). Examples are read-only `static/examples/<id>.json`, opened with `/?example=<id>`; saving one asks for a name. Rebuild an example with its script (`bun scripts/build-neighbourhood.ts`, which drives the real UI against a running server on `PORT`) rather than editing the JSON. `scripts/build-milestone.ts` records the SW 136th pocket demo the same way.

Test-only graphs live in `e2e/scenes/` and open through `openScene()` in `e2e/scenes.ts`; read storage only after `saveCity()` from `e2e/save.ts`. In tests, wait with `expect(...)` assertions, never `waitForTimeout()`. World to screen at the default top-down camera: `screen = centre + world * 720 / 500` at 1280×720.

## Code

- Strict types, no `any`, no explicit return types.
- Runes (`$state`, `$derived`, `$effect`) and `SvelteMap`/`SvelteSet` for reactive state.
- Comments explain the geometry rules in prose; keep them in step with the code under them.
- Never commit, push or branch: leave changes in the working tree for review.
