// Where a road actually is: its segment's drawn line (a straight line or one
// quadratic curve between its nodes, an end attached at another road's edge
// moved there) moved sideways by the segment's shift. Each end has its own
// shift (`offsetStart`, `offsetEnd`); between them the shift blends linearly
// with distance along the drawn line, so a straight road whose ends differ
// still shows as a straight line. The drawing (`core/place.ts`, the road's
// `lean`) blends the same way, by the same measure of length
// (core/segment-curve.ts).
// Every editing path that asks "is the pointer on this road?" or "where along
// this road?" reads this line, so the editor works on the road the user sees.
// Nodes stay on the drawn lines (they are where segments meet) but show, and
// are picked, where their roads meet (`nodePoint`).

import type { GraphView as Graph } from './graph.svelte';
import { roadwayOf, segmentEnds, type SegmentLike } from './attach';
import { getQuadraticBezierPoint, getQuadraticBezierTangent } from '../geometry/bezier';
import {
	controlPointOf,
	type Curve,
	lengthTo,
	quadratic as curveThrough,
	tAt,
	type Frame
} from './segment-curve';

export interface Pt {
	x: number;
	y: number;
}

// What the shown line needs of a segment besides its ends.
interface Shifted {
	controlX?: number;
	controlY?: number;
	offsetStart: number;
	offsetEnd: number;
}

const SAMPLES = 48;

// A segment's shift at one of its ends.
export const offsetAt = (segment: Shifted, end: 'start' | 'end') =>
	end === 'start' ? segment.offsetStart : segment.offsetEnd;

// A segment's shift where it meets a node, read to the right of the way
// out of the node along it (positive is the same side whichever way the
// segment was drawn).
export const offsetOutOf = (segment: Shifted & { startNodeId: string }, nodeId: string) =>
	segment.startNodeId === nodeId ? segment.offsetStart : -segment.offsetEnd;

// Whether a road at a node is shifted where it meets it, so its end there
// shows off the node.
export const shiftedAt = (graph: Graph, nodeId: string) =>
	(graph.nodes.get(nodeId)?.connectedSegments ?? []).some((id) => {
		const segment = graph.segments.get(id);
		return !!segment && offsetOutOf(segment, nodeId) !== 0;
	});

// The shift a fraction f of the way along the road (by length).
const shiftAlong = (segment: Shifted, f: number) =>
	segment.offsetStart + (segment.offsetEnd - segment.offsetStart) * f;

// The shift where a road shifted `start` to `end` is cut in two, `before`
// metres of its length on one side of the cut and `after` on the other, the
// lengths of the halves' curves (core/segment-curve.ts). The split
// (splitSegment in core/crossings.ts) stores it at the cut and the join
// (carriedOn in core/place.ts) expects it there, both from those curves, so a
// cut anywhere on any road joins back into the road it was.
export const shiftAtCut = (start: number, end: number, before: number, after: number) =>
	start + ((end - start) * before) / (before + after || 1);

type Quad = { a: Pt; c: Pt; b: Pt };

function quadratic(segment: Shifted, a: Pt, b: Pt): Quad {
	const c = {
		x: segment.controlX ?? (a.x + b.x) / 2,
		y: segment.controlY ?? (a.y + b.y) / 2
	};
	return { a, c, b };
}

const pointOf = (q: Quad, t: number) =>
	getQuadraticBezierPoint(q.a.x, q.a.y, q.c.x, q.c.y, q.b.x, q.b.y, t);

function normalOf(q: Quad, t: number) {
	const d = getQuadraticBezierTangent(q.a.x, q.a.y, q.c.x, q.c.y, q.b.x, q.b.y, t);
	const l = Math.hypot(d.x, d.y) || 1;
	const tangent = { x: d.x / l, y: d.y / l };
	return { tangent, normal: { x: -tangent.y, y: tangent.x } };
}

