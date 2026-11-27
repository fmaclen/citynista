# Backlog

Running list of decisions, open questions, and side-quests spawned while
building the road/junction/connector model. Lightweight on purpose — promote any
of these to GitHub issues if/when we want them tracked there.

Status key: **now** (in progress) · **next** (agreed, queued) · **later**
(parked) · **idea** (unvalidated).

## Open decisions

- **later** — Which road gives way where a road is joined to a shifted
  road. Where roads leaving a node in different directions are shifted
  differently there, their ends show apart, whatever the node: they show at
  one spot only where each shift there is nothing. The editor finds a
  crossing where the roads show and stores the join where they lie (on the
  shifted road's own line), and on a shifted road those are different
  places. So a join made on a shifted road cannot both keep every road
  exactly where it showed and show where the roads cross. Today every road
  stays where it showed and the node lies on the shifted road's own line, so
  its ends show the shift away from the crossing. Where the shift keeps a
  road's own line under its paving (the offset handle's limits at a junction
  or taper mostly do) the junction or joint still lies within it; where a
  shift takes a road off its own line it shows plainly wrong. The choices:
  keep this; let the shifted road give way at a join made on it (the node
  goes where the roads cross as shown, the shift there becomes nothing, and
  its pieces slant from there to their far ends), which makes the two places
  one at every join; or keep a footpath's shift within its own paving.
  Fixing the faults below one at a time means reconciling the two places
  inside the cutter, and both attempts so far changed draws and rings with
  no shift in them, so they wait for this. Waiting on it:
  - Drawing across a shifted street makes the junction where the unshifted
    lines cross (`nodeFor` in `core/crossings.ts`). A Street from (-100, 0)
    to (100, 0) shifted 3 m shows at y = 3; a Street drawn from (-80, -8)
    to (80, 8) crosses it as shown at (30, 3) and is joined at (0, 0).
  - A path drawn through the joint of two paths shifted 8 m joins there with
    its pieces' ends shown metres along it from the joint (node passes in
    `core/crossings.ts`).
  - One crossing is cut again and again (`resolveCrossings` in
    `core/crossings.ts`). A Path from (-100, 0) to (100, 0) shifted 3 m, and
    a Path drawn from (-80, -8) to (80, 8) across it: the first cut, on the
    stored line, leaves the shown lines still crossing, and later cuts
    reshape the shifted remainder and make more crossings for the same draw,
    five four-way nodes and twelve segments in all. Reversing the stored
    road or mirroring the shift does the same, and so does a car one-way
    lane shifted 8 m.
  - A circle finds and cuts the roads it meets on their stored lines
    (`crossingsOf` in `modes/circle.ts`), where a straight draw finds them
    where they show. A radius-25 Path circle at the origin cuts a path
    showing at y = 20 but lying at y = 0 at x = ±25 rather than where it
    shows crossing, at x = ±15. The same shown path lying at y = 30, shifted
    -10, is not cut at all. A 0.8 m shift on a 2 m Path, well inside its own
    paving, already gives two joins where the path only shows touching the
    ring. The same holds for a street under a car circle.
- **later** — A footpath through the very node of a sharp bend (two streets
  at 135°) leaves a sliver of the node's outer corner bare between its zebra
  and the curb: a road's crossing reads its roadway round the end as far as
  it is wide (`insideOf` in `core/runs.ts`), and the node's paving reaches
  further. For the same reason a footpath over the outer corner of a sharp
  bend alone, inside neither roadway (147°, 3 m off the node), crosses
  nothing. Reading every bend crossing off the car ground would close both
  and restyle every crossing near a bend.
- **later** — At a node of two sides each road reads its own crossings
  (`crossingsHeldBy` in `core/runs.ts`), so a footpath run both roadways
  read from curb to curb there is a crossing of each: two badges on one
  crosswalk, each storing its own control, each striped along its own road
  (at 147° the two run two ways). Open: making one crossing of the two
  readings changed which lanes are held and rewrote stored controls on the
  next save, so it was taken out. Where a road is parted so it never
  meets itself (`roadThrough` in `core/place.ts`), the parting is such a
  node, so a footpath a metre or three past it, on one side, is two
  crossings (`unit/long-roads.test.ts` allows it at a node of two roads and
  nowhere else).
