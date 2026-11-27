# Footpaths

A footpath is any segment with no car lane. Footpaths are a network of their own (`core/networks.ts`), built by `Footpaths` (`core/footpaths.ts`), never by `PlaceBuilder`, and drawn as if the car roads were not there. Then each footpath piece is laid over the car ground. This page covers how strips, bends and joints are built, how they are laid over the cars, and how a footpath end joins a street's walkway. Where a footpath crosses a car road is in [crossings.md](crossings.md).

## Strips

- A footpath segment is a strip: its lanes side by side at their widths, along the line it shows on (`core/road-line.ts`: its curve, and its shift blending from one end to the other), square to that line at each end.
- No taper or setback a car road takes applies to a strip. Strips never merge, never carry on through a node as one road, and never attach at an edge.
- A footpath saved attached at an edge reads as joined at its node (`endAt` in `core/attach.ts`).
- A strip is paved right up to its nodes, except where a bend stops it short. So widening one segment changes that strip and the bends at its ends alone.

## Bends

A node of exactly two footpaths, lying on no car road's dead end and on no sidewalk, is a bend. It is drawn the way a street's bend of two roads is.

- Both strips stop the same distance short of the node (`bendCut`): R tan(deflection / 2), where R is `TAPER.BEND_RADIUS` half widths of the wider footpath and the deflection is read no sharper than `TAPER.SHARPEST`. That is the rule `linkSetbacks` in `core/setbacks.ts` gives a street's two roads.
- The cut is never less than `TAPER.THROUGH_GAP`, nor less than half the length easing from one width and place to the other takes at `TAPER.WALK_ALONG_PER_SHIFT` metres along per metre.
- The cut never passes `JOINT.REACH` of either footpath's length. On a short footpath the bend turns tighter, and the bends at its two ends never meet.
- Each cut is read off the two footpaths' whole lines alone, so it changes only when one of them does.
- The bend (`bendOf`) paves the way round between the two strip ends. Its middle line leaves one strip's middle where it stops, along the way that strip runs, and joins the other's the same way on `curveBetween`'s even curve (a circular arc of radius R between two straight footpaths).
- The paving is the middle line's half width either side of it, square to it. The half width eases (`TAPER.EASE`) from one strip's to the other's along the whole bend, so each edge changes one way only.
- At a sharp angle the paving passes inside the node, as a street's does. An inside edge tighter than its half width (a hairpin, or a bend shrunk to fit) folds away into a sharp inside corner, and the bend stays one piece.
- The bend's ends are the strips' own end edges, with every lane edge on them put on its ring exactly.

### A bend that takes its strips over

A bend tighter than its footpaths are wide would leave the two strips lapping each other from their ends out, or lying within `JOINT.APART` of each other: a seam too thin to read as ground (`lapsFrom`). Such a bend takes them over as far as they would lap (`takeOver`).

- Both strips stop that far out. The bend paves along each one's own cross-section from there in to where its turn begins, round the turn and out again, and the ground between the two, as one piece. No ground is paved twice and no thin seam opens.
- It takes a footpath over no further than `JOINT.REACH` of its length where the footpath's far node holds two footpaths (a bend there, which stays apart from this one), and all of it but `JOINT.STUB` anywhere else (`takeOverCap`).
- How many footpaths meet at a node is read again at the far nodes of its footpaths whenever one comes or goes.
- `checks.ts` lets a bend's two strips lap within the bend's own ground alone.

## Joints

Where three or more footpaths meet at a node, the ground between them is paved as one joint (`fillOf`), whatever their widths and angles. No strip changes for it.

- The joint is the smallest convex shape holding each footpath's cross-section there.
- Each corner's outside (the way round between two neighbours wider than straight on) is paved round the node as far out as they are half wide.
- Each corner's inside is rounded by a circle touching both edges, `JOINT.RADIUS` half widths of the wider across. The circle shrinks where it would reach past `JOINT.REACH` of either footpath's length, or past where either runs straight on from the node. The corner is read along the line each footpath leaves the node on, which a curve soon leaves.
- A corner that would be rounded tighter than `JOINT.TIGHTEST` stays sharp: strips meeting at a shallow angle cover each other there.
- Nothing is edited at a bend or a joint: there is no handle and no stored setback.

## Walkers' lines

Each bend and joint holds, for each two footpaths meeting there, the line a walker follows from one to the other (its `paths`, of kind `walk`, drawn as wide as the paving it runs down).

