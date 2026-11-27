// Dragging nodes (modes/select.ts): each moves with the pointer, the curved
// roads at them bending with their ends (controlFrame). Cars may move
// footpaths, never the reverse: a footpath's node lying on the ground of a
// car road that moves (an end on its sidewalk, a bend in its roadway), as
// the last build drew that ground (`Ground`, Networks.onGround
// in core/networks.ts), rides with that road, keeping its place along and
// across it. However the road moves (its nodes dragged, the road dragged
// whole, its curve's handle or its shift), the same riders carry. A
// footpath node joined to a walkway a street or its junction draws (one
// lying on it) and moved itself slides along that walkway, its end showing
// on it where the move takes it, never off it (`carriedBy`). One joined to
// a junction's corner sidewalk keeps to that corner as the move draws it
// anew (Editor.followWalkways, which files what it moves with the edit, so
// a move refused puts it back) instead of riding a road of the junction.
// Where each lies is read when the drag begins; nothing is stored.

import type { Graph } from './graph.svelte';
import type { Node } from './node.svelte';
import type { Segment } from './segment.svelte';
import { carries } from './lane-types';
import { type Bend, closestOnRoad, endsAt, roadAt, shiftedAt, shownOffs } from './road-line';
import { controlFrame, type Frame, fromFrame, toFrame } from './segment-curve';

type Pt = { x: number; y: number };

// The footpath nodes with a footpath's end showing on the car ground of the
// roads some car segments are part of and of the junctions at some car
// nodes: by node, each footpath whose end there shows on that ground, the
// one the node is held by first (heldFirst in core/networks.ts), with the
// car segments of the ground it shows on.
export type Ground = (
	segments: Iterable<string>,
	nodes: Iterable<string>
) => Map<string, Map<string, Set<string>>>;

// A footpath node riding a car road: where along the road's line as it shows
// (core/road-line.ts, its shift and all) the spot it rides by lies (`t`),
// and how far from that spot along the road and to its right the point it
// keeps there lies, so it moves as the road's ground does when only the
// shift changes. One placed exactly (placedBy) keeps where an end of its
// footpath shows there (`path`, the footpath as the move began in `bend`);
// any other keeps itself there.
interface Rider {
	road: Segment;
	t: number;
	along: number;
	across: number;
	path?: Segment;
	bend?: Bend;
}

// How `segment` lies as a gesture beginning now carries it (Bend in
// core/road-line.ts): its chord, how far its nodes lie from where its ends
// show, and its curve in the frame of its nodes.
export function bendOf(graph: Graph, segment: Segment): Bend | null {
	const a = graph.nodes.get(segment.startNodeId);
	const b = graph.nodes.get(segment.endNodeId);
	if (!a || !b) return null;
	const frame = controlFrame(graph, segment);
	return {
		heading: { x: b.x - a.x, y: b.y - a.y },
		off: shownOffs(graph, segment),
		...(frame && { frame })
	};
}

// The node at a footpath's other end from `nodeId`.
export const farOf = (path: { startNodeId: string; endNodeId: string }, nodeId: string) =>
	path.startNodeId === nodeId ? path.endNodeId : path.startNodeId;

// How a gesture places a footpath node it moves, decided here once a node as
// the gesture begins, for its end the node is held by first (heldFirst in
// core/networks.ts), whose far node is `far`, all the gesture may move being
// `moves` (mayMove):
//
// - 'lies': a node with no shift at it (shiftedAt) shows every end on itself,
//   so it moves by where it lies, as before footpaths took a shift.
// - 'exact': a shifted end whose far node the gesture cannot move is placed
//   for that end to show exactly where the gesture takes it (endsAt in
//   core/road-line.ts), the far node lying still.
// - 'carried': a shifted end whose far node the gesture may move is never
//   placed against that node, which may yet move. The node is carried as
//   one with no shift is: riding, it keeps its place relative to the road
//   its end shows on at the spot where that end shows (ridersOf); kept to
//   a corner, it moves as far as the spot of the corner its end held when
//   the gesture began (followWalkway in modes/picking.ts); dragged or
//   sliding, it keeps as far from its end as when the gesture began. Its
//   curve is placed once both its nodes have their places (bentAfter).
//   So a footpath moved bodily (a street or the pair dragged, an arm swung
//   about its junction at its length) shows both ends exactly where the
//   move carried them, whatever the order its nodes are placed in.
export function placedBy(
	graph: Graph,
	nodeId: string,
	far: string | null | undefined,
	moves: ReadonlySet<string>
) {
	if (!shiftedAt(graph, nodeId)) return 'lies';
	return far && far !== nodeId && moves.has(far) ? 'carried' : 'exact';
}

