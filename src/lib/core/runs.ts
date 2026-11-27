// Where footpaths cross car roads, which the drawing paints as crossings
// (core/networks.ts). A crossing is paint alone: nothing in the graph marks
// it.
//
// A footpath crosses a car road where its run through the road's roadway
// enters it at one curb and leaves it at the other (`Run`). The roadway is
// the road as it is drawn (`Roadway`): the whole road a segment is part of,
// carried on through the nodes it only carries on through (carriedOn in
// place.ts), along the middle of its car lanes as they show, as wide as its
// car lanes, from end to end; a walkway down the street's middle parts it
// into one roadway for each carriageway (reaching up to that walkway, any
// buffer beside it included: carriagewaysOf in attach.ts), so a footpath
// ended on that walkway crosses the carriageway it came over, and one right
// across crosses each and walks the middle as the walkway it is. Past an end
// where other car roads meet it, a roadway runs on into their junction,
// round its end node as far as it is wide and inside the roads meeting
// there, and past a dead end not at all. A footpath is read where its paving
// lies: where it shows, its shift and all, and round a bend at its node as
// the bend is drawn (drawnLine), so a bend turning back inside a roadway
// never leaves it. Its pieces inside the roadway (`Stretch`) are joined at
// the footpath nodes lying inside it; a way across runs along them from one
// curb to the other passing no node twice, and the pieces and nodes on any
// such way are found at once, whatever the graph's size, ids or order
// (`onWays`). Leaving past a dead end reaches no curb: a footpath walked
// round a dead end crosses nothing. The footpath pieces inside one road's
// roadway joined at nodes there are one crossing (`RoadCrossing`), held by
// the least of their segments; pieces not so joined, a footpath leaving the
// roadway and coming back into it among them, are crossings apart. One
// crossing the middle in a junction is the crossing of the road there it
// crosses most squarely (heldAt).

import type { GraphView } from './graph.svelte';
import type { Segment } from './segment.svelte';
import { alongPath, frameAt, type PathSample, pieceAt, project } from '../road-model/geometry';
import { carriagewaysOf, segmentEnds } from './attach';
import { getTotalWidth } from './lane-template';
import { carries } from './lane-types';
import { carriedOn, chainThrough, roadThrough } from './place';
import { acrossRoad, drawnCurve, roadAt, roadLine, shownLine } from './road-line';
import { type Curve, tAt } from './segment-curve';

type Pt = { x: number; y: number };

const SAMPLES = 48;
// How far apart a footpath's line is read across a roadway (m).
const STEP = 0.5;
// How near the middle a footpath's node, or an end of the road, lies where
// a footpath crosses the middle there (m).
const AT_MIDDLE = 0.01;

// A car road's roadway (one carriageway of it) as a footpath crossing it
// reads it: the middle of the carriageway along the whole road as it shows
// (`path`, which places a point along it), half how wide it is, how far
// right of the road's shown line its middle lies (`mid`), each segment's
// line (`lines`) and, for each point of the path, the segment's line it
// lies on and where along it (`at`, which places a point across: acrossRoad
// in road-line.ts), the road's segments in order as drawn, named by the
// first, the segments of the road as it carries on before any parting
// (`chain`: chainThrough in place.ts, the whole loop where it is one), and
// the ids of the carriageway's car lanes (`lanes`): the chain and the lanes
// are what a crossing's control names it by (core/crossing-controls.ts),
// so where a loop is parted never matters to a control. Its end
// nodes, whether other car roads meet it there (`open`), the roadways of
// those roads (`beyond`, read no further), and the box round it. Its ends
// lie square to the road's drawn line (`drawn`: its segments' lines
// unshifted, end to end), as the drawing lays a road's end (endFrame in
// road-model/geometry.ts), however its shift slants its middle.
export interface Roadway {
	id: string;
	segments: string[];
	chain: string[];
	lanes: string[];
	path: PathSample;
	drawn: PathSample;
	half: number;
	mid: number;
	lines: RoadLine[];
	at: { k: number; t: number }[];
	ends: [string, string];
	open: [boolean, boolean];
	beyond: Roadway[];
	box: { x0: number; y0: number; x1: number; y1: number };
}

// A segment's line as a roadway reads it: the segment, its ends as drawn
// and its curve between them.
type RoadLine = { segment: Segment; a: Pt; b: Pt; curve: Curve };

type Box = Roadway['box'];
const apart = (a: Box, b: Box) => a.x1 < b.x0 || a.x0 > b.x1 || a.y1 < b.y0 || a.y0 > b.y1;