- **later** — An 8 m footpath crossing a Street at 2° paints 1,150 of the
  1,605 m² it lays over car lanes: a band reaches no further along a curb
  than 20 widths (`bandOf` in `core/runs.ts`). Left alone.
- **later** — A footpath meeting an Avenue's sidewalk at a slant leaves a
  sidewalk spike there (the "sidewalk spike" rule), with or without a
  junction near.
- **later** — A road's crossing whose footpath ends a little past the far
  curb at a slant paints past the footpath's end: the band carries each
  edge on to where it meets the curb (`bandOf` in `core/runs.ts`). A lone
  Street crossed by a 4 m footpath ending 0.4 m past the curb: 0.43 m² of
  zebra past its end at 60°, 1.20 m² at 45°, 2.03 m² at 35°.
- **later** — A footpath can cross a curved or shifted road where the road
  has no ground. Read square to the curve, a point can land on a place of
  the road it is not square to: past an end of the segment's line, or round
  a bend tighter than the point is far (`acrossRoad` in `core/road-line.ts`,
  read by `acrossOn` in `core/runs.ts`). Such a reading can put a point
  inside the road well off its paving, and a run across it is a crossing,
  zebra and all. An Avenue from (0, 0) to (91.16, 34.63), handle
  (112.49, 54.55), shifted 17.03 m at its start and −10.84 m at its end
  (folded back on itself near its end), and a Path from (−8.32, −3.07) to
  (77.62, 111.59), handle (96.63, −110.60): two crossings, the second over
  the sidewalk past the far curb, on no car ground. Of 1,000 fuzzed cities of
  one curved car road and eight footpaths, at least four have such a run;
  some paint zebra pieces off the paving or beside the footpath.
- **later** — Near the end of a long curved, shifted road a footpath across
  it can miss its zebra. Which end a point lies past is read square to the
  first or last sampled chord of the drawn line (`alongPath` on `drawn` in
  `core/runs.ts`), which turns off the curve's tangent there by half its
  bend; far out on a big shift that moves the end by a metre or more. A
  Street from (0, 0) to (900, 1000), handle (100, 0), both shifts −15 m,
  and a 2 m Path from (1.6, −30) to (1.6, 0), its width all inside the
  start cap and across the whole asphalt: no crossing. At x = 3 it has one.
- **later** — The same chord makes a footpath just past a curved dead end, on
  the inside of the bend, cross it. The Street from (0, 0) to (900, 1000),
  handle (100, 0), both shifts +15 m, and a 2 m Path from (−0.5, 0) to
  (−0.5, 30), its middle half a metre past the start cap and the car lanes,
  though its edge laps them by some 3.8 m²: one crossing, its zebra and its
  badge. At x = −1.1, all of it clear of the car lanes, the crossing is
  still read, though nothing paints. A wide divided curved road with no
  shift does the same (3.5 m lanes either side of a 7 m median, (0, 0) to
  (3000, 3000), handle (190, 0), a Path at x = −0.2).
- **later** — At a mouth a few degrees off square, a junction's corner verge
  is drawn over the end of an arm's outer lane. With no footpath nothing
  shows it; a footpath laid over that corner paves the verge
  ("sidewalk over asphalt"). Four 80 m arms at 1°, 90°, 182° and 271°
  (Highway, Street, Avenue, One-way lane), a 2 m Path from (-45.30, -18.93)
  to (47.36, 12.97): 0.65 m².
- **later** — Car-only junction faults a seeded sweep of footpaths over
  junctions met, none of them a crossing's (`checks.ts` reports them with no footpath at all): an arm's
  outline not simple (Highways from (81.36, -7.74), (-1.06, -67.83) and
  (-80.34, -2.05) meeting a One-way lane from (5.87, 75.95)); a hole at a
  Highway's mouth meeting two One-way lanes (Highway from (5.83, 67.15),
  lanes from (-90.53, 7.87) and (-7.54, -89.38), all to the origin).
- **later** — A crossing whose control was set and whose footpath then
  reaches a junction's ground (moved, or the junction redrawn towards it)
  loses that control on the next edit saved, as any crossing that goes
  does; moved back, it gives way until set again. Cities saved while
  footpaths crossed junctions keep their junction entries (`nodes`), which
  name nothing, until that next edit drops them.