// Whether a gesture leaves a footpath's curve to be placed after the
// walkway follower has moved its nodes (Moving.frames in modes/picking.ts):
// a footpath both of whose nodes the gesture may move (`moves`: mayMove),
// one of them a node it does not place itself (`placed`: the nodes dragged
// and the riders), as a node kept to a corner is, which moves only once the
// build has drawn the corner anew (Editor.followWalkways). A curve's handle
// is placed once, after both its nodes have their places for the frame, in
// the frame of its nodes as the gesture began (controlFrame); no step sets
// it from one node while the other is still to move. A footpath with a node
// the gesture cannot move keeps its handle where it is, as the node placed
// against that still node reads it (endsAt in core/road-line.ts). One with
// no shift at either node (shiftedAt) is bent as before footpaths took a
// shift: with the drag, from where its nodes then lie (placedBy, 'lies').
export const bentAfter = (
	graph: Graph,
	segment: Segment,
	moves: ReadonlySet<string>,
	placed: ReadonlySet<string>
) => {
	const ends = [segment.startNodeId, segment.endNodeId];
	return (
		!carries(segment.lanes) &&
		ends.every((n) => moves.has(n)) &&
		ends.some((n) => !placed.has(n)) &&
		ends.some((n) => shiftedAt(graph, n))
	);
};

// The car segments among `roads`, and the nodes they end at.
function carsOf(graph: Graph, roads: Iterable<string>) {
	const cars = new Set(
		[...roads].filter((id) => {
			const s = graph.segments.get(id);
			return !!s && carries(s.lanes);
		})
	);
	const nodes = new Set(
		[...cars].flatMap((id) => {
			const s = graph.segments.get(id)!;
			return [s.startNodeId, s.endNodeId];
		})
	);
	return { cars, nodes };
}

// Every footpath node a gesture moving `moving` itself and reshaping the car
// roads among `roads` may move: those, and each footpath node on the ground
// of the car roads at the nodes those roads end at and of the junctions
// there. That is all such a gesture redraws, so it holds the riders and
// every node joined to a walkway it draws anew, which keeps to it after each
// build (Editor.followWalkways). A node there whose road stays is counted
// too, as whether its walkway is drawn otherwise is known only once it is.
export function mayMove(
	graph: Graph,
	ground: Ground,
	roads: Iterable<string>,
	moving: Iterable<string> = []
) {
	const { cars, nodes } = carsOf(graph, roads);
	const around = new Set(
		[...nodes].flatMap((id) =>
			(graph.nodes.get(id)?.connectedSegments ?? []).filter((s) => {
				const segment = graph.segments.get(s);
				return !!segment && carries(segment.lanes);
			})
		)
	);
	return new Set([...moving, ...(cars.size ? ground(around, nodes).keys() : [])]);
}