// The box round some points, grown by `half`.
function boxAround(pts: Pt[], half: number): Box {
	const xs = pts.map((p) => p.x);
	const ys = pts.map((p) => p.y);
	return {
		x0: Math.min(...xs) - half,
		y0: Math.min(...ys) - half,
		x1: Math.max(...xs) + half,
		y1: Math.max(...ys) + half
	};
}

// Whether a segment's line as it shows bends or its shift changes, so it is
// read finely.
const bent = (s: Segment) => s.controlX !== undefined || s.offsetStart !== s.offsetEnd;

// A segment's line as it shows, read finely enough where it bends or its
// shift changes.
const shown = (graph: GraphView, s: Segment) => roadLine(graph, s, bent(s) ? SAMPLES : 1);

// Points as a path, with how far along it each lies (repeated points once).
function sampled(line: Pt[]): PathSample {
	const pts: Pt[] = [];
	const s: number[] = [];
	for (const p of line) {
		const last = pts.at(-1);
		const step = last ? Math.hypot(p.x - last.x, p.y - last.y) : 0;
		if (last && step < 1e-9) continue;
		pts.push({ x: p.x, y: p.y });
		s.push(last ? s.at(-1)! + step : 0);
	}
	return { pts, s, length: s.at(-1) ?? 0 };
}

// How a footpath is drawn round the bends at its ends (roundOf in
// core/footpaths.ts): at each end a bend takes over, how far back along its
// curve its strip stops and the bend's middle line from there to halfway
// round, where the footpath meets the other; null at an end no bend takes.
export type Rounds = (walk: Segment) => [Round | null, Round | null];
export type Round = { cut: number; line: Pt[] };

// A footpath's line as it is drawn: as it shows, but at an end a bend takes
// over (`rounds`), from where its strip stops round the bend to halfway
// round, which stands for its node there. Each point with how far along the
// segment it is (`t`, 0 at the bend's halfway point at its start, 1 at its
// end's), so a footpath is read where its paving lies.
function drawnLine(graph: GraphView, s: Segment, rounds?: Rounds): Sample[] {
	if (!rounds) return shown(graph, s);
	// Read once for each `rounds` (one build's), however many crossings read it.
	const known = drawn.get(rounds) ?? new Map<string, Sample[]>();
	drawn.set(rounds, known);
	let out = known.get(s.id);
	if (!out) known.set(s.id, (out = roundLine(graph, s, rounds)));
	return out;
}
const drawn = new WeakMap<Rounds, Map<string, Sample[]>>();

function roundLine(graph: GraphView, s: Segment, rounds: Rounds): Sample[] {
	const line = shown(graph, s);
	const [r0, r1] = rounds(s);
	const curve = (r0 || r1) && drawnCurve(graph, s);
	if (!curve) return line;
	const t0 = r0 ? tAt(curve, r0.cut) : 0;
	const t1 = r1 ? tAt(curve, curve.length - r1.cut) : 1;
	if (t0 >= t1) return line;
	const at = (t: number) => {
		const p = roadAt(graph, s, t)!.point;
		return { x: p.x, y: p.y, t };
	};
	// A bend's way round, from where the strip stops (at `from`) out to its
	// halfway point (at `to`), each point's t by how far round it lies.
	const round = (r: Round, from: number, to: number) => {
		const run = [0];
		for (let i = 1; i < r.line.length; i++)
			run.push(
				run[i - 1] + Math.hypot(r.line[i].x - r.line[i - 1].x, r.line[i].y - r.line[i - 1].y)
			);
		const total = run.at(-1)! || 1;
		const keep = thinned(r.line);
		return r.line
			.slice(1)
			.flatMap((p, i) =>
				keep.has(i + 1) ? [{ x: p.x, y: p.y, t: from + ((to - from) * run[i + 1]) / total }] : []
			);
	};
	return [
		...(r0 ? round(r0, t0, 0).reverse() : []),
		at(t0),
		...line.filter((p) => p.t > t0 && p.t < t1),
		at(t1),
		...(r1 ? round(r1, t1, 1) : [])
	];
}

// How far off the line a footpath is read along a bend's points may lie
// (m): the rest are read as the straight line between those kept.
const THIN = 0.01;

// The points of a line that keep it within THIN of itself, by index, its
// ends among them (Douglas-Peucker), so a bend turning little is read as the
// few straight pieces it all but is.
function thinned(line: Pt[]) {
	const keep = new Set([0, line.length - 1]);
	const todo: [number, number][] = [[0, line.length - 1]];
	for (let span = todo.pop(); span; span = todo.pop()) {
		const [i, k] = span;
		const [a, b] = [line[i], line[k]];
		const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
		let far = { d: THIN, at: -1 };
		for (let m = i + 1; m < k; m++) {
			const d = Math.abs((line[m].x - a.x) * (b.y - a.y) - (line[m].y - a.y) * (b.x - a.x)) / l;
			if (d > far.d) far = { d, at: m };
		}
		if (far.at < 0) continue;
		keep.add(far.at);
		todo.push([i, far.at], [far.at, k]);
	}
	return keep;
}

