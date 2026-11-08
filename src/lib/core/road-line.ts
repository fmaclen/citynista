// Where a road actually is: its segment's drawn line (a straight line or one
// quadratic curve between its nodes, an end attached at another road's edge
// moved there) moved sideways by the segment's offset.
// Every editing path that asks "is the pointer on this road?" or "where along
// this road?" reads this line, so the editor works on the road the user sees.
// Nodes stay on the drawn lines (they are where segments meet) but show, and
// are picked, where their roads meet (`nodePoint`).

import type { Graph } from './graph.svelte';
import type { Segment } from './segment.svelte';
import { segmentEnds } from './attach';

export interface Pt {
	x: number;
	y: number;
}

const SAMPLES = 48;

function curve(graph: Graph, segment: Segment) {
	const ends = segmentEnds(graph, segment);
	if (!ends) return null;
	const { a, b } = ends;
	const c = {
		x: segment.controlX ?? (a.x + b.x) / 2,
		y: segment.controlY ?? (a.y + b.y) / 2
	};
	return { a, c, b };
}

// The drawn line's point and the road's point at t, with the right normal
// (of the drawing direction) there.
export function roadAt(graph: Graph, segment: Segment, t: number) {
	const q = curve(graph, segment);
	if (!q) return null;
	const u = 1 - t;
	const line = {
		x: u * u * q.a.x + 2 * u * t * q.c.x + t * t * q.b.x,
		y: u * u * q.a.y + 2 * u * t * q.c.y + t * t * q.b.y
	};
	const d = {
		x: 2 * u * (q.c.x - q.a.x) + 2 * t * (q.b.x - q.c.x),
		y: 2 * u * (q.c.y - q.a.y) + 2 * t * (q.b.y - q.c.y)
	};
	const l = Math.hypot(d.x, d.y) || 1;
	const tangent = { x: d.x / l, y: d.y / l };
	const normal = { x: -tangent.y, y: tangent.x };
	const point = {
		x: line.x + normal.x * segment.offset,
		y: line.y + normal.y * segment.offset
	};
	return { line, point, tangent, normal };
}

// The road's centreline, sampled.
export function roadLine(graph: Graph, segment: Segment, samples = SAMPLES) {
	const out: (Pt & { t: number })[] = [];
	for (let i = 0; i <= samples; i++) {
		const at = roadAt(graph, segment, i / samples);
		if (!at) return [];
		out.push({ ...at.point, t: i / samples });
	}
	return out;
}

// The nearest point of the road's centreline to (x, y): where along the
// segment (t), how far, and the point itself.
export function closestOnRoad(graph: Graph, segment: Segment, x: number, y: number) {
	const pts = roadLine(graph, segment);
	let best = { t: 0, distance: Infinity, x: 0, y: 0 };
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1];
		const b = pts[i];
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const l2 = dx * dx + dy * dy || 1;
		const f = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2));
		const px = a.x + dx * f;
		const py = a.y + dy * f;
		const distance = Math.hypot(px - x, py - y);
		if (distance < best.distance) best = { t: a.t + (b.t - a.t) * f, distance, x: px, y: py };
	}
	return best;
}

// Where a node shows: in the middle of the road ends that meet there, each
// on its road (offset and all), so its ring and hit area sit on the roads
// the user sees rather than on the drawn lines between them.
export function nodePoint(
	graph: Graph,
	node: { id: string; x: number; y: number; connectedSegments: string[] }
) {
	let x = 0;
	let y = 0;
	let n = 0;
	// Roads attached at an edge don't pull the ring off the others.
	const sides = graph.nodes.get(node.id)?.junction?.sides ?? {};
	const mains = node.connectedSegments.filter((id) => !sides[id]);
	for (const id of mains.length ? mains : node.connectedSegments) {
		const segment = graph.segments.get(id);
		const at = segment && roadAt(graph, segment, segment.startNodeId === node.id ? 0 : 1);
		if (!at) continue;
		x += at.point.x;
		y += at.point.y;
		n++;
	}
	return n ? { x: x / n, y: y / n } : { x: node.x, y: node.y };
}