// The footpath nodes riding the car roads `roads` are part of as it
// reshapes, none of those in `moving` (which move themselves), and the
// footpaths' curves at them. Every way of moving a road finds them here,
// once, as the press begins, over all the ground those roads draw then:
// their own, and the junctions at their nodes, which a road reshaped
// reshapes too; but for those `onCorner` names, which keep to their corner
// as it is drawn anew instead (Editor.followWalkways). A footpath node the
// road reaches during the press is no rider and stays where it lay. Each
// rides as placedBy says, all the gesture may move (`moves`: mayMove) read
// before any rides:
//
// - 'lies': it rides when it lies on that ground, by where it lies, on the
//   car segment of that ground nearest it, if that is one that moves.
// - Shifted: a footpath is where it shows, never where its nodes lie (a
//   node whose footpaths are shifted lies off their ends, maybe off the
//   ground its ends show on, or nearer another road of a junction than the
//   one an end is on). So it rides when an end of its footpaths shows on
//   that ground, by the first of those ends in the order that holds a node
//   on a walkway (heldFirst in core/networks.ts, which Ground lists them
//   in), on the car segment of the ground that end shows on nearest it, if
//   that is one that moves, by the spot of that road where the end shows.
//   'exact', `follow` places it for that end to keep its place there
//   (endsAt in core/road-line.ts), its far node lying still; 'carried', the
//   node keeps its own place relative to the road at that spot.
//
// Nothing is read of the last pointer update, so where they go never
// depends on how many there were, nor on the order they are placed in.
export function ridersOf(
	graph: Graph,
	ground: Ground,
	roads: Iterable<string>,
	moving: Set<string> = new Set(),
	onCorner: (nodeId: string) => boolean = () => false,
	moves: ReadonlySet<string> = mayMove(graph, ground, roads, moving),
	chosen: Iterable<string> = moving
) {
	const { cars, nodes } = carsOf(graph, roads);
	// The car segment of `on` nearest a point, if it is one that moves, the
	// spot along it nearest the point and where `from` lies from that spot.
	const ride = (on: Iterable<string>, by: Pt, from: Pt) => {
		let best: { road: Segment; t: number; distance: number } | null = null;
		for (const s of on) {
			const road = graph.segments.get(s);
			if (!road) continue;
			const near = closestOnRoad(graph, road, by.x, by.y);
			if (!best || near.distance < best.distance) best = { road, ...near };
		}
		const at = best && cars.has(best.road.id) && roadAt(graph, best.road, best.t);
		if (!best || !at) return null;
		const [dx, dy] = [from.x - at.point.x, from.y - at.point.y];
		return {
			road: best.road,
			t: best.t,
			along: dx * at.tangent.x + dy * at.tangent.y,
			across: dx * at.normal.x + dy * at.normal.y
		};
	};
	const riders = new Map<string, Rider>();
	const frames = new Map<string, Frame>();
	for (const [id, ends] of cars.size ? ground(cars, nodes) : []) {
		const node = graph.nodes.get(id);
		if (!node || moving.has(id) || onCorner(id)) continue;
		const [first] = ends;
		const path = first && graph.segments.get(first[0]);
		const way = placedBy(graph, id, path && farOf(path, id), moves);
		const end = path && roadAt(graph, path, path.startNodeId === id ? 0 : 1)?.point;
		const bend = way === 'exact' && path && bendOf(graph, path);
		const rider =
			way === 'lies' || !end
				? ride(new Set([...ends.values()].flatMap((s) => [...s])), node, node)
				: ride(first[1], end, way === 'carried' ? node : end);
		if (!rider || (way === 'exact' && !bend)) continue;
		if (bend && path) Object.assign(rider, { path, bend });
		riders.set(id, rider);
	}
	// The curves at the riders, bent once the riders are placed; but for
	// those left until the follower has moved a node of theirs (bentAfter),
	// the gesture placing the nodes it moves itself (`chosen`) and these.
	const placed = new Set([...chosen, ...riders.keys()]);
	for (const id of riders.keys())
		for (const s of graph.nodes.get(id)?.connectedSegments ?? []) {
			const segment = graph.segments.get(s);
			const frame =
				segment && !bentAfter(graph, segment, moves, placed) && controlFrame(graph, segment);
			if (frame) frames.set(s, frame);
		}
	return {
		nodes: [...riders.keys()],
		follow() {
			for (const [id, { road, t, along, across, path, bend }] of riders) {
				const node = graph.nodes.get(id);
				const at = roadAt(graph, road, t);
				if (!node || !at) continue;
				const to = {
					x: at.point.x + at.tangent.x * along + at.normal.x * across,
					y: at.point.y + at.tangent.y * along + at.normal.y * across
				};
				const far = path && graph.nodes.get(farOf(path, id));
				const p =
					path && bend && far
						? endsAt(path, bend, path.startNodeId === id ? 'start' : 'end', to, far)
						: to;
				[node.x, node.y] = [p.x, p.y];
			}
			for (const [id, frame] of frames) {
				const segment = graph.segments.get(id);
				if (segment) toFrame(graph, segment, frame);
			}
		}
	};
}

