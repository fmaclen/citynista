# How the car roads are built and drawn

The car roads are read from the graph into a road model, described piece by piece, and turned into meshes. This page covers that pipeline: `PlaceBuilder` (`core/place.ts`), the road model (`road-model/model.ts`), the drawers in `road-model/`, and the meshes in `rendering/`. The footpaths are a network of their own ([footpaths.md](footpaths.md)); where they cross the car roads is in [crossings.md](crossings.md).

## From the graph to the road model (`core/place.ts`)

`PlaceBuilder` reads the car roads into the road model: each segment a road with one cross-section, trimmed back from its nodes, and each node of two or more roads a junction of road ends with its connections, walkways and approach controls.

- A junction's connections are the defaults (`road-model/connect.ts`, rules at its top) less the node's `removed` plus its `added`. Its crossings are `defaultCrossings` (`road-model/defaults.ts`) with the user's edits on top.
- Junctions too close together are merged into one (`road-model/merge.ts`, below).
- A junction's setbacks are read along its roads' curves as drawn, never more than two straight roads at that angle would need (`setbacks` in `core/setbacks.ts`).
- Nothing recognises a junction type from angles, except whether a road carries straight on (`TAPER.STRAIGHT`).

### Roads carried on through a node

A node of exactly two car segments that a road only carries on through is no node (`carriedOn`): the same lanes and lane ids, straight on within `TAPER.STRAIGHT`, the shift unbroken, and its edits leaving every lane straight on and setting no setback.

- The two segments are one road, named by the first (`units`; `joinCurves` in `core/segment-curve.ts`). Every reader of a road's length reads it whole.
- The segments of one road never start and end at the same node. Where a chain of them would, it is parted at nodes chosen by their ids alone (oldest first: read as numbered, then as written), never by length, so a drag that leaves the chain's nodes as they are moves no parting: a loop carried through all the way round (the Curve tool closed on itself, the Circle tool's ring) at its two oldest nodes, and a chain whose two ends are one real node (a ring with a side street, two rings sharing a node, a teardrop, a loop given an edit at one of its nodes) at its oldest inner node. A parting is then an ordinary node of two roads. On a ring just drawn the two oldest nodes are neighbours, so one road is a single piece. `roadThrough` in `core/place.ts` decides it, and every reader of a road (`PlaceBuilder`, the roadways crossings read in `core/runs.ts`) asks it. A parting still moves where the chain's nodes change: a node cut in whose id reads older than the rest, a node bent past straight or given a side street, a paste snapped onto a node. Nothing stored depends on where it lies: a crossing's control, the open badge and the badges of a selected road read the road as it carries on before any parting (`chainThrough`), never as drawn ([crossings.md](crossings.md)).
- It is drawn as one: pieces cut from one curve are that curve again (`rejoined`), sampled as uncut. An end of it attached at an edge is placed as the whole road's (`wholeOf` in `core/attach.ts`).
- A cut lists its halves where the road was in the graph, and every node lists its roads in the graph's order, as a saved graph reads back (`Graph.putAt`). So an attached road joins the road it did, and an edit draws as it will after a reload.
- A cut stores the shift where it cut as the join expects it, read off the halves' curves (`shiftAtCut` in `core/road-line.ts`), so a cut anywhere on any road joins back.
- The editor still names each segment. `Derived.units` maps a segment to its road's segments; spans, limits and the editor's junctions name the segment ending at each node (`segmentAtEnd`).
- The connector shows such a node as a node of its two segments (`Derived.through`), while it stays drawn as one road, until an edit there breaks the join.

### Merged junctions (`road-model/merge.ts`)

Merging changes how nodes are drawn, never what they hold.

- A road too short to show between two junctions is hidden, and its lanes chained through: the paths and the carried lines follow the hidden roads.
- The merged junction's curb outline is its nodes' own outlines joined along the hidden roads' curbs (`joinedOutline` in `outline.ts`).
- Each approach keeps its control. One going on into a hidden road takes the control at that road's far end.
- A sidewalk's connections are followed either way through the hidden roads, whichever way they were stored.
- Nodes of two sides merged only with each other stay a node of two sides, or don't merge.

`unit/car-only.test.ts` holds car-only graphs to the model recorded in `unit/car-only.json`, so car roads merge and draw as they always have.

