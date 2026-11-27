// Roads attached at the edge of another (JunctionData.sides): a ramp, a slip
// lane, one carriageway of a road that splits in two. Such a road still
// meets the others at their shared node, but its end is drawn at the edge
// of the road it joins rather than on that road's line, so its lanes carry
// on beside (or into) the lanes there instead of turning across them.
//
// Where the other road carries on through the node, the attached road sits
// just outside its roadway (a ramp beside a freeway), whatever its lanes: a
// two-way street ended on an avenue's edge joins the carriageway on that
// side both ways and leaves the rest of the avenue, its median too, as it
// was (sideConnections in road-model/connect.ts). Where the other road ends
// there, the attached road takes over that edge of it (one half of a split
// road). Only a car road is ever attached: a footpath (no car lane) saved
// attached at an edge is read as joined at its node (endAt).

import type { GraphView as Graph } from './graph.svelte';
import { carries } from './lane-types';
import { controlPointOf, type Curve, joinCurves, quadratic } from './segment-curve';
import type { Lane, LaneRole } from './types';

interface Pt {
	x: number;
	y: number;
}

export interface SegmentLike {
	id: string;
	startNodeId: string;
	endNodeId: string;
	controlX?: number;
	controlY?: number;
	// Its shift at each end (road-line.ts).
	offsetStart: number;
	offsetEnd: number;
	lanes: readonly Lane[];
}

// A segment's shift at the end that meets `nodeId`.
const shiftAt = (segment: SegmentLike, nodeId: string) =>
	segment.startNodeId === nodeId ? segment.offsetStart : segment.offsetEnd;

// Where a cross-section's lanes of one role lie across it, from its centre:
// from the outer edge of the first to that of the last, or null where it has
// none.
function spanOf(lanes: readonly Lane[], role: LaneRole) {
	const total = lanes.reduce((sum, l) => sum + l.width, 0);
	let x = -total / 2;
	let lo = Infinity;
	let hi = -Infinity;
	for (const lane of lanes) {
		if (lane.role === role) {
			lo = Math.min(lo, x);
			hi = Math.max(hi, x + lane.width);
		}
		x += lane.width;
	}
	return lo > hi ? null : { lo, hi };
}

// Where a cross-section's roadway lies across it, from its centre.
export function roadwayOf(lanes: readonly Lane[]) {
	const total = lanes.reduce((sum, l) => sum + l.width, 0);
	return spanOf(lanes, 'vehicle') ?? { lo: -total / 2, hi: total / 2 };
}

// Where each carriageway of a cross-section lies across it, from its centre,
// left to right, and the ids of its car lanes (`lanes`, which name it, as
// the road model names a lane: modelLane in place.ts): its roadway cut at
// every pedestrian lane inside it (a walkway down the middle of the street). Each piece reaches from that walkway's edge, so a buffer
// between the walkway and the car lanes is part of it, and on its outer side
// from the outer edge of its outermost car lane, the curb. A piece holding no
// car lane (a verge between two walkways) is none.
export function carriagewaysOf(lanes: readonly Lane[]) {
	const out: { lo: number; hi: number; lanes: string[] }[] = [];
	const first = lanes.findIndex((l) => l.role === 'vehicle');
	const last = lanes.findLastIndex((l) => l.role === 'vehicle');
	let x = -lanes.reduce((sum, l) => sum + l.width, 0) / 2;
	// The carriageway being read: where it starts, where its last car lane
	// ends, and its car lanes; and where the last walkway inside the road
	// ended.
	let lo: number | null = null;
	let hi = 0;
	let ids: string[] = [];
	let from: number | null = null;
	lanes.forEach((lane, k) => {
		if (lane.role === 'vehicle') {
			lo ??= from ?? x;
			hi = x + lane.width;
			ids.push(lane.id ?? `l${k}`);
		} else if (lane.role === 'pedestrian' && k > first && k < last) {
			if (lo !== null) out.push({ lo, hi: x, lanes: ids });
			[lo, ids, from] = [null, [], x + lane.width];
		}
		x += lane.width;
	});
	if (lo !== null) out.push({ lo, hi, lanes: ids });
	return out;
}

