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
// road).

import type { Graph } from './graph.svelte';
import type { Lane } from './types';

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
	lanes: Lane[];
}

// A segment's shift at the end that meets `nodeId`.
const shiftAt = (segment: SegmentLike, nodeId: string) =>
	segment.startNodeId === nodeId ? segment.offsetStart : segment.offsetEnd;

// Where a cross-section's roadway lies across it, from its centre.
export function roadwayOf(lanes: Lane[]) {
	const total = lanes.reduce((sum, l) => sum + l.width, 0);
	let x = -total / 2;
	let lo = Infinity;
	let hi = -Infinity;
	for (const lane of lanes) {
		if (lane.role === 'vehicle') {
			lo = Math.min(lo, x);
			hi = Math.max(hi, x + lane.width);
		}
		x += lane.width;
	}
	return lo > hi ? { lo: -total / 2, hi: total / 2 } : { lo, hi };
}

// The unit direction a segment's drawn line leaves `nodeId` in. Null only
// where there is no direction at all (the node within a nanometre of its
// control point or far node). Not the shared `outOf` in segment-curve.ts,
// which gives up within 0.1 mm: here a null drops an attached road's shift
// to zero (attachShift), jumping its end onto the node, so any direction
// that can be read is kept. It also takes any `SegmentLike`, reading its
// controlX/controlY, where the shared one needs a Segment's
// `hasControlPoint`.
function outOf(graph: Graph, segment: SegmentLike, nodeId: string) {
	const a = graph.nodes.get(segment.startNodeId);
	const b = graph.nodes.get(segment.endNodeId);
	if (!a || !b) return null;
	const atStart = segment.startNodeId === nodeId;
	const from = atStart ? a : b;
	const toward =
		segment.controlX !== undefined && segment.controlY !== undefined
			? { x: segment.controlX, y: segment.controlY }
			: atStart
				? b
				: a;
	const dx = toward.x - from.x;
	const dy = toward.y - from.y;
	const l = Math.hypot(dx, dy);
	return l > 1e-9 ? { x: dx / l, y: dy / l } : null;
}

// The right normal of a segment's drawing direction at one of its nodes.
function normalAt(graph: Graph, segment: SegmentLike, nodeId: string) {
	const out = outOf(graph, segment, nodeId);
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
// way here, so the side one records is the side the other moves to.
const rightward = (own: { out: Pt }, host: { n: Pt }) =>
	host.n.x * -own.out.y + host.n.y * own.out.x >= 0;

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
	// The other roads' roadway edge that way, the innermost of them.
	let edge = Infinity;
	for (const main of mains) {
		const m = normalAt(graph, main, nodeId);
		if (!m) continue;
		const r = roadwayOf(main.lanes);
		const k = m.n.x * d.x + m.n.y * d.y;
		const off = shiftAt(main, nodeId);
		edge = Math.min(edge, k >= 0 ? r.hi + off : -(r.lo + off));
	}
	if (!Number.isFinite(edge)) return zero;
	const mine = roadwayOf(segment.lanes);
	const half = (mine.hi - mine.lo) / 2;
	const beside = mains.length >= 2;
	// Where its roadway's middle goes, measured from the node along d.
	const reach = edge + (beside ? half : -half);
	// Its drawn end goes where that puts its roadway's middle.
	const middle = (mine.lo + mine.hi) / 2 + shiftAt(segment, nodeId);
	// (Its own normal leans by the angle it joins at.)
	const lean = own.n.x * d.x + own.n.y * d.y;
	const along = reach - lean * middle;
	return { x: d.x * along, y: d.y * along };
}

// A segment's two ends as drawn: its nodes, each moved by its attach shift.
export function segmentEnds(graph: Graph, segment: SegmentLike) {
	const a = graph.nodes.get(segment.startNodeId);
	const b = graph.nodes.get(segment.endNodeId);
	if (!a || !b) return null;
	const sa = attachShift(graph, segment, a.id);
	const sb = attachShift(graph, segment, b.id);
	return {
		a: { x: a.x + sa.x, y: a.y + sa.y },
		b: { x: b.x + sb.x, y: b.y + sb.y }
	};
}