- **later** — The paint cleared behind a crossing's line is the whole
  carriageway, both directions (`road-model/holds.ts`), as tested by hand.
  Clearing only the crossed lanes is the other reading, left unchosen.

## Costs that grow with the map

Each breaks the performance contract in `AGENTS.md` and needs a
restructuring rather than a patch.

- **later** — A road folded back so tightly that two of its lane edges
  pass within a metre of each other by a crossing (a one-lane road turned
  back on itself, 0.55 m between its arms' lanes) reads the whole turn
  between the two as one run of the lane near the crossing (`stripNear` in
  `road-model/geometry.ts`): 4,682 points a frame with its arms 80 m long,
  31,382 at 800 m. Left: keeping the runs apart there would need a lane's
  ground read in pieces that Clipper then joins, which moves the drawing.
- **later** — A footpath's crossing test reads every half-metre of it.
  Wherever a footpath's box meets a roadway's, `stretchesOf` in
  `core/runs.ts` tests a point every half-metre along the whole footpath
  against that roadway (`insideOf`: the nearest point of its path, and a
  read square across its curve), however little of the footpath lies near
  it. A Path from (−10, 20) heading north-east across a curved Street from
  (−40, 0) to (40, 0), handle (0, 80), dragged by its start: 375 reads a
  frame at 40 m, 1,095 at 400 m, 8,333 at 4 km, about 70 ms a frame then;
  square across a straight Street, 8,295 reads and about 22 ms at 4 km. In
  the neighbourhood example a footpath node drag reads about 7,700 points a
  frame and a footpath segment drag about 6,700. Needs the test to call a
  point inside only over the road's ground (the entry above on footpaths
  crossing where the road has no ground), after which a box round the
  roadway bounds it.
- **later** — A lane edit scans every segment for crossing controls
  (`carryControls`, `core/crossing-controls.ts`). Needs an index of
  footpaths storing controls by car road, with every write of `.controls`
  going through one Graph mutator (about ten writers today).
- **later** — `Graph.putAt` rebuilds the segment map and re-ranks every
  segment on each cut: 0.56 ms per cut at 500 segments, 2.66 ms at 5,000.
  Needs the order kept as gapped ranks.
- **later** — `resolveCrossings` scans every node and traces every segment
  on each draw or paste: 14 ms for one path at 500 segments, 82 ms at
  5,000. Needs a spatial index.
- **later** — Every build that changes a car road still passes over every
  car piece's key and end cuts (`Drawing.build`) and every piece again to
  paint it (`Drawing.paint`), and `Networks.build` files every car piece
  again; the car model itself is read again only where the edit reaches
  (`PlaceBuilder.model`). A footpath edit reads none of that. Needs the
  drawing to start from the pieces the car model changed, as
  `PlaceBuilder.model` starts from the writes.
- **later** — Every build, a footpath edit's too, copies the car and
  footpath lists and roads into the place it hands on (`place` and `geos`
  at the end of `Networks.build`), lists every footpath strip again when any
  strip changed and every fill when any fill changed (`listed`), and
  `PlaceBuilder` copies its own three lists whole on any car change. Then
  `RoadRenderer.update` looks up every road and junction of that place and
  every piece it holds, before it finds most of them unchanged. Needs the
  renderer and the editor to read the place through lookups and change
  lists rather than whole lists.
- **later** — Every build, a car edit's too, walks every segment of the
  graph, car roads included, to find the footpaths whose shape changed
  (`Footpaths.build` in `core/footpaths.ts`): 21, 41 and 101 segments for
  one footpath moved in graphs of 21, 41 and 101. Needs it to start from
  the graph's writes (`Graph.changesSince`), as the car view of the graph
  does (`carsOf` in `core/networks.ts`).
- **later** — With connections shown, every changed frame keys the overlay
  by every piece drawn and reads every link again (`refreshOverlay` in
  `rendering/road-renderer.ts`, `LinksReader.read` in
  `rendering/links.ts`), then walks every line and dot. Needs the links
  reader to hand back what it read again by piece, and the overlay to
  draw again only those pieces' lines and dots.