// The box round a segment's line as it shows (as it is drawn, given its
// `rounds`), grown by half its width.
export function shownBox(graph: GraphView, s: Segment, rounds?: Rounds): Box {
	return boxAround(drawnLine(graph, s, rounds), getTotalWidth(s.lanes) / 2);
}

// Whether a car road only carries on through a node, and with which two
// segments (carriedOn in place.ts, as PlaceBuilder reads it).
function carriedAt(graph: GraphView) {
	const curves = new Map<string, Curve>();
	const read = (s: Segment) => {
		if (curves.has(s.id)) return true;
		const curve = drawnCurve(graph, s);
		if (curve) curves.set(s.id, curve);
		return !!curve;
	};
	return (nodeId: string) => {
		const node = graph.nodes.get(nodeId);
		if (!node || node.connectedSegments.length !== 2) return null;
		const here = node.connectedSegments.flatMap((id) => graph.segments.get(id) ?? []);
		return here.length === 2 && here.every(read) ? carriedOn(node, here, curves) : null;
	};
}

// The car road a car segment is part of: its segments in order, carried on
// through the nodes it only carries on through (roadThrough in place.ts),
// as drawn (`road`, parted) and as it carries on (`chain`, chainThrough).
function unitOf(graph: GraphView, segment: Segment) {
	const pairAt = carriedAt(graph);
	return { road: roadThrough(segment, pairAt), chain: chainThrough(segment, pairAt).road };
}

// The segments of the car road a car segment is part of as it carries on,
// before any parting (chainThrough): what a crossing of it names it by,
// listed alike whichever of its segments it is asked from.
export const chainOf = (graph: GraphView, segment: Segment) =>
	chainThrough(segment, carriedAt(graph)).road.map((s) => s.id);

// The whole car road a car segment is part of, as its roadways: one for each
// of its carriageways (carriagewaysOf in attach.ts), so a street with a
// walkway down its middle is two, each crossed on its own, the first named
// by the road and each other by the road and its place (`id`, which only
// the drawing reads; a stored control names it by its car lanes instead).
function roadwaysOf(graph: GraphView, segment: Segment, far = true): Roadway[] {
	const { road, chain } = unitOf(graph, segment);
	const meets = (nodeId: string) =>
		(graph.nodes.get(nodeId)?.connectedSegments ?? []).some((id) => {
			const s = graph.segments.get(id);
			return !!s && carries(s.lanes) && !road.includes(s);
		});
	const beyond = far
		? [
				...new Map(
					[road[0].startNodeId, road.at(-1)!.endNodeId]
						.flatMap((id) => graph.nodes.get(id)?.connectedSegments ?? [])
						.flatMap((id) => {
							const s = graph.segments.get(id);
							if (!s || !carries(s.lanes) || road.includes(s)) return [];
							return roadwaysOf(graph, s, false).map((r) => [r.id, r] as const);
						})
				).values()
			]
		: [];
	const lines = road.flatMap((s): RoadLine[] => {
		const ends = segmentEnds(graph, s);
		const curve = drawnCurve(graph, s);
		return ends && curve ? [{ segment: s, ...ends, curve }] : [];
	});
	if (lines.length < road.length) return [];
	// The drawn lines unshifted, curves kept: a segment's handle is read
	// through accessors, which a spread would drop, leaving its chord.
	const drawn = sampled(
		lines.flatMap(({ segment: s, a, b }) =>
			shownLine(
				{ controlX: s.controlX, controlY: s.controlY, offsetStart: 0, offsetEnd: 0 },
				a,
				b,
				bent(s) ? SAMPLES : 1
			)
		)
	);
	return carriagewaysOf(segment.lanes).flatMap((span, k): Roadway[] => {
		const mid = (span.lo + span.hi) / 2;
		const pts: Pt[] = [];
		const along: number[] = [];
		const at: Roadway['at'] = [];
		for (const [i, s] of road.entries())
			for (const p of shown(graph, s)) {
				const q = { x: p.x + p.normal.x * mid, y: p.y + p.normal.y * mid };
				const last = pts.at(-1);
				const step = last ? Math.hypot(q.x - last.x, q.y - last.y) : 0;
				if (last && step < 1e-9) continue;
				pts.push(q);
				along.push(last ? along.at(-1)! + step : 0);
				at.push({ k: i, t: p.t });
			}
		if (pts.length < 2) return [];
		const half = (span.hi - span.lo) / 2;
		return [
			{
				id: k ? `${road[0].id}:${k}` : road[0].id,
				segments: road.map((s) => s.id),
				chain: chain.map((s) => s.id),
				lanes: span.lanes,
				path: { pts, s: along, length: along.at(-1)! },
				drawn,
				half,
				mid,
				lines,
				at,
				ends: [road[0].startNodeId, road.at(-1)!.endNodeId],
				open: [meets(road[0].startNodeId), meets(road.at(-1)!.endNodeId)],
				beyond,
				box: boxAround(pts, half)
			}
		];
	});
}