// How far along a curve t is, as a fraction of its length, measured as the
// drawing measures it.
const fractionAt = (curve: Curve, t: number) =>
	curve.length > 1e-9 ? lengthTo(curve, t) / curve.length : t;

// The drawn line's point and the road's point at t, with the right normal
// (of the drawing direction) and the shift there, for a segment drawn from
// a to b (its curve, `curve`, read off a and b where not given).
export function shownAt(segment: Shifted, a: Pt, b: Pt, t: number, curve?: Curve) {
	const q = quadratic(segment, a, b);
	const line = pointOf(q, t);
	const { tangent, normal } = normalOf(q, t);
	const shift =
		segment.offsetStart === segment.offsetEnd
			? segment.offsetStart
			: shiftAlong(segment, fractionAt(curve ?? curveThrough(q.a, q.c, q.b), t));
	const point = { x: line.x + normal.x * shift, y: line.y + normal.y * shift };
	return { line, point, tangent, normal, shift };
}

// Where a point lies across a road, read the way the drawing lays the
// road's lanes (crossSection in road-model/geometry.ts: each lane edge its
// offset along the drawn line's normal, the shift there added): the point
// of the drawn line the point lies square to (`t`, found from `guess`, a t
// near it), and how far right of the road's shown line it lies along the
// drawn line's normal there (`across`). Every reader of where a road's
// curb or a lane edge is reads it so, shift varying along the road and
// curve and all, so a point put on a curb (sideOf) reads as on it.
export function acrossRoad(segment: Shifted, a: Pt, b: Pt, p: Pt, guess: number, curve?: Curve) {
	const q = quadratic(segment, a, b);
	// Newton's method on (C(t) - p) · C'(t), from the guess.
	const dd = { x: 2 * (q.a.x - 2 * q.c.x + q.b.x), y: 2 * (q.a.y - 2 * q.c.y + q.b.y) };
	let t = Math.max(0, Math.min(1, guess));
	for (let i = 0; i < 8; i++) {
		const c = pointOf(q, t);
		const d = getQuadraticBezierTangent(q.a.x, q.a.y, q.c.x, q.c.y, q.b.x, q.b.y, t);
		const [ex, ey] = [c.x - p.x, c.y - p.y];
		const slope = d.x * d.x + d.y * d.y + ex * dd.x + ey * dd.y;
		if (slope <= 1e-12) break;
		const next = Math.max(0, Math.min(1, t - (ex * d.x + ey * d.y) / slope));
		const done = Math.abs(next - t) < 1e-12;
		t = next;
		if (done) break;
	}
	const at = shownAt(segment, a, b, t, curve);
	return { t, across: (p.x - at.point.x) * at.normal.x + (p.y - at.point.y) * at.normal.y };
}

// The same, for a segment of the graph (its ends as drawn).
export function roadAt(graph: Graph, segment: SegmentLike, t: number) {
	const ends = segmentEnds(graph, segment);
	return ends ? shownAt(segment, ends.a, ends.b, t) : null;
}

// How a footpath is carried while a gesture places a node by where its end
// shows (endsAt): its chord from its start node to its end node when the
// gesture began (`heading`), how far each node then lay from where its end
// showed (`off`), and its curve, carried in the frame of its two nodes as a
// drag bends it (`frame`: controlFrame in core/segment-curve.ts), or its
// handle left where it is (`handle`), or neither where it is straight.
export type Bend = { heading: Pt; off: Record<'start' | 'end', Pt>; frame?: Frame; handle?: Pt };

// How far each node of a segment lies from where its end shows (Bend.off).
export function shownOffs(
	graph: Graph,
	segment: SegmentLike & { startNodeId: string; endNodeId: string }
) {
	const off = (id: string, t: number) => {
		const node = graph.nodes.get(id);
		const end = roadAt(graph, segment, t)?.point;
		return node && end ? { x: node.x - end.x, y: node.y - end.y } : { x: 0, y: 0 };
	};
	return { start: off(segment.startNodeId, 0), end: off(segment.endNodeId, 1) };
}