- **open** — Dragging a node where four or five streets meet in the
  neighbourhood example costs about 55 ms a frame: it draws again every
  junction its roads reach (eight there), at about 4 ms each, most of it
  Clipper work on the corner sidewalks and crossings (`cornersOf` in
  `road-model/corners.ts`). The drawing reads the same however it is
  sped up only by drawing those corners differently (fewer points, or
  drawn in parts that Clipper then joins), which moves recorded drawings.

## Connector tool

- **later** — Re-enabling a blocked movement is "drag the same pair again."
  Revisit if it feels unclear.
- **later** — Fallback if drag still confuses: TM:PE-style click-source-then-
  click-targets.

## Overlays (general)

- **next** — Apply the hover convention (blue + slight scale + grab cursor) to
  **setback handles** and any other overlay, not just connector dots.

## Junctions / geometry

- **next** — #213: break the solid centerline at a node when a connection
  actually crosses the opposing flow (it's functionally an intersection there).
  Check first whether the line cutting in `road-model/node.ts` already does
  this; no test covers it.

- **later** — The diagonal avenue's 5–6-arm crossings render as big asphalt
  blobs; they really want traffic circles.
- **later** — Materials: a per-junction paving override from a menu. Today a
  junction is paved in the material that carries the most car-lane width
  across its arms.

## Known drawing bugs

Each is left out of `bun run test:jitter` (the `KNOWN` and `WALKS` lists in
`unit/jitter.ts`) or was found by hand; fixing one means dropping its
exclusion.

- **later** — `junction-materials`: with `tee` nudged south, or `tee-e` or
  `tee-w` nudged north, the lines of `tee-west` and `tee-east` cross `tee`'s.
- **later** — `tight-junction` and `tight-link`: with `b` or `c` moved 5 m
  north or south, the merged junction's own lines cross.
- **later** — `tight-bend`: with `a` or `b` moved toward the other, tightening
  the hairpin, the sidewalk on the inside of the fold lies over the far lanes
  and their paint.
- **later** — Bends sharper than about 155° make the two roads overlap: the
  bend setback stops growing at `TAPER.SHARPEST`.
- **later** — Two car roads that meet only through a footpath are not joined:
  dragged into each other (`short-footpath`, `t` walked toward `j`), their
  ground and lines lie over each other. The jitter test no longer walks that
  graph.
- **later** — A city saved with a footpath attached at the edge of a car road
  at a node they shared (`JunctionData.sides`, not where the road only
  carried on) loads with the footpath on a node of its own at that node
  (`core/separate.ts`), its side kept but read against no road: it ends on
  the road's line, not at its sidewalk's edge. No shipped scene or example
  has one.
- **later** — `offset`, its junction walked into its neighbour: nearing the
  merge, sidewalk runs over asphalt and `w1j1`'s lines cross `j1`'s; in the
  last 1.5 m before `j1` and `j2` draw as one, their corner sidewalks lie over
  each other.
- **later** — `off-ramp`, its junction walked toward its neighbour: one frame
  paints on grass.
- **later** — A few attached ramps whose curve is pulled across or behind the
  host road connect to a worse lane than before the one-pass `PlaceBuilder`.
- **later** — An approach whose own road is too short for its arrows (a
  roundabout entry between its split and the ring, nodes moved 5 m; `offset`
  walked toward its merge; a few neighbourhood nodes moved 5 m) draws none:
  its arrows can't stand back past a node of two sides. `check()` reports a
  missing arrow only where the approach's own road has room, so these pass.
- **later** — Four junctions merging round a small loop pave its open
  centre: `joinedOutline` (`road-model/outline.ts`) drops the hole ring.
- **later** — The car-only scene "tighter hairpin" has 0.16 m² of lane paint
  on a junction's own crossing. The "paint on a crossing" rule reports it,
  and that report is recorded in `unit/car-only.json`.
- **later** — Where two crossings overlap, the one whose id sorts first takes
  the shared ground.
- **later** — On a node of two sides, a crossing's drawn width depends on
  which way the street is stored (`bandOf` and the runs in `core/runs.ts`).
- **open** — A footpath wider than the road it crosses at a slant (8 m over
  a One-way lane, 45° or shallower) draws a crossing a fraction of its width:
  `bandOf` (`core/runs.ts`) looks for where each footpath edge meets the curb
  it enters by within reach of the edge, and finds the far curb instead, so
  both ends of the band land on one point per edge.
- **open** — A footpath across the last metres of a road bent hard into its
  dead end (an Avenue from (-55, 0) to (10, 0) with its handle at (10, -5), a
  2 m Path from (35, -25) to (-25, 25)) leaves some 14 m of car lanes along
  its way unpainted; the overlay's crossing line, kept on the paint, has
  gaps there.
- **open** — A junction's corner sidewalk laid across a road's mouth has a
  gap in its crossing in front of that road's median where the median stops
  short of the junction. Where the north-south highway meets the east-west
  boulevard in the example city (node-78, near (500, -420)), each corner's
  zebra over the highway is in two halves with about 3 m of bare asphalt
  between them, about (500, -401) and (500, -439), so some 7% of the
  corner's middle, which the connection overlay draws straight across, lies
  on neither sidewalk nor crossing. The road draws its median's cut-back
  nose as asphalt (`road-model/road.ts`), but `cornersOf`
  (`road-model/corners.ts`) lays a crossing only over the roads' roadway
  lanes (`nearEnd(..., isRoadway)`, which leaves a median out) and the
  junction's paving, and rests it on a refuge only over medians carried
  across the junction (`refuges`), so it lays neither over that asphalt.
- **open** — In the connection overlay, a footpath with a grass verge
  beside its walk lane has its orange line down the middle of the whole
  path, over the verge, and its links through bends and joints and onto a
  sidewalk the same. The overlay draws the model's walking lines, which run
  down the middle of a footpath's cross-section (`middleLine` in
  `core/footpaths.ts`). Following the walk lanes means changing those lines
  in the model, which the joins to a sidewalk, the follower and the
  connector read: each attempt moved where an end is stored or what the
  connector links, for one uncommon kind of path.
