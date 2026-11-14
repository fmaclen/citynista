# AGENTS.md

Citynista is a browser city-road editor: draw streets from lane presets, shape them, and see them drawn as a map. Later goal: buildings and vegetation inside the blocks the roads enclose. Snappy editing beats rendering fidelity.

Stack: SvelteKit + Svelte 5 runes, Three.js, clipper-lib for polygon booleans (typed in `src/types/clipper-lib.d.ts`), Tailwind v4, bits-ui/shadcn-svelte. Use `bun`, never `npm` or `node`.

## Running and testing

`scripts/worktree-setup` writes this checkout's `PORT` (dev) and `PREVIEW_PORT` (Playwright) to `.env`; dev, preview and Playwright hold to them. Other checkouts on this machine run the same tools, so stop a server or test run by the process ID you started, never by name.

- `bun test` runs the browser-free tests in `unit/` in a few seconds. Test road-model and drawing changes here.
- `bun run test:jitter` moves the nodes of every `e2e/scenes/` graph and the neighbourhood example, checking each frame against the drawing rules (`road-model/checks.ts`) and a fresh build; about two and a half minutes, run it when you change the drawing. Its `KNOWN` and `WALKS` lists record known drawing bugs (in `docs/backlog.md`) and may only shrink.
- `bun run test -- e2e/split.test.ts` or `-g 'partial name'` builds, serves and runs those Playwright tests, each writing a screenshot to `test-results/`. Run only the tests your change touches.

Helpers: `e2e/app.ts` drives the editor in the browser; `unit/model.ts` builds the road model from a saved graph in Node. To check what an action stored, read localStorage, with `saveCity()` first only where saving is the user's step. The camera is a tilted perspective by default; tests open with `?topdown` (or `?cam=x,z,zoom`), a straight-down view where `screenAt(zoom, centre)` maps world to screen linearly (`720 / 500` px per metre at zoom 1 in 1280×720). Wait with `expect(...)` assertions, never `waitForTimeout()`.

## How it fits together

**The graph** (`src/lib/core/`) is what the user edits and what is saved: nodes and segments. A segment has one cross-section (`lanes`, each with a stable `id`), an optional quadratic control point, and a shift at each end, `offsetStart`/`offsetEnd` (metres the cross-section sits right of the drawn line, blending linearly along the road). A node's `junction` holds only the user's edits there: connections `added`/`removed` against the defaults, `crossings`, per-approach `control`, per-road `setbacks`, attached roads' `sides`. Everything else is worked out on every build.

**Saved format:** cities and examples carry `SCHEMA_VERSION` (`core/city-store.ts`). A stored city of another version is dropped at boot, never migrated, so bump it whenever the saved shape changes.

**The drawing**, one pass per rebuild:

- `PlaceBuilder` (`core/place.ts`) reads the graph into the road model (`road-model/model.ts`): each segment a road trimmed back from its nodes, each node of two or more roads a junction whose connections are the defaults (`road-model/connect.ts`, rules at its top; crossings from `defaultCrossings` in `defaults.ts`) less `removed` plus `added`, and junctions too close together merged into one (`road-model/merge.ts`). Nothing recognises a junction type from angles.
- `Drawing` (`road-model/drawing.ts`) turns the model into descriptions (`description.ts`, explained in `docs/road-model.md`) through `describeRoad` (`road.ts`) and `describeJunction` (`node.ts`). The node drawer forks at `linkSides`: `lanesAcross` where lanes cross from one side to the other (two roads, or roads attached at an edge), `roadsMeeting` at a junction. `TAPER` in `road-model/geometry.ts` holds every number that shapes a taper or bend.
- A road attached at the edge of one that carries on joins the lane at that edge and nothing else, whatever its own lanes (`sideConnections` in `connect.ts`): a two-way street ended on an avenue's edge turns into and out of the near carriageway and leaves the median whole. Only its lanes are paved, the gore between them is ground (`outlinesAcross` in `outline.ts`), and its node reaches along it until it is clear of the road it joins (`clearOf` in `core/place.ts`).
- Wherever car lanes cross a walkway, in either fork, the walkway carries on over them as a zebra crossing and never as sidewalk: `crossingOver` in `corners.ts` is the one place that crossing is made. No road is a driveway.
- `road-model/lines.ts` is the lane-line rule, the one place to change which line goes between two neighbours; its table is at the top. Two roads' paths are put in order station by station (`pathLines`); with roads attached at an edge each path is read against what lies beside it on the ground (`linesBeside`). Which lines run on through a junction is decided in `carry.ts` and the priority-road block of `node.ts`. Whatever carries a lane, a curb or a line on from a road end leaves along `frame.run`, the way the road's lanes run there.
- `rendering/road-meshes.ts` turns each description into triangles per layer and colour, and `RoadRenderer` (`rendering/road-renderer.ts`) makes the meshes, rebuilding only pieces whose description changed. Every piece lies in one plane: layers are a painting order (`renderOrder`), not heights, so no seam shows at a tilt. Earcut mis-triangulates holes, so every ring a drawer emits comes from `toRings` (`road-model/clip.ts`), which slices holes away.

**Performance contract:** editing cost stays proportional to what changed, not to map size. `PlaceBuilder` caches by key each segment's curve and road shape, two-road nodes' connections and tapers, junctions, default crossings and the merge test; `Drawing` caches each node's description by its key and each road's by its key and end cuts. Keep new per-road or per-node work behind those keys. `?stats` exposes `__renderStats()` and `__perfMove()` for measuring a drag frame.

**Where the road is:** `core/road-line.ts` is the line each road shows on (the drawn line moved by the per-end shifts). Picking, snapping, splitting, crossing detection, node rings (`nodePoint`), the selection band and the handles all read it; nodes stay on the drawn lines.

## Editing

`src/lib/editor.svelte.ts` owns the graph, scene, renderers, selection and modes (`src/lib/modes/`). One `graph.save()` is one undo step. After a draw, paste or drag, `core/crossings.ts` joins the changed roads to what they pass over where they show. Keyboard shortcuts fire only when the event target is `<body>` (`fromPage` in `utils.ts`).

Cities live in localStorage; graph edits reach storage only on Save (⌘S). Examples are read-only `static/examples/<id>.json`, opened with `/?example=<id>`; saving one asks for a name. Rebuild an example with `bun scripts/build-neighbourhood.ts`, which drives the real UI against a dev server on `PORT`, rather than editing the JSON. `scripts/build-milestone.ts` records the SW 136th pocket demo the same way.

## Code

- Strict types, no `any`, no explicit return types.
- Runes and `SvelteMap`/`SvelteSet` for reactive state.
- Comments explain the geometry rules in prose; keep them in step with the code under them.
- Leave changes in the working tree for review: never commit, push or branch.
