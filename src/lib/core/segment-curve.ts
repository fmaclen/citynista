// A segment's curve between its two drawn ends: a straight line or one
// quadratic piece, measured along its length, and the piece of it a road
// covers as road points.

import { getQuadraticBezierPoint, getQuadraticBezierTangent } from '../geometry/bezier';
import type { End, PathPoint, Pt } from '../road-model/model';
import type { Graph } from './graph.svelte';
import type { Segment } from './segment.svelte';

export interface Curve {
	a: Pt;
	c: Pt | null;
	b: Pt;
	// Cumulative length at t = i / STEPS.
	arc: number[];
	length: number;
	// A road read on through the nodes it only carries on through
	// (core/place.ts): its segments' curves in order, all running the same
	// way, each over its share of t (in proportion to its length) from
	// `from`. Its `c` is any piece's control point (null where all are
	// straight, and so in line), its `arc` sampled over the whole.
	parts?: { curve: Curve; from: number; to: number; at: number }[];
}

export const STEPS = 64;

// Segments' curves read as one, end to end (Curve.parts). Neighbours that are
// the two pieces of one curve cut in two (splitSegment in core/crossings.ts:
// collinear lines running on, or a quadratic's halves) are that curve again,
// so a road cut and joined is sampled, and drawn, as it was uncut.
export function joinCurves(pieces: Curve[]): Curve {
	const curves: Curve[] = [];
	for (const curve of pieces) {
		const whole = curves.length ? rejoined(curves[curves.length - 1], curve) : null;
		if (whole) curves[curves.length - 1] = whole;
		else curves.push(curve);
	}
	if (curves.length === 1) return curves[0];
	const length = curves.reduce((sum, c) => sum + c.length, 0) || 1;
	let at = 0;
	const parts = curves.map((curve) => {
		const part = { curve, from: at / length, to: (at + curve.length) / length, at };
		at += curve.length;
		return part;
	});
	const joined: Curve = {
		a: curves[0].a,
		c: curves.find((c) => c.c)?.c ?? null,
		b: curves[curves.length - 1].b,
		arc: [],
		length: at,
		parts
	};
	joined.arc = Array.from({ length: STEPS + 1 }, (_, i) => lengthTo(joined, i / STEPS));
	return joined;
}

// How far two curves may lie from being one curve's two pieces (m).
const REJOIN = 1e-5;

// The one curve two curves, end to end, were cut from, or null. Straight:
// the second runs on in line. Quadratic: the first's control point lies a
// fraction t of the way from its start toward the whole's, the second's that
// fraction from the whole's toward its end, and the cut that fraction between
// the two (de Casteljau). Within REJOIN, which an end attached at an edge is
// placed well within (core/attach.ts).
function rejoined(p: Curve, q: Curve): Curve | null {
	if (p.parts || q.parts || !!p.c !== !!q.c) return null;
	const close = (u: Pt, v: Pt) => Math.hypot(u.x - v.x, u.y - v.y) < REJOIN;
	if (!close(p.b, q.a)) return null;
	const cross = (o: Pt, u: Pt, v: Pt) => (u.x - o.x) * (v.y - o.y) - (u.y - o.y) * (v.x - o.x);
	const run = (o: Pt, u: Pt, v: Pt) => (u.x - o.x) * (v.x - o.x) + (u.y - o.y) * (v.y - o.y);
	if (!p.c || !q.c) {
		const l = Math.hypot(q.b.x - p.a.x, q.b.y - p.a.y);
		if (l < REJOIN || Math.abs(cross(p.a, q.b, p.b)) / l > REJOIN) return null;
		if (run(p.a, p.b, q.b) <= 0 || run(q.b, p.b, p.a) <= 0) return null;
		return quadratic(p.a, null, q.b);
	}
	// Cut a fraction t of the way along, the cut lies that fraction from the
	// first's control toward the second's. The whole's control is read off
	// whichever piece is the longer (its end's own last digits weigh least
	// there), and each piece is then that fraction of it (de Casteljau).
	const [a, c1, c2, b] = [p.a, p.c, q.c, q.b];
	const l = Math.hypot(c2.x - c1.x, c2.y - c1.y);
	if (l < REJOIN) return null;
	const t = Math.hypot(p.b.x - c1.x, p.b.y - c1.y) / l;
	const lerp = (u: Pt, v: Pt) => ({ x: u.x + (v.x - u.x) * t, y: u.y + (v.y - u.y) * t });
	if (t <= 0 || t >= 1 || !close(lerp(c1, c2), p.b)) return null;
	const c =
		t >= 0.5
			? { x: a.x + (c1.x - a.x) / t, y: a.y + (c1.y - a.y) / t }
			: { x: (c2.x - t * b.x) / (1 - t), y: (c2.y - t * b.y) / (1 - t) };
	if (!close(lerp(a, c), c1) || !close(lerp(c, b), c2)) return null;
	return quadratic(a, c, b);
}