// Where a point lies on a roadway: how far along it (`s`, project), how far
// right of its middle (`d`, left below 0; past an end, how far from it, on
// the side its middle runs out on), how far from its middle at all (`off`),
// which end it lies past, if any (`end`, read square to its drawn line:
// alongPath), and whether that is a dead end (`past`). Along the road, how
// far across is read as the drawing lays the lanes (acrossRoad in
// road-line.ts), on the curve and its shift rather than on the path's
// chords, so a point on the curb as drawn (a footpath's end snapped there:
// sideOf) lies on it here, whatever the road's curve or shift.
function placeOn(r: Roadway, q: Pt) {
	const { s, d: near } = project(r.path, q);
	const on = alongPath(r.drawn, q);
	const end: 0 | 1 | null = on < 0 ? 0 : on > r.drawn.length ? 1 : null;
	let d: number;
	let off = near;
	const f = frameAt(r.path, s);
	const side = Math.sign((q.x - f.p.x) * f.n.x + (q.y - f.p.y) * f.n.y);
	if (end === null) {
		d = acrossOn(r, s, q) ?? side * near;
		off = Math.abs(d);
	} else d = side * near;
	return { s, d, off, end, past: end !== null && !r.open[end] };
}

// How far right of a roadway's middle a point `s` along it lies, on the
// segment's line under it there; null where that line is straight and
// shifted alike all along, its middle the path's chord itself, which reads
// it exactly.
function acrossOn(r: Roadway, s: number, q: Pt) {
	const i = pieceAt(r.path.s, s);
	const [p0, p1] = [r.at[i - 1], r.at[i]];
	const { segment } = r.lines[p1.k];
	if (segment.controlX === undefined && segment.offsetStart === segment.offsetEnd) return null;
	const span = r.path.s[i] - r.path.s[i - 1];
	const f = span > 1e-9 ? (s - r.path.s[i - 1]) / span : 0;
	// A chord from the last point of one segment runs along the next.
	const t0 = p0.k === p1.k ? p0.t : 0;
	const line = r.lines[p1.k];
	const { across } = acrossRoad(line.segment, line.a, line.b, q, t0 + (p1.t - t0) * f, line.curve);
	return across - r.mid;
}

// How near a roadway's curb a point may lie and still be read as on it, not
// inside, for the rounding of a point put on it (m).
const ON_CURB = 1e-6;

// Whether a point lies inside a roadway: within its width along it, or past
// an end where other car roads meet it, round that end or inside one of
// theirs. A point on the curb is not inside it.
const insideOf = (r: Roadway, q: Pt): boolean => {
	const at = placeOn(r, q);
	if (at.end === null) return at.off < r.half - ON_CURB;
	if (!r.open[at.end]) return false;
	return at.off < r.half || r.beyond.some((b) => placeOn(b, q).end === null && insideOf(b, q));
};

// The point of a roadway `s` along it (read on straight past its ends) and
// `d` right of its middle (frameAt), and the way the roadway runs there (`t`).
export function pointOn(r: Roadway, s: number, d: number) {
	const f = frameAt(r.path, s);
	const past = s - Math.max(0, Math.min(r.path.length, s));
	return { x: f.p.x + f.t.x * past + f.n.x * d, y: f.p.y + f.t.y * past + f.n.y * d, t: f.t };
}

// Where a footpath piece inside a roadway ends: a footpath node inside it,
// or a point on its edge (`side`: 1 the right curb, -1 the left, 0 a dead
// end), with how far along the road it is (`s`), the way the
// footpath runs out of the roadway there (`out`) and half its width.
export type Edge = { side: number; p: Pt; s: number; out: Pt; half: number };
export type StretchEnd = { node: string } | Edge;
const nodeOf = (e: StretchEnd) => ('node' in e ? e.node : null);

// A footpath segment's piece inside a roadway, between two ends along it
// (`t0` to `t1` along its shown line), how far along the road it crosses the
// roadway's middle (`mids`, with how far past its end, if it is).
export interface Stretch {
	segment: string;
	from: StretchEnd;
	to: StretchEnd;
	t0: number;
	t1: number;
	mids: { s: number; past: number }[];
}