- A bend's line is its middle line, run on along each strip's middle from `JOINT.LINK` out (or from where the bend starts, if that is further).
- A joint's line runs along each footpath's middle from `JOINT.LINK` along it, turning on a circle touching both middles halfway between the node and the inside rounding. Where two run straight on, it runs straight through their ends.
- The connector draws its links along these lines (below).

## Footpath nodes on car ground

- A footpath node joins a car road's dead end where its ends show on it: its fill holds that road's sidewalks too, carried on past the road's end as far as the widest footpath there is wide. The car road stays where it is. The join is decided at each spot where the node's ends show, by one rule (`deadEndAt` in `core/networks.ts`): the spot joins the one car road end showing there, and nothing where there are two or more (two car roads ending, unjoined, at one spot, or a car node more roads end at). A node with no shift has one spot, where it shows. A node whose ends show apart has one spot for each end, so it can join two dead ends, one at each, and holds both. Each end is read where it shows, shift and all, never the node, nor the middle of ends its footpaths' shifts show apart.
- A footpath node whose footpaths all end, where they show, on a car road's sidewalk is no fill, however many footpaths it holds. Each ends there whole, as a lone end does, and so joins that sidewalk (`onWalk`).
- A footpath end beyond a dead end lies on no ground.

## Laid over the car roads

Each footpath piece (strip, bend or joint) is laid over the car pieces whose boxes meet its own (`layOver` in `road-model/overlay.ts`):

- Over a sidewalk it is that sidewalk: its own paving is cut away there.
- Over a verge it is walk paving, which crosses no traffic (`Crossed.traffic`).
- Over car lanes or a median nothing of it is drawn. There it is a crossing, if a run across the roadway makes one ([crossings.md](crossings.md)).

## Ends on walkways

A walkway is a street's sidewalk, a sidewalk a junction carries on, or a junction's corner sidewalk (`NodeDescription.walkways`). A walkway down a street's middle counts as much as a sidewalk at its side.

- Each free footpath end lying on a walkway, however near the curb, is recorded in `Derived.sidewalks`, by its node: one entry for each footpath ending there so, the one the node is held by first. An entry holds the footpath, the road, the sidewalk lane, the station along the road, and the line a walker follows from along the footpath's middle onto the walkway's middle there (`walkOnto` in `core/footpaths.ts`).
- On a corner, `walkAt` in `road-model/overlay.ts` picks the corner whose middle line comes nearest and names it by the lane it joins nearer the end.
- To a footpath, a street's sidewalk and the corner sidewalks it runs into at its ends are one walkway (`walkwayOf` in `modes/picking.ts`). An end on a corner lies on both streets' sidewalks it joins (`oneWalkway`). A street's sidewalk stops `END_IN` short of an end no corner runs on from, so an end on it lies on it.
- A footpath node with an end on a walkway is joined to that walkway (`joinedTo` in `modes/picking.ts`). The join is read off the drawing and never stored.
- A node with several ends on walkways is held by one, whose walkway it slides along, keeps to when it is drawn anew, counts as its corner and rides a street by: at a node with a shift, the end of its widest footpath, and of those as wide the one showing furthest west, then south, then by its walkway (`heldFirst` in `core/networks.ts`). The drawing decides it, never the footpaths' ids or the order they were drawn in. So a 2 m path and an 8 m path shifted to run on from it, both ending on one sidewalk, slide and ride with the wide path's end on the sidewalk's middle. At a node with no shift the footpath whose id sorts first holds it, as before footpaths took a shift.
- Selected, or at an end of a selected footpath, a joined node shows each footpath's line onto its walkway (`Editor.joins`, read as `__editorLook().joins`).
- A join comes off only when the node, its footpath, its street or the walkway itself is deleted.

### Moving a joined end