// The piece of a joined curve at t, and t within it.
function partAt(parts: NonNullable<Curve['parts']>, t: number) {
	const part = parts.find((p) => t <= p.to) ?? parts[parts.length - 1];
	const span = part.to - part.from;
	return { part, t: span > 0 ? Math.max(0, Math.min(1, (t - part.from) / span)) : 0 };
}

// How far along the curve t is.
export function lengthTo(curve: Curve, t: number): number {
	if (curve.parts) {
		const { part, t: u } = partAt(curve.parts, t);
		return part.at + lengthTo(part.curve, u);
	}
	const k = Math.min(STEPS - 1, Math.max(0, Math.floor(t * STEPS)));
	return curve.arc[k] + (curve.arc[k + 1] - curve.arc[k]) * (t * STEPS - k);
}

// A segment's curve handle, or null where it is straight.
export const controlPointOf = (s: { controlX?: number; controlY?: number }) =>
	s.controlX !== undefined && s.controlY !== undefined ? { x: s.controlX, y: s.controlY } : null;

export function curveOf(segment: Segment, a: Pt, b: Pt): Curve {
	return quadratic(a, controlPointOf(segment), b);
}

export function quadratic(a: Pt, c: Pt | null, b: Pt): Curve {
	const arc = [0];
	let prev = a;
	for (let i = 1; i <= STEPS; i++) {
		const p = c
			? getQuadraticBezierPoint(a.x, a.y, c.x, c.y, b.x, b.y, i / STEPS)
			: { x: a.x + ((b.x - a.x) * i) / STEPS, y: a.y + ((b.y - a.y) * i) / STEPS };
		arc.push(arc[i - 1] + Math.hypot(p.x - prev.x, p.y - prev.y));
		prev = p;
	}
	return { a, c, b, arc, length: arc[STEPS] };
}

export function tAt(curve: Curve, distance: number): number {
	const d = Math.max(0, Math.min(curve.length, distance));
	if (curve.parts) {
		const part = curve.parts.find((p) => d <= p.at + p.curve.length) ?? curve.parts.at(-1)!;
		return part.from + (part.to - part.from) * tAt(part.curve, d - part.at);
	}
	let i = 1;
	while (i < STEPS && curve.arc[i] < d) i++;
	const span = curve.arc[i] - curve.arc[i - 1];
	const f = span > 1e-9 ? (d - curve.arc[i - 1]) / span : 0;
	return (i - 1 + f) / STEPS;
}

export function pointAt(curve: Curve, t: number): Pt {
	if (curve.parts) {
		const { part, t: u } = partAt(curve.parts, t);
		return pointAt(part.curve, u);
	}
	if (!curve.c)
		return {
			x: curve.a.x + (curve.b.x - curve.a.x) * t,
			y: curve.a.y + (curve.b.y - curve.a.y) * t
		};
	const { a, c, b } = curve;
	return getQuadraticBezierPoint(a.x, a.y, c.x, c.y, b.x, b.y, t);
}

// Unit direction leaving the node along the segment.
export function outward(curve: Curve, end: End): Pt {
	if (curve.parts)
		return outward((end === 'start' ? curve.parts[0] : curve.parts.at(-1)!).curve, end);
	const from = end === 'start' ? curve.a : curve.b;
	const toward = curve.c ?? (end === 'start' ? curve.b : curve.a);
	const dx = toward.x - from.x;
	const dy = toward.y - from.y;
	const l = Math.hypot(dx, dy) || 1;
	return { x: dx / l, y: dy / l };
}

// Unit direction a segment's drawn line leaves one of its nodes in, the
// line running between the nodes themselves: toward its control point, or
// its far node when straight. Null where the two lie within 0.1 mm, so the
// callers (snapping in draw and select, paste) fall back rather than steer
// by a direction read off a near-zero line. attach.ts keeps its own, which
// gives up only at a nanometre (see there): don't merge the two blindly.
export function outOf(graph: Graph, segment: Segment, nodeId: string): Pt | null {
	const a = graph.nodes.get(segment.startNodeId);
	const b = graph.nodes.get(segment.endNodeId);
	if (!a || !b) return null;
	const [from, far] = segment.startNodeId === nodeId ? [a, b] : [b, a];
	const toward = segment.hasControlPoint ? { x: segment.controlX!, y: segment.controlY! } : far;
	const dx = toward.x - from.x;
	const dy = toward.y - from.y;
	const l = Math.hypot(dx, dy);
	return l < 1e-4 ? null : { x: dx / l, y: dy / l };
}

