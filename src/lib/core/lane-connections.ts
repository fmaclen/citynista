import type { Graph } from './graph.svelte';
import type { Node } from './node.svelte';
import type { Lane, LaneConnectionRef, LaneRef } from './types';
import type { CenterlineSample, Point } from './road-geometry';
import {
	collectIntersectionArms,
	computeIntersectionTrims,
	medianBarriers,
	nodeThroughPair,
	offsetPoint,
	sampleTrimmedCenterline
} from './road-geometry';
import { laneSurface } from './lane-types';
import { getTotalWidth } from './lane-template';

// Minimum distance a connector dot sits out from its node, so the mouths of
// collinear through-arms don't stack their dots on the node itself.
const MIN_DOT_OFFSET = 6;

export function sameLaneRef(a: LaneRef, b: LaneRef): boolean {
	return a.segmentId === b.segmentId && a.laneIndex === b.laneIndex;
}

export function sameConnectionRef(a: LaneConnectionRef, b: LaneConnectionRef): boolean {
	return sameLaneRef(a.from, b.from) && sameLaneRef(a.to, b.to);
}

// Where a travel lane meets a node, and which way it flows there.
export interface LaneEndpoint {
	ref: LaneRef;
	// World position of the lane centre at the node mouth.
	point: Point;
	// Outward tangent at the mouth (points from the segment toward the node).
	dir: Point;
	flow: 'in' | 'out';
}

// An incoming lane routed to an outgoing lane through the node. Points and
// tangents are carried so a renderer can draw the connector without redoing
// the arm geometry.
export interface LaneConnection {
	from: LaneRef;
	to: LaneRef;
	fromPoint: Point;
	toPoint: Point;
	// Travel tangent entering the node (at `from`) and leaving it (at `to`).
	fromDir: Point;
	toDir: Point;
	// Whether the movement is allowed (not in the node's disabled set).
	active: boolean;
}

// Only directional roadway lanes carry through a junction; sidewalks, grass,
// medians and (bidirectional) parking are not movements.
function isTravelLane(lane: Lane): boolean {
	return (
		laneSurface(lane.type) === 'roadway' &&
		(lane.direction === 'forward' || lane.direction === 'backward')
	);
}

// The travel-lane endpoints at a node, one per directional roadway lane on
// every arm, positioned at the lane centre along the arm's mouth.
export function laneEndpointsAtNode(
	graph: Graph,
	node: Node,
	centerlines: Map<string, CenterlineSample[]>
): LaneEndpoint[] {
	const endpoints: LaneEndpoint[] = [];

	for (const arm of collectIntersectionArms(graph, node, centerlines)) {
		// Lanes are placed off the segment's DRAWING-direction normal (the same
		// frame the road strips use), so an arm that starts here and one that
		// ends here agree on which world side a lane is on. Using arm.side
		// (perp of `into`, which flips with start/end) put a straight-through
		// lane on opposite sides at the two arms — a diagonal, not a band.
		const tangent = arm.startsHere ? { x: -arm.into.x, y: -arm.into.y } : arm.into;
		const normal = { x: -tangent.y, y: tangent.x };

		// Seat the dots a minimum distance out from the node along the arm. At a
		// collinear through-node the two arms' trimmed mouths both sit on the
		// node, so without this their in/out dots stack on the same point and one
		// hides the other. `into` points at the node, so step out along −into.
		const stopDist = Math.hypot(arm.stop.x - node.x, arm.stop.y - node.y);
		const base =
			stopDist >= MIN_DOT_OFFSET
				? arm.stop
				: {
						x: node.x - arm.into.x * MIN_DOT_OFFSET,
						y: node.y - arm.into.y * MIN_DOT_OFFSET
					};

		let offset = -getTotalWidth(arm.lanes) / 2;
		for (let laneIndex = 0; laneIndex < arm.lanes.length; laneIndex++) {
			const lane = arm.lanes[laneIndex];
			const centre = offset + lane.width / 2;
			offset += lane.width;
			if (!isTravelLane(lane)) continue;

			// A lane flows toward the node when its travel direction points at
			// the node: backward lanes if the segment starts here, forward if it
			// ends here.
			const incoming = arm.startsHere
				? lane.direction === 'backward'
				: lane.direction === 'forward';
			endpoints.push({
				ref: { segmentId: arm.segmentId, laneIndex },
				point: offsetPoint(base, normal, centre),
				dir: arm.into,
				flow: incoming ? 'in' : 'out'
			});
		}
	}

	return endpoints;
}

export type Barrier = { a: Point; b: Point };

function segmentsCross(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
	const side = (a: Point, b: Point, c: Point) =>
		Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
	const d1 = side(p3, p4, p1);
	const d2 = side(p3, p4, p2);
	const d3 = side(p1, p2, p3);
	const d4 = side(p1, p2, p4);
	return d1 !== d2 && d3 !== d4 && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0;
}

function crossesBarrier(from: Point, to: Point, barriers: Barrier[]): boolean {
	return barriers.some((bar) => segmentsCross(from, to, bar.a, bar.b));
}

function makeConnection(from: LaneEndpoint, to: LaneEndpoint): LaneConnection {
	return {
		from: from.ref,
		to: to.ref,
		fromPoint: from.point,
		toPoint: to.point,
		// Incoming traffic heads into the node (+into); outgoing leaves it (−into
		// of its own arm).
		fromDir: from.dir,
		toDir: { x: -to.dir.x, y: -to.dir.y },
		active: true
	};
}

