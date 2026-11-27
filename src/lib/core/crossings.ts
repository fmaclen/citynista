import type { Graph, GraphView } from './graph.svelte';
import type { Segment } from './segment.svelte';
import type { JunctionCrossing, Lane } from './types';
import { getQuadraticBezierPoint, getQuadraticBezierTangent } from '../geometry/bezier';
import {
	closestOnRoad,
	distanceToChord,
	drawnCurve,
	type LineFrom,
	lineFrom,
	nodePoint,
	type Pt,
	roadAt,
	shiftAtCut,
	shownLine
} from './road-line';
import { getTotalWidth } from './lane-template';
import { carries } from './lane-types';
import { segmentEnds } from './attach';
import { mapJunction } from './junction-data';
import { controlPointOf } from './segment-curve';
import { carryControls, copyControl, sameIds } from './crossing-controls';
import { area, offsetLine, type Paths, subtract, union } from '../road-model/clip';

const SAMPLES = 50;
// Crossings of two roads of one network this close to an existing endpoint
// are already junctions.
export const ENDPOINT_EXCLUSION = 6;
// A line this near another's touches it: an end resting on it, or a line
// coming up to it and going back, crosses nothing.
export const TOUCH = 0.01;
// How many cuts one edit may make for each segment of the graph, at the most:
// a guard against a cut that never settles, never a limit any real edit meets.
const SPLITS_PER_SEGMENT = 8;

export interface Crossing {
	segmentA: Segment;
	segmentB: Segment;
	tA: number;
	tB: number;
	// Where the roads cross, as they show.
	x: number;
	y: number;
}

// Make the changed roads meet the others where they show, so overlaps render
// (and behave) as real intersections. Roads meet only roads of their own
// network (core/networks.ts): car roads car roads, footpaths footpaths. A
// changed road that passes over a node of its network (the node shows within
// the road's half width) is split there and joined to it, a footpath built,
// or a piece of one, lying within the footpaths already there as they show
// taken out (dropRetrace). Then changed roads that cross another of their
// network mid-span are both split at a new shared node, placed where the two
// segments' lines meet so both roads stay exactly where they were, wherever
// along either line they fall: only a line coming within TOUCH of the other
// and going back the side it came from, or resting on it to its end, touches
// rather than crosses (`passes`), and crossings of two roads near a node they
// already share (`nearSharedNode`) meet there already. A footpath across a
// car road changes nothing: its crossing is paint (core/runs.ts). Only the
// changed roads (and the pieces they split into) are looked at, so an edit
// never rewires roads elsewhere. Building calls this (drawing, pasting);
// moving never does. Returns whether the graph changed.
export function resolveCrossings(graph: Graph, changed: Iterable<string>) {
	const scope = new Set(changed);
	const scoped = () => [...scope].flatMap((id) => graph.segments.get(id) ?? []);
	const split = (segment: Segment, t: number, nodeId: string, off?: Pt) => {
		const halves = splitSegment(graph, segment, t, nodeId, off);
		if (!halves || !scope.delete(segment.id)) return;
		for (const half of [halves.left, halves.right])
			if (!dropRetrace(graph, half)) scope.add(half.id);
	};
	let changedGraph = false;
	for (const segment of scoped())
		if (dropRetrace(graph, segment)) {
			scope.delete(segment.id);
			changedGraph = true;
		}

	const most = SPLITS_PER_SEGMENT * (graph.segments.size + 1);
	for (let i = 0; i < most; i++) {
		const pass = nodePasses(graph, scoped()).next().value;
		if (pass) {
			split(pass.segment, pass.t, pass.nodeId, pass.off);
			changedGraph = true;
			continue;
		}

		const crossing = findCrossingsBetweenSegments(
			graph,
			scoped(),
			graph,
			graph.segments.values()
		)[0];
		if (!crossing) break;
		const { segmentA: a, segmentB: b } = crossing;
		const { tA, tB, at } = nodeFor(graph, crossing);
		const node = graph.createNode(at.x, at.y);
		split(a, tA, node.id);
		split(b, tB, node.id);
		changedGraph = true;
	}

	return changedGraph;
}