type Sample = { x: number; y: number; t: number };
const lerp = (a: Sample, b: Sample, f: number) => ({
	x: a.x + (b.x - a.x) * f,
	y: a.y + (b.y - a.y) * f,
	t: a.t + (b.t - a.t) * f
});
// Where between a and b a test first gives another answer than at a.
function change(a: Sample, b: Sample, test: (q: Pt) => boolean) {
	const at = test(a);
	let [lo, hi] = [0, 1];
	for (let i = 0; i < 40; i++) {
		const m = (lo + hi) / 2;
		if (test(lerp(a, b, m)) === at) lo = m;
		else hi = m;
	}
	return { lo, hi, p: lerp(a, b, (lo + hi) / 2) };
}

// Where the line from a to b crosses a roadway's middle, if it does.
function onMiddle(r: Roadway, a: Sample, b: Sample) {
	const [dx, dy] = [b.x - a.x, b.y - a.y];
	const m = r.path.pts;
	for (let k = 1; k < m.length; k++) {
		const [p, q] = [m[k - 1], m[k]];
		const [ex, ey] = [q.x - p.x, q.y - p.y];
		const den = dx * ey - dy * ex;
		if (Math.abs(den) < 1e-12) continue;
		const u = ((p.x - a.x) * ey - (p.y - a.y) * ex) / den;
		const v = ((p.x - a.x) * dy - (p.y - a.y) * dx) / den;
		if (u >= 0 && u <= 1 && v >= 0 && v <= 1) return lerp(a, b, u);
	}
	return null;
}

// A footpath segment's pieces inside a roadway, in order along it, read
// along its line as drawn (drawnLine, round the bends `rounds` gives).
function stretchesOf(graph: GraphView, r: Roadway, walk: Segment, rounds?: Rounds): Stretch[] {
	if (walk.startNodeId === walk.endNodeId || apart(shownBox(graph, walk, rounds), r.box)) return [];
	const line = drawnLine(graph, walk, rounds);
	if (line.length < 2) return [];
	const half = getTotalWidth(walk.lanes) / 2;
	// The line read every STEP at the most.
	const pts: Sample[] = [line[0]];
	for (let k = 1; k < line.length; k++) {
		const n = Math.max(
			1,
			Math.ceil(Math.hypot(line[k].x - line[k - 1].x, line[k].y - line[k - 1].y) / STEP)
		);
		for (let i = 1; i <= n; i++) pts.push(lerp(line[k - 1], line[k], i / n));
	}
	const inside = pts.map((p) => insideOf(r, p));
	// Where the line crosses the roadway's edge between pts[k] and pts[k+1].
	const edge = (k: number): Edge & { t: number } => {
		const [a, b] = [pts[k], pts[k + 1]];
		const { lo, hi, p } = change(a, b, (q) => insideOf(r, q));
		const outside = placeOn(r, lerp(a, b, inside[k] ? hi : lo));
		const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
		const way = inside[k] ? 1 : -1;
		return {
			side: outside.past ? 0 : Math.sign(outside.d),
			p: { x: p.x, y: p.y },
			s: placeOn(r, p).s,
			out: { x: (way * (b.x - a.x)) / l, y: (way * (b.y - a.y)) / l },
			half,
			t: p.t
		};
	};
	const out: Stretch[] = [];
	let open: { end: StretchEnd; t: number; k: number } | null = inside[0]
		? { end: { node: walk.startNodeId }, t: 0, k: 0 }
		: null;
	const close = (end: StretchEnd, t: number, k: number) => {
		if (!open) return;
		const mids: Stretch['mids'] = [];
		// A node of its ends lying on the middle is where it crosses, which
		// way soever the pieces either side read it.
		for (const [e, q] of [
			[open.end, pts[open.k]],
			[end, pts[k]]
		] as const) {
			const at = placeOn(r, q);
			if ('node' in e && Math.abs(at.d) < AT_MIDDLE)
				mids.push({ s: at.s, past: at.end === null ? 0 : at.off });
		}
		for (let i = open.k; i < k; i++) {
			const [a, b] = [pts[i], pts[i + 1]];
			const right = (q: Pt) => placeOn(r, q).d > 0;
			if (right(a) === right(b)) continue;
			const c = onMiddle(r, a, b) ?? change(a, b, right).p;
			const at = placeOn(r, c);
			mids.push({ s: at.s, past: at.end === null ? 0 : at.off });
		}
		out.push({ segment: walk.id, from: open.end, to: end, t0: open.t, t1: t, mids });
		open = null;
	};
	for (let k = 0; k + 1 < pts.length; k++) {
		if (inside[k] === inside[k + 1]) continue;
		const e = edge(k);
		if (open) close(e, e.t, k + 1);
		else open = { end: e, t: e.t, k };
	}
	if (open) close({ node: walk.endNodeId }, 1, pts.length - 1);
	return out;
}