// The shortest a shifted road placed by its end is made (m), the shortest
// draw mode lays (MIN_PREVIEW_LENGTH in modes/draw.ts).
const SHORTEST = 1;

// How near two points are read as one spot (m).
const ONE_SPOT = 1e-9;

// Points as complex numbers: `over(p, q)` is p turned back by q (and divided
// by its length).
const over = (p: Pt, q: Pt) => {
	const qq = q.x * q.x + q.y * q.y || 1;
	return { x: (p.x * q.x + p.y * q.y) / qq, y: (p.y * q.x - p.x * q.y) / qq };
};
const unit = (p: Pt) => {
	const l = Math.hypot(p.x, p.y);
	return l > 1e-12 ? { x: p.x / l, y: p.y / l } : { x: 1, y: 0 };
};
const dot = (p: Pt, q: Pt) => p.x * q.x + p.y * q.y;

// Where the node at end `k` of a road goes for that end to show at `shows`,
// `far` where its other node lies, or null where the gesture may move that
// node too (placedBy in core/drag.ts). A gesture that puts a footpath's end
// somewhere by where it shows (a node sliding along a walkway, kept on one
// its street draws anew, dropped on a sidewalk, riding a car road with its
// far node still) places its node here, so it is decided once:
//
// - An end with no shift shows on its node, which goes exactly there.
// - A shifted end is placed exactly only where its far node stays where it
//   lies (`far` given). Where the gesture may move that node too, the node
//   keeps as far from its end as when the gesture began (`bend.off`), as a
//   road with no shift is carried: exact for a road moved bodily, which is
//   what such a gesture does to it, and never solved against a node that
//   may move.
//
// A shifted end shows its shift (offsetOutOf) square to the way the road
// leaves its node, and that way turns as the node moves. It is solved
// outright, never walked toward from where the node lies now, so the answer
// is the same however many pointer updates a gesture took. The way out of
// the node is the chord toward the far node turned by an angle the move
// keeps: none for a straight road, the angle the handle makes in the frame
// of the nodes for a curve carried in that frame (`bend.frame`). A curve
// whose handle is left where it is (`bend.handle`) leaves the node toward
// the handle, which stands in for the far node. So with the chord L long
// (SHORTEST or more) along û from the node, the end shows z·û past the node
// (z the shift across the way out, as a complex number turned by that
// angle), and the far node, or the handle, lies (L − z)·û past the end:
// |L − z| is how far it lies from where the end is to show, which gives L
// and then û. Where two L answer, the one taken turns the chord least from
// the way it ran when the gesture began (`bend.heading`).
//
// A road is never turned round to show its end somewhere. Two ways it may
// run hold the measure: the way it ran when the gesture began, and the way
// it runs with the node kept as far from its end as then, which a drag
// swinging an end round past its far node turns round too. Where the
// answer's chord runs more than a right angle from both, or none answers
// (the end asked to show nearer the far node than the shift lets it), the
// node keeps as far from its end as then. That leaves its end off its
// target by as much as the turn since the gesture began moves it.
export function endsAt(
	segment: Shifted & { startNodeId: string; endNodeId: string },
	bend: Bend,
	k: 'start' | 'end',
	shows: Pt,
	far: Pt | null
): Pt {
	const shift = offsetOutOf(segment, k === 'start' ? segment.startNodeId : segment.endNodeId);
	if (shift === 0) return shows;
	const kept = { x: shows.x + bend.off[k].x, y: shows.y + bend.off[k].y };
	if (!far) return kept;
	const heading = k === 'start' ? bend.heading : { x: -bend.heading.x, y: -bend.heading.y };
	// The way out of the node as a turn from the chord toward the far node
	// (frameOf: the handle lies u along the chord from the start and v
	// across it), from the curve's derivative there; none where the handle
	// lies on the node, as shownAt reads it.
	const frame = bend.handle ? null : bend.frame;
	const d0 = !frame
		? { x: 1, y: 0 }
		: k === 'start'
			? { x: frame.u, y: frame.v }
			: { x: 1 - frame.u, y: -frame.v };
	const l0 = Math.hypot(d0.x, d0.y) || 1;
	const way = { x: d0.x / l0, y: d0.y / l0 };
	const z = { x: -way.y * shift, y: way.x * shift };
	const to = bend.handle ?? far;
	const shortest = bend.handle ? 0 : SHORTEST;
	const w = { x: to.x - shows.x, y: to.y - shows.y };
	const d = Math.hypot(w.x, w.y);
	// Each L of `shortest` or more with |L − z| = d, and the chord's way for
	// it: the way from where the end is to show to `to`, turned back by
	// L − z's angle, or `heading` where they are one spot (which only an
	// L − z of nothing answers).
	const answers: { length: number; u: Pt }[] = [];
	if (d > ONE_SPOT) {
		if (d < Math.abs(z.y)) return kept;
		const root = Math.sqrt(d * d - z.y * z.y);
		for (const length of root > 0 ? [z.x + root, z.x - root] : [z.x])
			if (length >= shortest)
				answers.push({ length, u: unit(over(w, { x: length - z.x, y: -z.y })) });
	} else if (Math.abs(z.y) <= ONE_SPOT && z.x >= shortest)
		answers.push({ length: z.x, u: unit(heading) });
	const best = answers.sort((p, q) => dot(q.u, heading) - dot(p.u, heading))[0];
	if (!best) return kept;
	const node = { x: to.x - best.u.x * best.length, y: to.y - best.u.y * best.length };
	const chord = { x: far.x - node.x, y: far.y - node.y };
	const keptChord = { x: far.x - kept.x, y: far.y - kept.y };
	return dot(chord, heading) > 0 || dot(chord, keptChord) > 0 ? node : kept;
}

