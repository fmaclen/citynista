# AGENTS.md

Citynista is a browser city-road editor: draw streets from lane presets, shape them, and see them drawn as a map. Later goal: buildings and vegetation inside the blocks the roads enclose. Snappy editing beats rendering fidelity.

Stack: SvelteKit + Svelte 5 runes, Three.js, clipper-lib for polygon booleans (typed in `src/types/clipper-lib.d.ts`), Tailwind v4, bits-ui/shadcn-svelte. Use `bun`, never `npm` or `node`.

## Before you change the code, read

- [docs/editing.md](docs/editing.md) before changing a gesture: what drawing or pasting connects, what a move may do and when it is refused, the drop that joins a dead end, how a press settles, draw mode's snapping and Shift lock, picking, saving and undo, shortcuts.
- [docs/footpaths.md](docs/footpaths.md) before changing how a footpath is paved (strips, bends, joints), how it is laid over the car roads, how a footpath end joins, slides along and follows a street's sidewalk, or what the connection overlay shows (`rendering/links.ts`).
- [docs/crossings.md](docs/crossings.md) before changing where a footpath crosses a car road, how a crossing or the stop and give-way lines before it are drawn, or how a crossing's control is stored, carried through edits or shown on its badge.
- [docs/road-model.md](docs/road-model.md) before changing how car roads and junctions are built or drawn: connections, setbacks, merging, tapers, lane lines, meshes, or a drawing rule in `checks.ts`.
- [docs/backlog.md](docs/backlog.md) before fixing a drawing bug or a known limitation: it lists what is known and open, and why some of it was left.

## Running and testing

`scripts/worktree-setup` writes this checkout's `PORT` (dev) and `PREVIEW_PORT` (Playwright) to `.env`; dev, preview and Playwright hold to them. Other checkouts on this machine run the same tools, so stop a server or test run by the process ID you started, never by name.

- `bun test` runs the browser-free tests in `unit/`, about a minute and a half in all; pass a file to run one. Road-model and drawing changes are tested here, and so is most editor behaviour: `unit/editor.svelte.ts` opens the real editor and its modes in Node (`openEditor`, with `cityOf` to build a graph), with pointer and keyboard events placed in world metres, a hotbar slot clicked (`brush`) and a draw as the page's (`draw`), and `stale()` listing what `__staleDrawing()` would. A gesture, undo step, drop, settle or badge belongs here; a browser test is for what needs the page (the DOM, the toolbar and lane panel, focus, screenshots).
- `bun run test:jitter` moves the nodes of every `e2e/scenes/` graph and the neighbourhood example, checking each frame against the drawing rules (`road-model/checks.ts`), a fresh build, and (where it has footpaths) the car roads of a fresh build without them; about three minutes, run it when you change the drawing. Its `KNOWN` and `WALKS` lists record known drawing bugs (in `docs/backlog.md`) and may only shrink.
- `bun run test -- e2e/split.test.ts` or `-g 'partial name'` builds, serves and runs those Playwright tests, each writing a screenshot to `test-results/`. Run only the tests your change touches. The test browser reaches nothing but the preview server, and CI runs a failed test once more (reported flaky if it then passes); a local run shows every failure.

Logic changes get tests, and tests assert on what the app does: the graph, the road model, DOM state, and the `?model` hooks in `src/routes/+page.svelte` (`__editorLook()` for the lane, handle, guides, refusals, joins, connector, drop marker and badges shown). Never on pixels, widths, alignment or whether text fits; how things look is checked by eye in the screenshots.

Helpers: `e2e/app.ts` drives the editor in the browser; `e2e/paths.ts`, `e2e/crossing.ts` and `e2e/strips.ts` read footpaths, crossings and paving off a drawing; `unit/model.ts` builds the road model from a saved graph in Node.

- `drawingOf()` reads the drawing built fresh in Node once `expectFreshDrawing()` finds the editor's live drawing the same (`__staleDrawing()` lists any piece kept from build to build that a fresh build draws otherwise). A footpath test asserts it after its edits.
- `unit/car-draw.test.ts` holds car-only draw gestures (`unit/car-draw.ts`) to the graphs the page stored for them before footpaths were a network of their own (`e2e/car-draw.json`, every coordinate within 0.15 m, everything else exact; never re-recorded), and exactly to what the editor in Node stores for them (`unit/car-draw.json`). `e2e/car-draw.test.ts` does one of them on the page, held exactly to the page's record.
- `unit/footpaths-as-before.test.ts` holds every gesture that places a footpath's node by where its end shows (riding, sliding, following a walkway, dropping, dead-end joins, other car ends at or near the dead end included, several paths meeting at a corner), done on footpaths with no shift, to the graph the editor stored for it before footpaths took a shift and the drawing the current code makes for it with the shift work reversed, since crossings have changed since (`unit/footpaths-as-before.json`, by hash). Re-record its graphs only from that older editor, and its drawings only from the current code with the shift work reversed.
- To check what an action stored, read localStorage, with `saveCity()` first only where saving is the user's step.
- The camera is a tilted perspective by default; tests open with `?topdown` (or `?cam=x,z,zoom`), a straight-down view where `screenAt(zoom, centre)` maps world to screen linearly (`720 / 500` px per metre at zoom 1 in 1280×720).
- Wait with `expect(...)` assertions, never `waitForTimeout()`.

## Rules that hold whatever you change