// The unit direction a segment's drawn line leaves `nodeId` in (from `at`, if
// given, rather than the node). Null only where there is no direction at
// all (the node within a nanometre of its control point or far node). Not
// the shared `outOf` in segment-curve.ts, which gives up within 0.1 mm: here
// a null drops an attached road's shift to zero (attachShift), jumping its
// end onto the node, so any direction that can be read is kept. It also
// takes any `SegmentLike`, reading its controlX/controlY, where the shared
// one needs a Segment's `hasControlPoint`.
function outOf(graph: Graph, segment: SegmentLike, nodeId: string, at?: Pt) {
	const a = graph.nodes.get(segment.startNodeId);
	const b = graph.nodes.get(segment.endNodeId);
	if (!a || !b) return null;
	const from = at ?? (segment.startNodeId === nodeId ? a : b);
	const toward = towardOf(graph, segment, nodeId)!;
	const dx = toward.x - from.x;
	const dy = toward.y - from.y;
	const l = Math.hypot(dx, dy);
	return l > 1e-9 ? { x: dx / l, y: dy / l } : null;
}

// The point a segment's drawn line heads for out of `nodeId`: its control
// point, or its far node.
function towardOf(graph: Graph, segment: SegmentLike, nodeId: string) {
	return (
		controlPointOf(segment) ??
		graph.nodes.get(segment.startNodeId === nodeId ? segment.endNodeId : segment.startNodeId)
	);
}

// The right normal of a segment's drawing direction at one of its nodes (or
// leaving `at`, where its end there is drawn).
function normalAt(graph: Graph, segment: SegmentLike, nodeId: string, at?: Pt) {
	const out = outOf(graph, segment, nodeId, at);
	if (!out) return null;
	const along = segment.startNodeId === nodeId ? out : { x: -out.x, y: -out.y };
	return { out, n: { x: -along.y, y: along.x } };
}

// The roads at a node that a segment there would attach beside: every other
// road not itself attached at an edge.
function mainsAt(graph: Graph, segment: SegmentLike, nodeId: string) {
	const node = graph.nodes.get(nodeId);
	const sides = node?.junction?.sides ?? {};
	return (node?.connectedSegments ?? [])
		.filter((id) => id !== segment.id && !sides[id])
		.flatMap((id) => {
			const s = graph.segments.get(id);
			return s ? [s] : [];
		});
}

// Whether a road's right, looking out of the node along it, lies the way the
// normal of the road it joins points. A road leaving square to that road has
// its right along it, neither way: sideToward and attachShift read that one
// way here, so the side one records is the side the other moves to: square
// to within a nanometre a metre, so a road read whole from its pieces
// (wholeOf), its direction off in the last digits, reads so too.
const rightward = (own: { out: Pt }, host: { n: Pt }) =>
	host.n.x * -own.out.y + host.n.y * own.out.x >= -1e-9;

// The side to record for a segment attached at `nodeId` so that its end
// moves toward `across` (the way from the road it joins to the edge picked).
// attachShift reads the side against the segment's own direction out of the
// node, curve and all, so this must be asked once that is final.
export function sideToward(graph: Graph, segment: SegmentLike, nodeId: string, across: Pt) {
	const mains = mainsAt(graph, segment, nodeId);
	const own = normalAt(graph, segment, nodeId);
	const host = mains.length ? normalAt(graph, mains[0], nodeId) : null;
	if (!own || !host) return null;
	const wanted = host.n.x * across.x + host.n.y * across.y >= 0;
	return wanted === rightward(own, host) ? 'right' : 'left';
}