// A footpath is never laid over footpaths already there: a footpath just
// built, or a piece of one a cut leaves, whose strip as it shows (its width
// either side of its shown line, square at its ends) lies within the strips
// of the other footpaths as they show is taken out, with each of its nodes
// left holding no road, and the way runs on along those (a short path
// pasted along a longer one, or one drawn or pasted over itself). One that
// leaves their ground anywhere (a curve bowing away from a straight path, a
// strip wider than the one it lies along, one shifted off it) is a way of
// its own and stays. A car road may lie over another. Whether it was taken
// out.
function dropRetrace(graph: Graph, piece: Segment) {
	if (carries(piece.lanes)) return false;
	const own = stripOf(graph, piece);
	if (!own) return false;
	const under: Paths = [];
	for (const other of graph.segments.values()) {
		if (other.id === piece.id || carries(other.lanes)) continue;
		const rough = roughBox(graph, other);
		if (!rough || !overlaps(rough, own.box)) continue;
		const strip = stripOf(graph, other);
		if (strip && overlaps(strip.box, own.box)) under.push(...strip.ground);
	}
	if (!under.length) return false;
	const left = subtract(own.ground, union(under)).reduce((sum, p) => sum + Math.abs(area(p)), 0);
	if (left > COVERED * own.length) return false;
	graph.deleteSegment(piece.id);
	for (const id of [piece.startNodeId, piece.endNodeId])
		if (graph.nodes.get(id)?.connectedSegments.length === 0) graph.deleteNode(id);
	return true;
}

// How much of a footpath's strip may lie off the strips under it, per metre
// of its length, for it to lie within them (m²/m): what sampling a curve
// leaves between two drawings of it.
const COVERED = 0.02;

// The box a footpath's strip lies within, read off its nodes, its curve's
// handle and its shifts without tracing it: a quadratic keeps within the
// triangle of its ends and handle.
function roughBox(graph: Graph, segment: Segment) {
	const [a, b] = [graph.nodes.get(segment.startNodeId), graph.nodes.get(segment.endNodeId)];
	if (!a || !b) return null;
	const c = controlPointOf(segment);
	const pts: Pt[] = c ? [a, b, c] : [a, b];
	const shift = Math.max(Math.abs(segment.offsetStart), Math.abs(segment.offsetEnd));
	return grown(boxOf(pts), getTotalWidth(segment.lanes) / 2 + shift);
}

// A footpath's strip as it shows: its ground, the box round it and its
// length.
function stripOf(graph: Graph, segment: Segment) {
	const shown = shownOf(graph, segment);
	const line = shown && trace(shown)?.pts;
	if (!line) return null;
	const half = getTotalWidth(segment.lanes) / 2;
	let length = 0;
	for (let i = 1; i < line.length; i++)
		length += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y);
	return { ground: offsetLine(line, half), box: grown(boxOf(line), half), length };
}

// Each of the roads that passes over a node of its network, away from the
// road's own ends: the node shows within the road's half width, or within
// ENDPOINT_EXCLUSION of it where one of the node's roads crosses it that near
// the node (a crossing the second pass leaves out, which meets at the node).
// A node the road only passes close by, its roads clear of it, stays apart.
// With each, how far the node shows from where it lies (`off`), which the
// road's pieces show off it by too (splitSegment).
function* nodePasses(graph: Graph, segments: Segment[]) {
	const candidates = [...graph.nodes.values()];
	for (const segment of segments) {
		const half = getTotalWidth(segment.lanes) / 2;
		const reach = Math.max(half, ENDPOINT_EXCLUSION);
		const line = sampleRoad(graph, segment);
		if (!line) continue;
		const [x0, y0, x1, y1] = boxOf(line);
		const car = carries(segment.lanes);
		for (const node of candidates) {
			if (node.connectedSegments.length === 0) continue;
			if (node.id === segment.startNodeId || node.id === segment.endNodeId) continue;
			const p = nodePoint(graph, node);
			if (p.x < x0 - reach || p.x > x1 + reach) continue;
			if (p.y < y0 - reach || p.y > y1 + reach) continue;
			const near = closestOnRoad(graph, segment, p.x, p.y);
			if (near.distance >= reach || isNearSegmentEndpoint(graph, segment, near)) continue;
			const roads = node.connectedSegments.flatMap((id) => graph.segments.get(id) ?? []);
			if (roads.some((other) => carries(other.lanes) !== car)) continue;
			const crossedNear = (other: Segment) => {
				const o = sampleRoad(graph, other);
				return !!o?.some(
					(q, j) =>
						j > 0 &&
						line.some((r, i) => {
							const hit = i > 0 && intersectLineSegments(line[i - 1], r, o[j - 1], q);
							return !!hit && Math.hypot(hit.x - p.x, hit.y - p.y) < ENDPOINT_EXCLUSION;
						})
				);
			};
			if (near.distance < half || roads.some(crossedNear)) {
				const off = { x: p.x - node.x, y: p.y - node.y };
				yield { segment, t: near.t, nodeId: node.id, off };
			}
		}
	}
}