// A curved segment's control point in the frame of its nodes: along from
// its start to its end, and across, both as fractions of that chord. Put
// back with `toFrame` once the nodes have moved, the curve scales and turns
// with them. Null for a straight segment or one whose nodes coincide.
export function controlFrame(graph: Graph, segment: Segment) {
	const a = graph.nodes.get(segment.startNodeId);
	const b = graph.nodes.get(segment.endNodeId);
	const c = controlPointOf(segment);
	return a && b && c ? frameOf(a, b, c) : null;
}

export function toFrame(graph: Graph, segment: Segment, frame: Frame) {
	const a = graph.nodes.get(segment.startNodeId);
	const b = graph.nodes.get(segment.endNodeId);
	if (!a || !b) return;
	const c = fromFrame(a, b, frame);
	segment.setControlPoint(c.x, c.y);
}

export type Frame = { u: number; v: number };

// A point in the frame of the chord from `a` to `b` (controlFrame), or null
// where they coincide; `fromFrame` puts it back.
export function frameOf(a: Pt, b: Pt, c: Pt): Frame | null {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const lengthSq = dx * dx + dy * dy;
	if (lengthSq < 1e-4) return null;
	const rx = c.x - a.x;
	const ry = c.y - a.y;
	return { u: (rx * dx + ry * dy) / lengthSq, v: (dx * ry - dy * rx) / lengthSq };
}

export function fromFrame(a: Pt, b: Pt, frame: Frame): Pt {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	return { x: a.x + frame.u * dx - frame.v * dy, y: a.y + frame.u * dy + frame.v * dx };
}

// Unit direction along the segment away from the node at `end`, a fraction
// `u` of the way along its curve from there (1 is its far end).
export function headingFrom(curve: Curve, end: End, u: number): Pt {
	if (curve.parts) {
		const { part, t } = partAt(curve.parts, end === 'start' ? u : 1 - u);
		return headingFrom(part.curve, end, end === 'start' ? t : 1 - t);
	}
	if (!curve.c) return outward(curve, end);
	const t = end === 'start' ? u : 1 - u;
	const { a, c, b } = curve;
	const d = getQuadraticBezierTangent(a.x, a.y, c.x, c.y, b.x, b.y, t);
	const l = Math.hypot(d.x, d.y) || 1;
	const k = end === 'start' ? 1 : -1;
	return { x: (k * d.x) / l, y: (k * d.y) / l };
}

// The piece of the curve between two distances, as road points.
export function piece(curve: Curve, d0: number, d1: number): PathPoint[] {
	if (curve.parts) {
		// Each part's share, joined where one ends and the next begins.
		const pts: PathPoint[] = [];
		const clamp = (d: number, part: Curve) => Math.max(0, Math.min(part.length, d));
		for (const { curve: part, at } of curve.parts) {
			const [from, to] = [clamp(d0 - at, part), clamp(d1 - at, part)];
			if (to - from < 1e-9) continue;
			const own = piece(part, from, to);
			pts.push(...(pts.length ? own.slice(1) : own));
		}
		if (pts.length) return pts;
		const { curve: part, at } =
			curve.parts.find((p) => d0 <= p.at + p.curve.length) ?? curve.parts.at(-1)!;
		return piece(part, clamp(d0 - at, part), clamp(d0 - at, part));
	}
	const t0 = tAt(curve, d0);
	const t1 = tAt(curve, d1);
	const a = pointAt(curve, t0);
	const b = pointAt(curve, t1);
	if (!curve.c) return [a, b];
	// The sub-curve's control point (the quadratic's blossom at t0, t1),
	// raised to the cubic handles a road point stores.
	const { a: p0, c: p1, b: p2 } = curve;
	const k0 = (1 - t0) * (1 - t1);
	const k1 = (1 - t0) * t1 + t0 * (1 - t1);
	const k2 = t0 * t1;
	const q = { x: k0 * p0.x + k1 * p1.x + k2 * p2.x, y: k0 * p0.y + k1 * p1.y + k2 * p2.y };
	return [
		a,
		{
			...b,
			c1: { x: a.x + ((q.x - a.x) * 2) / 3, y: a.y + ((q.y - a.y) * 2) / 3 },
			c2: { x: b.x + ((q.x - b.x) * 2) / 3, y: b.y + ((q.y - b.y) * 2) / 3 }
		}
	];
}