// How far a segment's end at `nodeId` is moved off the node: zero unless the
// node attaches it at an edge of the other roads there.
export function attachShift(graph: Graph, segment: SegmentLike, nodeId: string): Pt {
	const zero = { x: 0, y: 0 };
	const node = graph.nodes.get(nodeId);
	const side = node?.junction?.sides?.[segment.id];
	if (!node || !side) return zero;
	const mains = mainsAt(graph, segment, nodeId);
	const own = normalAt(graph, segment, nodeId);
	if (!mains.length || !own) return zero;
	// The side it is on: to its own right (looking out of the node along it)
	// for 'right', its left for 'left'. It moves straight across the road it
	// joins, toward that side.
	const host = normalAt(graph, mains[0], nodeId);
	if (!host) return zero;
	const k0 = (side === 'right') === rightward(own, host) ? 1 : -1;
	const d = { x: host.n.x * k0, y: host.n.y * k0 };
	// It lines up with the others' roadway there. Where they have none it
	// only meets them, unmoved.
	const across = (lanes: readonly Lane[]) => spanOf(lanes, 'vehicle');
	// The other roads' edge of those lanes that way, the innermost of them.
	let edge = Infinity;
	for (const main of mains) {
		const m = normalAt(graph, main, nodeId);
		const r = across(main.lanes);
		if (!m || !r) continue;
		const k = m.n.x * d.x + m.n.y * d.y;
		const off = shiftAt(main, nodeId);
		edge = Math.min(edge, k >= 0 ? r.hi + off : -(r.lo + off));
	}
	if (!Number.isFinite(edge)) return zero;
	const mine = across(segment.lanes) ?? roadwayOf(segment.lanes);
	const half = (mine.hi - mine.lo) / 2;
	const beside = mains.length >= 2;
	// Where its roadway's middle goes, measured from the node along d.
	const reach = edge + (beside ? half : -half);
	// Its drawn end goes where that puts its roadway's middle, across its own
	// normal, which leans by the angle it leaves its drawn end at: `along`,
	// how far the end lies from the node along d, solves
	// along + lean(along) * middle = reach, to the last digit. So a half of it
	// cut off there (crossings.ts, splitSegment), leaving that drawn end the
	// same way, lands on it again, wherever the cut is.
	const middle = (mine.lo + mine.hi) / 2 + shiftAt(segment, nodeId);
	const toward = towardOf(graph, segment, nodeId)!;
	const [tx, ty] = [toward.x - node.x, toward.y - node.y];
	const along = alongSolving(
		reach,
		middle,
		{ along: tx * d.x + ty * d.y, out: Math.abs(tx * d.y - ty * d.x) },
		(x) => {
			const at = { x: node.x + d.x * x, y: node.y + d.y * x };
			const leaves = normalAt(graph, segment, nodeId, at);
			return leaves ? leaves.n.x * d.x + leaves.n.y * d.y : 0;
		}
	);
	return { x: d.x * along, y: d.y * along };
}

// The x solving x + lean(x) * middle = reach, where lean (the sine of the
// angle a road leaves an end at x, so within ±1) changes with x: every
// solution lies within |middle| of reach. The point the road heads for lies
// `toward.along` along x's line and `toward.out` off it; lean changes fastest
// within `out` of its foot. Where `out` is more than about 0.4 |middle| there
// is one solution; less, there can be three, and the one nearest that point
// is taken: a half cut off a road near its end heads for a point close to
// that end. Each is found by bisection where the left side passes reach, from
// a scan of that span in steps fine enough to part them.
function alongSolving(
	reach: number,
	middle: number,
	toward: { along: number; out: number },
	lean: (x: number) => number
) {
	if (!middle) return reach;
	const below = (x: number) => x + lean(x) * middle < reach;
	const span = Math.abs(middle);
	const SCAN = Math.min(1000, Math.ceil((16 * span) / Math.min(span, Math.max(toward.out, 1e-3))));
	const at = (i: number) => reach - span + (2 * span * i) / SCAN;
	let best = reach;
	let found = false;
	for (let i = 1; i <= SCAN; i++) {
		let [lo, hi] = [at(i - 1), at(i)];
		if (below(lo) === below(hi)) continue;
		if (!below(lo)) [lo, hi] = [hi, lo];
		// Halved until no number lies between the two.
		for (let mid = (lo + hi) / 2; mid !== lo && mid !== hi; mid = (lo + hi) / 2) {
			if (below(mid)) lo = mid;
			else hi = mid;
		}
		const root = (lo + hi) / 2;
		if (!found || Math.abs(root - toward.along) < Math.abs(best - toward.along)) best = root;
		found = true;
	}
	return best;
}