// The segment's line (a quadratic between its ends as drawn) at t, and its
// derivative there.
function drawnAt(graph: Graph, segment: Segment, t: number) {
	const { a, b } = segmentEnds(graph, segment)!;
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
	const other = drawnAt(graph, c.segmentB, tB).p;
	const close = Math.hypot(meet.x - other.x, meet.y - other.y) < 0.01;
	if (inside(tA) && inside(tB) && close) return { tA, tB, at: meet };
	return { tA: c.tA, tB: c.tB, at: drawnAt(graph, c.segmentA, c.tA).p };
}

// The segments and nodes drawn near a box (Networks.near, through the
// build's grids).
export type Nearby = (box: { x0: number; y0: number; x1: number; y1: number }) => {
	segments: Iterable<string>;
	nodes: Iterable<string>;
};

// A road as the crossing tests read it: its nodes, its lanes and what its
// line as shown is made of (core/road-line.ts: its ends as drawn, attached
// at an edge or not, its curve's handle and its shifts).
export interface ShownRoad {
	id: string;
	startNodeId: string;
	endNodeId: string;
	lanes: readonly Lane[];
	line: LineFrom;
}

// Roads as some drawing shows them (Networks.shown): each by id, and the
// roads at each node.
export interface Lines {
	road(id: string): ShownRoad | undefined;
	at(nodeId: string): readonly string[];
}

// The same, with the roads drawn near a box.
export interface ShownRoads extends Lines {
	near(box: { x0: number; y0: number; x1: number; y1: number }): Iterable<string>;
}

// A segment as the crossing tests read it, on the line some drawing shows
// it on.
export const shownRoad = (s: Segment, line: LineFrom): ShownRoad => ({
	id: s.id,
	startNodeId: s.startNodeId,
	endNodeId: s.endNodeId,
	lanes: s.lanes,
	line
});

// A segment of a graph as it shows there.
function shownOf(graph: GraphView, segment: Segment): ShownRoad | null {
	const line = lineFrom(graph, segment);
	return line && shownRoad(segment, line);
}

// The roads of a graph as it shows them.
export const linesOf = (graph: GraphView): ShownRoads => ({
	road: (id) => {
		const s = graph.segments.get(id);
		return (s && shownOf(graph, s)) ?? undefined;
	},
	at: (id) => graph.nodes.get(id)?.connectedSegments ?? [],
	near: () => graph.segments.keys()
});

// A road's shown line sampled (`pts`: one chord where it is straight), with
// the box round it; `fine` samples a straight road as a curve's, for the
// walk from a shared node (nearSharedNode).
interface Traced {
	road: ShownRoad;
	pts: PolylinePoint[];
	car: boolean;
	box: Box;
	fine: () => PolylinePoint[];
}

function trace(road: ShownRoad): Traced | null {
	const { line } = road;
	const curved = line.controlX !== undefined && line.controlY !== undefined;
	const pts = shownLine(line, line.a, line.b, curved ? SAMPLES : 1);
	if (pts.length < 2) return null;
	let fine: PolylinePoint[] | null = curved ? pts : null;
	return {
		road,
		pts,
		car: carries(road.lanes),
		box: boxOf(pts),
		fine: () => (fine ??= shownLine(line, line.a, line.b, SAMPLES))
	};
}

// A segment of a graph's shown line, sampled.
function sampleRoad(graph: GraphView, segment: Segment) {
	const shown = shownOf(graph, segment);
	return (shown && trace(shown)?.pts) ?? null;
}