// The road's centreline from a to b, sampled, with the right normal at
// each point.
export function shownLine(segment: Shifted, a: Pt, b: Pt, samples = SAMPLES) {
	const q = quadratic(segment, a, b);
	const curve = segment.offsetStart === segment.offsetEnd ? null : curveThrough(q.a, q.c, q.b);
	return Array.from({ length: samples + 1 }, (_, i) => {
		const t = i / samples;
		const p = pointOf(q, t);
		const { normal } = normalOf(q, t);
		const shift = shiftAlong(segment, curve ? fractionAt(curve, t) : t);
		return { x: p.x + normal.x * shift, y: p.y + normal.y * shift, t, normal };
	});
}

// A segment's curve between its ends as drawn (endAt in core/attach.ts), or
// null where it has none.
export function drawnCurve(graph: Graph, segment: SegmentLike) {
	const ends = segmentEnds(graph, segment);
	return ends && curveThrough(ends.a, controlPointOf(segment), ends.b);
}

// The road's centreline, sampled.
export function roadLine(graph: Graph, segment: SegmentLike, samples = SAMPLES) {
	const ends = segmentEnds(graph, segment);
	return ends ? shownLine(segment, ends.a, ends.b, samples) : [];
}

// What a road's shown line is made of: its segment's ends as drawn, its
// curve's handle and its shift at each end. The drawing keeps one object per
// segment while these stay the same (PlaceBuilder.lines, Networks.shown,
// both a LineBook).
export interface LineFrom extends Shifted {
	a: Pt;
	b: Pt;
}

export function lineFrom(graph: Graph, segment: SegmentLike): LineFrom | null {
	const ends = segmentEnds(graph, segment);
	return ends && lineThrough(segment, ends.a, ends.b);
}

export const lineThrough = (segment: Shifted, a: Pt, b: Pt): LineFrom => ({
	a,
	b,
	controlX: segment.controlX,
	controlY: segment.controlY,
	offsetStart: segment.offsetStart,
	offsetEnd: segment.offsetEnd
});