// A way across a roadway, from a point on its left curb to one on its right,
// read by its two ends alone: its band (bandOf).
export interface Run {
	ends: [Edge, Edge];
}

// The footpath pieces inside one roadway joined at nodes inside it, as a
// crossing: the segments of the pieces some way across passes (sorted; the
// least holds it), those pieces, and the runs across (every left curb point
// joined to every right one).
export interface RoadCrossing {
	road: Roadway;
	segments: string[];
	stretches: Stretch[];
	runs: Run[];
}

// The edges of a graph (each a pair of its vertices) that lie on some way
// between `from` and `to` passing no vertex twice: those in one block with
// an edge joining the two (a block, or biconnected component, holds the
// edges any two of which lie on one cycle). Read the same whatever order the
// edges come in.
function onWays<E>(edges: [string, string, E][], from: string, to: string) {
	const all: [string, string, E | null][] = [...edges, [from, to, null]];
	const adj = new Map<string, number[]>();
	for (const [k, [a, b]] of all.entries())
		for (const v of a === b ? [a] : [a, b]) adj.set(v, [...(adj.get(v) ?? []), k]);
	const disc = new Map<string, number>();
	const low = new Map<string, number>();
	const stack: number[] = [];
	const out: E[] = [];
	let time = 0;
	const visit = (v: string, via: number) => {
		disc.set(v, time);
		low.set(v, time++);
		for (const k of adj.get(v) ?? []) {
			if (k === via) continue;
			const w = all[k][0] === v ? all[k][1] : all[k][0];
			if (!disc.has(w)) {
				stack.push(k);
				visit(w, k);
				low.set(v, Math.min(low.get(v)!, low.get(w)!));
				if (low.get(w)! >= disc.get(v)!) {
					const block: number[] = [];
					for (let e = stack.pop(); e !== undefined; e = stack.pop()) {
						block.push(e);
						if (e === k) break;
					}
					if (block.some((e) => all[e][2] === null))
						for (const e of block) if (all[e][2] !== null) out.push(all[e][2] as E);
				}
			} else if (disc.get(w)! < disc.get(v)!) {
				stack.push(k);
				low.set(v, Math.min(low.get(v)!, disc.get(w)!));
			}
		}
	};
	visit(from, -1);
	return out;
}

// The crossings of a roadway that the footpath pieces joined to a footpath
// segment inside it make, read from that segment, and every node of the
// segments read.
function crossingsOf(graph: GraphView, r: Roadway, walk: Segment, rounds?: Rounds) {
	const seen = new Set<string>();
	const found: Stretch[] = [];
	const read = new Set<string>();
	const queue = [walk];
	for (let s = queue.pop(); s; s = queue.pop()) {
		if (seen.has(s.id)) continue;
		seen.add(s.id);
		read.add(s.startNodeId);
		read.add(s.endNodeId);
		for (const st of stretchesOf(graph, r, s, rounds)) {
			found.push(st);
			for (const n of [nodeOf(st.from), nodeOf(st.to)])
				for (const id of (n && graph.nodes.get(n)?.connectedSegments) || []) {
					const next = graph.segments.get(id);
					if (next && !carries(next.lanes) && !seen.has(id)) queue.push(next);
				}
		}
	}
	// The pieces on some way from the left curb to the right one passing no
	// node twice: each curb point a vertex of its own, joined to one side
	// (L) or the other (R).
	const vertex = (st: Stretch, e: StretchEnd, k: string) =>
		'node' in e ? `n:${e.node}` : `e:${st.segment}:${st.t0}:${k}`;
	const edges: [string, string, Stretch][] = found.map((st) => [
		vertex(st, st.from, 'from'),
		vertex(st, st.to, 'to'),
		st
	]);
	const curbs: [string, string, Stretch][] = found.flatMap((st) =>
		(
			[
				[st.from, 'from'],
				[st.to, 'to']
			] as const
		).flatMap(([e, k]): [string, string, Stretch][] =>
			'node' in e || e.side === 0 ? [] : [[e.side < 0 ? 'L' : 'R', vertex(st, e, k), st]]
		)
	);
	const ways = new Set(onWays([...edges, ...curbs], 'L', 'R'));
	const pieces = found
		.filter((st) => ways.has(st))
		.sort((a, b) => (a.segment === b.segment ? a.t0 - b.t0 : a.segment < b.segment ? -1 : 1));
	// The pieces joined at footpath nodes inside the roadway, one crossing
	// each: a footpath that leaves the roadway and comes back into it crosses
	// it again, apart.
	const group = new Map<string, string>();
	const root = (v: string) => {
		let top = v;
		while (group.has(top)) top = group.get(top)!;
		for (let at = v; at !== top; ) {
			const up = group.get(at)!;
			group.set(at, top);
			at = up;
		}
		return top;
	};
	for (const [a, b] of edges) {
		const [p, q] = [root(a), root(b)];
		if (p !== q) group.set(p, q);
	}
	const groups = new Map<string, Stretch[]>();
	for (const st of pieces) {
		const k = root(vertex(st, st.from, 'from'));
		const here = groups.get(k);
		if (here) here.push(st);
		else groups.set(k, [st]);
	}
	return {
		read: [...read].sort(),
		crossings: [...groups.values()].flatMap((stretches) => {
			const c = crossingAlong(r, stretches);
			return c ? [c] : [];
		})
	};
}