// How an end attached at an edge is moved off its node: attachShift, or what
// stands in for it (core/place.ts keeps each one it works out).
export type Attach = (graph: Graph, segment: SegmentLike, nodeId: string) => Pt;

// A segment's two ends as drawn (endAt).
export function segmentEnds(graph: Graph, segment: SegmentLike, attach: Attach = attachShift) {
	const a = endAt(graph, segment, segment.startNodeId, attach);
	const b = endAt(graph, segment, segment.endNodeId, attach);
	return a && b ? { a, b } : null;
}

// Whether a segment's end at a node is attached at an edge there.
export const attached = (graph: Graph, s: SegmentLike, id: string) =>
	!!graph.nodes.get(id)?.junction?.sides?.[s.id];

// The segment `last` may run on into as a piece of one road at its end
// `far`, read the way `forward` (start to end, or back): the other of
// exactly two segments at that node, running on the same way, neither
// attached at an edge there. The one step every reader of the road a
// segment is a piece of takes (wholeOf, and the roads a trial reads again:
// moving in core/networks.ts).
export function pieceOn(graph: Graph, last: SegmentLike, far: string, forward: boolean) {
	const node = graph.nodes.get(far);
	const mine = (node?.connectedSegments ?? []).flatMap((id) => graph.segments.get(id) ?? []);
	const next = mine.length === 2 ? mine.find((s) => s.id !== last.id) : undefined;
	if (!next || (forward ? next.startNodeId : next.endNodeId) !== far) return null;
	if (attached(graph, last, far) || attached(graph, next, far)) return null;
	return next;
}

// A segment's end at a node as drawn. One the node attaches at an edge
// (JunctionData.sides) is moved there (attachShift), and where the segment
// is a piece of a road cut in two (wholeOf), that end goes where the whole
// road would put it, so a cut never moves it: a piece read alone can land
// elsewhere, where the road leaves its end nearly square to the road it
// joins and attachShift has more than one place to put it. Any other end, a
// footpath's included, is the node. The drawing (core/place.ts) and
// everything in the editor that reads where a road is (core/road-line.ts)
// read ends here, so they agree.
export function endAt(
	graph: Graph,
	segment: SegmentLike,
	nodeId: string,
	attach: Attach = attachShift
): Pt | null {
	const node = graph.nodes.get(nodeId);
	if (!node) return null;
	if (!node.junction?.sides?.[segment.id] || !carries(segment.lanes))
		return { x: node.x, y: node.y };
	const whole = wholeOf(graph, segment, nodeId);
	const moved = (s: Pt) => ({ x: node.x + s.x, y: node.y + s.y });
	const at = moved(attach(graph, whole?.road ?? segment, nodeId));
	return !whole || whole.fits(at) ? at : moved(attach(graph, segment, nodeId));
}

