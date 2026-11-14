# How the road model is drawn

`PlaceBuilder` (`src/lib/core/place.ts`) reads the graph into the road model (`src/lib/road-model/model.ts`): roads with one cross-section each, and junctions of road ends with their connections, walkways and approach controls. This page covers what happens next, in `src/lib/road-model/`.

## Descriptions

Each drawer hands on a description of one road (`describeRoad`, `road.ts`) or one node (`describeJunction`, `node.ts`): its surfaces, markings, signs, crossings and lane paths as plain shapes in metres, not finished polygons or meshes. That buys three things:

- **One place makes triangles.** `rendering/road-meshes.ts` is the only code that turns shapes into triangles, so layer order, colours and earcut's limits are handled once, and another renderer (3D, say) could read the same descriptions.
- **The drawing can be checked.** `checks.ts` and the unit tests read the descriptions the renderer draws, in Node, without a browser.
- **Pieces are cached.** `Drawing` (`drawing.ts`) keeps one description per node by its key and one per road by its key and end cuts; the renderer rebuilds a piece's meshes only when its description changed.

Nodes are described first, because each says where the paint of every road ending at it stops (`cuts`). Paint is cut by distance and by line, not by clipping painted polygons: a road cuts its lines by distance along it at crossings and end cuts, and a node cuts its lines against the ground paint may cover (`cutLine`, `geometry.ts`).

## The types (`description.ts`)

- `Line`: an open polyline.
- `Ring`: a closed polygon that never crosses itself, wound to a positive area, with no holes. `toRings` (`clip.ts`) slices holed clipper results into rings; where it cannot, the point is recorded in the description's `faults` and the checks fail.
- `Material` and `Role`: what a surface is made of and what it is for (walk, paving, lane, verge, median). Together they set its layer (`layerOf` in `rendering/road-meshes.ts`).
- `Ribbon`: a strip between two lines of equal point count, never folded. Lane `k` of a road lies between `edges[k]` and `edges[k + 1]`, so neighbours share points. `ribbonOf` (`geometry.ts`) turns a folded strip into rings instead.
- `Surface`: a role and material over a ribbon or rings, the lane it is (if any), and its hatch bars, already clipped.
- `Marking`: a painted line's middle, its colour and dash, and its distance `along` at each point, which sets the dash rhythm. A piece cut from a longer line keeps that line's rhythm.
- `Sign`: the bar across a lane that goes nowhere, a stop line, a yield line, or a turn arrow.
- `Crossing`: its middle line, its runs (zebra stripes, sidewalk paving, a refuge in a median), and its body, where markings stop and which must stay one piece.
- `LanePath`: one connection's path across a node, with its kind, line and widths.
- `EndCut`: where a road's paint stops at one end, and where a median stops in its nose.
- `RoadDescription`: the sampled path, the cross-section at the start, the lane edges, the surfaces, markings and crossings, the two end cuts, and faults.
- `NodeDescription`: the road ends; the curb outline (rings, the curb between neighbouring ends, the mouth across each roadway); paths, surfaces, markings, signs and crossings; each approach's control and badge; the cut it asks of each road; faults.

## Lane lines (`lines.ts`)

One rule says what goes between two neighbours across a row of slots (a `Slot` is a span with a kind and, for travel, a direction), and its table is at the top of the file. A road passes its lanes once (`laneLines`). A node of two roads passes the car paths across it at each station and chains each station's marks into lines (`pathLines`). Where roads are attached at an edge the paths don't all run the same way across (one turns off square while its neighbour carries straight on), so each path is read on its own: at every point along it, the paths whose drawn lanes its cross-section meets there make its row (`linesBeside`). Two-way lanes take no path across a node, so they get no line there.

A line a node carries on from a road starts on the end of the road's own line and leaves the way that line runs (`EndFrame.run` in `geometry.ts`: the road's direction turned by its lean, where it is shifted differently at its two ends), so the two are one line.

Which lines run on through a junction is decided where the junction is drawn: at a node of two sides every line runs across; a road carried past side roads that only join it keeps each line that pairs with the far end's and that no turning path crosses (`carry.ts`); a free priority road keeps its dashes and edge lines where nothing crosses or runs beside them (the priority-road block in `node.ts`); elsewhere lines stop at the junction.

## Walkways and car lanes

Where car lanes cross a walkway, the walkway carries on over them as a crossing, zebra stripes laid along the traffic, and the sidewalk itself stops at the lanes' edge. It is never paved over them and never just stops. `crossingOver` (`corners.ts`) is the one place that crossing is made, for all three ways it comes about:

- A junction's corner sidewalk passing the mouth of a road with no sidewalk of its own. Round a road with curb corners it follows the corners and crosses at the mouth, a landing either side. Past a narrow road that stops on the curb line (`stopsOnCurb` in `core/setbacks.ts`) it runs straight on along its own road's curb and crosses whatever asphalt lies in its line, however that road is slanted.
- A footpath across a street.
- A sidewalk carried across a node of two sides that a lane cuts through: a road attached at the edge of a road with sidewalks (`lanesAcross` in `node.ts`). These crossings belong to the node. A crossing the user can move or switch off (`crossings` in a node's stored junction) lies across one road between two of its own sidewalks, which a lane with none cannot hold.

## Roads attached at an edge

Across a node of two sides the paving lies between the outermost roadway lanes that run between each two road ends (`outlinesAcross`, `outline.ts`). Two roads make one such pair. A road attached at an edge makes another with each road it joins, and what lies between two pairs is ground: only lanes are paved, never the gore between a road and one leaving it, but for the seam between two paths still within 0.6 m of each other (`linesBeside`). The node reaches along the attached road until none of its width lies over the roads it joins, sidewalks and verges included (`clearOf`, `core/place.ts`), so every place its lanes cut through them is the node's to draw.

Two things there are deliberate, not gaps to fill. The attached road's own sidewalks stop at its mouth: pedestrian lanes join another road's only where the user connects them. And the crosswalks over its lanes are automatic, with no handle to move them or switch them off: to cross somewhere else, the user drops the sidewalk from that stretch of road and routes the path by hand.

## Drawing rules (`checks.ts`)

`check` reads every description of a built place and reports what breaks these rules:

- Paint stays on asphalt: inside roads and outlines, never on grass, concrete or sidewalk; hatching stays off car paths.
- Sidewalk never lies over car lanes or a node's paving, neither a sidewalk's surface nor the paving of a crossing; and wherever car paths cross the line of a sidewalk carried across a node, a crossing covers them.
- Lane lines never cross each other, and end where paint stops, not in the middle of the asphalt.
- Nothing opens between a road and its node: no hole across the roadway at the mouth, no open seam at a lane edge, no thin crack round a node or bare ground inside its outline.
- Sidewalk has no spikes, no outer corner sharper than 30°, but where it ends on the edge of its own crossing.
- A crossing is one piece with no holes.
- Every ring is simple and wound positively, no ribbon is folded, and no fault is left.
- One owner per ground: nothing is drawn twice over the same ground in one layer.

The unit tests run it on their graphs, and the jitter test (`unit/jitter.ts`) on every frame; what that test excludes is listed under "Known drawing bugs" in `backlog.md`.

## Left for later

- Curbs: a description does not say which edges are real curbs and which are only where a surface was sliced, which 3D needs.
- A lane network: lane paths are tied to their connections, but nothing joins them with the roads' lanes into one network, and two-way lanes have no path across a node of two roads.
- Corner sidewalks are built by polygon clipping, the slowest part of a junction and the source of most known drawing bugs.
- Heights, bridges and overpasses: everything is drawn flat.

These are under "Next projects" in `backlog.md`.
