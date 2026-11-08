import type { Graph } from './graph.svelte';
import type { Segment } from './segment.svelte';
import { getQuadraticBezierPoint, getQuadraticBezierTangent } from '../geometry/bezier';
import { roadAt, roadLine } from './road-line';

const SAMPLES = 50;
// Crossings this close to an existing endpoint are already junctions.
const ENDPOINT_EXCLUSION = 6;
const MAX_SPLITS = 50;

export interface Crossing {
	segmentA: Segment;
	segmentB: Segment;
	tA: number;
	tB: number;
	// Where the roads cross, as they show.
	x: number;
	y: number;
}

// Find roads that cross mid-span and split both at a shared node, so the
// crossing renders (and behaves) as a real intersection. Roads are found
// crossing where they show (offset and all); the node goes where the two
// segments' lines meet, so both roads stay exactly where they were. Returns
// whether the graph changed.
export function resolveCrossings(graph: Graph): boolean {
	let changed = false;

	for (let i = 0; i < MAX_SPLITS; i++) {
		const crossing = findCrossingsBetweenSegments(
			graph,
			graph.segments.values(),
			graph,
			graph.segments.values()
		)[0];
		if (!crossing) break;

		const { tA, tB, at } = nodeFor(graph, crossing);
		const node = graph.createNode(at.x, at.y);
		splitSegment(graph, crossing.segmentA, tA, node.id);
		splitSegment(graph, crossing.segmentB, tB, node.id);
		changed = true;
	}

	return changed;
}

// The segment's line (a quadratic between its nodes) at t, and its
// derivative there.
function drawnAt(graph: Graph, segment: Segment, t: number) {
	const a = graph.nodes.get(segment.startNodeId)!;
	const b = graph.nodes.get(segment.endNodeId)!;
	const cx = segment.controlX ?? (a.x + b.x) / 2;
	const cy = segment.controlY ?? (a.y + b.y) / 2;
	return {
		p: getQuadraticBezierPoint(a.x, a.y, cx, cy, b.x, b.y, t),
		d: getQuadraticBezierTangent(a.x, a.y, cx, cy, b.x, b.y, t)
	};
}

// Where to put the node for a crossing of two roads: where their segments'
// lines meet (Newton's method from the roads' crossing), when that is inside
// both; otherwise on the first segment's line where the roads cross.
function nodeFor(graph: Graph, c: Crossing) {
	let tA = c.tA;
	let tB = c.tB;
	for (let k = 0; k < 8; k++) {
		const A = drawnAt(graph, c.segmentA, tA);
		const B = drawnAt(graph, c.segmentB, tB);
		const fx = A.p.x - B.p.x;
		const fy = A.p.y - B.p.y;
		// Solve [dA, -dB] [δa, δb] = -f.
		const det = -A.d.x * B.d.y + A.d.y * B.d.x;
		if (Math.abs(det) < 1e-9) break;
		tA += (-fx * -B.d.y - -fy * -B.d.x) / det;
		tB += (A.d.x * -fy - A.d.y * -fx) / det;
	}
	const inside = (t: number) => t > 0.01 && t < 0.99;
	const meet = drawnAt(graph, c.segmentA, tA).p;
	const close =
		Math.hypot(
			meet.x - drawnAt(graph, c.segmentB, tB).p.x,
			meet.y - drawnAt(graph, c.segmentB, tB).p.y
		) < 0.01;
	if (inside(tA) && inside(tB) && close) return { tA, tB, at: meet };
	return { tA: c.tA, tB: c.tB, at: drawnAt(graph, c.segmentA, c.tA).p };
}

export function findCrossingsBetweenSegments(
	graphA: Graph,
	segmentsA: Iterable<Segment>,
	graphB: Graph,
	segmentsB: Iterable<Segment>
) {
	const crossings: Crossing[] = [];
	const lines = (graph: Graph, list: Iterable<Segment>) =>
		Array.from(list).flatMap((segment) => {
			const line = sampleRoad(graph, segment);
			return line ? [{ segment, line, box: boxOf(line) }] : [];
		});
	const a = lines(graphA, segmentsA);
	const b = graphA === graphB ? a : lines(graphB, segmentsB);

	for (const [i, la] of a.entries()) {
		for (const [j, lb] of b.entries()) {
			// Each pair once, and never a segment against itself.
			if (graphA === graphB && j <= i) continue;
			if (!overlaps(la.box, lb.box)) continue;
			crossings.push(
				...findPolylineCrossingsBetween(graphA, la.segment, la.line, graphB, lb.segment, lb.line)
			);
		}
	}

	return crossings;
}

interface PolylinePoint {
	x: number;
	y: number;
	t: number;
}

