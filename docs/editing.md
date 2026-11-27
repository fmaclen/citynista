# Editing rules

`src/lib/editor.svelte.ts` owns the graph, scene, renderers, selection and modes (`src/lib/modes/`). This page is the rules a gesture follows: what building connects, what a move may do, the drop that joins, how a press settles, how draw mode snaps, and how a click picks. Every editing path reads a road where it shows (`core/road-line.ts`), so the editor works on the road the user sees.

## Building connects, moving never does

- Only building connects. After a draw or a paste, `resolveCrossings` (`core/crossings.ts`) joins the roads just built to the roads of their kind they cross, or pass over the nodes of, where they show, wherever along either line they cross. Only an end resting on another's line touches it.
- A footpath across a car road joins nothing: its crossing is paint ([crossings.md](crossings.md)).
- A footpath just built, or a piece of one a cut leaves, whose strip as it shows (its width either side of its shown line, shift and all) lies within the strips of the footpaths already there is taken out, with its nodes left holding no road (`dropRetrace`). The path runs on along those. One that leaves their ground anywhere (bowing away, wider than the one it lies along, or shifted off it) stays.
- Car roads may lie two between two nodes; a footpath never does.
- A pasted footpath node laid at a footpath node's spot lands on it where the two also show at one spot, so landing moves nothing drawn. One shifted off where it lies keeps a node of its own (`layPaste`, `shownOffsets` in `clipboard.ts`). The paste's snap onto a node holds to the same.

## What a move may do

A move is a node, a road, a marquee's selection, a curve's handle or a shift's handle dragged.

- A move never changes which nodes and segments there are.
- A move may not lay a road across one of its kind where the two did not cross when the move began (`crossingPairs`, `crossedThere` in `core/crossings.ts`). Each place a pair crosses now must lie within half a metre (`SAME_PLACE`) of a place they crossed then. So a crossing slid along either road is refused as a second crossing of the same two is, and one left where it was is kept.
- Across the other kind a move always goes.
- What is read is every road whose shown line some frame of the move drew anew, whatever moved it: its nodes, its handle, its shift, a footpath riding a car road, or the roads beside an end attached at an edge (`relined`, kept by `PlaceBuilder.lines` and `Networks`). Each is read on its line as shown (`Networks.shown`) against the roads the build filed near that line (`Networks.near`), both ways round.

### Crossing against touching

Lines cross where each passes through the other away from a node they share (`passes` in `core/crossings.ts`).

- A line that comes within 1 cm (`TOUCH`) of another and goes back the side it came from only touches it. So does one resting on it all the way to its end.
- A line passing through a node whose roads leave it to both sides crosses them, whichever of the two moved. Two ways through one spot cross only where one way's roads leave strictly to both sides of the other's (`sideOfWay`). A road leaving along one of the other way's roads lies on it and touches it: a road cut where another's cut shows still crosses it, and one ended there, or two elbows sharing an arm, only touch.
- A road merely reaching into another's width is no crossing.

### A refused move

- While held where it would lay a new crossing, the roads moved that make it show refused (`Editor.showRefused`, read as `__editorLook().refused`).
- Let go there, everything goes back: nothing saved, no undo step, and the selection the press found given back (`putBack`, `undoMove` in `modes/select.ts`). Undo is offered while held only when letting go would keep the move (`Editor.holdsUndo`).

### Cars move footpaths, never the reverse