- **open** — A junction's curb can hook back on itself beside a road's
  mouth: where the next road's curb point lies past the end of the road
  whose mouth it leaves (six roads meeting, a road without sidewalks between
  two streets at a sharp angle), the corner curve (`road-model/outline.ts`)
  leaves into the junction and turns back, leaving a notch some 30 cm deep
  in the asphalt. The corner's sidewalk follows the curb into it and ends
  there in a point, which `check()` reports as a sidewalk spike. Opening the
  corner by 10 cm, as the drawing once did, swaps the point for grass and
  costs about a fifth of a junction drag; the fix is in the curb curve,
  which is the car drawing's.
- **open** — Where a curved road turns back into a junction it shares with
  a tapered road, pinching the junction's outline into two rings, a corner
  sidewalk can lose a narrow strip (some 30 cm wide and 6 m long) that
  links the sidewalk beside a crosswalk to the curved corner. A footpath
  end on that strip is left unjoined. It comes from running the corner's
  band back into each road square to the road's end (`backInto` in
  `road-model/corners.ts`), which keeps a seam from opening a slit where a
  road is shifted differently at its two ends; along the lanes' slant it
  keeps the strip but opens the slit. Seen only in generated cities.
- **later** — `cornersOf` (`road-model/corners.ts`) has unreachable same-end
  branches.

## Known editing faults

- **later** — A crossing wholly covered by a wider one has no badge, but its
  control still paints its line on one approach.
- **later** — The preview of a drop held over its marker leaves out what only
  a build of the joined graph moves (ends kept on their walkways), so a drop
  refused for that shows as refused only once let go.
- **later** — A held move dragged back exactly to where it began is still
  offered Undo.
- **later** — A Shift-locked line that misses the walkway it aims at leaves
  the end free on the line, possibly on asphalt.
- **later** — `nodeAt` in `core/networks.ts` measures corner-follow angles
  from the stored car node, not from where the junction shows. Not
  confirmed by a test.
- **later** — `walkwayAt` and `walkwayOf` read the middle of a sidewalk two
  ways, up to about 2 cm apart on curves.
- **later** — A joint on a sidewalk where a second path carries on does not
  follow its street when the street is widened: only a free end is kept on
  a walkway drawn anew (`followWalkway` in `modes/picking.ts`), so the joint
  stays where it was, 2 m from the new sidewalk's middle when a Street's two
  car lanes each widen 2 m. With or without a shift, and as before footpaths
  took a shift.
