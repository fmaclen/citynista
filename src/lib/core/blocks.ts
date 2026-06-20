import ClipperLib from 'clipper-lib';
import type { Path } from 'clipper-lib';
import type { Graph } from './graph.svelte';
import type { Segment } from './segment.svelte';
import {
	computeIntersectionTrims,
	executeBoolean,
	offsetPaths,
	pathsToPolygons,
	toClipperPath
} from './road-geometry';
import type { Point, PolygonWithHoles, SegmentTrims } from './road-geometry';
import { getQuadraticBezierPoint, getQuadraticBezierTangent } from '../geometry/bezier';

// City blocks: the enclosed faces of the road graph. Faces are traced by
// walking half-edges and always turning onto the next arm around each node;
// a block's interior is its face polygon minus the boundary roads' ribbons
// and node discs, so it hugs the outside edge of every road however wide or
// curved. Dangling dead-ends inside a face contribute slits that vanish in
// the subtraction.

const CURVE_SAMPLES = 16;
const MIN_BLOCK_AREA = 25;
// Adjacent arms closer than this form a pocket the plate's corner curve
// never reaches; the centerline wedge between them is cleared from blocks.
const SHARP_PAIR_ANGLE = 0.7;
// The analytic ribbon/wedge cut is wider than the road actually renders at
// convex corners and junctions (rounded fillets, gores), so the carve leaves
// notches the ground leaks through. Grow the carved block back under the road
// edges by this much to seal them; opaque roads render on top of the bleed.
const BLOCK_BLEED = 2.5;

export interface Block {
	// Stable identity: the sorted boundary segments.
	key: string;
	// Geometry signature: rebuild only when a boundary segment changed.
	signature: string;
	// Lazily computed interior — the Clipper work only runs for blocks
	// whose signature changed.
	polygons: () => PolygonWithHoles[];
}

interface HalfEdge {
	segment: Segment;
	fromId: string;
	toId: string;
	angle: number;
	reverse: HalfEdge | null;
	visited: boolean;
}

function segmentControl(graph: Graph, segment: Segment): { cx: number; cy: number } | null {
	const start = graph.nodes.get(segment.startNodeId);
	const end = graph.nodes.get(segment.endNodeId);
	if (!start || !end) return null;
	return {
		cx: segment.controlX ?? (start.x + end.x) / 2,
		cy: segment.controlY ?? (start.y + end.y) / 2
	};
}

// Sampled polyline of the segment from `fromId` toward the other end,
// excluding the final endpoint (faces append it as the next edge's start).
function sampledPoints(graph: Graph, segment: Segment, fromId: string): Point[] {
	const start = graph.nodes.get(segment.startNodeId)!;
	const end = graph.nodes.get(segment.endNodeId)!;
	const control = segmentControl(graph, segment)!;
	const samples = segment.hasControlPoint ? CURVE_SAMPLES : 1;
	const forward = segment.startNodeId === fromId;

	const points: Point[] = [];
	for (let i = 0; i < samples; i++) {
		const t = forward ? i / samples : 1 - i / samples;
		points.push(getQuadraticBezierPoint(start.x, start.y, control.cx, control.cy, end.x, end.y, t));
	}
	return points;
}

function signedArea(points: Point[]): number {
	let area = 0;
	for (let i = 0; i < points.length; i++) {
		const a = points[i];
		const b = points[(i + 1) % points.length];
		area += a.x * b.y - b.x * a.y;
	}
	return area / 2;
}

