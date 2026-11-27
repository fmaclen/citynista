import type { ModeHandlers } from './types';
import type { Editor, HandleRef } from '../editor.svelte';
import { beginOffsetDrag, dragOffset, type OffsetDrag } from './offset';
import { dragSetback, setbackHandleAt, type SetbackHandle } from './setback';
import { segmentEnds } from '../core/attach';
import { controlHandle } from '../rendering/selection-renderer';
import type { Segment } from '../core/segment.svelte';
import type { Node } from '../core/node.svelte';
import { outOf } from '../core/segment-curve';
import { HOVER_COLOR } from '../rendering/editor-palette';
import { CURVE_HANDLE, hitsHandle } from '../rendering/handle-shapes';
import {
	joinedTo,
	movingFrom,
	NOTHING_MOVING,
	nodeHitAt,
	onCorner,
	pickAt,
	placedAt,
	shownOffset
} from './picking';
import { createMarquee } from './marquee';
import { openConnector, opensConnector } from './connector';
import { type Bends, carriedBy, dragNodes } from '../core/drag';
import { carries } from '../core/lane-types';
import { crossedThere, crossingPairs, type Lines, type ShownRoads } from '../core/crossings';
import type { Graph } from '../core/graph.svelte';
import { copyAround, laidOver } from '../core/trial';
import { createSnapping, edgeAt, markerAt, unit, type SnapResult, type Way } from './draw';
import { oneWay } from '../core/lane-template';
import { attachShift, endAt } from '../core/attach';
import { ghostCursor } from './ghost';

// Snap radii are sized in screen pixels and converted to world units at
// the current zoom; hit areas live in modes/picking.
const STRAIGHT_SNAP_PX = 14;
const MARQUEE_COLOR = HOVER_COLOR;

// Where a dead end dragged alone joins if released, as draw mode's snap
// finds it (a node, or a road cut there), where its marker stands, and where
// its end is drawn and its curve's handle lie once joined there.
type Pt = { x: number; y: number };
type Drop = { target: SnapResult; shown: Pt; end: Pt; handle: Pt | null };

type DragTarget =
	| { type: 'nodes' }
	| { type: 'controlPoint'; segmentId: string }
	| { type: 'segments'; segmentIds: string[] }
	| null;