// Each segment's shown line as the last build drew it, changed in place
// from build to build, and views of it as it stood when each was taken
// (`view`): a view reads every line as it was then, whatever is written
// after, by keeping for itself the line each write replaces, the first time
// that segment is written. So taking a view copies nothing, and a write
// costs one entry for each view still held. A reader done with a view
// releases it (`release`, after which it reads no more), so what a write
// walks never depends on how many views the runtime has yet to collect; one
// never released is forgotten once collected, the next time the views are
// walked. A reader that only needs the lines as they are now reads `get`,
// taking none.
export class LineBook {
	#now = new Map<string, LineFrom>();
	#views: WeakRef<Map<string, LineFrom | undefined>>[] = [];
	// How many lines it has set or taken out, and how many views it has
	// walked, counted only while a test turns counting on (`on`).
	static written = { on: false, count: 0 };
	static walked = { on: false, count: 0 };

	get(id: string) {
		return this.#now.get(id);
	}
	keys() {
		return this.#now.keys();
	}
	// Sets a segment's line, or takes it out (undefined).
	set(id: string, line: LineFrom | undefined) {
		const was = this.#now.get(id);
		if (was === line) return;
		this.#walk((kept) => {
			if (!kept.has(id)) kept.set(id, was);
		});
		if (LineBook.written.on) LineBook.written.count++;
		if (line) this.#now.set(id, line);
		else this.#now.delete(id);
	}
	view(): { get(id: string): LineFrom | undefined; release(): void } {
		this.#walk(() => {});
		const kept = new Map<string, LineFrom | undefined>();
		const ref = new WeakRef(kept);
		this.#views.push(ref);
		return {
			get: (id) => (kept.has(id) ? kept.get(id) : this.#now.get(id)),
			release: () => {
				const at = this.#views.indexOf(ref);
				if (at >= 0) this.#views.splice(at, 1);
			}
		};
	}
	// Each view still held, the rest forgotten.
	#walk(each: (kept: Map<string, LineFrom | undefined>) => void) {
		let k = 0;
		for (const ref of this.#views) {
			if (LineBook.walked.on) LineBook.walked.count++;
			const kept = ref.deref();
			if (!kept) continue;
			this.#views[k++] = ref;
			each(kept);
		}
		this.#views.length = k;
	}
}

// Whether a road's line from `line` is the one it shows from `a` to `b` now.
export const sameLine = (line: LineFrom, segment: Shifted, a: Pt, b: Pt) =>
	line.a.x === a.x &&
	line.a.y === a.y &&
	line.b.x === b.x &&
	line.b.y === b.y &&
	line.controlX === segment.controlX &&
	line.controlY === segment.controlY &&
	line.offsetStart === segment.offsetStart &&
	line.offsetEnd === segment.offsetEnd;

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
	node: { id: string; x: number; y: number; connectedSegments: readonly string[] }
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

// How far a point lies from the straight line between `a` and `b` (a chord
// of a sampled line).
export const distanceToChord = (p: Pt, a: Pt, b: Pt) => {
	const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1;
	const f = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2));
	return Math.hypot(a.x + (b.x - a.x) * f - p.x, a.y + (b.y - a.y) * f - p.y);
};

// How far a node shows (`nodePoint`) from where it lies.
export function shownOff(
	graph: Graph,
	node: { id: string; x: number; y: number; connectedSegments: readonly string[] }
) {
	const p = nodePoint(graph, node);
	return { x: p.x - node.x, y: p.y - node.y };
}