// The crossing tests over some roads, each road traced once.
function tester(roads: Lines) {
	const traced = new Map<string, Traced | null>();
	const of = (id: string) => {
		let t = traced.get(id);
		if (t === undefined) {
			const road = roads.road(id);
			t = road ? trace(road) : null;
			traced.set(id, t);
		}
		return t;
	};
	// Each road of `line`'s kind at a node, but `line`, sampled from the node
	// out.
	const leavingNode = (nodeId: string, line: Traced) =>
		roads.at(nodeId).flatMap((id) => {
			const o = id === line.road.id ? null : of(id);
			if (!o || o.car !== line.car) return [];
			const starts = o.road.startNodeId === nodeId;
			if (starts === (o.road.endNodeId === nodeId)) return [];
			return [{ id, from: starts ? o.pts : [...o.pts].reverse() }];
		});
	// The roads `line` passes through at a node of its kind, not one of its
	// own: those whose ends there rest on it, where they leave it to both
	// sides. Each only touches the line, yet the way they make crosses it.
	// Where one of the line's own ends shows at that node too, the line goes
	// on through its own node there along each other road of that node whose
	// end shows at that spot (one its shift shows away from it leaves from
	// somewhere else, and the line only ends there), and two ways through one
	// spot cross where one way's roads leave strictly to both sides of the
	// other's: one between its two roads, the other outside them (sideOfWay).
	// A road leaving along one of the other way's lies on it and touches it,
	// on neither side, so a road cut where another's cut shows still crosses
	// it, and one ended there, or two elbows sharing an arm, only touch.
	const through = new Map<string, string[]>();
	const throughAt = (line: Traced, nodeId: string) => {
		const key = `${line.road.id}|${nodeId}`;
		let found = through.get(key);
		if (found) return found;
		found = [];
		through.set(key, found);
		if (nodeId === line.road.startNodeId || nodeId === line.road.endNodeId) return found;
		const others = leavingNode(nodeId, line);
		const [first, last] = [line.pts[0], line.pts.at(-1)!];
		const near = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y) < TOUCH;
		const onEnd = others.filter(({ from }) => near(from[0], first) || near(from[0], last));
		if (onEnd.length) {
			const own = near(onEnd[0].from[0], first) ? line.road.startNodeId : line.road.endNodeId;
			const out = own === line.road.startNodeId ? line.pts : [...line.pts].reverse();
			const crossing = new Set<string>();
			for (const way of leavingNode(own, line)) {
				if (!near(way.from[0], out[0])) continue;
				const sides = new Set(onEnd.map((o) => sideOfWay(out, way.from, o.from)));
				if (sides.has(1) && sides.has(-1)) for (const o of onEnd) crossing.add(o.id);
			}
			found.push(...crossing);
			return found;
		}
		const resting: string[] = [];
		const sides = new Set<number>();
		for (const { id, from } of others) {
			const end = from[0];
			if (distanceTo(end, line.pts) >= TOUCH) continue;
			resting.push(id);
			const side = leaving(from, 0, end, 1, line.pts);
			if (side) sides.add(side);
		}
		if (sides.size === 2) found.push(...resting);
		return found;
	};
	// Where two roads' lines cross: each point they pass through each other
	// at away from a node they share, and each node where one ends that the
	// other runs through, the roads there leaving it to both sides
	// (throughAt), either way round.
	const where = (a: Traced, b: Traced): Pt[] => {
		if (a.car !== b.car) return [];
		if (!overlaps(grown(a.box, TOUCH), b.box)) return [];
		const found: Pt[] = lineCrossings(a, b, true).map(({ x, y }) => ({ x, y }));
		const own = (t: Traced) => [t.road.startNodeId, t.road.endNodeId];
		const endAt = (t: Traced, n: string) => (t.road.startNodeId === n ? t.pts[0] : t.pts.at(-1)!);
		for (const n of own(b)) if (throughAt(a, n).includes(b.road.id)) found.push(endAt(b, n));
		for (const n of own(a)) if (throughAt(b, n).includes(a.road.id)) found.push(endAt(a, n));
		return found;
	};
	const crosses = (a: Traced, b: Traced) => where(a, b).length > 0;
	return { of, where, crosses };
}

const pairKey = (a: string, b: string) => [a, b].sort().join('|');

