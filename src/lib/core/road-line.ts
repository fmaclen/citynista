// Where a road actually is: its segment's drawn line (a straight line or one
// quadratic curve between its nodes, an end attached at another road's edge
// moved there) moved sideways by the segment's shift. Each end has its own
// shift (`offsetStart`, `offsetEnd`); between them the shift blends linearly
// with distance along the drawn line, so a straight road whose ends differ
// still shows as a straight line. The drawing (`core/place.ts`, the road's
// `lean`) blends the same way.
// Every editing path that asks "is the pointer on this road?" or "where along
// this road?" reads this line, so the editor works on the road the user sees.
// Nodes stay on the drawn lines (they are where segments meet) but show, and
// are picked, where their roads meet (`nodePoint`).

import type { Graph } from './graph.svelte';
import { segmentEnds, type SegmentLike } from './attach';

export interface Pt {
	x: number;
	y: number;
}

// What the shown line needs of a segment besides its ends.
export interface Shifted {
	controlX?: number;
	controlY?: number;
	offsetStart: number;
	offsetEnd: number;
}

const SAMPLES = 48;
// Steps for measuring how far along a curve a point is.
const LENGTH_STEPS = 24;

// A segment's shift at one of its ends.
export const offsetAt = (segment: Shifted, end: 'start' | 'end') =>
	end === 'start' ? segment.offsetStart : segment.offsetEnd;

// A segment's shift where it meets a node, read to the right of the way
// out of the node along it (positive is the same side whichever way the
// segment was drawn).
export const offsetOutOf = (segment: Shifted & { startNodeId: string }, nodeId: string) =>
	segment.startNodeId === nodeId ? segment.offsetStart : -segment.offsetEnd;

// The shift a fraction f of the way along the road (by length).
const shiftAlong = (segment: Shifted, f: number) =>
	segment.offsetStart + (segment.offsetEnd - segment.offsetStart) * f;

type Quad = { a: Pt; c: Pt; b: Pt };

function quadratic(segment: Shifted, a: Pt, b: Pt): Quad {
	const c = {
		x: segment.controlX ?? (a.x + b.x) / 2,
		y: segment.controlY ?? (a.y + b.y) / 2
	};
	return { a, c, b };
}

function pointOf(q: Quad, t: number) {
	const u = 1 - t;
	return {
		x: u * u * q.a.x + 2 * u * t * q.c.x + t * t * q.b.x,
		y: u * u * q.a.y + 2 * u * t * q.c.y + t * t * q.b.y
	};
}

function normalOf(q: Quad, t: number) {
	const u = 1 - t;
	const d = {
		x: 2 * u * (q.c.x - q.a.x) + 2 * t * (q.b.x - q.c.x),
		y: 2 * u * (q.c.y - q.a.y) + 2 * t * (q.b.y - q.c.y)
	};
	const l = Math.hypot(d.x, d.y) || 1;
	const tangent = { x: d.x / l, y: d.y / l };
	return { tangent, normal: { x: -tangent.y, y: tangent.x } };
}

// How far along the curve t is, as a fraction of its length.
function lengthFraction(q: Quad, t: number) {
	let total = 0;
	let upTo = 0;
	let prev = q.a;
	for (let i = 1; i <= LENGTH_STEPS; i++) {
		const s = i / LENGTH_STEPS;
		const p = pointOf(q, s);
		const l = Math.hypot(p.x - prev.x, p.y - prev.y);
		upTo += l * Math.max(0, Math.min(1, (t - (s - 1 / LENGTH_STEPS)) * LENGTH_STEPS));
		total += l;
		prev = p;
	}
	return total > 1e-9 ? upTo / total : t;
}

// The drawn line's point and the road's point at t, with the right normal
// (of the drawing direction) and the shift there, for a segment drawn from
// a to b.
export function shownAt(segment: Shifted, a: Pt, b: Pt, t: number) {
	const q = quadratic(segment, a, b);
	const line = pointOf(q, t);
	const { tangent, normal } = normalOf(q, t);
	const shift =
		segment.offsetStart === segment.offsetEnd
			? segment.offsetStart
			: shiftAlong(segment, lengthFraction(q, t));
	const point = { x: line.x + normal.x * shift, y: line.y + normal.y * shift };
	return { line, point, tangent, normal, shift };
}

// The same, for a segment of the graph (its ends as drawn).
export function roadAt(graph: Graph, segment: SegmentLike, t: number) {
	const ends = segmentEnds(graph, segment);
	return ends ? shownAt(segment, ends.a, ends.b, t) : null;
}

// The road's centreline from a to b, sampled, with the right normal at
// each point.
export function shownLine(segment: Shifted, a: Pt, b: Pt, samples = SAMPLES) {
	const q = quadratic(segment, a, b);
	const lines: Pt[] = [];
	const lengths = [0];
	for (let i = 0; i <= samples; i++) {
		const p = pointOf(q, i / samples);
		if (i) lengths.push(lengths[i - 1] + Math.hypot(p.x - lines[i - 1].x, p.y - lines[i - 1].y));
		lines.push(p);
	}
	const total = lengths[samples] || 1;
	return lines.map((p, i) => {
		const t = i / samples;
		const { normal } = normalOf(q, t);
		const shift = shiftAlong(segment, lengths[i] / total);
		return { x: p.x + normal.x * shift, y: p.y + normal.y * shift, t, normal };
	});
}

// The road's centreline, sampled.
export function roadLine(graph: Graph, segment: SegmentLike, samples = SAMPLES) {
	const ends = segmentEnds(graph, segment);
	return ends ? shownLine(segment, ends.a, ends.b, samples) : [];
}

// The nearest point of the road's centreline to (x, y): where along the
// segment (t), how far, and the point itself.
export function closestOnRoad(graph: Graph, segment: SegmentLike, x: number, y: number) {
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
// on its road (shift and all), so its ring and hit area sit on the roads
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