- **later** — A shifted footpath whose two nodes both move in a gesture is
  carried, never solved against its other end (`placedBy` in
  `core/drag.ts`), so where the street under it is stretched or bent rather
  than moved bodily its ends leave the middle of their walkway by its shift
  times the angle the footpath turns against the street there: about 2 cm
  for a path shifted 0.6 m between two arms of a T whose centre is moved
  (2, 5) m, 6 mm for an 8 m path's joint as the same T's centre moves. A
  carried end sliding along a walkway, or kept on one drawn anew, is off it
  the same way. Placing both ends exactly means solving each against the
  other moving, which has no single answer in rings and chains.
- **later** — A curved footpath with no shift at either node, one node kept
  to a corner and the other riding or dragged, is bent with the drag from
  where the corner's node lay the build before, so its handle lands by
  pointer count: 2.7 m apart between 1 and 32 updates for a path from a
  T's corner to a rider on the arm whose body is dragged (`corners` in
  `unit/footpaths-as-before.ts`). A shifted one is placed after the
  follower (`bentAfter` in `core/drag.ts`); dropping its shift condition
  fixes this too, but moves 8 recorded steps of that file, which holds
  footpaths with no shift to the editor before footpaths took a shift. The
  same footpath's corner node follows its corner from build to build, as
  it always did, drifting up to 0.2 mm over 32 updates of a rigid drag.
- **later** — An end kept to a junction's corner can be left behind in three
  gestures, with or without a shift on its footpath, as before footpaths
  took a shift:
  - A whole T dragged far in one or two pointer updates, (-11.25, 9.75) m,
    with a curved 8 m path between its two corners: the first rebuild can
    fill the joint where a 2 m path meets it, `freeEnd` then gives the
    follower nothing to move (`followWalkways` in `editor.svelte.ts`), and
    the east end stays 14 m back. Thirty-two updates land it.
  - An arm swung so that a corner's bearing turns more than 30° in one
    press (a T's north arm from (0, 86) to (39, 77) turns its west corner
    34°): the corner matcher (`onCorner` in `modes/picking.ts`) refuses it
    past 30°, and the end stops where the last accepted frame left it,
    3.48 m apart between pointer counts.
  - Two parallel Streets' ends dragged 40 m: a 20 m path between their
    sidewalks turns round, its far end jumping to the other Street's
    sidewalk (`ridersOf` in `core/drag.ts`), and the move is accepted.

## Tests and CI

- **later** — The browser suite is 288 tests in about 8.5 minutes on 8
  cores. CI's job has a 30-minute limit, 30 seconds per test, no retries and
  fewer cores. A handful of tests run 20 to 22 seconds in a full local run,
  and one in `e2e/examples.test.ts` takes about 35.
- **later** — The unit suite takes about 100 seconds, most of it sweeps over
  ranges of layouts.
- **later** — `e2e/lane-editor.test.ts:138` waits on a row's pixel position,
  which the testing rules forbid.

## Next projects

- **next** — Corner sidewalks built from curb runs instead of polygon
  clipping. They are most of a junction's drawing time (a drag frame on the
  example's busiest node is about 55 ms) and the source of the sidewalk
  wedges and overlaps above; with them out of `road-model/node.ts`,
  the node drawer's two paths could merge further.
- **idea** — Bike paths and rail as further networks laid over the cars and
  footpaths (`core/networks.ts`, `road-model/overlay.ts`).
- **idea** — The graph as plain data with one change counter instead of
  Svelte rune classes. Only the lane panel and one toolbar button need the
  reactivity, tests fake the graph with casts, and the example city has to be
  rebuilt by a script that drives a browser.
- **idea** — Before cities are stored for other people: migrate a city of an
  older schema version instead of dropping it, and make saving asynchronous
  (about twenty call sites assume it is instant).
- **idea** — Curb and boundary ownership in the description, for 3D: which
  edges are real curbs and which are only where a surface was sliced.
- **idea** — A lane graph for vehicles. Lane paths through nodes are in the
  description, tied to their connections, but nothing joins them with the
  roads' lanes into one network, and two-way lanes have no path across a
  two-road node.