However a car road is moved (its nodes or the road dragged, its curve's handle, its shift), the footpath nodes on the ground it draws when the press begins ride with it, and only those. That ground is the road's own and the junctions' at its nodes; `Networks.onGround` finds the nodes on it through the build's grids, and `ridersOf` in `core/drag.ts` is the one way every move reads them, once, as the press begins. A footpath node the road reaches during the press stays where it lay, whether the road passes on or is let go lying over it; nor does a walkway reaching it then carry it, since only the ends joined to a walkway as the press began follow it (`Moving.joined`, `Editor.noteWalkwayChanges`). A footpath end beyond a dead end lies on no ground and stays. Ends joined to a walkway follow it instead ([footpaths.md](footpaths.md)).

Every gesture places each footpath node it moves one of three ways, decided once a node as the gesture begins, before anything moves (`placedBy` in `core/drag.ts`), for the end the node is held by first (`heldFirst` in `core/networks.ts`: the widest footpath's end first, so which end carries a joint never depends on the paths' ids or the order they were drawn in). What the gesture may move (`mayMove`) is the nodes dragged and every footpath node on the ground of the car roads it reshapes, of the roads beside them and of the junctions between, which holds every rider.

- **No shift at the node**: it moves as before footpaths took a shift, by where it lies: it rides when where it shows (`nodePoint`) lies on the ground, on the car segment nearest it. `unit/footpaths-as-before.test.ts` holds these to that older editor's graph, and to the drawing the current code makes with the shift work reversed.
- **A shifted end whose far node the gesture cannot move**: the node rides by its end, on the car segment of the ground that end shows on nearest it, and goes where that end shows at its place along and across the road, solved outright (`endsAt` in `core/road-line.ts`) from where things lay when the gesture began, the same however many pointer updates it took. A footpath is never turned round to place its end: where showing it there would turn the footpath more than a right angle both from where it ran when the gesture began and from where the gesture takes a footpath with no shift (its node moved by as much as its end's target), or nothing shows it there, its node moves so.
- **A shifted end whose far node the gesture may move**: the node is never placed against that node, which may yet move. It rides by its end as above, on the arm that end shows on, and is carried: it keeps its own place relative to that road at the spot where its end shows, as a node with no shift keeps its place where it lies. Dragged, it moves by the pointer's travel; sliding along a walkway, it keeps as far from its end as when the gesture began; kept to a corner drawn anew, it moves as far as the spot of the corner its end held when the gesture began ([footpaths.md](footpaths.md)). Such a footpath's curve is placed once both its nodes have their places for the frame, from where they and the handle lay when the gesture began (`bentAfter`). So a footpath moved bodily (its street or the pair dragged, an arm swung about its junction at its length, all the streets or nodes of a T dragged) moves every node and handle exactly as the move did, whatever order its nodes are placed in and however many pointer updates it took. No gesture turns a selection. Where the street is stretched or bent instead, the end stays on its walkway to within its shift times the angle its footpath turned against the road there.

## The drop that joins

A dead end (a node of one road) dragged alone over a node or a road of its own kind shows draw mode's snap marker (`__editorLook().drop`). Let go there, it joins where a draw's finishing click there would end a road of its lanes from its far node, through the same snapping (`createSnapping` in `modes/draw.ts`), as one undo step (`dropAt`, `joinAt` in `modes/select.ts`):

- onto a node, by becoming it, its edits going with it and the node listing its roads in the graph's order (`Graph.merge`);
- onto a road, by cutting it there, at the edge it attaches at, if any.

A drop never joins where its road would retrace one: on its far node, on a node a road of its kind from the far node already leads to, or on such a road. Nor where one-way traffic is met head-on. There is no marker there, and the drag is an ordinary move.

- Held over its marker, the dead end already lies where the drop puts it (`dropped`): its end where the join draws it, at the edge it attaches at, its curve's handle as the join leaves it, and the footpath nodes riding its road carried there (`dragNodes` in `core/drag.ts`). What is drawn while held, what is checked and what is joined are one state, wherever in the snap ring the pointer stopped.
- The drop is judged once, at release, on the graph the join makes, against the roads as the press found them. A road the press's drawing does not show is a piece of the road cut there, read as that road (`piecesOf`). The pieces of the road cut meeting at the cut are the join itself and cross nothing. Any other crossing it lays is refused, one with the road it cuts that moved along it included, and the whole move is taken back.
- While held, the same judgement is previewed (`joined`): the join made in a copy of the roads it edits, every road at their nodes with them (`copyAround`, `laidOver` in `core/trial.ts`), and every road's line read off that as a build reads it (`Networks.shownIn`). Only those roads and the roads they are pieces of are read again, so it costs what the join changes, whatever the map's size.

## How a press ends

- A select drag ends in one place (`settle` in `modes/select.ts`), as a release at its last pointer position: joined at a drop, refused and put back, or kept as one undo step.
- One rule holds every press in every mode that takes a release (select, the connector, bulldoze). Any command given while one is in hand (Save, Undo, Redo, Delete, cut, copy, paste, a tool switched) settles it first (`Editor.settlePress`), so no command meets a gesture half done.
- A press that has moved past `CLICK_SLOP_PX` (`modes/types.ts`) is given its release where the pointer last was. One that has not is taken back as Escape takes it, since a command is no click: a crossing held still is not switched, open ground pressed in the connector does not leave it, and the tool asked for is the tool afterwards.
- A press or a move arriving with the button up is the release that never came, given where the pointer last was.
- Escape takes a press back in any mode (`Editor.cancelPress`): the graph as the newest undo step left it, the mode set up again holding nothing, and the selection the press found.
- Another button let go while the left is held ends nothing.

## Saving and history

- One `graph.save()` is one undo step.
- Save writes the graph as the newest undo step left it (`committed`). What a mode holds that is no step yet (a draw's start on open ground, a sidewalk start with nothing laid from it) is no part of the saved city.
- A history restore sets the mode up again forgetting what it held: its cleanup records and takes back nothing (`discardLastEdit`).
- A lane edit gives the segment a new cross-section rather than changing the old one in place (`editLanes`). What is read off a cross-section is kept by it (`carries` in `core/lane-types.ts`).
- Whatever changes what the next click lays re-enters the mode or redraws its preview (`Editor.enter`).

## Draw mode

### Starting

- A first click on a road of the armed brush's kind cuts it there and saves, one undo step. Escape with nothing laid takes the cut back.
- A first click on a street's sidewalk cuts nothing. Undo takes that start back alone, before anything in the history (`ModeHandlers.undo`).
- The brush switched to the other kind while anchored starts where a click of the new brush at the first click would, the cut left as it is: a footpath on the sidewalk nearest it, or at a node of its own kind at the start node's spot (`switched`).

### Snapping

- Car roads snap only to car roads: nodes, lines, and the edges a car road attaches at (`attachAt`).
- A footpath snaps to footpaths' lines and nodes, never to an edge. On a street it snaps to the walkway under the pointer as drawn, a junction's corner included (`Networks.walkwayAt`); else to the street's walkway nearest (a walkway down the middle as much as a sidewalk), or to the curb of a side with no sidewalk nearer it (`sideOf` in `core/road-line.ts`). Never to a car node or onto a car lane.
- A footpath's end lands on a footpath node lying and showing at the spot it snapped to, whichever snap found it (`landed`), so a path drawn back to its start closes.
- A footpath is never laid between two nodes a footpath already joins (`retraces`), so none has no length.

### Shift lock

With Shift held from an anchor, draw mode keeps the line's angle over a road (`resolveTarget`, `onLockedLine`).

- The locked line runs from the start as drawn (attached at an edge, where the road laid shows it).
- The end lands where the locked line meets what the snap found: a node within its ring, a road's line, a walkway's middle, or the edge the snap attaches at, with the end as it will be drawn lying on the line. A click there connects as that snap would.
- A node whose end attached at an edge would show off the line gives way to the road there, cut where the line meets that edge.
- A drawing that passes the checks outranks an exact angle. Where the locked line meets a road within the node ring of a node the road is drawn ending at (any but one it only carries on through), nothing is cut: the click joins that node, as an unlocked click on the road there does, its end off the line (`cutThere`). Never another road's node lying by it.

## Picking

- A node's hit area is its ring, a fixed size on screen. Inside a node's ring the node wins.
- Where a footpath's node and a car node show at one spot, a click, double-click or drag picks the footpath's where the car node is a cut its road is drawn whole through, and the car node anywhere else (`nodeHitAt` and `preferred` in `modes/picking.ts`).
- A footpath is picked, and snapped to, where it shows and nowhere else (`segmentHitAt`, `footpathScore`): on its paving as drawn (`Scene.footpathPaving`: its strip stopped short of a bend, and the bend or joint at each of its nodes) and on its own crossing (`Networks.onOwnCrossing`), never elsewhere on a car road's lanes or median (`Networks.onCarLanes`). A bend's paving picks one of its two footpaths; ground a bend leaves bare inside it picks neither. Where it shows, it outranks any car road there.
- A footpath's end dragged alone onto a street lands where draw mode lays one, by its snapping (`onSidewalk` in `modes/select.ts`). The end is snapped where it shows (shift and all), and its node goes where that end shows on the walkway (`endsAt`, as a riding end and one sliding along a walkway are placed); with no shift that is where the node is snapped.
- A double-click on a node of two or more roads, or a footpath end on a sidewalk, opens the connector; on a crossing it opens its badge ([crossings.md](crossings.md)).

## Keyboard

- Shortcuts, the toolbar's included, fire only when the event target is `<body>` (`fromPage` in `utils.ts`). A button clicked hands focus back to the page (`press`), so they keep working after a click.
- Save (Cmd/Ctrl+S) is the one exception, by design: it fires from anywhere, a focused lane-width field included, and saves what was entered. A width typed and not yet entered is not saved.

## What a move costs

- A press keeps only what the drag can move: the nodes it moves and the roads at them (a shift's handle: the road and its free ends' nodes, never a node its kept shift leaves where it is).
- Each frame's move check reads only the roads drawn anew and what the grids file near their lines.
- A drag finds the footpath nodes riding the car roads it moves through the footpath pieces' grid.
- A drag of footpaths alone builds no car road again: the car model is the last build's while nothing of the car roads changes, and its drawing is painted again only near the crossings that came or went; a drag of car roads reads again only what it reaches ([road-model.md](road-model.md)). Cutting a footpath in two builds no car road again either.
- The move check's view of the roads as the press found them (`Networks.shown`) copies nothing: the shown lines keep for it only those written over since. Each frame's check reads the roads as now drawn straight off the lines (`Networks.showing`), taking no view, so a drag holds one view however many frames it runs.
- Node rings are placed again only at the nodes written since the last build and at the ends of the segments written or drawn on another line since (`placeRings` in `editor.svelte.ts`).
- The road meshes never move once placed, so their matrices are worked out once, where they are made (`fixed` in `rendering/road-renderer.ts`), never each frame.
- A drop held over its marker copies only the roads the join edits and the roads at their nodes (their order read off `Graph.inOrder`, nothing of the rest walked), and reads again only the lines of those and of the roads they are pieces of, through `PlaceBuilder`'s cache of attached ends. Every other line is read as the last build drew it.
- `?stats` exposes `__renderStats()` and `__perfMove()` for measuring a drag frame.