// Where a footpath's end goes on a car road (draw mode snaps it there): the
// middle of the road's walkway nearest (x, y), the one under it if any, a
// walkway down the street's middle as much as a sidewalk at its side; or,
// nearer a side with no sidewalk, that side's curb. Given a walkway
// (`lane`, a pedestrian lane's id), the middle of that one alone, or
// nowhere if the road has no such walkway: a footpath's end joined to it
// slides along it. Never on a node nor on a car lane, so it changes no car
// road (core/networks.ts). Where the road is drawn trimmed back from its
// nodes (`drawn`, its span: Derived.spans), only along what is drawn, at
// least END_IN from either end, so the footpath's end lies on it. A segment
// cut from a road drawn as one has no end where the road carries on past it
// (its span reaching before or beyond it), and snaps all along.
export function sideOf(
	graph: Graph,
	segment: SegmentLike,
	x: number,
	y: number,
	drawn?: { d0: number; length: number; total: number },
	lane?: string
) {
	const ends = segmentEnds(graph, segment);
	if (!ends) return null;
	const p = { x, y };
	let t = acrossRoad(segment, ends.a, ends.b, p, closestOnRoad(graph, segment, x, y).t).t;
	const curve = drawn && drawnCurve(graph, segment);
	if (drawn && curve) {
		const end = drawn.d0 + drawn.length;
		const lo = drawn.d0 < -ON_PAST ? 0 : Math.max(0, drawn.d0) + END_IN;
		const hi = end > drawn.total + ON_PAST ? drawn.total : Math.min(drawn.total, end) - END_IN;
		if (lo < hi) t = tAt(curve, Math.min(hi, Math.max(lo, lengthTo(curve, t))));
	}
	const at = shownAt(segment, ends.a, ends.b, t);
	const across = (x - at.point.x) * at.normal.x + (y - at.point.y) * at.normal.y;
	const r = roadwayOf(segment.lanes);
	// Each place it may go, with the walkway's own stretch across the road
	// (`own`) and the stretch it stands for (`lo` to `hi`): each walkway (a
	// sidewalk reaching on to its curb, so the nearer curb decides between
	// sidewalks either side), and the curb of a side with no sidewalk.
	const places: { o: number; own: [number, number]; lo: number; hi: number }[] = [];
	let left = -segment.lanes.reduce((sum, l) => sum + l.width, 0) / 2;
	for (const l of segment.lanes) {
		const [lo, hi] = [left, left + l.width];
		left = hi;
		if (l.role !== 'pedestrian' || (lane !== undefined && l.id !== lane)) continue;
		places.push({
			o: (lo + hi) / 2,
			own: [lo, hi],
			lo: Math.min(lo, r.hi),
			hi: Math.max(hi, r.lo)
		});
	}
	if (lane !== undefined && !places.length) return null;
	if (lane === undefined) {
		const curb = (o: number) => ({ o, own: [o, o] as [number, number], lo: o, hi: o });
		if (!places.some((p) => p.o < r.lo)) places.push(curb(r.lo));
		if (!places.some((p) => p.o > r.hi)) places.push(curb(r.hi));
	}
	// The walkway under the point; where none is, the nearest; of two as
	// near, the one whose middle is nearer, and of two as near still the one
	// further right. (A sidewalk reaching on to its curb reaches over any
	// walkway between, so it is only as near as one under the point where no
	// walkway is.)
	const score = (p: (typeof places)[number]) => [
		across >= p.own[0] && across <= p.own[1] ? 0 : 1,
		Math.max(0, p.lo - across, across - p.hi),
		Math.abs(p.o - across)
	];
	const before = (s: number[], t: number[]) => {
		for (let k = 0; k < s.length; k++) if (s[k] !== t[k]) return s[k] < t[k];
		return true;
	};
	const best = places
		.sort((p, q) => p.o - q.o)
		.reduce((b, p) => (before(score(p), score(b)) ? p : b));
	return { x: at.point.x + at.normal.x * best.o, y: at.point.y + at.normal.y * best.o };
}

// How far inside a road's drawn ends a footpath's end snaps at the least (m).
export const END_IN = 1;
// How far past a segment's end its road must reach to carry on there (m).
const ON_PAST = 1e-6;