// The crossing some footpath pieces inside a roadway joined at nodes inside
// it make, if they make one: every left curb point joined to every right one.
function crossingAlong(r: Roadway, stretches: Stretch[]): RoadCrossing | null {
	const points = (side: number) =>
		stretches.flatMap((st) =>
			[st.from, st.to].flatMap((e) => (!('node' in e) && e.side === side ? [e] : []))
		);
	const lefts = points(-1);
	const runs: Run[] = lefts.flatMap((a) => points(1).map((b): Run => ({ ends: [a, b] })));
	if (!runs.length) return null;
	// Where the ways across cross the road's middle (read on past its ends):
	// on the road itself, it is this road's crossing; further past an end
	// than the road is wide, another road's meeting it there; at an end or
	// round it, in the junction of the roads meeting there, it is the
	// crossing of the one of them it crosses most squarely (heldAt).
	const mids = stretches.flatMap((st) => st.mids);
	const end = (m: (typeof mids)[number]) =>
		m.s <= AT_MIDDLE ? 0 : m.s >= r.path.length - AT_MIDDLE ? 1 : null;
	const own =
		mids.some((m) => m.past === 0 && (end(m) === null || !r.open[end(m)!])) ||
		mids.some((m) => {
			const e = end(m);
			return e !== null && m.past < r.half && r.open[e] && heldAt(r, e, runs);
		});
	if (!own) return null;
	const segments = [...new Set(stretches.map((st) => st.segment))].sort();
	return { road: r, segments, stretches, runs };
}

// Whether a crossing whose runs cross a roadway's middle at one of its ends
// where other car roads meet (`end`) is its: of the roads meeting there, the
// one the runs cross most squarely, the way each leaves the node, and of two
// as square, the one leaving it at the least angle (so ids and order never
// decide it), the angle read in [-π, π): a road leaving due west is at -π
// whichever way it is stored (its heading's -0 or 0 aside).
function heldAt(r: Roadway, end: 0 | 1, runs: Run[]) {
	const node = r.ends[end];
	const leaving = (x: Roadway) =>
		x.ends.flatMap((n, k) => {
			if (n !== node) return [];
			const t = frameAt(x.path, k === 0 ? 0 : x.path.length).t;
			return [k === 0 ? t : { x: -t.x, y: -t.y }];
		});
	const way = runs.reduce(
		(w, run) => {
			const [a, b] = run.ends.map((e) => e.p);
			return { x: w.x + b.x - a.x, y: w.y + b.y - a.y };
		},
		{ x: 0, y: 0 }
	);
	const l = Math.hypot(way.x, way.y) || 1;
	const angle = (t: Pt) => {
		const a = Math.atan2(t.y, t.x);
		return a >= Math.PI - 1e-12 ? -Math.PI : a;
	};
	const score = (t: Pt) => [Math.abs(way.x * t.y - way.y * t.x) / l, -angle(t)];
	const mine = leaving(r).map(score);
	const theirs = r.beyond.flatMap(leaving).map(score);
	const better = (p: number[], q: number[]) =>
		p[0] > q[0] + 1e-9 || (Math.abs(p[0] - q[0]) <= 1e-9 && p[1] > q[1] + 1e-12);
	return mine.some((m) => theirs.every((t) => !better(t, m)));
}