// How each road at the nodes a drag moves lay when it began (bendOf), by
// segment id: a node placed by where its footpath's end shows (endsAt in
// core/road-line.ts) is placed with its curve as the drag will leave it.
export type Bends = (segmentId: string) => Bend | undefined;

// A footpath node joined to a walkway (joinedTo in modes/picking.ts): the
// streets' segments, the far node of the footpath whose end it is joined by
// (`far`), where a point a move takes it to puts it on that walkway
// (`slide`, its footpath as the move began in `bends` where the move bends
// it, its handle left where it is otherwise; with `together`, where the
// move takes that far node too: endsAt in core/road-line.ts), and where it
// goes to stay on it from a point it was put at otherwise (`keep`); null
// where the walkway is gone.
export interface Joined {
	street: string[];
	far: string | null;
	slide: (at: Pt, bends?: Bends, together?: boolean) => Pt | null;
	keep: (at: Pt) => Pt | null;
}

// What a move carries besides the nodes it moves itself (`chosen`), and the
// roads it reshapes (`roads`): the footpath nodes riding the car roads among
// them (ridersOf), and those of the chosen joined to a street's walkway
// (`joined`), each held to it (`held`), sliding along it. Whether a node is
// joined to a junction's corner sidewalk (`onCorner`) is read without the
// rest: such a node rides no road (ridersOf). One joined to a
// street the move reshapes rides that street instead, as any footpath node
// lying on it does, so a move of the street and the footpath together keeps
// the footpath on it. All the move may move (`moves`: mayMove) is read
// before anything else, and each held node is told as it is held how it
// slides (placedBy): a node carried keeps as far from its end as when the
// move began (Joined.slide, `together`).
export function carriedBy(
	graph: Graph,
	ground: Ground,
	chosen: Set<string>,
	roads: Set<string>,
	joined?: (nodeId: string) => Joined | null,
	onCorner?: (nodeId: string) => boolean
) {
	const moves = mayMove(graph, ground, roads, chosen);
	const held = new Map<string, Joined>();
	for (const id of chosen) {
		const on = joined?.(id);
		if (!on) continue;
		const carried = placedBy(graph, id, on.far, moves) === 'carried';
		held.set(id, carried ? { ...on, slide: (at, bends) => on.slide(at, bends, true) } : on);
	}
	const ride = new Set(
		[...held].filter(([, on]) => on.street.some((s) => roads.has(s))).map(([id]) => id)
	);
	const riders = ridersOf(
		graph,
		ground,
		roads,
		new Set([...chosen].filter((id) => !ride.has(id))),
		onCorner,
		moves,
		chosen
	);
	for (const id of riders.nodes) held.delete(id);
	return {
		riders,
		held,
		moves,
		// The nodes the move places itself: those it moves and the riders.
		placed: new Set([...chosen, ...riders.nodes]) as ReadonlySet<string>,
		// Puts each node held back on its walkway where it comes nearest.
		hold() {
			for (const [id, on] of held) {
				const node = graph.nodes.get(id);
				const at = node && on.keep(node);
				if (node && at && (node.x !== at.x || node.y !== at.y)) [node.x, node.y] = [at.x, at.y];
			}
		}
	};
}