// Each pair of roads of one kind whose lines cross (as `roads` shows them)
// where one of `moved` lies, as its two ids in order: what a move may not lay
// across. Every road whose shown line a move changed, whatever changed it
// (its nodes, its handle, its shift, or the roads beside an end attached at
// an edge), is read against the roads drawn near its line as shown, both
// ways round. An end resting on the other's line touches rather than
// crosses, and a line touching another without passing to its far side
// crosses nothing (lineCrossings); a line through a node whose roads go on
// to both sides of it crosses them. A road's body over another's end is no
// crossing, its line has to cross. Only the roads `roads.near` finds round
// them are read, so the cost is that of what lies near them.
export function crossingPairs(roads: ShownRoads, moved: Iterable<string>) {
	const { of, crosses } = tester(roads);
	const pairs = new Set<string>();
	for (const id of new Set(moved)) {
		const s = of(id);
		if (!s) continue;
		const box = grown(s.box, ENDPOINT_EXCLUSION);
		for (const other of roads.near({ x0: box[0], y0: box[1], x1: box[2], y1: box[3] })) {
			if (other === id || pairs.has(pairKey(id, other))) continue;
			const o = of(other);
			if (o && crosses(s, o)) pairs.add(pairKey(id, other));
		}
	}
	return pairs;
}

// Where two roads' lines cross as `roads` shows them, by the same rules:
// each place, none where either is not shown.
function crossingsOf(roads: Lines, a: string, b: string) {
	const { of, where } = tester(roads);
	const [p, q] = [of(a), of(b)];
	return p && q ? where(p, q) : [];
}

// Whether roads `p` and `q`, as `now` shows them, cross only where roads `a`
// and `b` crossed as `then` shows them: the same two roads, or the roads they
// were cut from where a piece stands in for one. Each place they cross now
// must lie within SAME_PLACE of a place the two crossed then, so a crossing
// that moved along either road is a new one, whether it slid there or another
// went away, which two states compared cannot tell apart.
export function crossedThere(
	then: Lines,
	now: Lines,
	[p, q]: [string, string],
	[a, b]: [string, string]
) {
	const was = crossingsOf(then, a, b);
	return crossingsOf(now, p, q).every((c) =>
		was.some((w) => Math.hypot(c.x - w.x, c.y - w.y) < SAME_PLACE)
	);
}

// How far two roads' crossing may lie from where they crossed before and
// still be that crossing (m): a piece cut from a curved road is sampled
// apart from the whole (SAMPLES chords each), its line centimetres off the
// whole's at most, which moves the point the lines cross along the other
// road by that over the sine of the angle between them: under half a metre
// wherever they cross at more than a few degrees.
const SAME_PLACE = 0.5;

export function findCrossingsBetweenSegments(
	graphA: Graph,
	segmentsA: Iterable<Segment>,
	graphB: Graph,
	segmentsB: Iterable<Segment>
) {
	const crossings: Crossing[] = [];
	const lines = (graph: Graph, list: Iterable<Segment>) =>
		Array.from(list).flatMap((segment) => {
			const shown = shownOf(graph, segment);
			const traced = shown && trace(shown);
			return traced ? [{ segment, traced }] : [];
		});
	const a = lines(graphA, segmentsA);
	const b = segmentsA === segmentsB ? a : lines(graphB, segmentsB);

	for (const [i, la] of a.entries()) {
		for (const [j, lb] of b.entries()) {
			// Each pair once, and never a segment against itself.
			if (la.segment === lb.segment || (b === a && j <= i)) continue;
			// Roads join only roads of their own kind.
			if (la.traced.car !== lb.traced.car || !overlaps(la.traced.box, lb.traced.box)) continue;
			for (const c of lineCrossings(la.traced, lb.traced, graphA === graphB))
				crossings.push({ segmentA: la.segment, segmentB: lb.segment, ...c });
		}
	}

	return crossings;
}

interface PolylinePoint {
	x: number;
	y: number;
	t: number;
}

type Box = [number, number, number, number];