// The car roads some car segments are part of whose roadways come near a
// footpath segment as it shows, each once, by id.
function roadwaysNear(graph: GraphView, walk: Segment, cars: Iterable<Segment>, rounds?: Rounds) {
	const box = shownBox(graph, walk, rounds);
	const out = new Map<string, Roadway>();
	const done = new Set<string>();
	for (const car of cars) {
		if (done.has(car.id) || !carries(car.lanes) || apart(shownBox(graph, car), box)) continue;
		for (const r of roadwaysOf(graph, car)) {
			for (const id of r.segments) done.add(id);
			if (!apart(r.box, box)) out.set(r.id, r);
		}
	}
	return [...out.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

// The crossings a footpath segment holds: those over the roads of some car
// segments whose footpath pieces it is the least of, each footpath read as
// drawn round its bends (`rounds`). Every footpath node read is noted in
// `seen`.
export function crossingsHeldBy(
	graph: GraphView,
	walk: Segment,
	cars: Iterable<Segment>,
	seen: Set<string>,
	rounds?: Rounds
) {
	const out: RoadCrossing[] = [];
	for (const r of roadwaysNear(graph, walk, cars, rounds)) {
		const { read, crossings } = crossingsOf(graph, r, walk, rounds);
		for (const n of read) seen.add(n);
		for (const c of crossings) if (c.segments[0] === walk.id) out.push(c);
	}
	return out;
}

// The least slant to its curb a footpath is read as meeting it at (the sine
// of the angle), and how far past the curb its band reaches (m), for the
// road's ground to cut it there.
const MIN_SLANT = 0.05;
const PAST_EDGE = 0.5;

// A run's band: the footpath's own width carried straight across, from
// where each of its edges meets the curb it enters by to where that edge
// meets the curb it leaves by, bent only as the road bends between them, so
// it keeps within the roadway however the road runs, and the footpath
// outside meets it edge to edge however slant it comes. Each corner reaches a
// little on along the footpath past the curb (PAST_EDGE), for the road's
// ground to cut it there. A footpath's edge is looked for where it meets the
// curb so slant to it, no further than 1 / MIN_SLANT half its width from
// where its middle does.
export function bandOf(r: Roadway, run: Run): Pt[] {
	const [a, b] = run.ends;
	// Each end, the way the run goes there (into the roadway, then out of
	// it), and where each edge of the footpath meets the curb.
	const ways = [
		{ e: a, dir: { x: -a.out.x, y: -a.out.y }, back: -1 },
		{ e: b, dir: b.out, back: 1 }
	].map(({ e, dir, back }) => {
		const n = { x: -dir.y, y: dir.x };
		const t = pointOn(r, e.s, 0).t;
		const slant = Math.max(MIN_SLANT, Math.abs(dir.x * t.y - dir.y * t.x));
		const reach = (e.half / slant) * 1.05 + 0.05;
		const edge = (k: number) => {
			const on = (d: number) => ({
				x: e.p.x + n.x * e.half * k + dir.x * d * back,
				y: e.p.y + n.y * e.half * k + dir.y * d * back,
				t: d
			});
			// Along the edge, from inside the roadway to out past the curb.
			const [inner, outer] = [on(-reach), on(reach)];
			const hit =
				insideOf(r, inner) !== insideOf(r, outer)
					? change(inner, outer, (q) => insideOf(r, q)).p
					: on(0);
			return {
				hit: { x: hit.x, y: hit.y },
				past: {
					x: hit.x + dir.x * PAST_EDGE * back,
					y: hit.y + dir.y * PAST_EDGE * back
				}
			};
		};
		return { edges: [edge(1), edge(-1)], place: placeOn(r, e.p) };
	});
	// How far the road between the two ends strays from the straight line
	// between them, part way along.
	const [w0, w1] = ways;
	const along = (u: number) =>
		pointOn(
			r,
			w0.place.s + (w1.place.s - w0.place.s) * u,
			w0.place.d + (w1.place.d - w0.place.d) * u
		);
	const [pa, pb] = [along(0), along(1)];
	const stray = (u: number) => {
		const on = along(u);
		return { x: on.x - (pa.x + (pb.x - pa.x) * u), y: on.y - (pa.y + (pb.y - pa.y) * u) };
	};
	const steps = Math.max(1, Math.ceil(Math.abs(w1.place.s - w0.place.s)));
	const side = (k: 0 | 1) => {
		const [p, q] = [w0.edges[k].hit, w1.edges[k].hit];
		return [
			w0.edges[k].past,
			...Array.from({ length: steps + 1 }, (_, i) => {
				const u = i / steps;
				const off = stray(u);
				return { x: p.x + (q.x - p.x) * u + off.x, y: p.y + (q.y - p.y) * u + off.y };
			}),
			w1.edges[k].past
		];
	};
	return [...side(0), ...side(1).reverse()];
}

// The car segments whose ground a crossing of a roadway is drawn on: the
// road's own and those of the roads meeting it at its ends, whose junction it
// may reach over.
export function groundOf(graph: GraphView, r: Pick<Roadway, 'segments' | 'ends'>) {
	const out = new Set(r.segments);
	for (const node of r.ends)
		for (const id of graph.nodes.get(node)?.connectedSegments ?? []) {
			const s = graph.segments.get(id);
			if (s && carries(s.lanes)) out.add(id);
		}
	return out;
}
