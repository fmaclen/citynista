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
	return lane.role === 'vehicle' && (lane.direction === 'forward' || lane.direction === 'backward');
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
type MovementBucket = 'left' | 'through' | 'right';
type DestinationArm = { endpoints: LaneEndpoint[] };
type BucketedDestinations = { bucket: MovementBucket; arms: DestinationArm[] };

const DEFAULT_THROUGH_DOT = Math.cos(Math.PI / 4);
const BUCKET_ORDER: MovementBucket[] = ['left', 'through', 'right'];

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

function bucketReachable(
	incoming: LaneEndpoint[],
	bucket: BucketedDestinations,
	barriers: Barrier[]
) {
	return bucket.arms.some((arm) =>
		arm.endpoints.some((to) =>
			incoming.some((from) => !crossesBarrier(from.point, to.point, barriers))
		)
	);
}

function orderedOutgoing(endpoints: LaneEndpoint[]) {
	if (endpoints.length <= 1) return endpoints;
	const outDir = { x: -endpoints[0].dir.x, y: -endpoints[0].dir.y };
	const left = { x: -outDir.y, y: outDir.x };
	return [...endpoints].sort(
		(a, b) => b.point.x * left.x + b.point.y * left.y - (a.point.x * left.x + a.point.y * left.y)
	);
}

function monotonicLanePairs(incoming: LaneEndpoint[], outgoing: LaneEndpoint[]) {
	const pairs: { from: LaneEndpoint; to: LaneEndpoint }[] = [];
	if (incoming.length === 0 || outgoing.length === 0) return pairs;

	if (incoming.length <= outgoing.length) {
		for (let outIndex = 0; outIndex < outgoing.length; outIndex++) {
			const inIndex = Math.floor((outIndex * incoming.length) / outgoing.length);
			pairs.push({ from: incoming[inIndex], to: outgoing[outIndex] });
		}
	} else {
		for (let inIndex = 0; inIndex < incoming.length; inIndex++) {
			const outIndex = Math.floor((inIndex * outgoing.length) / incoming.length);
			pairs.push({ from: incoming[inIndex], to: outgoing[outIndex] });
		}
	}
	return pairs;
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

function normalized(point: Point): Point | null {
	const length = Math.hypot(point.x, point.y);
	if (length < 0.0001) return null;
	return { x: point.x / length, y: point.y / length };
}

function classifyDefaultDestination(from: LaneEndpoint, to: LaneEndpoint): MovementBucket | null {
	const fromDir = normalized(from.dir);
	const toDir = normalized({ x: -to.dir.x, y: -to.dir.y });
	if (!fromDir || !toDir) return null;

	const dot = fromDir.x * toDir.x + fromDir.y * toDir.y;
	if (dot >= DEFAULT_THROUGH_DOT) return 'through';

	const cross = fromDir.x * toDir.y - fromDir.y * toDir.x;
	if (cross > 0.0001) return 'left';
	if (cross < -0.0001) return 'right';
	return null;
}

function assignedBuckets(laneIndex: number, laneCount: number, buckets: MovementBucket[]) {
	if (buckets.length <= 1 || laneCount === 1) return buckets;
	if (laneCount < buckets.length) {
		return laneIndex === 0 ? buckets.slice(0, 2) : buckets.slice(1);
	}

	const counts = buckets.map(() => 1);
	const throughIndex = buckets.findIndex((bucket) => bucket === 'through');
	const spareIndex = throughIndex >= 0 ? throughIndex : Math.floor((buckets.length - 1) / 2);
	counts[spareIndex] += laneCount - buckets.length;

	let start = 0;
	for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex++) {
		const end = start + counts[bucketIndex];
		if (laneIndex >= start && laneIndex < end) return [buckets[bucketIndex]];
		start = end;
	}
	return [];
}

// Whether a movement is in the default lane-discipline set. A U-turn, a
// cross-median break, or a lane crossing over its sibling lanes has to be
// enabled explicitly.
export function isDefaultMovement(
	endpoints: LaneEndpoint[],
	barriers: Barrier[],
	from: LaneRef,
	to: LaneRef
): boolean {
	return defaultConnections(endpoints, barriers).some(
		(c) => sameLaneRef(c.from, from) && sameLaneRef(c.to, to)
	);
}

