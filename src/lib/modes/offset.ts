// The lateral offset handle: with one road selected, a handle sits on its
// cross-section's centre, a quarter of the way along. Dragging it across
// slides the whole cross-section sideways relative to the drawn line (the
// segment's `offset`); with Shift held it snaps to centred, or to where its
// kerb or outer edge on one side lines up with the road it carries on from.

import type { Editor } from '../editor.svelte';
import type { Segment } from '../core/segment.svelte';
import { segmentEnds } from '../core/attach';
import { getQuadraticBezierPoint, getQuadraticBezierTangent } from '../geometry/bezier';

interface Pt {
	x: number;
	y: number;
}

export interface OffsetHandle {
	segmentId: string;
	// The point on the drawn line, the right normal there, and the handle.
	base: Pt;
	normal: Pt;
	point: Pt;
}

// Where along the line the handle sits (the curvature handle has the middle).
const AT = 0.25;

function frame(editor: Editor, segment: Segment, t: number) {
	// Its ends as drawn (an end attached at another road's edge moved there).
	const ends = segmentEnds(editor.graph, segment);
	if (!ends) return null;
	const { a, b } = ends;
	const cx = segment.controlX ?? (a.x + b.x) / 2;
	const cy = segment.controlY ?? (a.y + b.y) / 2;
	const p = getQuadraticBezierPoint(a.x, a.y, cx, cy, b.x, b.y, t);
	const d = getQuadraticBezierTangent(a.x, a.y, cx, cy, b.x, b.y, t);
	const l = Math.hypot(d.x, d.y) || 1;
	// Right of the drawing direction (y grows downward).
	return { p: { x: p.x, y: p.y }, n: { x: -d.y / l, y: d.x / l } };
}

export function offsetHandle(editor: Editor): OffsetHandle | null {
	if (editor.selectedSegments.size !== 1 || editor.selectedNodes.size > 0) return null;
	const segment = editor.graph.segments.get([...editor.selectedSegments][0]);
	if (!segment) return null;
	const f = frame(editor, segment, AT);
	if (!f) return null;
	return {
		segmentId: segment.id,
		base: f.p,
		normal: f.n,
		point: { x: f.p.x + f.n.x * segment.offset, y: f.p.y + f.n.y * segment.offset }
	};
}

// A segment's outer edges and kerbs, across it from its own centre.
function edges(segment: Segment) {
	const total = segment.lanes.reduce((sum, l) => sum + l.width, 0);
	let x = -total / 2;
	let lo = Infinity;
	let hi = -Infinity;
	for (const lane of segment.lanes) {
		if (lane.role === 'vehicle') {
			lo = Math.min(lo, x);
			hi = Math.max(hi, x + lane.width);
		}
		x += lane.width;
	}
	const outer = { lo: -total / 2, hi: total / 2 };
	return { outer, kerb: lo <= hi ? { lo, hi } : outer };
}

// Offsets worth snapping to: centred, and those that line this road's kerb
// or outer edge up with the same edge of a road it meets, on either side.
function snapTargets(editor: Editor, segment: Segment) {
	const targets = [0];
	const mine = edges(segment);
	for (const [nodeId, t] of [
		[segment.startNodeId, 0],
		[segment.endNodeId, 1]
	] as const) {
		const node = editor.graph.nodes.get(nodeId);
		const here = frame(editor, segment, t);
		if (!node || !here) continue;
		for (const id of node.connectedSegments) {
			if (id === segment.id) continue;
			const other = editor.graph.segments.get(id);
			const there = other && frame(editor, other, other.startNodeId === nodeId ? 0 : 1);
			if (!other || !there) continue;
			// Only roads carrying on from this one line up with it.
			const dot = here.n.x * there.n.x + here.n.y * there.n.y;
			if (Math.abs(dot) < 0.9) continue;
			const theirs = edges(other);
			// Their edges across this road, nearest-side first.
			const across = (lo: number, hi: number) => {
				const a = (lo + other.offset) * dot;
				const b = (hi + other.offset) * dot;
				return { lo: Math.min(a, b), hi: Math.max(a, b) };
			};
			for (const key of ['outer', 'kerb'] as const) {
				const e = across(theirs[key].lo, theirs[key].hi);
				targets.push(e.lo - mine[key].lo, e.hi - mine[key].hi);
			}
		}
	}
	return targets;
}

// The offset for a pointer position, snapped when asked.
export function offsetFromPointer(
	editor: Editor,
	handle: OffsetHandle,
	x: number,
	y: number,
	snap: boolean
) {
	const segment = editor.graph.segments.get(handle.segmentId);
	if (!segment) return 0;
	const raw = (x - handle.base.x) * handle.normal.x + (y - handle.base.y) * handle.normal.y;
	if (!snap) return Math.round(raw * 10) / 10;
	return snapTargets(editor, segment).reduce((best, t) =>
		Math.abs(t - raw) < Math.abs(best - raw) ? t : best
	);
}
