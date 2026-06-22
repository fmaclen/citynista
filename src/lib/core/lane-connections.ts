import type { Graph } from './graph.svelte';
import type { Node } from './node.svelte';
import type { Lane, LaneConnectionRef, LaneRef } from './types';
import type { CenterlineSample, Point } from './road-geometry';
import {
	collectIntersectionArms,
	computeIntersectionTrims,
	offsetPoint,
	sampleTrimmedCenterline
} from './road-geometry';
import { laneSurface } from './lane-types';
import { getTotalWidth } from './lane-template';

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
				point: offsetPoint(arm.stop, normal, centre),
				dir: arm.into,
				flow: incoming ? 'in' : 'out'
			});
		}
	}

	return endpoints;
}

// The permissive default: every incoming lane connects to every outgoing lane
// on a different arm (no U-turns yet). Turn lanes are made by *restricting*
// this set later, not by a special lane type.
export function defaultConnections(endpoints: LaneEndpoint[]): LaneConnection[] {
	const connections: LaneConnection[] = [];

	for (const from of endpoints) {
		if (from.flow !== 'in') continue;
		for (const to of endpoints) {
			if (to.flow !== 'out') continue;
			if (to.ref.segmentId === from.ref.segmentId) continue;
			connections.push({
				from: from.ref,
				to: to.ref,
				fromPoint: from.point,
				toPoint: to.point,
				// Incoming traffic heads into the node (+into); outgoing leaves
				// it (−into of its own arm).
				fromDir: from.dir,
				toDir: { x: -to.dir.x, y: -to.dir.y },
				active: true
			});
		}
	}

	return connections;
}

// The connectivity of a node: its travel-lane endpoints plus the connectors
// between them (active = not in the node's disabled set). Builds the trimmed
// centerlines for the node's arms once.
export function nodeConnectivity(
	graph: Graph,
	node: Node
): { endpoints: LaneEndpoint[]; connections: LaneConnection[] } {
	if (node.connectedSegments.length < 2) return { endpoints: [], connections: [] };

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
	const disabled = node.disabledConnections ?? [];
	const connections = defaultConnections(endpoints);
	for (const connection of connections) {
		connection.active = !disabled.some((d) => sameConnectionRef(d, connection));
	}
	return { endpoints, connections };
}