// The default lane discipline assigns contiguous incoming lanes to the
// left/through/right destination buckets, so edge turns never cross over
// sibling lanes. Turn lanes are made by restricting this set; U-turns and
// median breaks by adding to it.
export function defaultConnections(
	endpoints: LaneEndpoint[],
	barriers: Barrier[] = []
): LaneConnection[] {
	const connections: LaneConnection[] = [];
	const endpointsBySegment = new Map<string, LaneEndpoint[]>();
	for (const endpoint of endpoints) {
		const armEndpoints = endpointsBySegment.get(endpoint.ref.segmentId) ?? [];
		armEndpoints.push(endpoint);
		endpointsBySegment.set(endpoint.ref.segmentId, armEndpoints);
	}

	for (const [segmentId, armEndpoints] of endpointsBySegment) {
		const incoming = armEndpoints.filter((endpoint) => endpoint.flow === 'in');
		if (incoming.length === 0) continue;

		const t = normalized(incoming[0].dir);
		if (!t) continue;
		const left = { x: -t.y, y: t.x };
		incoming.sort(
			(a, b) => b.point.x * left.x + b.point.y * left.y - (a.point.x * left.x + a.point.y * left.y)
		);

		const bucketed = new Map<MovementBucket, DestinationArm[]>();
		for (const [otherSegmentId, otherEndpoints] of endpointsBySegment) {
			if (otherSegmentId === segmentId) continue;
			const outgoing = otherEndpoints.filter((endpoint) => endpoint.flow === 'out');
			if (outgoing.length === 0) continue;
			const bucket = classifyDefaultDestination(incoming[0], outgoing[0]);
			if (!bucket) continue;
			const destinations = bucketed.get(bucket) ?? [];
			destinations.push({ endpoints: orderedOutgoing(outgoing) });
			bucketed.set(bucket, destinations);
		}

		const buckets: BucketedDestinations[] = BUCKET_ORDER.flatMap((bucket) => {
			const destinations = bucketed.get(bucket);
			const bucketedDestinations = destinations ? { bucket, arms: destinations } : null;
			return bucketedDestinations && bucketReachable(incoming, bucketedDestinations, barriers)
				? [bucketedDestinations]
				: [];
		});
		if (buckets.length === 0) continue;
		const orderedBuckets = buckets.map((bucket) => bucket.bucket);

		for (const bucket of buckets) {
			const assignedIncoming = incoming.filter((_, index) =>
				assignedBuckets(index, incoming.length, orderedBuckets).includes(bucket.bucket)
			);
			for (const arm of bucket.arms) {
				for (const { from, to } of monotonicLanePairs(assignedIncoming, arm.endpoints)) {
					if (crossesBarrier(from.point, to.point, barriers)) continue;
					connections.push(makeConnection(from, to));
				}
			}
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
	centerlines: Map<string, CenterlineSample[]>,
	connections = activeConnectionsAt(graph, node, centerlines)
): boolean {
	const pair = nodeThroughPair(graph, node);
	if (!pair) return false;

	const throughIds = new Set([pair[0].id, pair[1].id]);
	const arms = collectIntersectionArms(graph, node, centerlines, throughIds);
	if (arms.length === 0) return false;
	const axis = arms[0].into;
	const a = { x: node.x - axis.x * CENTER_CROSS_REACH, y: node.y - axis.y * CENTER_CROSS_REACH };
	const b = { x: node.x + axis.x * CENTER_CROSS_REACH, y: node.y + axis.y * CENTER_CROSS_REACH };

	// The centre line breaks wherever an active movement crosses it — a slip,
	// turn, or U-turn carrying traffic across the through road's centreline. To
	// keep the line continuous through a fork, disable the crossing movements.
	return connections.some((c) => segmentsCross(c.fromPoint, c.toPoint, a, b));
}