// Whether a movement is in the permissive default set: incoming → outgoing on a
// DIFFERENT arm that does not cross a centre-median barrier. A U-turn or a
// cross-median break is NOT default — it has to be enabled explicitly.
export function isDefaultMovement(
	endpoints: LaneEndpoint[],
	barriers: Barrier[],
	from: LaneRef,
	to: LaneRef
): boolean {
	if (from.segmentId === to.segmentId) return false;
	const f = endpoints.find((e) => sameLaneRef(e.ref, from) && e.flow === 'in');
	const t = endpoints.find((e) => sameLaneRef(e.ref, to) && e.flow === 'out');
	if (!f || !t) return false;
	return !crossesBarrier(f.point, t.point, barriers);
}

// The permissive default: every incoming lane connects to every outgoing lane
// on a different arm, except across a centre median (no U-turns either). Turn
// lanes are made by *restricting* this set; U-turns and median breaks by
// *adding* to it.
export function defaultConnections(
	endpoints: LaneEndpoint[],
	barriers: Barrier[] = []
): LaneConnection[] {
	const connections: LaneConnection[] = [];
	for (const from of endpoints) {
		if (from.flow !== 'in') continue;
		for (const to of endpoints) {
			if (to.flow !== 'out') continue;
			if (to.ref.segmentId === from.ref.segmentId) continue;
			if (crossesBarrier(from.point, to.point, barriers)) continue;
			connections.push(makeConnection(from, to));
		}
	}
	return connections;
}

// The connectivity of a node: its travel-lane endpoints plus the connectors
// between them — the default set (minus the node's disabled movements) plus any
// explicitly enabled extras (U-turns, median breaks). Builds the trimmed
// centerlines for the node's arms once.
export function nodeConnectivity(
	graph: Graph,
	node: Node
): { endpoints: LaneEndpoint[]; connections: LaneConnection[]; barriers: Barrier[] } {
	if (node.connectedSegments.length < 2) return { endpoints: [], connections: [], barriers: [] };

	const trims = computeIntersectionTrims(graph);
	const centerlines = new Map<string, CenterlineSample[]>();
	for (const segmentId of node.connectedSegments) {
		const segment = graph.segments.get(segmentId);
		if (!segment) continue;
		const startNode = graph.nodes.get(segment.startNodeId);
		const endNode = graph.nodes.get(segment.endNodeId);
		if (!startNode || !endNode) continue;
		const trim = trims.get(segmentId);
		const samples = sampleTrimmedCenterline(
			segment,
			startNode,
			endNode,
			trim?.start ?? 0,
			trim?.end ?? 0
		);
		if (samples.length >= 2) centerlines.set(segmentId, samples);
	}

	const endpoints = laneEndpointsAtNode(graph, node, centerlines);
	const barriers = medianBarriers(graph, node, centerlines);
	const disabled = node.disabledConnections ?? [];
	const enabled = node.enabledConnections ?? [];

	const connections = defaultConnections(endpoints, barriers);
	for (const connection of connections) {
		connection.active = !disabled.some((d) => sameConnectionRef(d, connection));
	}

	// Explicit extras beyond the default — drawn U-turns and median breaks.
	for (const ref of enabled) {
		if (connections.some((c) => sameConnectionRef(c, ref))) continue;
		const f = endpoints.find((e) => sameLaneRef(e.ref, ref.from) && e.flow === 'in');
		const t = endpoints.find((e) => sameLaneRef(e.ref, ref.to) && e.flow === 'out');
		if (f && t) connections.push(makeConnection(f, t));
	}

	return { endpoints, connections, barriers };
}

// The movements that actually exist at a node, reusing the network's already
// trimmed centerlines instead of recomputing them — the default set minus the
// node's disabled movements, plus any explicitly enabled extras.
export function activeConnectionsAt(
	graph: Graph,
	node: Node,
	centerlines: Map<string, CenterlineSample[]>
): LaneConnection[] {
	if (node.connectedSegments.length < 2) return [];

	const endpoints = laneEndpointsAtNode(graph, node, centerlines);
	const barriers = medianBarriers(graph, node, centerlines);
	const disabled = node.disabledConnections ?? [];
	const enabled = node.enabledConnections ?? [];

	const connections = defaultConnections(endpoints, barriers).filter(
		(c) => !disabled.some((d) => sameConnectionRef(d, c))
	);
	for (const ref of enabled) {
		if (connections.some((c) => sameConnectionRef(c, ref))) continue;
		const f = endpoints.find((e) => sameLaneRef(e.ref, ref.from) && e.flow === 'in');
		const t = endpoints.find((e) => sameLaneRef(e.ref, ref.to) && e.flow === 'out');
		if (f && t) connections.push(makeConnection(f, t));
	}
	return connections;
}

// How far the centre axis reaches either side of the node — far enough to
// catch a connector dot (seated MIN_DOT_OFFSET out) peeling across the centre.
const CENTER_CROSS_REACH = MIN_DOT_OFFSET + 2;

// Whether an active movement crosses the through road's centreline at the node
// — a slip/turn/U-turn that carries traffic from one carriageway to the
// opposing one. The solid centre line breaks where this happens and runs
// through where it doesn't, so its continuity follows the actual connectivity.
export function centerCrossedAt(
	graph: Graph,
	node: Node,
	centerlines: Map<string, CenterlineSample[]>
): boolean {
	const pair = nodeThroughPair(graph, node);
	if (!pair) return false;

	const arms = collectIntersectionArms(graph, node, centerlines, new Set([pair[0].id, pair[1].id]));
	if (arms.length === 0) return false;
	const axis = arms[0].into;
	const a = { x: node.x - axis.x * CENTER_CROSS_REACH, y: node.y - axis.y * CENTER_CROSS_REACH };
	const b = { x: node.x + axis.x * CENTER_CROSS_REACH, y: node.y + axis.y * CENTER_CROSS_REACH };

	return activeConnectionsAt(graph, node, centerlines).some((c) =>
		segmentsCross(c.fromPoint, c.toPoint, a, b)
	);
}