export function buildBlocks(graph: Graph, trims?: SegmentTrims): Block[] {
	// Half-edges with outgoing tangent angles, ringed per node.
	const rings = new Map<string, HalfEdge[]>();
	const halfEdges: HalfEdge[] = [];

	for (const segment of graph.segments.values()) {
		const start = graph.nodes.get(segment.startNodeId);
		const end = graph.nodes.get(segment.endNodeId);
		if (!start || !end) continue;
		if (Math.hypot(end.x - start.x, end.y - start.y) < 0.01 && !segment.hasControlPoint) continue;
		const control = segmentControl(graph, segment)!;

		const tangentStart = getQuadraticBezierTangent(
			start.x,
			start.y,
			control.cx,
			control.cy,
			end.x,
			end.y,
			0
		);
		const tangentEnd = getQuadraticBezierTangent(
			start.x,
			start.y,
			control.cx,
			control.cy,
			end.x,
			end.y,
			1
		);

		const out: HalfEdge = {
			segment,
			fromId: segment.startNodeId,
			toId: segment.endNodeId,
			angle: Math.atan2(tangentStart.y, tangentStart.x),
			reverse: null,
			visited: false
		};
		const back: HalfEdge = {
			segment,
			fromId: segment.endNodeId,
			toId: segment.startNodeId,
			angle: Math.atan2(-tangentEnd.y, -tangentEnd.x),
			reverse: out,
			visited: false
		};
		out.reverse = back;
		halfEdges.push(out, back);

		for (const edge of [out, back]) {
			const ring = rings.get(edge.fromId) ?? [];
			ring.push(edge);
			rings.set(edge.fromId, ring);
		}
	}
	for (const ring of rings.values()) {
		ring.sort((a, b) => a.angle - b.angle);
	}

	// Arriving at a node via an edge, the face continues on the arm next
	// around the ring from the reverse edge — tracing every interior face
	// exactly once.
	const nextOf = (edge: HalfEdge): HalfEdge => {
		const ring = rings.get(edge.toId)!;
		const index = ring.indexOf(edge.reverse!);
		return ring[(index - 1 + ring.length) % ring.length];
	};

	const wedges = sharpWedgePaths(graph, trims);

	const blocks: Block[] = [];
	for (const first of halfEdges) {
		if (first.visited) continue;

		const boundary: HalfEdge[] = [];
		let edge = first;
		do {
			edge.visited = true;
			boundary.push(edge);
			edge = nextOf(edge);
		} while (edge !== first && boundary.length < halfEdges.length + 1);

		const points: Point[] = [];
		for (const e of boundary) {
			points.push(...sampledPoints(graph, e.segment, e.fromId));
		}
		if (points.length < 3) continue;

		// Interior faces wind one way, the unbounded outer face the other.
		const area = signedArea(points);
		if (area <= MIN_BLOCK_AREA) continue;

		const segmentIds = [...new Set(boundary.map((e) => e.segment.id))].sort();
		const key = segmentIds.join(',');
		const signature = segmentIds
			.map((id) => {
				const segment = graph.segments.get(id)!;
				const start = graph.nodes.get(segment.startNodeId)!;
				const end = graph.nodes.get(segment.endNodeId)!;
				return `${id}:${start.x},${start.y},${end.x},${end.y},${segment.controlX ?? '-'},${segment.controlY ?? '-'},${segment.totalWidth}`;
			})
			.join('|');

		const facePoints = points;
		blocks.push({
			key,
			signature,
			polygons: () => carveBlock(graph, facePoints, segmentIds, wedges)
		});
	}
	return blocks;
}

// Triangular wedges between sharply-angled adjacent arms at each node,
// reaching past their junction trims — the pockets the visible pavement
// (plates, gores) covers from above but the face polygon would otherwise
// fill with block.
function sharpWedgePaths(
	graph: Graph,
	trims: SegmentTrims = computeIntersectionTrims(graph)
): { path: Path; points: Point[] }[] {
	const wedges: { path: Path; points: Point[] }[] = [];

	for (const node of graph.nodes.values()) {
		if (node.connectedSegments.length < 2) continue;

		const arms: { dir: Point; angle: number; reach: number }[] = [];
		for (const segmentId of node.connectedSegments) {
			const segment = graph.segments.get(segmentId);
			if (!segment) continue;
			const control = segmentControl(graph, segment);
			const start = graph.nodes.get(segment.startNodeId);
			const end = graph.nodes.get(segment.endNodeId);
			if (!control || !start || !end) continue;

			const atStart = segment.startNodeId === node.id;
			const tangent = getQuadraticBezierTangent(
				start.x,
				start.y,
				control.cx,
				control.cy,
				end.x,
				end.y,
				atStart ? 0 : 1
			);
			const length = Math.hypot(tangent.x, tangent.y);
			if (length < 0.0001) continue;
			const dir = atStart
				? { x: tangent.x / length, y: tangent.y / length }
				: { x: -tangent.x / length, y: -tangent.y / length };

			const trim = trims.get(segmentId);
			const trimHere = (atStart ? trim?.start : trim?.end) ?? 0;
			arms.push({
				dir,
				angle: Math.atan2(dir.y, dir.x),
				reach: Math.max(trimHere, segment.totalWidth / 2) + 3
			});
		}
		if (arms.length < 2) continue;
		arms.sort((a, b) => a.angle - b.angle);

		for (let i = 0; i < arms.length; i++) {
			const a = arms[i];
			const b = arms[(i + 1) % arms.length];
			let gap = b.angle - a.angle;
			if (i === arms.length - 1) gap += Math.PI * 2;
			if (gap <= 0 || gap >= SHARP_PAIR_ANGLE) continue;

			const reach = Math.max(a.reach, b.reach);
			const points: Point[] = [
				{ x: node.x, y: node.y },
				{ x: node.x + a.dir.x * reach, y: node.y + a.dir.y * reach },
				{ x: node.x + b.dir.x * reach, y: node.y + b.dir.y * reach }
			];
			wedges.push({ path: toClipperPath(points), points });
		}
	}
	return wedges;
}