function boxOf(line: Pt[]): Box {
	const xs = line.map((p) => p.x);
	const ys = line.map((p) => p.y);
	return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const grown = (b: Box, by: number): Box => [b[0] - by, b[1] - by, b[2] + by, b[3] + by];

const overlaps = (p: Box, q: Box) => p[0] <= q[2] && q[0] <= p[2] && p[1] <= q[3] && q[1] <= p[3];

// How far a point lies from a line, and to which side of it (1 to its
// left, -1 to its right, read along the chord nearest the point).
function sideOf(p: Pt, line: Pt[]) {
	let best = { distance: Infinity, side: 0 };
	for (let k = 1; k < line.length; k++) {
		const [a, b] = [line[k - 1], line[k]];
		const distance = distanceToChord(p, a, b);
		if (distance < best.distance)
			best = {
				distance,
				side: Math.sign((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x))
			};
	}
	return best;
}

const distanceTo = (p: Pt, line: Pt[]) => sideOf(p, line).distance;

// The heading a line leaves its first point on: toward its first point
// more than TOUCH from there.
function headingOut(line: Pt[]) {
	const [p] = line;
	const q = line.find((r) => Math.hypot(r.x - p.x, r.y - p.y) > TOUCH) ?? line.at(-1)!;
	return Math.atan2(q.y - p.y, q.x - p.x);
}

// How far heading `b` turns anticlockwise from heading `a`, in [0, 2π).
const turnFrom = (a: number, b: number) =>
	(((b - a) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

// How near two headings out of one spot are read as one (radians).
const ALONG = 1e-6;

// Which side of a way through a spot, out along `out` and back along `back`
// (each line from the spot outward), a road leaving the same spot (`road`)
// lies on: 1 between the two, anticlockwise from `out`, -1 outside them, 0
// on the way. One leaving along either of the way's roads is read where it
// leaves it (leavingAt), and is on the way where it never does or only goes
// on past that road's end.
function sideOfWay(out: Pt[], back: Pt[], road: Pt[]) {
	const [o, b, h] = [headingOut(out), headingOut(back), headingOut(road)];
	const arc = turnFrom(o, b);
	const turn = turnFrom(o, h);
	const near = (a: number) => Math.min(a, 2 * Math.PI - a) < ALONG;
	const leaves = (along: Pt[]) => {
		const left = leavingAt(road, 0, road[0], 1, along);
		const end = along.at(-1)!;
		const past =
			left.at && Math.hypot(left.at.x - end.x, left.at.y - end.y) <= left.distance + 1e-9;
		return past ? 0 : left.side;
	};
	if (near(turn)) return leaves(out);
	if (near(turnFrom(b, h))) return -leaves(back);
	return turn < arc ? 1 : -1;
}

// The side of `other` that `line` leaves to, walked along it from `at` (a
// point on its chord `i`) toward its end (`step` 1) or its start (-1): the
// first point more than TOUCH from `other`, looked at 2 cm on and at
// distances doubling from there, and at each of its own points passed. So
// the side is read just past where they meet, against the piece of `other`
// nearest it there. 0 where it reaches its end first, resting on `other`.
const leaving = (line: Pt[], i: number, at: Pt, step: 1 | -1, other: Pt[]) =>
	leavingAt(line, i, at, step, other).side;

// The same, with the point it is first read at and how far that lies from
// `other` (no point where it never leaves).
function leavingAt(line: Pt[], i: number, at: Pt, step: 1 | -1, other: Pt[]) {
	const pts = step === 1 ? [at, ...line.slice(i + 1)] : [at, ...line.slice(0, i + 1).reverse()];
	let walked = 0;
	let next = 2 * TOUCH;
	for (let k = 1; k < pts.length; k++) {
		const [p, q] = [pts[k - 1], pts[k]];
		const l = Math.hypot(q.x - p.x, q.y - p.y);
		for (; next < walked + l; next *= 2) {
			const f = (next - walked) / l;
			const point = { x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f };
			const there = sideOf(point, other);
			if (there.distance > TOUCH) return { ...there, at: point };
		}
		walked += l;
		const end = sideOf(q, other);
		if (end.distance > TOUCH) return { ...end, at: q };
	}
	return { side: 0, distance: 0, at: null };
}

// Whether `line` passes from one side of `other` to the other where they
// meet at `at` on its chord `i` (from point i to i + 1): walked from there
// both ways until it gets more than TOUCH from `other`, it is on opposite
// sides. An end resting on `other` is judged on the whole stretch that rests
// there, however far a shallow approach puts the meeting from the end:
// walked to that end, it never leaves, and touches. A line that comes up to
// `other` and goes back the side it came from only touches it too.
function passes(line: Pt[], i: number, at: Pt, other: Pt[]) {
	const before = leaving(line, i, at, -1, other);
	const after = leaving(line, i, at, 1, other);
	return before !== 0 && after !== 0 && before !== after;
}

// Where two roads' lines cross: each passes through the other there
// (`passes`), and, of roads of one graph (`shared`), not near a node they
// share (nearSharedNode). Crossings within half a metre of one already found
// are the same.
function lineCrossings(a: Traced, b: Traced, shared: boolean) {
	const found: { tA: number; tB: number; x: number; y: number }[] = [];
	const [pa, pb] = [a.pts, b.pts];
	for (let i = 0; i < pa.length - 1; i++) {
		for (let j = 0; j < pb.length - 1; j++) {
			const hit = intersectLineSegments(pa[i], pa[i + 1], pb[j], pb[j + 1]);
			if (!hit) continue;
			if (found.some((c) => Math.hypot(c.x - hit.x, c.y - hit.y) < 0.5)) continue;
			const tA = pa[i].t + (pa[i + 1].t - pa[i].t) * hit.u;
			const tB = pb[j].t + (pb[j + 1].t - pb[j].t) * hit.v;
			if (!passes(pa, i, hit, pb) || !passes(pb, j, hit, pa)) continue;
			if (shared && nearSharedNode(a, tA, b, tB)) continue;
			found.push({ tA, tB, x: hit.x, y: hit.y });
		}
	}
	return found;
}

// Whether a point is within ENDPOINT_EXCLUSION of where one of the
// segment's ends shows.
function isNearSegmentEndpoint(graph: Graph, segment: Segment, point: { x: number; y: number }) {
	for (const t of [0, 1]) {
		const end = roadAt(graph, segment, t);
		if (end && Math.hypot(end.point.x - point.x, end.point.y - point.y) < ENDPOINT_EXCLUSION)
			return true;
	}
	return false;
}

// Whether a crossing of two roads, at `ta` along one and `tb` along the
// other, lies inside the junction a node they share already makes. From that
// node the roads' bodies lie over each other until they are a whole half
// width each apart, and the node reaches that far along them; two roads
// leaving it side by side (the halves of a split) may run on over each other
// far out. The junction joins the two roads' ends there, wherever their
// shifts put them, so each line is read against the other's with the gap
// between their ends bridged. A crossing that each reaches from the node
// without ever getting that far apart from the other lies within it. Past
// where they get apart they are two roads, and crossing again they meet
// anew.
function nearSharedNode(a: Traced, ta: number, b: Traced, tb: number) {
	const apart = (getTotalWidth(a.road.lanes) + getTotalWidth(b.road.lanes)) / 2;
	const [la, lb] = [a.fine(), b.fine()];
	// Whether `line`, walked from its end at the node (its start, or not) up
	// to `t`, keeps within `apart` of `other`.
	const together = (line: PolylinePoint[], fromStart: boolean, t: number, other: Pt[]) =>
		line
			.filter((p) => (fromStart ? p.t < t : p.t > t))
			.every((p) => other.some((q, k) => k > 0 && distanceToChord(p, other[k - 1], q) < apart));
	// `other`'s line with its end at the node joined to `end`.
	const bridged = (other: Pt[], atStart: boolean, end: Pt) =>
		atStart ? [end, ...other] : [...other, end];
	for (const nodeId of [a.road.startNodeId, a.road.endNodeId]) {
		if (nodeId !== b.road.startNodeId && nodeId !== b.road.endNodeId) continue;
		const [sa, sb] = [a.road.startNodeId === nodeId, b.road.startNodeId === nodeId];
		const [ea, eb] = [sa ? la[0] : la.at(-1)!, sb ? lb[0] : lb.at(-1)!];
		if (together(la, sa, ta, bridged(lb, sb, ea)) && together(lb, sb, tb, bridged(la, sa, eb)))
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
// quadratics whose control points are the lerped legs. The legs run from the
// segment's ends as drawn (an end attached at another road's edge moved
// there, core/attach.ts), so each half, its end there attached as the
// road's was, traces the road where it showed. Cut at a node showing off
// where it lies (its roads shifted: `off`, nodePoint), the halves show off
// it as near that as a shift at the cut puts them, so a road joined to a
// node where it shows bends there as one joined to a node showing where it
// lies does. Returns the two halves: start to the node, and the node to the
// end.
export function splitSegment(
	graph: Graph,
	segment: Segment,
	t: number,
	nodeId: string,
	off: Pt = { x: 0, y: 0 }
) {
	const drawn = segmentEnds(graph, segment);
	if (!drawn) return;
	const { a, b } = drawn;

	const c = controlPointOf(segment);
	const lerp = (p: { x: number; y: number }, q: { x: number; y: number }) => ({
		x: p.x + (q.x - p.x) * t,
		y: p.y + (q.y - p.y) * t
	});
	const leftControl = c && lerp(a, c);
	const rightControl = c && lerp(c, b);

	const startNodeId = segment.startNodeId;
	const endNodeId = segment.endNodeId;
	const leftLanes = segment.cloneLanes();
	const rightLanes = segment.cloneLanes();

	// The way across the road at the cut, read before it goes.
	const across = roadAt(graph, segment, t)?.normal ?? null;
	const slot = graph.slotOf(segment.id);
	graph.deleteSegment(segment.id);

	const left = graph.createSegment(startNodeId, nodeId, leftLanes);
	if (leftControl) {
		left.setControlPoint(leftControl.x, leftControl.y);
	}

	left.offsetStart = segment.offsetStart;
	// Cut at a node holding the other kind of road, the halves meet at a node
	// of their own there (Graph.createSegment).
	const right = graph.createSegment(left.endNodeId, endNodeId, rightLanes);
	right.offsetEnd = segment.offsetEnd;
	if (rightControl) {
		right.setControlPoint(rightControl.x, rightControl.y);
	}
	// Each half listed where the road was, so the roads at its nodes read as
	// they did (an attached road joins the one it did, core/attach.ts).
	graph.putAt(slot, [left.id, right.id]);
	// The crossing controls set on a footpath go with both halves, each
	// dropping on saving those of carriageways it does not cross; those
	// naming a car road cut name both its halves, whichever the crossing now
	// lies on, each carriageway on the lanes it named, which both halves keep
	// (core/crossing-controls.ts).
	if (carries(segment.lanes))
		carryControls(graph, [
			{
				from: segment,
				to: [left, right].map((half) => ({
					id: half.id,
					lanes: half.lanes,
					same: sameIds(segment.lanes, half.lanes)
				}))
			}
		]);
	else {
		left.controls = segment.controls?.map(copyControl);
		right.controls = segment.controls?.map(copyControl);
	}

	// The edits stored at the road's ends move onto the half that ends there
	// now. A crossing stored past the cut lies on the other half: it moves to
	// the node at the cut, measured from there. (The half is measured once
	// its end there is attached as the road's was.)
	const cutNode = graph.nodes.get(left.endNodeId);
	for (const [at, end, half, other] of [
		[startNodeId, 'start', left, right],
		[endNodeId, 'end', right, left]
	] as const) {
		const node = graph.nodes.get(at);
		if (!node?.junction || !cutNode) continue;
		const junction = mapJunction(node.junction, (road, e) =>
			road === segment.id ? { road: half.id, end } : { road, end: e }
		);
		node.junction = junction;
		const reach = drawnCurve(graph, half)?.length ?? 0;
		const past = (c: JunctionCrossing) => c.road === half.id && c.at !== undefined && c.at > reach;
		const crossings = junction?.crossings ?? [];
		if (!crossings.some(past)) continue;
		const kept = crossings.filter((c) => !past(c));
		node.junction = { ...junction, crossings: kept.length ? kept : undefined };
		const moved = crossings
			.filter(past)
			.map((c) => ({ ...c, road: other.id, at: (c.at ?? 0) - reach }));
		cutNode.junction = {
			...cutNode.junction,
			crossings: [...(cutNode.junction?.crossings ?? []), ...moved]
		};
	}
	// The shift where it is cut, read off the halves' curves (their ends
	// attached as the road's were) as the join reads it, so both halves show
	// where the road did and join back into it.
	setCutShift(graph, left, right, across && { off, across });
	return { left, right };
}

// Sets the shift where a road is cut into `left` (ending at the cut) and
// `right` (starting there): shiftAtCut over the halves' curves as drawn;
// at a node showing `off` from where it lies, each half's as much more as
// puts its end that far across the road as it ran there (`across`, its
// normal at the cut), so a road cut where the node shows runs on there as
// one cut where a node shows where it lies.
function setCutShift(
	graph: Graph,
	left: Segment,
	right: Segment,
	at: { off: Pt; across: Pt } | null
) {
	const length = (s: Segment) => drawnCurve(graph, s)?.length ?? 0;
	const cut = shiftAtCut(left.offsetStart, right.offsetEnd, length(left), length(right));
	const more = (s: Segment, t: number) => {
		const n = at && roadAt(graph, s, t)?.normal;
		if (!at || !n) return 0;
		const m = at.across;
		const facing = n.x * m.x + n.y * m.y;
		return Math.abs(facing) > 0.1 ? (at.off.x * m.x + at.off.y * m.y) / facing : 0;
	};
	left.offsetEnd = cut + more(left, 1);
	right.offsetStart = cut + more(right, 0);
}
