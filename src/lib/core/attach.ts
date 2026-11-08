// Roads attached at the edge of another (JunctionData.sides): a ramp, a slip
// lane, one carriageway of a road that splits in two. Such a road still
// meets the others at their shared node, but its end is drawn at the edge
// of the road it joins rather than on that road's line, so its lanes carry
// on beside (or into) the lanes there instead of turning across them.
//
// Where the other road carries on through the node, the attached road sits
// just outside its roadway (a ramp beside a freeway); where it ends there,
// the attached road takes over that edge of it (one half of a split road).

import type { Graph } from './graph.svelte';
import type { Lane } from './types';

interface Pt {
	x: number;
	y: number;
}

interface SegmentLike {
	id: string;
	startNodeId: string;
	endNodeId: string;
	controlX?: number;
	controlY?: number;
	offset: number;
	lanes: Lane[];
}

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

// The unit direction a segment's drawn line leaves `nodeId` in.
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

// How far a segment's end at `nodeId` is moved off the node: zero unless the
// node attaches it at an edge of the other roads there.
export function attachShift(graph: Graph, segment: SegmentLike, nodeId: string): Pt {
	const zero = { x: 0, y: 0 };
	const node = graph.nodes.get(nodeId);
	const side = node?.junction?.sides?.[segment.id];
	if (!node || !side) return zero;
	const sides = node.junction?.sides ?? {};
	const mains = node.connectedSegments
		.filter((id) => id !== segment.id && !sides[id])
		.flatMap((id) => {
			const s = graph.segments.get(id);
			return s ? [s] : [];
		});
	const own = normalAt(graph, segment, nodeId);
	if (!mains.length || !own) return zero;
	// The side it is on: to its own right (looking out of the node along it)
	// for 'right', its left for 'left'. It moves straight across the road it
	// joins, toward that side.
	const right = { x: -own.out.y, y: own.out.x };
	const toward = side === 'right' ? right : { x: -right.x, y: -right.y };
	const host = normalAt(graph, mains[0], nodeId);
	if (!host) return zero;
	const k0 = host.n.x * toward.x + host.n.y * toward.y >= 0 ? 1 : -1;
	const d = { x: host.n.x * k0, y: host.n.y * k0 };
	// The other roads' roadway edge that way, the innermost of them.
	let edge = Infinity;
	for (const main of mains) {
		const m = normalAt(graph, main, nodeId);
		if (!m) continue;
		const r = roadwayOf(main.lanes);
		const k = m.n.x * d.x + m.n.y * d.y;
		edge = Math.min(edge, k >= 0 ? r.hi + main.offset : -(r.lo + main.offset));
	}
	if (!Number.isFinite(edge)) return zero;
	const mine = roadwayOf(segment.lanes);
	const half = (mine.hi - mine.lo) / 2;
	const beside = mains.length >= 2;
	// Where its roadway's middle goes, measured from the node along d.
	const reach = edge + (beside ? half : -half);
	// Its drawn end goes where that puts its roadway's middle.
	const middle = (mine.lo + mine.hi) / 2 + segment.offset;
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