export function setupSelectMode(editor: Editor): ModeHandlers {
	let isDragging = false;
	let dragTarget: DragTarget = null;
	let dragStartX = 0;
	let dragStartZ = 0;
	// Shift+click on a selected node means "deselect" only if no drag
	// follows — a shift+drag instead smooths the node's tangent live.
	let pendingShiftToggle: string | null = null;
	// Dragging a setback handle of the selected node sets that road's setback.
	let taperDrag: { handle: SetbackHandle } | null = null;
	// Dragging the selected road's lateral offset handle.
	let offsetDrag: OffsetDrag | null = null;
	let dragDistance = 0;

	const marquee = createMarquee(editor, MARQUEE_COLOR, 0.4);
	// The selected nodes in hand (core/drag.ts): curves bend with their ends,
	// and footpath nodes on a car road moved ride with it.
	let nodeDrag: ReturnType<typeof dragNodes> | null = null;
	// What dragging segments, a curve's handle or a road's shift carries: the
	// footpath nodes riding the car roads moved, and the nodes it moves
	// joined to a street's walkway, held to it; with the segments, where the
	// nodes it moves started and how far it has taken them.
	let riders: ReturnType<typeof carriedBy> | null = null;
	let carried: {
		from: Map<string, { x: number; y: number }>;
		by: { x: number; y: number };
	} | null = null;

	// A footpath node joined to a street's walkway, which it slides along;
	// one joined to a corner keeps to it as the corner is drawn anew.
	const onWalkway = (nodeId: string) => joinedTo(editor, nodeId);
	const cornered = (nodeId: string) => onCorner(editor, nodeId);

	// What moving some nodes (`nodes`) and `roads` carries: the footpath
	// nodes on the car ground of `roads` and of the roads at those nodes,
	// which ride along as they move, and those of the nodes joined to a
	// walkway, held to it (carriedBy).
	const ridersAt = (nodes: string[], roads: string[] = []) =>
		carriedBy(
			editor.graph,
			editor.roadRenderer.onGround,
			new Set(nodes),
			new Set([
				...roads,
				...nodes.flatMap((id) => editor.graph.nodes.get(id)?.connectedSegments ?? [])
			]),
			onWalkway,
			cornered
		);

	// A footpath's end dragged alone onto a street lands where draw mode
	// lays one, by its snapping (dropSnap): on the walkway under it, a
	// junction's corner included, or else the street's walkway nearest or
	// its curb. A footpath's end is where it shows, its shift and all: the
	// end is snapped where the drag takes it (as far from its node as it
	// showed when the press began: `endOff`), and the node goes where that
	// end shows there, its curve as the drag bends it (placedAt). Only the
	// roads near it are read.
	const onSidewalk = (node: Node, at: { x: number; y: number }, bends: Bends) => {
		const path = editor.graph.segments.get(node.connectedSegments[0]);
		if (!dropSnap || !endOff || !path) return null;
		const snap = dropSnap.resolveSnap(at.x + endOff.x, at.y + endOff.y, false);
		if (snap.kind !== 'side') return null;
		return placedAt(editor, path, node.id, snap, bends(path.id));
	};

	const worldPerPixel = () => editor.sceneManager.worldPerPixel();

	// A move changes where roads are, never which roads and nodes there are,
	// and may not lay a road across another of its kind where the two did not
	// cross when the move began (core/crossings.ts: their lines as shown
	// crossing). What is read is every road whose shown line some frame of
	// the move drew anew (the renderer's `relined`), whatever moved it: its
	// nodes, its handle, its shift, a footpath riding a car road, or the
	// roads beside an end attached at an edge. In hand, `held` is the roads
	// as drawn when the press began (`before`), those drawn anew since
	// (`moved`), and where what the move can move was, to put back: the nodes
	// it moves and the roads at them or reshaped by it, read off those alone,
	// so a press costs what the drag can move. While a move lays roads
	// across, they show as refused; let go there, it is undone.
	let held: {
		before: Lines & { release(): void };
		moved: Set<string>;
		nodes: Map<string, { x: number; y: number }>;
		segments: Map<string, { cx?: number; cy?: number; start: number; end: number }>;
		refused: boolean;
	} | null = null;

	// Holds a move of some nodes and the roads at them, and of `roads`.
	const hold = (nodes: Iterable<string>, roads: Iterable<string> = []) => {
		const graph = editor.graph;
		const moving = [...new Set(nodes)].flatMap((id) => graph.nodes.get(id) ?? []);
		const reshaped = new Set([...roads, ...moving.flatMap((n) => n.connectedSegments)]);
		held?.before.release();
		held = {
			before: editor.roadRenderer.shown(),
			moved: new Set(),
			nodes: new Map(moving.map((n) => [n.id, { x: n.x, y: n.y }])),
			segments: new Map(
				[...reshaped]
					.flatMap((id) => graph.segments.get(id) ?? [])
					.map((s) => [
						s.id,
						{ cx: s.controlX, cy: s.controlY, start: s.offsetStart, end: s.offsetEnd }
					])
			),
			refused: false
		};
	};

	// Holds a move of some nodes and `roads` with what it carries
	// (ridersAt): the riders move and are put back with them.
	const carry = (nodes: string[], roads: string[]) => {
		riders = ridersAt(nodes, roads);
		editor.moving = movingFrom(editor, riders.moves, riders.placed);
		hold([...nodes, ...riders.riders.nodes], roads);
	};

	// Where the dead end in hand would join (dropAt), and its marker.
	let drop: Drop | null = null;
	const marker = ghostCursor(editor);
	// Draw mode's snapping for the dead end in hand, as a road of its lanes
	// drawn from its far node (createSnapping): set when its drag begins.
	let dropSnap: ReturnType<typeof createSnapping> | null = null;
	// How far from it the footpath's end at the dead end in hand showed when
	// its drag began (none for a car road's).
	let endOff: { x: number; y: number } | null = null;

	// The one dead end selected: a node of one road, and its far node.
	const deadEnd = () => {
		if (editor.selectedNodes.size !== 1) return null;
		const node = editor.graph.nodes.get([...editor.selectedNodes][0]);
		const own =
			node?.connectedSegments.length === 1 && editor.graph.segments.get(node.connectedSegments[0]);
		if (!node || !own) return null;
		return { node, own, far: own.startNodeId === node.id ? own.endNodeId : own.startNodeId };
	};

	// A dead end joined to a street's walkway slides along it and drops
	// nowhere.
	const beginDrop = () => {
		const end = deadEnd();
		endOff =
			end && !carries(end.own.lanes) ? shownOffset(editor, end.own, end.node.id, end.node) : null;
		dropSnap =
			end && !onWalkway(end.node.id)
				? createSnapping(
						editor,
						() => end.own.lanes,
						() => end.far,
						() => false,
						{ node: end.node.id, segment: end.own.id }
					)
				: null;
	};

	// Where the dead end in hand joins if released at the pointer: where a
	// draw's finishing click there would end a road of its lanes from its far
	// node, on a node or a road of its kind; none where that click would lay
	// nothing (on its far node itself, a road already joining the two nodes,
	// or one-way traffic met head-on). Its end and curve are read as the join
	// leaves them (`dropped`), so the held end, the head-on test and the
	// join are one state wherever in the snap ring the pointer is.
	const dropAt = (x: number, y: number): Drop | null => {
		const end = deadEnd();
		if (!end || !dropSnap) return null;
		const { node, own, far } = end;
		const target = dropSnap.resolveSnap(x, y, false);
		if (target.kind !== 'node' && target.kind !== 'segment') return null;
		if (target.kind === 'node' && target.nodeId === far) return null;
		if (dropSnap.retracesFrom(far, target)) return null;
		const lies = dropped(target);
		if (!lies) return null;
		const dir = oneWay(own.lanes);
		if (dir) {
			// Its traffic arrives at the dropped end if it runs toward it.
			const way: Way = (dir === 'forward') === (own.endNodeId === node.id) ? 'arrive' : 'leave';
			const from = lies.handle ?? editor.graph.nodes.get(far)!;
			if (dropSnap.meetsHeadOn(target, way, unit(lies.end, from))) return null;
		}
		return { target, shown: markerAt(editor, target), ...lies };
	};

	// Joins the dead end in hand into `graph` (the editor's, or a copy of
	// part of it) where it was dropped, as a draw's finishing click lays an
	// end there: the node it lands on (a road under it cut there), its curve
	// bent as the drag bends it with its end there (wherever the pointer
	// left it), the edge it attaches at and the curve's handle moved with
	// it. The node it joined, or null where it could not.
	const joinIn = (graph: Graph, target: SnapResult) => {
		const end = deadEnd();
		const own = end && graph.segments.get(end.own.id);
		if (!end || !own || !dropSnap || !nodeDrag) return null;
		const control = nodeDrag.handleAt(own.id, end.node.id, target);
		const endId = dropSnap.anchorIn(graph, target);
		if (!graph.merge(end.node.id, endId)) return null;
		if (control) own.setControlPoint(control.x, control.y);
		else if (own.hasControlPoint) own.clearControlPoint();
		const edge = edgeAt(target);
		dropSnap.attach(graph, endId, own, edge);
		if (control && edge) {
			const shift = attachShift(graph, own, endId);
			own.setControlPoint(control.x + shift.x, control.y + shift.y);
		}
		return endId;
	};

	// Where the dead end lies once joined at `target`: its end as drawn
	// (moved to the edge it attaches at) and its curve's handle, read off
	// the join made in a copy of the roads it edits. Null where it could not
	// join.
	const dropped = (target: SnapResult) => {
		const end = deadEnd();
		if (!end) return null;
		const copy = copyAround(editor.graph, joinSeeds(target));
		const endId = joinIn(copy, target);
		const own = copy.segments.get(end.own.id);
		const at = endId !== null && own && endAt(copy, own, endId);
		if (!at || !own) return null;
		return { end: at, handle: own.hasControlPoint ? { x: own.controlX!, y: own.controlY! } : null };
	};

	// The roads a join at `target` edits: the dead end's own road, and the road
	// cut there or those at the node it lands on.
	const joinSeeds = (target: SnapResult) => {
		const seeds = new Set([deadEnd()?.own.id ?? '']);
		if (target.kind === 'segment') seeds.add(target.snap.segment.id);
		else if (target.kind === 'node')
			for (const id of editor.graph.nodes.get(target.nodeId)?.connectedSegments ?? [])
				seeds.add(id);
		seeds.delete('');
		return seeds;
	};

	// A drop is judged once, at release, on the graph the join makes, against
	// the roads as the press found them. Held over its marker the dead end
	// already lies where the drop puts it (`dropped`): its end where the join
	// draws it, at the edge it attaches at, its curve's handle as the join
	// leaves it and the footpath nodes riding its road carried there
	// (dragNodes' `put`), so what is drawn while held, what the preview
	// checks and what is joined are one state, wherever in the snap ring the
	// pointer stopped. The join may cut a road and merge a node; the roads
	// and nodes it edits (the seeds and every road at their nodes) are read
	// off the press's drawing before it is made (`pin`), so the judgement
	// still finds the road it cut as it lay then. A road the press's drawing
	// does not show is a piece of the road cut there (`piecesOf`), read as
	// that road.
	const pin = (before: Lines, seeds: Set<string>) => {
		const graph = editor.graph;
		const nodes = new Set(
			[...seeds].flatMap((id) => {
				const s = graph.segments.get(id);
				return s ? [s.startNodeId, s.endNodeId] : [];
			})
		);
		const roads = new Set([...seeds, ...[...nodes].flatMap((n) => before.at(n))]);
		for (const id of roads) {
			const s = graph.segments.get(id);
			if (s) nodes.add(s.startNodeId).add(s.endNodeId);
		}
		const shown = new Map([...roads].map((id) => [id, before.road(id)]));
		const at = new Map([...nodes].map((n) => [n, [...before.at(n)]]));
		return {
			road: (id: string) => (shown.has(id) ? shown.get(id) : before.road(id)),
			at: (id: string) => at.get(id) ?? before.at(id)
		} satisfies Lines;
	};
	const piecesOf = (before: Lines, to: Drop) => {
		const cut = to.target.kind === 'segment' ? to.target.snap.segment.id : null;
		return (id: string) => (cut && !before.road(id) ? cut : id);
	};

	// Joins the dead end in hand where it was dropped, one undo step, the
	// node it joined selected, with all the join carries: the footpath nodes
	// riding its road where they lie on it as joined, and the ends on a
	// walkway the join draws anew kept on it (Editor.followWalkways). Laying
	// a road across one of its kind where the two did not cross when the
	// press began (refusedIn), the whole move is taken back, nothing saved,
	// and the selection the press found given back (Editor.takeBack).
	// Whether it joined or was taken back; false where it could not join.
	const joinAt = (to: Drop) => {
		const end = deadEnd();
		if (!held || !end) return false;
		const before = pin(held.before, joinSeeds(to.target));
		const endId = joinIn(editor.graph, to.target);
		if (endId === null) return false;
		nodeDrag?.follow();
		editor.clearSelection();
		editor.selectNode(endId);
		editor.rebuildRoads();
		for (const id of editor.roadRenderer.relined()) held.moved.add(id);
		const now = {
			roads: editor.roadRenderer.shown(),
			moved: held.moved,
			named: piecesOf(before, to)
		};
		const refused = refusedIn(now, before).size > 0;
		now.roads.release();
		if (refused) editor.takeBack(pressed ?? { nodes: [], segments: [] });
		else editor.graph.save();
		return true;
	};

	// The preview of that judgement while held over the marker: the roads as
	// a build of the graph will show them once joined there, and those whose
	// shown line that changes. The join is made in a copy of the roads it
	// edits (every road at their nodes with them), laid over the graph, and
	// every road's line read off that as a build reads it (Networks.shownIn),
	// so it costs what the join changes, whatever the map's size. Only what a
	// build of the joined graph moves besides (Editor.followWalkways) is left
	// to the judgement. Null where it would not join.
	const joined = (to: Drop) => {
		if (!held || !deadEnd()) return null;
		const graph = editor.graph;
		const copy = copyAround(graph, joinSeeds(to.target));
		const known = new Set(copy.segments.keys());
		if (joinIn(copy, to.target) === null) return null;
		const roads = editor.roadRenderer.shownIn(laidOver(graph, copy, known), [
			...known,
			...copy.segments.keys()
		]);
		const moved = new Set([...held.moved, ...roads.relined]);
		return { roads, moved, named: piecesOf(held.before, to) };
	};

	// Whether the move in hand lays a road across one of its kind where it did
	// not cross it when the press began, read once the frame is drawn: each
	// pair crossing now where a road moved lies, each place they cross against
	// where the two crossed then (crossedThere: a crossing slid along either
	// road is refused as a new one is). The roads moved that make such a
	// crossing show refused. A dead end over a drop marker is read as it will
	// lie once joined there (`joined`).
	const checkHeld = () => {
		if (!held) return;
		for (const id of editor.roadRenderer.relined()) held.moved.add(id);
		const now = (drop && joined(drop)) ?? {
			roads: editor.roadRenderer.showing(),
			moved: held.moved,
			named: (id: string) => id
		};
		const refused = refusedIn(now, held.before);
		held.refused = refused.size > 0;
		editor.showRefused([...refused].sort());
		// A move in hand that letting go keeps is an edit Undo takes back (it
		// settles it into a step first); one refused is put back, no step.
		editor.holdsUndo(!held.refused);
	};

	// The roads moved (`moved`, as the road each is `named` for) that lay a
	// road across one of its kind, as `roads` shows them, where the two did
	// not cross as `before` shows them (the press's drawing).
	const refusedIn = (
		now: { roads: ShownRoads; moved: Set<string>; named: (id: string) => string },
		before: Lines
	) => {
		const refused = new Set<string>();
		const crossedThen = (p: string, q: string) => {
			const [a, b] = [now.named(p), now.named(q)];
			return a === b || crossedThere(before, now.roads, [p, q], [a, b]);
		};
		for (const key of crossingPairs(now.roads, now.moved)) {
			const pair = key.split('|');
			if (crossedThen(pair[0], pair[1])) continue;
			for (const id of pair) if (now.moved.has(id)) refused.add(now.named(id));
		}
		return refused;
	};

	// Puts everything back where the move in hand found it.
	const putBack = () => {
		if (!held) return;
		for (const [id, at] of held.nodes) {
			const node = editor.graph.nodes.get(id);
			if (node && (node.x !== at.x || node.y !== at.y)) [node.x, node.y] = [at.x, at.y];
		}
		for (const [id, was] of held.segments) {
			const segment = editor.graph.segments.get(id);
			if (!segment) continue;
			if (was.cx === undefined || was.cy === undefined) {
				if (segment.hasControlPoint) segment.clearControlPoint();
			} else if (segment.controlX !== was.cx || segment.controlY !== was.cy)
				segment.setControlPoint(was.cx, was.cy);
			if (segment.offsetStart !== was.start) segment.offsetStart = was.start;
			if (segment.offsetEnd !== was.end) segment.offsetEnd = was.end;
		}
	};

	// The selection when the press began, which a refused move gives back.
	let pressed: { nodes: string[]; segments: string[] } | null = null;

	// Undoes the move in hand: everything where the press found it, the
	// footpath ends its frames kept on their walkways included
	// (Editor.putBackFollowed), the drawing rebuilt without following, so
	// nothing moves anew, nothing shown refused, and the selection as the
	// press found it.
	const undoMove = () => {
		editor.putBackFollowed();
		putBack();
		editor.showRefused([]);
		editor.refreshSelectionVisuals();
		editor.rebuildRoads(false);
		if (pressed) {
			editor.clearSelection();
			for (const id of pressed.nodes) editor.selectNode(id);
			for (const id of pressed.segments) editor.selectSegment(id);
		}
	};

	const findControlPointAt = (worldX: number, worldZ: number) => {
		for (const segmentId of editor.selectedSegments) {
			const segment = editor.graph.segments.get(segmentId);
			if (!segment) continue;

			const startNode = editor.graph.nodes.get(segment.startNodeId);
			const endNode = editor.graph.nodes.get(segment.endNodeId);
			if (!startNode || !endNode) continue;

			const ends = segmentEnds(editor.graph, segment);
			if (!ends) continue;
			const handle = controlHandle(segment, ends.a, ends.b);

			// The square is drawn on screen, axis-aligned to the world.
			if (hitsHandle(CURVE_HANDLE, handle, { x: 1, y: 0 }, worldX, worldZ, worldPerPixel())) {
				return segment;
			}
		}
		return null;
	};

	// The handle a press here would grab, in the order onMouseDown tries them.
	const handleAt = (worldX: number, worldZ: number): HandleRef | null => {
		const taper = editor.selectedNodes.size === 1 && setbackHandleAt(editor, worldX, worldZ);
		if (taper) return { kind: 'taper', index: taper.index };
		if (editor.offsetHandleAt(worldX, worldZ)) return { kind: 'offset', index: 0 };
		const curve = findControlPointAt(worldX, worldZ);
		return curve ? { kind: 'curve', segmentId: curve.id } : null;
	};

	const moveControlPoint = (segmentId: string, dx: number, dz: number, factor: number) => {
		const segment = editor.graph.segments.get(segmentId);
		if (!segment) return;

		// A straight road's handle starts half way between its ends as drawn.
		const ends = segmentEnds(editor.graph, segment);
		if (!ends) return;

		const cx = segment.controlX ?? (ends.a.x + ends.b.x) / 2;
		const cy = segment.controlY ?? (ends.a.y + ends.b.y) / 2;
		segment.setControlPoint(cx + dx * factor, cy + dz * factor);
	};

	// Every direction a smooth continuation of a neighboring road would
	// enter this segment with at the given node — one candidate per
	// neighbor, so the handle can snap to any of them.
	const approachDirectionsAt = (segment: Segment, node: Node) => {
		const directions: { x: number; y: number }[] = [];

		for (const segmentId of node.connectedSegments) {
			if (segmentId === segment.id) continue;
			const adjacent = editor.graph.segments.get(segmentId);
			const out = adjacent && outOf(editor.graph, adjacent, node.id);
			// Inward along the neighbor's continuation, into this segment.
			if (out) directions.push({ x: -out.x, y: -out.y });
		}

		return directions;
	};

	// Shift while dragging the control point snaps to the nearest "perfect
	// curve": straight when near the chord, otherwise the candidate closest
	// to the cursor among every combination of neighbor tangents — ray
	// intersections (tangent-continuous at both ends) and single rays
	// (tangent-continuous at one end, cursor sliding along the ray). Keep
	// dragging the other way and the next neighbor's tangent catches.
	const snapControlPoint = (segmentId: string, worldX: number, worldZ: number) => {
		const segment = editor.graph.segments.get(segmentId);
		if (!segment) return;

		const startNode = editor.graph.nodes.get(segment.startNodeId);
		const endNode = editor.graph.nodes.get(segment.endNodeId);
		const ends = segmentEnds(editor.graph, segment);
		if (!startNode || !endNode || !ends) return;
		// The curve is spanned between the ends as drawn.
		const start = ends.a;
		const end = ends.b;

		const chordX = end.x - start.x;
		const chordY = end.y - start.y;
		const chordLength = Math.hypot(chordX, chordY);
		if (chordLength < 0.0001) return;

		// Straight snap: cursor close to the line between the endpoints.
		const t = Math.max(
			0,
			Math.min(
				1,
				((worldX - start.x) * chordX + (worldZ - start.y) * chordY) / (chordLength * chordLength)
			)
		);
		const nearestX = start.x + chordX * t;
		const nearestY = start.y + chordY * t;
		if (Math.hypot(worldX - nearestX, worldZ - nearestY) < STRAIGHT_SNAP_PX * worldPerPixel()) {
			segment.clearControlPoint();
			return;
		}

		const fromStarts = approachDirectionsAt(segment, startNode);
		const fromEnds = approachDirectionsAt(segment, endNode);
		const reach = chordLength * 5;
		const candidates: { x: number; y: number }[] = [];

		for (const fromStart of fromStarts) {
			for (const fromEnd of fromEnds) {
				const denominator = fromStart.x * fromEnd.y - fromStart.y * fromEnd.x;
				if (Math.abs(denominator) <= 0.0001) continue;
				const a = (chordX * fromEnd.y - chordY * fromEnd.x) / denominator;
				const b = (chordX * fromStart.y - chordY * fromStart.x) / denominator;
				if (a > 0.01 && b > 0.01 && a < reach && b < reach) {
					candidates.push({
						x: start.x + fromStart.x * a,
						y: start.y + fromStart.y * a
					});
				}
			}
		}
		for (const [origin, directions] of [
			[start, fromStarts],
			[end, fromEnds]
		] as const) {
			for (const direction of directions) {
				const along = Math.max(
					0,
					Math.min(reach, (worldX - origin.x) * direction.x + (worldZ - origin.y) * direction.y)
				);
				candidates.push({ x: origin.x + direction.x * along, y: origin.y + direction.y * along });
			}
		}

		if (candidates.length > 0) {
			let best = candidates[0];
			let bestDistance = Infinity;
			for (const candidate of candidates) {
				const distance = Math.hypot(worldX - candidate.x, worldZ - candidate.y);
				if (distance < bestDistance) {
					bestDistance = distance;
					best = candidate;
				}
			}
			segment.setControlPoint(best.x, best.y);
			return;
		}

		// No neighbors at all: symmetric curve via the perpendicular bisector.
		const perpX = -chordY / chordLength;
		const perpY = chordX / chordLength;
		const midX = (start.x + end.x) / 2;
		const midY = (start.y + end.y) / 2;
		const offset = (worldX - midX) * perpX + (worldZ - midY) * perpY;
		segment.setControlPoint(midX + perpX * offset, midY + perpY * offset);
	};

	// Leaves a road's curve as a snap set it for the rest of the drag: the
	// drag bends it no more, nor does the follower (Moving.frames).
	const keepCurve = (segmentId: string) => {
		nodeDrag?.keepCurve(segmentId);
		editor.moving.frames?.delete(segmentId);
	};

	// Shift-dragging near the line between two of the node's far endpoints
	// snaps the node onto it and straightens that pair — one perfectly
	// straight continuous road. Every pair of segments through the node is
	// a candidate, so it works at junctions and merge nodes too: the other
	// arms simply follow the node.
	const snapNodeStraight = (node: Node): boolean => {
		const ends: { segment: Segment; far: Node }[] = [];
		for (const segmentId of node.connectedSegments) {
			const segment = editor.graph.segments.get(segmentId);
			if (!segment) continue;
			const farId = segment.startNodeId === node.id ? segment.endNodeId : segment.startNodeId;
			const far = editor.graph.nodes.get(farId);
			if (!far) continue;
			ends.push({ segment, far });
		}
		if (ends.length < 2) return false;

		const threshold = STRAIGHT_SNAP_PX * worldPerPixel();
		let best: { x: number; y: number; pair: [Segment, Segment] } | null = null;
		let bestDistance = threshold;
		for (let i = 0; i < ends.length; i++) {
			for (let j = i + 1; j < ends.length; j++) {
				const ax = ends[i].far.x;
				const ay = ends[i].far.y;
				const dx = ends[j].far.x - ax;
				const dy = ends[j].far.y - ay;
				const lengthSq = dx * dx + dy * dy;
				if (lengthSq < 0.0001) continue;

				const t = ((node.x - ax) * dx + (node.y - ay) * dy) / lengthSq;
				if (t < 0.05 || t > 0.95) continue;
				const px = ax + dx * t;
				const py = ay + dy * t;
				const distance = Math.hypot(node.x - px, node.y - py);
				if (distance < bestDistance) {
					bestDistance = distance;
					best = { x: px, y: py, pair: [ends[i].segment, ends[j].segment] };
				}
			}
		}
		if (!best) return false;

		node.x = best.x;
		node.y = best.y;
		for (const segment of best.pair) {
			segment.clearControlPoint();
			keepCurve(segment.id);
		}
		return true;
	};

	// Shift-dragging a dangling end node near the extension of a road at
	// its far end snaps it onto that line and straightens the segment — a
	// perfectly straight continuation.
	const snapEndNodeToContinuation = (node: Node): boolean => {
		if (node.connectedSegments.length !== 1) return false;
		const segment = editor.graph.segments.get(node.connectedSegments[0]);
		if (!segment) return false;
		const farId = segment.startNodeId === node.id ? segment.endNodeId : segment.startNodeId;
		const far = editor.graph.nodes.get(farId);
		if (!far) return false;

		const threshold = STRAIGHT_SNAP_PX * worldPerPixel();
		let best: { x: number; y: number } | null = null;
		let bestDistance = threshold;
		for (const direction of approachDirectionsAt(segment, far)) {
			const along = (node.x - far.x) * direction.x + (node.y - far.y) * direction.y;
			if (along < 1) continue;
			const candidate = { x: far.x + direction.x * along, y: far.y + direction.y * along };
			const distance = Math.hypot(node.x - candidate.x, node.y - candidate.y);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = candidate;
			}
		}
		if (!best) return false;

		node.x = best.x;
		node.y = best.y;
		segment.clearControlPoint();
		keepCurve(segment.id);
		return true;
	};

	// A node with exactly two segments becomes a perfect tangent point: the
	// shared tangent is the line between the two far endpoints, and each
	// segment's control sits on it at a third of its chord.
	const smoothTangentThrough = (node: Node) => {
		if (node.connectedSegments.length !== 2) return;

		const ends: { segment: Segment; far: Node }[] = [];
		for (const segmentId of node.connectedSegments) {
			const segment = editor.graph.segments.get(segmentId);
			if (!segment) return;
			const farId = segment.startNodeId === node.id ? segment.endNodeId : segment.startNodeId;
			const far = editor.graph.nodes.get(farId);
			if (!far) return;
			ends.push({ segment, far });
		}

		const dirX = ends[1].far.x - ends[0].far.x;
		const dirY = ends[1].far.y - ends[0].far.y;
		const length = Math.hypot(dirX, dirY);
		if (length < 0.0001) return;

		for (const [index, { segment, far }] of ends.entries()) {
			const sign = index === 0 ? -1 : 1;
			const chord = Math.hypot(far.x - node.x, far.y - node.y);
			const reach = chord * 0.35;
			segment.setControlPoint(
				node.x + (dirX / length) * sign * reach,
				node.y + (dirY / length) * sign * reach
			);
		}
	};

	const applyChanges = () => {
		editor.refreshSelectionVisuals();
		editor.rebuildRoads();
		checkHeld();
	};

	// A drag mutates node positions cheaply on every mousemove but the rebuild
	// is heavy, so coalesce rebuilds to one per animation frame — high-frequency
	// mousemoves otherwise saturate the main thread and tank the frame rate.
	let applyRaf: number | null = null;
	const scheduleApply = () => {
		if (applyRaf !== null) return;
		applyRaf = requestAnimationFrame(() => {
			applyRaf = null;
			applyChanges();
		});
	};
	const flushApply = () => {
		if (applyRaf === null) return;
		cancelAnimationFrame(applyRaf);
		applyRaf = null;
		applyChanges();
	};

	const onMouseDown = (event: MouseEvent) => {
		if (event.button !== 0) return;
		if (event.altKey) return;
		// A press on the map closes a crossing's badge; its double-click opens
		// it again.
		editor.closeCrossing();
		pressed = { nodes: [...editor.selectedNodes], segments: [...editor.selectedSegments] };

		const worldPos = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		dragStartX = worldPos.x;
		dragStartZ = worldPos.z;

		// The hover highlight would go stale while dragging; selection visuals
		// take over from here. A handle pressed is in hand.
		editor.setHoveredSegment(null);
		editor.lightHandle(handleAt(worldPos.x, worldPos.z), 'active');

		// Dragging a setback handle of the selected node (Shift moves every
		// road's together). The handles sit out where each road stops short,
		// so node dragging still works at the centre.
		if (editor.selectedNodes.size === 1) {
			const handle = setbackHandleAt(editor, worldPos.x, worldPos.z);
			if (handle) {
				taperDrag = { handle };
				editor.moving = { ...NOTHING_MOVING, joined: new Map() };
				return;
			}
		}

		const offset = editor.offsetHandleAt(worldPos.x, worldPos.z);
		if (offset) {
			offsetDrag = beginOffsetDrag(editor, offset, worldPos.x, worldPos.z);
			if (offsetDrag) {
				// Only its free ends move (modes/offset.ts); a kept end's node and
				// the roads at it stay, but for the road itself.
				const free = offsetDrag.ends.filter((e) => e.free).map((e) => e.nodeId);
				carry(free, [offsetDrag.segmentId]);
			}
			return;
		}

		const controlPointSegment = findControlPointAt(worldPos.x, worldPos.z);
		if (controlPointSegment) {
			isDragging = true;
			dragTarget = { type: 'controlPoint', segmentId: controlPointSegment.id };
			carry([], [controlPointSegment.id]);
			return;
		}

		const { node, segment: pickedSegment } = pickAt(editor, worldPos.x, worldPos.z);
		if (node) {
			if (event.shiftKey) {
				if (editor.selectedNodes.has(node.id)) {
					// Deselect only if this turns out to be a click, not a
					// shift+drag (which smooths the node's tangent instead).
					pendingShiftToggle = node.id;
				} else {
					editor.selectNode(node.id);
				}
			} else if (!editor.selectedNodes.has(node.id)) {
				editor.clearSelection();
				editor.selectNode(node.id);
			}
			isDragging = true;
			dragDistance = 0;
			dragTarget = { type: 'nodes' };
			nodeDrag = dragNodes(
				editor.graph,
				editor.selectedNodes,
				editor.roadRenderer.onGround,
				onSidewalk,
				onWalkway,
				cornered
			);
			editor.moving = movingFrom(editor, nodeDrag.moves, nodeDrag.placed);
			hold(nodeDrag.nodes());
			beginDrop();
			return;
		}

		const segment = pickedSegment;
		if (segment) {
			if (event.shiftKey) {
				if (editor.selectedSegments.has(segment.id)) {
					editor.deselectSegment(segment.id);
					return;
				}
				editor.selectSegment(segment.id);
			} else if (!editor.selectedSegments.has(segment.id)) {
				editor.clearSelection();
				editor.selectSegment(segment.id);
			}
			isDragging = true;
			dragTarget = { type: 'segments', segmentIds: [...editor.selectedSegments] };
			const ends = endsOf(dragTarget.segmentIds);
			carried = {
				from: new Map(
					ends.flatMap((id) => {
						const n = editor.graph.nodes.get(id);
						return n ? [[id, { x: n.x, y: n.y }] as const] : [];
					})
				),
				by: { x: 0, y: 0 }
			};
			// The roads moved are those at its ends, read in the order the
			// nodes list them, so a footpath node on the ground of two of them
			// rides the first (ridersOf).
			carry(ends, []);
			return;
		}

		if (!event.shiftKey) {
			editor.clearSelection();
		}
		marquee.begin(event.clientX, event.clientY);
	};

	const onMouseMove = (event: MouseEvent) => {
		const worldPos = editor.sceneManager.screenToWorld(event.clientX, event.clientY);

		if (taperDrag) {
			dragSetback(editor, taperDrag.handle, worldPos.x, worldPos.z, event.shiftKey);
			// Letting go keeps it, a step Undo takes back.
			editor.holdsUndo(true);
			return;
		}

		if (offsetDrag) {
			dragOffset(editor, offsetDrag, worldPos.x, worldPos.z, event.shiftKey);
			riders?.hold();
			riders?.riders.follow();
			scheduleApply();
			return;
		}

		if (marquee.active) {
			marquee.update(event.clientX, event.clientY);
			return;
		}

		if (!isDragging || !dragTarget) {
			editor.lightHandle(handleAt(worldPos.x, worldPos.z));
			const { node, segment } = pickAt(editor, worldPos.x, worldPos.z);
			editor.setHoveredNode(node?.id ?? null);
			// With a node selected, stay focused on it — don't light up other
			// segments on hover. Click still reselects; Esc/empty ground clears.
			editor.setHoveredSegment(editor.selectedNodes.size > 0 ? null : (segment?.id ?? null));
			return;
		}

		const dx = worldPos.x - dragStartX;
		const dz = worldPos.z - dragStartZ;

		dragDistance += Math.hypot(dx, dz);
		if (dragTarget.type === 'nodes') {
			if (dragDistance > 1) pendingShiftToggle = null;

			nodeDrag?.move(dx, dz);
			// Shift while dragging a single node: near the collinear line it
			// snaps onto it and straightens; otherwise a two-segment node
			// keeps the road perfectly tangent through it, both controls
			// re-solving every frame.
			if (event.shiftKey && editor.selectedNodes.size === 1) {
				const nodeId = [...editor.selectedNodes][0];
				const node = editor.graph.nodes.get(nodeId);
				if (node && !snapNodeStraight(node) && !snapEndNodeToContinuation(node)) {
					smoothTangentThrough(node);
				}
				nodeDrag?.follow();
			}
			drop = event.shiftKey ? null : dropAt(worldPos.x, worldPos.z);
			// Held over a marker, the end lies where the join draws it, its
			// curve as the join leaves it, with all a drag there carries.
			const end = drop && deadEnd();
			if (drop && end) nodeDrag?.put(end.node.id, drop.end, new Map([[end.own.id, drop.handle]]));
			if (drop) marker.place(drop.shown, true);
			else marker.hide();
			editor.dropShown = drop?.shown ?? null;
			scheduleApply();
			// Taper handles ride along with a moving node.
			editor.refreshTaperHandles();
		} else if (dragTarget.type === 'controlPoint') {
			if (event.shiftKey) {
				snapControlPoint(dragTarget.segmentId, worldPos.x, worldPos.z);
			} else {
				moveControlPoint(dragTarget.segmentId, dx, dz, 1);
			}
			riders?.riders.follow();
			scheduleApply();
		} else if (dragTarget.type === 'segments') {
			// Dragging a path moves the selected segments rigidly; curvature only
			// changes via the control-point handle. Shared endpoints move once.
			const movedNodes = new Set<string>();
			for (const segmentId of dragTarget.segmentIds) {
				const segment = editor.graph.segments.get(segmentId);
				if (!segment) continue;

				for (const nodeId of [segment.startNodeId, segment.endNodeId]) {
					if (movedNodes.has(nodeId)) continue;
					movedNodes.add(nodeId);

					const node = editor.graph.nodes.get(nodeId);
					if (node) {
						node.x += dx;
						node.y += dz;
					}
				}
				if (segment.hasControlPoint) {
					moveControlPoint(segment.id, dx, dz, 1);
				}
			}
			// An end joined to a walkway slides along it to where the drag
			// has taken it.
			if (carried) {
				carried.by.x += dx;
				carried.by.y += dz;
				for (const [id, on] of riders?.held ?? []) {
					const node = editor.graph.nodes.get(id);
					const start = carried.from.get(id);
					const at = start && on.slide({ x: start.x + carried.by.x, y: start.y + carried.by.y });
					if (node && at) [node.x, node.y] = [at.x, at.y];
				}
			}
			riders?.riders.follow();
			scheduleApply();
		}

		dragStartX = worldPos.x;
		dragStartZ = worldPos.z;
	};

	// Whether a press is in hand: a move, a setback handle or a marquee.
	const holding = () => held !== null || taperDrag !== null || marquee.active;

	// Ends what the press began, as letting go where the pointer last was.
	// Every drag ends here, through the release: let go, or let go by the
	// editor. A command given while a press is in hand settles it
	// (Editor.settlePress), which lets go only a press that has moved, one
	// that has not being undone (Editor.cancelPress, as Escape does); a move
	// or press arriving with the button already up is a release that never
	// came, given where the pointer last was (Editor.release). The frame still
	// queued is applied first, so the last move is read; then a dead end over
	// a drop marker is joined there or taken back, as the join judges, a
	// refused move put back, or anything else kept as one undo step, and a
	// marquee selects what it holds.
	const settle = () => {
		if (!holding()) return;
		flushApply();
		const to = drop;
		drop = null;
		marker.hide();
		editor.dropShown = null;

		if (marquee.active) {
			const contents = marquee.contents();
			marquee.end();
			for (const nodeId of contents.nodeIds) editor.selectNode(nodeId);
			for (const segmentId of contents.segmentIds) editor.selectSegment(segmentId);
		}

		if (taperDrag) editor.graph.save();

		// A shift+click on a selected node that never turned into a drag is
		// the deselect gesture.
		if (pendingShiftToggle !== null) editor.deselectNode(pendingShiftToggle);

		// Over a marker the join's own judgement decides (joinAt), the
		// preview's verdict none of it.
		if (held && !(to && joinAt(to))) {
			if (held.refused) undoMove();
			else editor.graph.save();
		}

		held?.before.release();
		held = null;
		taperDrag = null;
		offsetDrag = null;
		pendingShiftToggle = null;
		isDragging = false;
		dragTarget = null;
		dragDistance = 0;
		nodeDrag = null;
		riders = null;
		carried = null;
		dropSnap = null;
		endOff = null;
		editor.moving = NOTHING_MOVING;
		pressed = null;
		editor.holdsUndo(false);
		editor.lightHandle(null);
	};

	// The nodes at the ends of some segments.
	const endsOf = (segmentIds: string[]) =>
		segmentIds.flatMap((id) => {
			const segment = editor.graph.segments.get(id);
			return segment ? [segment.startNodeId, segment.endNodeId] : [];
		});

	// Out of hand, a handle still under the pointer goes back to hover.
	const onMouseUp = (event: MouseEvent) => {
		if (marquee.active) marquee.update(event.clientX, event.clientY);
		settle();
		const worldPos = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		editor.lightHandle(handleAt(worldPos.x, worldPos.z));
	};

	// Double-clicking a node (≥2 arms, junctions and transitions, or a
	// footpath's end on a sidewalk) opens the lane connector for it. Of a
	// footpath's node and a car node at one spot, the one picked
	// (nodeHitAt) is the one opened. A double-click on a crossing opens its
	// badge wherever on the crossing it lands, over the ring of a footpath's
	// node in it too (whose connector edits nothing): only a car node's ring
	// is opened before it.
	const onDoubleClick = (event: MouseEvent) => {
		if (event.button !== 0) return;
		const worldPos = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		const hit = nodeHitAt(editor, worldPos.x, worldPos.z).node;
		const car = (id: string) => carries(editor.graph.segments.get(id)?.lanes ?? []);
		const crossing =
			hit && hit.connectedSegments.some(car)
				? null
				: editor.roadRenderer.crossingAt({ x: worldPos.x, y: worldPos.z });
		const node = crossing ? null : hit;
		if (node && opensConnector(editor, node.id)) {
			openConnector(editor, node.id);
		} else if (node && node.connectedSegments.length === 1) {
			// A dangling endpoint: continue its road onward with the same lanes.
			editor.continueFromNode(node.id);
		} else if (crossing) {
			// A footpath's crossing over a car road: its control badge opens,
			// as a junction's approaches show theirs in the connector.
			editor.openCrossing(crossing);
		}
	};

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === 'Delete' || event.key === 'Backspace') {
			// Deletes what is selected once the editor has settled the press
			// in hand (a marquee, what it holds).
			if (editor.selectedNodes.size > 0 || editor.selectedSegments.size > 0) {
				event.preventDefault();
				editor.deleteSelected();
			}
		} else if (event.key === 'Escape') {
			editor.clearSelection();
			editor.closeCrossing();
		}
	};

	// The editor settles the press in hand before the mode is left, or has
	// taken it back (Editor.cancelPress); what is left of it is dropped.
	const cleanup = () => {
		if (applyRaf !== null) {
			cancelAnimationFrame(applyRaf);
			applyRaf = null;
		}
		editor.dropShown = null;
		editor.moving = NOTHING_MOVING;
		editor.showRefused([]);
		editor.setHoveredNode(null);
		editor.setHoveredSegment(null);
		editor.lightHandle(null);
		marquee.dispose();
		marker.destroy();
	};

	return {
		onMouseDown,
		onMouseMove,
		onMouseUp,
		onDoubleClick,
		onKeyDown,
		cleanup
	};
}