**One network per kind.** A node holds car roads (segments with a car lane) or footpaths (every other segment), never both, and the Graph keeps it so on every edit, whatever tool makes it (`core/networks.ts`, `core/separate.ts`):

- A segment added at a node holding the other kind (`Graph.createSegment`), or given lanes of the other kind (`Graph.setLanes`, several as one edit, so roads turned together stay joined), takes a node of its own at the same place, a car road with the edits naming it (`keepKinds`). The roads already at a node never move off it, and its edits not naming the roads that move stay as stored, to the byte.
- The graph is written only through the Graph's mutators. Outside it, a segment's ends and lanes (frozen, roles and all), a node's list of roads and the graph's maps are read-only (`SegmentWrites` in `core/segment.svelte.ts`). Each mutator reads all it is given before changing anything, so one that fails leaves the graph as it was. Read the ends of a segment you add off the segment.
- A footpath node holds no edits: no setback, taper, connection, control or attachment applies to a strip, and a crossing stores nothing on a node, so an edit there would be state nothing draws. A city read with one drops it, footpaths leaving a car node take none, and no paste lays one (`layPaste` in `clipboard.ts`).
- A city saved with a node holding both kinds is split when read (`separateKinds`), and the edits saved on its footpath node are dropped there. So undo and redo replay the graph as it was saved.

**Car roads are built and drawn as if no footpath existed.** No footpath operation creates, moves, cuts or deletes a car node or segment. A crossing is paint: the crossings and their paint are all a car piece takes from the footpaths, and painting changes no ground. Cars may move footpaths (a footpath node on a car road's ground rides it), never the reverse. `unit/car-only.test.ts` holds car-only graphs to the model recorded in `unit/car-only.json`.

**Nothing is stored but a user's edit.** What the drawing works out (defaults, joins to walkways, crossings) is never stored. Edits reach storage only on Save, and selecting, opening or loading writes nothing. Cities and examples carry `SCHEMA_VERSION` (`core/city-store.ts`); a stored city of another version is dropped at boot, never migrated, so bump it whenever the saved shape changes in a way an older city would read wrongly. An optional field whose absence reads as before (a footpath's `controls`) needs none.

**Editing cost stays proportional to what changed, not to map size.** Every build compares each piece with what it was drawn from and draws again only what changed and what lies near it, found through grids kept from build to build; the car model, and the footpaths' lines and crossing controls, start from what the Graph logs as written since the last build (`Graph.changesSince`). Keep new per-road or per-node work behind those keys; the editing, footpath, crossing and road-model docs each end with what their part caches. Nor, where it can be read exactly or to rounding, to a road's length: the road-model doc lists what reads only near one spot, to what precision, and what still reads a road whole. `?stats` exposes `__renderStats()` and `__perfMove()` for measuring a drag frame; a unit test holds work to what changed by counting the points handed to Clipper (`clipped` in `road-model/clip.ts`, off unless a test turns it on, and writing nothing while off), never by timing.

**Leave changes in the working tree for review:** never commit, push or branch.

## Where things live

- **The graph** (`src/lib/core/`) is what the user edits and what is saved: nodes and segments. A segment has one cross-section (`lanes`, each with a stable `id`), an optional quadratic control point, and a shift at each end, `offsetStart`/`offsetEnd` (metres the cross-section sits right of the drawn line, blending linearly along the road). A node's `junction` holds only the user's edits there: connections `added`/`removed` against the defaults, `crossings`, per-approach `control`, per-road `setbacks`, attached roads' `sides`. Everything else is worked out on every build.
- **Where a road is:** `core/road-line.ts` is the line each road shows on (the drawn line moved by the per-end shifts), between the segment's ends as drawn (`endAt` in `core/attach.ts`). Picking, snapping, splitting, crossing detection, node rings (`nodePoint`), the selection band and the handles all read it; nodes stay on the drawn lines.
- **The build:** `Networks` (`core/networks.ts`), called by `RoadRenderer`, runs one pass per network per rebuild: `PlaceBuilder` (`core/place.ts`) for the car roads, `Footpaths` (`core/footpaths.ts`) for the footpaths, then lays the footpaths over the car ground (`road-model/overlay.ts`) and finds their crossings (`core/runs.ts`), none where one's route's paving runs on onto a junction's ground (`onJunction` in `core/networks.ts`); a junction paints none (`drawJunction` in `road-model/node.ts`).
- **The drawing:** `road-model/` turns the car roads' model into descriptions (`describeRoad` in `road.ts`, `drawJunction` in `node.ts`), `holds.ts` decides where traffic is held at a crossing, and `rendering/` turns descriptions into meshes.
- **The editor:** `src/lib/editor.svelte.ts` owns the graph, scene, renderers, selection and modes (`src/lib/modes/`). One `graph.save()` is one undo step.
- **Cities** live in localStorage. Examples are read-only `static/examples/<id>.json`, opened with `/?example=<id>`; saving one asks for a name. Rebuild an example with `bun scripts/build-neighbourhood.ts`, which drives the real UI against a dev server on `PORT`, rather than editing the JSON. `scripts/build-milestone.ts` records the SW 136th pocket demo the same way.

## Code

- Strict types, no `any`, no explicit return types.
- Runes and `SvelteMap`/`SvelteSet` for reactive state.
- Comments explain the geometry rules in prose for a reader arriving cold; keep them in step with the code under them. The comment above a function is the authority on its rule, and the docs point to it.