- Moved itself (alone, with its footpath, or in a group), a joined node slides along the walkway it was joined to when the press began, at its middle as that press found it drawn (`slide` on `joinedTo`'s result; `carriedBy` in `core/drag.ts`). Its footpath's end shows where the move takes it, shift and all; the node goes where its shifted end lands (`endsAt` in `core/road-line.ts`). Where the move may take that footpath's far node too (both its ends dragged, or the far node riding), the node keeps as far from its end as when the press began instead, never placed against the far node (`placedBy` in `core/drag.ts`, [editing.md](editing.md)).
- From a street's sidewalk it slides along it and onto the corners its ends run into. From a corner it slides along it, both streets' sidewalks it joins, and their corners.
- One drag goes no further: going past a corner onto the next street's sidewalk takes a second drag, once the end lies on the corner.
- A sliding node never drops onto another node. Shift's snaps shape its footpaths but leave it on the walkway.
- Moved with its street, or when the street alone is moved, reshaped or shifted, an end on a street's sidewalk rides the street as any footpath node with an end showing on its ground does (`ridersOf` in `core/drag.ts`). An end on a corner rides no road of its junction.

### Following a redrawn walkway

Whatever else draws an end's walkway anew under it while its node was not moved itself (a road of the junction moved, a lane edit, a setback, a road added to or removed from the junction, a road beside it cut), each build of that edit puts the end back on that walkway as redrawn and on no other (`Editor.followWalkways`, `followWalkway` in `modes/picking.ts`). In a press, only the ends joined to a walkway as the press began follow (`Moving.joined`, filled in by `Editor.noteWalkwayChanges`), a setback or taper handle's press included: an end a walkway sweeps over during the press (a street swung across it) stays where it lay. In a press, "moved itself" means dragged or riding (`Moving.placed`), never that its end shows elsewhere, which a shifted end does as its far node moves; outside one, it means its end shows elsewhere. Each node is placed as a gesture places it (`placedBy` in `core/drag.ts`), what the press in hand may move (`Editor.moving`) and every end following counted as moving. A node with no shift goes where its end keeps its place on the walkway, from build to build, as before footpaths took a shift. A shifted node keeps the place on the walkway its end held as the press began (`Moving.walked`): one whose far node lies still goes where its end shows there; one whose far node may move is carried, moving as far as that place has since the press began, reading nothing of the other node or of how the footpath now lies. A curve with both nodes moving and one of them kept to a walkway is placed only after the follower, in the frame of its nodes as the press began (`bentAfter` in `core/drag.ts`, `Moving.frames`). So a junction moved bodily carries a footpath between its corners, or from a corner to a street riding with it, exactly, however many builds the press took. The walkway is found by where it lies, never by the ids of the roads beside it, which a cut renames.

- On a corner: the corner of the junction now drawn at the same car node whose two ends each lie within `TURN` of where the old corner's did, seen from that node (`roundAgain`). The end keeps the same fraction of the way round.
- On a street's sidewalk: that sidewalk lane of every car road now drawn that carries it on where the street did, the corners it runs into included (`sidewalkNow`, `laneThrough`), as every piece a cut leaves of the street does. The end goes where that comes nearest where it joined.
- Where the walkway is drawn no more (the corner gone, the street deleted, the lane retyped or removed), the end stays where it is, joined to nothing. It is never pulled onto a walkway beside it.
- Every node the follower moves, and every curve it places, belongs to the edit: saved in its one undo step, or put back with it when the edit is taken back without one (a refused move: `Editor.putBackFollowed`). A cancelled gesture or a history step restores the graph whole. No later click or build finds a move waiting.
- A build that puts a graph in place (a history step, a city opened) moves no node.

## The connection overlay

The overlay the toolbar's connections button shows (`LinksReader` in `rendering/links.ts`) reads the build and changes nothing in it. Blue is a way to drive: each car movement through a node, with a dot on each lane end. Orange is a way to walk, and every walking link a footpath has is drawn, but only on ground a walker has: a footpath's walk paving as it is laid over the cars, and a crossing's paint (`walkable`). Its lines are the model's:

- each footpath strip's middle, where it has a walk lane, up to where a bend's line or an end's line onto a walkway takes over;
- the walkers' lines through each bend and joint (above), where it has walk paving, each sidewalk a car node of two sides carries across, and each corner sidewalk a junction carries round its corners, along its middle and over any road's mouth it crosses on the way (`NodeDescription.walkways`);
- each end on a walkway, along its line onto the walkway's middle;
- each run of a crossing, one line from where the footpath's line reaches the asphalt to where it leaves it, on the crossing's paint (crossings.md). A footpath through a junction has no crossing there, so no line over the junction: its own line stops at the asphalt each side.

The lines of one footpath join up: a strip's line, a crossing's, a link's and an onto-line meet end to end where one runs on as another. As the model walks a footpath down the middle of its whole cross-section, a footpath with a grass verge beside its walk lane has its line down the middle of the whole path, over the verge (backlog.md).

Where a footpath lies over car lanes or a median, which layOver draws nothing of (`asphaltOf` in `rendering/links.ts`, read as `layOver` in `road-model/overlay.ts` reads it), its own lines stop, and only a crossing's line runs there. Both are cut at the same edge, the asphalt grown by 2 mm, so they meet at the curb, and a crossing's line lying along the asphalt's edge (a path straight across a dead end) is kept. A footpath along a street's lanes with no crossing has no line there. Where runs of one footpath's crossings lie over one stretch of ground (two roads meeting at a bend, each with a run across), the first draws its line there (`lessLapped`), so no two of a footpath's lines run side by side.

An orange dot stands for every join of a footpath to a car piece's walkway:

- an end on a walkway, which the build records (`Derived.sidewalks`): where its line onto the walkway arrives on the walkway's middle;
- a footpath's paving sharing an edge with a car road's sidewalk at the road's dead end, which the build joins, laying the footpath over the sidewalk there or, from a footpath node on the dead end, carrying the sidewalks on past it (`fillOf`): at the middle of the stretch of the sidewalk's end the paving reaches (`deadEnds`), unless the footpath is joined to that sidewalk on its paving already;
- a footpath passing over a walkway, of which the build keeps no fact: wherever one of its orange lines crosses the walkway's middle where it is drawn (`joinsOf`).

Points within a dot's radius of one are that dot, as where the links through a joint fan across a sidewalk.

It is read only while it is shown, through `Scene.walking()`, which hands over what the build holds (`WalkedCrossing`: each crossing's runs' bands, its ground and the car pieces it is laid on, kept with the crossing held; the car pieces filed near a box; what of a car piece a footpath laid over it is drawn on) and works nothing out until asked. Hidden, or once a city is cleared away, it keeps nothing it read. The footpaths' part is read a unit at a time (each strip with its crossings' lines and dots, each bend or joint, each node's ends on walkways), and a unit is read again only where what it is read from is not the same object as last time: its paving, the bend and the ends on walkways at its nodes, its crossings' runs, their footpaths' paving and the car pieces they are laid on as drawn (with their paint), and the car pieces within `READ` (2 cm) of its lines and paving (and which of their ends are dead ends). `READ` is also how far a dead end's dot looks past the paving, so the cache watches all a unit reads. So a drag reads again only the footpaths near it. Each line is read a grid cell at a time, against the car pieces and their walkways' middles filed in `BoxGrid`s, so a long path reads only what lies along it. The renderer keeps each line and dot it drew while the points it was drawn from are the same object, and shares one material of each colour and one geometry for each size of dot.

## The connector on a footpath node

The connector opened on a footpath node (two or more footpaths, or an end on a sidewalk) edits nothing. It shows each footpath there joined to every other its paving meets and to the walkway its own end lies on, each link drawn along the walker's line the model holds (`footpathJoin` in `modes/connector.ts`; `__editorLook().connector` lists what it shows).

- At a bend or joint, every two footpaths are joined, along the line it paves between them.
- Of ends on walkways, two are joined only where both lie on one walkway (two on one corner included, whichever half each is named by) or where their cross-sections meet. Two ends on a street's opposite sidewalks are joined to their own walkway alone, and no line runs across the asphalt.

## What is cached

A build reads nothing of a footpath far from a change but what each strip's cache compares.

- `Footpaths` compares each footpath's nodes, where they lie, its curve's handle, its shift and its cross-section with what its shape was drawn from, on every build (about a microsecond a footpath), as `PlaceBuilder` does each car segment's key.
- It reads again only the nodes of shapes drawn afresh or gone, and those near a car piece that came or went. It draws again only the strips there whose bend cuts changed, and fills again only those nodes and the nodes of the strips drawn again.
- `Networks` lays a footpath piece over the cars again only when its description or its free ends changed (each compared as the same object or not), or a car piece near it came or went, found through a grid of the footpath pieces' boxes (`BoxGrid` in `road-model/overlay.ts`, kept from build to build).
- A piece's description key names its shape, its nodes and, through the road's number, the edits at the nodes it carries on through.
- A footpath's free ends are worked out again only when its shape changed or a fill at one of its nodes came or went.
- What each footpath node reads of the cars (the car dead ends its ends show on, whether its ends lie on a sidewalk) is kept while the strips ending there keep their shape and no car piece came or went near them. Each end, as it shows, lies in the box of its strip paved up to it or of its node's fill.
- While the connection overlay is shown, its reader keeps each footpath unit's lines and dots while the objects it was read from stay the same, and the walkways' middles and grown asphalt of each car piece by its description (`LinksReader` in `rendering/links.ts`); the renderer keeps each line and dot drawn from the same points.