// The road as it shows (its segment's line moved by its offset), sampled.
function sampleRoad(graph: Graph, segment: Segment): PolylinePoint[] | null {
	const line = roadLine(graph, segment, segment.hasControlPoint ? SAMPLES : 1);
	return line.length >= 2 ? line : null;
}

function boxOf(line: PolylinePoint[]) {
	const xs = line.map((p) => p.x);
	const ys = line.map((p) => p.y);
	return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

const overlaps = (p: ReturnType<typeof boxOf>, q: ReturnType<typeof boxOf>) =>
	p.x0 <= q.x1 && q.x0 <= p.x1 && p.y0 <= q.y1 && q.y0 <= p.y1;

function findPolylineCrossingsBetween(
	graphA: Graph,
	segmentA: Segment,
	polylineA: PolylinePoint[],
	graphB: Graph,
	segmentB: Segment,
	polylineB: PolylinePoint[]
) {
	const crossings: Crossing[] = [];
	for (let i = 0; i < polylineA.length - 1; i++) {
		for (let j = 0; j < polylineB.length - 1; j++) {
			const hit = intersectLineSegments(
				polylineA[i],
				polylineA[i + 1],
				polylineB[j],
				polylineB[j + 1]
			);
			if (!hit) continue;

			if (
				isNearSegmentEndpoint(graphA, segmentA, hit) ||
				isNearSegmentEndpoint(graphB, segmentB, hit)
			) {
				continue;
			}

			const crossing = {
				segmentA,
				segmentB,
				tA: polylineA[i].t + (polylineA[i + 1].t - polylineA[i].t) * hit.u,
				tB: polylineB[j].t + (polylineB[j + 1].t - polylineB[j].t) * hit.v,
				x: hit.x,
				y: hit.y
			};
			if (!crossings.some((existing) => Math.hypot(existing.x - hit.x, existing.y - hit.y) < 0.5)) {
				crossings.push(crossing);
			}
		}
	}

	return crossings;
}

// Whether a point is close to where one of the segment's ends shows.
function isNearSegmentEndpoint(graph: Graph, segment: Segment, point: { x: number; y: number }) {
	for (const t of [0, 1]) {
		const end = roadAt(graph, segment, t);
		if (end && Math.hypot(end.point.x - point.x, end.point.y - point.y) < ENDPOINT_EXCLUSION)
			return true;
	}
	return false;
}

function intersectLineSegments(
	p1: { x: number; y: number },
	p2: { x: number; y: number },
	p3: { x: number; y: number },
	p4: { x: number; y: number }
): { x: number; y: number; u: number; v: number } | null {
	const d1x = p2.x - p1.x;
	const d1y = p2.y - p1.y;
	const d2x = p4.x - p3.x;
	const d2y = p4.y - p3.y;

	const denominator = d1x * d2y - d1y * d2x;
	if (Math.abs(denominator) < 0.0000001) return null;

	const u = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denominator;
	const v = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denominator;

	if (u < 0 || u > 1 || v < 0 || v > 1) return null;

	return { x: p1.x + d1x * u, y: p1.y + d1y * u, u, v };
}

// Split a segment at parameter t through an existing node. Curved segments
// keep their exact shape: de Casteljau subdivision of a quadratic yields two
// quadratics whose control points are the lerped legs.
export function splitSegment(graph: Graph, segment: Segment, t: number, nodeId: string) {
	const startNode = graph.nodes.get(segment.startNodeId);
	const endNode = graph.nodes.get(segment.endNodeId);
	if (!startNode || !endNode) return;

	const hadControl = segment.hasControlPoint;
	let leftControl: { x: number; y: number } | null = null;
	let rightControl: { x: number; y: number } | null = null;

	if (hadControl) {
		const cx = segment.controlX!;
		const cy = segment.controlY!;
		leftControl = {
			x: startNode.x + (cx - startNode.x) * t,
			y: startNode.y + (cy - startNode.y) * t
		};
		rightControl = {
			x: cx + (endNode.x - cx) * t,
			y: cy + (endNode.y - cy) * t
		};
	}

	const startNodeId = segment.startNodeId;
	const endNodeId = segment.endNodeId;
	const leftLanes = segment.cloneLanes();
	const rightLanes = segment.cloneLanes();

	graph.deleteSegment(segment.id);

	const left = graph.createSegment(startNodeId, nodeId, leftLanes);
	if (leftControl) {
		left.setControlPoint(leftControl.x, leftControl.y);
	}

	left.offset = segment.offset;
	const right = graph.createSegment(nodeId, endNodeId, rightLanes);
	right.offset = segment.offset;
	if (rightControl) {
		right.setControlPoint(rightControl.x, rightControl.y);
	}
}