## Descriptions

Each drawer hands on a description of one road (`describeRoad`, `road.ts`) or one node (`drawJunction`, `node.ts`): its surfaces, markings, signs, crossings and lane paths as plain shapes in metres, not finished polygons or meshes. That buys three things:

- **One place makes triangles.** `rendering/road-meshes.ts` is the only code that turns shapes into triangles, so layer order, colours and earcut's limits are handled once, and another renderer (3D, say) could read the same descriptions.
- **The drawing can be checked.** `checks.ts` and the unit tests read the descriptions the renderer draws, in Node, without a browser.
- **Pieces are cached.** `Drawing` (`drawing.ts`) keeps one description per node by its key and one per road by its key and end cuts; the renderer rebuilds a piece's meshes only when its description changed.

The car pieces footpaths cross are described once more with their crossings and the lines held traffic stands at (`Drawing.paint`); a car piece nothing lies over keeps its own description.

Nodes are described first, because each says where the paint of every road ending at it stops (`cuts`). Paint is cut by distance and by line, not by clipping painted polygons: a road cuts its lines by distance along it at crossings and end cuts, and a node cuts its lines against the ground paint may cover (`cutLine`, `geometry.ts`).

## The types (`description.ts`)

- `Line`: an open polyline.
- `Ring`: a closed polygon that never crosses itself, wound to a positive area, with no holes. `toRings` (`clip.ts`) slices holed clipper results into rings, because earcut mis-triangulates holes; every ring a drawer emits comes from it. Where it cannot slice, the point is recorded in the description's `faults` and the checks fail.
- `Material` and `Role`: what a surface is made of and what it is for (walk, paving, lane, verge, median). Together they set its layer (`layerOf` in `rendering/road-meshes.ts`).
- `Ribbon`: a strip between two lines of equal point count, never folded. Lane `k` of a road lies between `edges[k]` and `edges[k + 1]`, so neighbours share points. `ribbonOf` (`geometry.ts`) turns a folded strip into rings instead.
- `Surface`: a role and material over a ribbon or rings, the lane it is (if any), and its hatch bars, already clipped.
- `Marking`: a painted line's middle, its colour and dash, and its distance `along` at each point, which sets the dash rhythm. A piece cut from a longer line keeps that line's rhythm.
- `Sign`: the bar across a lane that goes nowhere, a stop line, a yield line, or a turn arrow.
- `Crossing`: its middle line, its runs (zebra stripes, sidewalk paving, a refuge in a median), and its body, where markings stop and which must stay one piece.
- `LanePath`: one connection's path across a node, with its kind, line and widths.
- `EndCut`: where a road's paint stops at one end, where a median stops in its nose, and the ground of a node's walkway over its mouth that its paint stops short of (`clear`).
- `RoadDescription`: the sampled path, the cross-section at the start, the lane edges, the surfaces, markings, signs and crossings, the ground cleared for lines held traffic stands at (`cleared`), the two end cuts, and faults.
- `NodeDescription`: the road ends; the curb outline (rings, the curb between neighbouring ends, the mouth across each roadway); paths, surfaces, markings, signs and crossings; `cleared`; each approach's control, badge and arrow count; each corner sidewalk's middle line (`walkways`); faults.

## The node drawer (`node.ts`)

The node drawer forks at `linkSides` (`ends.ts`): `lanesAcross` where lanes cross from one side to the other (two roads, or roads attached at an edge), `roadsMeeting` at a junction. `TAPER` in `geometry.ts` holds every number that shapes a taper or bend. Corner sidewalks and walkways are built in `corners.ts`, each approach's signs in `approach.ts`, from the plans `holds.ts` decides ([crossings.md](crossings.md)).

## Lane lines (`lines.ts`)

One rule says what goes between two neighbours across a row of slots (a `Slot` is a span with a kind and, for travel, a direction). Its table is at the top of the file, the one place to change which line goes between two neighbours.

- A road passes its lanes once (`laneLines`).
- A node of two roads passes the car paths across it at each station and chains each station's marks into lines (`pathLines`).
- Where roads are attached at an edge the paths don't all run the same way across (one turns off square while its neighbour carries straight on), so each path is read on its own: at every point along it, the paths whose drawn lanes its cross-section meets there make its row (`linesBeside`).
- Two-way lanes take no path across a node, so they get no line there.
- Whatever carries a lane, a curb or a line on from a road end leaves along `EndFrame.run` (`geometry.ts`): the road's direction turned by its lean, where it is shifted differently at its two ends. So a line a node carries on from a road starts on the end of the road's own line and the two are one line.