// The pieces of one road a segment's end at `nodeId` runs on into, as
// wholeOf walks them: through nodes where only it and the next meet, so long
// as they make one curve (`rest`, ending at `last`'s far end), stopped where
// the next's far end is attached at an edge too (`farAttached`). With each
// segment it looks at (`read`: those it takes in and the one past them),
// whose shapes alone the whole road read from that end is made of.
function runOn(graph: Graph, segment: SegmentLike, nodeId: string) {
	const starts = segment.startNodeId === nodeId;
	const farOf = (s: SegmentLike) => (starts ? s.endNodeId : s.startNodeId);
	const read = new Set([segment.id]);
	let rest: Curve | null = null;
	let last = segment;
	for (;;) {
		const next = pieceOn(graph, last, farOf(last), starts);
		if (!next || read.has(next.id)) break;
		read.add(next.id);
		if (attached(graph, next, farOf(next))) return { rest, last, read, farAttached: true };
		const ends = segmentEnds(graph, next);
		if (!ends) break;
		const curve = quadratic(ends.a, controlPointOf(next), ends.b);
		const joined: Curve = rest ? joinCurves(starts ? [rest, curve] : [curve, rest]) : curve;
		if (joined.parts) break;
		rest = joined;
		last = next;
	}
	return { rest, last, read, farAttached: false };
}

// The segments whose shapes a segment's end attached at an edge at `nodeId`
// is placed from (endAt): its own and those of the road it was cut from
// (wholeOf), and the first piece past them, whose shape decides where that
// road stops. An edit of any other segment moves that end only through the
// node (attachShift).
export const placedFrom = (graph: Graph, segment: SegmentLike, nodeId: string) =>
	runOn(graph, segment, nodeId).read;

// The road a segment was cut from (splitSegment in core/crossings.ts), read
// from its end at `nodeId`, attached at an edge, to the far end: the segment
// and the segments it runs on into, end to end, through nodes where only it
// and the next meet, so long as they make one curve, as one segment
// (`road`). Its control point is worked out from the other pieces
// (a plain cut leaves halves of it): they make one quadratic, its control a
// fraction t of the way from the whole's toward the far end, the cut that
// fraction from this piece's control toward theirs. Whether an end placed
// for the whole lies where this piece is that fraction of the whole from
// there (`fits`: two segments drawn on smoothly that were never one road
// don't). Null where the segment runs on into none, or the road's far end
// is attached at an edge too (both are then read piece by piece).
export function wholeOf(graph: Graph, segment: SegmentLike, nodeId: string) {
	const starts = segment.startNodeId === nodeId;
	const { rest, last, farAttached } = runOn(graph, segment, nodeId);
	// Its far end attached too: read piece by piece.
	if (farAttached) return null;
	const own = controlPointOf(segment);
	if (!rest || !!own !== !!rest.c) return null;
	let control: Pt | null = null;
	let frac = 0;
	if (own && rest.c) {
		const [cut, far] = starts ? [rest.a, rest.b] : [rest.b, rest.a];
		const c2 = rest.c;
		const l = Math.hypot(c2.x - own.x, c2.y - own.y);
		const t = l > 1e-9 ? Math.hypot(cut.x - own.x, cut.y - own.y) / l : 1;
		const on = { x: own.x + (c2.x - own.x) * t, y: own.y + (c2.y - own.y) * t };
		if (t >= 1 || Math.hypot(on.x - cut.x, on.y - cut.y) > 1e-6) return null;
		control = { x: (c2.x - t * far.x) / (1 - t), y: (c2.y - t * far.y) / (1 - t) };
		frac = t;
	}
	const road: SegmentLike = {
		id: segment.id,
		startNodeId: starts ? nodeId : last.startNodeId,
		endNodeId: starts ? last.endNodeId : nodeId,
		...(control && { controlX: control.x, controlY: control.y }),
		offsetStart: starts ? segment.offsetStart : last.offsetStart,
		offsetEnd: starts ? last.offsetEnd : segment.offsetEnd,
		lanes: segment.lanes
	};
	const fits = (at: Pt) =>
		!control ||
		!own ||
		Math.hypot(at.x + (control.x - at.x) * frac - own.x, at.y + (control.y - at.y) * frac - own.y) <
			1e-5;
	return { road, fits };
}
