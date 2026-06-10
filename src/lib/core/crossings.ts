import type { Graph } from './graph.svelte';
import type { Segment } from './segment.svelte';
import { getQuadraticBezierPoint } from '../geometry/bezier';

const SAMPLES = 50;
// Crossings this close to an existing endpoint are already junctions.
const ENDPOINT_EXCLUSION = 6;
const MAX_SPLITS = 50;

interface Crossing {
	segmentA: Segment;
	segmentB: Segment;
	tA: number;
	tB: number;
	x: number;
	y: number;
}

// Find segments that cross mid-span and split both at a shared node, so the
// crossing renders (and behaves) as a real intersection. Returns whether the
// graph changed.
export function resolveCrossings(graph: Graph): boolean {
	let changed = false;

	for (let i = 0; i < MAX_SPLITS; i++) {
		const crossing = findFirstCrossing(graph);
		if (!crossing) break;

		const node = graph.createNode(crossing.x, crossing.y);
		splitSegment(graph, crossing.segmentA, crossing.tA, node.id);
		splitSegment(graph, crossing.segmentB, crossing.tB, node.id);
		changed = true;
	}

	return changed;
}

function findFirstCrossing(graph: Graph): Crossing | null {
	const segments = Array.from(graph.segments.values());

	for (let i = 0; i < segments.length; i++) {
		const polylineA = samplePolyline(graph, segments[i]);
		if (!polylineA) continue;

		for (let j = i + 1; j < segments.length; j++) {
			const polylineB = samplePolyline(graph, segments[j]);
			if (!polylineB) continue;

			const crossing = findPolylineCrossing(graph, segments[i], polylineA, segments[j], polylineB);
			if (crossing) return crossing;
		}
	}

	return null;
}

interface PolylinePoint {
	x: number;
	y: number;
}

function samplePolyline(graph: Graph, segment: Segment): PolylinePoint[] | null {
	const startNode = graph.nodes.get(segment.startNodeId);
	const endNode = graph.nodes.get(segment.endNodeId);
	if (!startNode || !endNode) return null;

	if (!segment.hasControlPoint) {
		return [
			{ x: startNode.x, y: startNode.y },
			{ x: endNode.x, y: endNode.y }
		];
	}

	const points: PolylinePoint[] = [];
	for (let i = 0; i <= SAMPLES; i++) {
		points.push(
			getQuadraticBezierPoint(
				startNode.x,
				startNode.y,
				segment.controlX!,
				segment.controlY!,
				endNode.x,
				endNode.y,
				i / SAMPLES
			)
		);
	}
	return points;
}

function findPolylineCrossing(
	graph: Graph,
	segmentA: Segment,
	polylineA: PolylinePoint[],
	segmentB: Segment,
	polylineB: PolylinePoint[]
): Crossing | null {
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
				isNearSegmentEndpoint(graph, segmentA, hit) ||
				isNearSegmentEndpoint(graph, segmentB, hit)
			) {
				continue;
			}

			return {
				segmentA,
				segmentB,
				tA: (i + hit.u) / (polylineA.length - 1),
				tB: (j + hit.v) / (polylineB.length - 1),
				x: hit.x,
				y: hit.y
			};
		}
	}

	return null;
}

function isNearSegmentEndpoint(graph: Graph, segment: Segment, point: PolylinePoint): boolean {
	for (const nodeId of [segment.startNodeId, segment.endNodeId]) {
		const node = graph.nodes.get(nodeId);
		if (!node) continue;

		const dx = node.x - point.x;
		const dy = node.y - point.y;
		if (Math.sqrt(dx * dx + dy * dy) < ENDPOINT_EXCLUSION) return true;
	}
	return false;
}

function intersectLineSegments(
	p1: PolylinePoint,
	p2: PolylinePoint,
	p3: PolylinePoint,
	p4: PolylinePoint
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
	let leftControl: PolylinePoint | null = null;
	let rightControl: PolylinePoint | null = null;

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

	const right = graph.createSegment(nodeId, endNodeId, rightLanes);
	if (rightControl) {
		right.setControlPoint(rightControl.x, rightControl.y);
	}
}