Which lines run on through a junction is decided where the junction is drawn: at a node of two sides every line runs across; a road carried past side roads that only join it keeps each line that pairs with the far end's and that no turning path crosses (`carry.ts`); a free priority road keeps its dashes and edge lines where nothing crosses or runs beside them (the priority-road block in `node.ts`); elsewhere lines stop at the junction.

## Walkways and car lanes

Wherever car lanes cross a walkway, the walkway carries on over them as a zebra crossing, stripes laid along the traffic, and the sidewalk itself stops at the lanes' edge. It is never paved over them and never just stops. No road is a driveway. A node's own walkways cross in `crossingOver` (`corners.ts`); footpaths cross in `crossingsOver` (`overlay.ts`, [crossings.md](crossings.md)). A node's own walkways that cross are:

- A junction's corner sidewalk passing the mouth of a road with no sidewalk of its own. Round a road with curb corners it follows the corners and crosses at the mouth, a landing either side. Past a narrow road that stops on the curb line (`stopsOnCurb` in `core/setbacks.ts`) it runs straight on along its own road's curb and crosses whatever asphalt lies in its line, however that road is slanted.
- A sidewalk carried across a node of two sides that a lane cuts through: a road attached at the edge of a road with sidewalks (`lanesAcross` in `node.ts`). These crossings belong to the node. A crossing the user can move or switch off (`crossings` in a node's stored junction) lies across one road between two of its own sidewalks, which a lane with none cannot hold.

## Roads attached at an edge

- A road attached at the edge of one that carries on joins the lane at that edge and nothing else, whatever its own lanes (`sideConnections` in `connect.ts`). A two-way street ended on an avenue's edge turns into and out of the near carriageway and leaves the median whole.
- Across a node of two sides the paving lies between the outermost roadway lanes that run between each two road ends (`outlinesAcross`, `outline.ts`). Two roads make one such pair. A road attached at an edge makes another with each road it joins, and what lies between two pairs is ground: only lanes are paved, never the gore between a road and one leaving it, but for the seam between two paths still within 0.6 m of each other (`linesBeside`).
- The node reaches along the attached road until none of its width lies over the roads it joins, sidewalks and verges included, and along two roads attached side by side until they are apart (`clearOf`, `core/place.ts`). So every place its lanes cut through them is the node's to draw.

Two things there are deliberate, not gaps to fill. The attached road's own sidewalks stop at its mouth: pedestrian lanes join another road's only where the user connects them. And the crosswalks over its lanes are automatic, with no handle to move them or switch them off: to cross somewhere else, the user drops the sidewalk from that stretch of road and routes the path by hand.

## Meshes (`rendering/`)

`rendering/road-meshes.ts` turns each description into triangles per layer and colour, and `RoadRenderer` (`rendering/road-renderer.ts`) makes the meshes, rebuilding only pieces whose description changed. Every piece lies in one plane: layers are a painting order (`renderOrder`), not heights, so no seam shows at a tilt.

## Drawing rules (`checks.ts`)

`check` reads every description of a built place and reports what breaks these rules:

- Paint stays on asphalt: inside roads and outlines, never on grass, concrete or sidewalk; hatching stays off car paths.
- Sidewalk never lies over car lanes or a node's paving, neither a sidewalk's surface nor the paving of a crossing; and wherever car paths cross the line of a sidewalk carried across a node, a crossing covers them.
- Lane lines never cross each other, and end where paint stops (a stop line, a crossing, the ground cleared for a line, or the outline), not in the middle of the asphalt.
- Nothing opens between a road and its node: no hole across the roadway at the mouth, no open seam at a lane edge, no thin crack round a node or bare ground inside its outline, and no bare ground between the ends of footpaths meeting, which have no outline.
- Sidewalk has no spikes, no outer corner sharper than 30°, but where it ends on the edge of its own crossing. The sharp tip of a hole in it (open ground closing to a point between two footpaths crossing at a shallow angle) is a notch, not a spike.
- A crossing is one piece with no holes.
- An approach that takes arrows (where traffic stops, or a lane can't go straight on) has one on each such lane wherever its own road has room for them behind its paint and the crossings there.
- No marking of one approach (its arrows, stop line or give-way teeth, whichever piece draws them) lies on another of its own or anywhere on a crossing's body, between its stripes too, each shrunk a centimetre first. Nor does any other paint: no lane or edge line and no hatching lies on a crossing.
- A stop line or give-way row that is described has paint: a row too narrow for one tooth draws one as wide as the row.
- Looking from a stop line or give-way teeth the way its traffic drives, the first crossing ahead is the one it stands for, and between them lies no other line for that traffic and no end of a lane line.
- Every ring is simple and wound positively, no ribbon is folded, and no fault is left.
- One owner per ground: nothing is drawn twice over the same ground in one layer. Each of two surfaces is shrunk 3 cm first (a junction's corners are drawn 1 cm wider), and between two footpath pieces, never drawn wider, half a centimetre: so a lap is reported where it is more than 6 cm across, or between footpaths more than 1 cm, and covers over 0.05 m². Within one crossing its paving may lie under its own stripes, which are another layer. Two laps are drawn on purpose and allowed: a junction's corner sidewalks and verges run a seam back over its roads' own, and footpaths, strips paved up to their nodes (or to where a bend takes them over) with their joints paved over them there, lap each other from a node they both end at outward. Of the ground two footpath pieces both cover, a piece is their lap only where it reaches the end of each at one node they both end at that is no bend (each strip's cross-section there, with the other strip's where a fill there joins just the two; a fill's are those of the strips it joins); a bend's two strips may lap within the bend's own ground alone. Any other piece is reported: one away from every node they share, one reaching the end of only one of them there (a footpath brought back over another's end), and any between footpaths ending at two nodes that lie at one spot, which share no node.

The unit tests run it on their graphs, and the jitter test (`unit/jitter.ts`) on every frame; what that test excludes is listed under "Known drawing bugs" in `backlog.md`.

## What is cached

Editing cost stays proportional to what changed. On the car side:

- The Graph logs every write to a node or segment (`Graph.changesSince`), and `Networks` keeps the car roads' part of the graph from build to build, reading again only the nodes and segments written (`carsOf` in `core/networks.ts`). `PlaceBuilder.build` reads again only what those writes reach, stage by stage (the comment above `PlaceBuilder.model` lists each stage's reach): the lines and curves of the segments written and of those they place at an edge, the roads they are part of, both ends of each, the nodes one road away whose room a changed setback or taper reads (`roomOf`), the shapes of the roads at all of those, their junctions, crossings and road ends, and the merge groups any of it reaches. With nothing written to a car road and the hold the same it is the last build's model, the same object, and `Drawing` draws the same model as it did. A graph that logs nothing is read whole.
- `PlaceBuilder` caches by key each segment's curve, joined roads' curves, attached ends and road shape, two-road nodes' connections and tapers, junctions and their setbacks, default crossings, and the merge test while its road links two junctions and is shorter than the merge limit (`TOUCH_REACH`), and each cross-section's curb while a road end has it. Merging reads again only the junctions joined to one read again by roads too short to exist (`tooShort` in `merge.ts`) and those they merged with in the last build, each old group's members once: a set of junctions so joined merges among themselves as among all. Footpaths put in another place in the graph's order (a footpath cut in two) leave the car roads' order as it was (`Changes.reordered`).
- `PlaceBuilder.lines` and the footpaths' lines in `Networks` keep one shown line per segment while what it is made of stays the same (`lineFrom` in `core/road-line.ts`), which the move check reads. Both are a `LineBook`: changed in place, only for the segments written, it hands the move check views of itself as it stood (`Networks.shown`), each keeping for itself the lines written over since, so neither a build nor a view copies the map. The move check takes one per press and releases it when the press settles, so a write walks only the views in hand, whatever the runtime has yet to collect; it reads each frame's roads straight off the lines (`Networks.showing`). `Networks.build` reads again the footpaths' lines and their crossings' controls only for the segments written and those at a node written.
- `Drawing` caches each node's description by its key and each road's by its key and end cuts, and a painted car piece by those and the keys of the footpath pieces crossing it. Where nothing of the car roads was drawn again since the last paint (a footpath edit), `Drawing.paint` looks only at the pieces whose boxes meet what was laid over them that came or went (found in grids it keeps), the pieces their crossings' decisions reach, and the roads ending at a junction painted afresh, and `Networks.build` keeps the car pieces filed as they were.
- Some readers of a long road near one spot read only that much of it: the nearest point of a path (`project` in `geometry.ts`, through a tree of boxes round runs of its pieces kept with the path), a point along it (`pieceAt`), and the ground traffic is held on and a crossing's stretch of roadway (`stripNear` in `geometry.ts`, for `laneNear` in `holds.ts` and `stretchOver`; a strip's edges kept with the road's sampled path). Each cuts the road where a piece lying further off begins, so near the spot it reads the road's own points. A path across a node is read only where its box meets the crossing's (`wayNear`).
- `stripNear` is the rule to rounding, not to the millimetre: what is drawn from it has the same pieces, rings and vertex counts as with the strip read whole, every coordinate within 5 mm. Clipper is not local: it sweeps every vertex of an operation in one pass and places each crossing of two edges within the band of that sweep, so cutting far points off a strip moves a point of the result a millimetre or two now and then (a marking's end beside a crossing, say). Reading the strip whole would give back most of what reading it near saves.
- Others read the road whole, each a cost that grows with the road's length. The ground a footpath is laid over and a crossing is cut from is read whole (`underOf`, kept per description, its unions kept per set of pieces below: `mergedOf` in `overlay.ts`): cut, it could draw two crossings as one at a median's nose, not only move a point. Also whole: describing a road afresh with what is laid over it (`describeRoad`), the roadways crossings are placed on (`roadwaysOf` in `core/runs.ts`, walked and sampled piece by piece on every read), a footpath tested for crossings against a roadway (`stretchesOf`: every half-metre of the footpath, whole, wherever its box meets the roadway's, the backlog's entry on it), where a footpath meets a roadway's middle (`onMiddle`), which way traffic runs under a crossing (`trafficAt`), the connection overlay (`onPaving` and `walkable` in `rendering/links.ts`), and a pointer's reads of a sidewalk or a car lane (`walkAt`, `walkwayOf`, `onCarLanes`, `onGround`).
- `unit/long-roads.test.ts` holds a drag's work by counting the points handed to Clipper (`clipped` in `clip.ts`, every array of points handed to it, counted only while a test turns it on; with it off nothing is written): what is read whole is counted apart (`wholly`), and the rest must not grow with the road's length. `unit/drag-cost.test.ts` holds each kind of drag in the neighbourhood example to as many reads with a copy of it pasted beside it (`visited` in `core/place.ts`, `viewed` and `filed` in `core/networks.ts`, `LineBook.written` and `LineBook.walked` in `core/road-line.ts`, `looked` in `road-model/drawing.ts`, `ringsPlaced` in `rendering/node-renderer.ts`, counted the same way), a footpath drag or cut to the car model already built, a merged junction's reads to one pass over its group, and the car roads to a fresh build's drawing through every kind of edit and its undo.
- Still read whole on every car build that changed anything: the lists `PlaceBuilder` hands on (`Place.roads`, `hidden`, `junctions`) are copied whole, `Drawing.build` and `Drawing.paint` pass over every piece, and `Networks.build` files every car piece again. On every build, a footpath edit's too, `Networks.build` copies the car and footpath lists and roads into the place it hands on, and with connections shown the overlay (`refreshOverlay` in `rendering/road-renderer.ts`) reads every piece. Moving a node draws again every junction whose roads it reshapes, its neighbours' too (about 4 ms each for a junction of four or five avenues and streets with corner sidewalks and crossings, most of it Clipper work on the corners).

## Left for later

- Curbs: a description does not say which edges are real curbs and which are only where a surface was sliced, which 3D needs.
- A lane network: lane paths are tied to their connections, but nothing joins them with the roads' lanes into one network, and two-way lanes have no path across a node of two roads.
- More networks laid over these: bike paths, rail.
- Corner sidewalks are built by polygon clipping, the slowest part of a junction and the source of most known drawing bugs.
- Heights, bridges and overpasses: everything is drawn flat.

These are under "Next projects" in `backlog.md`.