// The face polygon minus every nearby road ribbon and node disc — the lot
// surface that remains between the streets.
function carveBlock(
	graph: Graph,
	facePoints: Point[],
	boundaryIds: string[],
	wedges: { path: Path; points: Point[] }[]
): PolygonWithHoles[] {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const point of facePoints) {
		minX = Math.min(minX, point.x);
		minY = Math.min(minY, point.y);
		maxX = Math.max(maxX, point.x);
		maxY = Math.max(maxY, point.y);
	}

	const boundary = new Set(boundaryIds);
	const clips: Path[] = [];

	for (const segment of graph.segments.values()) {
		const start = graph.nodes.get(segment.startNodeId);
		const end = graph.nodes.get(segment.endNodeId);
		if (!start || !end) continue;

		// Anything overlapping the face's bounds can intrude — including
		// roads fully inside the block that aren't on its boundary.
		const half = segment.totalWidth / 2;
		if (!boundary.has(segment.id)) {
			const sMinX = Math.min(start.x, end.x) - half;
			const sMaxX = Math.max(start.x, end.x) + half;
			const sMinY = Math.min(start.y, end.y) - half;
			const sMaxY = Math.max(start.y, end.y) + half;
			if (sMaxX < minX || sMinX > maxX || sMaxY < minY || sMinY > maxY) continue;
		}

		clips.push(ribbonPath(graph, segment, half));
	}
	// No node discs: any block spill into a bend or junction gap sits below
	// the corner bands and plates, which render on top of it. Sharp-pair
	// pockets are the exception — nothing renders over them, so their
	// wedges are cleared explicitly.
	for (const wedge of wedges) {
		const inBounds = wedge.points.some(
			(point) => point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY
		);
		if (inBounds) clips.push(wedge.path);
	}

	const subject = toClipperPath(facePoints);
	const paths = executeBoolean(
		ClipperLib.ClipType.ctDifference,
		[orient(subject)],
		clips.map(orient)
	);

	// Bleed the block back under the road edges to seal corner/junction
	// notches, but never past a centerline onto the far side — clamp to the
	// narrowest boundary road's half-width.
	let minHalf = Infinity;
	for (const id of boundaryIds) {
		const segment = graph.segments.get(id);
		if (segment) minHalf = Math.min(minHalf, segment.totalWidth / 2);
	}
	const bleed = Math.min(BLOCK_BLEED, minHalf);
	const grown = bleed > 0 ? offsetPaths(paths, bleed) : paths;
	return pathsToPolygons(grown.length > 0 ? grown : paths);
}

// Clipper decides fill by winding; every input must be positively oriented
// or differences shred into fragments.
function orient(path: Path): Path {
	if (!ClipperLib.Clipper.Orientation(path)) {
		path.reverse();
	}
	return path;
}

function ribbonPath(graph: Graph, segment: Segment, half: number): Path {
	const start = graph.nodes.get(segment.startNodeId)!;
	const end = graph.nodes.get(segment.endNodeId)!;
	const control = segmentControl(graph, segment)!;
	const samples = segment.hasControlPoint ? CURVE_SAMPLES : 1;

	const left: Point[] = [];
	const right: Point[] = [];
	for (let i = 0; i <= samples; i++) {
		const t = i / samples;
		const point = getQuadraticBezierPoint(
			start.x,
			start.y,
			control.cx,
			control.cy,
			end.x,
			end.y,
			t
		);
		const tangent = getQuadraticBezierTangent(
			start.x,
			start.y,
			control.cx,
			control.cy,
			end.x,
			end.y,
			t
		);
		const length = Math.hypot(tangent.x, tangent.y);
		const nx = length > 0.0001 ? -tangent.y / length : 0;
		const ny = length > 0.0001 ? tangent.x / length : 1;
		left.push({ x: point.x + nx * half, y: point.y + ny * half });
		right.push({ x: point.x - nx * half, y: point.y - ny * half });
	}
	right.reverse();
	return toClipperPath([...left, ...right]);
}
