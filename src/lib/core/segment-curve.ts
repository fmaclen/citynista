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
}

export const STEPS = 64;

export function curveOf(segment: Segment, a: Pt, b: Pt): Curve {
	const c = segment.hasControlPoint ? { x: segment.controlX!, y: segment.controlY! } : null;
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

function tAt(curve: Curve, distance: number) {
	const d = Math.max(0, Math.min(curve.length, distance));
	let i = 1;
	while (i < STEPS && curve.arc[i] < d) i++;
	const span = curve.arc[i] - curve.arc[i - 1];
	const f = span > 1e-9 ? (d - curve.arc[i - 1]) / span : 0;
	return (i - 1 + f) / STEPS;
}

export function pointAt(curve: Curve, t: number): Pt {
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
	if (!a || !b || !segment.hasControlPoint) return null;
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const lengthSq = dx * dx + dy * dy;
	if (lengthSq < 1e-4) return null;
	const rx = segment.controlX! - a.x;
	const ry = segment.controlY! - a.y;
	return { u: (rx * dx + ry * dy) / lengthSq, v: (dx * ry - dy * rx) / lengthSq };
}

export function toFrame(graph: Graph, segment: Segment, frame: { u: number; v: number }) {
	const a = graph.nodes.get(segment.startNodeId);
	const b = graph.nodes.get(segment.endNodeId);
	if (!a || !b) return;
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	segment.setControlPoint(a.x + frame.u * dx - frame.v * dy, a.y + frame.u * dy + frame.v * dx);
}

// Unit direction along the segment away from the node at `end`, a fraction
// `u` of the way along its curve from there (1 is its far end).
export function headingFrom(curve: Curve, end: End, u: number): Pt {
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