// Begins dragging the `selected` nodes as they stand in the graph. Each goes
// where the pointer has taken it since (`move`), or, dragged alone, where
// `snap` puts that (a footpath's end onto a street's sidewalk, as draw mode
// lays one, the curves at it carried as the drag bends them); one joined to
// a street's walkway (`joined`) slides along it.
export function dragNodes(
	graph: Graph,
	selected: Iterable<string>,
	ground: Ground,
	snap?: (node: Node, at: Pt, bends: Bends) => Pt | null,
	joined?: (nodeId: string) => Joined | null,
	onCorner?: (nodeId: string) => boolean
) {
	const chosen = new Set(selected);
	const from = new Map(
		[...chosen].flatMap((id) => {
			const node = graph.nodes.get(id);
			return node ? [[id, { x: node.x, y: node.y }] as const] : [];
		})
	);
	const by = { x: 0, y: 0 };
	// The other curved roads at every node moved, bending with it, and how
	// each road there lay when the drag began.
	const frames = new Map<string, Frame>();
	const bends = new Map<string, Bend>();
	const roads = new Set<string>();
	for (const id of chosen)
		for (const segmentId of graph.nodes.get(id)?.connectedSegments ?? []) {
			roads.add(segmentId);
			const segment = graph.segments.get(segmentId);
			const bend = segment && bendOf(graph, segment);
			if (!bend) continue;
			bends.set(segmentId, bend);
			if (bend.frame) frames.set(segmentId, bend.frame);
		}
	const bent: Bends = (s) => bends.get(s);
	const { riders, held, hold, moves, placed } = carriedBy(
		graph,
		ground,
		chosen,
		roads,
		joined,
		onCorner
	);
	// Bends the curves at the nodes moved but those the follower places once
	// it has moved a node of theirs (bentAfter), and those `skip` names, set
	// otherwise.
	const bend = (skip?: ReadonlyMap<string, unknown>) => {
		for (const [id, frame] of frames) {
			const segment = graph.segments.get(id);
			if (segment && !skip?.has(id) && !bentAfter(graph, segment, moves, placed))
				toFrame(graph, segment, frame);
		}
	};

	return {
		// Moves the selection on by (dx, dy).
		move(dx: number, dy: number) {
			by.x += dx;
			by.y += dy;
			for (const [id, start] of from) {
				const node = graph.nodes.get(id);
				if (!node) continue;
				const to = { x: start.x + by.x, y: start.y + by.y };
				const on = held.get(id);
				const at = on
					? (on.slide(to, bent) ?? node)
					: (from.size === 1 && snap?.(node, to, bent)) || to;
				node.x = at.x;
				node.y = at.y;
			}
			bend();
			riders.follow();
		},
		// The curve's handle a road at a moved node takes with that node at
		// `at`, as a move there bends it (null: straight). A road whose curve
		// the drag leaves as set (keepCurve) keeps its own.
		handleAt(segmentId: string, id: string, at: Pt): Pt | null {
			const segment = graph.segments.get(segmentId);
			if (!segment) return null;
			const frame = frames.get(segmentId);
			if (!frame)
				return segment.hasControlPoint ? { x: segment.controlX!, y: segment.controlY! } : null;
			const end = (nodeId: string) => (nodeId === id ? at : graph.nodes.get(nodeId));
			const a = end(segment.startNodeId);
			const b = end(segment.endNodeId);
			return a && b ? fromFrame(a, b, frame) : null;
		},
		// Puts a node moved at `at` instead of where the pointer took it (a
		// dead end held over a drop marker, modes/select.ts), the roads at it
		// shaped as `handles` gives them (a road it leaves out bending with
		// it, as a drag there would) and the riders following. The pointer's
		// travel is kept: the next move starts from it.
		put(id: string, at: Pt, handles = new Map<string, Pt | null>()) {
			const node = graph.nodes.get(id);
			if (!node || !from.has(id)) return;
			[node.x, node.y] = [at.x, at.y];
			bend(handles);
			for (const [segmentId, handle] of handles) {
				const segment = graph.segments.get(segmentId);
				if (!segment) continue;
				if (handle) segment.setControlPoint(handle.x, handle.y);
				else if (segment.hasControlPoint) segment.clearControlPoint();
			}
			riders.follow();
		},
		// Puts the riders back where they lie on their roads, and the nodes
		// joined to a walkway back on it, once something else (select mode's
		// Shift snaps) has moved them or reshaped the roads moved.
		follow() {
			riders.follow();
			hold();
		},
		// Leaves a road's curve as it is set from here on, unbent by the drag.
		keepCurve(segmentId: string) {
			frames.delete(segmentId);
		},
		// All the drag may move (mayMove) and the nodes it places itself:
		// what the follower reads (Editor.followWalkways).
		moves,
		placed,
		// The nodes the drag moves: those selected and the riders. It reshapes
		// only the roads at them.
		nodes() {
			return [...chosen, ...riders.nodes];
		},
		// The roads the drag changed: every road at a node moved.
		changed() {
			return new Set(this.nodes().flatMap((id) => graph.nodes.get(id)?.connectedSegments ?? []));
		}
	};
}
